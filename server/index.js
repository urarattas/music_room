/**
 * 音乐听歌房服务端
 * - HTTP：静态资源 + /api 音乐代理
 * - WebSocket：房间信令、聊天、播放状态同步
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import { musicApi } from './music.js';
import { RoomRegistry } from './rooms.js';
import { getCachedCover, storeCover } from './cover-cache.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

const registry = new RoomRegistry();

/** connId -> { ws, user, room } */
const connections = new Map();
let connSeq = 0;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/* ---------------------------------- HTTP ---------------------------------- */

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error('payload too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}

async function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath);
  if (rel === '/' || rel === '') rel = '/index.html';
  const target = path.resolve(PUBLIC_DIR, '.' + rel);
  if (!target.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const stat = await fsp.stat(target);
    if (stat.isDirectory()) {
      res.writeHead(404).end('not found');
      return;
    }
    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': 'no-cache',
      'content-length': stat.size,
    });
    fs.createReadStream(target).pipe(res);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
  }
}

async function handleApi(req, res, url) {
  const p = url.pathname;
  const q = url.searchParams;

  if (p === '/api/health') {
    return sendJson(res, 200, { ok: true, rooms: registry.rooms.size, uptime: process.uptime() });
  }
  if (p === '/api/rooms') {
    return sendJson(res, 200, { rooms: registry.list() });
  }
  if (p === '/api/search') {
    const list = await musicApi.searchTracks({
      source: q.get('source') || 'netease',
      name: q.get('name') || '',
      count: Math.min(50, Number(q.get('count')) || 20),
      pages: Math.max(1, Number(q.get('pages')) || 1),
    });
    // 立即返回，不等待封面 —— 封面由前端渐进加载（/img/pic），
    // 否则 20+ 个封面请求会把上游配额耗尽，拖垮播放与歌词。
    return sendJson(res, 200, { list });
  }
  if (p === '/api/url') {
    const r = await musicApi.getTrackUrl({
      source: q.get('source') || 'netease',
      id: q.get('id'),
      br: Number(q.get('br')) || 320,
    });
    return sendJson(res, 200, r);
  }
  if (p === '/api/pic') {
    try {
      const r = await musicApi.getTrackPic({
        source: q.get('source') || 'netease',
        id: q.get('id'),
        size: Number(q.get('size')) || 300,
      });
      return sendJson(res, 200, r);
    } catch {
      // 封面缺失不应影响页面
      return sendJson(res, 200, { url: null });
    }
  }
  if (p === '/api/lyric') {
    try {
      const r = await musicApi.getTrackLyric({
        source: q.get('source') || 'netease',
        id: q.get('id'),
      });
      return sendJson(res, 200, r);
    } catch {
      return sendJson(res, 200, { lyric: '', tlyric: '' });
    }
  }
  return sendJson(res, 404, { error: 'unknown api' });
}

/**
 * 提供封面图片。
 *
 * 优先返回本地缓存的图片（快，且不消耗上游配额）；
 * 未命中时向上游要地址、把图片存到本地，再返回。
 */
async function handlePicRedirect(req, res, url) {
  const q = url.searchParams;
  const source = q.get('source') || 'netease';
  const id = q.get('id');
  const size = Number(q.get('size')) || 300;
  if (!id) {
    res.writeHead(400).end();
    return;
  }
  const key = `${source}_${id}_${size}`;

  // 命中本地缓存
  const cached = getCachedCover(key);
  if (cached) {
    await serveCachedImage(res, cached);
    return;
  }

  try {
    const r = await musicApi.getTrackPic({ source, id, size });
    if (!r.url) {
      res.writeHead(404).end();
      return;
    }
    // 下载并缓存到本地
    const local = await storeCover(key, r.url);
    if (local) {
      await serveCachedImage(res, local);
      return;
    }
    // 下载失败则直接跳转
    res.writeHead(302, {
      location: r.url,
      'cache-control': 'public, max-age=86400',
    });
    res.end();
  } catch {
    res.writeHead(404).end();
  }
}

