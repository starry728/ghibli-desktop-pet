/**
 * 右下角桌面宠物挂件
 *
 * - 默认出现在视口右下角
 * - 可自由拖动（Pointer Events，支持鼠标 / 触摸 / 触控笔）
 * - 位置持久化到 localStorage，窗口缩放时自动收进视口
 * - 拖动与点击自动区分：位移小于阈值视为点击
 */

const STORAGE_KEY = 'dsh.desktop-pet.position.v1';
const MARGIN = 8;          // 距离视口边缘的最小留白
const DRAG_THRESHOLD = 5;  // px，超过才认定是拖动

export class PetWidget {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.root       .pet 容器
   * @param {HTMLElement} opts.stage      可拖拽的舞台（.pet__stage）
   * @param {HTMLImageElement} opts.img   宠物头像
   * @param {HTMLElement} opts.bubble     气泡
   * @param {(ev:{type:string})=>void} opts.onClick 点击（非拖动）回调
   * @param {(pos:{x:number,y:number})=>void} [opts.onMove]
   */
  constructor({ root, stage, img, bubble, onClick, onMove }) {
    this.root = root;
    this.stage = stage;
    this.img = img;
    this.bubble = bubble;
    this.onClick = onClick;
    this.onMove = onMove;

    this.pos = null;          // { left, top } 像素
    this.dragging = false;
    this.moved = false;
    this.pointerId = null;
    this.offset = { x: 0, y: 0 };
    this.start = { x: 0, y: 0 };

    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerUp = this._onPointerUp.bind(this);
    this._onKeyDown = this._onKeyDown.bind(this);
    this._onResize = this._clampToViewport.bind(this);

    this.stage.addEventListener('pointerdown', this._onPointerDown);
    this.stage.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('resize', this._onResize);
    window.addEventListener('scroll', this._onResize, { passive: true });

    this.restore();
  }

  /* -------------------- 位置 -------------------- */

  /** 当前尺寸 */
  _size() {
    const r = this.root.getBoundingClientRect();
    return { w: r.width || 132, h: r.height || 190 };
  }

  /** 用 left/top 定位（初始为 right/bottom） */
  _applyPx(left, top) {
    this.pos = { left, top };
    this.root.style.right = 'auto';
    this.root.style.bottom = 'auto';
    this.root.style.left = `${Math.round(left)}px`;
    this.root.style.top = `${Math.round(top)}px`;
  }

  _maxLeft() {
    return Math.max(MARGIN, window.innerWidth - this._size().w - MARGIN);
  }
  _maxTop() {
    return Math.max(MARGIN, window.innerHeight - this._size().h - MARGIN);
  }

  _clamp(left, top) {
    return {
      left: Math.min(Math.max(MARGIN, left), this._maxLeft()),
      top: Math.min(Math.max(MARGIN, top), this._maxTop()),
    };
  }

  /** 窗口变化后把挂件收回视口 */
  _clampToViewport() {
    if (!this.pos) return;
    const { left, top } = this._clamp(this.pos.left, this.pos.top);
    this._applyPx(left, top);
    this._flipBubble();
    this.persist();
  }

  /** 回到右下角 */
  reset({ animate = true } = {}) {
    if (animate) {
      this.root.classList.add('is-snapping');
      setTimeout(() => this.root.classList.remove('is-snapping'), 400);
    }
    this.root.style.left = 'auto';
    this.root.style.top = 'auto';
    this.root.style.right = `${28}px`;
    this.root.style.bottom = `${28}px`;
    this.pos = null;
    this.root.classList.remove('has-moved');
    this._flipBubble();
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }

