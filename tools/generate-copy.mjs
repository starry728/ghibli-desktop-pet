/**
 * 命令行批量生成 AI 领养文案。
 *
 * 用法：
 *   node tools/generate-copy.mjs                # 只为缺失的宠物生成
 *   node tools/generate-copy.mjs --force        # 全部重新生成
 *   node tools/generate-copy.mjs --only id1,id2 # 只生成指定的宠物
 *   node tools/generate-copy.mjs --dry          # 只打印将要生成的宠物，不调用 API
 */
import { initEnv, resolveApiKey, maskKey, DEEPSEEK_MODEL } from '../server/config.js';
import { loadCatalog, getStats, copyStore } from '../server/catalog.js';
import { generateCopy } from '../server/copywriter.js';

initEnv();

const args = process.argv.slice(2);
const has = (f) => args.includes(`--${f}`);
const val = (f) => {
  const i = args.indexOf(`--${f}`);
  return i >= 0 ? args[i + 1] : undefined;
};

async function main() {
  await loadCatalog();
  const stats = await getStats();
  const { key, source } = resolveApiKey();

  console.log(`宠物总数：${stats.total}`);
  console.log(`已有文案：${stats.withCopy}`);
  console.log(`API Key ：${key ? `${maskKey(key)}  (${source})` : `未找到 — ${source}`}`);
  console.log(`模型    ：${DEEPSEEK_MODEL}`);
  console.log('');

  const force = has('force');
  const petIds = val('only')?.split(',').map((s) => s.trim()).filter(Boolean);

  const copy = await copyStore.load();
  const catalog = await loadCatalog();
  const targets = catalog.pets.filter(
    (p) => (!petIds || petIds.includes(p.id)) && (force || !copy.items?.[p.id])
  );

  if (!targets.length) {
    console.log('没有需要生成的宠物。用 --force 可以全部重写。');
    return;
  }

  console.log(`将处理 ${targets.length} 只宠物：`);
  for (const p of targets) console.log(`  - ${p.id.padEnd(30)} ${p.name}（${p.film.zh}）`);

  if (has('dry')) {
    console.log('\n--dry 模式，未调用 API。');
    return;
  }

  console.log('');
  let last = 0;
  const result = await generateCopy({
    petIds: targets.map((p) => p.id),
    force,
    onProgress: (ev) => {
      if (ev.type === 'pet' && ev.done !== last) {
        last = ev.done;
        const pct = Math.round((ev.done / ev.total) * 100);
        process.stdout.write(`\r  生成中 ${String(pct).padStart(3)}%  (${ev.done}/${ev.total})  ${ev.name}          `);
      } else if (ev.type === 'error') {
        console.log(`\n  !! ${ev.message}`);
      }
    },
  });

  console.log(`\n\n完成：成功 ${result.done} / ${result.total}（来源：${result.source}）`);
  const after = await getStats();
  console.log(`当前文案覆盖：${after.withCopy}/${after.total}`);
}

main().catch((err) => {
  console.error('\n生成失败:', err);
  process.exit(1);
});
