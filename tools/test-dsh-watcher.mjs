/**
 * DshWatcher 自测
 *
 * 造一个「真实格式」的 DSH 会话日志（zstd 多帧追加的 JSONL），
 * 验证监听器能否正确识别：
 *   1. 启动预热不播报历史事件
 *   2. 新增 turn/end(completed)        -> onTurnEnd
 *   3. 新增 turn/end(aborted)          -> 也回调，但 reason 是 aborted（上层据此不播报）
 *   4. 新增 approval/asked             -> onApprovalAsked
 *   5. approval/decided 之后不再算 pending
 *   6. 子代理会话被静音
 *   7. 末帧不完整时不会崩，补齐后仍能解出
 *
 * 用法：node tools/test-dsh-watcher.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { DshWatcher } from '../server/dsh-watcher.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const log = [];
function check(name, cond, extra = '') {
  if (cond) { pass++; log.push(`PASS  ${name}${extra ? '  — ' + extra : ''}`); }
  else { fail++; log.push(`FAIL  ${name}${extra ? '  — ' + extra : ''}`); }
}

/** 把一批事件压成一个 zstd 帧（模拟 DSH 的追加写入） */
function frame(events) {
  return zlib.zstdCompressSync(Buffer.from(events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8'));
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-watcher-test-'));
const mainDir = path.join(root, '--D-workspace--', 'session-test-0001');
const subDir = path.join(root, '--D-workspace--', 'subagent-0002');
fs.mkdirSync(mainDir, { recursive: true });
fs.mkdirSync(subDir, { recursive: true });

const mainFile = path.join(mainDir, 'session.v4.jsonl.zstd');
const subFile = path.join(subDir, 'session.v4.jsonl.zstd');

const t0 = Date.now();
// 历史部分（预热时应被忽略）
fs.writeFileSync(mainFile, Buffer.concat([
  frame([
    { type: 'permission/preset', seq: 0, time: t0, data: { preset: 'workspace-write' } },
    { type: 'approval/policy', seq: 1, time: t0, data: { policy: 'ask' } },
  ]),
  frame([
    { type: 'turn/start', seq: 2, time: t0 + 10, data: { turn: 1 } },
    { type: 'turn/end', seq: 3, time: t0 + 20, data: { turn: 1, reason: { kind: 'completed' } } },
  ]),
]));

// 子代理会话（应被静音）
fs.writeFileSync(subFile, Buffer.concat([
  frame([
    { type: 'subagent/descriptor', seq: 0, time: t0, data: { label: 'x' } },
    { type: 'sandbox/mode', seq: 1, time: t0, data: { mode: 'workspace-write', source: 'delegation' } },
    { type: 'turn/end', seq: 2, time: t0 + 30, data: { turn: 1, reason: { kind: 'completed' } } },
  ]),
]));

const got = { turnEnds: [], asked: [], decided: [] };

const watcher = new DshWatcher({
  sessionsDir: root,
  pollMs: 60,
  onTurnEnd: (ev) => got.turnEnds.push(ev),
  onApprovalAsked: (ev) => got.asked.push(ev),
  onApprovalDecided: (ev) => got.decided.push(ev),
});

watcher.prime();
watcher.start();

await sleep(250);
check('预热阶段不播报历史事件', got.turnEnds.length === 0 && got.asked.length === 0,
  `turnEnds=${got.turnEnds.length} asked=${got.asked.length}`);
check('子代理会话被识别并静音',
  watcher.status().sessions.some((s) => s.sessionId === 'subagent-0002' && s.muted));

/* ---- 追加一个新帧：任务完成 ---- */
fs.appendFileSync(mainFile, frame([
  { type: 'turn/start', seq: 4, time: t0 + 100, data: { turn: 2 } },
  { type: 'turn/end', seq: 5, time: t0 + 200, data: { turn: 2, reason: { kind: 'completed' } } },
]));
await sleep(300);
check('新增 turn/end(completed) 触发回调', got.turnEnds.length === 1,
  JSON.stringify(got.turnEnds.map((e) => e.reason)));
check('回调带上了会话 id', got.turnEnds[0] && got.turnEnds[0].sessionId === 'session-test-0001',
  got.turnEnds[0] ? got.turnEnds[0].sessionId : '');

/* ---- 追加 approval/asked ---- */
fs.appendFileSync(mainFile, frame([
  { type: 'approval/asked', seq: 6, time: t0 + 300, data: { id: 'appr-1111', toolName: 'pwsh', callId: 'call_1', reason: '需要提权' } },
]));
await sleep(300);
check('新增 approval/asked 触发回调', got.asked.length === 1,
  JSON.stringify(got.asked.map((e) => e.approvalId + '/' + e.toolName)));
check('审批内容解析正确',
  got.asked[0] && got.asked[0].approvalId === 'appr-1111' && got.asked[0].toolName === 'pwsh',
  got.asked[0] ? `${got.asked[0].approvalId} ${got.asked[0].toolName}` : '');
check('pendingApprovals 里能看到它', watcher.pendingApprovals().length === 1);

/* ---- 同一个审批不会重复播报 ---- */
await sleep(250);
check('同一个 approval 只播报一次', got.asked.length === 1, `asked=${got.asked.length}`);

/* ---- 末帧写一半（不完整）不应崩溃 ---- */
const half = frame([{ type: 'turn/end', seq: 99, time: t0 + 400, data: { turn: 3, reason: { kind: 'aborted' } } }]);
const before = got.turnEnds.length;
fs.appendFileSync(mainFile, half.subarray(0, Math.floor(half.length / 2)));
await sleep(250);
check('末帧不完整时不崩溃、不误报', got.turnEnds.length === before, `turnEnds=${got.turnEnds.length}`);
// 补齐剩余字节
fs.appendFileSync(mainFile, half.subarray(Math.floor(half.length / 2)));
await sleep(350);
check('补齐后能解出该帧', got.turnEnds.length === before + 1,
  `turnEnds=${got.turnEnds.length} reasons=${JSON.stringify(got.turnEnds.map((e) => e.reason))}`);
check('aborted 会被如实上报（上层据此不播报）',
  got.turnEnds[got.turnEnds.length - 1].reason === 'aborted');

/* ---- approval/decided 之后不再 pending ---- */
fs.appendFileSync(mainFile, frame([
  { type: 'approval/decided', seq: 100, time: t0 + 500, data: { id: 'appr-1111', outcome: 'allowed-once' } },
]));
await sleep(300);
check('approval/decided 触发回调', got.decided.length === 1 && got.decided[0].outcome === 'allowed-once');
check('已决策的审批不再计入 pending', watcher.pendingApprovals().length === 0,
  `pending=${watcher.pendingApprovals().length}`);

watcher.stop();

/* ---- 汇总 ---- */
console.log(`DSH 监听器自测：${pass} 通过 / ${fail} 失败`);
console.log('临时会话目录:', root);
console.log('-'.repeat(60));
for (const l of log) console.log(l);
console.log('-'.repeat(60));
console.log(`RESULT=${fail === 0 ? 'ALL_PASS' : 'HAS_FAILURE'}`);

try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(fail === 0 ? 0 : 1);
