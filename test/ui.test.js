/**
 * 浏览器端 UI 冒烟测试（puppeteer-core + 本机 Chrome）
 * 覆盖：搜索 → 播放 → 房间同步 → 聊天
 * 运行：node test/ui.test.js
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 34568;
const BASE = `http://127.0.0.1:${PORT}`;
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHealth(timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch {
      /* retry */
    }
    await sleep(300);
  }
  throw new Error('server did not start');
}

const results = [];
function check(name, ok, extra = '') {
  results.push({ name, ok, extra });
  console.log(`${ok ? '✔' : '✘'} ${name}${extra ? ` — ${extra}` : ''}`);
}
function step(msg) {
  console.log(`  … ${msg}`);
}

const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: 'ignore',
});

let browser;
try {
  await waitHealth();
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    protocolTimeout: 120000,
    args: [
      '--no-sandbox',
      '--disable-gpu',
      '--autoplay-policy=no-user-gesture-required',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
    ],
  });

  const pageA = await browser.newPage();
  const pageB = await browser.newPage();
  // 后台标签页中 puppeteer 的 click() 会因 IntersectionObserver 不触发而挂起，
  // 因此统一使用 evaluate 触发点击。
  const clickA = (sel) => pageA.evaluate((s) => document.querySelector(s)?.click(), sel);
  const clickB = (sel) => pageB.evaluate((s) => document.querySelector(s)?.click(), sel);
  pageA.on('pageerror', (e) => console.log('  [A pageerror]', e.message));
  pageB.on('pageerror', (e) => console.log('  [B pageerror]', e.message));

  await pageA.goto(`${BASE}/?room=uitest`, { waitUntil: 'networkidle2' });
  await pageB.goto(`${BASE}/?room=uitest`, { waitUntil: 'networkidle2' });
  await sleep(1200);

  const connA = await pageA.$eval('#conn-state', (e) => e.textContent.trim());
  check('A 已连接 WebSocket', connA === '已连接', connA);

  const membersA = await pageA.$eval('#member-count', (e) => e.textContent.trim());
  check('A 看到 2 名成员', membersA === '2', `count=${membersA}`);

  // 搜索
  step('填写搜索框');
  await pageA.$eval('#search-input', (e) => {
    e.value = '周杰伦';
  });
  step('点击搜索按钮');
  await clickA('#search-form button[type=submit]');
  step('等待搜索结果');
  await pageA.waitForFunction(() => document.querySelectorAll('#search-results .track-item').length > 0, { timeout: 30000, polling: 500 });
  const searchCount = await pageA.$$eval('#search-results .track-item', (els) => els.length);
  check('搜索返回结果', searchCount > 0, `${searchCount} 条`);

  // 播放第一首
  await clickA('#search-results .track-item .icon-btn');
  await pageA.waitForFunction(() => document.getElementById('np-title').textContent !== '未在播放', { timeout: 25000, polling: 500 });
  const titleA = await pageA.$eval('#np-title', (e) => e.textContent.trim());
  check('A 播放成功', titleA.length > 0, titleA);

  // B 应同步到同一首曲目
  await pageB.waitForFunction(
    (t) => document.getElementById('np-title').textContent.trim() === t,
    { timeout: 20000, polling: 500 },
    titleA
  );
  const titleB = await pageB.$eval('#np-title', (e) => e.textContent.trim());
  check('B 同步到同一首曲目', titleB === titleA, `${titleB} / ${titleA}`);

  // 播放队列同步
  const plB = await pageB.$eval('#playlist-count', (e) => e.textContent.trim());
  check('B 收到播放队列', Number(plB) > 0, `count=${plB}`);

  // 聊天
  await pageA.$eval('#chat-input', (e) => {
    e.value = '一起来听歌';
  });
  await clickA('#chat-form button[type=submit]');
  await pageB.waitForFunction(
    () => document.getElementById('chat-list').textContent.includes('一起来听歌'),
    { timeout: 10000, polling: 500 }
  );
  check('B 收到聊天消息', true);

  // 播放进度推进
  await sleep(3000);
  const pos = await pageA.evaluate(() => {
    const a = document.getElementById('audio');
    return { currentTime: a.currentTime, paused: a.paused, readyState: a.readyState };
  });
  check('音频正在播放', pos.currentTime > 0.5 && !pos.paused, JSON.stringify(pos));

  // 封面
  await pageA.waitForFunction(
    () => {
      const img = document.getElementById('cover');
      return img.classList.contains('visible') && img.naturalWidth > 0;
    },
    { timeout: 20000, polling: 500 }
  );
  const coverOk = await pageA.evaluate(() => {
    const img = document.getElementById('cover');
    return { visible: img.classList.contains('visible'), w: img.naturalWidth };
  });
  check('封面已加载', coverOk.visible && coverOk.w > 0, JSON.stringify(coverOk));

  // 搜索结果缩略图
  await pageA.waitForFunction(
    () => {
      const imgs = [...document.querySelectorAll('#search-results .track-item img')];
      return imgs.length > 0 && imgs.some((i) => i.naturalWidth > 0);
    },
    { timeout: 20000, polling: 500 }
  );
  const thumbOk = await pageA.evaluate(() => {
    const imgs = [...document.querySelectorAll('#search-results .track-item img')];
    return { total: imgs.length, loaded: imgs.filter((i) => i.naturalWidth > 0).length };
  });
  check('搜索结果缩略图已加载', thumbOk.loaded > 0, JSON.stringify(thumbOk));

  // 歌词
  await pageA.waitForFunction(
    () => document.querySelectorAll('#lyric-list .lyric-line').length > 0,
    { timeout: 20000, polling: 500 }
  );
  const lyricCount = await pageA.$$eval('#lyric-list .lyric-line', (els) => els.length);
  check('歌词已加载', lyricCount > 0, `${lyricCount} 行`);

  // 开麦（fake device）
  await clickA('#btn-mic');
  await sleep(1500);
  const micOn = await pageA.$eval('#btn-mic', (e) => e.classList.contains('active'));
  const micB = await pageB.$eval('#members', (el) => el.textContent.includes('🎙'));
  check('A 开麦成功', micOn, `active=${micOn}`);
  check('B 看到 A 已开麦', micB);

  // P2P 连接建立：B 未开麦，因此 A 不会收到 B 的音轨；
  // 但 B 应收到 A 的音轨
  await sleep(4000);
  const peerState = await pageB.evaluate(() => {
    const audios = [...document.querySelectorAll('audio[id^="peer-"]')];
    return {
      count: audios.length,
      ids: audios.map((a) => a.id),
      live: audios.map((a) => a.srcObject?.getAudioTracks().length ?? 0),
    };
  });
  check('B 收到 A 的远端音轨', peerState.count > 0 && peerState.live.some((n) => n > 0), JSON.stringify(peerState));

  // B 也开麦，验证双向音轨
  await clickB('#btn-mic');
  await sleep(4000);
  const bidirectional = await pageA.evaluate(() => {
    const audios = [...document.querySelectorAll('audio[id^="peer-"]')];
    return {
      count: audios.length,
      live: audios.map((a) => a.srcObject?.getAudioTracks().length ?? 0),
    };
  });
  check('A 收到 B 的远端音轨（双向）', bidirectional.count > 0 && bidirectional.live.some((n) => n > 0), JSON.stringify(bidirectional));

  await pageA.screenshot({ path: path.join(__dirname, '..', 'ui-a.png') });
  await pageB.screenshot({ path: path.join(__dirname, '..', 'ui-b.png') });
} catch (err) {
  check('测试执行', false, err.message);
  console.error(err);
} finally {
  await browser?.close();
  server.kill();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
process.exit(failed.length ? 1 : 0);