  persist() {
    if (!this.pos) return;
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ ...this.pos, vw: window.innerWidth, vh: window.innerHeight })
      );
    } catch {
      /* ignore */
    }
  }

  restore() {
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    } catch {
      saved = null;
    }
    if (!saved || typeof saved.left !== 'number' || typeof saved.top !== 'number') {
      this.reset({ animate: false });
      return;
    }
    // 按窗口尺寸变化等比缩放，避免换分辨率后跑到屏幕外
    const sx = saved.vw ? window.innerWidth / saved.vw : 1;
    const sy = saved.vh ? window.innerHeight / saved.vh : 1;
    const { left, top } = this._clamp(saved.left * sx, saved.top * sy);
    this._applyPx(left, top);
    this.root.classList.add('has-moved');
    this._flipBubble();
  }

  /** 靠近左半边时气泡朝左展开 */
  _flipBubble() {
    const r = this.root.getBoundingClientRect();
    const nearLeft = r.left + r.width / 2 < window.innerWidth / 2;
    this.root.classList.toggle('bubble-left', nearLeft);
  }

  /* -------------------- 拖动 -------------------- */

  _onPointerDown(e) {
    if (e.button !== undefined && e.button !== 0) return;
    const rect = this.root.getBoundingClientRect();

    this.dragging = true;
    this.moved = false;
    this.pointerId = e.pointerId;
    this.start = { x: e.clientX, y: e.clientY };
    this.offset = { x: e.clientX - rect.left, y: e.clientY - rect.top };

    // setPointerCapture 在极端情况下（无效 pointerId、元素已移除）会抛异常，
    // 但即使不捕获指针，下面的 pointermove/up 监听也能保证拖动可用。
    try {
      this.stage.setPointerCapture?.(e.pointerId);
    } catch {
      /* ignore */
    }
    this.stage.addEventListener('pointermove', this._onPointerMove);
    this.stage.addEventListener('pointerup', this._onPointerUp);
    this.stage.addEventListener('pointercancel', this._onPointerUp);
    e.preventDefault();
  }

  _onPointerMove(e) {
    if (!this.dragging || e.pointerId !== this.pointerId) return;

    const dx = e.clientX - this.start.x;
    const dy = e.clientY - this.start.y;

    if (!this.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;

    if (!this.moved) {
      this.moved = true;
      this.root.classList.add('is-dragging', 'has-moved');
      this.hideBubble();
    }

    const { left, top } = this._clamp(e.clientX - this.offset.x, e.clientY - this.offset.y);
    this._applyPx(left, top);
    this.onMove?.({ x: left, y: top });
  }

  _onPointerUp(e) {
    if (e.pointerId !== undefined && e.pointerId !== this.pointerId) return;

    this.stage.removeEventListener('pointermove', this._onPointerMove);
    this.stage.removeEventListener('pointerup', this._onPointerUp);
    this.stage.removeEventListener('pointercancel', this._onPointerUp);
    try {
      this.stage.releasePointerCapture?.(this.pointerId);
    } catch {
      /* ignore */
    }

    const wasDragging = this.dragging;
    const didMove = this.moved;
    this.dragging = false;
    this.moved = false;
    this.pointerId = null;
    this.root.classList.remove('is-dragging');

    if (didMove) {
      this.persist();
      this._flipBubble();
    } else if (wasDragging) {
      // 视为点击 → 打开领养所
      this.onClick?.({ type: 'click' });
    }
  }

  _onKeyDown(e) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      this.onClick?.({ type: 'keyboard' });
    }
  }

  /* -------------------- 表现 -------------------- */

  renderPet(pet) {
    if (!pet) return;
    this.img.src = pet.image;
    this.img.alt = `${pet.name}（${pet.nameJa}）`;
    this.root.dataset.petId = pet.id;
  }

  /** 显示日语台词气泡 */
  showLine({ ja, zh }, { duration = 7000 } = {}) {
    const jaEl = this.bubble.querySelector('.pet__bubble-ja');
    const zhEl = this.bubble.querySelector('.pet__bubble-zh');
    if (jaEl) jaEl.textContent = ja || '';
    if (zhEl) zhEl.textContent = zh || '';
    this.bubble.hidden = false;
    this._flipBubble();
    this.root.classList.add('is-speaking');
    clearTimeout(this._bubbleTimer);
    setTimeout(() => this.root.classList.remove('is-speaking'), 2400);
    if (duration > 0) {
      this._bubbleTimer = setTimeout(() => this.hideBubble(), duration);
    }
  }

  showText(zh) {
    this.showLine({ ja: '', zh });
  }

  hideBubble() {
    this.bubble.hidden = true;
    this.root.classList.remove('is-speaking');
    clearTimeout(this._bubbleTimer);
  }

  destroy() {
    window.removeEventListener('resize', this._onResize);
    window.removeEventListener('scroll', this._onResize);
    this.stage.removeEventListener('pointerdown', this._onPointerDown);
    this.stage.removeEventListener('keydown', this._onKeyDown);
  }
}
