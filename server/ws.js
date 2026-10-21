/**
 * 极简 WebSocket 服务端实现（RFC 6455）
 *
 * 为什么自己实现而不直接用 `ws`：
 * 让整个项目**零运行时依赖**，用户只需装 Node.js 就能启动，
 * 不需要 npm / pnpm，也不需要联网装包。
 *
 * 只实现本项目需要的部分：
 * - 文本帧的收发（JSON）
 * - 客户端 ping / pong 保活
 * - 关闭握手
 *
 * 不支持：二进制帧、分片（continuation）、压缩（permessage-deflate）。
 * 本项目只发送小于 64KB 的 JSON 文本消息，够用。
 */
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** opcode */
const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

/** 单条消息最大字节数 */
const MAX_MESSAGE_BYTES = 1 << 20; // 1MB

/**
 * WebSocket 连接
 * 事件：message(text), close(code, reason), error(err), pong()
 */
export class WebSocketConnection extends EventEmitter {
  constructor(socket, request) {
    super();
    this.socket = socket;
    this.request = request;
    this.readyState = 1; // OPEN
    this._buffer = Buffer.alloc(0);
    this._fragments = [];
    this._fragmentOpcode = 0;

    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => this._onClose(1006, 'socket closed'));
    socket.on('error', (err) => {
      this.emit('error', err);
      this._onClose(1006, err?.message || 'socket error');
    });
  }

  /** 发送文本消息 */
  send(text) {
    if (this.readyState !== 1) return false;
    const payload = Buffer.from(String(text), 'utf8');
    return this._sendFrame(OP_TEXT, payload);
  }

  ping() {
    if (this.readyState !== 1) return false;
    return this._sendFrame(OP_PING, Buffer.alloc(0));
  }

  close(code = 1000, reason = '') {
    if (this.readyState !== 1) return;
    const reasonBuf = Buffer.from(String(reason), 'utf8');
    const payload = Buffer.alloc(2 + reasonBuf.length);
    payload.writeUInt16BE(code, 0);
    reasonBuf.copy(payload, 2);
    this._sendFrame(OP_CLOSE, payload);
    // 注意：这里不要把 readyState 直接置为 3，
    // 否则 _onClose 里的 `readyState === 3` 判断会提前 return，
    // 导致 close 事件不触发（房间成员不会被清理）。
    this.readyState = 2; // CLOSING
    // 给对方一点时间收到关闭帧
    setTimeout(() => {
      try {
        this.socket.end();
      } catch {
        /* ignore */
      }
      this._onClose(code, reason);
    }, 50);
  }

  terminate() {
    try {
      this.socket.destroy();
    } catch {
      /* ignore */
    }
    this._onClose(1006, 'terminated');
  }

  _sendFrame(opcode, payload) {
    try {
      const len = payload.length;
      let header;
      if (len < 126) {
        header = Buffer.alloc(2);
        header[1] = len;
      } else if (len < 65536) {
        header = Buffer.alloc(4);
        header[1] = 126;
        header.writeUInt16BE(len, 2);
      } else {
        header = Buffer.alloc(10);
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(len), 2);
      }
      // 首字节：FIN(0x80) | opcode(低 4 位)
      header[0] = 0x80 | (opcode & 0x0f);
      // 服务端 → 客户端不需要掩码（掩码位保持 0）
      this.socket.write(Buffer.concat([header, payload]));
      return true;
    } catch (err) {
      this.emit('error', err);
      return false;
    }
  }

  _onData(chunk) {
    this._buffer = this._buffer.length ? Buffer.concat([this._buffer, chunk]) : chunk;
    while (this._buffer.length >= 2) {
      const b0 = this._buffer[0];
      const b1 = this._buffer[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;

      if (len === 126) {
        if (this._buffer.length < 4) return;
        len = this._buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this._buffer.length < 10) return;
        const big = this._buffer.readBigUInt64BE(2);
        if (big > BigInt(MAX_MESSAGE_BYTES)) {
          this.close(1009, 'message too large');
          return;
        }
        len = Number(big);
        offset = 10;
      }

      let maskKey = null;
      if (masked) {
        if (this._buffer.length < offset + 4) return;
        maskKey = this._buffer.subarray(offset, offset + 4);
        offset += 4;
      }

      if (this._buffer.length < offset + len) return; // 数据还没收全
      const payload = Buffer.from(this._buffer.subarray(offset, offset + len));
      this._buffer = this._buffer.subarray(offset + len);

      if (maskKey) {
        for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
      }

      this._handleFrame(fin, opcode, payload);
      if (this.readyState !== 1) return;
    }
  }

  _handleFrame(fin, opcode, payload) {
    switch (opcode) {
      case OP_PING:
        this._sendFrame(OP_PONG, payload);
        break;
      case OP_PONG:
        this.emit('pong');
        break;
      case OP_CLOSE: {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
        // 按 RFC 6455，收到关闭帧后必须回一个关闭帧。
        // 对方没带状态码（空载荷）时回 1000，让对端看到正常关闭。
        if (this.readyState === 1) {
          // 置为 CLOSING(2) 而不是 CLOSED(3)：_onClose 遇到 3 会提前 return，
          // 那样 close 事件就不会触发（房间成员不会被清理）。
          this.readyState = 2; // CLOSING
          const echo = payload.length >= 2 ? payload : Buffer.from([0x03, 0xe8]); // 1000
          this._sendFrame(OP_CLOSE, echo);
        }
        try {
          this.socket.end();
        } catch {
          /* ignore */
        }
        this._onClose(code, reason);
        break;
      }
      case OP_TEXT:
      case OP_BINARY:
        if (fin) {
          this._deliver(opcode, payload);
        } else {
          this._fragmentOpcode = opcode;
          this._fragments = [payload];
        }
        break;
      case OP_CONT:
        this._fragments.push(payload);
        if (fin) {
          const full = Buffer.concat(this._fragments);
          this._fragments = [];
          this._deliver(this._fragmentOpcode, full);
        }
        break;
      default:
        this.close(1002, 'unknown opcode');
    }
  }

  _deliver(opcode, payload) {
    if (opcode === OP_BINARY) {
      this.emit('message', payload);
      return;
    }
    let text;
    try {
      text = payload.toString('utf8');
    } catch {
      return;
    }
    this.emit('message', text);
  }

  _onClose(code, reason) {
    // 已经是 CLOSED 就不要重复触发
    if (this.readyState === 3) return;
    this.readyState = 3; // CLOSED
    this.emit('close', code, reason);
  }
}

