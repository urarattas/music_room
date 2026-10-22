# 前端模块契约（`public/js/*`）

无构建步骤，全部为原生 ES Module。页面入口 `public/index.html` 引入 `public/js/main.js`。

## `gd-api.js` — GD 音乐台 API 客户端（浏览器直连）

```js
import { gdApi } from './gd-api.js';

await gdApi.searchTracks({ source: 'netease', name: '周杰伦', count: 30, pages: 1 });
// → [{ id, name, artist[], album, pic_id, lyric_id, source }]

await gdApi.getTrackUrl({ source: 'netease', id: '5257138', br: 320 });
// → { url, br, size }

await gdApi.getTrackPic({ source: 'netease', id: '109951165671182684', size: 300 });
// → { url }

await gdApi.getTrackLyric({ source: 'netease', id: '5257138' });
// → { lyric, tlyric }

await gdApi.probeSource('joox');
// → { ok: false, message: '该音源（joox）暂不可用，请换用网易云音源' }
```

`probeSource(source)` 会先搜索几条再试取播放地址，用于识别
「搜得到但播不了」的音源（上游部分音源的 `types=url` 端点会返回空地址）。

- **直连上游** `https://music-api.gdstudio.xyz/api.php`（上游已开启 CORS），
  完全不经过我们的服务端。
- **TTL 缓存**：搜索 60s、播放地址 4min、封面 24h、歌词 10min。
- **请求合并**：相同 URL 的并发请求只发一次上游。
- **指数退避重试**：503 时自动退避重试 2 次。
- 不同音源的搜索需要额外参数时，由 `SOURCE_PARAMS` 表处理
  （如 `joox` 需要 `type=song`）。
- `getTrackPic` 会识别 `pic_id` 本身即为完整 URL 的情况（bilibili 等音源）。

## `ws.js` — `export class RoomClient`

```js
const client = new RoomClient({ room: 'room-id', name: '昵称', autoJoin: false });
client.connect();                      // 连接 ws(s)://<host>/ws
client.send('chat', { text: 'hello' });
client.switchRoom('new-room', '昵称');  // 切换房间（复用同一连接）
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
const player = new MusicPlayer({ client, audioEl, quality: 320 });
player.play(); player.pause(); player.seek(ms); player.setVolume(0..1);
player.reload();                       // 重新获取播放地址（例如切换音质后）
player.quality = 192;                  // 修改音质（仅影响本客户端）
player.on('state', (state) => {});     // 内部同步后的状态
player.on('time', (posMs) => {});      // 时间轴 tick
player.on('duration', (ms) => {});     // 曲目总时长（毫秒）
player.on('track', (track) => {});     // 当前曲目变化
player.on('loading', ({track, loading}) => {});  // 正在获取播放地址
player.on('loaded', ({track, url}) => {});        // 播放地址就绪
player.state;                          // { track, playing, pos, startAt, volume }
player.duration;                       // 曲目总时长，**单位毫秒**（与 state.pos 一致）
```

职责：
- 收到 `music` 消息后按 `docs/protocol.md` 的播放同步算法校正 `<audio>`。
- **播放地址由本客户端独立获取**：服务端广播的曲目只有 ID 与元数据，
  本客户端调用 `gdApi.getTrackUrl()` 取直链，再从上游 CDN 直接播放。
- 曲目变化时先取地址，取到后再 `play()`（`_playWhenReady`）。
- 音频地址为跨域 URL，播放前需 `audio.crossOrigin = 'anonymous'`；
  若上游拒绝 CORS 导致 `MediaError`，降级为不带 crossOrigin 播放（此时歌词/进度仍可用）。
- 播放失败时自动重新取一次地址（上游 URL 约 20 分钟过期）。
- **单位约定**：`audio.duration` 原始单位是秒，此处统一换算为毫秒后再暴露，
  避免与 `state.pos` 混用导致进度条计算错误。

## `rtc.js` — `export class VoiceRoom`（由 rtc 负责实现）

```js
const voice = new VoiceRoom({ client });
voice.start();                         // 获取麦克风并与房间内其他成员建立 P2P 连接
voice.setMicEnabled(true/false);       // 静音切换（不重新协商）
voice.removePeer(userId);              // 清理某个成员的连接与音轨
voice.stop();
voice.on('localStream', (stream) => {});   // 本地麦克风流（用于音量条）
voice.on('remoteStream', ({ id, stream, existing }) => {});
voice.on('peerLeft', ({ id }) => {});      // 成员离开
voice.on('peers', (peers) => {});          // [{id, connected, state}]
voice.on('error', (err) => {});
```

- **避免重复音轨**：同一 peer 可能多次触发 `ontrack`（重新协商）。
  `remoteStream` 事件带 `existing` 标记，收到 `existing: true` 时应**替换已有
  `<audio>` 的 srcObject 而不是新建元素**，否则会出现声音叠加。
