/**
 * 各音源在浏览器直连下的可用性测试
 *
 * 上游现状（实测）：
 * - netease   ：搜索 + 播放地址 + 歌词 + 封面 全部可用 ✅
 * - joox      ：搜索 / 封面 / 歌词可用，但 `types=url` 恒返回空地址（0/30）⚠
 * - bilibili  ：搜索结果不稳定（同一关键字有时返回 0 条），播放地址部分可用 ⚠
 *
 * 本测试只断言 **netease 完全可用**，其余音源打印实测结果供参考。
 * 运行：node test/sources.test.js
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 34633;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: 'ignore',
});
await sleep(1500);

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  protocolTimeout: 60000,
  args: ['--no-sandbox', '--disable-gpu', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.goto(`${BASE}/?room=src`, { waitUntil: 'networkidle2' });
await sleep(800);
await page.evaluate(() => {
  document.getElementById('gate-name').value = '测试';
  document.getElementById('gate-room').value = 'src';
  document.getElementById('gate-enter').click();
});
await sleep(1200);

const sources = [
  ['netease', '周杰伦'],
  ['joox', '周杰倫'],
  ['bilibili', '周杰伦'],
];

let neteaseOk = false;

for (const [source, keyword] of sources) {
  await page.evaluate(
    (s, kw) => {
      window.__ev = [];
      for (const n of ['loaded', 'error']) {
        window.__player.addEventListener(n, (e) =>
          window.__ev.push({ n, url: e.detail?.url?.slice(0, 40), msg: e.detail?.msg })
        );
      }
      document.getElementById('search-source').value = s;
      document.getElementById('search-input').value = kw;
      document.querySelector('#search-form button[type=submit]').click();
    },
    source,
    keyword
  );
  await sleep(6000);

  const info = await page.evaluate(() => ({
    count: document.querySelectorAll('#search-results .track-item').length,
    status: document.getElementById('search-status').textContent.trim(),
  }));
  console.log(`[${source}] 搜索到 ${info.count} 条 — ${info.status}`);
  if (info.count === 0) continue;

  await page.evaluate(() => document.querySelector('#search-results .track-item .icon-btn').click());
  await sleep(9000);

  const play = await page.evaluate(() => {
    const a = document.getElementById('audio');
    const p = window.__player;
    return {
      srcKey: p._lastLoadedKey,
      stateKey: p._keyOf(p.state.track),
      hasSrc: !!a.src && a.src.startsWith('http'),
      host: a.src ? new URL(a.src).hostname : null,
      duration: Number((a.duration || 0).toFixed(1)),
      currentTime: Number(a.currentTime.toFixed(1)),
      paused: a.paused,
      ev: window.__ev,
    };
  });
  const ok = play.hasSrc && play.srcKey === play.stateKey && play.currentTime > 0 && !play.paused;
  if (source === 'netease') neteaseOk = ok;
  console.log(
    `  播放: ${ok ? '✔ 可播放' : '✘ 不可播放'} src=${play.host} 时长=${play.duration}s 已播=${play.currentTime}s`
  );
  if (!ok) console.log('    原因:', JSON.stringify(play.ev.filter((e) => e.n === 'error').map((e) => e.msg)));
}

console.log(`\nnetease 完全可用: ${neteaseOk ? '✔' : '✘'}`);
console.log('说明：joox / bilibili 的播放地址由上游决定，当前上游对 joox 恒返回空地址。');

await browser.close();
server.kill();
process.exit(neteaseOk ? 0 : 1);
