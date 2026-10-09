/**
 * AI 领养文案生成器
 *
 * 调用 DeepSeek 为每只宠物生成：一句话标语 / 领养文案 / 性格标签 / 饲养须知。
 * - 结果按宠物 id 缓存到 server/data/generated/copy.json，已生成的不重复调用；
 * - 批量请求（每批若干只宠物）以降低调用次数；
 * - 未配置 API Key 或调用失败时，回退到内置模板生成器，保证界面永远有内容。
 */
import { chatJson, DeepSeekError } from './deepseek.js';
import { copyStore, getCatalog, getPetRaw } from './catalog.js';
import { resolveApiKey, DEEPSEEK_MODEL } from './config.js';

const BATCH_SIZE = 5;

/** 生成任务状态（供 /api/copy/status 查询） */
export const copyJob = {
  running: false,
  total: 0,
  done: 0,
  failed: 0,
  currentBatch: '',
  startedAt: null,
  finishedAt: null,
  lastError: null,
  model: null,
  source: null,
  /** @type {AbortController|null} */
  controller: null,
};

const SYSTEM_PROMPT = `你是一家名为「吉卜力移动城堡收容所」的桌面宠物领养中心的金牌领养顾问。
你的工作是为每一只等待领养的动画角色宠物撰写中文领养文案。你的文字温暖、细腻、有画面感，像宫崎骏电影的分镜一样带着风和光。

写作要求：
1. 严格依据给出的角色信息（姓名、出处电影、角色定位、经典台词）来写，不要编造该角色没有的设定。
2. 语气是"介绍一位等待领养的小伙伴"，可以俏皮，但不要油腻、不要网络烂梗、不要 emoji。
3. 文案要让人产生"我想带它回家"的冲动，突出这只宠物会怎样陪伴主人。
4. 全部使用简体中文。
5. 必须只输出一个 JSON 对象，不要输出任何解释文字。`;

function buildUserPrompt(batch) {
  const list = batch.map((pet) => ({
    id: pet.id,
    名字: pet.name,
    日文名: pet.nameJa,
    英文名: pet.nameEn,
    出处电影: `${pet.film.zh}（${pet.film.ja} / ${pet.film.en}，${pet.film.year}）`,
    角色定位: pet.role === 'Main' ? '主角' : '重要配角',
    稀有度: pet.rarity,
    属性: pet.element,
    经典台词: pet.lineJa ? `${pet.lineJa}（${pet.lineZh}）` : '无',
    已有标签: pet.personality || [],
  }));

  return `请为下面 ${list.length} 只宠物分别生成领养文案。

宠物数据（JSON）：
${JSON.stringify({ pets: list }, null, 2)}

请输出如下结构的 JSON（pets 数组长度必须等于 ${list.length}，id 必须与输入一一对应）：
{
  "pets": [
    {
      "id": "原样返回输入的 id",
      "tagline": "一句话标语，8-18个汉字，朗朗上口",
      "text": "领养文案正文，90-140个汉字，一段话，不要换行符",
      "tags": ["3到5个性格标签，每个2-4个汉字"],
      "care": "一句饲养须知，20-40个汉字，贴合角色特点，带点幽默"
    }
  ]
}`;
}

/** 请求模型生成一批 */
async function generateBatch(batch, { signal } = {}) {
  const res = await chatJson({
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserPrompt(batch) },
    ],
    temperature: 1.15,
    maxTokens: 3000,
    model: DEEPSEEK_MODEL,
    signal,
  });

  const arr = Array.isArray(res.data?.pets) ? res.data.pets : Array.isArray(res.data) ? res.data : [];
  const byId = new Map();
  for (const item of arr) {
    if (item && typeof item.id === 'string') byId.set(item.id, item);
  }
  return { byId, usage: res.usage, model: res.model };
}

/** 未配置 Key / 调用失败时的兜底文案 */
export function fallbackCopy(pet) {
  const elementWord = { 森: '森林', 海: '大海', 风: '风', 火: '炉火', 天空: '天空', 光: '光', 影: '影子', 梦: '梦境' }[pet.element] || '世界';
  return {
    tagline: `${pet.film.zh}来的小客人`,
    text:
      `${pet.name}来自《${pet.film.zh}》。它沿着${elementWord}走了很远的路，最后停在了你的桌角。` +
      `它不太会说话，但会在你写代码、写作业、发呆的时候安安静静待在旁边——` +
      `你抬头的时候能看见它，它就觉得很值得。请温柔一点对待它，它会记得你很久很久。`,
    tags: pet.personality?.length ? pet.personality.slice(0, 4) : ['温柔', '安静', '陪伴'],
    care: '建议每天投喂一次注意力，并保证屏幕右下角有充足的光线。',
    source: 'fallback',
  };
}

function normalizeCopy(pet, raw) {
  const fb = fallbackCopy(pet);
  const tags = Array.isArray(raw?.tags)
    ? raw.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 6)
    : fb.tags;
  return {
    tagline: String(raw?.tagline || fb.tagline).trim().slice(0, 40),
    text: String(raw?.text || fb.text).trim().replace(/\s*\n+\s*/g, ' ').slice(0, 400),
    tags: tags.length ? tags : fb.tags,
    care: String(raw?.care || fb.care).trim().slice(0, 120),
  };
}

