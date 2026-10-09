/**
 * 从常见凭据文件中提取 API Key（零依赖，针对 YAML / JSON / INI 的宽松扫描）
 *
 * 主要目标：DeepSeek Harness 的凭据库 ~/.dsh/.credentials.yaml，其结构为
 *   version: 1
 *   records:
 *     <id>:
 *       kind: grant
 *       payload:
 *         version: 1
 *         secret: <内部密钥>
 *       refs:
 *         DEEPSEEK_API_KEY: <你的密钥>
 *
 * 同时也兼容 .deepseek/config.json、环境变量式文件等。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const KEY_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SECRETISH_RE = /^(?:sk-|sk_|api-|key-)[A-Za-z0-9_\-]{12,}$/;

/** 该值是否像一把 API Key */
function looksLikeKey(value) {
  const v = String(value).trim().replace(/^["']|["']$/g, '');
  if (v.length < 16 || v.length > 200) return false;
  if (/\s/.test(v)) return false;
  return SECRETISH_RE.test(v) || /^[A-Za-z0-9_\-]{32,}$/.test(v);
}

/**
 * 扫描文本，返回 { KEY_NAME: value }
 * 识别形如 `NAME: value` 或 `NAME=value` 或 `"NAME": "value"` 的行。
 */
export function scanCredentialText(text) {
  const found = {};
  const lines = String(text).split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^["']?([A-Za-z_][A-Za-z0-9_]*)["']?\s*[:=]\s*(.+)$/.exec(line);
    if (!m) continue;
    const name = m[1];
    let value = m[2].trim().replace(/,$/, '').trim();
    value = value.replace(/^["']|["']$/g, '');
    // YAML 行内注释
    value = value.replace(/\s+#.*$/, '').trim();
    if (!KEY_NAME_RE.test(name)) continue;
    if (!looksLikeKey(value)) continue;
    if (found[name] === undefined) found[name] = value;
  }
  return found;
}

/** 候选凭据文件（存在才读） */
export function credentialCandidates() {
  const home = os.homedir();
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  return [
    path.join(home, '.dsh', '.credentials.yaml'),
    path.join(home, '.dsh', '.credentials.yml'),
    path.join(home, '.deepseek', 'config.json'),
    path.join(home, '.deepseek', 'credentials.json'),
    path.join(home, '.config', 'deepseek', 'config.json'),
    path.join(appData, 'deepseek', 'config.json'),
    path.join(appData, 'DeepSeek', 'config.json'),
    path.join(localAppData, 'deepseek', 'credentials.json'),
    path.join(home, '.deepseek_key'),
    path.join(home, '.dsh', 'api-key'),
  ];
}

/**
 * 在候选凭据文件中查找 DeepSeek API Key。
 * @returns {{key:string, source:string}|null}
 */
export function findKeyInCredentialFiles() {
  for (const file of credentialCandidates()) {
    let text;
    try {
      if (!fs.existsSync(file)) continue;
      const st = fs.statSync(file);
      if (!st.isFile() || st.size > 512 * 1024) continue;
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const map = scanCredentialText(text);

    // 1) 明确以 DEEPSEEK 命名
    for (const [name, value] of Object.entries(map)) {
      if (/DEEPSEEK/i.test(name) && /KEY|TOKEN|SECRET/i.test(name)) {
        return { key: value, source: `${file} → ${name}` };
      }
    }
    // 2) 任意 *API_KEY
    for (const [name, value] of Object.entries(map)) {
      if (/API_?KEY$/i.test(name)) return { key: value, source: `${file} → ${name}` };
    }
    // 3) 裸 sk-... 值
    const bare = text.match(/(sk-[A-Za-z0-9]{16,})/);
    if (bare) return { key: bare[1], source: `${file} → 裸 sk- 值` };
  }
  return null;
}
