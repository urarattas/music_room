/**
 * LRC 歌词解析与滚动展示
 */

/** 翻译行与原文行的时间戳允许的最大偏差（秒） */
const TIME_TOLERANCE = 0.15;

export class LyricPanel {
  constructor({ listEl, tabsEl }) {
    this.listEl = listEl;
    this.tabsEl = tabsEl;
    this.mode = 'lyric';
    this.lines = []; // [{ time, text }]
    this.translation = new Map(); // time -> text
    this.activeIndex = -1;
    /** 最近一次播放位置，用于歌词重新加载后恢复高亮 */
    this.lastPosMs = undefined;

    tabsEl?.addEventListener('click', (e) => {
      const btn = e.target.closest('.lyric-tab');
      if (!btn) return;
      this.mode = btn.dataset.mode || 'lyric';
      for (const t of tabsEl.querySelectorAll('.lyric-tab')) {
        t.classList.toggle('active', t === btn);
      }
      this._render();
      // 切换标签后重新定位到当前行
      this.activeIndex = -1;
      if (this.lastPosMs !== undefined) this.update(this.lastPosMs);
    });

    // 容器尺寸变化（窗口缩放、布局变化）后重新补白与居中
    if (typeof ResizeObserver !== 'undefined' && this.listEl) {
      this._resizeObserver = new ResizeObserver(() => {
        this._ensurePadding();
        this.refresh('auto');
      });
      this._resizeObserver.observe(this.listEl);
    }
  }

  /** @param {{lyric:string, tlyric:string}} data */
  setLyrics(data) {
    this.lines = parseLrc(data?.lyric || '');
    this.translation = matchTranslation(this.lines, parseLrc(data?.tlyric || ''));
    this.activeIndex = -1;
    this._render();
    // 新歌词加载后，把当前播放位置对应的行滚到正中
    if (this.lastPosMs !== undefined) {
      this.update(this.lastPosMs);
    }
  }

  clear() {
    this.lines = [];
    this.translation.clear();
    this.activeIndex = -1;
    this._render();
  }

  /** 当前模式下要展示的行 */
  _source() {
    if (this.mode === 'tlyric' && this.translation.size) {
      // 翻译行按原文行的时间轴排列，保证高亮同步
      const out = [];
      for (const l of this.lines) {
        const text = this.translation.get(l.time);
        out.push({ time: l.time, text: text !== undefined ? text : l.text });
      }
      return out;
    }
    return this.lines;
  }

  _render() {
    this.listEl.innerHTML = '';
    if (!this.lines.length) {
      const empty = document.createElement('div');
      empty.className = 'lyric-empty';
      empty.textContent = '暂无歌词';
      this.listEl.appendChild(empty);
      this._ensurePadding();
      return;
    }
    for (const l of this._source()) {
      const div = document.createElement('div');
      div.className = 'lyric-line';
      div.dataset.time = String(l.time);
      div.textContent = l.text || '♪';
      this.listEl.appendChild(div);
    }
    this._ensurePadding();
  }

  /** 根据当前播放位置高亮歌词 */
  update(posMs) {
    this.lastPosMs = posMs;
    if (!this.lines.length) return;
    const t = posMs / 1000;
    let idx = -1;
    for (let i = 0; i < this.lines.length; i++) {
      if (this.lines[i].time <= t) idx = i;
      else break;
    }
    if (idx === this.activeIndex) return;
    this.activeIndex = idx;

    const children = [...this.listEl.children];
    children.forEach((c) => c.classList.remove('active'));
    const target = children[idx];
    if (!target) return;
    target.classList.add('active');
    this._scrollToCenter(target);
  }

