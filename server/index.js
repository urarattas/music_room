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

import { WebSocketServer } from './ws.js';
import { RoomRegistry } from './rooms.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

/**
 * GD 音乐台上游地址。
 * 服务端不会调用它，仅告知客户端，让浏览器直连。
 */
const UPSTREAM = 'https://music-api.gdstudio.xyz/api.php';

/** 新成员加入时补发的聊天记录条数 */
const CHAT_HISTORY_ON_JOIN = 50;

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

/**
 * 服务端自身的接口。
 *
 * 注意：**这里不再代理音乐 API**。
 * 音乐相关的数据（搜索结果、播放地址、封面、歌词）全部由浏览器直连
 * GD 音乐台获取，服务端只负责广播曲目 ID 与元数据。
 * 这样服务端完全不消耗上游配额，音频流量也不经过服务器。
 */
function handleApi(req, res, url) {
  const p = url.pathname;

  if (p === '/api/health') {
    return sendJson(res, 200, {
      ok: true,
      rooms: registry.rooms.size,
      uptime: process.uptime(),
      // 告知客户端上游地址，便于前端直连
      upstream: UPSTREAM,
    });
  }
  if (p === '/api/rooms') {
    return sendJson(res, 200, { rooms: registry.list() });
  }
  if (p === '/api/config') {
    return sendJson(res, 200, { upstream: UPSTREAM });
  }
  return sendJson(res, 404, { error: 'unknown api' });
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
      handleApi(req, res, url);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end('method not allowed');
      return;
    }
    await serveStatic(req, res, url.pathname);
  } catch (err) {
    sendJson(res, 500, { error: err?.message || 'internal error' });
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

/**
 * 规范化客户端提交的曲目。
 *
 * 服务端只保留 **ID 与元数据**，不包含播放地址 ——
 * 每个客户端收到广播后，会各自独立向上游获取播放地址并直连播放。
 */
function sanitizeTrack(raw) {
  if (!raw || !raw.id) return null;
  return {
    id: String(raw.id),
    name: String(raw.name ?? ''),
    artist: Array.isArray(raw.artist) ? raw.artist.map(String) : raw.artist ? [String(raw.artist)] : [],
    album: String(raw.album ?? ''),
    pic_id: raw.pic_id ? String(raw.pic_id) : null,
    lyric_id: raw.lyric_id ? String(raw.lyric_id) : null,
    source: String(raw.source ?? 'netease'),
  };
}

function playTrack(room, track, pos = 0) {
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
          // 把最近的聊天记录补发给新成员（否则中途加入的人看不到之前的对话）
          for (const entry of room.chatHistory.slice(-CHAT_HISTORY_ON_JOIN)) {
            sendTo(ws, 'chat', entry);
          }
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
          const track = sanitizeTrack(msg.track);
          if (!track) return sendTo(ws, 'error', { msg: '无效的曲目' });
          room.addToPlaylist(track);
          playTrack(room, track, msg.pos);
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
          const track = sanitizeTrack(msg.track);
          if (!track) return;
          if (room.addToPlaylist(track)) broadcastPlaylist(room);
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
          playTrack(room, next, 0);
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
  console.log(`   音乐来源: GD Studio 音乐台 API（浏览器直连，服务端不代理）`);
  console.log(`   上游地址: ${UPSTREAM}`);
});

export { server, registry };
