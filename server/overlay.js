/**
 * OverlayHub —— 桌面悬浮宠物的事件总线
 *
 * 任何来源（网页领养、DSH 完成任务、DSH 请求批准、手动测试）都往这里投递事件，
 * 悬浮层 PetOverlay.exe 通过 /api/overlay/poll?since=<cursor> 拉取新指令。
 *
 * 指令类型（发给悬浮层）：
 *   { type:'pet',    petId, imageUrl }
 *   { type:'speak',  petId, imageUrl, audioUrl, ja, zh, reason, source }
 *   { type:'bubble', ja, zh }
 *   { type:'quit' }
 */
import { getPetRaw } from './catalog.js';
import { adoptionStore } from './catalog.js';
import { resolveLineAudio, resolveApprovalAudio, resolveSayAudio, listOriginalVoicePets } from './voice.js';

const MAX_LOG = 300;

class OverlayHub {
  constructor() {
    this.seq = 0;
    this.log = [];
    /** 当前陪伴的宠物 id（右下游走的那只） */
    this.companionId = null;
    /** 最近一次事件，供 /api/overlay/state 展示 */
    this.lastEvent = null;
    /** 去抖：避免同一来源短时间重复播报 */
    this._lastSpoken = { key: null, at: 0 };
  }

  /** 投递一条指令（会推入队列并推进游标） */
  push(command) {
    this.seq += 1;
    const entry = { seq: this.seq, at: new Date().toISOString(), command };
    this.log.push(entry);
    if (this.log.length > MAX_LOG) this.log.splice(0, this.log.length - MAX_LOG);
    this.lastEvent = entry;
    return entry;
  }

  /** 取游标之后的新指令，同时返回服务端保留的最小游标 */
  since(cursor) {
    const c = Number(cursor) || 0;
    let commands = this.log.filter((e) => e.seq > c).map((e) => e.command);

    // 悬浮层离线较久时，积压的指令会在重连瞬间一次性下发（可能连播十几句）。
    // 这里做折叠：只保留「最后一只宠物」与「最后一条要播的指令」。
    if (commands.length > 8) {
      const lastOf = (type) => {
        for (let i = commands.length - 1; i >= 0; i--) if (commands[i].type === type) return commands[i];
        return null;
      };
      const keep = [];
      const pet = lastOf('pet');
      const speak = lastOf('speak');
      const quit = lastOf('quit');
      if (pet) keep.push(pet);
      if (speak) keep.push(speak);
      if (quit) keep.push(quit);
      commands = keep;
    }

    return { cursor: this.seq, commands, oldest: this.log.length ? this.log[0].seq : this.seq };
  }

  /** 悬浮层心跳：每次 /api/overlay/poll 都会更新，用于确认 exe 真的活着并在拉取指令 */
  touchClient(info = {}) {
    const now = Date.now();
    this.client = {
      lastPollAt: new Date(now).toISOString(),
      lastPollMs: now,
      polls: (this.client && this.client.polls ? this.client.polls : 0) + 1,
      since: info.since ?? null,
      pet: info.pet || '',
      remote: info.remote || '',
    };
    return this.client;
  }

  /** 悬浮层是否在线（默认 6 秒内有心跳） */
  clientOnline(windowMs = 6000) {
    if (!this.client || !this.client.lastPollMs) return false;
    return Date.now() - this.client.lastPollMs < windowMs;
  }

  /** 通用去抖：key 相同且间隔小于 ms 就跳过 */
  _debounced(key, ms) {
    const now = Date.now();
    if (this._lastSpoken.key === key && now - this._lastSpoken.at < ms) return true;
    this._lastSpoken = { key, at: now };
    return false;
  }

  /* -------------------- 高层动作 -------------------- */

  /** 切换悬浮层显示的宠物 */
  setPet(pet) {
    if (!pet) return null;
    this.companionId = pet.id;
    return this.push({ type: 'pet', petId: pet.id, imageUrl: pet.image, name: pet.name, nameJa: pet.nameJa });
  }