/**
 * WebSocket 服务端
 * 事件：connection(conn, request), error(err)
 */
export class WebSocketServer extends EventEmitter {
  /**
   * @param {{server: import('node:http').Server, path?: string}} options
   */
  constructor({ server, path = '/ws' } = {}) {
    super();
    this.path = path;
    this.clients = new Set();
    this.server = server;

    server.on('upgrade', (req, socket, head) => {
      this._handleUpgrade(req, socket, head);
    });
  }

  _handleUpgrade(req, socket, head) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname !== this.path) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    const key = req.headers['sec-websocket-key'];
    const upgrade = String(req.headers.upgrade || '').toLowerCase();
    if (upgrade !== 'websocket' || !key) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    const accept = crypto
      .createHash('sha1')
      .update(key + GUID)
      .digest('base64');

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n` +
        '\r\n'
    );
    socket.setNoDelay(true);

    const conn = new WebSocketConnection(socket, req);
    this.clients.add(conn);
    conn.on('close', () => this.clients.delete(conn));
    if (head?.length) conn._onData(head);

    this.emit('connection', conn, req);
  }

  /** 广播 */
  broadcast(text) {
    for (const c of this.clients) c.send(text);
  }

  /** 关闭所有连接并停止服务 */
  close(cb) {
    for (const c of this.clients) {
      try {
        c.terminate();
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
    this.server.close(cb);
  }
}

export default WebSocketServer;
