/**
 * GD Studio 音乐台 API 客户端（带缓存与限流保护）
 * 文档：https://music-api.gdstudio.xyz/api.php
 */

const UPSTREAM = 'https://music-api.gdstudio.xyz/api.php';

/** 上游限流：5 分钟内不超过 50 次请求 */
const RATE_LIMIT = { windowMs: 5 * 60 * 1000, max: 50 };

/** 相邻请求最小间隔（ms），避免突发触发上游 503 */
const MIN_REQUEST_INTERVAL = 350;

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

/** 串行队列：所有上游请求排队执行，彼此至少间隔 MIN_REQUEST_INTERVAL */
let chain = Promise.resolve();
let lastRequestAt = 0;

function enqueue(fn) {
  const run = chain.then(async () => {
    const wait = lastRequestAt + MIN_REQUEST_INTERVAL - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRequestAt = Date.now();
    return fn();
  });
  // 保证链条不会因为单次失败而中断
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
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

async function callApi(params, { ttlMs = 0, timeoutMs = 15000, retries = 2 } = {}) {
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
        const data = await enqueue(() => fetchUpstream(key, timeoutMs));
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
    { ttlMs: 60 * 1000 }
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
    { ttlMs: 5 * 60 * 1000 }
  );
  if (!data || !data.url) {
    const err = new Error('未找到该歌曲的播放地址');
    err.code = 'NO_URL';
    throw err;
  }
  return { url: data.url, br: data.br ?? br, size: data.size ?? null };
}

/** 获取封面地址 */
export async function getTrackPic({ source = 'netease', id, size = 300 }) {
  const data = await callApi({ types: 'pic', source, id, size }, { ttlMs: 24 * 60 * 60 * 1000 });
  return { url: data?.url ?? null };
}

/** 获取歌词 */
export async function getTrackLyric({ source = 'netease', id }) {
  const data = await callApi({ types: 'lyric', source, id }, { ttlMs: 10 * 60 * 1000 });
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
    br: null,
    size: null,
  };
}

/** 供路由层使用的规范化入口 */
export const musicApi = {
  searchTracks,
  getTrackUrl,
  getTrackPic,
  getTrackLyric,
  normalizeTrack,
};

export default musicApi;