- **成员离开清理**：客户端收到 `users` 广播后，对比新旧成员列表，
  对已离开的成员调用 `removePeer(id)`，并移除对应的 `<audio>` 元素。

## `chat.js` — `export class ChatPanel`

```js
const chat = new ChatPanel({ client, listEl, formEl, inputEl });
```

## `search.js` — `export class SearchPanel`

```js
const search = new SearchPanel({
  listEl, inputEl, sourceEl, statusEl, moreBtn,
  onPick: (track) => {},
  onAdd: (track) => {},
  coverLoader,
});
```

- 通过 `gdApi.searchTracks({source, name, count, pages})` 搜索（浏览器直连上游）。
- `search(pages, {append})`：`append=true` 时把结果**追加**到列表（翻页），
  重复项按 `source:id` 去重；查询条件变化时自动切换为替换。
- `moreBtn`（可选）：满页时显示「加载更多」按钮，点击请求下一页。
- 展示歌名 / 歌手 / 专辑 / 封面，点击回调 `onPick(track)`，`+` 按钮回调 `onAdd(track)`。

## `cover-loader.js` — `export class CoverLoader`

```js
const loader = new CoverLoader({ concurrency: 3 });
loader.push(img, { source: 'netease', pic_id: '10995...', size: 300 }, priority, opts);
```

- 封面地址由 `gdApi.getTrackPic()` 直连上游获取，图片再从上游 CDN 直接加载，
  **不经过服务端**。
- 并发限制为 3，避免 30 个封面请求同时打爆上游配额。
- 按 `priority` 排序（数字越小越先），当前播放的封面 priority = 0。
- `isVisible(el, container, margin)` 判断元素是否在容器可视区域内，
  搜索列表据此**只为可见条目**请求封面，滚动时再补。
- **同一个 `<img>` 可以重复加载**：`push(..., { reload: true })` 会强制重新取地址。
  主封面复用同一个元素，切歌时必须这样才能换成新图 —— 否则会一直显示上一首的封面。
- 取地址期间若已切歌，过期结果会被丢弃（用 `coverKey` 校验）。

## `lyrics.js` — `export class LyricPanel`

```js
const panel = new LyricPanel({ listEl, tabsEl });
panel.setLyrics({ lyric, tlyric });   // LRC 原文与翻译
panel.update(posMs);                  // 高亮当前行并居中滚动
panel.refresh();                      // 重新居中（尺寸变化后）
panel.clear();
export function parseLrc(lrc);            // → [{time, text}]
export function matchTranslation(lines, tLines);  // → Map<time, text>
```

### 居中显示的两个关键点

1. **用 `getBoundingClientRect` 而不是 `offsetTop`**。
   `offsetTop` 是相对 `offsetParent` 的偏移，歌词容器必须设
   `position: relative`，否则它相对的是页面而非滚动容器，滚动位置会完全跑偏。
2. **上下补足留白**（`_ensurePadding`）。
   歌词总高度可能小于容器高度（只有几行、或容器很高），
   这时首行永远在顶部、无法居中。补上「半个容器高」的上下 padding 后，
   任何一行都能被滚到中央。容器尺寸变化时由 `ResizeObserver` 重新补白。

- **翻译对齐**：上游的原文与翻译时间戳不一定完全相同 —— 实测有的歌两者相差
  50ms（如原文 `[00:01.000]` 对应翻译 `[00:01.050]`）。
  `matchTranslation` 先精确匹配，剩余的用「时间最近且在 150ms 容差内」的原文行兜底，
  否则这些行会被当成"没有翻译"，切到翻译标签页时仍显示原文。
- 翻译模式按**原文行的时间轴**对齐，原文缺失对应翻译时用原文兜底，
  保证切换标签页时行数一致、高亮同步。

## `main.js` — 应用装配

- **入口页流程**：默认显示 `#gate`（昵称 + 房间号），提交后隐藏入口页、
  显示 `#app` 并连接房间；URL 中的 `?room=` 会预填房间号。
  入口页还会拉取 `/api/rooms` 列出当前有人的房间，点击可快速填入。
- 读取 `localStorage` 中的昵称、上次房间名与音质。
- 创建 `RoomClient`、`MusicPlayer`、`ChatPanel`、`SearchPanel`、`VoiceRoom`、`LyricPanel`。
- 处理 `welcome` 中的 `users` / `playlist` / `music` 初始状态。
- 渲染成员列表（头像首字母、麦克风图标、"我"标记）。
- 顶部房间号改动后调用 `client.switchRoom(room, name)` 切换房间，无需刷新。
- 音质下拉框改动后更新 `player.quality` 并调用 `player.reload()`，
  **只影响本客户端**，房间内其他人音质不变。
- 提供"开麦/关麦"按钮与房间分享链接。
