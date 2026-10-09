/**
 * Edge TTS 客户端（零依赖）
 *
 * 使用微软 Edge 浏览器「大声朗读」背后的在线语音合成服务：
 * 免费、无需 API Key、音质接近神经网络语音。
 *
 * 实现要点（都是实测踩出来的）：
 *  1. 握手必须带 `Origin: chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold`
 *     以及 Pragma / Cache-Control / User-Agent，否则一律 403。
 *     —— 浏览器规范的 WebSocket 不允许自定义请求头，所以用 lib/ws.js 自己握手。
 *  2. Sec-MS-GEC 签名里的 ticks*1e7 会超过 Number.MAX_SAFE_INTEGER，
 *     必须用 BigInt 计算，浮点会因精度丢失算出错误签名 → 403。
 *  3. Sec-MS-GEC-Version 必须跟上一个足够新的 Chromium 版本号，
 *     旧版本号（如 130）同样会被拒。
 *
 * 消息格式：2 字节大端头长度 + 头部文本 + 负载；音频以二进制帧返回，头部带 Path:audio。
 */
import { createHash, randomUUID } from 'node:crypto';
import { connect as wsConnect } from './ws.js';

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const CHROMIUM_FULL_VERSION = '143.0.3650.75';
const CHROMIUM_MAJOR_VERSION = CHROMIUM_FULL_VERSION.split('.')[0];
const SEC_MS_GEC_VERSION = `1-${CHROMIUM_FULL_VERSION}`;

const BASE_URL = 'speech.platform.bing.com/consumer/speech/synthesize/readaloud';
const WSS_URL = `wss://${BASE_URL}/edge/v1?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}`;
const VOICE_LIST_URL = `https://${BASE_URL}/voices/list?trustedclienttoken=${TRUSTED_CLIENT_TOKEN}`;

const WIN_EPOCH = 11644473600; // 1601-01-01 -> 1970-01-01 的秒数

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  `(KHTML, like Gecko) Chrome/${CHROMIUM_MAJOR_VERSION}.0.0.0 Safari/537.36 ` +
  `Edg/${CHROMIUM_MAJOR_VERSION}.0.0.0`;

/** 握手必需的请求头 */
export const WSS_HEADERS = {
  Pragma: 'no-cache',
  'Cache-Control': 'no-cache',
  Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Accept-Language': 'en-US,en;q=0.9',
  'User-Agent': USER_AGENT,
};

/**
 * 生成 Sec-MS-GEC 签名。
 * 必须用 BigInt —— ticks*1e7 远超 2^53，用 Number 会丢精度导致 403。
 */
export function secMsGec(timestampMs = Date.now()) {
  let ticks = BigInt(Math.floor(timestampMs / 1000) + WIN_EPOCH);
  ticks -= ticks % 300n; // 向下取整到 5 分钟
  return createHash('sha256')
    .update(`${ticks * 10000000n}${TRUSTED_CLIENT_TOKEN}`, 'ascii')
    .digest('hex')
    .toUpperCase();
}

function buildUrl() {
  return (
    `${WSS_URL}&Sec-MS-GEC=${secMsGec()}` +
    `&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}` +
    `&ConnectionId=${randomUUID().replace(/-/g, '')}`
  );
}

/** 拼一条协议消息 */
function buildMessage(headers, payload) {
  const headerText = Object.entries(headers).map(([k, v]) => `${k}:${v}`).join('\r\n');
  const head = Buffer.from(`${headerText}\r\n\r\n`, 'utf8');
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const len = Buffer.alloc(2);
  len.writeUInt16BE(head.length, 0);
  return Buffer.concat([len, head, body]);
}

/** 解析一条协议消息 */
function parseMessage(buf) {
  if (buf.length < 2) return null;
  const headerLen = buf.readUInt16BE(0);
  if (buf.length < 2 + headerLen) return null;
  const headerText = buf.subarray(2, 2 + headerLen).toString('utf8');
  const payload = buf.subarray(2 + headerLen);
  const headers = {};
  for (const line of headerText.split('\r\n')) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { headers, payload };
}

function escapeXml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

/** 获取可用语音列表 */
export async function listVoices({ locale } = {}) {
  const res = await fetch(VOICE_LIST_URL, {
    headers: {
      Authority: 'speech.platform.bing.com',
      'User-Agent': USER_AGENT,
      Accept: '*/*',
    },
  });
  if (!res.ok) throw new Error(`获取语音列表失败: HTTP ${res.status}`);
  const all = await res.json();
  return locale ? all.filter((v) => String(v.Locale || '').toLowerCase().startsWith(locale.toLowerCase())) : all;
}

/**
 * 输出格式。
 *
 * 为什么需要 WAV：本机是精简版 Windows，`wmplayer.exe` 已被移除，
 * WPF 的 MediaPlayer / DirectShow 无法播放 MP3（实测 HRESULT 0xC00D1198 且会带崩进程）。
 * 而 PCM WAV 可以用 System.Media.SoundPlayer 播放 —— 它走 WinMM 的 PlaySound，
 * 不需要任何编解码器。因此在线悬浮层用 WAV，浏览器端用体积更小的 MP3。
 */
export const FORMATS = {
  mp3: 'audio-24khz-48kbitrate-mono-mp3',
  wav: 'riff-24khz-16bit-mono-pcm',
  mp3_16k: 'audio-16khz-32kbitrate-mono-mp3',
  wav_16k: 'riff-16khz-16bit-mono-pcm',
};

