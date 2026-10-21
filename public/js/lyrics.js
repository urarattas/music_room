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

    tabsEl?.addEventListener('click', (e) => {
      const btn = e.target.closest('.lyric-tab');
      if (!btn) return;
      this.mode = btn.dataset.mode || 'lyric';
      for (const t of tabsEl.querySelectorAll('.lyric-tab')) {
        t.classList.toggle('active', t === btn);
      }
      this._render();
    });
  }

  /** @param {{lyric:string, tlyric:string}} data */
  setLyrics(data) {
    this.lines = parseLrc(data?.lyric || '');
    this.translation = matchTranslation(this.lines, parseLrc(data?.tlyric || ''));
    this.activeIndex = -1;
    this._render();
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
      return;
    }
    for (const l of this._source()) {
      const div = document.createElement('div');
      div.className = 'lyric-line';
      div.dataset.time = String(l.time);
      div.textContent = l.text || '♪';
      this.listEl.appendChild(div);
    }
  }

  /** 根据当前播放位置高亮歌词 */
  update(posMs) {
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
    // 居中滚动
    const box = this.listEl;
    const top = target.offsetTop - box.clientHeight / 2 + target.offsetHeight / 2;
    box.scrollTo({ top, behavior: 'smooth' });
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
