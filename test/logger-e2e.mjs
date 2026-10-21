// 端到端验证：真实连接/断开是否被记录到日志文件
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';

const PORT = 34691;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-log-e2e-'));

const server = spawn(process.execPath, ['server/index.js'], {
  env: {
    ...process.env,
    PORT: String(PORT),
    LOG_DIR: tmp,
    LOG_LEVEL: 'debug',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
server.stdout.on('data', (d) => (out += d));
server.stderr.on('data', (d) => (out += d));

await new Promise((r) => setTimeout(r, 1500));

const results = [];
const check = (name, ok, extra = '') => {
  results.push(ok);
  console.log(`${ok ? '✔' : '✘'} ${name}${extra ? ` — ${extra}` : ''}`);
};

// 连接并加入房间
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
await new Promise((resolve, reject) => {
  ws.on('open', resolve);
  ws.on('error', reject);
});
check('WebSocket 连接成功', true);

ws.send(JSON.stringify({ t: 'join', room: 'e2e', name: '测试员' }));
await new Promise((r) => setTimeout(r, 800));

// 发一条消息
ws.send(JSON.stringify({ t: 'chat', text: '日志测试消息' }));
await new Promise((r) => setTimeout(r, 500));

// 断开
ws.close();
await new Promise((r) => setTimeout(r, 1200));

// 读取日志文件
const files = fs.readdirSync(tmp);
check('生成了日志文件', files.length > 0, files.join(', '));
const file = path.join(tmp, files.find((f) => f.endsWith('.log')));
const text = fs.readFileSync(file, 'utf8');

console.log('\n--- 日志内容 ---');
console.log(text.trim());
console.log('----------------\n');

check('记录了连接建立', text.includes('WebSocket 连接建立'));
check('记录了加入房间', text.includes('成员加入房间'));
check('记录了成员名与房间名', text.includes('测试员') && text.includes('e2e'));
check('记录了聊天消息', text.includes('收到聊天消息'));
check('记录了连接断开', text.includes('WebSocket 连接断开'));
check('记录了服务启动', text.includes('服务已启动'));
check('包含客户端 IP', /\d+\.\d+\.\d+\.\d+/.test(text), '应记录来源 IP');
check('每行都有时间戳', text.trim().split('\n').every((l) => /^\[\d{4}-\d{2}-\d{2} /.test(l)));

server.kill();
fs.rmSync(tmp, { recursive: true, force: true });

const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} 项通过`);
process.exit(failed ? 1 : 0);
