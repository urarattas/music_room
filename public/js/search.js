/** 搜索面板 */
import { isVisible } from './cover-loader.js';

export class SearchPanel {
  constructor({ listEl, formEl, inputEl, sourceEl, statusEl, onPick, onAdd, coverLoader }) {
    this.listEl = listEl;
    this.formEl = formEl;
    this.inputEl = inputEl;
    this.sourceEl = sourceEl;
    this.statusEl = statusEl;
    this.onPick = onPick || (() => {});
    this.onAdd = onAdd || (() => {});
    this.coverLoader = coverLoader || null;
    this.results = [];

    this.formEl.addEventListener('submit', (e) => {
      e.preventDefault();
      this.search(1);
    });

    // 滚动时补充加载可视区域内的封面
    this.listEl.addEventListener('scroll', () => this._loadVisibleCovers());
  }

  /** 只为可视区域内的条目加载封面，避免一次拉几十张 */
  _loadVisibleCovers() {
    if (!this.coverLoader) return;
    const items = this.listEl.querySelectorAll('.track-item');
    let priority = 0;
    for (const li of items) {
      const img = li.querySelector('img');
      if (!img || img.dataset.coverState) continue;
      if (!isVisible(li, this.listEl)) continue;
      const idx = Number(img.dataset.index ?? priority);
      this.coverLoader.push(img, this._trackOf(img), idx);
      priority++;
    }
  }

  _trackOf(img) {
    try {
      return JSON.parse(img.dataset.track);
    } catch {
      return null;
    }
  }

  async search(pages = 1) {
    const name = this.inputEl.value.trim();
    if (!name) {
      this.statusEl.textContent = '请输入关键字';
      return;
    }
    this.statusEl.textContent = '搜索中…';
    try {
      const params = new URLSearchParams({
        source: this.sourceEl.value,
        name,
        count: '30',
        pages: String(pages),
      });
      const res = await fetch(`/api/search?${params}`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      this.results = data.list || [];
      this.statusEl.textContent = this.results.length
        ? `找到 ${this.results.length} 首`
        : '没有找到相关歌曲';
      this.render();
    } catch (err) {
      this.statusEl.textContent = `搜索失败：${err.message}`;
      this.results = [];
      this.render();
    }
  }

  render() {
    this.listEl.innerHTML = '';
    this.results.forEach((track, idx) => {
      const li = document.createElement('li');
      li.className = 'track-item';

      const img = document.createElement('img');
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.dataset.index = String(idx);
      if (track.pic_id) {
        img.dataset.track = JSON.stringify({ source: track.source, pic_id: track.pic_id });
        if (!this.coverLoader) {
          img.src = `/img/pic?source=${encodeURIComponent(track.source)}&id=${encodeURIComponent(track.pic_id)}&size=300`;
          img.onerror = () => img.remove();
        }
      }

      const meta = document.createElement('div');
      meta.className = 'track-meta';
      const name = document.createElement('div');
      name.className = 'track-name';
      name.textContent = track.name;
      const sub = document.createElement('div');
      sub.className = 'track-sub';
      sub.textContent = `${(track.artist || []).join(' / ')} — ${track.album || ''}`;
      meta.append(name, sub);

      const actions = document.createElement('div');
      actions.className = 'track-actions';
      const playBtn = document.createElement('button');
      playBtn.className = 'icon-btn';
      playBtn.textContent = '▶';
      playBtn.title = '立即播放（同步给房间）';
      playBtn.onclick = (e) => {
        e.stopPropagation();
        this.onPick(track);
      };
      const addBtn = document.createElement('button');
      addBtn.className = 'icon-btn';
      addBtn.textContent = '+';
      addBtn.title = '加入播放队列';
      addBtn.onclick = (e) => {
        e.stopPropagation();
        this.onAdd(track);
      };
      actions.append(playBtn, addBtn);

      li.append(img, meta, actions);
      li.onclick = () => this.onPick(track);
      this.listEl.appendChild(li);
    });

    // 元素已入 DOM，现在才能判断是否在可视区域内
    this._loadVisibleCovers();
  }
}