/** 返回本地缓存的图片文件 */
async function serveCachedImage(res, filePath) {
  try {
    const stat = await fsp.stat(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'image/jpeg',
      'content-length': stat.size,
      'cache-control': 'public, max-age=604800',
    });
    fs.createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404).end();
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
    });
    res.end();
    return;
  }
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }
    if (url.pathname === '/img/pic') {
      await handlePicRedirect(req, res, url);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end('method not allowed');
      return;
    }
    await serveStatic(req, res, url.pathname);
  } catch (err) {
    const code = err?.code === 'BAD_REQUEST' ? 400 : err?.code === 'RATE_LIMITED' ? 429 : 500;
    sendJson(res, code, { error: err?.message || 'internal error', code: err?.code || 'INTERNAL' });
  }
});

/* --------------------------------- WebSocket -------------------------------- */

const wss = new WebSocketServer({ server, path: '/ws' });

function sendTo(ws, type, payload = {}) {
  if (!ws || ws.readyState !== 1) return;
  try {
    ws.send(JSON.stringify({ t: type, ...payload }));
  } catch {
    /* ignore */
  }
}

function broadcast(room, type, payload = {}) {
  for (const user of room.users.values()) {
    sendTo(user.ws, type, payload);
  }
}

function broadcastUsers(room) {
  broadcast(room, 'users', { users: room.publicUsers() });
}

function broadcastMusic(room) {
  broadcast(room, 'music', { state: room.musicState() });
}

function broadcastPlaylist(room) {
  broadcast(room, 'playlist', { list: room.playlist });
}

async function ensureTrackUrl(room, track) {
  if (!track) return null;
  if (track.url) return track;
  try {
    const { url, br, size } = await musicApi.getTrackUrl({
      source: track.source || 'netease',
      id: track.id,
      br: 320,
    });
    track.url = url;
    track.br = br;
    track.size = size;
    return track;
  } catch (err) {
    // 播放地址获取失败，尝试一次不带 source 的调用
    try {
      const { url, br, size } = await musicApi.getTrackUrl({ id: track.id, br: 320 });
      track.url = url;
      track.br = br;
      track.size = size;
      return track;
    } catch {
      console.warn('[music] 获取播放地址失败:', track.id, err?.message);
      return track;
    }
  }
}

async function playTrack(room, track, pos = 0) {
  await ensureTrackUrl(room, track);
  room.setTrack(track, { playing: true, pos: Math.max(0, Number(pos) || 0) });
  broadcastMusic(room);
}