/**
 * 为指定宠物生成文案。
 * @param {object} opts
 * @param {string[]} [opts.petIds] 缺省为全部宠物
 * @param {boolean}  [opts.force]  已生成的是否重新生成
 * @param {boolean}  [opts.fallback] 无 Key 时是否写入兜底文案（默认 true）
 * @param {(ev:object)=>void} [opts.onProgress]
 */
export async function generateCopy({ petIds, force = false, fallback = true, onProgress } = {}) {
  if (copyJob.running) throw new Error('已有生成任务在进行中');

  const catalog = getCatalog();
  const all = catalog.pets;
  let targets = petIds?.length ? all.filter((p) => petIds.includes(p.id)) : all;

  const copy = await copyStore.load();
  copy.items = copy.items || {};
  if (!force) targets = targets.filter((p) => !copy.items[p.id]);

  const { key, source } = resolveApiKey();
  const hasKey = Boolean(key);

  copyJob.running = true;
  copyJob.total = targets.length;
  copyJob.done = 0;
  copyJob.failed = 0;
  copyJob.currentBatch = '';
  copyJob.startedAt = new Date().toISOString();
  copyJob.finishedAt = null;
  copyJob.lastError = null;
  copyJob.model = hasKey ? DEEPSEEK_MODEL : null;
  copyJob.source = hasKey ? 'deepseek' : 'fallback';
  copyJob.controller = new AbortController();

  const emit = (ev) => {
    try {
      onProgress?.(ev);
    } catch {
      /* ignore */
    }
  };

  emit({ type: 'start', total: targets.length, source: copyJob.source, keySource: source });

  try {
    if (!targets.length) {
      emit({ type: 'done', total: 0, done: 0, failed: 0 });
      return { total: 0, done: 0, failed: 0, source: 'cache' };
    }

    if (!hasKey) {
      // 无 Key：直接写兜底文案
      const now = new Date().toISOString();
      for (const pet of targets) {
        copy.items[pet.id] = { ...fallbackCopy(pet), model: null, generatedAt: now };
        copyJob.done++;
        emit({ type: 'pet', id: pet.id, name: pet.name, done: copyJob.done, total: copyJob.total });
      }
      copy.generatedAt = now;
      copy.model = null;
      copy.source = 'fallback';
      await copyStore.save();
      copyJob.finishedAt = new Date().toISOString();
      emit({ type: 'done', total: copyJob.total, done: copyJob.done, failed: 0, source: 'fallback' });
      return { total: copyJob.total, done: copyJob.done, failed: 0, source: 'fallback' };
    }

    for (let i = 0; i < targets.length; i += BATCH_SIZE) {
      if (copyJob.controller.signal.aborted) break;
      const batch = targets.slice(i, i + BATCH_SIZE);
      copyJob.currentBatch = batch.map((p) => p.name).join('、');
      emit({ type: 'batch', ids: batch.map((p) => p.id), names: batch.map((p) => p.name), done: copyJob.done, total: copyJob.total });

      const now = new Date().toISOString();
      let batchModel = null;
      try {
        const { byId, model } = await generateBatch(batch, { signal: copyJob.controller.signal });
        batchModel = model;
        for (const pet of batch) {
          const raw = byId.get(pet.id);
          const normalized = normalizeCopy(pet, raw);
          copy.items[pet.id] = { ...normalized, source: 'ai', model, generatedAt: now };
          copyJob.done++;
          if (!raw) copyJob.failed++;
          emit({ type: 'pet', id: pet.id, name: pet.name, done: copyJob.done, total: copyJob.total });
        }
      } catch (err) {
        if (copyJob.controller.signal.aborted) break;
        copyJob.lastError = err.message;
        emit({ type: 'error', message: err.message });
        for (const pet of batch) {
          if (!fallback) {
            copyJob.failed++;
            continue;
          }
          copy.items[pet.id] = { ...fallbackCopy(pet), model: null, generatedAt: now };
          copyJob.done++;
          copyJob.failed++;
          emit({ type: 'pet', id: pet.id, name: pet.name, done: copyJob.done, total: copyJob.total, fallback: true });
        }
      }

      copy.generatedAt = now;
      copy.model = batchModel || DEEPSEEK_MODEL;
      copy.source = 'deepseek';
      await copyStore.save();
    }

    copyJob.finishedAt = new Date().toISOString();
    emit({ type: 'done', total: copyJob.total, done: copyJob.done, failed: copyJob.failed, source: 'deepseek' });
    return { total: copyJob.total, done: copyJob.done, failed: copyJob.failed, source: 'deepseek' };
  } finally {
    copyJob.running = false;
    copyJob.currentBatch = '';
    copyJob.controller = null;
  }
}

export function stopCopyJob() {
  if (copyJob.running && copyJob.controller) {
    copyJob.controller.abort();
    return true;
  }
  return false;
}

export function copyJobStatus() {
  const { controller, ...rest } = copyJob;
  return { ...rest, canStop: Boolean(controller) };
}

export { DeepSeekError };
