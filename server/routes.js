/**
 * API 路由定义。
 */
import { readJsonBody, sendJson, sendError } from './lib/http.js';
import {
  getCatalog,
  getPetView,
  getPetRaw,
  listPetViews,
  getStats,
  copyStore,
  adoptionStore,
} from './catalog.js';
import { generateCopy, copyJobStatus, stopCopyJob, fallbackCopy } from './copywriter.js';
import { ping, DeepSeekError } from './deepseek.js';
import { overlayHub, defaultCompanionPet } from './overlay.js';
import { getDshWatcher } from './dsh-watcher.js';
import { resolveLineAudio, resolveApprovalAudio, resolveSayAudio, listOriginalVoicePets, STYLE_PRESETS, APPROVAL_TEXT } from './voice.js';
import { resolveApiKey, maskKey, DEEPSEEK_MODEL, DEEPSEEK_BASE_URL, PORT, HOST } from './config.js';

function boolParam(v) {
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  return undefined;
}

/** 领养响应里附带的「经典日语台词」卡片 */
function lineCard(pet) {
  return {
    character: pet.name,
    characterJa: pet.nameJa,
    film: pet.film.zh,
    filmJa: pet.film.ja,
    ja: pet.lineJa || '',
    zh: pet.lineZh || '',
    scene: pet.lineScene || '',
    confidence: pet.lineConfidence || 'medium',
    lang: 'ja-JP',
  };
}

