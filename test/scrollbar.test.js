// 验证滚动条样式已统一应用到各滚动容器
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = 34720;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn(process.execPath, ['server/index.js'], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: 'ignore',
});
await sleep(1500);

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  protocolTimeout: 30000,
  args: ['--no-sandbox', '--disable-gpu'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });

const results = [];
const check = (name, ok, extra = '') => {
  results.push(ok);
  console.log(`${ok ? '✔' : '✘'} ${name}${extra ? ` — ${extra}` : ''}`);
};

await page.goto(`${BASE}/?room=sb`, { waitUntil: 'networkidle2' });
await sleep(800);
await page.evaluate(() => {
  document.getElementById('gate-name').value = '测试';
  document.getElementById('gate-room').value = 'sb';
  document.getElementById('gate-enter').click();
});
await sleep(1000);

// 检查全局滚动条样式是否生效
const sbStyle = await page.evaluate(() => {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;top:-9999px;width:50px;height:50px;overflow:scroll';
  document.body.appendChild(probe);
  const cs = getComputedStyle(probe);
  const r = { scrollbarWidth: cs.scrollbarWidth, scrollbarColor: cs.scrollbarColor };
  probe.remove();
  return r;
});
console.log('  全局滚动条样式:', JSON.stringify(sbStyle));
check('全局启用了细滚动条 (scrollbar-width: thin)', sbStyle.scrollbarWidth === 'thin', sbStyle.scrollbarWidth);
check(
  '滚动条配色已设置',
  /rgb/.test(sbStyle.scrollbarColor) && sbStyle.scrollbarColor !== 'auto',
  sbStyle.scrollbarColor
);

// 检查各滚动容器的样式
const containers = await page.evaluate(() => {
  const ids = ['lyric-list', 'search-results', 'playlist', 'chat-list'];
  const out = {};
  for (const id of ids) {
    const el = document.getElementById(id);
    if (!el) continue;
    const cs = getComputedStyle(el);
    out[id] = {
      overflowY: cs.overflowY,
      scrollbarWidth: cs.scrollbarWidth,
      scrollbarColor: cs.scrollbarColor,
    };
  }
  return out;
});
console.log('  各容器:', JSON.stringify(containers, null, 1));

for (const [id, s] of Object.entries(containers)) {
  check(`${id} 使用统一滚动条样式`, s.scrollbarWidth === 'thin' && /rgb/.test(s.scrollbarColor), JSON.stringify(s));
}

// 确认 CSS 变量已定义
const vars = await page.evaluate(() => {
  const cs = getComputedStyle(document.documentElement);
  return {
    thumb: cs.getPropertyValue('--scroll-thumb').trim(),
    hover: cs.getPropertyValue('--scroll-thumb-hover').trim(),
    active: cs.getPropertyValue('--scroll-thumb-active').trim(),
    size: cs.getPropertyValue('--scroll-size').trim(),
  };
});
console.log('  CSS 变量:', JSON.stringify(vars));
check('滚动条颜色变量已定义', vars.thumb && vars.hover && vars.active, JSON.stringify(vars));

await browser.close();
server.kill();
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} 项通过`);
process.exit(failed ? 1 : 0);
