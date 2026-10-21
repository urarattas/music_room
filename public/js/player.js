/**
 * 同步播放器：与服务端播放状态对齐
 *
 * 播放地址由**每个客户端独立**向上游获取：
 * 服务端广播的曲目里只有 ID 与元数据，没有 url，
 * 收到后本客户端自己去 GD 音乐台拿直链，再从上游 CDN 直接拉流。
 */
import { gdApi } from './gd-api.js';

export class MusicPlayer extends EventTarget {
  constructor({ client, audioEl, quality = 320 }) {
    super();
    this.client = client;
    this.audio = audioEl;
    /** 请求音质（kbps） */
    this.quality = quality;
    this.state = {
      track: null,
      playing: false,
      pos: 0,
      startAt: 0,
      volume: 1,
    };
    /** 曲目总时长，单位 ms（与 state.pos 保持一致） */
    this.duration = 0;
    this._lastTrackId = null;
    this._correctTimer = null;
    this._seekingByUser = false;
    this._crossOriginTried = true;
    /** 当前加载的播放地址 */
    this._url = null;
    /** 取地址的令牌，用于丢弃过期请求 */
    this._loadToken = 0;

    this.audio.volume = this.state.volume;
    this.audio.preload = 'auto';

    this.audio.addEventListener('loadedmetadata', () => {
      // audio.duration 单位是秒，统一换算成毫秒
      this.duration = Math.max(0, Math.round((this.audio.duration || 0) * 1000));
      this.emit('duration', this.duration);
      this._applyPosition(true);
    });
    this.audio.addEventListener('timeupdate', () => {
      this.emit('time', this.audio.currentTime * 1000);
    });
    this.audio.addEventListener('ended', () => {
      this.client.send('playlist.next', {});
    });
    this.audio.addEventListener('error', () => {
      // 跨域/CORS 或地址失效
      if (this._crossOriginTried) {
        this._crossOriginTried = false;
        this.audio.removeAttribute('crossorigin');
        this.audio.load();
        this._applyPosition(true);
      } else {
        // 地址可能已过期，重新取一次
        this.emit('error', { msg: '音频播放失败，正在重新获取播放地址' });
        this._loadTrack(this.state.track, { force: true });
      }
    });

    this._correctTimer = setInterval(() => this.correct(), 2000);
  }

  emit(name, detail) {
    this.dispatchEvent(new CustomEvent(name, { detail }));
  }

  on(name, handler) {
    this.addEventListener(name, (e) => handler(e.detail));
    return this;
  }

  /** 更新当前曲目（不改变播放状态） */
  setTrack(track) {
    this.state.track = track;
    this.emit('state', this.state);
  }

  /** 服务端状态下发 */
  applyServerState(state) {
    if (!state) return;
    const prev = this.state;
    const trackChanged =
      (state.track?.id ?? null) !== (prev.track?.id ?? null) ||
      (state.track?.source ?? null) !== (prev.track?.source ?? null);

    this.state = {
      track: state.track ?? null,
      playing: !!state.playing,
      pos: state.pos ?? 0,
      startAt: state.startAt ?? 0,
      volume: state.volume ?? 1,
    };
    this.audio.volume = Math.min(1, Math.max(0, this.state.volume));

    if (trackChanged) {
      // 曲目变了：本客户端独立去取播放地址
      this._loadTrack(this.state.track);
      if (this.state.playing) {
        // 等地址取到后再播放
        this._playWhenReady();
      }
      this.emit('state', this.state);
      return;
    }

    if (this.state.playing) {
      this.audio.play().catch(() => {
        // 自动播放被拦截：等待用户交互
        this.emit('blocked', {});
      });
      this._applyPosition(true);
    } else {
      this.audio.pause();
      this._applyPosition(true);
    }
    this.emit('state', this.state);
  }

