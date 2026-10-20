/**
 * GD Studio 音乐台 API 客户端（带缓存与限流保护）
 * 文档：https://music-api.gdstudio.xyz/api.php
 */
import fs from 'node:fs';
import path from 'node:path';

const UPSTREAM = 'https://music-api.gdstudio.xyz/api.php';

/** 上游限流：5 分钟内不超过 50 次请求 */
const RATE_LIMIT = { windowMs: 5 * 60 * 1000, max: 50 };

/**
 * 相邻请求最小间隔（ms），避免突发触发上游 503。
 * 实测：350ms 间隔下 30 次请求 0 失败；0ms 间隔下第 2 个就开始失败。
 */
const MIN_REQUEST_INTERVAL = 350;

/**
 * 优先级：数字越小越先执行。
 * 封面（low）可以等，播放地址与歌词（high）必须立刻拿到。
 */
export const PRIORITY = { high: 0, normal: 1, low: 2 };

const requestTimes = [];

function rateLimited() {
  const now = Date.now();
  while (requestTimes.length && now - requestTimes[0] > RATE_LIMIT.windowMs) {
    requestTimes.shift();
  }
  if (requestTimes.length >= RATE_LIMIT.max) return true;
  requestTimes.push(now);
  return false;
}

/** 简单 TTL 缓存 */
const cache = new Map();

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() > hit.expire) {
    cache.delete(key);
    return undefined;
  }
  return hit.value;
}

function cacheSet(key, value, ttlMs) {
  cache.set(key, { value, expire: Date.now() + ttlMs });
  return value;
}

/**
 * 优先级串行队列：
 * - 任意两个上游请求之间至少间隔 MIN_REQUEST_INTERVAL（上游并发会 503）
 * - 高优先级请求插队到队首，避免被几十个封面请求堵在后面
 */
const queue = [];
let running = false;
let lastRequestAt = 0;

function enqueue(fn, priority = PRIORITY.normal) {
  return new Promise((resolve, reject) => {
    queue.push({ fn, priority, seq: queue.length, resolve, reject });
    queue.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
    drain();
  });
}

async function drain() {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      const task = queue.shift();
      const wait = lastRequestAt + MIN_REQUEST_INTERVAL - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastRequestAt = Date.now();
      try {
        task.resolve(await task.fn());
      } catch (err) {
        task.reject(err);
      }
    }
  } finally {
    running = false;
  }
}

async function fetchUpstream(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'user-agent': 'music-room/0.1 (+https://music.gdstudio.org)' },
    });
    if (!res.ok) {
      const err = new Error(`音乐服务返回 ${res.status}`);
      err.code = res.status === 503 ? 'UPSTREAM_BUSY' : 'UPSTREAM_ERROR';
      err.status = res.status;
      throw err;
    }
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      const err = new Error('音乐服务返回了无法解析的内容');
      err.code = 'BAD_PAYLOAD';
      throw err;
    }
  } finally {
    clearTimeout(timer);
  }
}

/** 相同 key 的并发请求合并为一次上游调用 */
const inflight = new Map();

async function callApi(params, { ttlMs = 0, timeoutMs = 15000, retries = 2, priority = PRIORITY.normal } = {}) {
  const url = new URL(UPSTREAM);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const key = url.toString();
  if (ttlMs > 0) {
    const hit = cacheGet(key);
    if (hit !== undefined) return hit;
  }
  if (inflight.has(key)) return inflight.get(key);

  const task = (async () => {
    if (rateLimited()) {
      const err = new Error('音乐服务请求过于频繁，请稍后再试');
      err.code = 'RATE_LIMITED';
      throw err;
    }

    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const data = await enqueue(() => fetchUpstream(key, timeoutMs), priority);
        return ttlMs > 0 ? cacheSet(key, data, ttlMs) : data;
      } catch (err) {
        lastErr = err;
        // 503/网络抖动时退避重试
        if (err.code === 'UPSTREAM_BUSY' && attempt < retries) {
          await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
          continue;
        }
        break;
      }
    }
    throw lastErr;
  })().finally(() => inflight.delete(key));

  inflight.set(key, task);
  return task;
}

/**
 * 搜索歌曲
 * @param {{source?:string,name:string,count?:number,pages?:number}} q
 */
export async function searchTracks(q) {
  const { source = 'netease', name, count = 20, pages = 1 } = q || {};
  if (!name || !String(name).trim()) {
    const err = new Error('搜索关键字不能为空');
    err.code = 'BAD_REQUEST';
    throw err;
  }
  const data = await callApi(
    { types: 'search', source, name: String(name).trim(), count, pages },
    { ttlMs: 60 * 1000, priority: PRIORITY.high }
  );
  const list = Array.isArray(data) ? data : [];
  return list.map(normalizeTrack);
}

