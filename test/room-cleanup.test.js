/**
 * 房间成员清理测试
 *
 * 服务端的 close 事件负责把离开的用户从房间成员列表里移除。
 * 如果 close 事件不触发，连接与房间会一直残留 —— 长期运行就是内存泄漏。
 *
 * 运行：node test/room-cleanup.test.js
 */
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';

const PORT = 34693;
const server = spawn(process.execPath, ['server/index.js'], {
  env: { ...process.env, PORT: String(PORT), LOG_LEVEL: 'error' },
  stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 1500));

const results = [];
const check = (name, ok, extra = '') => {
  results.push(ok);
  console.log(`${ok ? '✔' : '✘'} ${name}${extra ? ` — ${extra}` : ''}`);
};

const health = async () => (await fetch(`http://127.0.0.1:${PORT}/api/health`)).json();

try {
  // --- 正常关闭后应被清理 ---
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  ws.send(JSON.stringify({ t: 'join', room: 'cleanup-test', name: '要离开的人' }));
  await new Promise((r) => setTimeout(r, 500));

  const before = await health();
  check('加入后有 1 个连接', before.connections === 1, String(before.connections));
  check('有 1 个房间', before.rooms === 1, String(before.rooms));

  ws.close();
  await new Promise((r) => setTimeout(r, 1500));

  const after = await health();
  check('关闭后连接被清理', after.connections === 0, String(after.connections));
  check('空房间被回收', after.rooms === 0, String(after.rooms));

  // --- 多个成员：断开一个，其余保留 ---
  const a = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const b = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  await Promise.all(
    [a, b].map(
      (s) =>
        new Promise((resolve, reject) => {
          s.on('open', resolve);
          s.on('error', reject);
        })
    )
  );
  a.send(JSON.stringify({ t: 'join', room: 'multi', name: 'A' }));
  b.send(JSON.stringify({ t: 'join', room: 'multi', name: 'B' }));
  await new Promise((r) => setTimeout(r, 600));

  const both = await health();
  check('两个成员都在', both.connections === 2, String(both.connections));

  a.close();
  await new Promise((r) => setTimeout(r, 1200));

  const one = await health();
  check('断开一个后只剩 1 个连接', one.connections === 1, String(one.connections));
  check('房间仍然存在', one.rooms === 1, String(one.rooms));

  b.close();
  await new Promise((r) => setTimeout(r, 1200));
  const none = await health();
  check('全部离开后房间被回收', none.connections === 0 && none.rooms === 0, JSON.stringify(none));
} catch (err) {
  check('测试执行', false, err.message);
} finally {
  server.kill();
}

const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} 项通过`);
process.exit(failed ? 1 : 0);
