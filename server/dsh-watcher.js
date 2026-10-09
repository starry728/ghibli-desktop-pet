/**
 * DshWatcher —— 监听 DeepSeek Harness 的会话日志，感知两类事件：
 *
 *   1. 任务完成：日志里出现 `turn/end` 且 `data.reason.kind === 'completed'`
 *   2. 等待批准：出现 `approval/asked` 而尚未出现配对的 `approval/decided`
 *      （实测「已请求但未决策」会作为独立 zstd 帧立即落盘，最长窗口达 252 秒，
 *        因此轮询完全来得及）
 *
 * 为什么用轮询而不是官方钩子：DSH 有 Cordis 插件系统与 ACP 协议，但
 *   · 没有出站通知 / webhook / 可挂命令的配置文件
 *   · Claude Code hooks 桥不支持 PermissionRequest，感知不到审批
 *   · 插件路线需要装包并重启 dsh web
 * 会话日志是 zstd 多帧追加的 JSONL，读取方无需任何锁，边写边读是安全的。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ZstdTailReader } from './lib/zstd-frames.js';

const SESSION_FILE = 'session.v4.jsonl.zstd';
const MAX_DEPTH = 4;

/** 递归找会话日志（限定深度，避免遍历过多目录） */
function findSessionFiles(root, maxFiles = 40) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > MAX_DEPTH) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(p, depth + 1);
      } else if (e.name === SESSION_FILE) {
        try {
          const st = fs.statSync(p);
          out.push({ file: p, size: st.size, mtime: st.mtimeMs });
        } catch { /* ignore */ }
      }
      if (out.length >= maxFiles * 3) return;
    }
  };
  walk(root, 0);
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, maxFiles);
}

export class DshWatcher {
  /**
   * @param {object} opts
   * @param {string} [opts.sessionsDir]
   * @param {number} [opts.pollMs]
   * @param {boolean}[opts.includeSubagents] 是否也播报子代理的事件（默认 false，否则太吵）
   * @param {number} [opts.maxFiles]
   * @param {(ev:object)=>void} [opts.onTurnEnd]
   * @param {(ev:object)=>void} [opts.onApprovalAsked]
   * @param {(ev:object)=>void} [opts.onApprovalDecided]
   */
  constructor(opts = {}) {
    this.sessionsDir = opts.sessionsDir || path.join(os.homedir(), '.dsh', 'sessions');
    this.pollMs = opts.pollMs ?? Number(process.env.DSH_WATCH_INTERVAL_MS || 1200);
    this.includeSubagents = opts.includeSubagents ?? (process.env.DSH_WATCH_SUBAGENTS === '1');
    this.maxFiles = opts.maxFiles ?? 40;

    this.onTurnEnd = opts.onTurnEnd || (() => {});
    this.onApprovalAsked = opts.onApprovalAsked || (() => {});
    this.onApprovalDecided = opts.onApprovalDecided || (() => {});

    /** @type {Map<string, {reader:ZstdTailReader, primed:boolean, approvalsFired:Set<string>}>} */
    this.readers = new Map();
    this.timer = null;
    this.running = false;

    this.stats = {
      polls: 0,
      sessionsTracked: 0,
      turnEnds: 0,
      approvalsAsked: 0,
      errors: 0,
      lastPollAt: null,
      lastEventAt: null,
      lastSummary: '',
    };
  }

  /** 只做扫描与预热，不触发任何回调 —— 避免服务启动时把历史记录全播一遍 */
  prime() {
    const files = findSessionFiles(this.sessionsDir, this.maxFiles);
    for (const f of files) this._readerFor(f.file);
    this.stats.sessionsTracked = this.readers.size;
    return this.readers.size;
  }

