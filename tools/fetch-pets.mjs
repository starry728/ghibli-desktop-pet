/**
 * 吉卜力角色图抓取器
 *
 * 数据源：MyAnimeList（Jikan 等第三方 API 在本机网络下不可达，MAL 站点可直连）
 *   - 影片页  https://myanimelist.net/anime/{malId}/{slug}
 *     页面中的角色区块内嵌缩略图（lazyload），形如：
 *       <a href=".../character/384/Chihiro_Ogino" class="fw-n">
 *         <img alt="Ogino, Chihiro" data-src="https://cdn.myanimelist.net/r/42x62/images/characters/7/434512.jpg?s=..." />
 *     去掉 `/r/42x62` 尺寸前缀与 `?s=` 缓存串即得原图。
 *
 * 用法：node tools/fetch-pets.mjs [--per-film N] [--dry]
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_IMG_DIR = path.join(ROOT, 'public', 'pets');
const OUT_DATA = path.join(ROOT, 'server', 'data', 'scraped-characters.json');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** 七部宫崎骏电影（malId 已通过 MAL 站内搜索核实） */
export const FILMS = [
  { key: 'laputa', malId: 513, slug: 'Tenkuu_no_Shiro_Laputa', zh: '天空之城', ja: '天空の城ラピュタ', en: 'Castle in the Sky', year: 1986 },
  { key: 'totoro', malId: 523, slug: 'Tonari_no_Totoro', zh: '龙猫', ja: 'となりのトトロ', en: 'My Neighbor Totoro', year: 1988 },
  { key: 'chihiro', malId: 199, slug: 'Sen_to_Chihiro_no_Kamikakushi', zh: '千与千寻', ja: '千と千尋の神隠し', en: 'Spirited Away', year: 2001 },
  { key: 'howl', malId: 431, slug: 'Howl_no_Ugoku_Shiro', zh: '哈尔的移动城堡', ja: 'ハウルの動く城', en: "Howl's Moving Castle", year: 2004 },
  { key: 'ponyo', malId: 2890, slug: 'Gake_no_Ue_no_Ponyo', zh: '悬崖上的金鱼姬', ja: '崖の上のポニョ', en: 'Ponyo', year: 2008 },
  { key: 'kaze', malId: 16662, slug: 'Kaze_Tachinu', zh: '起风了', ja: '風立ちぬ', en: 'The Wind Rises', year: 2013 },
  { key: 'heron', malId: 36699, slug: 'Kimitachi_wa_Dou_Ikiru_ka', zh: '你想活出怎样的人生', ja: '君たちはどう生きるか', en: 'The Boy and the Heron', year: 2023 },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url, { attempts = 4, referer } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        headers: {
          'User-Agent': UA,
          'Accept-Language': 'en-US,en;q=0.9',
          Accept: 'text/html,application/xhtml+xml,image/avif,image/webp,*/*;q=0.8',
          ...(referer ? { Referer: referer } : {}),
        },
      });
      if (res.status === 429 || res.status >= 500) {
        await sleep(2000 * (i + 1));
        lastErr = new Error(`HTTP ${res.status}`);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return { text: await res.text(), res };
    } catch (err) {
      lastErr = err;
      await sleep(1500 * (i + 1));
    }
  }
  throw lastErr ?? new Error(`failed: ${url}`);
}

async function fetchBinary(url, { attempts = 4, referer } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        headers: {
          'User-Agent': UA,
          Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
          ...(referer ? { Referer: referer } : {}),
        },
      });
      if (res.status === 429 || res.status >= 500) {
        await sleep(2000 * (i + 1));
        lastErr = new Error(`HTTP ${res.status}`);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      lastErr = err;
      await sleep(1500 * (i + 1));
    }
  }
  throw lastErr ?? new Error(`failed: ${url}`);
}

/** 从 MAL 影片页解析角色列表（保持页面顺序 = 人气/重要度顺序） */
export function parseCharacters(html, film) {
  const out = [];
  const seen = new Set();

  // 角色锚点 + 紧随其后的缓存图
  const anchorRe =
    /<a href="https:\/\/myanimelist\.net\/character\/(\d+)\/([^"]+)" class="fw-n">\s*<img alt="([^"]*)"[^>]*?data-src="([^"]+)"/g;

  let m;
  while ((m = anchorRe.exec(html))) {
    const [, id, nameSlug, alt, thumb] = m;
    if (seen.has(id)) continue;

    // 角色定位（Main / Supporting）：在同一片段内向后查找
    const window = html.slice(m.index, m.index + 2200);
    let role = 'Supporting';
    if (/(?:>|\s)Main(?:<|\s)/.test(window)) role = 'Main';
    else if (/(?:>|\s)Supporting(?:<|\s)/.test(window)) role = 'Supporting';
    else if (/No\s*data\s*yet/i.test(window)) role = 'Supporting';

    // 去掉 /r/42x62 尺寸前缀与 ?s= 缓存串 => 原图
    const full = thumb.split('?')[0].replace('/r/42x62', '');

    const altName = alt.trim();
    const slugName = decodeURIComponent(nameSlug).replace(/_/g, ' ');
    const display = normalizeMalName(altName || slugName);

    seen.add(id);
    out.push({
      malCharacterId: Number(id),
      malUrl: `https://myanimelist.net/character/${id}/${nameSlug}`,
      nameMal: display,
      nameRaw: altName || slugName,
      role,
      imageUrl: full,
      filmKey: film.key,
      filmMalId: film.malId,
      filmZh: film.zh,
      filmJa: film.ja,
      filmEn: film.en,
      year: film.year,
    });
  }
  return out;
}

