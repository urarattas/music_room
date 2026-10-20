import { RoomClient } from './ws.js';
import { MusicPlayer } from './player.js';
import { ChatPanel } from './chat.js';
import { SearchPanel } from './search.js';
import { VoiceRoom } from './rtc.js';
import { LyricPanel } from './lyrics.js';

const $ = (id) => document.getElementById(id);

const el = {
  roomInput: $('room-input'),
  roomJoin: $('room-join'),
  copyLink: $('copy-link'),
  nameInput: $('name-input'),
  connState: $('conn-state'),
  searchForm: $('search-form'),
  searchInput: $('search-input'),
  searchSource: $('search-source'),
  searchStatus: $('search-status'),
  searchResults: $('search-results'),
  playlist: $('playlist'),
  playlistCount: $('playlist-count'),
  cover: $('cover'),
  coverPlaceholder: $('cover-placeholder'),
  npTitle: $('np-title'),
  npArtist: $('np-artist'),
  npAlbum: $('np-album'),
  btnPrev: $('btn-prev'),
  btnPlay: $('btn-play'),
  btnNext: $('btn-next'),
  seek: $('seek'),
  timeCurrent: $('time-current'),
  timeTotal: $('time-total'),
  volume: $('volume'),
  volumeLabel: $('volume-label'),
  audio: $('audio'),
  members: $('members'),
  memberCount: $('member-count'),
  btnMic: $('btn-mic'),
  micHint: $('mic-hint'),
  micLevel: $('mic-level'),
  chatList: $('chat-list'),
  chatForm: $('chat-form'),
  chatInput: $('chat-input'),
  lyricList: $('lyric-list'),
  lyricTabs: document.querySelector('.lyric-tabs'),
};

const STORAGE = { name: 'mr_name', room: 'mr_room' };

const params = new URLSearchParams(location.search);
const urlRoom = params.get('room');
let roomName = urlRoom || localStorage.getItem(STORAGE.room) || '大厅';
let userName = localStorage.getItem(STORAGE.name) || '';

el.roomInput.value = roomName;
el.nameInput.value = userName;
el.nameInput.placeholder = userName || '你的昵称';

if (!userName) {
  userName = `听众${Math.floor(Math.random() * 900 + 100)}`;
  el.nameInput.value = userName;
  localStorage.setItem(STORAGE.name, userName);
}

/* ------------------------------ 客户端实例 ------------------------------ */

const client = new RoomClient({ room: roomName, name: userName, autoJoin: true });
const player = new MusicPlayer({ client, audioEl: el.audio });
const voice = new VoiceRoom({ client });
const lyrics = new LyricPanel({ listEl: el.lyricList, tabsEl: el.lyricTabs });

/** 当前加载歌词的曲目，避免重复请求 */
let lyricTrackId = null;

client.knownUsers = [];
client.on('open', () => setConnState(true));
client.on('close', () => setConnState(false));
client.on('pong', (m) => client.onPong(m));

const chat = new ChatPanel({
  client,
  listEl: el.chatList,
  formEl: el.chatForm,
  inputEl: el.chatInput,
});

const search = new SearchPanel({
  listEl: el.searchResults,
  formEl: el.searchForm,
  inputEl: el.searchInput,
  sourceEl: el.searchSource,
  statusEl: el.searchStatus,
  onPick: (track) => playNow(track),
  onAdd: (track) => {
    client.send('playlist.add', { track });
    el.searchStatus.textContent = `已加入队列：${track.name}`;
  },
});

/* ------------------------------ 连接状态 ------------------------------ */

function setConnState(online) {
  el.connState.textContent = online ? '已连接' : '未连接';
  el.connState.className = 'conn-state ' + (online ? 'online' : 'offline');
}

/* ------------------------------ 播放控制 ------------------------------ */

function playNow(track) {
  client.send('music.play', { track, pos: 0 });
}

el.btnPlay.onclick = () => player.toggle();
el.btnPrev.onclick = () => client.send('playlist.prev', {});
el.btnNext.onclick = () => client.send('playlist.next', {});

let seeking = false;
el.seek.addEventListener('pointerdown', () => (seeking = true));
el.seek.addEventListener('pointerup', () => (seeking = false));
el.seek.addEventListener('input', () => {
  if (!player.duration) return;
  const pos = (Number(el.seek.value) / 1000) * player.duration;
  el.timeCurrent.textContent = fmtTime(pos);
});
el.seek.addEventListener('change', () => {
  if (!player.duration) return;
  const pos = (Number(el.seek.value) / 1000) * player.duration;
  player.seek(pos);
  seeking = false;
});