  /** 等待播放地址就绪后开始播放 */
  async _playWhenReady() {
    const key = this._keyOf(this.state.track);
    // 最多等待 15 秒
    const deadline = Date.now() + 15000;
    while (this._lastLoadedKey !== key && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 120));
    }
    if (this._lastLoadedKey !== key || !this._url) return;
    try {
      await this.audio.play();
      this._applyPosition(true);
    } catch {
      this.emit('blocked', {});
    }
  }

  /**
   * 加载曲目。
   *
   * 服务端广播的 track 只有 ID 与元数据，没有播放地址，
   * 这里由本客户端独立向上游取地址，然后直接从上游 CDN 播放。
   */
  async _loadTrack(track, { force = false } = {}) {
    const token = ++this._loadToken;
    this._lastTrackId = track?.id ?? null;

    if (!track) {
      this.audio.pause();
      this.audio.removeAttribute('src');
      this.audio.load();
      this.emit('track', null);
      return;
    }
    this.emit('track', track);

    // 已经是同一条地址且未强制刷新，无需重复请求
    if (!force && this._url && this._lastLoadedKey === this._keyOf(track)) {
      this.audio.src = this._url;
      this.audio.crossOrigin = 'anonymous';
      this.audio.load();
      return;
    }

    // 切歌时先停掉旧音源，避免新地址取不到时还在放上一首
    if (!force) {
      this.audio.pause();
      this.audio.removeAttribute('src');
      this._url = null;
      this._lastLoadedKey = null;
    }

    this.emit('loading', { track, loading: true });
    try {
      const { url, br, size } = await gdApi.getTrackUrl({
        source: track.source || 'netease',
        id: track.id,
        br: this.quality,
      });
      // 请求期间已切歌 → 丢弃结果
      if (token !== this._loadToken) return;
      this._url = url;
      this._lastLoadedKey = this._keyOf(track);
      this.audio.src = url;
      this.audio.crossOrigin = 'anonymous';
      this.audio.load();
      this.emit('loaded', { track, url, br, size });
    } catch (err) {
      if (token !== this._loadToken) return;
      this.emit('loading', { track, loading: false });
      this.emit('error', { msg: err?.message || '获取播放地址失败' });
    }
  }

  _keyOf(track) {
    return `${track?.source ?? 'netease'}:${track?.id ?? ''}`;
  }

  /** 重新获取当前曲目的播放地址（例如切换音质后） */
  reload() {
    if (!this.state.track) return;
    this._url = null;
    this._lastLoadedKey = null;
    this._loadTrack(this.state.track, { force: true });
    if (this.state.playing) this._playWhenReady();
  }

  /** 期望位置（ms） */
  expectedPos() {
    const { playing, startAt, pos } = this.state;
    if (!playing) return pos;
    return Math.max(0, this.client.serverNow() - startAt);
  }

  currentPos() {
    if (this.audio.readyState > 0 && !this.audio.paused && this.audio.currentTime > 0) {
      return this.audio.currentTime * 1000;
    }
    return this.expectedPos();
  }

  _applyPosition(force = false) {
    const target = this.expectedPos() / 1000;
    if (!Number.isFinite(target)) return;
    if (force || Math.abs(this.audio.currentTime - target) > 0.25) {
      try {
        this.audio.currentTime = target;
      } catch {
        /* 尚未加载 */
      }
    }
  }

  /** 周期性校正漂移 */
  correct() {
    if (!this.state.track || !this.state.playing) return;
    if (this.audio.paused) {
      this.audio.play().catch(() => {});
      return;
    }
    const expected = this.expectedPos() / 1000;
    const diff = this.audio.currentTime - expected;
    if (Math.abs(diff) > 0.35) {
      this._applyPosition(true);
      this.emit('desync', { diff });
    }
  }

  play() {
    if (!this.state.track) return;
    this.client.send('music.play', { track: this.state.track, pos: this.currentPos() });
  }

  pause() {
    this.client.send('music.pause', {});
  }

  toggle() {
    if (this.state.playing) this.pause();
    else this.play();
  }

  seek(ms) {
    this.client.send('music.seek', { pos: Math.max(0, Number(ms) || 0) });
  }

  setVolume(v) {
    this.client.send('music.volume', { v: Math.min(1, Math.max(0, Number(v) || 0)) });
  }

  destroy() {
    clearInterval(this._correctTimer);
  }
}
