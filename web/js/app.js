/**
 * 主应用：宠物列表、筛选、领养、AI 文案生成、右下角挂件联动。
 */
import { api } from './api.js';
import { speech } from './speech.js';
import { PetWidget } from './widget.js';

/* ---------------- DOM ---------------- */
const $ = (id) => document.getElementById(id);
const el = {
  grid: $('grid'),
  empty: $('empty'),
  filmChips: $('filmChips'),
  search: $('search'),
  sort: $('sort'),
  onlyAdopted: $('onlyAdopted'),
  hideAdopted: $('hideAdopted'),
  stats: $('stats'),
  statTotal: $('statTotal'),
  statCopy: $('statCopy'),
  statAdopted: $('statAdopted'),
  statFilms: $('statFilms'),
  petCount: $('petCount'),
  filmCount: $('filmCount'),
  status: $('status'),
  statusDot: $('statusDot'),
  statusLabel: $('statusLabel'),
  btnHealth: $('btnHealth'),
  btnGen: $('btnGen'),
  btnGenLabel: $('btnGenLabel'),
  progress: $('progress'),
  progressTitle: $('progressTitle'),
  progressCount: $('progressCount'),
  progressFill: $('progressFill'),
  progressSub: $('progressSub'),
  modal: $('modal'),
  modalBody: $('modalBody'),
  linecard: $('linecard'),
  lineKicker: $('lineKicker'),
  lineAvatar: $('lineAvatar'),
  lineName: $('lineName'),
  lineJa: $('lineJa'),
  lineZh: $('lineZh'),
  lineScene: $('lineScene'),
  btnSpeakAgain: $('btnSpeakAgain'),
  toasts: $('toasts'),
  petWidget: $('petWidget'),
  petStage: $('petStage'),
  petImg: $('petImg'),
  petBubble: $('petBubble'),
  petBadge: $('petBadge'),
  petOpen: $('petOpen'),
  petTalk: $('petTalk'),
  petReset: $('petReset'),
  clouds: $('clouds'),
  bridge: $('bridge'),
  overlayDot: $('overlayDot'),
  overlayState: $('overlayState'),
  overlayDesc: $('overlayDesc'),
  dshDot: $('dshDot'),
  dshState: $('dshState'),
  dshDesc: $('dshDesc'),
  voiceDot: $('voiceDot'),
  voiceState: $('voiceState'),
  voiceDesc: $('voiceDesc'),
  btnSay: $('btnSay'),
  btnOverlayHelp: $('btnOverlayHelp'),
  btnSimComplete: $('btnSimComplete'),
  btnSimApproval: $('btnSimApproval'),
  btnVoiceInfo: $('btnVoiceInfo'),
};

/* ---------------- 状态 ---------------- */
const state = {
  films: [],
  pets: [],
  stats: null,
  filter: { film: '', q: '', sort: 'rarity', onlyAdopted: false, hideAdopted: false },
  health: null,
  copyPolling: null,
  currentPet: null,     // 右下角当前陪伴的宠物
  currentLine: null,
  japaneseVoice: false,
  overlayOnline: false, // 桌面悬浮层是否在线
};

/* ---------------- 工具 ---------------- */
const RARITY_CLASS = { SSR: 'var(--rarity-ssr)', SR: 'var(--rarity-sr)', R: 'var(--rarity-r)', N: 'var(--rarity-n)' };

