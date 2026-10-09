/**
 * 日语台词播报：优先使用浏览器语音合成（ja-JP），
 * 若无可用语音则静默降级（文字气泡照常显示）。
 */

let cachedVoices = [];
let voicesReady = null;

function loadVoices() {
  if (voicesReady) return voicesReady;
  voicesReady = new Promise((resolve) => {
    if (!('speechSynthesis' in window)) return resolve([]);
    const grab = () => {
      cachedVoices = window.speechSynthesis.getVoices() || [];
      if (cachedVoices.length) resolve(cachedVoices);
    };
    grab();
    if (!cachedVoices.length) {
      window.speechSynthesis.addEventListener('voiceschanged', grab, { once: true });
      setTimeout(() => resolve(window.speechSynthesis.getVoices() || []), 1500);
    }
  });
  return voicesReady;
}

export const speech = {
  get supported() {
    return 'speechSynthesis' in window && typeof SpeechSynthesisUtterance === 'function';
  },

  /** 挑选最合适的日语语音 */
  async pickJapaneseVoice() {
    const voices = await loadVoices();
    if (!voices.length) return null;
    const ja = voices.filter((v) => /^ja/i.test(v.lang || ''));
    if (!ja.length) return null;
    // 偏好本地/native 语音，其次名字里带 Kyoko / Nanami / Google
    const score = (v) => {
      let s = 0;
      if (v.localService) s += 3;
      if (/kyoko|nanami|google|microsoft/i.test(v.name)) s += 2;
      if (/ja-JP/i.test(v.lang)) s += 1;
      return s;
    };
    return ja.sort((a, b) => score(b) - score(a))[0];
  },

  /** 是否有可用日语语音 */
  async hasJapanese() {
    return Boolean(await this.pickJapaneseVoice());
  },

  /**
   * 朗读一段日语文本。
   * @returns {Promise<{spoken:boolean, reason?:string}>}
   */
  async speakJa(text, { rate = 0.92, pitch = 1.05, onStart, onEnd } = {}) {
    if (!text) return { spoken: false, reason: 'empty' };
    if (!this.supported) return { spoken: false, reason: 'unsupported' };

    try {
      window.speechSynthesis.cancel();
    } catch {
      /* ignore */
    }

    const voice = await this.pickJapaneseVoice();
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = 'ja-JP';
    utter.rate = rate;
    utter.pitch = pitch;
    utter.volume = 1;
    if (voice) utter.voice = voice;

    return new Promise((resolve) => {
      let settled = false;
      const settle = (r) => {
        if (settled) return;
        settled = true;
        clearTimeout(guard);
        onEnd?.();
        resolve(r);
      };
      // 兜底超时：部分浏览器不会触发 onend，避免 Promise 永久挂起
      const guard = setTimeout(() => settle({ spoken: true }), Math.min(15000, 1800 + text.length * 220));
      utter.onstart = () => onStart?.();
      utter.onend = () => settle({ spoken: true });
      utter.onerror = () => settle({ spoken: false, reason: 'error' });
      try {
        window.speechSynthesis.speak(utter);
      } catch {
        clearTimeout(guard);
        settle({ spoken: false, reason: 'exception' });
      }
    });
  },

  cancel() {
    if (this.supported) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        /* ignore */
      }
    }
  },
};