el.volume.addEventListener('input', () => {
  const v = Number(el.volume.value);
  el.volumeLabel.textContent = `${v}%`;
  el.audio.volume = v / 100;
});
el.volume.addEventListener('change', () => {
  player.setVolume(Number(el.volume.value) / 100);
});

function fmtTime(ms) {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const total = Math.floor(ms / 1000);
  const m = String(Math.floor(total / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${m}:${s}`;
}

/* ------------------------------ 播放器事件 ------------------------------ */

player.on('state', (state) => {
  el.btnPlay.textContent = state.playing ? '⏸' : '▶';
  const t = state.track;
  el.npTitle.textContent = t ? t.name : '未在播放';
  el.npArtist.textContent = t ? (t.artist || []).join(' / ') || '未知歌手' : '—';
  el.npAlbum.textContent = t ? t.album || '—' : '—';
  el.volume.value = Math.round((state.volume ?? 1) * 100);
  el.volumeLabel.textContent = `${el.volume.value}%`;
  if (t?.pic_id) {
    el.cover.src = `/img/pic?source=${encodeURIComponent(t.source)}&id=${encodeURIComponent(t.pic_id)}&size=500`;
    el.cover.classList.add('visible');
    el.coverPlaceholder.style.display = 'none';
  } else {
    el.cover.classList.remove('visible');
    el.coverPlaceholder.style.display = 'flex';
  }
});

player.on('duration', (d) => {
  el.timeTotal.textContent = fmtTime(d);
});

player.on('time', (pos) => {
  el.timeCurrent.textContent = fmtTime(pos);
  if (!seeking && player.duration) {
    el.seek.value = String(Math.min(1000, Math.round((pos / player.duration) * 1000)));
  }
  lyrics.update(pos);
});

player.on('track', (track) => {
  loadLyrics(track);
});

/** 拉取并展示歌词 */
async function loadLyrics(track) {
  if (!track?.lyric_id) {
    lyricTrackId = null;
    lyrics.clear();
    return;
  }
  const key = `${track.source}:${track.lyric_id}`;
  if (key === lyricTrackId) return;
  lyricTrackId = key;
  try {
    const params = new URLSearchParams({
      source: track.source || 'netease',
      id: track.lyric_id,
    });
    const res = await fetch(`/api/lyric?${params}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    // 防止竞态：期间已切歌
    if (lyricTrackId !== key) return;
    lyrics.setLyrics(data);
  } catch {
    if (lyricTrackId === key) lyrics.clear();
  }
}

player.on('error', (e) => {
  el.micHint.textContent = e?.msg || '播放出现问题';
  console.warn('[player]', e?.msg);
});

player.on('blocked', () => {
  el.micHint.textContent = '浏览器阻止了自动播放，请点击播放按钮';
});

/* ------------------------------ 房间事件 ------------------------------ */

client.on('welcome', (msg) => {
  client.knownUsers = msg.users || [];
  renderMembers(msg.users || []);
  renderPlaylist(msg.playlist || []);
  player.applyServerState(msg.music);
  el.micHint.textContent = '开麦后成员之间可语音聊天';
});

client.on('users', (msg) => {
  client.knownUsers = msg.users || [];
  renderMembers(msg.users || []);
});

client.on('music', (msg) => player.applyServerState(msg.state));

client.on('playlist', (msg) => renderPlaylist(msg.list || []));

client.on('mic', (msg) => {
  const u = (client.knownUsers || []).find((x) => x.id === msg.id);
  if (u) u.mic = msg.on;
  renderMembers(client.knownUsers || []);
});

client.on('error', (e) => {
  el.micHint.textContent = e?.msg || '发生错误';
});

/* ------------------------------ 成员渲染 ------------------------------ */

const COLORS = ['#5b8cff', '#7c5bff', '#35d07f', '#ff8f5b', '#ff5b6e', '#43c6ff', '#c05bff'];

function renderMembers(users) {
  el.members.innerHTML = '';
  el.memberCount.textContent = String(users.length);
  users.forEach((u, i) => {
    const li = document.createElement('li');
    li.className = 'member';
    const av = document.createElement('div');
    av.className = 'avatar';
    av.textContent = (u.name || '?').slice(0, 1).toUpperCase();
    av.style.background = `linear-gradient(135deg, ${COLORS[i % COLORS.length]}, ${COLORS[(i + 3) % COLORS.length]})`;
    const nm = document.createElement('span');
    nm.className = 'member-name';
    nm.textContent = u.name;
    const mic = document.createElement('span');
    mic.className = 'mic-icon ' + (u.mic ? 'on' : 'off');
    mic.textContent = u.mic ? '🎙' : '🔇';
    mic.title = u.mic ? '正在开麦' : '已静音';
    li.append(av, nm, mic);
    if (u.id === client.selfId) {
      const tag = document.createElement('span');
      tag.className = 'member-tag';
      tag.textContent = '我';
      li.appendChild(tag);
    }
    el.members.appendChild(li);
  });
}

/* ------------------------------ 播放列表渲染 ------------------------------ */

function renderPlaylist(list) {
  el.playlist.innerHTML = '';
  el.playlistCount.textContent = String(list.length);
  list.forEach((track, idx) => {
    const li = document.createElement('li');
    li.className = 'track-item';
    const img = document.createElement('img');
    img.alt = '';
    if (track.pic_id) {
      img.src = `/img/pic?source=${encodeURIComponent(track.source)}&id=${encodeURIComponent(track.pic_id)}&size=300`;
      img.onerror = () => img.remove();
    }
    const meta = document.createElement('div');
    meta.className = 'track-meta';
    const nm = document.createElement('div');
    nm.className = 'track-name';
    nm.textContent = `${idx + 1}. ${track.name}`;
    const sub = document.createElement('div');
    sub.className = 'track-sub';
    sub.textContent = (track.artist || []).join(' / ');
    meta.append(nm, sub);
    const rm = document.createElement('button');
    rm.className = 'icon-btn';
    rm.textContent = '✕';
    rm.title = '移除';
    rm.onclick = (e) => {
      e.stopPropagation();
      client.send('playlist.remove', { trackId: track.id });
    };
    li.append(img, meta, rm);
    li.onclick = () => playNow(track);
    el.playlist.appendChild(li);
  });
}

/* ------------------------------ 麦克风 ------------------------------ */

el.btnMic.onclick = async () => {
  el.btnMic.disabled = true;
  try {
    if (voice.micEnabled) {
      voice.setMicEnabled(false);
      el.btnMic.textContent = '🎙 开麦';
      el.btnMic.classList.remove('active');
      el.micHint.textContent = '已静音';
    } else {
      const ok = await voice.start();
      if (ok === false) return; // start() 内部已报告错误
      el.btnMic.textContent = '🔇 静音';
      el.btnMic.classList.add('active');
      el.micHint.textContent = '正在开麦，其他人可听到你';
    }
  } finally {
    el.btnMic.disabled = false;
  }
};

voice.on('level', (v) => {
  el.micLevel.style.width = `${Math.min(100, Math.round(v * 160))}%`;
});

voice.on('error', (e) => {
  el.micHint.textContent = e?.msg || '麦克风出错';
  // 仅致命错误（拿不到麦克风）才复位按钮；协商类错误只提示
  if (e?.fatal) {
    el.btnMic.textContent = '🎙 开麦';
    el.btnMic.classList.remove('active');
  }
});

voice.on('remoteStream', ({ id, stream }) => {
  const audio = document.createElement('audio');
  audio.autoplay = true;
  audio.id = `peer-${id}`;
  audio.srcObject = stream;
  document.body.appendChild(audio);
});

voice.on('peers', (peers) => {
  window.__voicePeers = peers;
});

/* ------------------------------ 房间切换 / 邀请 ------------------------------ */

el.roomJoin.onclick = () => {
  const next = el.roomInput.value.trim() || '大厅';
  if (next === roomName) return;
  roomName = next;
  localStorage.setItem(STORAGE.room, next);
  client.room = next;
  client.close();
  setTimeout(() => client.connect(), 200);
};

el.nameInput.onchange = () => {
  const next = el.nameInput.value.trim();
  if (!next) return;
  userName = next;
  localStorage.setItem(STORAGE.name, next);
  el.nameInput.placeholder = next;
  el.micHint.textContent = '昵称已保存（重新进入房间后生效）';
};

el.copyLink.onclick = async () => {
  const url = new URL(location.href);
  url.searchParams.set('room', roomName);
  try {
    await navigator.clipboard.writeText(url.toString());
    el.micHint.textContent = '房间链接已复制';
  } catch {
    prompt('复制房间链接：', url.toString());
  }
};

/* ------------------------------ 启动 ------------------------------ */

// 便于调试与自动化测试
window.__client = client;
window.__voice = voice;
window.__player = player;

client.connect();
window.addEventListener('beforeunload', () => client.close());