export const routes = [
  /* ---------------- 健康检查 / 元信息 ---------------- */
  {
    method: 'GET',
    pattern: '/api/health',
    async handler(req, res) {
      const { key, source, envVar } = resolveApiKey({ refresh: true });
      const stats = await getStats();
      sendJson(res, 200, {
        ok: true,
        service: 'desktop-pet-adoption',
        time: new Date().toISOString(),
        server: { host: HOST, port: PORT },
        deepseek: {
          hasApiKey: Boolean(key),
          keySource: source,
          envVar,
          maskedKey: maskKey(key),
          model: DEEPSEEK_MODEL,
          baseUrl: DEEPSEEK_BASE_URL,
        },
        catalog: stats,
        copyJob: copyJobStatus(),
      });
    },
  },
  {
    method: 'GET',
    pattern: '/api/deepseek/ping',
    async handler(req, res) {
      try {
        const result = await ping();
        sendJson(res, 200, { ok: true, ...result });
      } catch (err) {
        sendJson(res, 502, { ok: false, error: err.message, code: err.code ?? null });
      }
    },
  },

  /* ---------------- 电影 / 宠物 ---------------- */
  {
    method: 'GET',
    pattern: '/api/films',
    async handler(req, res) {
      const catalog = getCatalog();
      const stats = await getStats();
      sendJson(res, 200, { ok: true, films: catalog.films, stats });
    },
  },
  {
    method: 'GET',
    pattern: '/api/pets',
    async handler(req, res, { query }) {
      const pets = await listPetViews({
        film: query.get('film') || undefined,
        rarity: query.get('rarity') || undefined,
        adopted: boolParam(query.get('adopted')),
        q: query.get('q') || undefined,
        sort: query.get('sort') || undefined,
      });
      sendJson(res, 200, { ok: true, count: pets.length, pets, stats: await getStats() });
    },
  },
  {
    method: 'GET',
    pattern: '/api/pets/:id',
    async handler(req, res, { params }) {
      const pet = await getPetView(params.id);
      if (!pet) return sendError(res, 404, `没有找到宠物 ${params.id}`);
      sendJson(res, 200, { ok: true, pet });
    },
  },

  /* ---------------- 领养 ---------------- */
  {
    method: 'POST',
    pattern: '/api/pets/:id/adopt',
    async handler(req, res, { params }) {
      const pet = getPetRaw(params.id);
      if (!pet) return sendError(res, 404, `没有找到宠物 ${params.id}`);

      const body = await readJsonBody(req).catch(() => ({}));
      const adopter = String(body.adopter ?? '').trim().slice(0, 40) || '无名旅人';

      const existing = await adoptionStore.load();
      const prev = existing.adoptions?.[params.id];

      const record = {
        petId: pet.id,
        adopter,
        adoptedAt: new Date().toISOString(),
        timesAdopted: (prev?.timesAdopted ?? 0) + 1,
      };

      await adoptionStore.update((data) => {
        data.adoptions = data.adoptions || {};
        data.adoptions[pet.id] = record;
        return record;
      });

      // 首次领养时若还没有 AI 文案，补一份（不阻塞响应）
      const copy = await copyStore.load();
      if (!copy.items?.[pet.id]) {
        copy.items = copy.items || {};
        copy.items[pet.id] = {
          ...fallbackCopy(pet),
          model: null,
          generatedAt: new Date().toISOString(),
        };
        await copyStore.save();
      }

      // ⭐ 通知桌面悬浮层：换宠物 + 念出它的经典台词。
      // 这一步以前漏掉了 —— 结果在网页上领养新宠物后，桌面右下角那只不会跟着换。
      // 放在服务端而不是前端，是为了让「任何客户端领养」都能同步到桌面宠物。
      overlayHub.setPet(pet);
      let overlay = null;
      try {
        const entry = await overlayHub.speakLine(pet, { reason: 'adopt', force: true });
        if (entry) {
          overlay = {
            petId: pet.id,
            audioUrl: entry.command.audioUrl,
            voiceSource: entry.command.voiceSource,
            online: overlayHub.clientOnline(),
          };
        }
      } catch (err) {
        // 语音合成失败不该让领养失败
        overlay = { petId: pet.id, audioUrl: null, voiceSource: 'none', error: err.message, online: overlayHub.clientOnline() };
      }

      const view = await getPetView(pet.id);
      sendJson(res, 200, {
        ok: true,
        pet: view,
        adoption: record,
        firstTime: !prev,
        /** 任务完成 → 该角色的经典日语台词 */
        line: lineCard(pet),
        /** 桌面悬浮层收到的指令（前端可据此提示） */
        overlay,
      });
    },
  },
  {
    method: 'DELETE',
    pattern: '/api/pets/:id/adopt',
    async handler(req, res, { params }) {
      const pet = getPetRaw(params.id);
      if (!pet) return sendError(res, 404, `没有找到宠物 ${params.id}`);
      const existing = await adoptionStore.load();
      if (!existing.adoptions?.[params.id]) return sendError(res, 409, '这只宠物还没有被领养');
      await adoptionStore.update((data) => {
        delete data.adoptions[params.id];
      });

      // 如果送回的就是桌面上的那只，换一只继续陪着
      let nextCompanion = null;
      if (overlayHub.companionId === params.id) {
        const fallback = await defaultCompanionPet();
        if (fallback && fallback.id !== params.id) {
          overlayHub.setPet(fallback);
          nextCompanion = fallback.id;
        }
      }

      sendJson(res, 200, {
        ok: true,
        pet: await getPetView(params.id),
        nextCompanion,
      });
    },
  },
  {
    method: 'GET',
    pattern: '/api/adoptions',
    async handler(req, res) {
      const data = await adoptionStore.load();
      const ids = Object.keys(data.adoptions || {});
      const pets = [];
      for (const id of ids) {
        const v = await getPetView(id);
        if (v) pets.push(v);
      }
      pets.sort((a, b) => new Date(b.adoption.adoptedAt) - new Date(a.adoption.adoptedAt));
      sendJson(res, 200, { ok: true, count: pets.length, pets });
    },
  },

  /* ---------------- AI 文案生成 ---------------- */
  {
    method: 'GET',
    pattern: '/api/copy/status',
    async handler(req, res) {
      sendJson(res, 200, { ok: true, job: copyJobStatus(), stats: await getStats() });
    },
  },
  {
    method: 'POST',
    pattern: '/api/copy/generate',
    async handler(req, res) {
      const body = await readJsonBody(req).catch(() => ({}));
      if (copyJobStatus().running) return sendError(res, 409, '已有生成任务在进行中');

      const petIds = Array.isArray(body.petIds) ? body.petIds.map(String) : undefined;
      const force = Boolean(body.force);

      // 后台跑，立刻返回
      generateCopy({ petIds, force }).catch((err) => {
        console.error('[copy] 生成任务失败:', err);
      });

      sendJson(res, 202, { ok: true, message: '已开始生成，请轮询 /api/copy/status', job: copyJobStatus() });
    },
  },
  {
    method: 'POST',
    pattern: '/api/copy/stop',
    async handler(req, res) {
      const stopped = stopCopyJob();
      sendJson(res, 200, { ok: true, stopped, job: copyJobStatus() });
    },
  },
  {
    method: 'POST',
    pattern: '/api/copy/regenerate/:id',
    async handler(req, res, { params }) {
      const pet = getPetRaw(params.id);
      if (!pet) return sendError(res, 404, `没有找到宠物 ${params.id}`);
      if (copyJobStatus().running) return sendError(res, 409, '已有生成任务在进行中');
      generateCopy({ petIds: [pet.id], force: true }).catch((err) => console.error('[copy] 单只重生成失败:', err));
      sendJson(res, 202, { ok: true, message: `正在为 ${pet.name} 重新生成文案` });
    },
  },

  /* ---------------- 桌面悬浮层 ---------------- */
  {
    method: 'GET',
    pattern: '/api/overlay/poll',
    async handler(req, res, { query }) {
      const since = query.get('since');
      const petId = query.get('pet');
      overlayHub.touchClient({
        since,
        pet: petId || '',
        remote: req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : '',
      });
      const { commands, cursor, oldest } = overlayHub.since(since);
      // 悬浮层首次连接（since 缺省或为 0）时，先把当前陪伴宠物推给它。
      // 注意：这里必须同时记住 companionId，否则 seq 一直是 0，
      // 客户端每次轮询都会被判定为「首次连接」，pet 指令会被无限重复下发。
      if ((!since || since === '0') && !overlayHub.companionId) {
        const pet = petId ? getPetRaw(petId) : await defaultCompanionPet();
        if (pet) {
          overlayHub.companionId = pet.id;
          commands.unshift({ type: 'pet', petId: pet.id, imageUrl: pet.image, name: pet.name, nameJa: pet.nameJa });
        }
      }
      sendJson(res, 200, { ok: true, cursor, oldest, commands, serverTime: Date.now() });
    },
  },
  {
    method: 'GET',
    pattern: '/api/overlay/state',
    async handler(req, res) {
      sendJson(res, 200, { ok: true, ...overlayHub.state(), approvalText: APPROVAL_TEXT, presets: STYLE_PRESETS });
    },
  },
  {
    method: 'POST',
    pattern: '/api/overlay/companion',
    async handler(req, res) {
      const body = await readJsonBody(req).catch(() => ({}));
      const pet = body.petId ? getPetRaw(String(body.petId)) : await defaultCompanionPet();
      if (!pet) return sendError(res, 404, '找不到这只宠物');
      overlayHub.setPet(pet);
      sendJson(res, 200, { ok: true, companion: pet.id, name: pet.name });
    },
  },
  {
    method: 'POST',
    pattern: '/api/overlay/say',
    async handler(req, res, { query }) {
      const petId = query.get('pet') || overlayHub.companionId;
      const pet = petId ? getPetRaw(petId) : await defaultCompanionPet();
      if (!pet) return sendError(res, 404, '没有可用的宠物');
      const entry = await overlayHub.speakLine(pet, { reason: 'manual', force: true });
      sendJson(res, 200, { ok: Boolean(entry), pet: pet.name, audio: entry ? entry.command.audioUrl : null, source: entry ? entry.command.voiceSource : null });
    },
  },
  {
    method: 'POST',
    pattern: '/api/overlay/test/:kind',
    async handler(req, res, { params }) {
      const kind = params.kind;
      if (kind === 'approval') {
        const entry = await overlayHub.speakApproval({ force: true, title: '测试：批准提醒' });
        return sendJson(res, 200, { ok: true, kind, audio: entry.command.audioUrl, text: entry.command.zh });
      }
      if (kind === 'complete') {
        const entry = await overlayHub.taskComplete({ force: true, title: '测试：任务完成' });
        return sendJson(res, 200, { ok: Boolean(entry), kind, audio: entry ? entry.command.audioUrl : null });
      }
      if (kind === 'line') {
        const pet = overlayHub.companionId ? getPetRaw(overlayHub.companionId) : await defaultCompanionPet();
        const entry = await overlayHub.speakLine(pet, { reason: 'test', force: true });
        return sendJson(res, 200, { ok: true, kind, audio: entry.command.audioUrl, line: entry.command.ja });
      }
      return sendError(res, 400, `未知的测试类型 ${kind}（可用：line / approval / complete）`);
    },
  },
  {
    method: 'POST',
    pattern: '/api/overlay/quit',
    async handler(req, res) {
      overlayHub.push({ type: 'quit' });
      sendJson(res, 200, { ok: true });
    },
  },

  /* ---------------- 语音（原声 / TTS） ---------------- */
  {
    method: 'GET',
    pattern: '/api/voice/presets',
    async handler(req, res) {
      const originals = listOriginalVoicePets();
      sendJson(res, 200, {
        ok: true,
        presets: STYLE_PRESETS,
        approvalText: APPROVAL_TEXT,
        originalVoice: {
          count: Object.keys(originals).length,
          dir: 'public/voice/',
          namingHint: '把电影原声剪好，命名为 <宠物id>.mp3 放进 public/voice/ 即可自动优先使用原声',
          pets: originals,
        },
      });
    },
  },
  {
    method: 'GET',
    pattern: '/api/voice/sample',
    async handler(req, res, { query }) {
      const preset = query.get('preset') || 'susu';
      const text = query.get('text') || APPROVAL_TEXT;
      const isJa = query.get('lang') === 'ja';
      try {
        const r = isJa
          ? await resolveLineAudio({ id: '__sample__', lineJa: text }, { forceSource: 'tts' })
          : await resolveSayAudio(text, { preset });
        sendJson(res, 200, { ok: true, preset, text, url: r.url, cached: r.cached, source: r.source });
      } catch (err) {
        sendError(res, 502, err.message);
      }
    },
  },
  {
    method: 'GET',
    pattern: '/api/voice/line/:id',
    async handler(req, res, { params, query }) {
      const pet = getPetRaw(params.id);
      if (!pet) return sendError(res, 404, `没有找到宠物 ${params.id}`);
      if (!pet.lineJa) return sendError(res, 409, `${pet.name} 在片中可确证的台词为空`);
      try {
        const r = await resolveLineAudio(pet, { forceSource: query.get('source') || undefined });
        if (!r.url) return sendError(res, 409, r.reason || '无法准备音频');
        sendJson(res, 200, { ok: true, pet: pet.name, line: pet.lineJa, url: r.url, source: r.source, cached: r.cached, bytes: r.bytes });
      } catch (err) {
        sendError(res, 502, err.message);
      }
    },
  },

  /* ---------------- DeepSeek Harness 集成 ---------------- */
  {
    method: 'GET',
    pattern: '/api/dsh/status',
    async handler(req, res) {
      const w = getDshWatcher();
      sendJson(res, 200, {
        ok: true,
        watching: Boolean(w && w.running),
        watcher: w ? w.status() : null,
        overlay: overlayHub.state(),
        hint: 'DSH 完成任务 → 宠物念台词；DSH 请求批准 → 播放「您有新的请求请批准~」',
      });
    },
  },
  {
    method: 'GET',
    pattern: '/api/dsh/pending',
    async handler(req, res) {
      const w = getDshWatcher();
      sendJson(res, 200, { ok: true, pending: w ? w.pendingApprovals() : [] });
    },
  },
  {
    method: 'POST',
    pattern: '/api/dsh/simulate/:kind',
    async handler(req, res, { params }) {
      const kind = params.kind;
      if (kind === 'task-complete') {
        const entry = await overlayHub.taskComplete({ force: true, title: '模拟：DSH 任务完成' });
        return sendJson(res, 200, { ok: Boolean(entry), kind, command: entry ? entry.command : null });
      }
      if (kind === 'approval') {
        const entry = await overlayHub.speakApproval({ force: true, title: '模拟：DSH 等待批准' });
        return sendJson(res, 200, { ok: true, kind, command: entry.command });
      }
      return sendError(res, 400, `未知类型 ${kind}（可用：task-complete / approval）`);
    },
  },

  /* ---------------- 兜底 ---------------- */
  {
    method: 'GET',
    pattern: '/api',
    async handler(req, res) {
      sendJson(res, 200, {
        ok: true,
        name: 'AI 桌面宠物领养系统 API',
        endpoints: routes.filter((r) => r.pattern.startsWith('/api')).map((r) => `${r.method} ${r.pattern}`),
      });
    },
  },
];

export { DeepSeekError };
