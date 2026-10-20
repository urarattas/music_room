/**
 * 封面本地缓存
 *
 * 问题：上游 API 只有 50 次 / 5 分钟配额，且单次响应约 1.3 秒。
 * 如果每次显示列表都去问上游要封面地址，很快就会耗尽配额，
 * 导致播放地址、歌词拿不到；而且 30 张封面串行请求要等 40 秒。
 *
 * 方案：服务端拿到封面地址后，把图片本身下载到本地缓存目录，
 * 之后浏览器直接读本地文件 —— 上游只被访问一次（每个 pic_id 一次），
 * 页面加载也变快。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.resolve(__dirname, '..', '.cache', 'covers');

/** picId -> 本地文件名 */
const index = new Map();
const INDEX_FILE = path.join(path.dirname(CACHE_DIR), 'cover-index.json');

function loadIndex() {
  try {
    const obj = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
    for (const [k, v] of Object.entries(obj)) index.set(k, v);
  } catch {
    /* 首次运行 */
  }
}

let dirty = false;

function saveIndex() {
  if (!dirty) return;
  dirty = false;
  try {
    fs.mkdirSync(path.dirname(INDEX_FILE), { recursive: true });
    fs.writeFileSync(INDEX_FILE, JSON.stringify(Object.fromEntries(index)), 'utf8');
  } catch {
    /* ignore */
  }
}

loadIndex();
setInterval(saveIndex, 10_000).unref?.();

/** key -> 本地绝对路径（若已缓存） */
export function getCachedCover(key) {
  const file = index.get(key);
  if (!file) return null;
  const full = path.join(CACHE_DIR, file);
  try {
    if (fs.existsSync(full)) return full;
  } catch {
    /* ignore */
  }
  index.delete(key);
  return null;
}

/** 把远端图片写入本地缓存，返回本地绝对路径 */
export async function storeCover(key, remoteUrl) {
  if (!remoteUrl) return null;
  try {
    const res = await fetch(remoteUrl, {
      headers: { 'user-agent': 'music-room/0.1', referer: 'https://music.163.com/' },
    });
    if (!res.ok) return null;
    const type = res.headers.get('content-type') || 'image/jpeg';
    const ext = type.includes('png') ? '.png' : type.includes('webp') ? '.webp' : '.jpg';
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) return null;

    await fsp.mkdir(CACHE_DIR, { recursive: true });
    // 用 hash 命名，避免非法字符
    const safe = key.replace(/[^a-zA-Z0-9_-]/g, '_');
    const file = `${safe}${ext}`;
    await fsp.writeFile(path.join(CACHE_DIR, file), buf);
    index.set(key, file);
    dirty = true;
    return path.join(CACHE_DIR, file);
  } catch {
    return null;
  }
}

export { CACHE_DIR };