/**
 * 合成语音
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {string} [opts.voice]  语音名，如 zh-CN-XiaoyiNeural
 * @param {string} [opts.lang]   语言，默认由 voice 推断
 * @param {string} [opts.format] 'mp3' | 'wav'，默认 mp3
 * @param {string} [opts.rate]   语速 '+14%'
 * @param {string} [opts.pitch]  音调 '+45Hz'
 * @param {string} [opts.volume] 音量 '+10%'
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<Buffer>}
 */
export async function synthesize(text, opts = {}) {
  const {
    voice = VOICES.girl,
    lang,
    format = 'mp3',
    rate = '+0%',
    pitch = '+0Hz',
    volume = '+0%',
    timeoutMs = 30000,
  } = opts;

  if (!text || !String(text).trim()) throw new Error('合成文本为空');

  const outputFormat = FORMATS[format] || format;
  const language = lang || voice.split('-').slice(0, 2).join('-');
  const ssml =
    `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${language}'>` +
    `<voice name='${voice}'>` +
    `<prosody pitch='${pitch}' rate='${rate}' volume='${volume}'>${escapeXml(text)}</prosody>` +
    `</voice></speak>`;

  const ws = await wsConnect(buildUrl(), { headers: WSS_HEADERS, timeoutMs: Math.min(timeoutMs, 15000) });

  const chunks = [];
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* ignore */ }
      if (err) reject(err);
      else if (!chunks.length) reject(new Error('语音服务没有返回音频数据'));
      else resolve(Buffer.concat(chunks));
    };
    const timer = setTimeout(() => finish(new Error(`语音合成超时（${timeoutMs}ms）`)), timeoutMs);

    ws.on('message', (data) => {
      if (typeof data === 'string') {
        if (data.includes('Path:turn.end')) finish(null);
        return;
      }
      const msg = parseMessage(data);
      if (!msg) return;
      if (msg.headers.Path === 'audio' && msg.payload.length) chunks.push(msg.payload);
      else if (msg.headers.Path === 'turn.end') finish(null);
    });
    ws.on('close', () => { if (!settled) finish(chunks.length ? null : new Error('语音服务提前关闭连接')); });
    ws.on('error', (e) => finish(e));

    ws.on('open', () => {
      ws.send(buildMessage(
        {
          'X-Timestamp': new Date().toString(),
          'Content-Type': 'application/json; charset=utf-8',
          Path: 'speech.config',
        },
        JSON.stringify({
          context: {
            synthesis: {
              audio: {
                metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' },
                outputFormat: outputFormat,
              },
            },
          },
        })
      ));

      ws.send(buildMessage(
        {
          'X-RequestId': randomUUID().replace(/-/g, ''),
          'Content-Type': 'application/ssml+xml',
          'X-Timestamp': new Date().toString(),
          Path: 'ssml',
        },
        ssml
      ));
    });
  });
}

/* ---------------- 语音预设 ---------------- */

export const VOICES = {
  /**
   * 中文少女 / 动漫音。
   * 微软官方把 zh-CN-XiaoyiNeural 归类为 Cartoon，是当前免费中文语音里
   * 最接近「涂山苏苏」那种稚气少女感的。
   * （zh-CN-XiaoshuangNeural 儿童音已从该服务下架，实测不可用）
   */
  girl: 'zh-CN-XiaoyiNeural',
  gentle: 'zh-CN-XiaoxiaoNeural',
  boyCartoon: 'zh-CN-YunxiaNeural',
  jaGirl: 'ja-JP-NanamiNeural',
  jaGirl2: 'ja-JP-AoiNeural',
  jaGirl3: 'ja-JP-MayuNeural',
  jaMale: 'ja-JP-KeitaNeural',
};

/**
 * 「涂山苏苏」风格参数。
 *
 * 涂山苏苏的声音特征：音域高、偏童声、语速略快、尾音上扬、带一点撒娇的鼻音。
 * zh-CN-XiaoyiNeural 本身是动漫少女音，再叠加
 *   音调 +45Hz（明显抬高，逼近童声）
 *   语速 +14%（活泼、不拖沓）
 *   音量 +10%（明亮、贴耳）
 * 后最接近那种感觉。可在此调整。
 */
export const SUSU_STYLE = {
  voice: VOICES.girl,
  rate: '+14%',
  pitch: '+45Hz',
  volume: '+10%',
};

/** 需要用户批准时的提示语 */
export const APPROVAL_TEXT = '您有新的请求请批准~';

/** 候选风格，供试听后挑选 */
export const STYLE_PRESETS = {
  susu: { label: '涂山苏苏（动漫少女音·默认）', ...SUSU_STYLE },
  susuSoft: { label: '苏苏·温柔版（音调稍低）', voice: VOICES.girl, rate: '+8%', pitch: '+28Hz', volume: '+6%' },
  girl: { label: '标准少女音', voice: VOICES.girl, rate: '+0%', pitch: '+0Hz', volume: '+0%' },
  gentle: { label: '温柔女声', voice: VOICES.gentle, rate: '+0%', pitch: '+0Hz', volume: '+0%' },
  lively: { label: '活泼动漫音（再抬高）', voice: VOICES.girl, rate: '+20%', pitch: '+65Hz', volume: '+12%' },
};
