/**
 * 生成「原声截取清单」
 *
 * 背景：吉卜力电影原声属于版权素材，无法自动获取（实测 20+ 站点/数据集均无单句台词音频）。
 * 但 kitsunekko.net 提供**官方日语字幕**（含逐句时间戳），可以精确定位台词出现的位置。
 *
 * 本脚本：
 *   1. 下载 5 部电影的日语 SRT（另 2 部无字幕源）
 *   2. BOM 感知解码（⚠️ 千与千寻是 UTF-16LE，其余多为 UTF-8，猜错就全是乱码）
 *   3. 把每只宠物的 lineJa 与字幕 cue 做模糊匹配（支持合并相邻 cue —— 字幕常把一句话切成两段）
 *   4. 输出 public/voice/clips.json：每句台词的精确起止时间
 *
 * 用户拿这份清单，在自己合法持有的蓝光/正版片源上用 ffmpeg 按时间戳切出音频，
 * 命名为 <宠物id>.mp3 放进 public/voice/，程序就会自动优先使用原声（见 server/voice.js）。
 *
 * 用法：node tools/build-voice-clips.mjs [--refresh]
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CACHE_DIR = path.join(ROOT, 'server', 'data', 'generated', 'subtitles');
const OUT_FILE = path.join(ROOT, 'public', 'voice', 'clips.json');
const README_FILE = path.join(ROOT, 'public', 'voice', 'README.md');

const BASE = 'https://kitsunekko.net/subtitles/japanese';

/** 电影 -> 字幕 URL（子代理已实测全部 200） */
const SOURCES = {
  chihiro: {
    url: `${BASE}/Spirited%20Away%20(Sen%20to%20Chihiro%20no%20Kamikakushi)/Sen%20to%20Chihiro%20no%20Kamikakushi.srt`,
    note: 'UTF-16LE',
  },
  howl: {
    url: `${BASE}/Howl's%20Moving%20Castle/Howl's%20Moving%20Castle%20(2004).ja.srt`,
    note: 'UTF-8',
  },
  totoro: {
    url: `${BASE}/Tonari%20no%20Totoro/My_Neighbor_Totoro_(1988)_%5B1080p%2CBluRay%2Cx264%2Cflac%5D_-_THORA%20v2%20-%20JP.srt`,
    note: 'UTF-8+BOM',
  },
  ponyo: {
    url: `${BASE}/Gake%20no%20Ue%20no%20Ponyo/Ponyo.WEBRip.Netflix.ja%5Bcc%5D.srt`,
    note: 'UTF-8+BOM',
  },
  laputa: {
    url: `${BASE}/Laputa_Castle_In_The_Sky/Laputa_Castle_In_The_Sky_(1986.08.02).srt`,
    note: 'UTF-8+BOM',
  },
  // kaze (起风了) 和 heron (你想活出怎样的人生) 在 kitsunekko 无对应日语字幕
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 下载与解码 ---------------- */

function decodeBuffer(buf) {
  // BOM 驱动：这是踩过两次坑之后唯一正确的做法
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.subarray(2).toString('utf16le');
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    // UTF-16BE -> 交换字节序后按 LE 解
    const swapped = Buffer.from(buf.subarray(2));
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.subarray(3).toString('utf8');
  }
  // 无 BOM：UTF-16LE 的日文常以 0x1A 之类字节开头，用「零字节比例」判断
  let zeros = 0;
  for (let i = 1; i < Math.min(buf.length, 400); i += 2) if (buf[i] === 0) zeros++;
  if (zeros > 60) return buf.toString('utf16le');
  return buf.toString('utf8');
}

