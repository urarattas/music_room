# 内部通信协议（WebSocket + HTTP）

WebSocket 端点：`ws://<host>:<port>/ws`（同源，前端使用 `location` 构造）。

所有消息均为 JSON 文本帧，字段 `t` 表示消息类型。

> **重要**：服务端**不代理音乐 API**。它只广播曲目 **ID 与元数据**，
> 每个客户端收到广播后，各自直连 `https://music-api.gdstudio.xyz/api.php`
> 获取播放地址 / 封面 / 歌词，并直接从上游 CDN 拉流播放。

## 数据结构

```ts
Track = {
  id: string,          // 曲目 ID（track_id）—— 各客户端据此向上游取地址
  name: string,
  artist: string[],    // 歌手数组
  album: string,
  pic_id: string,      // 封面 ID（bilibili 等音源本身即为完整 URL）
  lyric_id: string,
  source: string       // netease / joox / bilibili ...
}
// 注意：Track 中**没有** url / br / size —— 播放地址由各客户端独立获取

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

服务端只提供房间相关接口，**没有任何音乐代理接口**：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/rooms` | 房间列表：`{rooms:[{id,name,users,capacity}]}` |
| GET | `/api/health` | 健康检查：`{ok, rooms, uptime, upstream}` |
| GET | `/api/config` | 返回 `{upstream}`，告知客户端上游地址 |

音乐数据由客户端直连上游获取（上游已开启 `Access-Control-Allow-Origin: *`）：

| 上游参数 | 说明 |
| --- | --- |
| `types=search&source=&name=&count=&pages=` | 搜索歌曲 |
| `types=url&source=&id=&br=` | 获取播放地址 |
| `types=pic&source=&id=&size=` | 获取封面地址 |
| `types=lyric&source=&id=` | 获取歌词 |

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
5. **播放地址由各客户端独立获取**：
   - 收到曲目变化的 `music` 消息后，本客户端向 GD 音乐台请求该曲目的播放地址
     （`types=url&source=&id=&br=`），并**直接从上游 CDN 拉流**播放
   - 客户端本地缓存播放地址约 4 分钟；上游 URL 有效期约 20 分钟
   - 播放失败（地址过期 / 网络问题）时，客户端自动重新取一次地址
   - 各客户端可选择不同音质（128 / 192 / 320 / 740 无损），互不影响
6. 服务端广播的曲目**不含播放地址**，因此某客户端取地址失败不会影响其他成员。

## WebRTC 语音（Mesh）

- 每位用户加入房间后，向房间内已有成员各发起一次 `offer`（发起方为新加入者，避免 glare）。
- SDP/ICE 通过 `rtc.signal` 经服务端中转。
- 麦克风轨道在 `getUserMedia` 成功后加入；静音时使用 `track.enabled = false`，避免重新协商。
- 每位远端成员对应一个 `<audio autoplay>` 元素播放其音轨。
- 麦克风状态（开/关）通过 `rtc.mic` 广播，用于 UI 显示。
- STUN：`stun:stun.l.google.com:19302`、`stun:stun1.l.google.com:19302`。