function toast(message, kind = '', ms = 3200) {
  const node = document.createElement('div');
  node.className = `toast${kind ? ` toast--${kind}` : ''}`;
  node.textContent = message;
  el.toasts.appendChild(node);
  setTimeout(() => {
    node.style.transition = 'opacity .3s, transform .3s';
    node.style.opacity = '0';
    node.style.transform = 'translateY(-10px)';
    setTimeout(() => node.remove(), 320);
  }, ms);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function setStatus(kind, label) {
  el.status.className = `status status--${kind}`;
  el.statusLabel.textContent = label;
}

/* ---------------- 背景云朵 ---------------- */
function makeClouds() {
  const specs = [
    { w: 180, h: 46, top: '8%', left: '-14%', dur: 96, delay: 0, opacity: 0.9 },
    { w: 120, h: 32, top: '20%', left: '-8%', dur: 128, delay: -30, opacity: 0.7 },
    { w: 240, h: 58, top: '30%', left: '-22%', dur: 160, delay: -70, opacity: 0.55 },
    { w: 96, h: 26, top: '48%', left: '-6%', dur: 110, delay: -52, opacity: 0.6 },
    { w: 200, h: 50, top: '62%', left: '-18%', dur: 145, delay: -12, opacity: 0.45 },
  ];
  for (const s of specs) {
    const c = document.createElement('div');
    c.className = 'cloud';
    c.style.cssText = `width:${s.w}px;height:${s.h}px;top:${s.top};left:${s.left};opacity:${s.opacity};
      animation: drift ${s.dur}s linear ${s.delay}s infinite;`;
    el.clouds.appendChild(c);
  }
  const style = document.createElement('style');
  style.textContent = `@keyframes drift { from { transform: translateX(0); } to { transform: translateX(140vw); } }`;
  document.head.appendChild(style);
}

/* ---------------- 数据加载 ---------------- */
async function loadPets() {
  const data = await api.pets({});
  state.pets = data.pets;
  state.stats = data.stats;
  renderStats();
  renderChips();
  renderGrid();
}

function renderStats() {
  const s = state.stats;
  if (!s) return;
  el.stats.hidden = false;
  el.statTotal.textContent = s.total;
  el.statCopy.textContent = s.withCopy;
  el.statAdopted.textContent = s.adopted;
  el.statFilms.textContent = s.films;
  el.petCount.textContent = s.total;
  el.filmCount.textContent = s.films;
}

function renderChips() {
  const counts = new Map();
  for (const p of state.pets) counts.set(p.film.key, (counts.get(p.film.key) || 0) + 1);

  const items = [{ key: '', zh: '全部', n: state.pets.length }];
  for (const f of state.films) items.push({ key: f.key, zh: f.zh, n: counts.get(f.key) || 0 });

  el.filmChips.innerHTML = items
    .map(
      (it) => `<button class="chip${state.filter.film === it.key ? ' is-active' : ''}" data-film="${escapeHtml(it.key)}" type="button">
        ${escapeHtml(it.zh)}<span class="chip__n">${it.n}</span></button>`
    )
    .join('');
}

/* ---------------- 网格渲染 ---------------- */
function visiblePets() {
  const { film, q, sort, onlyAdopted, hideAdopted } = state.filter;
  let items = state.pets.slice();

  if (film) items = items.filter((p) => p.film.key === film);
  if (onlyAdopted) items = items.filter((p) => p.adopted);
  else if (hideAdopted) items = items.filter((p) => !p.adopted);

  if (q) {
    const needle = q.toLowerCase();
    items = items.filter((p) =>
      [p.name, p.nameJa, p.nameEn, p.film.zh, p.film.en, p.element, ...(p.personality || []), ...(p.copy?.tags || [])]
        .join(' ')
        .toLowerCase()
        .includes(needle)
    );
  }

  const order = { SSR: 0, SR: 1, R: 2, N: 3 };
  if (sort === 'name') items.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  else if (sort === 'film') items.sort((a, b) => a.film.year - b.film.year || a.filmOrderIndex - b.filmOrderIndex);
  else items.sort((a, b) => order[a.rarity] - order[b.rarity] || a.film.year - b.film.year || a.filmOrderIndex - b.filmOrderIndex);

  return items;
}

function renderGrid() {
  const items = visiblePets();
  el.empty.hidden = items.length > 0;

  el.grid.innerHTML = items
    .map((p, i) => {
      const tags = (p.copy?.tags?.length ? p.copy.tags : p.personality || []).slice(0, 4);
      const copyText = p.copy ? p.copy.text : 'AI 正在为它撰写领养文案…';
      const tagline = p.copy?.tagline || `${p.film.zh} · ${p.role === 'Main' ? '主角' : '重要配角'}`;
      const line = p.lineJa || '（这只小家伙不太说话）';
      return `
      <article class="card${p.adopted ? ' is-adopted' : ''}" data-id="${escapeHtml(p.id)}" style="animation-delay:${Math.min(i * 22, 500)}ms">
        <div class="card__media">
          <img loading="lazy" src="${escapeHtml(p.image)}" alt="${escapeHtml(p.name)}" />
          <span class="card__rarity" style="background:${RARITY_CLASS[p.rarity] || RARITY_CLASS.N}">${escapeHtml(p.rarity)}</span>
          <span class="card__role">${p.role === 'Main' ? '主角' : '配角'}</span>
          <div class="card__film"><span>${escapeHtml(p.film.zh)}</span><span>${p.film.year}</span></div>
          ${p.adopted ? '<div class="card__stamp">已领养</div>' : ''}
        </div>
        <div class="card__body">
          <div class="card__names">
            <span class="card__name">${escapeHtml(p.emoji)} ${escapeHtml(p.name)}</span>
            <span class="card__nameJa">${escapeHtml(p.nameJa)}</span>
          </div>
          <p class="card__tagline">${escapeHtml(tagline)}</p>
          <p class="card__copy${p.copy ? '' : ' card__copy--placeholder'}">${escapeHtml(copyText)}</p>
          <div class="card__tags">
            <span class="tag tag--warm">${escapeHtml(p.element)}</span>
            ${tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')}
          </div>
          <div class="card__footer">
            <span class="card__line" title="${escapeHtml(p.lineJa)}">${escapeHtml(line)}</span>
            <button class="card__adopt${p.adopted ? ' is-adopted' : ''}" data-adopt="${escapeHtml(p.id)}" type="button">
              ${p.adopted ? '已领养' : '领养'}
            </button>
          </div>
        </div>
      </article>`;
    })
    .join('');
}

/* ---------------- 详情弹窗 ---------------- */
function openDetail(id) {
  const p = state.pets.find((x) => x.id === id);
  if (!p) return;

  const tags = (p.copy?.tags?.length ? p.copy.tags : p.personality || []);
  const copy = p.copy;

  el.modalBody.innerHTML = `
    <div class="detail">
      <div class="detail__media" style="background:linear-gradient(160deg, ${p.film.accent}22, #f7f3e8)">
        <img src="${escapeHtml(p.image)}" alt="${escapeHtml(p.name)}" />
      </div>
      <div class="detail__content">
        <div class="detail__head">
          <div>
            <h2 class="detail__name" id="modalName">${escapeHtml(p.emoji)} ${escapeHtml(p.name)}</h2>
            <p class="detail__nameJa">${escapeHtml(p.nameJa)} · ${escapeHtml(p.nameEn)}</p>
          </div>
          <span class="detail__rarity" style="background:${RARITY_CLASS[p.rarity] || RARITY_CLASS.N}">${escapeHtml(p.rarity)}</span>
        </div>

        <div class="detail__film">🎬 《${escapeHtml(p.film.zh)}》 ${p.film.year} · ${escapeHtml(p.film.ja)}</div>

        ${copy ? `<p class="detail__tagline">「${escapeHtml(copy.tagline)}」</p>` : ''}
        <p class="detail__copy">${
          copy ? escapeHtml(copy.text) : 'AI 正在为它撰写领养文案，稍后刷新即可看到。'
        }</p>

        ${copy?.care ? `<div class="meta"><div class="meta__k">饲养须知</div><div class="meta__v">${escapeHtml(copy.care)}</div></div>` : ''}

        ${
          p.lineJa
            ? `<div class="quote">
                 <div class="quote__ja">「${escapeHtml(p.lineJa)}」</div>
                 <div class="quote__zh">${escapeHtml(p.lineZh)}</div>
                 <div class="quote__scene">${escapeHtml(p.lineScene)}</div>
               </div>`
            : ''
        }

        <div class="detail__meta">
          <div class="meta"><div class="meta__k">属性</div><div class="meta__v">${escapeHtml(p.element)} ${escapeHtml(p.emoji)}</div></div>
          <div class="meta"><div class="meta__k">出处定位</div><div class="meta__v">${p.role === 'Main' ? '主角' : '重要配角'}</div></div>
          <div class="meta"><div class="meta__k">台词把握度</div><div class="meta__v">${
            { high: '已核实', medium: '较可信', none: '无台词' }[p.lineConfidence] || '—'
          }</div></div>
        </div>

        <div class="detail__tags card__tags">
          ${tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')}
        </div>

        <div class="detail__actions">
          ${
            p.adopted
              ? `<button class="btn btn--ghost" data-release="${escapeHtml(p.id)}" type="button">送回收容所</button>`
              : `<button class="btn btn--primary" data-adopt="${escapeHtml(p.id)}" type="button">领养它</button>`
          }
          ${
            p.lineJa
              ? `<button class="btn btn--warm" data-speak="${escapeHtml(p.id)}" type="button">听它说台词</button>`
              : ''
          }
          <button class="btn btn--ghost" data-regen="${escapeHtml(p.id)}" type="button">重写 AI 文案</button>
        </div>

        <div class="detail__ai">
          <span class="ai-dot"></span>
          ${
            copy
              ? `AI 领养文案 · ${copy.source === 'ai' ? escapeHtml(copy.model || 'DeepSeek') : '内置模板'} · ${new Date(copy.generatedAt).toLocaleString('zh-CN')}`
              : '文案尚未生成'
          }
        </div>
      </div>
    </div>`;

  el.modal.hidden = false;
  document.body.style.overflow = 'hidden';
  // 写入深链，方便分享 / 刷新后保持
  if (location.hash !== `#pet=${p.id}`) {
    history.replaceState(null, '', `#pet=${encodeURIComponent(p.id)}`);
  }
}

function closeDetail() {
  el.modal.hidden = true;
  document.body.style.overflow = '';
  if (location.hash.startsWith('#pet=')) {
    history.replaceState(null, '', location.pathname + location.search);
  }
}

/* ---------------- 深链：#pet=<id> 打开详情，#line=<id> 直接看台词 ---------------- */
function applyHash() {
  const hash = location.hash.replace(/^#/, '');
  if (!hash) return;
  const [kind, id] = hash.split('=');
  if (!id) return;
  const pet = state.pets.find((p) => p.id === decodeURIComponent(id));
  if (!pet) return;
  if (kind === 'pet') openDetail(pet.id);
  else if (kind === 'line') announceLine(pet, { kicker: pet.adopted ? '它的经典台词' : '预览台词' });
}

/* ---------------- 台词宣告 ---------------- */
/**
 * 宣告台词。
 * 如果桌面悬浮层在线，就由它来出声（它可能用的是电影原声），浏览器这边只出画面，
 * 避免两边同时念同一句台词。
 */
async function announceLine(pet, { kicker = '领养成功' } = {}) {
  state.currentLine = pet;
  el.lineKicker.textContent = kicker;
  el.lineAvatar.src = pet.image;
  el.lineAvatar.alt = pet.name;
  el.lineName.textContent = `${pet.emoji} ${pet.name}（${pet.nameJa}）`;

  const hasLine = Boolean(pet.lineJa);
  el.lineJa.textContent = hasLine ? `「${pet.lineJa}」` : '（这只小家伙安静地看着你，什么也没说）';
  el.lineZh.textContent = hasLine ? pet.lineZh : `${pet.name}在《${pet.film.zh}》里没有留下台词，但它留下了陪伴。`;
  el.lineScene.textContent = hasLine ? pet.lineScene : '';
  el.btnSpeakAgain.hidden = !hasLine;

  el.linecard.hidden = false;

  if (!hasLine) {
    showPetBubble(pet, { ja: '', zh: `${pet.name} 安静地陪着你。` });
    return;
  }

  if (state.overlayOnline) {
    // 交给桌面宠物发声，这里只弹气泡
    showPetBubble(pet, { ja: pet.lineJa, zh: pet.lineZh });
    el.btnSpeakAgain.textContent = '让桌宠再说一次';
  } else {
    el.btnSpeakAgain.textContent = '再听一次';
    await speakLine(pet);
  }
}

function closeLineCard() {
  el.linecard.hidden = true;
  speech.cancel();
}

/** 让某只宠物念台词（网页端：浏览器 TTS；若桌面宠物在线则转发给它） */
async function speakLine(pet) {
  if (!pet?.lineJa) return;

  if (state.overlayOnline) {
    await api.overlaySay(pet.id).catch(() => {});
    showPetBubble(pet, { ja: pet.lineJa, zh: pet.lineZh });
    return;
  }

  showPetBubble(pet, { ja: pet.lineJa, zh: pet.lineZh });
  const res = await speech.speakJa(pet.lineJa, {
    onStart: () => { /* 气泡已在显示 */ },
  });

  if (!res.spoken) {
    if (res.reason === 'unsupported') toast('当前浏览器不支持语音合成，已显示台词文字', 'warn');
    else if (!state.japaneseVoice) toast('系统未安装日语语音包，已显示台词文字', 'warn', 4200);
  }
}

function showPetBubble(pet, { ja, zh }) {
  widget.showLine({ ja, zh });
}

/* ---------------- 领养 / 送回 ---------------- */
async function adopt(id, { fromCard = false } = {}) {
  const pet = state.pets.find((p) => p.id === id);
  if (!pet) return;
  if (pet.adopted) {
    openDetail(id);
    return;
  }

  try {
    const res = await api.adopt(id, '无名旅人');
    // 更新本地状态
    const idx = state.pets.findIndex((p) => p.id === id);
    if (idx >= 0) state.pets[idx] = res.pet;
    state.stats = { ...(state.stats || {}), ...(await api.health()).catalog };

    renderStats();
    renderGrid();
    if (!el.modal.hidden) openDetail(id);

    // 设为网页右下角挂件的陪伴（桌面悬浮层由后端在 /adopt 里同步切换）
    setCompanion(res.pet, { persist: true });

    // 刷新一次联动状态，让下面的提示准确
    await refreshBridge().catch(() => {});

    await announceLine(res.pet, { kicker: res.firstTime ? '领养成功' : '又见面了' });

    const ov = res.overlay;
    if (ov && ov.online) {
      toast(
        `领养成功！${res.pet.name} 已经跑到你桌面右下角了` +
          (ov.voiceSource === 'original' ? '（正在播放电影原声）' : '')
      , 'ok');
    } else {
      toast(
        `领养成功！${res.pet.name} 已加入。桌面悬浮宠物没在运行 —— 在项目目录执行 npm run pet 就能让它出现在桌面上`,
        '', 7000
      );
    }
  } catch (err) {
    toast(`领养失败：${err.message}`, 'err');
  }
}

async function release(id) {
  try {
    const res = await api.release(id);
    const idx = state.pets.findIndex((p) => p.id === id);
    if (idx >= 0) state.pets[idx] = res.pet;
    state.stats = { ...(state.stats || {}), ...(await api.health()).catalog };
    renderStats();
    renderGrid();
    if (!el.modal.hidden) openDetail(id);
    toast(`${res.pet.name} 已送回收容所`);
  } catch (err) {
    toast(`操作失败：${err.message}`, 'err');
  }
}

/* ---------------- 右下角挂件 ---------------- */
const widget = new PetWidget({
  root: el.petWidget,
  stage: el.petStage,
  img: el.petImg,
  bubble: el.petBubble,
  onClick: () => {
    document.querySelector('.page')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (state.currentPet) openDetail(state.currentPet.id);
    else toast('还没有选中的宠物，先在列表里领养一只吧');
  },
});

function setCompanion(pet, { persist = false } = {}) {
  if (!pet) return;
  state.currentPet = pet;
  widget.renderPet(pet);

  if (pet.adopted) {
    el.petBadge.hidden = false;
    el.petBadge.textContent = '已领养';
  } else {
    el.petBadge.hidden = true;
  }

  if (persist) {
    try {
      localStorage.setItem('dsh.desktop-pet.companion', pet.id);
    } catch { /* ignore */ }
  }
}

function pickDefaultCompanion() {
  let saved = null;
  try {
    saved = localStorage.getItem('dsh.desktop-pet.companion');
  } catch { /* ignore */ }

  const adopted = state.pets.filter((p) => p.adopted);
  if (saved) {
    const hit = state.pets.find((p) => p.id === saved);
    if (hit) return hit;
  }
  if (adopted.length) {
    // 取最近领养的
    return adopted.sort((a, b) => new Date(b.adoption.adoptedAt) - new Date(a.adoption.adoptedAt))[0];
  }
  return state.pets.find((p) => p.id === 'totoro-totoro') || state.pets[0] || null;
}

/* ---------------- AI 文案生成 ---------------- */
async function startGeneration(force = false) {
  try {
    el.btnGen.disabled = true;
    el.btnGen.querySelector('.btn__spinner').hidden = false;
    el.btnGenLabel.textContent = '生成中…';
    await api.generateCopy({ force });
    el.progress.hidden = false;
    pollCopyStatus();
  } catch (err) {
    el.btnGen.disabled = false;
    el.btnGen.querySelector('.btn__spinner').hidden = true;
    el.btnGenLabel.textContent = '生成 AI 文案';
    toast(`无法开始生成：${err.message}`, 'err');
  }
}

function pollCopyStatus() {
  clearInterval(state.copyPolling);
  state.copyPolling = setInterval(async () => {
    let data;
    try {
      data = await api.copyStatus();
    } catch {
      return;
    }
    const job = data.job;

    if (job.running) {
      el.progress.hidden = false;
      el.progressTitle.textContent = `AI 正在撰写领养文案…（${job.source === 'deepseek' ? job.model || 'DeepSeek' : '内置模板'}）`;
      el.progressCount.textContent = `${job.done} / ${job.total}`;
      const pct = job.total ? Math.round((job.done / job.total) * 100) : 0;
      el.progressFill.style.width = `${pct}%`;
      el.progressSub.textContent = job.currentBatch ? `正在描写：${job.currentBatch}` : '正在呼唤 DeepSeek…';
      return;
    }

    // 结束
    clearInterval(state.copyPolling);
    state.copyPolling = null;
    el.btnGen.disabled = false;
    el.btnGen.querySelector('.btn__spinner').hidden = true;
    el.btnGenLabel.textContent = '生成 AI 文案';

    if (job.total > 0) {
      el.progressTitle.textContent = 'AI 文案生成完成';
      el.progressCount.textContent = `${job.done} / ${job.total}`;
      el.progressFill.style.width = '100%';
      el.progressSub.textContent = job.lastError
        ? `部分批次失败（${job.failed}），已用内置模板补齐：${job.lastError}`
        : `全部完成，共 ${job.done} 条`;
      setTimeout(() => { el.progress.hidden = true; }, 5000);
      toast(`AI 领养文案生成完成（${job.done} 条）`, 'ok');
    }

    await loadPets();
    if (state.currentPet) {
      const refreshed = state.pets.find((p) => p.id === state.currentPet.id);
      if (refreshed) setCompanion(refreshed);
    }
  }, 1000);
}

/* ---------------- 事件绑定 ---------------- */
function bindEvents() {
  el.filmChips.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-film]');
    if (!btn) return;
    state.filter.film = btn.dataset.film;
    renderChips();
    renderGrid();
  });

  let searchTimer;
  el.search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.filter.q = el.search.value.trim();
      renderGrid();
    }, 160);
  });

  el.sort.addEventListener('change', () => {
    state.filter.sort = el.sort.value;
    renderGrid();
  });

  el.onlyAdopted.addEventListener('change', () => {
    state.filter.onlyAdopted = el.onlyAdopted.checked;
    if (el.onlyAdopted.checked) {
      el.hideAdopted.checked = false;
      state.filter.hideAdopted = false;
    }
    renderGrid();
  });

  el.hideAdopted.addEventListener('change', () => {
    state.filter.hideAdopted = el.hideAdopted.checked;
    if (el.hideAdopted.checked) {
      el.onlyAdopted.checked = false;
      state.filter.onlyAdopted = false;
    }
    renderGrid();
  });

  // 卡片点击 / 领养按钮
  el.grid.addEventListener('click', (e) => {
    const adoptBtn = e.target.closest('[data-adopt]');
    if (adoptBtn) {
      e.stopPropagation();
      adopt(adoptBtn.dataset.adopt, { fromCard: true });
      return;
    }
    const card = e.target.closest('.card');
    if (card) openDetail(card.dataset.id);
  });

  // 弹窗内动作
  el.modalBody.addEventListener('click', (e) => {
    const adoptBtn = e.target.closest('[data-adopt]');
    if (adoptBtn) return adopt(adoptBtn.dataset.adopt);
    const relBtn = e.target.closest('[data-release]');
    if (relBtn) return release(relBtn.dataset.release);
    const speakBtn = e.target.closest('[data-speak]');
    if (speakBtn) {
      const pet = state.pets.find((p) => p.id === speakBtn.dataset.speak);
      if (pet) speakLine(pet);
      return;
    }
    const regenBtn = e.target.closest('[data-regen]');
    if (regenBtn) {
      api.regenerate(regenBtn.dataset.regen)
        .then(() => { pollCopyStatus(); toast('正在重新生成这只宠物的文案…'); })
        .catch((err) => toast(`失败：${err.message}`, 'err'));
      return;
    }
  });

  el.modal.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) closeDetail();
  });

  el.linecard.addEventListener('click', (e) => {
    if (e.target.closest('[data-lineclose]')) closeLineCard();
  });

  el.btnSpeakAgain.addEventListener('click', () => {
    if (state.currentLine) speakLine(state.currentLine);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!el.linecard.hidden) closeLineCard();
    else if (!el.modal.hidden) closeDetail();
  });

  el.btnGen.addEventListener('click', () => startGeneration(false));

  el.btnHealth.addEventListener('click', async () => {
    try {
      const h = await api.health();
      state.health = h;
      setStatus(h.deepseek.hasApiKey ? 'ok' : 'warn', h.deepseek.hasApiKey ? 'DeepSeek 已就绪' : '未配置 Key');

      let msg = `后端正常 · 宠物 ${h.catalog.total} 只 · AI 文案 ${h.catalog.withCopy}/${h.catalog.total}`;
      if (h.deepseek.hasApiKey) {
        msg += `\n模型 ${h.deepseek.model} · Key 来源：${h.deepseek.keySource} · ${h.deepseek.maskedKey}`;
      } else {
        msg += `\n未找到 DeepSeek API Key：${h.deepseek.keySource}`;
      }

      // 顺便测一次真实调用
      try {
        const p = await api.pingDeepSeek();
        msg += `\n连通性测试通过（${p.latencyMs}ms，模型 ${p.model}）`;
        toast(`DeepSeek 连通正常 · ${p.latencyMs}ms`, 'ok');
      } catch (err) {
        msg += `\n连通性测试失败：${err.message}`;
        toast(`DeepSeek 调用失败：${err.message}`, 'err', 5000);
      }
      console.log('[自检]\n' + msg);
    } catch (err) {
      setStatus('err', '后端不可用');
      toast(`自检失败：${err.message}`, 'err');
    }
  });

  // 挂件按钮
  el.petOpen.addEventListener('click', () => {
    document.querySelector('.page')?.scrollIntoView({ behavior: 'smooth' });
    if (state.currentPet) openDetail(state.currentPet.id);
  });
  el.petTalk.addEventListener('click', () => {
    const pet = state.currentPet;
    if (!pet) return;
    if (pet.lineJa) speakLine(pet);
    else showPetBubble(pet, { ja: '', zh: `${pet.name} 安静地看着你，尾巴轻轻摇了一下。` });
  });
  el.petReset.addEventListener('click', () => {
    widget.reset();
    toast('宠物已回到右下角');
  });
}

