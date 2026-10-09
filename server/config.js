/**
 * 全局配置：路径、端口、模型，以及 DeepSeek API Key 的解析。
 *
 * API Key 解析优先级（全部只读，不会写入任何地方）：
 *   1. 进程环境变量 DEEPSEEK_API_KEY
 *   2. 进程环境变量 DEEPSEEK_KEY / DS_API_KEY / DEEPSEEK_TOKEN
 *   3. 项目根目录 .env 文件（由 lib/dotenv.js 载入 process.env）
 *   4. 本机凭据文件（~/.dsh/.credentials.yaml 等，见 lib/credentials.js）
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDotenv } from './lib/dotenv.js';
import { findKeyInCredentialFiles } from './lib/credentials.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(__dirname, '..');
export const SERVER_DIR = __dirname;
export const DATA_DIR = path.join(SERVER_DIR, 'data');
export const GENERATED_DIR = path.join(DATA_DIR, 'generated');
export const WEB_DIR = path.join(ROOT, 'web');
export const PUBLIC_DIR = path.join(ROOT, 'public');

export const PETS_FILE = path.join(DATA_DIR, 'pets.json');
export const COPY_FILE = path.join(GENERATED_DIR, 'copy.json');
export const ADOPTIONS_FILE = path.join(GENERATED_DIR, 'adoptions.json');

export const HOST = process.env.HOST || '127.0.0.1';
export const PORT = Number(process.env.PORT || 8787);
export const WEB_DEV_PORT = Number(process.env.WEB_DEV_PORT || 5173);

export const DEEPSEEK_BASE_URL = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
export const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
export const DEEPSEEK_TIMEOUT_MS = Number(process.env.DEEPSEEK_TIMEOUT_MS || 120000);

const ENV_KEYS = ['DEEPSEEK_API_KEY', 'DEEPSEEK_KEY', 'DS_API_KEY', 'DEEPSEEK_TOKEN'];

let cached = null;

/** 载入 .env（幂等） */
export function initEnv() {
  loadDotenv(path.join(ROOT, '.env'));
}

/**
 * 解析 DeepSeek API Key。
 * @returns {{key:string|null, source:string, envVar:string|null}}
 */
export function resolveApiKey({ refresh = false } = {}) {
  if (cached && !refresh) return cached;

  // 1) 环境变量（含 .env 注入的）
  for (const name of ENV_KEYS) {
    const v = process.env[name];
    if (v && v.trim().length >= 16) {
      cached = { key: v.trim(), source: `环境变量 ${name}`, envVar: name };
      return cached;
    }
  }

  // 2) 本机凭据文件
  const found = findKeyInCredentialFiles();
  if (found) {
    cached = { key: found.key, source: `凭据文件 ${found.source}`, envVar: null };
    return cached;
  }

  cached = { key: null, source: '未找到（可设置环境变量 DEEPSEEK_API_KEY 或项目根目录 .env）', envVar: null };
  return cached;
}

/** 供日志展示的脱敏 Key */
export function maskKey(key) {
  if (!key) return '(none)';
  if (key.length <= 12) return `${key.slice(0, 3)}***`;
  return `${key.slice(0, 6)}…${key.slice(-4)} (len=${key.length})`;
}

export const config = {
  ROOT,
  HOST,
  PORT,
  WEB_DEV_PORT,
  DEEPSEEK_BASE_URL,
  DEEPSEEK_MODEL,
  DEEPSEEK_TIMEOUT_MS,
};
