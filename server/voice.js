/**
 * 语音解析：决定某只宠物的台词用「电影原声」还是「TTS 合成」，并把音频准备好。
 *
 * 优先级：
 *   1. 原声文件  public/voice/<petId>.mp3|.wav|.m4a|.ogg
 *      —— 用户自己放入的电影原声片段，程序不会覆盖、也不会自动下载
 *   2. Edge TTS 合成（日语），缓存到 server/data/generated/voice/
 *
 * 这样设计的原因：电影原声属于版权素材，无法自动获取；
 * 但只要你把剪好的音频丢进 public/voice/，整套流程立刻切换成原声，无需改代码。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { PUBLIC_DIR, GENERATED_DIR } from './config.js';
import { synthesize, VOICES, SUSU_STYLE, STYLE_PRESETS, APPROVAL_TEXT } from './lib/edge-tts.js';

export const VOICE_DIR = path.join(PUBLIC_DIR, 'voice');            // 用户提供的原声
export const VOICE_CACHE_DIR = path.join(GENERATED_DIR, 'voice');   // TTS 缓存

const ORIGINAL_EXTS = ['.mp3', '.wav', '.m4a', '.ogg', '.opus', '.flac', '.aac'];

fs.mkdirSync(VOICE_DIR, { recursive: true });
fs.mkdirSync(VOICE_CACHE_DIR, { recursive: true });

/** 查找该宠物的原声文件 */
export function findOriginal(petId) {
  for (const ext of ORIGINAL_EXTS) {
    const p = path.join(VOICE_DIR, petId + ext);
    if (fs.existsSync(p) && fs.statSync(p).size > 512) {
      return { file: p, url: '/voice/' + petId + ext, ext: ext.slice(1) };
    }
  }
  return null;
}

/** 原声清单（供前端/文档展示哪些宠物已有原声） */
export function listOriginalVoicePets() {
  const out = {};
  let files = [];
  try {
    files = fs.readdirSync(VOICE_DIR);
  } catch {
    return out;
  }
  for (const f of files) {
    const ext = path.extname(f).toLowerCase();
    if (!ORIGINAL_EXTS.includes(ext)) continue;
    let size = 0;
    try { size = fs.statSync(path.join(VOICE_DIR, f)).size; } catch { /* ignore */ }
    if (size > 512) out[path.basename(f, ext)] = { file: f, bytes: size };
  }
  return out;
}

/** TTS 缓存文件名（文本 + 语音参数 → 哈希，不含格式） */
function cacheKey(text, opts) {
  return createHash('sha1')
    .update(JSON.stringify({ text, voice: opts.voice, rate: opts.rate, pitch: opts.pitch, volume: opts.volume }))
    .digest('hex')
    .slice(0, 16);
}

/**
 * 合成（带磁盘缓存）。返回可访问的 URL。
 *
 * format：
 *   'wav' —— 给桌面悬浮层用。本机是精简版 Windows（wmplayer.exe 已移除），
 *            WPF MediaPlayer 放不了 MP3，而 PCM WAV 可以用 WinMM 的 PlaySound 放，无需编解码器。
 *   'mp3' —— 给浏览器用，体积小。
 *
 * @param {string} text
 * @param {object} opts 同 edge-tts 的 synthesize，外加 format
 * @returns {Promise<{url:string, file:string, cached:boolean, bytes:number, format:string}>}
 */
export async function ttsCached(text, opts = {}) {
  // 注意：实测该服务已不支持 PCM/WAV 输出（配置被接受但随后断流），
  // 只有 mp3 与 webm-opus 可用，所以默认 mp3。
  const format = opts.format === 'wav' ? 'wav' : 'mp3';
  const full = {
    voice: opts.voice || VOICES.jaGirl,
    rate: opts.rate || '+0%',
    pitch: opts.pitch || '+0Hz',
    volume: opts.volume || '+0%',
  };
  const name = `${cacheKey(text, full)}.${format}`;
  const file = path.join(VOICE_CACHE_DIR, name);

  if (fs.existsSync(file) && fs.statSync(file).size > 512) {
    return { url: '/voice-cache/' + name, file, cached: true, bytes: fs.statSync(file).size, format };
  }

  const buf = await synthesize(text, { ...full, format });
  await fsp.writeFile(file, buf);
  return { url: '/voice-cache/' + name, file, cached: false, bytes: buf.length, format };
}

