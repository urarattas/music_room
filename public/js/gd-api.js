/**
 * GD 音乐台 API —— 浏览器直连客户端
 *
 * 架构说明：
 * 服务端**不再代理**音乐 API，只负责广播曲目 ID 与元数据。
 * 每个客户端在收到广播后，各自独立向上游请求播放地址 / 封面 / 歌词，
 * 音频由浏览器直接从上游 CDN 拉取。
 *
 * 好处：
 * - 服务端完全不碰上游，不再受上游 50 次/5 分钟的配额限制
 * - 播放流量不经过服务端，带宽成本为零
 * - 每个客户端可以自行选择音质（br），互不影响
 *
 * 上游文档：https://music-api.gdstudio.xyz/api.php
 * 上游已开启 CORS（Access-Control-Allow-Origin: *），浏览器可直连。
 */

const UPSTREAM = 'https://music-api.gdstudio.xyz/api.php';

/** 各个音源搜索时需要的额外参数 */
const SOURCE_PARAMS = {
  netease: {},
  joox: { type: 'song' },
  bilibili: {},
  tencent: { type: 'song' },
  kuwo: { type: 'song' },
  apple: { type: 'song' },
  ytmusic: { type: 'song' },
  tidal: { type: 'song' },
  qobuz: { type: 'song' },
  spotify: { type: 'song' },
};

/* ------------------------------ 本地缓存 ------------------------------ */

/** key -> value，TTL 由各接口自行决定 */
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

/** 相同 key 的并发请求合并为一次 */
const inflight = new Map();

/* ------------------------------ 底层请求 ------------------------------ */

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
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(key, {
          signal: controller.signal,
          headers: { accept: 'application/json' },
        });
        if (!res.ok) {
          const err = new Error(`音乐服务返回 ${res.status}`);
          err.code = res.status === 503 ? 'UPSTREAM_BUSY' : 'UPSTREAM_ERROR';
          err.status = res.status;
          throw err;
        }
        const text = await res.text();
        let data;
        try {
          data = JSON.parse(text);
        } catch {
          const err = new Error('音乐服务返回了无法解析的内容');
          err.code = 'BAD_PAYLOAD';
          throw err;
        }
        return ttlMs > 0 ? cacheSet(key, data, ttlMs) : data;
      } catch (err) {
        lastErr = err;
        // 503 / 网络抖动时退避重试
        if (err.code === 'UPSTREAM_BUSY' && attempt < retries) {
          await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
          continue;
        }
        break;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr;
  })().finally(() => inflight.delete(key));

  inflight.set(key, task);
  return task;
}

/* ------------------------------ 对外接口 ------------------------------ */

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
  const extra = SOURCE_PARAMS[source] || {};
  const data = await callApi(
    {
      types: 'search',
      source,
      name: String(name).trim(),
      count,
      pages,
      ...extra,
    },
    { ttlMs: 60 * 1000 }
  );
  const list = Array.isArray(data) ? data : [];
  return list.map(normalizeTrack);
}

/**
 * 获取播放地址
 * 播放地址约 20 分钟过期，因此缓存时间较短。
 */
export async function getTrackUrl({ source = 'netease', id, br = 320 }) {
  const data = await callApi(
    { types: 'url', source, id, br },
    { ttlMs: 4 * 60 * 1000 }
  );
  if (!data || !data.url) {
    const err = new Error(source === 'netease'
      ? '该歌曲暂无可用播放地址'
      : `该音源（${source}）暂不可用，请换用网易云音源`);
    err.code = 'NO_URL';
    err.source = source;
    throw err;
  }
  return { url: data.url, br: data.br ?? br, size: data.size ?? null };
}

/**
 * 获取封面地址
 * 注意：bilibili 等音源的 pic_id 本身就是完整 URL。
 */
export async function getTrackPic({ source = 'netease', id, size = 300 }) {
  if (!id) return { url: null };
  // 已经是完整 URL（bilibili 等）
  if (/^https?:\/\//i.test(id)) {
    return { url: withSize(id, size) };
  }
  const data = await callApi(
    { types: 'pic', source, id, size },
    { ttlMs: 24 * 60 * 60 * 1000, retries: 1 }
  );
  return { url: data?.url ?? null };
}

/** 获取歌词 */
export async function getTrackLyric({ source = 'netease', id }) {
  const data = await callApi(
    { types: 'lyric', source, id },
    { ttlMs: 10 * 60 * 1000 }
  );
  return {
    lyric: typeof data?.lyric === 'string' ? data.lyric : '',
    tlyric: typeof data?.tlyric === 'string' ? data.tlyric : '',
  };
}

/** 上游搜索返回的原始曲目结构 → 统一结构 */
export function normalizeTrack(raw) {
  return {
    id: String(raw.id ?? ''),
    name: raw.name ?? '',
    artist: Array.isArray(raw.artist) ? raw.artist : raw.artist ? [raw.artist] : [],
    album: raw.album ?? '',
    pic_id: raw.pic_id ? String(raw.pic_id) : null,
    lyric_id: raw.lyric_id ? String(raw.lyric_id) : null,
    source: raw.source ?? 'netease',
  };
}

/** 给已经是完整 URL 的封面追加尺寸参数 */
function withSize(url, size) {
  if (!size) return url;
  if (/param=/.test(url)) return url;
  return `${url}${url.includes('?') ? '&' : '?'}param=${size}y${size}`;
}

export const gdApi = {
  searchTracks,
  getTrackUrl,
  getTrackPic,
  getTrackLyric,
  normalizeTrack,
  UPSTREAM,
};

/**
 * 音源可用性探测。
 *
 * 上游部分音源的 `types=url` 端点会返回空地址（例如 joox 实测 0/30 可用），
 * 搜索能出结果但播不了。这里主动探测一次，避免用户白搜一场。
 *
 * @param {string} source
 * @returns {Promise<{ok:boolean, message:string}>}
 */
export async function probeSource(source = 'netease') {
  try {
    const list = await searchTracks({ source, name: '周杰伦', count: 3, pages: 1 });
    if (!list.length) {
      return { ok: false, message: `「${source}」音源没有搜索结果` };
    }
    // 用第一条真实曲目试取播放地址
    const t = list[0];
    try {
      const { url } = await getTrackUrl({ source, id: t.id, br: 128 });
      if (url) return { ok: true, message: '' };
      return { ok: false, message: `「${source}」音源暂无播放地址` };
    } catch (err) {
      return { ok: false, message: err?.message || `「${source}」音源不可用` };
    }
  } catch (err) {
    return { ok: false, message: err?.message || `「${source}」音源不可用` };
  }
}

gdApi.probeSource = probeSource;

export default gdApi;