  /** 让宠物说它的经典台词 */
  async speakLine(pet, opts = {}) {
    if (!pet) return null;
    const key = 'line:' + pet.id + ':' + (opts.reason || '');
    if (!opts.force && this._debounced(key, opts.debounceMs || 2500)) return null;

    const audio = await resolveLineAudio(pet, opts);
    this.companionId = pet.id;
    return this.push({
      type: 'speak',
      petId: pet.id,
      name: pet.name,
      nameJa: pet.nameJa,
      imageUrl: pet.image,
      audioUrl: audio.url,
      voiceSource: audio.source,
      ja: pet.lineJa || '',
      zh: pet.lineZh || '',
      scene: pet.lineScene || '',
      reason: opts.reason || 'line',
      title: opts.title || '',
    });
  }

  /** 「您有新的请求请批准~」 */
  async speakApproval(opts = {}) {
    const key = 'approval';
    if (!opts.force && this._debounced(key, opts.debounceMs || 2000)) return null;

    const audio = await resolveApprovalAudio(opts);
    const pet = this.companionId ? getPetRaw(this.companionId) : null;
    return this.push({
      type: 'speak',
      petId: pet ? pet.id : '',
      name: pet ? pet.name : '',
      imageUrl: pet ? pet.image : '',
      audioUrl: audio.url,
      voiceSource: audio.source,
      ja: '',
      zh: audio.text,
      reason: 'approval',
      title: opts.title || 'DSH 等待你的批准',
      preset: audio.preset,
      voice: audio.voice,
    });
  }

  /** 说话（中文，苏苏音） */
  async speakText(text, opts = {}) {
    const audio = await resolveSayAudio(text, opts);
    const pet = this.companionId ? getPetRaw(this.companionId) : null;
    return this.push({
      type: 'speak',
      petId: pet ? pet.id : '',
      imageUrl: pet ? pet.image : '',
      audioUrl: audio.url,
      voiceSource: audio.source,
      ja: '',
      zh: text,
      reason: opts.reason || 'say',
      title: opts.title || '',
    });
  }

  /** 只弹气泡，不出声 */
  bubble(ja, zh) {
    return this.push({ type: 'bubble', ja: ja || '', zh: zh || '' });
  }

  /** 完成任务：换回陪伴宠物并念台词 */
  async taskComplete(opts = {}) {
    let pet = null;
    if (opts.petId) pet = getPetRaw(opts.petId);
    if (!pet && this.companionId) pet = getPetRaw(this.companionId);
    if (!pet) pet = await defaultCompanionPet();
    if (!pet) return null;
    return this.speakLine(pet, {
      reason: 'task-complete',
      title: opts.title || '任务完成',
      debounceMs: opts.debounceMs || 3000,
      force: opts.force,
    });
  }

  state() {
    const orig = listOriginalVoicePets();
    return {
      cursor: this.seq,
      companionId: this.companionId,
      companion: this.companionId ? getPetRaw(this.companionId) : null,
      lastEvent: this.lastEvent,
      queued: this.log.length,
      originalVoiceCount: Object.keys(orig).length,
      originalVoice: orig,
      client: this.client || null,
      clientOnline: this.clientOnline(),
    };
  }
}

/** 默认陪伴宠物：优先最近领养的，其次龙猫 */
export async function defaultCompanionPet() {
  try {
    const data = await adoptionStore.load();
    const ids = Object.keys(data.adoptions || {});
    if (ids.length) {
      ids.sort((a, b) => new Date(data.adoptions[b].adoptedAt) - new Date(data.adoptions[a].adoptedAt));
      const p = getPetRaw(ids[0]);
      if (p) return p;
    }
  } catch { /* ignore */ }
  return getPetRaw('totoro-totoro') || null;
}

export const overlayHub = new OverlayHub();
