/**
 * DeepSeek 官方 API 客户端（零依赖，基于 fetch）。
 * 文档：https://api-docs.deepseek.com/
 */
import { DEEPSEEK_BASE_URL, DEEPSEEK_MODEL, DEEPSEEK_TIMEOUT_MS, resolveApiKey } from './config.js';

export class DeepSeekError extends Error {
  constructor(message, { status, code, body } = {}) {
    super(message);
    this.name = 'DeepSeekError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 调用 /chat/completions。
 * @param {object} opts
 * @param {Array<{role:string,content:string}>} opts.messages
 * @param {boolean} [opts.json] 是否要求返回 JSON 对象
 * @param {number}  [opts.temperature]
 * @param {number}  [opts.maxTokens]
 * @param {string}  [opts.model]
 * @param {number}  [opts.attempts]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{text:string, usage:object|null, model:string, raw:object}>}
 */
export async function chat(opts) {
  const {
    messages,
    json = false,
    temperature = 1.0,
    maxTokens = 2048,
    model = DEEPSEEK_MODEL,
    attempts = 3,
    signal,
  } = opts;

  const { key, source } = resolveApiKey();
  if (!key) {
    throw new DeepSeekError(`未找到 DeepSeek API Key（${source}）`, { code: 'NO_API_KEY' });
  }

  const body = {
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
    stream: false,
  };
  if (json) body.response_format = { type: 'json_object' };

  let lastErr;
  for (let i = 0; i < attempts; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEEPSEEK_TIMEOUT_MS);
    const onAbort = () => controller.abort();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    try {
      const res = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const text = await res.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        /* 非 JSON 响应 */
      }

      if (!res.ok) {
        const msg = data?.error?.message || text.slice(0, 300) || `HTTP ${res.status}`;
        const err = new DeepSeekError(`DeepSeek API 错误 (${res.status}): ${msg}`, {
          status: res.status,
          code: data?.error?.code,
          body: data,
        });
        // 4xx（除 429）不重试
        if (res.status !== 429 && res.status < 500) throw err;
        lastErr = err;
        await sleep(1200 * (i + 1));
        continue;
      }

      const choice = data?.choices?.[0];
      const content = choice?.message?.content ?? '';
      if (!content) {
        lastErr = new DeepSeekError('DeepSeek 返回了空内容', { body: data });
        await sleep(800 * (i + 1));
        continue;
      }

      return { text: content, usage: data?.usage ?? null, model: data?.model || model, raw: data };
    } catch (err) {
      if (err instanceof DeepSeekError && err.status && err.status !== 429 && err.status < 500) throw err;
      lastErr = err;
      if (i < attempts - 1) await sleep(1200 * (i + 1));
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }
  throw lastErr ?? new DeepSeekError('DeepSeek 调用失败');
}

/** 调用并解析 JSON 结果（自动剥离 ```json 围栏） */
export async function chatJson(opts) {
  const res = await chat({ ...opts, json: true });
  return { ...res, data: parseJsonLoose(res.text) };
}

export function parseJsonLoose(text) {
  let t = String(text).trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t);
  if (fence) t = fence[1].trim();
  try {
    return JSON.parse(t);
  } catch {
    /* 尝试截取第一个 { 到最后一个 } */
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(t.slice(start, end + 1));
      } catch {
        /* ignore */
      }
    }
    const as = t.indexOf('[');
    const ae = t.lastIndexOf(']');
    if (as >= 0 && ae > as) {
      try {
        return JSON.parse(t.slice(as, ae + 1));
      } catch {
        /* ignore */
      }
    }
    throw new DeepSeekError('无法解析模型返回的 JSON');
  }
}

/** 轻量连通性自检 */
export async function ping() {
  const started = Date.now();
  const res = await chat({
    messages: [{ role: 'user', content: '回复两个字：在线' }],
    maxTokens: 16,
    temperature: 0,
    attempts: 1,
  });
  return { ok: true, model: res.model, latencyMs: Date.now() - started, sample: res.text.trim() };
}
