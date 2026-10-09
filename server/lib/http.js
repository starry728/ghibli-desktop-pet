/**
 * 零依赖微型 HTTP 工具：路由、JSON 收发、静态文件服务。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/opus',
  '.flac': 'audio/flac',
  '.mp4': 'video/mp4',
};

export function mimeFor(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

export function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

export function sendError(res, status, message, extra = {}) {
  sendJson(res, status, { ok: false, error: message, ...extra });
}

export async function readJsonBody(req, { limit = 1024 * 1024 } = {}) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('请求体不是合法 JSON');
  }
}

/** CORS（供前端独立开发服务器 5173 调用 8787 时使用） */
export function applyCors(req, res, { origin = '*' } = {}) {
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
}

/** 静态文件服务，带路径穿越防护 */
export async function serveStatic(req, res, rootDir, urlPath, { spa = false } = {}) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';

  const target = path.resolve(rootDir, '.' + path.posix.normalize(rel));
  const rootResolved = path.resolve(rootDir);
  if (target !== rootResolved && !target.startsWith(rootResolved + path.sep)) {
    sendError(res, 403, 'forbidden');
    return true;
  }

  let stat = null;
  try {
    stat = await fsp.stat(target);
  } catch {
    stat = null;
  }

  if (stat && stat.isDirectory()) {
    const idx = path.join(target, 'index.html');
    try {
      stat = await fsp.stat(idx);
      return await streamFile(req, res, idx, stat);
    } catch {
      /* fallthrough */
    }
  }

  if (stat && stat.isFile()) return await streamFile(req, res, target, stat);

  if (spa) {
    const idx = path.join(rootResolved, 'index.html');
    try {
      const st = await fsp.stat(idx);
      return await streamFile(req, res, idx, st);
    } catch {
      /* fallthrough */
    }
  }
  return false;
}

async function streamFile(req, res, file, stat) {
  const etag = `W/"${stat.size}-${Number(stat.mtimeMs).toString(36)}"`;
  const isMedia = /\.(mp3|wav|m4a|ogg|opus|flac|aac)$/i.test(file);

  // 音视频：支持 Range 请求，保证 MediaPlayer 等播放器能稳定取流与拖动
  const range = req.headers.range;
  if (isMedia && range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m) {
      let start = m[1] === '' ? null : Number(m[1]);
      let end = m[2] === '' ? null : Number(m[2]);
      if (start === null && end !== null) {
        start = Math.max(0, stat.size - end);
        end = stat.size - 1;
      } else {
        if (start === null) start = 0;
        if (end === null || end >= stat.size) end = stat.size - 1;
      }
      if (start > end || start >= stat.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
        res.end();
        return true;
      }
      res.writeHead(206, {
        'Content-Type': mimeFor(file),
        'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=3600',
      });
      if (req.method === 'HEAD') { res.end(); return true; }
      await new Promise((resolve, reject) => {
        const stream = fs.createReadStream(file, { start, end });
        stream.on('error', reject);
        stream.on('end', resolve);
        stream.pipe(res);
      });
      return true;
    }
  }

  const headers = {
    'Content-Type': mimeFor(file),
    'Cache-Control': file.endsWith('.html') ? 'no-cache' : 'public, max-age=3600',
    ETag: etag,
    'Last-Modified': stat.mtime.toUTCString(),
  };
  if (isMedia) headers['Accept-Ranges'] = 'bytes';
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    res.end();
    return true;
  }
  res.writeHead(200, { ...headers, 'Content-Length': stat.size });
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('end', resolve);
    stream.pipe(res);
  });
  return true;
}

/**
 * 简单路由表。
 * routes: [{ method, pattern:'/api/pets/:id', handler(req,res,ctx) }]
 */
export function createRouter(routes) {
  const compiled = routes.map((r) => {
    const names = [];
    const source = r.pattern
      .split('/')
      .map((seg) => {
        if (seg.startsWith(':')) {
          names.push(seg.slice(1));
          return '([^/]+)';
        }
        return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('/');
    return { ...r, re: new RegExp(`^${source}/?$`), names };
  });

  return function match(method, pathname) {
    for (const route of compiled) {
      if (route.method !== method) continue;
      const m = route.re.exec(pathname);
      if (!m) continue;
      const params = {};
      route.names.forEach((n, i) => {
        params[n] = decodeURIComponent(m[i + 1]);
      });
      return { route, params };
    }
    return null;
  };
}
