/**
 * 自研 WebSocket 服务端（server/ws.js）协议测试
 * 运行：node --test test/websocket.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocketServer } from '../server/ws.js';
import { WebSocket } from 'ws';

function startServer() {
  const server = http.createServer((req, res) => res.end('ok'));
  const wss = new WebSocketServer({ server, path: '/ws' });
  return { server, wss };
}

test('握手成功并能双向收发', async () => {
  const { server, wss } = startServer();
  await new Promise((r) => server.listen(34598, '127.0.0.1', r));

  wss.on('connection', (conn) => {
    conn.on('message', (text) => {
      const m = JSON.parse(text);
      if (m.t === 'hello') conn.send(JSON.stringify({ t: 'ack' }));
    });
  });

  const received = [];
  await new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:34598/ws');
    const timer = setTimeout(() => reject(new Error('超时')), 5000);

    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello' })));
    ws.on('message', (data) => {
      const m = JSON.parse(data.toString());
      received.push(m.t);
      if (m.t === 'ack') {
        clearTimeout(timer);
        ws.close();
        resolve();
      }
    });
    ws.on('error', (e) => reject(e));
  });

  assert.deepEqual(received, ['ack']);
  wss.close();
});

test('支持大消息（>64KB 走 127 长度分支）', async () => {
  const { server, wss } = startServer();
  await new Promise((r) => server.listen(34597, '127.0.0.1', r));

  wss.on('connection', (conn) => {
    conn.on('message', (text) => {
      const m = JSON.parse(text);
      if (m.t === 'big') conn.send(JSON.stringify({ t: 'from-server', text: m.text }));
    });
  });

  const big = 'x'.repeat(200000);
  const got = await new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:34597/ws');
    const timer = setTimeout(() => reject(new Error('超时')), 5000);
    ws.on('open', () => ws.send(JSON.stringify({ t: 'big', text: big })));
    ws.on('message', (data) => {
      const m = JSON.parse(data.toString());
      clearTimeout(timer);
      resolve(m.text);
    });
    ws.on('error', (e) => reject(e));
  });

  assert.equal(got.length, big.length);
  assert.equal(got, big);
  wss.close();
});

test('服务端可主动推送消息', async () => {
  const { server, wss } = startServer();
  await new Promise((r) => server.listen(34596, '127.0.0.1', r));

  const got = await new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:34596/ws');
    const timer = setTimeout(() => reject(new Error('超时')), 5000);
    ws.on('open', () => setTimeout(() => wss.broadcast('push'), 100));
    ws.on('message', (data) => {
      clearTimeout(timer);
      resolve(data.toString());
    });
    ws.on('error', (e) => reject(e));
  });

  assert.equal(got, 'push');
  wss.close();
});

test('关闭握手正常（code 1000）', async () => {
  const { server, wss } = startServer();
  await new Promise((r) => server.listen(34595, '127.0.0.1', r));

  const code = await new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:34595/ws');
    const timer = setTimeout(() => reject(new Error('超时')), 5000);
    ws.on('open', () => ws.close());
    ws.on('close', (c) => {
      clearTimeout(timer);
      resolve(c);
    });
    ws.on('error', (e) => reject(e));
  });

  assert.equal(code, 1000);
  wss.close();
});

test('非 /ws 路径的升级请求被拒绝', async () => {
  const { server, wss } = startServer();
  await new Promise((r) => server.listen(34594, '127.0.0.1', r));

  const ws = new WebSocket('ws://127.0.0.1:34594/wrong');
  await new Promise((resolve) => {
    ws.on('error', () => resolve());
    ws.on('open', () => resolve(new Error('不应连接成功')));
  });
  wss.close();
});

test('服务端响应 ping（保活）', async () => {
  const { server, wss } = startServer();
  await new Promise((r) => server.listen(34593, '127.0.0.1', r));

  const ponged = await new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:34593/ws');
    const timer = setTimeout(() => reject(new Error('超时')), 5000);
    ws.on('open', () => ws.ping());
    ws.on('pong', () => {
      clearTimeout(timer);
      resolve(true);
    });
    ws.on('error', (e) => reject(e));
  });

  assert.equal(ponged, true);
  wss.close();
});

test('客户端主动关闭时，服务端会触发 close 事件', async () => {
  // 这个行为很关键：服务端的 close 事件负责清理房间成员。
  // 如果 close 事件不触发，离开房间的用户会一直残留在成员列表里。
  const { server, wss } = startServer();
  await new Promise((r) => server.listen(34592, '127.0.0.1', r));

  const serverClosed = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('服务端未收到 close 事件')), 6000);
    wss.on('connection', (conn) => {
      conn.on('close', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    const ws = new WebSocket('ws://127.0.0.1:34592/ws');
    ws.on('open', () => setTimeout(() => ws.close(), 200));
    ws.on('error', reject);
  });

  assert.ok(typeof serverClosed === 'number', '服务端应收到带退出码的 close 事件');
  wss.close();
});

test('服务端主动关闭连接时，也会触发 close 事件', async () => {
  const { server, wss } = startServer();
  await new Promise((r) => server.listen(34591, '127.0.0.1', r));

  const serverClosed = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('服务端未收到 close 事件')), 6000);
    wss.on('connection', (conn) => {
      conn.on('close', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
      setTimeout(() => conn.close(1001, 'bye'), 200);
    });
    const ws = new WebSocket('ws://127.0.0.1:34591/ws');
    ws.on('error', () => {});
  });

  assert.equal(serverClosed, 1001);
  wss.close();
});