  _readerFor(file) {
    let entry = this.readers.get(file);
    if (entry) return entry;
    const reader = new ZstdTailReader(file);
    entry = { reader, primed: false, approvalsFired: new Set() };
    this.readers.set(file, entry);
    return entry;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.prime();
    this.timer = setInterval(() => this.poll(), this.pollMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 执行一轮扫描 */
  poll() {
    if (!this.running) return;
    this.stats.polls += 1;
    this.stats.lastPollAt = new Date().toISOString();

    let files = [];
    try {
      files = findSessionFiles(this.sessionsDir, this.maxFiles);
    } catch (err) {
      this.stats.errors += 1;
      return;
    }

    for (const f of files) {
      const entry = this._readerFor(f.file);
      let fresh;
      try {
        fresh = entry.reader.read();
      } catch (err) {
        this.stats.errors += 1;
        continue;
      }

      // 第一次读到内容：只建立基线，不触发回调
      if (!entry.primed) {
        entry.primed = true;
        if (entry.reader.isSubagent() && !this.includeSubagents) entry.muted = true;
        continue;
      }
      if (entry.muted) continue;
      if (!fresh.length) continue;

      const meta = {
        sessionId: entry.reader.id,
        file: f.file,
        isSubagent: entry.reader.isSubagent(),
        cwd: entry.reader.cwd,
      };

      for (const ev of fresh) {
        this.stats.lastEventAt = new Date().toISOString();

        if (ev.type === 'turn/end') {
          const kind = ev.data && ev.data.reason ? ev.data.reason.kind : 'unknown';
          this.stats.turnEnds += 1;
          this.stats.lastSummary = `turn/end (${kind}) @ ${meta.sessionId.slice(0, 12)}`;
          try {
            this.onTurnEnd({ ...meta, seq: ev.seq, time: ev.time, reason: kind, raw: ev });
          } catch (err) {
            this.stats.errors += 1;
          }
        } else if (ev.type === 'approval/asked') {
          const id = ev.data && ev.data.id;
          if (!id || entry.approvalsFired.has(id)) continue;
          entry.approvalsFired.add(id);
          this.stats.approvalsAsked += 1;
          this.stats.lastSummary = `approval/asked (${ev.data.toolName || '?'}) @ ${meta.sessionId.slice(0, 12)}`;
          try {
            this.onApprovalAsked({
              ...meta,
              seq: ev.seq,
              time: ev.time,
              approvalId: id,
              toolName: ev.data.toolName || '',
              reason: ev.data.reason || '',
              raw: ev,
            });
          } catch (err) {
            this.stats.errors += 1;
          }
        } else if (ev.type === 'approval/decided') {
          const id = ev.data && ev.data.id;
          try {
            this.onApprovalDecided({ ...meta, seq: ev.seq, time: ev.time, approvalId: id, outcome: ev.data && ev.data.outcome });
          } catch (err) {
            this.stats.errors += 1;
          }
        }
      }
    }

    this.stats.sessionsTracked = this.readers.size;
  }

  /** 当前所有会话里仍未决策的审批 */
  pendingApprovals() {
    const out = [];
    for (const [file, entry] of this.readers) {
      if (entry.muted) continue;
      for (const ev of entry.reader.pendingApprovals()) {
        out.push({
          sessionId: entry.reader.id,
          file,
          seq: ev.seq,
          time: ev.time,
          approvalId: ev.data && ev.data.id,
          toolName: (ev.data && ev.data.toolName) || '',
          reason: (ev.data && ev.data.reason) || '',
        });
      }
    }
    return out;
  }

  status() {
    return {
      enabled: this.running,
      sessionsDir: this.sessionsDir,
      pollMs: this.pollMs,
      includeSubagents: this.includeSubagents,
      ...this.stats,
      pendingApprovals: this.pendingApprovals().length,
      sessions: Array.from(this.readers.entries()).map(([file, e]) => ({
        file,
        sessionId: e.reader.id,
        isSubagent: e.reader.isSubagent(),
        muted: Boolean(e.muted),
        events: e.reader.events.size,
        pending: e.reader.pendingApprovals().length,
      })),
    };
  }
}

/* ---------------- 进程内单例 ---------------- */

let instance = null;

/** 启动（或复用）全局监听器 */
export function startDshWatcher(opts = {}) {
  if (instance) return instance;
  instance = new DshWatcher(opts);
  instance.start();
  return instance;
}

/** 取全局监听器（可能尚未启动） */
export function getDshWatcher() {
  return instance;
}

export function stopDshWatcher() {
  if (instance) {
    instance.stop();
    instance = null;
  }
}
