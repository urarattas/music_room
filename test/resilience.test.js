/**
 * 降级行为测试：上游不可用时应用仍应正常工作
 * 运行：node test/resilience.test.js
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 34651;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, extra = '') {
  results.push(ok);
  console.log(`${ok ? '✔' : '✘'} ${name}${extra ? ` — ${extra}` : ''}`);
}

const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: 'ignore',
});
await sleep(1500);

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  protocolTimeout: 30000,
  args: ['--no-sandbox', '--disable-gpu'],
});

try {
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

  // 搜索失败时不应抛未捕获异常
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
} finally {
  await browser?.close();
  server.kill();
}

const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} 项通过`);
process.exit(failed ? 1 : 0);