/**
 * 确保某个文本同时有 wav 与 mp3 两种缓存（wav 给悬浮层，mp3 给浏览器）
 * @returns {Promise<{wav:string, mp3:string, wavBytes:number, mp3Bytes:number, cached:boolean}>}
 */
export async function ttsBoth(text, opts = {}) {
  const wav = await ttsCached(text, { ...opts, format: 'wav' });
  const mp3 = await ttsCached(text, { ...opts, format: 'mp3' });
  return {
    wav: wav.url,
    mp3: mp3.url,
    wavBytes: wav.bytes,
    mp3Bytes: mp3.bytes,
    cached: wav.cached && mp3.cached,
  };
}

/**
 * 解析「角色经典台词」的音频。
 * @param {object} pet pets.json 中的宠物对象
 * @param {object} [opts]
 * @param {string} [opts.forceSource] 'original' | 'tts' —— 强制来源（用于对比试听）
 * @param {string} [opts.format] 'wav'（悬浮层，默认）| 'mp3'（浏览器）
 * @returns {Promise<{url:string, source:'original'|'tts'|'none', cached:boolean, text:string, reason?:string}>}
 */
export async function resolveLineAudio(pet, opts = {}) {
  const text = pet.lineJa;
  if (!text) {
    return { url: '', source: 'none', cached: true, text: '', reason: '该角色在片中无台词' };
  }

  if (opts.forceSource !== 'tts') {
    const orig = findOriginal(pet.id);
    if (orig) {
      // 原声通常是 mp3/m4a：悬浮层放不了 mp3，但 SoundPlayer 也支持直接从文件读 WAV。
      // 这里仍然把原声交给悬浮层，由它自行决定用哪种播放器（见 PetOverlay 的 Play()）。
      return { url: orig.url, source: 'original', cached: true, text, bytes: fs.statSync(orig.file).size, format: orig.ext };
    }
    if (opts.forceSource === 'original') {
      return { url: '', source: 'none', cached: true, text, reason: '没有找到该角色的原声文件' };
    }
  }

  try {
    // 日语台词用日语女声读；若角色偏男性/粗犷，可由调用方指定 voice
    const style = {
      voice: opts.voice || VOICES.jaGirl,
      rate: opts.rate || '-2%',
      pitch: opts.pitch || '+0Hz',
      volume: opts.volume || '+0%',
      format: opts.format || 'mp3',
    };
    const r = await ttsCached(text, style);
    return { url: r.url, source: 'tts', cached: r.cached, text, bytes: r.bytes, format: r.format };
  } catch (err) {
    return { url: '', source: 'none', cached: false, text, reason: 'TTS 合成失败：' + err.message };
  }
}

/** 批准提示音（涂山苏苏风格，中文） */
export async function resolveApprovalAudio(opts = {}) {
  const presetKey = opts.preset || process.env.APPROVAL_VOICE_PRESET || 'susu';
  const preset = STYLE_PRESETS[presetKey] || SUSU_STYLE;
  const text = opts.text || APPROVAL_TEXT;
  try {
    const r = await ttsCached(text, {
      voice: opts.voice || preset.voice,
      rate: opts.rate || preset.rate,
      pitch: opts.pitch || preset.pitch,
      volume: opts.volume || preset.volume,
      format: opts.format || 'mp3',
    });
    return {
      url: r.url, source: 'tts', cached: r.cached, text, bytes: r.bytes, format: r.format,
      preset: presetKey, voice: opts.voice || preset.voice,
    };
  } catch (err) {
    return { url: '', source: 'none', cached: false, text, reason: 'TTS 合成失败：' + err.message };
  }
}

/** 任意中文提示音的合成（给自定义提醒用） */
export async function resolveSayAudio(text, opts = {}) {
  const preset = STYLE_PRESETS[opts.preset] || SUSU_STYLE;
  const r = await ttsCached(text, {
    voice: opts.voice || preset.voice,
    rate: opts.rate || preset.rate,
    pitch: opts.pitch || preset.pitch,
    volume: opts.volume || preset.volume,
    format: opts.format || 'mp3',
  });
  return { url: r.url, source: 'tts', cached: r.cached, text, bytes: r.bytes, format: r.format };
}

export { VOICES, SUSU_STYLE, STYLE_PRESETS, APPROVAL_TEXT };
