/**
 * 同步播放器：与服务端播放状态对齐
 */
export class MusicPlayer extends EventTarget {
  constructor({ client, audioEl }) {
    super();
    this.client = client;
    this.audio = audioEl;
    this.state = {
      track: null,
      playing: false,
      pos: 0,
      startAt: 0,
      volume: 1,
    };
    this.duration = 0;
    this._lastTrackId = null;
    this._correctTimer = null;
    this._seekingByUser = false;
    this._crossOriginTried = true;

    this.audio.volume = this.state.volume;
    this.audio.preload = 'auto';

    this.audio.addEventListener('loadedmetadata', () => {
      this.duration = this.audio.duration || 0;
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
        this.emit('error', { msg: '音频播放失败，尝试刷新播放地址' });
        this.client.send('music.play', { track: this.state.track, pos: this.currentPos() });
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
      this._loadTrack(this.state.track);
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

  _loadTrack(track) {
    this._lastTrackId = track?.id ?? null;
    if (!track) {
      this.audio.pause();
      this.audio.removeAttribute('src');
      this.audio.load();
      this.emit('track', null);
      return;
    }
    this.emit('track', track);
    if (!track.url) {
      this.emit('error', { msg: '该曲目暂无可用播放地址' });
      return;
    }
    this.audio.src = track.url;
    this.audio.crossOrigin = 'anonymous';
    this.audio.load();
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
