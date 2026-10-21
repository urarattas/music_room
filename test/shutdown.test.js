/**
 * 优雅退出测试
 *
 * 为什么不用真信号：
 * Windows 上 Node 收到信号会直接终止进程（退出码 null + signal），
 * 不走 JS 的 signal handler —— 这是平台限制。
 * Docker 跑在 Linux，那里 handler 会正常生效。
 *
 * 所以这里用 `process.emit('SIGTERM')` 触发 —— 走的是与真信号
 * **完全相同的 handler 代码路径**，可以真正验证退出逻辑。
 *
 * 运行：node --test test/shutdown.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = 34675;

test('SIGTERM 触发优雅退出，退出码为 0', async () => {
  const harness = `
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const ROOT = ${JSON.stringify(ROOT)};
process.chdir(ROOT);
await import(pathToFileURL(path.join(ROOT, 'server', 'index.js')).href);
setTimeout(() => process.emit('SIGTERM'), 2000);
`;

  const child = spawn(process.execPath, ['--input-type=module', '-e', harness], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(PORT) },
  });

  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => process.stderr.write('[err] ' + d));

  const result = await new Promise((resolve) => {
    const t = setTimeout(() => resolve({ code: 'timeout' }), 12000);
    child.on('exit', (code, signal) => {
      clearTimeout(t);
      resolve({ code, signal });
    });
  });

  assert.equal(result.code, 0, `应以 code 0 退出，实际 ${result.code}/${result.signal}`);
  assert.match(out, /已启动/, '应先正常启动');
  assert.match(out, /收到 SIGTERM/, '应输出收到信号的提示');
  assert.match(out, /服务已停止/, '应输出停止完成的提示');
});

test('SIGINT 同样触发优雅退出', async () => {
  const harness = `
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const ROOT = ${JSON.stringify(ROOT)};
process.chdir(ROOT);
await import(pathToFileURL(path.join(ROOT, 'server', 'index.js')).href);
setTimeout(() => process.emit('SIGINT'), 2000);
`;

  const child = spawn(process.execPath, ['--input-type=module', '-e', harness], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(PORT + 1) },
  });

  let out = '';
  child.stdout.on('data', (d) => (out += d));

  const result = await new Promise((resolve) => {
    const t = setTimeout(() => resolve({ code: 'timeout' }), 12000);
    child.on('exit', (code, signal) => {
      clearTimeout(t);
      resolve({ code, signal });
    });
  });

  assert.equal(result.code, 0, `应以 code 0 退出，实际 ${result.code}/${result.signal}`);
  assert.match(out, /收到 SIGINT/);
});

test('退出时会关闭所有 WebSocket 连接', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
  assert.match(src, /conn\.ws\.close\(1001/, '退出时应关闭 WebSocket 连接');
  assert.match(src, /server\.close\(/, '退出时应关闭 HTTP 服务器');
  assert.match(src, /setTimeout\(\(\) => process\.exit\(0\), 3000\)/, '应有超时兜底');
});
