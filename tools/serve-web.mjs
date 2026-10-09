/**
 * 前端独立开发服务器（零依赖）
 *
 * 只负责托管 web/ 目录，并把 /api/* 与 /pets/* 反向代理到后端（默认 127.0.0.1:8787）。
 * 这样「前端」和「后端」可以作为两个独立进程分别启动。
 *
 * 用法：node tools/serve-web.mjs [--port 5173] [--api http://127.0.0.1:8787]
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const WEB_DIR = path.join(ROOT, 'web');
const PUBLIC_DIR = path.join(ROOT, 'public');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const PORT = Number(arg('port', process.env.WEB_DEV_PORT || 5173));
const HOST = arg('host', process.env.WEB_HOST || '127.0.0.1');
const API = String(arg('api', process.env.API_ORIGIN || 'http://127.0.0.1:8787')).replace(/\/+$/, '');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const mimeFor = (f) => MIME[path.extname(f).toLowerCase()] || 'application/octet-stream';

/** 把请求转发到后端 */
function proxy(req, res, targetPath) {
  const url = new URL(API);
  const upstream = http.request(
    {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || 80,
      method: req.method,
      path: targetPath,
      headers: { ...req.headers, host: url.host },
    },
    (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
    }
  );
  upstream.on('error', (err) => {
    res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(
      JSON.stringify({
        ok: false,
        error: `无法连接后端 ${API}：${err.message}`,
        hint: '请先在另一个终端运行 npm run dev:api（或 npm start）',
      })
    );
  });
  req.pipe(upstream);
}

async function serveFile(res, file) {
  const stat = await fsp.stat(file);
  res.writeHead(200, {
    'Content-Type': mimeFor(file),
    'Content-Length': stat.size,
    'Cache-Control': file.endsWith('.html') ? 'no-cache' : 'public, max-age=600',
  });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, `http://${req.headers.host}`).pathname;

  if (pathname.startsWith('/api/') || pathname === '/api') return proxy(req, res, req.url);
  if (pathname.startsWith('/pets/')) {
    const file = path.resolve(PUBLIC_DIR, '.' + path.posix.normalize(pathname));
    if (file.startsWith(PUBLIC_DIR) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      return serveFile(res, file);
    }
    res.writeHead(404).end('not found');
    return;
  }

  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.resolve(WEB_DIR, '.' + path.posix.normalize(rel));

  if (file.startsWith(WEB_DIR) && fs.existsSync(file) && fs.statSync(file).isFile()) {
    return serveFile(res, file);
  }
  return serveFile(res, path.join(WEB_DIR, 'index.html'));
});

server.listen(PORT, HOST, () => {
  console.log(`[web] 前端开发服务器已就绪  http://${HOST}:${PORT}`);
  console.log(`[web] 静态目录  ${WEB_DIR}`);
  console.log(`[web] /api 与 /pets 代理到  ${API}`);
});
