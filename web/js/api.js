/**
 * 后端 API 封装。
 * 开发模式下（前端独立跑在 5173）会自动指向 8787 的后端。
 */

const API_BASE = (() => {
  // 同源部署（后端同时托管前端）时直接用相对路径
  if (location.port === '8787' || location.port === '') return '';
  // 允许通过 ?api= 覆盖
  const q = new URLSearchParams(location.search).get('api');
  if (q) return q.replace(/\/+$/, '');
  // 前端独立开发服务器：默认代理到后端
  if (location.port === '5173' || location.port === '5174') return '';
  return '';
})();

async function request(path, { method = 'GET', body, signal } = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* 非 JSON */
  }

  if (!res.ok) {
    const err = new Error(data?.error || text.slice(0, 200) || `HTTP ${res.status}`);
    err.status = res.status;
    err.payload = data;
    throw err;
  }
  return data;
}

export const api = {
  health: () => request('/api/health'),
  pingDeepSeek: () => request('/api/deepseek/ping'),
  films: () => request('/api/films'),
  pets: (params = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === '' || v === false) continue;
      qs.set(k, String(v));
    }
    const s = qs.toString();
    return request(`/api/pets${s ? `?${s}` : ''}`);
  },
  pet: (id) => request(`/api/pets/${encodeURIComponent(id)}`),
  adopt: (id, adopter) => request(`/api/pets/${encodeURIComponent(id)}/adopt`, { method: 'POST', body: { adopter } }),
  release: (id) => request(`/api/pets/${encodeURIComponent(id)}/adopt`, { method: 'DELETE' }),
  adoptions: () => request('/api/adoptions'),
  copyStatus: () => request('/api/copy/status'),
  generateCopy: (opts = {}) => request('/api/copy/generate', { method: 'POST', body: opts }),
  stopCopy: () => request('/api/copy/stop', { method: 'POST' }),
  regenerate: (id) => request(`/api/copy/regenerate/${encodeURIComponent(id)}`, { method: 'POST' }),

  /* ---- 桌面悬浮层 ---- */
  overlayState: () => request('/api/overlay/state'),
  overlaySay: (petId) => request(`/api/overlay/say${petId ? `?pet=${encodeURIComponent(petId)}` : ''}`, { method: 'POST' }),
  setCompanion: (petId) => request('/api/overlay/companion', { method: 'POST', body: { petId } }),
  overlayTest: (kind) => request(`/api/overlay/test/${encodeURIComponent(kind)}`, { method: 'POST' }),

  /* ---- DSH 联动 ---- */
  dshStatus: () => request('/api/dsh/status'),
  dshPending: () => request('/api/dsh/pending'),

  /* ---- 语音 ---- */
  voicePresets: () => request('/api/voice/presets'),
  voiceLine: (id, source) =>
    request(`/api/voice/line/${encodeURIComponent(id)}${source ? `?source=${source}` : ''}`),
};

export { API_BASE };