/* ---------------- 悬浮层 / DSH 联动面板 ---------------- */

function setDot(el, kind) {
  el.className = `bridge__dot${kind ? ` is-${kind}` : ''}`;
}

async function refreshBridge() {
  // 1) 桌面悬浮层
  try {
    const s = await api.overlayState();
    const online = s.clientOnline;
    state.overlayOnline = online;
    setDot(el.overlayDot, online ? 'ok' : 'off');
    el.overlayState.textContent = online ? '运行中' : '未启动';
    if (online) {
      const polls = s.client ? s.client.polls : 0;
      el.overlayDesc.textContent = `悬浮窗口正在运行（已轮询 ${polls} 次），当前陪伴：${s.companion ? s.companion.name : '—'}。它压在所有窗口之上，可直接拖动。`;
    } else {
      el.overlayDesc.textContent = '尚未启动。在项目目录另开一个终端执行 npm run pet（需先 npm start），宠物就会悬浮在桌面右下角。';
    }
  } catch {
    setDot(el.overlayDot, 'warn');
    el.overlayState.textContent = '未知';
  }

  // 2) DSH 监听
  try {
    const d = await api.dshStatus();
    const w = d.watcher;
    if (!d.watching || !w) {
      setDot(el.dshDot, 'off');
      el.dshState.textContent = '未开启';
      el.dshDesc.textContent = '监听未启动。以 DSH_WATCH=0 启动后端会关闭它；默认是开启的。';
    } else {
      const pending = w.pendingApprovals || 0;
      setDot(el.dshDot, pending > 0 ? 'warn' : 'ok');
      el.dshState.textContent = pending > 0 ? `${pending} 项待批准` : '监听中';
      el.dshDesc.textContent =
        `正在监听 ${w.sessionsTracked} 个会话（每 ${w.pollMs}ms 一次）。` +
        `已捕获 ${w.turnEnds} 次回合结束、${w.approvalsAsked} 次批准请求。` +
        `完成任务→念台词，请求批准→播放「您有新的请求请批准~」。`;
    }
  } catch {
    setDot(el.dshDot, 'warn');
    el.dshState.textContent = '未知';
  }

  // 3) 语音
  try {
    const v = await api.voicePresets();
    const n = v.originalVoice.count;
    setDot(el.voiceDot, n > 0 ? 'ok' : 'warn');
    el.voiceState.textContent = n > 0 ? `原声 ${n} 段` : 'TTS 合成';
    el.voiceDesc.textContent =
      n > 0
        ? `已识别到 ${n} 段电影原声，将优先播放；其余角色用日语 TTS。`
        : '尚未放入电影原声，当前全部使用日语 TTS 合成。把音频放进 public/voice/<宠物id>.mp3 即可自动切换为原声。';
  } catch {
    setDot(el.voiceDot, 'warn');
    el.voiceState.textContent = '未知';
  }
}

