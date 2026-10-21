/** 搜索面板 —— 直接调用 GD 音乐台 API（浏览器直连，不经服务端） */
import { isVisible } from './cover-loader.js';
import { gdApi } from './gd-api.js';

export class SearchPanel {
  constructor({ listEl, formEl, inputEl, sourceEl, statusEl, moreBtn, onPick, onAdd, coverLoader }) {
    this.listEl = listEl;
    this.formEl = formEl;
    this.inputEl = inputEl;
    this.sourceEl = sourceEl;
    this.statusEl = statusEl;
    this.moreBtn = moreBtn || null;
    this.onPick = onPick || (() => {});
    this.onAdd = onAdd || (() => {});
    this.coverLoader = coverLoader || null;
    this.results = [];
    this.page = 1;
    this.query = '';
    this.source = sourceEl?.value || 'netease';
    this.loading = false;

    this.formEl.addEventListener('submit', (e) => {
      e.preventDefault();
      this.search(1);
    });

    // 滚动时补充加载可视区域内的封面
    this.listEl.addEventListener('scroll', () => this._loadVisibleCovers());

    // 加载更多
    this.moreBtn?.addEventListener('click', () => this.search(this.page + 1, { append: true }));
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

  /**
   * 搜索
   * @param {number} pages 页码
   * @param {{append?:boolean}} opts append=true 时把结果追加到已有列表
   */
  async search(pages = 1, { append = false } = {}) {
    const name = this.inputEl.value.trim();
    if (!name) {
      this.statusEl.textContent = '请输入关键字';
      return;
    }
    if (this.loading) return;

    const source = this.sourceEl.value;
    // 查询条件变了就不是"加载更多"，而是新搜索（会替换列表）
    const sameQuery = name === this.query && source === this.source;
    const isNewQuery = !append || !sameQuery;

    this.loading = true;
    this.statusEl.style.color = '';
    this.statusEl.textContent = append ? '加载中…' : '搜索中…';
    this.moreBtn && (this.moreBtn.disabled = true);

    try {
      // 浏览器直连 GD 音乐台 API
      const list = await gdApi.searchTracks({ source, name, count: 30, pages });
      if (isNewQuery) {
        this.results = list || [];
      } else {
        // 去重后追加（上游可能返回重复项）
        const seen = new Set(this.results.map((t) => `${t.source}:${t.id}`));
        for (const t of list || []) {
          const key = `${t.source}:${t.id}`;
          if (!seen.has(key)) {
            this.results.push(t);
            seen.add(key);
          }
        }
      }
      this.page = pages;
      this.query = name;
      this.source = source;

      this.statusEl.textContent = this.results.length
        ? `找到 ${this.results.length} 首`
        : '没有找到相关歌曲';
      this.render();

      // 未满页说明没有更多了
      if (this.moreBtn) {
        this.moreBtn.hidden = !(list && list.length >= 30);
      }

      // 提醒：该音源可能搜得到但播不了（上游部分音源的 url 端点返回空）
      if (this.results.length) this._warnIfUnplayable(source);
    } catch (err) {
      this.statusEl.textContent = `搜索失败：${err.message}`;
      this.statusEl.style.color = 'var(--danger)';
      if (!append) {
        this.results = [];
        this.render();
      }
    } finally {
      this.loading = false;
      if (this.moreBtn) this.moreBtn.disabled = false;
    }
  }

  /** 探测音源是否能播放，有问题则给出提示 */
  async _warnIfUnplayable(source) {
    if (this._probed?.has(source)) return;
    this._probed = this._probed || new Set();
    this._probed.add(source);
    try {
      const { ok, message } = await gdApi.probeSource(source);
      if (!ok) {
        this.statusEl.textContent = `⚠ ${message}`;
        this.statusEl.style.color = 'var(--danger)';
      }
    } catch {
      /* 忽略 */
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
          // 没有加载器时直接取地址（浏览器直连上游）
          gdApi
            .getTrackPic({ source: track.source, id: track.pic_id, size: 300 })
            .then(({ url }) => {
              if (url) img.src = url;
              else img.remove();
            })
            .catch(() => img.remove());
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
