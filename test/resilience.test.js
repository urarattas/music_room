/**
 * 降级行为测试：上游不可用时应用仍应正常工作
 *
 * 用一个**必定返回 503 的本地上游**来模拟故障，
 * 这样无论真实 GD 音乐台是否可用，测试结果都是确定的。
 *
 * 运行：node test/resilience.test.js
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = 34730;
const MOCK_PORT = 34731;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, ok, extra = '') => {
  results.push(ok);
  console.log(`${ok ? '✔' : '✘'} ${name}${extra ? ` — ${extra}` : ''}`);
};

/* ---------------- 必定失败的模拟上游 ---------------- */

const brokenUpstream = http.createServer((req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', '*');
  if (req.method === 'OPTIONS') return res.writeHead(204).end();
  // 模拟上游被限流 / 不可用
  res.writeHead(503, { 'content-type': 'text/plain' });
  res.end('Service Unavailable');
});
await new Promise((r) => brokenUpstream.listen(MOCK_PORT, '127.0.0.1', r));

/* -------- 复制项目并把上游指向必定失败的模拟服务器 -------- */

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'mr-resilience-'));
await fsp.cp(path.join(ROOT, 'public'), path.join(tmp, 'public'), { recursive: true });
await fsp.cp(path.join(ROOT, 'server'), path.join(tmp, 'server'), { recursive: true });
await fsp.copyFile(path.join(ROOT, 'package.json'), path.join(tmp, 'package.json'));

const gdPath = path.join(tmp, 'public', 'js', 'gd-api.js');
fs.writeFileSync(
  gdPath,
  fs
    .readFileSync(gdPath, 'utf8')
    .replace(
      /const UPSTREAM = 'https:\/\/music-api\.gdstudio\.xyz\/api\.php';/,
      `const UPSTREAM = 'http://127.0.0.1:${MOCK_PORT}/api.php';`
    )
);

const server = spawn(process.execPath, ['server/index.js'], {
  cwd: tmp,
  env: { ...process.env, PORT: String(PORT) },
  stdio: 'ignore',
});
await sleep(1500);

let browser;
try {
  browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: 'new',
    protocolTimeout: 30000,
    args: ['--no-sandbox', '--disable-gpu'],
  });

  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto(`${BASE}/?room=degrade`, { waitUntil: 'networkidle2' });
  await sleep(800);

  // 进入房间
  await page.evaluate(() => {
    document.getElementById('gate-name').value = '测试';
    document.getElementById('gate-room').value = 'degrade';
    document.getElementById('gate-enter').click();
  });
  await sleep(1500);

  const conn = await page.$eval('#conn-state', (e) => e.textContent.trim());
  check('上游不可用时仍能进入房间', conn === '已连接', conn);

  // 搜索必然失败
  await page.evaluate(() => {
    document.getElementById('search-input').value = '周杰伦';
    document.querySelector('#search-form button[type=submit]').click();
  });
  await sleep(8000);

  const state = await page.evaluate(() => ({
    status: document.getElementById('search-status').textContent.trim(),
    color: document.getElementById('search-status').style.color,
    items: document.querySelectorAll('#search-results .track-item').length,
    moreHidden: document.getElementById('search-more').hidden,
  }));
  console.log('  搜索状态:', JSON.stringify(state));

  check(
    '搜索失败时给出明确提示',
    /失败|不可用|无法连接|繁忙/.test(state.status),
    state.status
  );
  check('搜索失败时提示为警示色', state.color.includes('danger'), state.color);
  check('搜索失败时列表为空，不残留脏数据', state.items === 0, `${state.items} 项`);
  check('搜索失败时隐藏「加载更多」按钮', state.moreHidden === true);
  check('页面无未捕获异常', errors.length === 0, errors.join('; '));

  // 聊天不依赖上游
  await page.evaluate(() => {
    document.getElementById('chat-input').value = '上游挂了也能聊天';
    document.querySelector('#chat-form button[type=submit]').click();
  });
  await sleep(1500);
  const chatOk = await page.evaluate(() =>
    document.getElementById('chat-list').textContent.includes('上游挂了也能聊天')
  );
  check('聊天功能不受上游影响', chatOk);

  // 房间成员列表仍正常
  const memberCount = await page.$eval('#member-count', (e) => e.textContent.trim());
  check('成员列表不受上游影响', memberCount === '1', memberCount);
} catch (err) {
  check('测试执行', false, err.message);
  console.error(err);
} finally {
  await browser?.close();
  server.kill();
  brokenUpstream.close();
  for (let i = 0; i < 5; i++) {
    try {
      await fsp.rm(tmp, { recursive: true, force: true });
      break;
    } catch {
      await sleep(300);
    }
  }
}

const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} 项通过`);
process.exit(failed ? 1 : 0);
