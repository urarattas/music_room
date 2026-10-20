// 生成文档截图：入口页 + 主界面
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = 34612;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: 'ignore',
});
await sleep(1500);

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  protocolTimeout: 60000,
  args: ['--no-sandbox', '--disable-gpu', '--autoplay-policy=no-user-gesture-required', '--window-size=1440,900'],
});

const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });

// 1) 入口页
await page.goto(`${BASE}/?room=大厅`, { waitUntil: 'networkidle2' });
await sleep(1500);
await page.screenshot({ path: path.join(ROOT, 'docs', 'screenshot-gate.png') });
console.log('✓ docs/screenshot-gate.png');

// 2) 主界面
await page.evaluate(() => {
  document.getElementById('gate-name').value = '小明';
  document.getElementById('gate-room').value = '大厅';
  document.getElementById('gate-enter').click();
});
await sleep(1500);
await page.evaluate(() => {
  document.getElementById('search-input').value = '周杰伦';
  document.querySelector('#search-form button[type=submit]').click();
});
await sleep(4000);
await page.evaluate(() => document.querySelector('#search-results .track-item .icon-btn').click());
await sleep(6000);
await page.evaluate(() => {
  document.getElementById('chat-input').value = '这首不错！';
  document.querySelector('#chat-form button[type=submit]').click();
});
await sleep(2000);
await page.screenshot({ path: path.join(ROOT, 'docs', 'screenshot.png') });
console.log('✓ docs/screenshot.png');

await browser.close();
server.kill();