async function fetchSubtitle(key, { refresh } = {}) {
  await fsp.mkdir(CACHE_DIR, { recursive: true });
  const dest = path.join(CACHE_DIR, `${key}.srt`);

  if (!refresh && fs.existsSync(dest) && fs.statSync(dest).size > 1000) {
    return { file: dest, bytes: fs.statSync(dest).size, cached: true };
  }

  const src = SOURCES[key];
  const res = await fetch(src.url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fsp.writeFile(dest, buf);
  return { file: dest, bytes: buf.length, cached: false };
}

/* ---------------- SRT 解析 ---------------- */

function parseSrt(text) {
  const cues = [];
  const blocks = text.replace(/\r\n/g, '\n').split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2) continue;
    const timeLine = lines.find((l) => l.includes('-->'));
    if (!timeLine) continue;
    const m = /(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)/.exec(timeLine);
    if (!m) continue;
    const start = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 1000;
    const end = (+m[5]) * 3600 + (+m[6]) * 60 + (+m[7]) + (+m[8]) / 1000;
    const textLines = lines.filter((l) => l !== timeLine && !/^\d+$/.test(l));
    if (!textLines.length) continue;
    cues.push({ start, end, text: textLines.join(' ') });
  }
  return cues.sort((a, b) => a.start - b.start);
}

/* ---------------- 模糊匹配 ---------------- */

/** 去掉空格、标点、说话人标注，只留假名/汉字/拉丁字母数字 */
function normalize(s) {
  return String(s)
    .replace(/[（(][^）)]{0,12}[）)]/g, '')       // 说话人标注，如 （ハク）
    .replace(/[\s\u3000]/g, '')
    .replace(/[「」『』、。，．！？!?…‥・—―ー~〜\-:：;；"'“”‘’\[\]【】]/g, '')
    .toLowerCase();
}

function bigrams(s) {
  const out = new Map();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    out.set(g, (out.get(g) || 0) + 1);
  }
  return out;
}

/** Dice 系数，对日文很稳 */
function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const A = bigrams(a);
  const B = bigrams(b);
  let inter = 0;
  let totalA = 0;
  let totalB = 0;
  for (const v of A.values()) totalA += v;
  for (const v of B.values()) totalB += v;
  for (const [g, c] of A) if (B.has(g)) inter += Math.min(c, B.get(g));
  return (2 * inter) / (totalA + totalB);
}

/**
 * 在 cues 中找到最匹配 target 的连续片段。
 * 字幕经常把一句话切成 2~3 个 cue，所以要合并相邻 cue 再比。
 */
function findBestMatch(cues, target, { maxMerge = 4, threshold = 0.55 } = {}) {
  const t = normalize(target);
  let best = null;

  for (let i = 0; i < cues.length; i++) {
    let merged = '';
    for (let k = 0; k < maxMerge && i + k < cues.length; k++) {
      // 相邻 cue 之间超过 4 秒就不算同一句
      if (k > 0 && cues[i + k].start - cues[i + k - 1].end > 4) break;
      merged += normalize(cues[i + k].text);
      const score = similarity(merged, t);
      // 合并越多分数通常会涨，用「分数 - 轻微惩罚」挑最紧凑的匹配
      const adjusted = score - k * 0.012;
      if (!best || adjusted > best.adjusted) {
        best = {
          adjusted,
          score,
          start: cues[i].start,
          end: cues[i + k].end,
          cues: k + 1,
          text: cues.slice(i, i + k + 1).map((c) => c.text).join(' '),
        };
      }
    }
  }

  if (!best || best.score < threshold) return null;
  return best;
}

