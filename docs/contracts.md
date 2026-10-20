# 前端模块契约（`public/js/*`）

无构建步骤，全部为原生 ES Module。页面入口 `public/index.html` 引入 `public/js/main.js`。

## `ws.js` — `export class RoomClient`

```js
const client = new RoomClient({ room: 'room-id', name: '昵称' });
client.connect();                      // 连接 ws(s)://<host>/ws
client.send('chat', { text: 'hello' });
client.on('eventName', (payload) => {});  // 事件: welcome users chat music playlist signal mic error room pong
client.close();
client.offsetMs;                       // 客户端时钟 -> 服务端时钟 的偏移估计
client.serverNow();                    // 估算的服务端当前时间 (ms)
```

事件载荷（服务端 → 客户端）与 `docs/protocol.md` 一致：

- `welcome`: `{ selfId, room:{id,name}, users, playlist, music, serverTime }`
- `users`: `{ users: User[] }`
- `chat`: `{ from:{id,name}, text, ts }`
- `music`: `{ state: MusicState }`
- `playlist`: `{ list: Track[] }`
- `signal`: `{ from, data }`（`data` 为 RTCSessionDescriptionInit 或 RTCIceCandidateInit）
- `mic`: `{ id, on }`
- `error`: `{ msg }`
- `room`: `{ room:{id,name} }`

## `player.js` — `export class MusicPlayer`

```js
const player = new MusicPlayer({ client, audioEl });
player.play(); player.pause(); player.seek(ms); player.setVolume(0..1);
player.on('state', (state) => {});   // 内部同步后的状态
player.on('time', (posMs) => {});    // 时间轴 tick
player.on('track', (track) => {});   // 当前曲目变化
player.state;                        // { track, playing, pos, startAt, volume }
```

职责：
- 收到 `music` 消息后按 `docs/protocol.md` 的播放同步算法校正 `<audio>`。
- 音频地址为跨域 URL，播放前需 `audio.crossOrigin = 'anonymous'`；
  若上游拒绝 CORS 导致 `MediaError`，降级为不带 crossOrigin 播放（此时歌词/进度仍可用）。
- 曲目切换时自动暂停旧音源、加载新音源、seek 到目标位置。

## `rtc.js` — `export class VoiceRoom`（由 rtc 负责实现）

```js
const voice = new VoiceRoom({ client });
voice.start();                         // 获取麦克风并与房间内其他成员建立 P2P 连接
voice.setMicEnabled(true/false);       // 静音切换（不重新协商）
voice.stop();
voice.on('localStream', (stream) => {});   // 本地麦克风流（用于音量条）
voice.on('remoteStream', ({ id, stream }) => {});
voice.on('peers', (peers) => {});          // [{id, name, connected}]
voice.on('error', (err) => {});
```

## `chat.js` — `export class ChatPanel`

```js
const chat = new ChatPanel({ client, listEl, formEl, inputEl });
```

## `search.js` — `export class SearchPanel`

```js
const search = new SearchPanel({ listEl, inputEl, onPick: (track) => {} });
```

- 通过 `GET /api/search?source=&name=&count=&pages=` 搜索。
- 展示歌名 / 歌手 / 专辑 / 封面，点击回调 `onPick(track)`。

## `main.js` — 应用装配

- 读取 `localStorage` 中的昵称与上次房间名。
- 创建 `RoomClient`、`MusicPlayer`、`ChatPanel`、`SearchPanel`、`VoiceRoom`。
- 处理 `welcome` 中的 `users` / `playlist` / `music` 初始状态。
- 渲染成员列表（头像首字母、麦克风图标、房主标记）。
- 提供"开麦/关麦"按钮与房间分享链接。