wss.on('connection', (ws, req) => {
  const connId = `c${++connSeq}`;
  connections.set(connId, { ws, user: null, room: null });

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return sendTo(ws, 'error', { msg: '消息格式错误' });
    }
    const conn = connections.get(connId);
    if (!conn) return;

    try {
      switch (msg.t) {
        case 'join': {
          const wantRoom = String(msg.room || 'lobby').trim() || 'lobby';

          // 已经在房间里：先离开旧房间（可能是切换房间）
          if (conn.room) {
            if (conn.room.id === wantRoom) {
              // 同一房间重复 join：忽略
              break;
            }
            const old = conn.room;
            old.removeUser(conn.user.id);
            broadcast(old, 'chat', {
              from: { id: 'system', name: '系统' },
              text: `${conn.user.name} 离开了房间`,
              ts: Date.now(),
              system: true,
            });
            broadcastUsers(old);
            if (old.isEmpty()) registry.cleanup();
            conn.room = null;
            conn.user = null;
          }

          const room = registry.join(wantRoom, msg.name);
          const user = room.addUser(ws, { name: msg.name });
          conn.user = user;
          conn.room = room;
          sendTo(ws, 'welcome', {
            selfId: user.id,
            room: { id: room.id, name: room.name },
            users: room.publicUsers(),
            playlist: room.playlist,
            music: room.musicState(),
            serverTime: Date.now(),
          });
          broadcast(room, 'room', { room: { id: room.id, name: room.name } });
          broadcastUsers(room);
          // 通知新成员加入
          broadcast(room, 'chat', {
            from: { id: 'system', name: '系统' },
            text: `${user.name} 加入了房间`,
            ts: Date.now(),
            system: true,
          });
          break;
        }

        case 'chat': {
          const { room, user } = conn;
          if (!room || !user) return sendTo(ws, 'error', { msg: '尚未加入房间' });
          const text = String(msg.text ?? '').slice(0, 1000);
          if (!text.trim()) return;
          const entry = {
            from: { id: user.id, name: user.name },
            text,
            ts: Date.now(),
          };
          room.addChat(entry);
          broadcast(room, 'chat', entry);
          break;
        }

        case 'music.play': {
          const { room } = conn;
          if (!room) return sendTo(ws, 'error', { msg: '尚未加入房间' });
          const track = msg.track;
          if (!track || !track.id) return sendTo(ws, 'error', { msg: '无效的曲目' });
          room.addToPlaylist(track);
          await playTrack(room, track, msg.pos);
          broadcastPlaylist(room);
          break;
        }

        case 'music.pause': {
          const { room } = conn;
          if (!room) return;
          room.setPlaying(false);
          broadcastMusic(room);
          break;
        }

        case 'music.seek': {
          const { room } = conn;
          if (!room) return;
          room.seek(msg.pos);
          broadcastMusic(room);
          break;
        }

        case 'music.volume': {
          const { room } = conn;
          if (!room) return;
          room.setVolume(msg.v);
          broadcastMusic(room);
          break;
        }

        case 'playlist.add': {
          const { room } = conn;
          if (!room) return;
          if (room.addToPlaylist(msg.track)) broadcastPlaylist(room);
          break;
        }

        case 'playlist.remove': {
          const { room } = conn;
          if (!room) return;
          if (room.removeFromPlaylist(String(msg.trackId))) broadcastPlaylist(room);
          break;
        }

        case 'playlist.next':
        case 'playlist.prev': {
          const { room } = conn;
          if (!room) return;
          const cur = room.music.track?.id;
          const next =
            msg.t === 'playlist.next' ? room.nextTrack(cur) : room.prevTrack(cur);
          if (!next) return;
          await playTrack(room, next, 0);
          break;
        }

        case 'rtc.signal': {
          const { room, user } = conn;
          if (!room || !user) return;
          const target = room.getUser(String(msg.to));
          if (!target) return;
          sendTo(target.ws, 'signal', { from: user.id, data: msg.data });
          break;
        }

        case 'rtc.mic': {
          const { room, user } = conn;
          if (!room || !user) return;
          user.mic = !!msg.on;
          broadcast(room, 'mic', { id: user.id, on: user.mic });
          break;
        }

        case 'ping': {
          sendTo(ws, 'pong', { ts: msg.ts, serverTime: Date.now() });
          break;
        }

        default:
          break;
      }
    } catch (err) {
      console.warn('[ws] 处理消息出错:', err?.message);
      sendTo(ws, 'error', { msg: err?.message || '服务器错误' });
    }
  });

  ws.on('close', () => {
    const conn = connections.get(connId);
    connections.delete(connId);
    if (!conn || !conn.room || !conn.user) return;
    const room = conn.room;
    room.removeUser(conn.user.id);
    broadcast(room, 'chat', {
      from: { id: 'system', name: '系统' },
      text: `${conn.user.name} 离开了房间`,
      ts: Date.now(),
      system: true,
    });
    broadcastUsers(room);
    if (room.isEmpty()) registry.cleanup();
  });

  ws.on('error', () => {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`🎵 音乐听歌房已启动: http://localhost:${PORT}`);
  console.log(`   WebSocket: ws://localhost:${PORT}/ws`);
  console.log(`   音乐来源: GD Studio 音乐台 API (music.gdstudio.org)`);
});

export { server, registry };
