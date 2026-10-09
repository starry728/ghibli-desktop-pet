/**
 * 文档脱敏
 *
 * 把准备公开的文档里属于「本机 / 个人」的信息替换成占位符：
 *   - Windows 用户名目录      C:\Users\<用户名>\...   → C:\Users\<你的用户名>\...
 *   - 项目在本机的绝对路径     <盘符>:\...\DesktopPet   → <项目目录>
 *   - DSH 会话 id            session-<uuid>          → session-<已隐去>
 *   - 裸 UUID（会话/代理/审批 id）                     → <id-已隐去>
 *
 * 用户名与路径都在运行时从本机推断，脚本里不写死。
 *
 * 默认只做「预演」（打印将要替换的内容），加 --write 才真正写回。
 *
 * 用法：
 *   node tools/scrub-docs.mjs            # 预演
 *   node tools/scrub-docs.mjs --write    # 真正写入
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const WRITE = process.argv.includes('--write');

const USERNAME = os.userInfo().username;              // 例如 ASUS
const HOME = os.homedir();                            // C:\Users\ASUS
const PROJECT_ABS = ROOT;                             // D:\myAIprojects\...\DesktopPet
const PROJECT_PARENT = path.dirname(ROOT);            // D:\myAIprojects\...

/** 目标文件：只处理准备公开的文档 */
const TARGETS = [
  'docs/research/DSH事件集成调研报告.md',
  'docs/research/电影原声可行性调研报告.md',
].map((p) => path.join(ROOT, p));

const RULES = [
  {
    name: 'Windows 用户名目录',
    // 反斜杠要转义；大小写不敏感
    re: () => new RegExp(escapeRe(HOME).replace(/\\\\/g, '\\\\+'), 'gi'),
    to: 'C:\\Users\\<你的用户名>',
  },
  {
    name: '项目绝对路径',
    re: () => new RegExp(escapeRe(PROJECT_ABS).replace(/\\\\/g, '\\\\+'), 'gi'),
    to: '<项目目录>',
  },
  {
    name: '项目父目录绝对路径',
    re: () => new RegExp(escapeRe(PROJECT_PARENT).replace(/\\\\/g, '\\\\+'), 'gi'),
    to: '<项目父目录>',
  },
  {
    name: '用户名单独出现（限定在路径上下文）',
    re: () => new RegExp(`(Users[\\\\/]+)${escapeRe(USERNAME)}\\b`, 'gi'),
    to: '$1<你的用户名>',
  },
  {
    name: 'DSH 会话 id',
    re: () => /session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    to: 'session-<已隐去>',
  },
  {
    name: '裸 UUID（会话/代理/审批 id）',
    re: () => /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    to: '<id-已隐去>',
  },
];

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

let totalHits = 0;
const summary = [];

for (const file of TARGETS) {
  if (!fs.existsSync(file)) {
    console.log(`跳过（不存在）: ${path.relative(ROOT, file)}`);
    continue;
  }
  const original = fs.readFileSync(file, 'utf8');
  let text = original;
  const perFile = [];

  for (const rule of RULES) {
    const re = rule.re();
    const matches = text.match(re);
    const count = matches ? matches.length : 0;
    if (!count) continue;
    perFile.push({ rule: rule.name, count, sample: matches.slice(0, 2).join(' | ') });
    text = text.replace(re, rule.to);
  }

  const hits = perFile.reduce((a, b) => a + b.count, 0);
  totalHits += hits;

  console.log(`\n=== ${path.relative(ROOT, file)} ===`);
  console.log(`    ${original.length} → ${text.length} 字符，共替换 ${hits} 处`);
  for (const p of perFile) {
    console.log(`    [${p.rule}] x${p.count}`);
    console.log(`        例如: ${p.sample}`);
  }

  summary.push({ file: path.relative(ROOT, file), hits });

  if (WRITE && text !== original) {
    fs.writeFileSync(file, text, 'utf8');
    console.log('    ✅ 已写入');
  }
}

console.log('\n' + '='.repeat(60));
console.log(`合计需要替换 ${totalHits} 处`);
console.log(WRITE ? '模式：已写入' : '模式：预演（加 --write 才会真正写入）');
console.log('='.repeat(60));

// 写入后自检：确认没有残留
if (WRITE) {
  console.log('\n--- 写后残留检查 ---');
  let residue = 0;
  for (const file of TARGETS) {
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const rule of RULES) {
      const m = text.match(rule.re());
      if (m) {
        residue += m.length;
        console.log(`   ❌ ${path.relative(ROOT, file)} 仍有 [${rule.name}] x${m.length}: ${m.slice(0, 2).join(' | ')}`);
      }
    }
  }
  console.log(residue === 0 ? '   ✅ 没有残留' : `   ❌ 仍有 ${residue} 处残留`);
}
