/**
 * 房间 WebSocket 客户端
 * 事件名与 docs/protocol.md 对应
 */
export class RoomClient extends EventTarget {
  constructor({ room = 'lobby', name = '听众', autoJoin = true } = {}) {
    super();
    this.room = room;
    this.name = name;
    this.autoJoin = autoJoin;
    this.ws = null;
    this.connected = false;
    this.selfId = null;
    /** 客户端时钟 -> 服务端时钟 的偏移（ms） */
    this.offsetMs = 0;
    this._pingTimer = null;
    this._pingSentAt = new Map();
    this._reconnectTimer = null;
    this._closedByUser = false;
    this._reconnectDelay = 1000;
  }

  connect() {
    this._closedByUser = false;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}/ws`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.connected = true;
      this._reconnectDelay = 1000;
      this.emit('open');
      if (this.autoJoin) {
        this.send('join', { room: this.room, name: this.name });
      }
      this._startPing();
    });

    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.t === 'welcome') {
        this.selfId = msg.selfId;
      }
      this.emit(msg.t, msg);
      this.emit('*', msg);
    });

    ws.addEventListener('close', () => {
      this.connected = false;
      this._stopPing();
      this.emit('close');
      if (!this._closedByUser) this._scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      this.emit('error', { msg: 'WebSocket 连接错误' });
    });
  }

  _scheduleReconnect() {
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectDelay = Math.min(this._reconnectDelay * 1.6, 15000);
      this.connect();
    }, this._reconnectDelay);
  }

  _startPing() {
    this._stopPing();
    this._pingTimer = setInterval(() => {
      const ts = Date.now();
      this._pingSentAt.set(ts, Date.now());
      this.send('ping', { ts });
    }, 5000);
    // 立即测一次
    const ts = Date.now();
    this._pingSentAt.set(ts, Date.now());
    this.send('ping', { ts });
  }

  _stopPing() {
    clearInterval(this._pingTimer);
    this._pingTimer = null;
  }

  onPong(msg) {
    const sent = this._pingSentAt.get(msg.ts);
    if (sent == null) return;
    this._pingSentAt.delete(msg.ts);
    const rtt = Date.now() - sent;
    const est = msg.serverTime + rtt / 2;
    // 简单平滑，避免抖动
    this.offsetMs = this.offsetMs === 0 ? est - Date.now() : this.offsetMs * 0.7 + (est - Date.now()) * 0.3;
  }

  /** 估算的服务端当前时间 */
  serverNow() {
    return Date.now() + this.offsetMs;
  }

  send(t, payload = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify({ t, ...payload }));
      return true;
    } catch {
      return false;
    }
  }

  emit(name, detail) {
    this.dispatchEvent(new CustomEvent(name, { detail }));
  }

  on(name, handler) {
    const wrapped = (e) => handler(e.detail);
    this._handlers = this._handlers || [];
    this._handlers.push({ name, wrapped });
    this.addEventListener(name, wrapped);
    return this;
  }

  /** 移除所有事件监听（换房间时调用） */
  offAll() {
    for (const { name, wrapped } of this._handlers || []) {
      this.removeEventListener(name, wrapped);
    }
    this._handlers = [];
  }

  /** 移除单个事件的某个监听 */
  off(name, handler) {
    this._handlers = (this._handlers || []).filter((h) => {
      if (h.name !== name) return true;
      if (handler && h.wrapped !== handler) return true;
      this.removeEventListener(name, h.wrapped);
      return false;
    });
    return this;
  }

  close() {
    this._closedByUser = true;
    clearTimeout(this._reconnectTimer);
    this._stopPing();
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }
}