/** 解码 HTML 实体（&#039; / &amp; / &quot; / 数字实体等） */
export function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/** MAL 写作 "Ogino, Chihiro" -> "Chihiro Ogino" */
export function normalizeMalName(raw) {
  const t = decodeEntities(String(raw)).replace(/\s+/g, ' ').trim();
  if (t.includes(',')) {
    const [last, first] = t.split(',').map((s) => s.trim());
    return `${first} ${last}`.trim();
  }
  return t;
}

export function slugify(name, fallback) {
  const s = String(name)
    .normalize('NFKD')
    .replace(/[^\x20-\x7E]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || `char-${fallback}`;
}

/** JPEG/PNG/WebP 魔数校验 */
function sniffImage(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return null;
}

async function main() {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry');
  const perFilmArg = args.indexOf('--per-film');
  const perFilm = perFilmArg >= 0 ? Number(args[perFilmArg + 1]) : 8;

  await fs.mkdir(OUT_IMG_DIR, { recursive: true });
  await fs.mkdir(path.dirname(OUT_DATA), { recursive: true });

  const all = [];
  const failures = [];

  for (const film of FILMS) {
    const url = `https://myanimelist.net/anime/${film.malId}/${film.slug}`;
    process.stdout.write(`\n[film] ${film.zh} <${film.en}> ${url}\n`);
    let chars = [];
    try {
      const { text } = await fetchText(url);
      chars = parseCharacters(text, film);
    } catch (err) {
      console.log(`  !! 影片页抓取失败: ${err.message}`);
      failures.push({ film: film.key, error: err.message });
      continue;
    }

    // Main 优先，其次 Supporting；同组保持页面顺序
    const ordered = [
      ...chars.filter((c) => c.role === 'Main'),
      ...chars.filter((c) => c.role !== 'Main'),
    ].slice(0, perFilm);

    console.log(`  解析到 ${chars.length} 个角色，选取 ${ordered.length} 个`);

    for (const c of ordered) {
      const slug = `${film.key}-${slugify(c.nameMal, c.malCharacterId)}`;
      const file = `${slug}.jpg`;
      const dest = path.join(OUT_IMG_DIR, file);

      if (dry) {
        console.log(`  [dry] ${c.role.padEnd(10)} ${c.nameMal}  ->  ${file}`);
        all.push({ ...c, slug, imageFile: file, imageBytes: 0 });
        continue;
      }

      try {
        const buf = await fetchBinary(c.imageUrl, { referer: c.malUrl });
        const kind = sniffImage(buf);
        if (!kind) throw new Error(`不是有效图片 (${buf.length}B)`);
        if (buf.length < 3000) throw new Error(`图片过小 (${buf.length}B)`);
        await fs.writeFile(dest, buf);
        console.log(`  ok  ${c.role.padEnd(10)} ${c.nameMal.padEnd(28)} ${String(buf.length).padStart(7)}B  ${file}`);
        all.push({ ...c, slug, imageFile: file, imageBytes: buf.length });
      } catch (err) {
        console.log(`  !!  ${c.nameMal}: ${err.message}`);
        failures.push({ film: film.key, character: c.nameMal, error: err.message });
      }
      await sleep(650);
    }
    await sleep(1200);
  }

  if (!dry) {
    await fs.writeFile(
      OUT_DATA,
      JSON.stringify({ generatedAt: new Date().toISOString(), films: FILMS, characters: all, failures }, null, 2),
      'utf8'
    );
  }

  console.log(`\n=== 汇总 ===`);
  console.log(`成功图片: ${all.length}`);
  console.log(`失败:     ${failures.length}`);
  for (const f of FILMS) {
    const n = all.filter((c) => c.filmKey === f.key).length;
    console.log(`  ${f.zh.padEnd(12)} ${n} 张`);
  }
  if (!dry) console.log(`\n写到 ${path.relative(ROOT, OUT_DATA)}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
