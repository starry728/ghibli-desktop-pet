/**
 * AI 桌面宠物领养系统 —— 后端服务入口
 *
 * 单进程同时提供：
 *   /api/*     JSON API
 *   /pets/*    宠物图片（public/pets）
 *   /          前端静态站点（web/）
 *
 * 用法：node server/index.js     或     npm start
 */
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';

import { config, initEnv, resolveApiKey, maskKey, PORT, HOST, WEB_DIR, PUBLIC_DIR, GENERATED_DIR } from './config.js';
import { createRouter, serveStatic, sendJson, sendError, applyCors } from './lib/http.js';
import { routes } from './routes.js';
import { loadCatalog, getStats } from './catalog.js';
import { generateCopy, copyJobStatus } from './copywriter.js';
import { startDshWatcher, getDshWatcher } from './dsh-watcher.js';
import { overlayHub } from './overlay.js';

initEnv();

const match = createRouter(routes);

const AUTO_GENERATE = process.env.AUTO_GENERATE_COPY !== '0';

function log(...args) {
  console.log('[pet]', ...args);
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  applyCors(req, res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // 1) API
  if (pathname === '/api' || pathname.startsWith('/api/')) {
    const hit = match(req.method, pathname);
    if (!hit) return sendError(res, 404, `未知接口 ${req.method} ${pathname}`);
    const query = url.searchParams;
    try {
      await hit.route.handler(req, res, { params: hit.params, query, url });
    } catch (err) {
      console.error('[api] 处理失败:', err);
      if (!res.headersSent) {
        const status = err instanceof Error && err.name === 'DeepSeekError' ? 502 : 500;
        sendError(res, status, err.message || '服务器内部错误');
      }
    }
    return;
  }

  // 2) 宠物图片
  if (pathname.startsWith('/pets/')) {
    const served = await serveStatic(req, res, PUBLIC_DIR, pathname);
    if (served) return;
    return sendError(res, 404, '图片不存在');
  }

  // 2b) 语音：/voice/ 是用户放入的电影原声，/voice-cache/ 是 TTS 合成缓存
  if (pathname.startsWith('/voice/')) {
    const served = await serveStatic(req, res, PUBLIC_DIR, pathname);
    if (served) return;
    return sendError(res, 404, '语音文件不存在');
  }
  if (pathname.startsWith('/voice-cache/')) {
    const rel = pathname.slice('/voice-cache'.length) || '/';
    const served = await serveStatic(req, res, path.join(GENERATED_DIR, 'voice'), rel);
    if (served) return;
    return sendError(res, 404, '语音缓存不存在');
  }

  // 3) 前端静态站点
  const served = await serveStatic(req, res, WEB_DIR, pathname, { spa: true });
  if (served) return;

  sendError(res, 404, 'Not Found');
}

async function main() {
  log('启动中…');

  if (!fs.existsSync(path.join(WEB_DIR, 'index.html'))) {
    log(`!! 警告：前端入口不存在 ${path.join(WEB_DIR, 'index.html')}`);
  }

  await loadCatalog();
  const stats = await getStats();
  log(`已载入宠物目录：${stats.total} 只宠物 / ${stats.films} 部电影`);

  const { key, source } = resolveApiKey({ refresh: true });
  if (key) {
    log(`DeepSeek API Key：${maskKey(key)}  来源：${source}`);
    log(`模型：${config.DEEPSEEK_MODEL}  接口：${config.DEEPSEEK_BASE_URL}`);
  } else {
    log(`!! 未找到 DeepSeek API Key（${source}）`);
    log('   将使用内置文案模板。设置环境变量 DEEPSEEK_API_KEY 或在项目根目录创建 .env 后重启即可启用 AI 生成。');
  }
  log(`AI 文案进度：${stats.withCopy}/${stats.total}`);

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      console.error('[server] 未捕获错误:', err);
      if (!res.headersSent) sendError(res, 500, '服务器内部错误');
      else res.end();
    });
  });

  server.listen(PORT, HOST, () => {
    const url = `http://${HOST}:${PORT}`;
    log(`后端已就绪  ${url}`);
    log(`前端界面    ${url}/`);
    log(`健康检查    ${url}/api/health`);

    // ---- DeepSeek Harness 事件监听（任务完成 / 等待批准） ----
    if (process.env.DSH_WATCH !== '0') {
      const watcher = startDshWatcher({
        onTurnEnd: (ev) => {
          if (ev.reason !== 'completed') {
            log(`[dsh] 回合结束（${ev.reason}），不播报 · ${ev.sessionId}`);
            return;
          }
          log(`[dsh] 任务完成 → 让宠物念台词 · ${ev.sessionId}`);
          overlayHub.taskComplete({ title: 'DSH 任务完成' }).catch((err) => log(`[dsh] 播报失败: ${err.message}`));
        },
        onApprovalAsked: (ev) => {
          log(`[dsh] 等待批准（${ev.toolName}）→ 语音提醒 · ${ev.sessionId}`);
          overlayHub.speakApproval({ title: 'DSH 等待你的批准' }).catch((err) => log(`[dsh] 播报失败: ${err.message}`));
        },
      });
      log(`DSH 监听已启动  目录 ${watcher.sessionsDir}  间隔 ${watcher.pollMs}ms`);
      log(`   · DSH 完成任务      → 宠物念出该角色的经典台词`);
      log(`   · DSH 请求批准      → 播放「您有新的请求请批准~」`);
      log(`   · 设 DSH_WATCH=0 关闭监听；DSH_WATCH_SUBAGENTS=1 连子代理也播报`);
    } else {
      log('DSH 监听已关闭（DSH_WATCH=0）');
    }

    // 首次启动自动补齐缺失的 AI 文案（后台执行，不阻塞服务）
    if (AUTO_GENERATE && !copyJobStatus().running) {
      const missing = stats.total - stats.withCopy;
      if (missing > 0) {
        log(`检测到 ${missing} 只宠物缺少领养文案，开始后台生成…`);
        generateCopy({})
          .then((r) => log(`文案生成完成：成功 ${r.done}/${r.total}（来源：${r.source}）`))
          .catch((err) => log(`文案生成失败：${err.message}`));
      } else {
        log('所有宠物均已有领养文案，跳过生成。');
      }
    }
  });

  const shutdown = (sig) => {
    log(`收到 ${sig}，正在关闭…`);
    const w = getDshWatcher();
    if (w) w.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[pet] 启动失败:', err);
  process.exit(1);
});
