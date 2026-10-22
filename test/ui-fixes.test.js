/**
 * UI 专项测试：封面同步、歌词居中、音质切换
 *
 * 上游可能限流（503），所以这里用一个**本地上游模拟**，
 * 通过改写 gd-api 的上游地址来测试，不依赖真实 GD 音乐台。
 *
 * 运行：node test/ui-fixes.test.js
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { makePng } from './make-png.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = 34700;
const MOCK_PORT = 34701;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, ok, extra = '') => {
  results.push(ok);
  console.log(`${ok ? '✔' : '✘'} ${name}${extra ? ` — ${extra}` : ''}`);
};

/* ------------------------------ 模拟上游 ------------------------------ */

const PNG_1PX = makePng(64, 64);

let lastUrlRequest = null;

/**
 * 模拟上游 + 静态资源（封面图片、音频）放在同一个服务器里，
 * 这样返回的 URL 端口一定对得上。
 */
const mockUpstream = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const types = url.searchParams.get('types');

  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', '*');
  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }

  // ---- 静态资源 ----
  if (url.pathname.endsWith('.png')) {
    res.writeHead(200, { 'content-type': 'image/png' }).end(PNG_1PX);
    return;
  }
  if (url.pathname === '/audio.mp3') {
    // 60 秒静音 WAV（支持 Range 请求，否则浏览器无法 seek）
    const rate = 8000;
    const n = rate * 60;
    const buf = Buffer.alloc(44 + n * 2);
    buf.write('RIFF', 0);
    buf.writeUInt32LE(36 + n * 2, 4);
    buf.write('WAVE', 8);
    buf.write('fmt ', 12);
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20);
    buf.writeUInt16LE(1, 22);
    buf.writeUInt32LE(rate, 24);
    buf.writeUInt32LE(rate * 2, 28);
    buf.writeUInt16LE(2, 32);
    buf.writeUInt16LE(16, 34);
    buf.write('data', 36);
    buf.writeUInt32LE(n * 2, 40);

    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d+)-(\d*)/.exec(range);
      const start = Number(m[1]);
      const end = m[2] ? Number(m[2]) : buf.length - 1;
      const chunk = buf.subarray(start, end + 1);
      res.writeHead(206, {
        'content-type': 'audio/wav',
        'content-range': `bytes ${start}-${end}/${buf.length}`,
        'accept-ranges': 'bytes',
        'content-length': chunk.length,
      });
      res.end(chunk);
      return;
    }
    res.writeHead(200, {
      'content-type': 'audio/wav',
      'accept-ranges': 'bytes',
      'content-length': buf.length,
    });
    res.end(buf);
    return;
  }

  // ---- API ----
  if (types === 'search') {
    const name = url.searchParams.get('name') || '';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify([
        { id: 't1', name: `歌曲A-${name}`, artist: ['歌手A'], album: '专辑A', pic_id: 'p1', lyric_id: 'l1', source: 'netease' },
        { id: 't2', name: `歌曲B-${name}`, artist: ['歌手B'], album: '专辑B', pic_id: 'p2', lyric_id: 'l2', source: 'netease' },
      ])
    );
    return;
  }
  if (types === 'url') {
    const br = url.searchParams.get('br');
    lastUrlRequest = { br, id: url.searchParams.get('id') };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ url: `http://127.0.0.1:${MOCK_PORT}/audio.mp3?br=${br}`, br: Number(br), size: 1000 }));
    return;
  }
  if (types === 'pic') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ url: `http://127.0.0.1:${MOCK_PORT}/cover-${url.searchParams.get('id')}.png` }));
    return;
  }
  if (types === 'lyric') {
    res.writeHead(200, { 'content-type': 'application/json' });
    // 20 行歌词，时间间隔 3 秒
    const lines = [];
    const trans = [];
    for (let i = 0; i < 20; i++) {
      const t = String(i * 3).padStart(2, '0');
      lines.push(`[00:${t}.00]原文第${i + 1}行`);
      trans.push(`[00:${t}.00]翻译第${i + 1}行`);
    }
    res.end(JSON.stringify({ lyric: lines.join('\n'), tlyric: trans.join('\n') }));
    return;
  }
  res.writeHead(404).end();
});

