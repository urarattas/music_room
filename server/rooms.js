/**
 * 房间管理：成员、播放列表、播放状态、聊天记录
 */
import { randomUUID } from 'node:crypto';
import { musicApi } from './music.js';

const MAX_USERS_PER_ROOM = 20;
const MAX_CHAT_HISTORY = 200;
const PLAYLIST_MAX = 200;

export class Room {
  constructor(id, name) {
    this.id = id;
    this.name = name;
    this.users = new Map(); // userId -> { id, name, mic, joinedAt, ws }
    this.playlist = []; // Track[]
    this.chatHistory = [];
    this.music = {
      track: null,
      playing: false,
      pos: 0, // 播放位置 ms
      startAt: 0, // 服务端 epoch ms，playing 时有效
      serverTime: Date.now(),
      volume: 1,
      updatedAt: Date.now(),
    };
    this.createdAt = Date.now();
  }

  get userCount() {
    return this.users.size;
  }

  addUser(ws, { name }) {
    const id = randomUUID();
    const user = {
      id,
      name: String(name || '匿名听众').slice(0, 24),
      mic: false,
      joinedAt: Date.now(),
      ws,
    };
    this.users.set(id, user);
    return user;
  }

  removeUser(userId) {
    this.users.delete(userId);
  }

  getUser(userId) {
    return this.users.get(userId);
  }

  publicUsers() {
    return [...this.users.values()].map((u) => ({
      id: u.id,
      name: u.name,
      mic: u.mic,
      joinedAt: u.joinedAt,
    }));
  }

  isEmpty() {
    return this.users.size === 0;
  }

  addChat(entry) {
    this.chatHistory.push(entry);
    if (this.chatHistory.length > MAX_CHAT_HISTORY) {
      this.chatHistory.splice(0, this.chatHistory.length - MAX_CHAT_HISTORY);
    }
  }

  addToPlaylist(track) {
    if (!track || !track.id) return false;
    if (this.playlist.some((t) => t.id === track.id && t.source === track.source)) return false;
    this.playlist.push(track);
    if (this.playlist.length > PLAYLIST_MAX) this.playlist.shift();
    return true;
  }

  removeFromPlaylist(trackId) {
    const idx = this.playlist.findIndex((t) => t.id === trackId);
    if (idx >= 0) {
      this.playlist.splice(idx, 1);
      return true;
    }
    return false;
  }

  /** 推进到下一首（返回新曲目或 null） */
  nextTrack(currentId) {
    if (!this.playlist.length) return null;
    const idx = this.playlist.findIndex((t) => t.id === currentId);
    const next = this.playlist[(idx + 1 + this.playlist.length) % this.playlist.length];
    return next || null;
  }

  prevTrack(currentId) {
    if (!this.playlist.length) return null;
    const idx = this.playlist.findIndex((t) => t.id === currentId);
    const prev = this.playlist[(idx - 1 + this.playlist.length) % this.playlist.length];
    return prev || null;
  }

  /** 生成对外的播放状态 */
  musicState() {
    return {
      track: this.music.track,
      playing: this.music.playing,
      pos: this.currentPos(),
      startAt: this.music.startAt,
      serverTime: Date.now(),
      volume: this.music.volume,
      updatedAt: this.music.updatedAt,
    };
  }

  currentPos() {
    const { playing, pos, startAt } = this.music;
    if (!playing) return pos;
    return Math.max(0, Date.now() - startAt);
  }

  setTrack(track, { playing = true, pos = 0 } = {}) {
    this.music.track = track;
    this.music.pos = pos;
    this.music.playing = playing;
    this.music.startAt = playing ? Date.now() - pos : 0;
    this.music.updatedAt = Date.now();
    this.music.serverTime = this.music.updatedAt;
  }

  setPlaying(playing) {
    if (!this.music.track) return;
    if (playing) {
      const pos = this.currentPos();
      this.music.startAt = Date.now() - pos;
    } else {
      this.music.pos = this.currentPos();
    }
    this.music.playing = playing;
    this.music.updatedAt = Date.now();
    this.music.serverTime = this.music.updatedAt;
  }

  seek(pos) {
    if (!this.music.track) return;
    const p = Math.max(0, Number(pos) || 0);
    this.music.pos = p;
    if (this.music.playing) this.music.startAt = Date.now() - p;
    this.music.updatedAt = Date.now();
    this.music.serverTime = this.music.updatedAt;
  }

  setVolume(v) {
    let vol = Number(v);
    if (!Number.isFinite(vol)) vol = 1;
    this.music.volume = Math.min(1, Math.max(0, vol));
    this.music.updatedAt = Date.now();
    this.music.serverTime = this.music.updatedAt;
  }
}

export class RoomRegistry {
  constructor() {
    this.rooms = new Map();
  }

  /** 通过 id 或名称查找/创建房间 */
  join(roomIdOrName, name) {
    const key = String(roomIdOrName || 'lobby').trim();
    if (!key) key = 'lobby';
    let room = this.rooms.get(key);
    if (!room) {
      // 名称归一化：允许用显示名加入同名房间
      const norm = key.toLowerCase();
      for (const r of this.rooms.values()) {
        if (r.name.toLowerCase() === norm) {
          room = r;
          break;
        }
      }
    }
    if (!room) {
      if (this.rooms.size >= 100) {
        const err = new Error('服务器房间数量已达上限');
        err.code = 'ROOM_LIMIT';
        throw err;
      }
      room = new Room(key, key);
      this.rooms.set(key, room);
    }
    if (room.userCount >= MAX_USERS_PER_ROOM) {
      const err = new Error('房间已满');
      err.code = 'ROOM_FULL';
      throw err;
    }
    return room;
  }

  get(id) {
    return this.rooms.get(id);
  }

  list() {
    return [...this.rooms.values()].map((r) => ({
      id: r.id,
      name: r.name,
      users: r.userCount,
      capacity: MAX_USERS_PER_ROOM,
      playing: r.music.playing ? r.music.track?.name ?? null : null,
    }));
  }

  cleanup() {
    for (const [id, room] of this.rooms) {
      if (room.isEmpty()) this.rooms.delete(id);
    }
  }
}

export { musicApi, MAX_USERS_PER_ROOM };