  /**
   * 把指定行滚动到可视区域的垂直中央。
   *
   * 用 getBoundingClientRect 计算，而不是 offsetTop ——
   * offsetTop 是相对 offsetParent 的偏移，当容器没有 position: relative 时
   * 它相对的是页面而非滚动容器，算出来的滚动位置会完全跑偏。
   */
  _scrollToCenter(target, behavior = 'smooth') {
    const box = this.listEl;
    if (!box) return;
    const boxRect = box.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    if (!boxRect.height) return;

    // 目标行相对容器顶部的偏移，加上要回退的「半个容器高度 - 半个行高」
    const offsetInBox = targetRect.top - boxRect.top + box.scrollTop;
    const top = offsetInBox - box.clientHeight / 2 + targetRect.height / 2;

    // 首行/末行内容不足以滚到正中时，浏览器会自动夹到边界，
    // 这里显式夹一次，避免"差很多"的偏移
    const maxTop = Math.max(0, box.scrollHeight - box.clientHeight);
    const clamped = Math.max(0, Math.min(maxTop, top));

    // 已经基本居中就不用滚了，避免频繁触发动画
    if (Math.abs(box.scrollTop - clamped) < 2) return;
    box.scrollTo({ top: clamped, behavior });
  }

  /**
   * 在歌词列表上下补足空白，让首行/末行也能滚到正中。
   *
   * 歌词总高度可能小于容器高度（比如只有几行、或容器很高），
   * 这时首行永远在顶部，无法居中。
   * 补上「半个容器高」的上 padding 与同样多的下 padding 后，
   * 任何一行都能被滚到中央。
   */
  _ensurePadding() {
    const box = this.listEl;
    if (!box) return;
    const pad = Math.max(0, Math.floor(box.clientHeight / 2) - 20);
    box.style.paddingTop = `${pad}px`;
    box.style.paddingBottom = `${pad}px`;
  }

  /** 歌词内容变化后（如切歌、切换标签页）重新居中当前行 */
  refresh(behavior = 'auto') {
    if (this.activeIndex < 0) return;
    const target = this.listEl?.children?.[this.activeIndex];
    if (target) this._scrollToCenter(target, behavior);
  }
}

/**
 * 把翻译行对齐到原文行。
 *
 * 上游的原文与翻译时间戳**不一定完全相同** —— 实测有的歌两者相差 50ms
 * （如原文 `[00:01.000]` 对应翻译 `[00:01.050]`）。若用严格相等匹配，
 * 这些行会被当成"没有翻译"，导致切到翻译标签页时仍显示原文。
 *
 * 做法：先按精确时间戳匹配，剩下的用「时间最近且在容差内」的原文行兜底。
 *
 * @param {{time:number,text:string}[]} lines 原文行
 * @param {{time:number,text:string}[]} tLines 翻译行
 * @returns {Map<number,string>} 原文时间 -> 翻译文本
 */
export function matchTranslation(lines, tLines) {
  const map = new Map();
  if (!lines.length || !tLines.length) return map;

  const exact = new Map(lines.map((l) => [l.time, l.text]));
  const used = new Set();

  // 第一轮：精确匹配
  for (const t of tLines) {
    if (exact.has(t.time)) {
      map.set(t.time, t.text);
      used.add(t.time);
    }
  }

  // 第二轮：容差匹配（取最近的未占用原文行）
  for (const t of tLines) {
    if (map.has(t.time)) continue;
    let best = null;
    let bestDiff = Infinity;
    for (const l of lines) {
      if (used.has(l.time)) continue;
      const diff = Math.abs(l.time - t.time);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = l;
      }
    }
    if (best && bestDiff <= TIME_TOLERANCE) {
      map.set(best.time, t.text);
      used.add(best.time);
    }
  }

  return map;
}

/**
 * 解析 LRC 歌词
 * @param {string} lrc
 * @returns {{time:number,text:string}[]}
 */
export function parseLrc(lrc) {
  if (!lrc || typeof lrc !== 'string') return [];
  const out = [];
  const timeRe = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
  for (const raw of lrc.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    timeRe.lastIndex = 0;
    const times = [];
    let m;
    while ((m = timeRe.exec(line)) !== null) {
      const min = Number(m[1]);
      const sec = Number(m[2]);
      const frac = m[3] ? Number(`0.${m[3]}`) : 0;
      times.push(min * 60 + sec + frac);
    }
    if (!times.length) continue;
    const text = line.replace(timeRe, '').trim();
    for (const time of times) out.push({ time, text });
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}