await new Promise((r) => mockUpstream.listen(MOCK_PORT, '127.0.0.1', r));

/* ------------------ 复制项目并把上游指向本地模拟 ------------------ */

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'mr-fixes-'));
await fsp.cp(path.join(ROOT, 'public'), path.join(tmp, 'public'), { recursive: true });
await fsp.cp(path.join(ROOT, 'server'), path.join(tmp, 'server'), { recursive: true });
await fsp.copyFile(path.join(ROOT, 'package.json'), path.join(tmp, 'package.json'));

// 把 gd-api.js 的上游改成模拟服务器
const gdPath = path.join(tmp, 'public', 'js', 'gd-api.js');
let gd = fs.readFileSync(gdPath, 'utf8');
gd = gd.replace(
  /const UPSTREAM = 'https:\/\/music-api\.gdstudio\.xyz\/api\.php';/,
  `const UPSTREAM = 'http://127.0.0.1:${MOCK_PORT}/api.php';`
);
fs.writeFileSync(gdPath, gd);

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
    protocolTimeout: 60000,
    args: [
      '--no-sandbox',
      '--disable-gpu',
      '--autoplay-policy=no-user-gesture-required',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
    ],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));

  await page.goto(`${BASE}/?room=fixes`, { waitUntil: 'networkidle2' });
  await sleep(800);
  await page.evaluate(() => {
    document.getElementById('gate-name').value = '测试';
    document.getElementById('gate-room').value = 'fixes';
    document.getElementById('gate-enter').click();
  });
  await sleep(1200);

  /* ---------------- 搜索并播放第一首 ---------------- */
  await page.evaluate(() => {
    document.getElementById('search-input').value = '测试歌';
    document.querySelector('#search-form button[type=submit]').click();
  });
  await sleep(2000);

  await page.evaluate(() => document.querySelector('#search-results .track-item .icon-btn').click());
  await sleep(3000);

  /* ============ 1. 封面同步 ============ */
  console.log('\n=== 1. 封面同步 ===');
  const cover1 = await page.evaluate(() => ({
    src: document.getElementById('cover').src,
    state: document.getElementById('cover').dataset.coverState,
    key: document.getElementById('cover').dataset.coverKey,
  }));
  console.log('  第一首封面:', JSON.stringify(cover1));

  // 切到第二首
  await page.evaluate(() => {
    document.querySelectorAll('#search-results .track-item')[1].querySelector('.icon-btn').click();
  });
  await sleep(3500);

  const cover2 = await page.evaluate(() => ({
    src: document.getElementById('cover').src,
    state: document.getElementById('cover').dataset.coverState,
    key: document.getElementById('cover').dataset.coverKey,
  }));
  console.log('  第二首封面:', JSON.stringify(cover2));

  check('切歌后封面地址已改变', cover1.src !== cover2.src, `${cover1.src.slice(-22)} → ${cover2.src.slice(-22)}`);
  check('切歌后封面状态为已加载', cover2.state === 'loaded', cover2.state);
  check('切歌后封面 key 已更新', cover1.key !== cover2.key, `${cover1.key} → ${cover2.key}`);
  check('封面指向新曲目的图片', cover2.src.includes('cover-p2'), cover2.src.slice(-20));

  /* ============ 2. 歌词居中 ============ */
  console.log('\n=== 2. 歌词居中 ===');
  // 通过 UI 进度条 seek 到 50%（会同步到服务端）
  await page.evaluate(() => {
    const s = document.getElementById('seek');
    s.value = '500';
    s.dispatchEvent(new Event('input', { bubbles: true }));
    s.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await sleep(3000);

  const lyricState = await page.evaluate(() => {
    const box = document.getElementById('lyric-list');
    const active = box.querySelector('.lyric-line.active');
    if (!active) return { hasActive: false };
    const b = box.getBoundingClientRect();
    const a = active.getBoundingClientRect();
    return {
      hasActive: true,
      activeText: active.textContent,
      // 活动行中心相对容器中心的偏移（像素）
      offset: Math.round(a.top + a.height / 2 - (b.top + b.height / 2)),
      boxHeight: Math.round(b.height),
      scrollTop: Math.round(box.scrollTop),
      padTop: Math.round(parseFloat(box.style.paddingTop) || 0),
    };
  });
  console.log('  歌词状态:', JSON.stringify(lyricState));

  check('存在高亮的歌词行', lyricState.hasActive === true);
  if (lyricState.hasActive) {
    // 允许 ±8px 误差（字体行高带来的取整）
    check(
      '当前歌词居中显示',
      Math.abs(lyricState.offset) <= 8,
      `偏离中心 ${lyricState.offset}px`
    );
    check('歌词列表已补足上下留白', lyricState.padTop > 0, `padding-top=${lyricState.padTop}px`);
  }

  // 切到翻译标签后仍应居中
  await page.evaluate(() => document.querySelector('.lyric-tab[data-mode=tlyric]').click());
  await sleep(1200);
  const transState = await page.evaluate(() => {
    const box = document.getElementById('lyric-list');
    const active = box.querySelector('.lyric-line.active');
    if (!active) return { hasActive: false };
    const b = box.getBoundingClientRect();
    const a = active.getBoundingClientRect();
    return {
      hasActive: true,
      text: active.textContent,
      offset: Math.round(a.top + a.height / 2 - (b.top + b.height / 2)),
    };
  });
  console.log('  翻译模式:', JSON.stringify(transState));
  check('切换翻译后当前行仍居中', transState.hasActive && Math.abs(transState.offset) <= 8, `偏离 ${transState.offset}px`);
  check('翻译内容已生效', (transState.text || '').includes('翻译'), transState.text);

  /* ============ 3. 音质切换 ============ */
  console.log('\n=== 3. 音质切换 ===');
  const qualityPos = await page.evaluate(() => {
    const q = document.getElementById('quality');
    const r = q.getBoundingClientRect();
    const title = document.getElementById('np-title').getBoundingClientRect();
    return { qTop: Math.round(r.top), titleBottom: Math.round(title.bottom), inSearch: !!document.querySelector('#search-form #quality') };
  });
  check('音质选择器不在搜索表单里', qualityPos.inSearch === false);
  check(
    '音质选择器位于当前歌曲信息下方',
    qualityPos.qTop >= qualityPos.titleBottom,
    `选择器 top=${qualityPos.qTop}, 标题 bottom=${qualityPos.titleBottom}`
  );

  lastUrlRequest = null;
  await page.evaluate(() => {
    const q = document.getElementById('quality');
    q.value = '128';
    q.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await sleep(3000);

  const afterQuality = await page.evaluate(() => ({
    audioSrc: document.getElementById('audio').src,
    hint: document.getElementById('quality-hint').textContent,
    playerQuality: window.__player.quality,
  }));
  console.log('  切换后:', JSON.stringify(afterQuality));
  console.log('  上游收到的 br:', JSON.stringify(lastUrlRequest));

  check('已向上游请求新音质', lastUrlRequest?.br === '128', `br=${lastUrlRequest?.br}`);
  check('播放地址已换成新音质', afterQuality.audioSrc.includes('br=128'), afterQuality.audioSrc.slice(-14));
  check('播放器记录的音质已更新', afterQuality.playerQuality === 128, String(afterQuality.playerQuality));

  await page.screenshot({ path: path.join(ROOT, 'ui-fixes.png') });
} catch (err) {
  check('测试执行', false, err.message);
  console.error(err);
} finally {
  await browser?.close();
  server.kill();
  mockUpstream.close();
  // Windows 上文件句柄可能还没释放，重试几次
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
