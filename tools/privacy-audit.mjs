/**
 * 隐私 / 密钥审计
 *
 * 目标：在把项目推到公开仓库之前，确认没有任何密钥、凭据、会话数据、本机路径被带出去。
 *
 * 用法：node tools/privacy-audit.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/* ---------------- 收集"真密钥"用于精确比对（只用来匹配，不打印） ---------------- */
function collectRealSecrets() {
  const secrets = [];
  const cred = path.join(os.homedir(), '.dsh', '.credentials.yaml');
  try {
    const text = fs.readFileSync(cred, 'utf8');
    for (const m of text.matchAll(/(sk-[A-Za-z0-9]{8,})/g)) {
      secrets.push({ label: '本机凭据库里的 API Key', value: m[1] });
    }
  } catch { /* 读不到就算了 */ }
  return secrets;
}

const REAL_SECRETS = collectRealSecrets();

/* ---------------- 敏感模式 ---------------- */
const PATTERNS = [
  { name: '完整 API Key (sk-...)', re: /\bsk-[A-Za-z0-9]{20,}\b/g, severity: 'critical' },
  { name: 'DeepSeek Key 前缀', re: /\bsk-[A-Za-z0-9]{6,}\b/g, severity: 'high' },
  { name: '疑似遮蔽后的 Key（形如 sk-abc…1234）', re: /sk-[A-Za-z0-9]{3,}[…\.]{1,3}[A-Za-z0-9]{3,}/g, severity: 'high' },
  { name: 'Bearer token', re: /Bearer\s+[A-Za-z0-9._\-]{16,}/g, severity: 'critical' },
  { name: '赋值形式的密钥', re: /(?:api[_-]?key|apikey|secret|token|password|passwd|pwd)\s*[:=]\s*["']?[A-Za-z0-9._\-]{16,}/gi, severity: 'critical' },
  { name: 'Windows 用户目录', re: /[A-Za-z]:\\Users\\[^\\\s"')]+/g, severity: 'medium' },
  { name: 'DSH 会话 id', re: /\bsession-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, severity: 'medium' },
  { name: 'DSH 子代理 id', re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, severity: 'low' },
  { name: 'GitHub token', re: /\b(ghp_|gho_|ghu_|ghs_|ghr_|github_pat_)[A-Za-z0-9_]{20,}\b/g, severity: 'critical' },
  { name: '私有邮箱', re: /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g, severity: 'medium' },
  { name: '内网 IP / 主机名', re: /\b(?:10|172|192)\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, severity: 'low' },
];

/* ---------------- 白名单 ----------------
 * 有些命中是「看起来像密钥但其实不是」，或者是工具脚本自身包含的检测正则。
 * 这里显式列出并写明理由，避免以后自己吓自己。
 */
const ALLOWLIST = [
  {
    file: 'server/lib/edge-tts.js',
    pattern: '赋值形式的密钥',
    reason: 'TRUSTED_CLIENT_TOKEN 是微软 Edge「大声朗读」公开的客户端标识，任何开源 edge-tts 实现里都有，不是密钥',
  },
  {
    file: 'tools/privacy-audit.mjs',
    pattern: '*',
    reason: '审计脚本自身包含检测用的正则表达式',
  },
  {
    file: 'tools/scrub-docs.mjs',
    pattern: '*',
    reason: '脱敏脚本自身包含替换规则与示例',
  },
];

function isAllowlisted(relFile, patternName) {
  const f = relFile.split(path.sep).join('/');
  return ALLOWLIST.some((a) => f === a.file && (a.pattern === '*' || a.pattern === patternName));
}

/** 已经是脱敏占位符的（含尖括号）不算泄露 */
function isPlaceholder(s) {
  return /[<>]/.test(s) || /已隐去|你的用户名|项目目录|你的密钥/.test(s);
}

/* ---------------- 不扫的目录（构建产物 / 依赖 / 二进制） ---------------- */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.shots', '.browser-profile', '.browser-profile2']);
const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.exe', '.dll', '.mp3', '.wav', '.zip', '.woff', '.woff2', '.pdf']);
const MAX_SIZE = 4 * 1024 * 1024;

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), out);
    } else if (e.isFile()) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

const files = walk(ROOT);
const findings = [];
let scanned = 0;
let skippedBinary = 0;

for (const file of files) {
  const ext = path.extname(file).toLowerCase();
  const rel = path.relative(ROOT, file);
  if (BINARY_EXT.has(ext)) { skippedBinary++; continue; }
  let stat;
  try { stat = fs.statSync(file); } catch { continue; }
  if (stat.size > MAX_SIZE) continue;

  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
  scanned++;

  // 1) 精确匹配真密钥
  for (const s of REAL_SECRETS) {
    if (text.includes(s.value)) {
      findings.push({ file: rel, pattern: s.label, severity: 'critical', sample: '(已隐藏，为避免二次泄露不打印)', count: 1 });
    }
  }

  // 2) 模式匹配
  for (const p of PATTERNS) {
    if (isAllowlisted(rel, p.name)) continue;
    const matches = [...text.matchAll(p.re)];
    if (!matches.length) continue;
    // 过滤掉已经是占位符的
    const real = matches.map((m) => m[0]).filter((s) => !isPlaceholder(s));
    if (!real.length) continue;
    const samples = [...new Set(real)].slice(0, 3);
    findings.push({
      file: rel,
      pattern: p.name,
      severity: p.severity,
      count: real.length,
      sample: samples.map((s) => (p.severity === 'critical' || p.severity === 'high' ? mask(s) : s)).join(' | '),
    });
  }
}

function mask(s) {
  if (s.length <= 12) return s.slice(0, 3) + '***';
  return s.slice(0, 6) + '…' + s.slice(-4) + ` (len=${s.length})`;
}

/* ---------------- git 忽略检查 ---------------- */
function readGitignore() {
  try {
    // 必须去掉注释行：否则「# …adoptions.json…」这样的说明文字会被误判成已忽略规则
    return fs
      .readFileSync(path.join(ROOT, '.gitignore'), 'utf8')
      .split(/\r?\n/)
      .filter((l) => l.trim() && !l.trim().startsWith('#'))
      .join('\n');
  } catch {
    return '';
  }
}

const SENSITIVE_PATHS = [
  '.env',
  'server/data/generated/voice/',
  'server/data/generated/subtitles/',
  'desktop/PetOverlay.log',
  'server/data/generated/adoptions.json',
];

const gi = readGitignore();
const ignoreStatus = SENSITIVE_PATHS.map((p) => {
  const base = p.replace(/\/$/, '');
  const name = base.split('/').pop();
  const covered = gi.includes(p) || gi.includes(base) || gi.includes(name) || (name.startsWith('.') && gi.includes(name));
  const exists = fs.existsSync(path.join(ROOT, base));
  return { path: p, exists, coveredByGitignore: covered };
});

/* ---------------- 带 out 的产物文件 ---------------- */
const GENERATED_PRESENT = [
  'server/data/generated/copy.json',
  'server/data/generated/adoptions.json',
  'server/data/generated/voice',
  'server/data/generated/subtitles',
].map((p) => ({ path: p, exists: fs.existsSync(path.join(ROOT, p)) }));

/* ---------------- 输出 ---------------- */
const order = { critical: 0, high: 1, medium: 2, low: 3 };
findings.sort((a, b) => order[a.severity] - order[b.severity] || a.file.localeCompare(b.file));

console.log('='.repeat(78));
console.log('隐私 / 密钥审计报告');
console.log('='.repeat(78));
console.log(`扫描根目录 : ${ROOT}`);
console.log(`文本文件   : ${scanned} 个已扫描，${skippedBinary} 个二进制已跳过`);
console.log(`真实密钥   : 从本机凭据库取到 ${REAL_SECRETS.length} 条用于精确比对（不会打印内容）`);
console.log('');

const bySeverity = { critical: [], high: [], medium: [], low: [] };
for (const f of findings) bySeverity[f.severity].push(f);

for (const sev of ['critical', 'high', 'medium', 'low']) {
  const list = bySeverity[sev];
  const tag = { critical: '🔴 严重', high: '🟠 高', medium: '🟡 中', low: '⚪ 低' }[sev];
  console.log(`--- ${tag} (${list.length}) ---`);
  if (!list.length) { console.log('   （无）'); console.log(''); continue; }
  for (const f of list) {
    console.log(`   ${f.file}  [${f.pattern}] x${f.count}`);
    if (f.sample) console.log(`       ${f.sample}`);
  }
  console.log('');
}

console.log('--- .gitignore 覆盖情况 ---');
for (const s of ignoreStatus) {
  const mark = s.coveredByGitignore ? '✅ 已忽略' : (s.exists ? '❌ 未忽略且存在' : '➖ 未忽略（当前不存在）');
  console.log(`   ${mark}  ${s.path}`);
}
console.log('');

console.log('--- 生成物目录 ---');
for (const g of GENERATED_PRESENT) {
  console.log(`   ${g.exists ? '存在' : '不存在'}  ${g.path}`);
}
console.log('');

console.log('='.repeat(78));
const blocker = bySeverity.critical.length + bySeverity.high.length;
if (blocker === 0) {
  console.log('结论：没有发现严重/高危泄露。');
} else {
  console.log(`结论：发现 ${blocker} 处严重/高危问题，**必须处理后再上传**。`);
}
console.log('='.repeat(78));

process.exit(blocker > 0 ? 1 : 0);
