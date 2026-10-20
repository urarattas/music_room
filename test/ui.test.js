/**
 * 浏览器端到端测试（puppeteer-core + 本机 Chrome）
 * 覆盖：入口页 → 搜索 → 播放 → 房间同步 → 聊天 → 歌词/翻译 → 封面 → 拖动进度 → 开麦 P2P
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
  const setValA = (sel, v) => pageA.evaluate((s, val) => { document.querySelector(s).value = val; }, sel, v);
  const setValB = (sel, v) => pageB.evaluate((s, val) => { document.querySelector(s).value = val; }, sel, v);
  pageA.on('pageerror', (e) => console.log('  [A pageerror]', e.message));
  pageB.on('pageerror', (e) => console.log('  [B pageerror]', e.message));

  await pageA.goto(`${BASE}/?room=uitest`, { waitUntil: 'networkidle2' });
  await pageB.goto(`${BASE}/?room=uitest`, { waitUntil: 'networkidle2' });
  await sleep(1200);

  /* ---------------- 4. 入口页：先输入昵称和房间号 ---------------- */
  step('检查入口页');
  const gateVisible = await pageA.$eval('#gate', (e) => !e.classList.contains('hidden'));
  const appHidden = await pageA.$eval('#app', (e) => e.classList.contains('hidden'));
  check('入口页默认显示，主界面隐藏', gateVisible && appHidden, `gate=${gateVisible} appHidden=${appHidden}`);

  const prefillRoom = await pageA.$eval('#gate-room', (e) => e.value);
  check('入口页预填 URL 中的房间号', prefillRoom === 'uitest', prefillRoom);

  step('输入昵称与房间号');
  await setValA('#gate-name', '小明');
  await setValA('#gate-room', 'uitest');
  await setValB('#gate-name', '小红');
  await setValB('#gate-room', 'uitest');
  await clickA('#gate-enter');
  await clickB('#gate-enter');
  await sleep(1500);

  const afterEnter = await pageA.evaluate(() => ({
    gateHidden: document.getElementById('gate').classList.contains('hidden'),
    appHidden: document.getElementById('app').classList.contains('hidden'),
    conn: document.getElementById('conn-state').textContent.trim(),
    name: document.getElementById('name-input').value,
  }));
  check('进入后切换到主界面', afterEnter.gateHidden && !afterEnter.appHidden, JSON.stringify(afterEnter));
  check('连接状态为已连接', afterEnter.conn === '已连接', afterEnter.conn);
  check('昵称已带入主界面', afterEnter.name === '小明', afterEnter.name);

  const membersA = await pageA.$eval('#member-count', (e) => e.textContent.trim());
  check('A 看到 2 名成员', membersA === '2', `count=${membersA}`);

  /* ---------------- 搜索 ---------------- */
  step('搜索');
  await setValA('#search-input', '周杰伦');
  await clickA('#search-form button[type=submit]');
  await pageA.waitForFunction(() => document.querySelectorAll('#search-results .track-item').length > 0, { timeout: 30000, polling: 500 });
  const searchCount = await pageA.$$eval('#search-results .track-item', (els) => els.length);
  check('搜索返回结果', searchCount > 0, `${searchCount} 条`);

  /* ---------------- 2. 封面 ---------------- */
  step('检查封面');
  // 后台标签页会被 Chrome 限速（定时器节流），前台化后再断言
  await pageA.bringToFront();
  await pageA.waitForFunction(
    () => {
      const imgs = [...document.querySelectorAll('#search-results .track-item img')];
      return imgs.length > 0 && imgs.filter((i) => i.naturalWidth > 0).length > 0;
    },
    { timeout: 60000, polling: 500 }
  );
  const thumbOk = await pageA.evaluate(() => {
    const imgs = [...document.querySelectorAll('#search-results .track-item img')];
    return {
      total: imgs.length,
      loaded: imgs.filter((i) => i.naturalWidth > 0).length,
      // 已请求但失败的才算坏图；尚未请求的不算
      broken: imgs.filter((i) => i.dataset.coverState === 'error').length,
      queued: imgs.filter((i) => i.dataset.coverState === 'queued').length,
    };
  });
  check(
    '搜索结果缩略图已加载',
    thumbOk.loaded > 0 && thumbOk.broken === 0,
    JSON.stringify(thumbOk)
  );

  // 滚动列表应渐进加载更多封面
  const beforeScroll = thumbOk.loaded;
  await pageA.evaluate(() => {
    const l = document.getElementById('search-results');
    l.scrollTop = l.scrollHeight;
  });
  await sleep(6000);
  const afterScroll = await pageA.evaluate(() => {
    const imgs = [...document.querySelectorAll('#search-results .track-item img')];
    return {
      loaded: imgs.filter((i) => i.naturalWidth > 0).length,
      broken: imgs.filter((i) => i.dataset.coverState === 'error').length,
    };
  });
  check(
    '滚动列表渐进加载更多封面',
    afterScroll.loaded > beforeScroll && afterScroll.broken === 0,
    `${beforeScroll} → ${afterScroll.loaded}, 坏图 ${afterScroll.broken}`
  );

  /* ---------------- 播放 ---------------- */
  step('播放第一首');
  await clickA('#search-results .track-item .icon-btn');
  await pageA.waitForFunction(() => document.getElementById('np-title').textContent !== '未在播放', { timeout: 30000, polling: 500 });
  const titleA = await pageA.$eval('#np-title', (e) => e.textContent.trim());
  check('A 播放成功', titleA.length > 0, titleA);

  await pageB.waitForFunction(
    (t) => document.getElementById('np-title').textContent.trim() === t,
    { timeout: 30000, polling: 500 },
    titleA
  );
  const titleB = await pageB.$eval('#np-title', (e) => e.textContent.trim());
  check('B 同步到同一首曲目', titleB === titleA, `${titleB} / ${titleA}`);

  const plB = await pageB.$eval('#playlist-count', (e) => e.textContent.trim());
  check('B 收到播放队列', Number(plB) > 0, `count=${plB}`);

  // 主封面
  await pageA.waitForFunction(
    () => {
      const img = document.getElementById('cover');
      return img.classList.contains('visible') && img.naturalWidth > 0;
    },
    { timeout: 30000, polling: 500 }
  );
  const coverOk = await pageA.evaluate(() => {
    const img = document.getElementById('cover');
    return { visible: img.classList.contains('visible'), w: img.naturalWidth };
  });
  check('主封面已加载', coverOk.visible && coverOk.w > 0, JSON.stringify(coverOk));

  /* ---------------- 1. 歌词与翻译 ---------------- */
  step('检查歌词');
  await pageA.waitForFunction(
    () => document.querySelectorAll('#lyric-list .lyric-line').length > 0,
    { timeout: 30000, polling: 500 }
  );
  const lyricOk = await pageA.evaluate(() => {
    const lines = [...document.querySelectorAll('#lyric-list .lyric-line')];
    return { count: lines.length, sample: lines.slice(0, 2).map((l) => l.textContent) };
  });
  check('歌词已加载', lyricOk.count > 0, `${lyricOk.count} 行`);

  // 切到「翻译」标签页
  await clickA('.lyric-tab[data-mode=tlyric]');
  await sleep(800);
  const transState = await pageA.evaluate(() => {
    const lines = [...document.querySelectorAll('#lyric-list .lyric-line')];
    const active = document.querySelector('.lyric-tab[data-mode=tlyric]');
    return {
      count: lines.length,
      activeTab: active?.classList.contains('active'),
      hasContent: lines.some((l) => l.textContent.trim() && l.textContent.trim() !== '♪'),
      sample: lines.slice(0, 2).map((l) => l.textContent),
    };
  });
  check('翻译标签页已激活', transState.activeTab === true, JSON.stringify(transState));
  check('翻译歌词有实际内容（非 ♪ 占位）', transState.hasContent === true, JSON.stringify(transState.sample));

  // 切回原文
  await clickA('.lyric-tab[data-mode=lyric]');
  await sleep(500);
  const backToOriginal = await pageA.evaluate(() => {
    const lines = [...document.querySelectorAll('#lyric-list .lyric-line')];
    return { count: lines.length, sample: lines.slice(0, 2).map((l) => l.textContent) };
  });
  check('可切回原文歌词', backToOriginal.count > 0, JSON.stringify(backToOriginal.sample));

  /* ---------------- 聊天 ---------------- */
  step('聊天');
  await setValA('#chat-input', '一起来听歌');
  await clickA('#chat-form button[type=submit]');
  await pageB.waitForFunction(
    () => document.getElementById('chat-list').textContent.includes('一起来听歌'),
    { timeout: 15000, polling: 500 }
  );
  check('B 收到聊天消息', true);

  /* ---------------- 3. 拖动进度条 ---------------- */
  step('检查进度条');
  await sleep(3000);
  const totalTxt = await pageA.$eval('#time-total', (e) => e.textContent.trim());
  check('总时长已显示', /\d+:\d\d/.test(totalTxt) && totalTxt !== '00:00', totalTxt);

  await pageA.waitForFunction(
    () => {
      const p = window.__player;
      return p.duration > 1000;
    },
    { timeout: 20000, polling: 500 }
  );
  const durInfo = await pageA.evaluate(() => ({ duration: window.__player.duration }));
  check('player.duration 单位为毫秒', durInfo.duration > 1000, `${durInfo.duration}ms`);

  // 拖动到 50%
  await pageA.evaluate(() => {
    const s = document.getElementById('seek');
    s.value = '500';
    s.dispatchEvent(new Event('input', { bubbles: true }));
    s.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await sleep(2500);
  const afterSeek = await pageA.evaluate(() => {
    const p = window.__player;
    const a = document.getElementById('audio');
    return {
      audioCurrent: Number(a.currentTime.toFixed(2)),
      expected: Math.round(p.expectedPos() / 1000),
      serverPos: Math.round(p.state.pos / 1000),
    };
  });
  const half = durInfo.duration / 2000; // 50% 处，单位秒
  check(
    '拖动进度条生效（跳到约 50%）',
    Math.abs(afterSeek.audioCurrent - half) < 8,
    `audio=${afterSeek.audioCurrent}s 期望≈${half.toFixed(1)}s server=${afterSeek.serverPos}s`
  );

  /* ---------------- 开麦与 P2P ---------------- */
  step('开麦');
  await clickA('#btn-mic');
  await sleep(2000);
  const micOn = await pageA.$eval('#btn-mic', (e) => e.classList.contains('active'));
  const micB = await pageB.$eval('#members', (el) => el.textContent.includes('🎙'));
  check('A 开麦成功', micOn, `active=${micOn}`);
  check('B 看到 A 已开麦', micB);

  await sleep(4000);
  const peerState = await pageB.evaluate(() => {
    const audios = [...document.querySelectorAll('audio[id^="peer-"]')];
    return {
      count: audios.length,
      live: audios.map((a) => a.srcObject?.getAudioTracks().length ?? 0),
    };
  });
  check('B 收到 A 的远端音轨', peerState.count > 0 && peerState.live.some((n) => n > 0), JSON.stringify(peerState));

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