/**
 * 获取播放地址
 */
export async function getTrackUrl({ source = 'netease', id, br = 320 }) {
  const data = await callApi(
    { types: 'url', source, id, br },
    { ttlMs: 5 * 60 * 1000, priority: PRIORITY.high }
  );
  if (!data || !data.url) {
    const err = new Error('未找到该歌曲的播放地址');
    err.code = 'NO_URL';
    throw err;
  }
  return { url: data.url, br: data.br ?? br, size: data.size ?? null };
}

/**
 * 封面地址本地缓存：picId -> url。
 * 同一张专辑的封面在所有曲目间共用，缓存后可大幅减少上游请求。
 * 使用磁盘缓存，重启后依然生效。
 */
const picCache = new Map();
const PIC_CACHE_FILE = path.join(process.cwd(), '.cache', 'pics.json');

function loadPicCache() {
  try {
    const raw = fs.readFileSync(PIC_CACHE_FILE, 'utf8');
    const obj = JSON.parse(raw);
    for (const [k, v] of Object.entries(obj)) picCache.set(k, v);
  } catch {
    /* 首次运行没有缓存文件 */
  }
}

let picCacheDirty = false;

function savePicCache() {
  if (!picCacheDirty) return;
  picCacheDirty = false;
  try {
    fs.mkdirSync(path.dirname(PIC_CACHE_FILE), { recursive: true });
    fs.writeFileSync(PIC_CACHE_FILE, JSON.stringify(Object.fromEntries(picCache)), 'utf8');
  } catch {
    /* 缓存写失败不影响功能 */
  }
}

loadPicCache();
setInterval(savePicCache, 10_000).unref?.();

/** 获取封面地址（低优先级：宁可慢，也不要挡住播放） */
export async function getTrackPic({ source = 'netease', id, size = 300 }) {
  const key = `${source}:${id}:${size}`;
  const cached = picCache.get(key);
  if (cached) return { url: cached };
  const data = await callApi(
    { types: 'pic', source, id, size },
    { ttlMs: 24 * 60 * 60 * 1000, priority: PRIORITY.low, retries: 2 }
  );
  const url = data?.url ?? null;
  if (url) {
    picCache.set(key, url);
    picCacheDirty = true;
  }
  return { url };
}

/** 获取歌词 */
export async function getTrackLyric({ source = 'netease', id }) {
  const data = await callApi(
    { types: 'lyric', source, id },
    { ttlMs: 10 * 60 * 1000, priority: PRIORITY.high }
  );
  return {
    lyric: typeof data?.lyric === 'string' ? data.lyric : '',
    tlyric: typeof data?.tlyric === 'string' ? data.tlyric : '',
  };
}

/** 上游搜索返回的原始曲目结构 */
function normalizeTrack(raw) {
  return {
    id: String(raw.id ?? ''),
    name: raw.name ?? '',
    artist: Array.isArray(raw.artist) ? raw.artist : raw.artist ? [raw.artist] : [],
    album: raw.album ?? '',
    pic_id: raw.pic_id ? String(raw.pic_id) : null,
    lyric_id: raw.lyric_id ? String(raw.lyric_id) : null,
    source: raw.source ?? 'netease',
    url: null,
    pic: null,
    br: null,
    size: null,
  };
}

/**
 * 批量补全封面地址。
 *
 * 上游限流只有 50 次/5 分钟，如果让浏览器为每条搜索结果各发一次
 * 封面请求，很快就会把配额耗尽，导致播放地址、歌词拿不到。
 * 因此在服务端一次性把封面解析好，客户端直接用 img.src。
 */
async function attachPics(tracks, size = 300) {
  // 同一张专辑只查一次
  const byPicId = new Map();
  for (const t of tracks) {
    if (t.pic_id && !byPicId.has(t.pic_id)) byPicId.set(t.pic_id, []);
    if (t.pic_id) byPicId.get(t.pic_id).push(t);
  }

  const ids = [...byPicId.keys()];
  await Promise.all(
    ids.map(async (picId) => {
      try {
        const { url } = await getTrackPic({ source: 'netease', id: picId, size });
        for (const t of byPicId.get(picId)) t.pic = url;
      } catch {
        for (const t of byPicId.get(picId)) t.pic = null;
      }
    })
  );
  return tracks;
}

/** 供路由层使用的规范化入口 */
export const musicApi = {
  searchTracks,
  getTrackUrl,
  getTrackPic,
  getTrackLyric,
  normalizeTrack,
  attachPics,
};

export default musicApi;