function bindBridge() {
  el.btnSay.addEventListener('click', async () => {
    try {
      // 不传 petId：让后端用「桌面上显示的那只」说话，而不是网页里选中的那只
      const r = await api.overlaySay();
      if (r.ok) {
        toast(`${r.pet} 开始说话了${r.source === 'original' ? '（电影原声）' : '（TTS 合成）'}`);
      } else {
        toast('这只宠物没有可播放的台词', 'warn');
      }
      refreshBridge();
    } catch (err) {
      toast(`桌面宠物没在运行或调用失败：${err.message}`, 'err');
    }
  });

  el.btnOverlayHelp.addEventListener('click', () => {
    toast('另开一个终端，在项目目录执行：npm start 然后 npm run pet', '', 9000);
    console.info(
      '%c启动桌面悬浮宠物',
      'font-weight:bold',
      '\n1) 终端 A: npm start        （后端 + DSH 监听）' +
        '\n2) 终端 B: npm run pet      （编译并启动悬浮窗口）' +
        '\n也可以直接双击 desktop\\start.cmd'
    );
  });

  el.btnSimComplete.addEventListener('click', async () => {
    try {
      const r = await api.overlayTest('complete');
      toast(r.ok ? '已模拟「DSH 任务完成」→ 宠物会念出当前角色的经典台词' : '当前没有可播报的角色', r.ok ? 'ok' : 'warn');
      refreshBridge();
    } catch (err) {
      toast(`失败：${err.message}`, 'err');
    }
  });

  el.btnSimApproval.addEventListener('click', async () => {
    try {
      const r = await api.overlayTest('approval');
      toast(`已模拟「请求批准」→ ${r.text || '您有新的请求请批准~'}`, 'ok');
      refreshBridge();
    } catch (err) {
      toast(`失败：${err.message}`, 'err');
    }
  });

  el.btnVoiceInfo.addEventListener('click', async () => {
    try {
      const v = await api.voicePresets();
      const o = v.originalVoice;
      const lines = [];
      lines.push(`批准提示语：${v.approvalText}`);
      lines.push(`可选语音预设：${Object.keys(v.presets).join(' / ')}`);
      lines.push(`已放入原声：${o.count} 段（目录 ${o.dir}）`);
      lines.push(o.namingHint);
      if (o.count) lines.push('已有：' + Object.keys(o.pets).join(', '));
      toast(lines.join('  ·  '), '', 12000);
      console.info('[语音信息]\n' + lines.join('\n'));
    } catch (err) {
      toast(`失败：${err.message}`, 'err');
    }
  });
}

