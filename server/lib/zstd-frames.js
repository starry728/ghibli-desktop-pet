/**
 * Zstandard 多帧解码工具
 *
 * DSH 的会话日志 `session.v4.jsonl.zstd` 是「多个独立 zstd 帧依次追加」的格式：
 * 每帧包含 1~7 条 JSONL 事件。Node 的 zstdDecompressSync / 流式解压都**只返回第一帧**，
 * 因此必须自己按帧魔术字切分，再逐帧解压。
 *
 * 帧魔术字：0xFD2FB528（小端字节序 28 B5 2F FD）
 *
 * 同时提供了一个「有状态读取器」：记住上次读到的字节偏移（对齐到帧边界），
 * 只解压新增的字节，适合每秒轮询正在写入的日志（读取方不需要任何锁）。
 */
import fs from 'node:fs';
import zlib from 'node:zlib';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 在 buf 中从 from 开始找下一个帧魔数 */
function findMagic(buf, from) {
  return buf.indexOf(MAGIC, from);
}

/**
 * 从 buffer 的 start 偏移开始，切出所有**完整**的 zstd 帧。
 *
 * @param {Buffer} buf
 * @param {number} start 必须是帧边界
 * @returns {{frames: Buffer[], consumed: number, incompleteFrom: number}}
 *          consumed 表示已完整消费到的字节数（= 最后一个完整帧的结束位置）
 */
export function sliceFrames(buf, start = 0) {
  const frames = [];
  let pos = start;

  while (pos < buf.length) {
    // 帧必须从魔术字开始；否则说明调用方的 start 没有对齐
    if (buf.indexOf(MAGIC, pos) !== pos) {
      const next = findMagic(buf, pos);
      if (next < 0) break;
      pos = next;
    }

    // 找下一个候选帧起点
    let end = findMagic(buf, pos + MAGIC.length);
    let slice = null;

    // 候选分割点可能是压缩数据里偶然出现的魔术字，因此要逐个往后试，直到能解压成功
    while (true) {
      const candidate = end < 0 ? buf.subarray(pos) : buf.subarray(pos, end);
      try {
        const out = zlib.zstdDecompressSync(candidate);
        slice = { data: out, end: end < 0 ? buf.length : end };
        break;
      } catch {
        if (end < 0) break; // 末尾帧还不完整，等下次轮询
        end = findMagic(buf, end + MAGIC.length);
      }
    }

    if (!slice) break; // 剩余部分不完整，保留给下一次
    frames.push(slice.data);
    pos = slice.end;
  }

  return { frames, consumed: pos, incompleteFrom: pos };
}

/** 解压一段 buffer，返回所有完整帧的文本行 */
export function decodeFramesToLines(buf, start = 0) {
  const { frames, consumed } = sliceFrames(buf, start);
  const lines = [];
  for (const data of frames) {
    for (const line of data.toString('utf8').split('\n')) {
      const t = line.trim();
      if (t) lines.push(t);
    }
  }
  return { lines, consumed };
}

/**
 * 有状态的增量读取器：适合轮询正在被追加写入的日志文件。
 * 只读取并解压自上次以来的新增字节，且始终停在帧边界上。
 */
export class ZstdTailReader {
  /** @param {string} file */
  constructor(file) {
    this.file = file;
    this.offset = 0;   // 已消费到的字节偏移（帧边界）
    this.size = 0;
    /** @type {Map<number, object>} seq -> event，用于去重与配对 */
    this.events = new Map();
    this.sessionMeta = null;
    this.broken = false;
    /** 文件被替换（重建）时置位，调用方据此重置自身状态 */
    this.resetDetected = false;
  }

  /** 读取新增的事件；返回本次新增的事件数组 */
  read() {
    let stat;
    try {
      stat = fs.statSync(this.file);
    } catch {
      return [];
    }

    // 文件变小 → 被重建（例如会话被重写），重置偏移
    if (stat.size < this.size) {
      this.offset = 0;
      this.events.clear();
      this.resetDetected = true;
    }
    this.size = stat.size;
    if (stat.size <= this.offset) return [];

    let handle;
    try {
      handle = fs.openSync(this.file, 'r');
      const len = stat.size - this.offset;
      const buf = Buffer.alloc(len);
      let read = 0;
      while (read < len) {
        const n = fs.readSync(handle, buf, read, len - read, this.offset + read);
        if (n <= 0) break;
        read += n;
      }
      const data = read === len ? buf : buf.subarray(0, read);
      const { lines, consumed } = decodeFramesToLines(data, 0);
      this.offset += consumed;

      const fresh = [];
      for (const line of lines) {
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        if (!ev) continue;
        // 会话头（{type:'session', version, id, cwd, delegationDepth…}）没有 seq 字段，
        // 单独保存下来用于判断工作目录与是否子代理会话。
        if (typeof ev.seq !== 'number') {
          if (ev.type === 'session') this.sessionMeta = ev;
          continue;
        }
        if (this.events.has(ev.seq)) continue;
        this.events.set(ev.seq, ev);
        if (ev.type === 'session') this.sessionMeta = ev.data || ev;
        fresh.push(ev);
      }
      // 防止长时间运行内存膨胀
      if (this.events.size > 5000) {
        const keys = Array.from(this.events.keys()).sort((a, b) => a - b).slice(0, this.events.size - 3000);
        for (const k of keys) this.events.delete(k);
      }
      return fresh;
    } catch {
      return [];
    } finally {
      if (handle !== undefined) {
        try { fs.closeSync(handle); } catch { /* ignore */ }
      }
    }
  }

  /** 当前处于「已请求但尚未决策」状态的审批 */
  pendingApprovals() {
    const asked = new Map();
    const decided = new Set();
    for (const ev of this.events.values()) {
      if (ev.type === 'approval/asked' && ev.data && ev.data.id) asked.set(ev.data.id, ev);
      else if (ev.type === 'approval/decided' && ev.data && ev.data.id) decided.add(ev.data.id);
    }
    const out = [];
    for (const [id, ev] of asked) if (!decided.has(id)) out.push(ev);
    return out;
  }

  /**
   * 是否子代理（委派）会话。
   * 判定依据（实测）：子代理会话的日志里有 `subagent/descriptor` 事件，
   * 且 `sandbox/mode`、`approval/policy` 都带 `source: "delegation"`。
   */
  isSubagent() {
    const m = this.sessionMeta;
    if (m) {
      if (m.origin === 'subagent') return true;
      if (typeof m.delegationDepth === 'number' && m.delegationDepth > 0) return true;
    }
    for (const ev of this.events.values()) {
      if (ev.type === 'subagent/descriptor') return true;
      if (ev.data && ev.data.source === 'delegation') return true;
    }
    return false;
  }

  /** 会话标识（取目录名，形如 session-xxxx 或 agent id） */
  get id() {
    const parts = this.file.split(/[\\/]/);
    return parts[parts.length - 2] || this.file;
  }

  /** 工作目录（若日志里有） */
  get cwd() {
    const m = this.sessionMeta;
    return m && m.cwd ? m.cwd : '';
  }
}
