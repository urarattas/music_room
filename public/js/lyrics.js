/**
 * LRC 歌词解析与滚动展示
 */
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
    this.translation = new Map();
    const tLines = parseLrc(data?.tlyric || '');
    for (const l of tLines) {
      // 翻译行的时间与原文对齐（取最接近的行）
      this.translation.set(l.time, l.text);
    }
    this.activeIndex = -1;
    this._render();
  }

  clear() {
    this.lines = [];
    this.translation.clear();
    this.activeIndex = -1;
    this._render();
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
    const source = this.mode === 'tlyric' && this.translation.size ? this.translation : this.lines;
    for (const l of source) {
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
