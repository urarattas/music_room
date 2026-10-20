/**
 * 端到端联调测试：启动服务端 + 两个 WebSocket 客户端
 * 运行：node --test test/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 34567;
const BASE = `http://127.0.0.1:${PORT}`;

let child;

function waitForHealth(timeoutMs = 20000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const res = await fetch(`${BASE}/api/health`);
        if (res.ok) return resolve();
      } catch {
        /* retry */
      }
      if (Date.now() - start > timeoutMs) return reject(new Error('server did not start'));
      setTimeout(tick, 300);
    };
    tick();
  });
}

class TestClient {
  constructor(name, room) {
    this.name = name;
    this.room = room;
    this.messages = [];
    this.waiters = [];
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
      this.ws.on('open', () => {
        this.send('join', { room: this.room, name: this.name });
        resolve();
      });
      this.ws.on('error', reject);
      this.ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        this.messages.push(msg);
        for (const w of [...this.waiters]) {
          if (w.match(msg)) {
            this.waiters.splice(this.waiters.indexOf(w), 1);
            w.resolve(msg);
          }
        }
      });
    });
  }

  send(t, payload = {}) {
    this.ws.send(JSON.stringify({ t, ...payload }));
  }

  waitFor(match, timeoutMs = 8000) {
    const existing = this.messages.find(match);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const w = { match, resolve };
      this.waiters.push(w);
      setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) {
          this.waiters.splice(i, 1);
          reject(new Error('timeout waiting for message'));
        }
      }, timeoutMs);
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

test.before(async () => {
  child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore',
  });
  await waitForHealth();
});

test.after(() => {
  child?.kill();
});

test('HTTP 静态页与健康检查可用', async () => {
  const res = await fetch(`${BASE}/`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /音乐听歌房/);

  const health = await (await fetch(`${BASE}/api/health`)).json();
  assert.equal(health.ok, true);
});

test('HTTP 搜索代理返回曲目列表', async () => {
  const res = await fetch(`${BASE}/api/search?name=${encodeURIComponent('周杰伦')}&count=3&source=netease`);
  assert.equal(res.status, 200);
  const { list } = await res.json();
  assert.ok(Array.isArray(list) && list.length > 0, '应返回至少一条搜索结果');
  assert.ok(list[0].id);
  assert.ok(Array.isArray(list[0].artist));
});

test('房间：加入、成员广播、聊天', async () => {
  const a = new TestClient('甲', 'test-room');
  const b = new TestClient('乙', 'test-room');
  await a.connect();
  await b.connect();

  const welcome = await a.waitFor((m) => m.t === 'welcome');
  assert.equal(welcome.room.id, 'test-room');
  assert.ok(welcome.selfId);

  // b 加入后，a 应收到 users 广播（2 人）
  const usersMsg = await a.waitFor((m) => m.t === 'users' && m.users.length === 2);
  assert.equal(usersMsg.users.length, 2);

  // 聊天
  a.send('chat', { text: '你好' });
  const chat = await b.waitFor((m) => m.t === 'chat' && m.text === '你好');
  assert.equal(chat.from.name, '甲');

  a.close();
  b.close();
});

test('播放状态在房间内同步', async () => {
  const a = new TestClient('甲', 'sync-room');
  const b = new TestClient('乙', 'sync-room');
  await a.connect();
  await b.connect();
  await a.waitFor((m) => m.t === 'welcome');
  await b.waitFor((m) => m.t === 'welcome');

  a.send('music.play', {
    track: { id: '5257138', name: '屋顶', artist: ['周杰伦'], album: '测试', source: 'netease', pic_id: '109951165671182684' },
    pos: 0,
  });

  const music = await b.waitFor((m) => m.t === 'music' && m.state.track?.id === '5257138', 20000);
  assert.equal(music.state.playing, true);
  assert.ok(music.state.track.url, '服务端应补全播放地址');
  assert.equal(music.state.track.source, 'netease');

  // 暂停同步
  a.send('music.pause', {});
  const paused = await b.waitFor((m) => m.t === 'music' && m.state.playing === false);
  assert.equal(paused.state.playing, false);

  // 播放列表同步
  const pl = await b.waitFor((m) => m.t === 'playlist' && m.list.length > 0);
  assert.equal(pl.list[0].id, '5257138');

  a.close();
  b.close();
});

test('信令消息在成员之间中转', async () => {
  const a = new TestClient('甲', 'rtc-room');
  const b = new TestClient('乙', 'rtc-room');
  await a.connect();
  await b.connect();
  const wa = await a.waitFor((m) => m.t === 'welcome');
  await b.waitFor((m) => m.t === 'welcome');
  const wb = await b.waitFor((m) => m.t === 'welcome');

  a.send('rtc.signal', { to: wb.selfId, data: { type: 'offer', sdp: 'v=0-test' } });
  const sig = await b.waitFor((m) => m.t === 'signal');
  assert.equal(sig.data.type, 'offer');
  assert.equal(sig.data.sdp, 'v=0-test');
  assert.equal(sig.from, wa.selfId);

  a.close();
  b.close();
});

test('麦克风状态广播', async () => {
  const a = new TestClient('甲', 'mic-room');
  const b = new TestClient('乙', 'mic-room');
  await a.connect();
  await b.connect();
  await a.waitFor((m) => m.t === 'welcome');
  await b.waitFor((m) => m.t === 'welcome');

  a.send('rtc.mic', { on: true });
  const mic = await b.waitFor((m) => m.t === 'mic' && m.on === true);
  assert.equal(mic.on, true);

  a.close();
  b.close();
});

test('切换房间：离开旧房间并加入新房间', async () => {
  const a = new TestClient('甲', 'old-room');
  const b = new TestClient('乙', 'old-room');
  await a.connect();
  await b.connect();
  await a.waitFor((m) => m.t === 'welcome');
  await b.waitFor((m) => m.t === 'welcome');
  await a.waitFor((m) => m.t === 'users' && m.users.length === 2);

  // 甲切到新房间
  a.send('join', { room: 'new-room', name: '甲' });
  const welcome = await a.waitFor((m) => m.t === 'welcome' && m.room.id === 'new-room');
  assert.equal(welcome.room.id, 'new-room');
  assert.equal(welcome.users.length, 1, '新房间里只有自己');

  // 旧房间只剩乙
  const users = await b.waitFor((m) => m.t === 'users' && m.users.length === 1);
  assert.equal(users.users.length, 1);

  a.close();
  b.close();
});

test('封面接口可用并返回图片', async () => {
  const res = await fetch(`${BASE}/img/pic?source=netease&id=109951163038292176&size=300`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /image/);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.ok(buf.length > 1000, '封面应有内容');
  // JPEG 魔数
  assert.equal(buf[0], 0xff);
  assert.equal(buf[1], 0xd8);
});

test('歌词接口返回原文与翻译', async () => {
  const res = await fetch(`${BASE}/api/lyric?source=netease&id=451703096`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(data.lyric.includes('['), '应返回 LRC 原文');
  assert.ok(typeof data.tlyric === 'string');
});