/* ---------------- 启动 ---------------- */
async function boot() {
  makeClouds();
  bindEvents();
  bindBridge();
  refreshBridge();
  setInterval(refreshBridge, 4000);

  // 1) 健康检查
  try {
    const h = await api.health();
    state.health = h;

    if (h.deepseek.hasApiKey) {
      setStatus('ok', 'DeepSeek 已就绪');
    } else {
      setStatus('warn', '未配置 API Key');
    }

    if (!h.deepseek.hasApiKey) {
      toast('未找到 DeepSeek API Key，将使用内置文案模板', 'warn', 5000);
    }
    if (h.catalog.withCopy < h.catalog.total) {
      el.progress.hidden = false;
      el.progressTitle.textContent = h.copyJob.running ? 'AI 正在撰写领养文案…' : 'AI 领养文案尚未生成完整';
      el.progressSub.textContent = `已完成 ${h.catalog.withCopy}/${h.catalog.total}，可点击右上角「生成 AI 文案」`;
    }
    if (h.copyJob.running) pollCopyStatus();
  } catch (err) {
    setStatus('err', '后端连接失败');
    toast(`无法连接后端：${err.message}`, 'err', 6000);
    return;
  }

  // 2) 电影 + 宠物
  try {
    const films = await api.films();
    state.films = films.films;
    await loadPets();
  } catch (err) {
    toast(`加载宠物失败：${err.message}`, 'err', 6000);
    return;
  }

  // 3) 右下角宠物
  const companion = pickDefaultCompanion();
  if (companion) {
    setCompanion(companion);
    const adoptedCount = state.pets.filter((p) => p.adopted).length;
    setTimeout(() => {
      widget.showLine({
        ja: companion.lineJa || '',
        zh: companion.adopted
          ? `${companion.name} 已经在你的桌面上安家了。`
          : `你好，我是${companion.name}。要带我回家吗？`,
      });
    }, 900);
  }

  // 4) 日语语音可用性
  state.japaneseVoice = await speech.hasJapanese();
  if (speech.supported && !state.japaneseVoice) {
    console.info('[语音] 系统未找到日语语音包，台词将以文字呈现。');
  }

  // 5) 深链
  applyHash();
  window.addEventListener('hashchange', applyHash);
}

boot();
