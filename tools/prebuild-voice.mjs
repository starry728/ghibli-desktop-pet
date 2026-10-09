/**
 * 预生成语音包（离线可用）
 *
 * 为什么要做这个：
 *   Edge TTS 是**在线**服务。断网时合成必然失败，service/voice.js 会返回空 audioUrl，
 *   悬浮层拿到空地址就静默什么都不做 —— 用户只会觉得「右键让它说话没反应」。
 *   而且即使联网，第一次说话也要等 1~3 秒（正在合成），期间悬浮层界面是卡住的。
 *
 * 这个脚本把「所有角色的经典台词」+「批准提醒（各语音预设）」一次性合成好，
 * 放进 public/voice-cache/ 并提交进仓库。之后：
 *   · 断网也能说话（直接读本地文件）
 *   · 第一次点击即时出声（不需要现场合成）
 *
 * 命名规则与 server/voice.js 的缓存键完全一致（同一个 hash），
 * 所以运行时能直接命中，不会重复合成。
 *
 * 用法：
 *   node tools/prebuild-voice.mjs            # 只补缺失的
 *   node tools/prebuild-voice.mjs --force    # 全部重新生成
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const { getCatalog, loadCatalog } = await import('../server/catalog.js');
const { ttsCached, resolveLineAudio, VOICE_DIR, VOICE_CACHE_DIR, STYLE_PRESETS, APPROVAL_TEXT } =
  await import('../server/voice.js');

const OUT_DIR = path.join(ROOT, 'public', 'voice-cache');
const force = process.argv.includes('--force');

await fsp.mkdir(OUT_DIR, { recursive: true });

/** 把生成缓存里的文件复制到 public/voice-cache（入库目录） */
async function publish(name) {
  const src = path.join(VOICE_CACHE_DIR, name);
  const dest = path.join(OUT_DIR, name);
  if (!fs.existsSync(src)) return { ok: false, reason: '生成缓存里没有这个文件' };
  await fsp.copyFile(src, dest);
  return { ok: true, bytes: fs.statSync(dest).size };
}

await loadCatalog();
const pets = getCatalog().pets.filter((p) => p.lineJa);

console.log(`=== 预生成语音包 ===`);
console.log(`有台词的角色: ${pets.length} 个`);
console.log(`输出目录    : ${path.relative(ROOT, OUT_DIR)}`);
console.log(`模式        : ${force ? '全部重新生成' : '只补缺失'}`);
console.log('');

let done = 0;
let skipped = 0;
let failed = 0;
let totalBytes = 0;

/* ---------------- 1. 角色台词（日语 TTS） ---------------- */

console.log('--- 角色台词 ---');

for (const pet of pets) {
  // 先看看生成缓存里是不是已经有了
  const probe = await ttsCached(pet.lineJa, {
    voice: process.env.LINE_VOICE || 'ja-JP-NanamiNeural',
    rate: '-2%',
    pitch: '+0Hz',
    volume: '+0%',
    format: 'mp3',
  });

  const name = path.basename(probe.file);
  const dest = path.join(OUT_DIR, name);
  const exists = fs.existsSync(dest) && fs.statSync(dest).size > 512;

  if (exists && !force) {
    skipped++;
    totalBytes += fs.statSync(dest).size;
    continue;
  }

  try {
    const r = await publish(name);
    if (!r.ok) throw new Error(r.reason);
    done++;
    totalBytes += r.bytes;
    process.stdout.write(
      `\r  [${String(done + skipped).padStart(2)}/${pets.length}] ${pet.name.padEnd(8)} ${String(r.bytes).padStart(6)}B   `
    );
    await new Promise((s) => setTimeout(s, 350)); // 别把服务打太急
  } catch (err) {
    failed++;
    console.log(`\n  !! ${pet.name} 失败: ${err.message}`);
  }
}

/* ---------------- 2. 批准提醒（每个语音预设一份） ---------------- */

console.log('\n--- 批准提醒（各预设）---');

const approvalSkipped = [];
for (const [key, preset] of Object.entries(STYLE_PRESETS)) {
  try {
    const r = await ttsCached(APPROVAL_TEXT, {
      voice: preset.voice,
      rate: preset.rate,
      pitch: preset.pitch,
      volume: preset.volume,
      format: 'mp3',
    });
    const name = path.basename(r.file);
    const dest = path.join(OUT_DIR, name);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 512 && !force) {
      approvalSkipped.push(key);
      totalBytes += fs.statSync(dest).size;
      console.log(`  ${key.padEnd(10)} 已存在`);
      continue;
    }
    const pub = await publish(name);
    done++;
    totalBytes += pub.bytes;
    console.log(`  ${key.padEnd(10)} ${String(pub.bytes).padStart(6)}B  ${preset.label || ''}`);
    await new Promise((s) => setTimeout(s, 350));
  } catch (err) {
    failed++;
    console.log(`  ${key} 失败: ${err.message}`);
  }
}

/* ---------------- 汇总 ---------------- */

const files = fs.readdirSync(OUT_DIR).filter((f) => f.endsWith('.mp3'));
const allBytes = files.reduce((a, f) => a + fs.statSync(path.join(OUT_DIR, f)).size, 0);

console.log('');
console.log('='.repeat(60));
console.log(`本次新生成 : ${done} 个`);
console.log(`跳过已存在 : ${skipped} 个角色 + ${approvalSkipped.length} 个预设`);
console.log(`失败       : ${failed} 个`);
console.log(`目录内共   : ${files.length} 个文件，${(allBytes / 1024 / 1024).toFixed(2)} MB`);
console.log('='.repeat(60));

// 写一份清单，运行时可以据此判断「离线音频是否齐全」
const manifest = {
  generatedAt: new Date().toISOString(),
  note: '预生成的离线语音包。server/voice.js 会优先从这里读取，断网也能说话。',
  approvalText: APPROVAL_TEXT,
  presets: Object.keys(STYLE_PRESETS),
  fileCount: files.length,
  totalBytes: allBytes,
  files,
};
fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
console.log(`已写入 ${path.relative(ROOT, path.join(OUT_DIR, 'manifest.json'))}`);