function fmtTime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`;
}

/* ---------------- 主流程 ---------------- */

async function main() {
  const refresh = process.argv.includes('--refresh');
  const pets = JSON.parse(fs.readFileSync(path.join(ROOT, 'server', 'data', 'pets.json'), 'utf8')).pets;

  console.log('=== 下载/读取日语字幕 ===');
  const cueMap = {};
  for (const key of Object.keys(SOURCES)) {
    try {
      const r = await fetchSubtitle(key, { refresh });
      const text = decodeBuffer(await fsp.readFile(r.file));
      const cues = parseSrt(text);
      cueMap[key] = cues;
      console.log(`  ${key.padEnd(9)} ${String(r.bytes).padStart(7)}B  ${String(cues.length).padStart(5)} cues  ${r.cached ? '(缓存)' : '(已下载)'}  首个时间码 ${cues.length ? fmtTime(cues[0].start) : '-'}`);
    } catch (err) {
      console.log(`  ${key.padEnd(9)} 失败: ${err.message}`);
    }
    await sleep(600);
  }

  console.log('\n=== 匹配台词 ===');
  const clips = [];
  const stats = { matched: 0, noSubtitle: 0, noMatch: 0, noLine: 0 };

  for (const pet of pets) {
    if (!pet.lineJa) {
      stats.noLine++;
      continue;
    }
    const cues = cueMap[pet.film.key];
    if (!cues) {
      stats.noSubtitle++;
      clips.push({
        petId: pet.id, name: pet.name, film: pet.film.zh, filmKey: pet.film.key,
        lineJa: pet.lineJa, lineZh: pet.lineZh,
        matched: false, reason: '该片没有可用的日语字幕时间轴',
      });
      continue;
    }

    const hit = findBestMatch(cues, pet.lineJa);
    if (!hit) {
      stats.noMatch++;
      clips.push({
        petId: pet.id, name: pet.name, film: pet.film.zh, filmKey: pet.film.key,
        lineJa: pet.lineJa, lineZh: pet.lineZh,
        matched: false, reason: '字幕中未找到足够相似的句子',
      });
      continue;
    }

    stats.matched++;
    clips.push({
      petId: pet.id,
      name: pet.name,
      nameJa: pet.nameJa,
      film: pet.film.zh,
      filmKey: pet.film.key,
      filmJa: pet.film.ja,
      lineJa: pet.lineJa,
      lineZh: pet.lineZh,
      matched: true,
      start: Number(hit.start.toFixed(3)),
      end: Number(hit.end.toFixed(3)),
      startHuman: fmtTime(hit.start),
      endHuman: fmtTime(hit.end),
      durationSec: Number((hit.end - hit.start).toFixed(2)),
      score: Number(hit.score.toFixed(3)),
      mergedCues: hit.cues,
      subtitleText: hit.text,
    });
  }

  const withTime = clips.filter((c) => c.matched).sort((a, b) => a.film.localeCompare(b.film) || a.start - b.start);

  const payload = {
    generatedAt: new Date().toISOString(),
    source: 'kitsunekko.net 日语字幕（BOM 感知解码 + Dice 双字母模糊匹配，支持相邻 cue 合并）',
    note: '时间戳对应的是字幕时间轴，通常与蓝光/正版片源一致；不同片源可能有偏移，建议前后各留 0.5 秒并人工试听。',
    summary: {
      totalPets: pets.length,
      petsWithLine: pets.length - stats.noLine,
      located: stats.matched,
      noSubtitle: stats.noSubtitle,
      noMatch: stats.noMatch,
      filmsWithSubtitle: Object.keys(cueMap),
      filmsWithoutSubtitle: ['kaze', 'heron'],
    },
    clips,
  };

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(payload, null, 2), 'utf8');

  console.log(`\n精确命中 ${stats.matched} 句 / 有台词的 ${payload.summary.petsWithLine} 句`);
  console.log(`  无字幕可用        ${stats.noSubtitle}`);
  console.log(`  字幕里没找到      ${stats.noMatch}`);
  console.log(`  角色本身无台词    ${stats.noLine}`);
  console.log(`\n已写入 ${path.relative(ROOT, OUT_FILE)}`);

  console.log('\n命中的句子（前 20 条）：');
  for (const c of withTime.slice(0, 20)) {
    console.log(`  ${c.startHuman}  +${String(c.durationSec).padStart(5)}s  ${String(c.score).padEnd(5)}  ${c.name.padEnd(8)} ${c.lineJa.slice(0, 30)}`);
  }

  fs.writeFileSync(README_FILE, buildReadme(payload), 'utf8');
  console.log(`\n已写入 ${path.relative(ROOT, README_FILE)}`);
}

function buildReadme(payload) {
  const s = payload.summary;
  const rows = payload.clips
    .filter((c) => c.matched)
    .sort((a, b) => a.filmKey.localeCompare(b.filmKey) || a.start - b.start)
    .map((c) => `| ${c.name} | ${c.film} | \`${c.startHuman}\` | ${c.durationSec}s | ${c.score} | ${c.lineJa.replace(/\|/g, '\\|')} |`)
    .join('\n');

  return `# 原声目录（public/voice/）

## 这个目录是干什么的

桌面宠物念台词时，会**优先**使用这个目录里的音频文件：

\`\`\`
public/voice/<宠物id>.mp3     ← 你放进去的电影原声片段
\`\`\`

只要文件存在，程序就自动把它当作「原声」播放；不存在则回退到日语 TTS 合成。
不需要改任何代码，放进去重启后端即可生效。

支持格式：\`.mp3\` \`.wav\` \`.m4a\` \`.ogg\` \`.opus\` \`.flac\` \`.aac\`

宠物 id 见 \`server/data/pets.json\` 的 \`id\` 字段，也可以用
\`GET /api/voice/presets\` 查看当前已有哪些原声。

---

## ⚠️ 为什么这里默认是空的

**电影原声属于版权素材，本项目不会、也无法自动下载。**
我实测了 20 多个候选站点与 4 类数据集（B 站、语音素材站、Freesound、HuggingFace、
GitHub 数据集检索等），**没有任何可达来源能直接提供吉卜力单句台词的原声音频**：

- B 站：接口能拿到音频流，但搜不到包含这些台词的内容，且搜索接口连调 2~3 次即被 \`-412\` 封禁；
  正片对白还与 BGM/音效混录，切出来并不干净
- 语音素材站（anime-voice.com / koe-voice.com / voice-quality.com）：域名停放页或已下线
- \`joujiboi/japanese-anime-speech-v2\`（292,637 条）：逐行核对后确认**全部来自 galgame，无一条吉卜力**
- GitHub / HuggingFace / Freesound / archive.org / YouTube：无可达资源或全部超时

所以这里提供的是**替代方案**：精确的截取时间戳清单。

---

## 怎么用（推荐路径）

### 1. 找到时间戳

\`clips.json\` 里记录了每句台词在片中的精确起止时间。
时间轴来自 **kitsunekko.net 的官方日语字幕**（BOM 感知解码 + Dice 双字母模糊匹配，支持合并被切开的相邻字幕）。

本次结果：**${s.located} 句精确定位**（有台词的角色共 ${s.petsWithLine} 个）

| 角色 | 电影 | 起始时间 | 时长 | 匹配度 | 台词 |
| --- | --- | --- | --- | --- | --- |
${rows}

> 未列出的角色：${s.noSubtitle} 个所属电影没有可用日语字幕（**起风了**、**你想活出怎样的人生**），
> ${s.noMatch} 个在字幕中未找到足够相似的句子。

### 2. 从你**自己合法持有**的片源里切出音频

\`\`\`bash
# 以无脸男为例：从 00:37:36.4 开始切 3 秒
ffmpeg -ss 00:37:36.400 -t 3 -i "你的片源.mkv" -vn -acodec libmp3lame -q:a 4 \\
       "public/voice/chihiro-kaonashi.mp3"
\`\`\`

建议：
- 前后各留 0.3~0.5 秒余量，**切完一定要试听**（不同片源的时间轴可能有偏移）
- 单声道、22~44kHz 即可，文件别太大
- 对白与 BGM 是混录的，这样切出来的原声会带一点背景音——这是正常的

### 3. 重启后端

\`\`\`bash
npm start
\`\`\`

然后访问 \`GET /api/voice/line/<宠物id>\`，\`source\` 字段会变成 \`original\`。

---

## 其它可用手段

- \`GET /api/voice/line/<宠物id>?source=tts\` —— 强制用 TTS 合成，方便与原声对比
- \`GET /api/voice/presets\` —— 查看当前识别到多少个原声文件
- 没有原声时，程序用 **Edge TTS 的日语神经语音**合成，40 个角色立刻都能说话，完全合法可批量

---

## 重新生成时间戳

\`\`\`bash
node tools/build-voice-clips.mjs            # 用缓存
node tools/build-voice-clips.mjs --refresh  # 重新下载字幕
\`\`\`
`;
}

main().catch((err) => {
  console.error('生成失败:', err);
  process.exit(1);
});
