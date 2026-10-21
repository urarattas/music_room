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

/**
 * 请求上游 API 并对 503 做退避重试。
 * 上游限流 50 次/5 分钟，且 503 是间歇性的，重试可让测试稳定。
 */
async function fetchUpstream(path, { retries = 4 } = {}) {
  let lastStatus = 0;
  for (let i = 0; i <= retries; i++) {
    const res = await fetch(`https://music-api.gdstudio.xyz/api.php${path}`, {
      headers: { Origin: BASE },
    });
    lastStatus = res.status;
    if (res.status !== 503) return res;
    await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
  }
  return new Response('', { status: lastStatus });
}

test('HTTP 静态页与健康检查可用', async () => {
  const res = await fetch(`${BASE}/`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /音乐听歌房/);

  const health = await (await fetch(`${BASE}/api/health`)).json();
  assert.equal(health.ok, true);
  // 告知客户端上游地址，供浏览器直连
  assert.match(health.upstream, /music-api\.gdstudio\.xyz/);
});

test('服务端不再代理音乐 API', async () => {
  // 这些接口已移除，应全部返回 404
  for (const p of [
    '/api/search?name=test',
    '/api/url?id=1',
    '/api/lyric?id=1',
    '/api/pic?id=1',
    '/img/pic?id=1',
  ]) {
    const res = await fetch(`${BASE}${p}`);
    assert.equal(res.status, 404, `${p} 应返回 404`);
  }
});

test('上游 API 支持浏览器跨域直连', async () => {
  const res = await fetchUpstream('?types=search&source=netease&name=%E5%91%A8%E6%9D%B0%E4%BC%A6&count=3&pages=1');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), '*', '上游必须允许跨域');
  const list = await res.json();
  assert.ok(Array.isArray(list) && list.length > 0);
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
  assert.equal(music.state.track.source, 'netease');
  // 服务端只广播 ID 与元数据，不应包含播放地址
  assert.equal(music.state.track.url, undefined, '服务端不应广播播放地址');
  assert.ok(music.state.track.id, '应广播曲目 ID');
  assert.ok(music.state.track.name, '应广播曲目名称');

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

test('每个客户端可独立从上游获取播放地址', async () => {
  // 模拟两个客户端各自直连上游取地址
  const fetchUrl = async (br) => {
    const res = await fetchUpstream(`?types=url&source=netease&id=5257138&br=${br}`);
    assert.equal(res.status, 200, '上游应正常响应');
    return res.json();
  };
  const a = await fetchUrl(320);
  const b = await fetchUrl(128);
  assert.ok(a.url, '应能取到播放地址');
  assert.ok(b.url, '应能取到播放地址');
  // 两个客户端可以选不同音质
  assert.equal(a.br, 320);
  assert.equal(b.br, 128);
});

test('上游歌词接口返回原文与翻译', async () => {
  const res = await fetchUpstream('?types=lyric&source=netease&id=451703096');
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(data.lyric.includes('['), '应返回 LRC 原文');
  assert.ok(typeof data.tlyric === 'string');
});

test('新成员加入时补发历史聊天记录', async () => {
  const a = new TestClient('甲', 'hist-room');
  await a.connect();
  await a.waitFor((m) => m.t === 'welcome');

  a.send('chat', { text: '第一条消息' });
  a.send('chat', { text: '第二条消息' });
  await a.waitFor((m) => m.t === 'chat' && m.text === '第二条消息');

  // 迟到的成员应收到之前的历史
  const b = new TestClient('乙', 'hist-room');
  await b.connect();
  await b.waitFor((m) => m.t === 'welcome');

  const first = await b.waitFor((m) => m.t === 'chat' && m.text === '第一条消息');
  const second = await b.waitFor((m) => m.t === 'chat' && m.text === '第二条消息');
  assert.ok(first.ts <= second.ts, '历史记录应按时间顺序补发');

  a.close();
  b.close();
});

test('切换房间时不补发旧房间的聊天记录', async () => {
  const a = new TestClient('甲', 'room-a');
  await a.connect();
  await a.waitFor((m) => m.t === 'welcome');
  a.send('chat', { text: '房间A的消息' });
  await a.waitFor((m) => m.t === 'chat' && m.text === '房间A的消息');

  // 切到新房间
  a.send('join', { room: 'room-b', name: '甲' });
  await a.waitFor((m) => m.t === 'welcome' && m.room.id === 'room-b');
  // 之后不应再收到旧房间的消息
  await new Promise((r) => setTimeout(r, 300));
  const oldMsgs = a.messages.filter((m) => m.t === 'chat' && m.text === '房间A的消息');
  assert.equal(oldMsgs.length, 1, '旧房间消息只应出现一次');

  a.close();
});
