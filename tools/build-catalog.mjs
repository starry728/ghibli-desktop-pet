/**
 * 构建最终宠物目录 server/data/pets.json
 *
 * 输入：
 *   server/data/scraped-characters.json   抓取到的角色 + 图片
 *   tools/data/roster.mjs                 精选花名册（中文名 / 稀有度 / 属性 …）
 *   tools/data/lines-core.json            考证台词（第一批 35 条）
 *   tools/data/lines-extra.json           考证台词（第二批，可选）
 *
 * 用法：node tools/build-catalog.mjs [--prune]
 *   --prune  删除未被任何宠物引用的图片文件
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FILMS } from './fetch-pets.mjs';
import { ROSTER } from './data/roster.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SCRAPED = path.join(ROOT, 'server', 'data', 'scraped-characters.json');
const OUT = path.join(ROOT, 'server', 'data', 'pets.json');
const IMG_DIR = path.join(ROOT, 'public', 'pets');

const prune = process.argv.includes('--prune');

/** 每部电影的主题色（用于前端点缀） */
const FILM_ACCENT = {
  laputa: '#3f8fd0',
  totoro: '#5aa463',
  chihiro: '#c2544a',
  howl: '#7c5cf0',
  ponyo: '#2fa3b8',
  kaze: '#8a9bb0',
  heron: '#c8992f',
};

function readJsonIfExists(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** 规范化角色名，用于匹配 */
function normName(s) {
  return String(s)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]/g, '');
}

function main() {
  const scraped = readJsonIfExists(SCRAPED);
  if (!scraped?.characters?.length) {
    console.error(`找不到抓取结果或为空：${SCRAPED}\n请先运行: node tools/fetch-pets.mjs`);
    process.exit(1);
  }

  const core = readJsonIfExists(path.join(__dirname, 'data', 'lines-core.json')) ?? [];
  const extra = readJsonIfExists(path.join(__dirname, 'data', 'lines-extra.json')) ?? [];
  const allLines = [...core, ...extra];
  console.log(`台词库：core ${core.length} 条 + extra ${extra.length} 条 = ${allLines.length} 条`);

  // charEn -> line（后者覆盖前者）
  const lineMap = new Map();
  for (const l of allLines) {
    if (!l?.charEn) continue;
    lineMap.set(normName(l.charEn), l);
    // 兼容 "A / B" 形式，注册每个别名
    for (const alias of String(l.charEn).split('/')) {
      const k = normName(alias);
      if (k) lineMap.set(k, l);
    }
  }

  // (filmKey, nameMal) -> scraped character
  const byKey = new Map();
  for (const c of scraped.characters) {
    byKey.set(`${c.filmKey}::${normName(c.nameMal)}`, c);
  }

  const filmByKey = new Map(FILMS.map((f) => [f.key, f]));
  const pets = [];
  const problems = [];
  const usedImages = new Set();

  for (const entry of ROSTER) {
    const film = filmByKey.get(entry.film);
    if (!film) {
      problems.push(`未知电影 key: ${entry.film}（${entry.mal}）`);
      continue;
    }
    const char = byKey.get(`${entry.film}::${normName(entry.mal)}`);
    if (!char) {
      problems.push(`抓取结果中找不到角色：${entry.mal} @ ${film.zh}`);
      continue;
    }

    const line = entry.lineKey ? lineMap.get(normName(entry.lineKey)) : null;
    if (entry.lineKey && !line) {
      problems.push(`台词缺失：${entry.mal} 需要 lineKey="${entry.lineKey}"`);
    }

    const slug = char.slug;
    usedImages.add(char.imageFile);

    pets.push({
      id: slug,
      slug,
      name: entry.zh,
      nameJa: entry.ja,
      nameEn: entry.en,
      nameMal: char.nameMal,
      aliases: [entry.ja, entry.en, char.nameMal].filter(Boolean),
      film: {
        key: film.key,
        zh: film.zh,
        ja: film.ja,
        en: film.en,
        year: film.year,
        malId: film.malId,
        accent: FILM_ACCENT[film.key] ?? '#2f7f8f',
      },
      filmOrderIndex: pets.filter((p) => p.film.key === film.key).length,
      image: `/pets/${char.imageFile}`,
      imageFile: char.imageFile,
      role: char.role,
      rarity: entry.rarity,
      element: entry.element,
      emoji: entry.emoji,
      personality: entry.personality ?? [],
      malUrl: char.malUrl,
      malCharacterId: char.malCharacterId,

      lineJa: line?.lineJa ?? '',
      lineZh: line?.lineZh ?? '',
      lineScene: line?.scene ?? '',
      lineConfidence: line?.confidence ?? 'none',
      lineCharJa: line?.charJa ?? entry.ja,
    });
  }

  // 统计
  const withLine = pets.filter((p) => p.lineJa).length;
  console.log(`\n构建完成：${pets.length} 只宠物（${withLine} 只带有考证过的经典台词）`);
  for (const f of FILMS) {
    const n = pets.filter((p) => p.film.key === f.key).length;
    const l = pets.filter((p) => p.film.key === f.key && p.lineJa).length;
    console.log(`  ${f.zh.padEnd(12)} ${String(n).padStart(2)} 只  (台词 ${l})`);
  }

  if (problems.length) {
    console.log(`\n需要注意的 ${problems.length} 项：`);
    for (const p of problems) console.log(`  - ${p}`);
  }

  const payload = {
    version: 2,
    generatedAt: new Date().toISOString(),
    source: 'MyAnimeList 角色图（https://myanimelist.net）+ 考证台词',
    attribution:
      '角色图片来自 MyAnimeList（cdn.myanimelist.net），版权归各自权利人所有；本项目仅用于个人学习演示。',
    films: FILMS.map((f) => ({
      key: f.key,
      zh: f.zh,
      ja: f.ja,
      en: f.en,
      year: f.year,
      malId: f.malId,
      accent: FILM_ACCENT[f.key] ?? '#2f7f8f',
      total: pets.filter((p) => p.film.key === f.key).length,
    })),
    pets,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2), 'utf8');
  console.log(`\n已写入 ${path.relative(ROOT, OUT)}`);

  // 清理未使用的图片
  const files = fs.existsSync(IMG_DIR) ? fs.readdirSync(IMG_DIR) : [];
  const unused = files.filter((f) => !usedImages.has(f));
  if (unused.length) {
    console.log(`\n未被引用的图片 ${unused.length} 张${prune ? '（已删除）' : '（加 --prune 删除）'}：`);
    for (const f of unused) {
      console.log(`  - ${f}`);
      if (prune) fs.unlinkSync(path.join(IMG_DIR, f));
    }
  }
}

main();
