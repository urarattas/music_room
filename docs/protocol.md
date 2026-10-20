# 内部通信协议（WebSocket + HTTP）

WebSocket 端点：`ws://<host>:<port>/ws`（同源，前端使用 `location` 构造）。

所有消息均为 JSON 文本帧，字段 `t` 表示消息类型。

## 数据结构

```ts
Track = {
  id: string,          // 曲目 ID（track_id）
  name: string,
  artist: string[],    // 歌手数组
  album: string,
  pic: string,         // 封面 URL（可为 null）
  pic_id: string,
  lyric_id: string,
  source: string,      // netease / joox / bilibili ...
  url?: string,        // 播放地址，由服务端获取
  br?: number,
  size?: number
}

User = {
  id: string,          // 连接级用户 ID
  name: string,
  mic: boolean,        // 是否开麦
  joinedAt: number     // 服务端时间戳（ms）
}

MusicState = {
  track: Track | null, // 当前曲目
  playing: boolean,
  pos: number,         // 播放位置（ms）；当 playing 为 true 时以 startAt 为准
  startAt: number,     // 服务端 epoch ms；playing 时表示曲目开始播放的时刻
  serverTime: number,  // 生成该状态时的服务端时间
  volume: number,      // 0~1
  updatedAt: number
}
```

## HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/search?source=&name=&count=&pages=` | 搜索歌曲，返回 `Track[]`（**不含**封面地址，封面走 `/img/pic`） |
| GET | `/api/url?source=&id=&br=` | 获取播放地址，返回 `{url, br, size}` |
| GET | `/api/pic?source=&id=&size=` | 获取封面 URL，返回 `{url}` |
| GET | `/img/pic?source=&id=&size=` | 返回封面**图片本体**（本地缓存优先），供 `<img src>` 直接使用 |
| GET | `/api/lyric?source=&id=` | 获取歌词，返回 `{lyric, tlyric}` |
| GET | `/api/rooms` | 房间列表：`{rooms:[{id,name,users,capacity}]}` |
| GET | `/api/health` | 健康检查 |

所有 `/api/*` 均代理到 `https://music-api.gdstudio.xyz/api.php` 并在服务端缓存（上游限流 5 分钟 50 次）。

## 客户端 → 服务端

| t | 载荷 | 说明 |
| --- | --- | --- |
| `join` | `{room, name}` | 加入房间（room 为房间 ID 或房间名）。**若已在房间中且 room 不同**，服务端会先让该成员离开旧房间再加入新房间 |
| `chat` | `{text}` | 发送文字消息 |
| `music.play` | `{track, pos?}` | 播放指定曲目（可指定起始位置 ms） |
| `music.pause` | `{}` | 暂停 |
| `music.seek` | `{pos}` | 跳转（ms） |
| `music.volume` | `{v}` | 音量 0~1 |
| `playlist.add` | `{track}` | 加入播放列表 |
| `playlist.remove` | `{trackId}` | 从播放列表移除 |
| `playlist.next` / `playlist.prev` | `{}` | 切歌（由服务端从播放列表推进） |
| `rtc.signal` | `{to, data}` | WebRTC 信令（SDP / ICE）经服务端中转 |
| `rtc.mic` | `{on}` | 开关麦克风 |
| `ping` | `{ts}` | 校时往返探测 |

## 服务端 → 客户端

| t | 载荷 | 说明 |
| --- | --- | --- |
| `welcome` | `{selfId, room:{id,name}, users, playlist, music, serverTime}` | 入房后的初始状态 |
| `room` | `{room:{id,name}}` | 房间信息变更 |
| `users` | `{users}` | 成员列表变更 |
| `chat` | `{from:{id,name}, text, ts}` | 文字消息 |
| `music` | `{state: MusicState}` | 播放状态变更 |
| `playlist` | `{list: Track[]}` | 播放列表变更 |
| `rtc.signal` | `{from, data}` | 中转的 WebRTC 信令 |
| `rtc.mic` | `{id, on}` | 某成员麦克风状态 |
| `pong` | `{ts, serverTime}` | 校时响应 |
| `error` | `{msg}` | 错误提示 |

## 播放同步算法

1. 服务端保存 `startAt`（服务端 epoch ms）与 `serverTime`（该状态生成时刻）。
2. 客户端通过 `ping/pong` 估算时钟偏移：`offset = serverTime - (t0 + t1) / 2`（客户端时钟 → 服务端时钟）。
3. 客户端期望位置 `pos = (serverNow + offset) - startAt`。
4. 收到 `music` 消息或每 2 秒校正一次，若 `|actualPos - expectedPos| > 0.35s` 则 seek，否则保持播放。
5. 播放地址由服务端按需获取并缓存（上游 URL 有有效期，约 20 分钟），获取失败时服务端会重试并广播新的 `music` 消息。

## WebRTC 语音（Mesh）

- 每位用户加入房间后，向房间内已有成员各发起一次 `offer`（发起方为新加入者，避免 glare）。
- SDP/ICE 通过 `rtc.signal` 经服务端中转。
- 麦克风轨道在 `getUserMedia` 成功后加入；静音时使用 `track.enabled = false`，避免重新协商。
- 每位远端成员对应一个 `<audio autoplay>` 元素播放其音轨。
- 麦克风状态（开/关）通过 `rtc.mic` 广播，用于 UI 显示。
- STUN：`stun:stun.l.google.com:19302`、`stun:stun1.l.google.com:19302`。
