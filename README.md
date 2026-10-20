# 音乐听歌房 · Music Room

在线多人音乐听歌房：**音乐由服务器提供**（GD Studio 音乐台 API），**用户之间 P2P 连接**（WebRTC 语音），
并支持**文字聊天**与**播放进度同步**。

![进入房间](docs/screenshot-gate.png)

![界面预览](docs/screenshot.png)

## 功能特性

| 模块 | 说明 |
| --- | --- |
| 🚪 进入房间 | 独立的入口页，先填写昵称与房间号再进入听歌界面；显示当前有人的房间便于快速加入 |
| 🎵 音乐来源 | 服务端代理 [GD 音乐台 API](https://music.gdstudio.xyz/api.php)，支持 `netease` / `joox` / `bilibili` 等音源 |
| 🔍 搜索 | 歌名 / 歌手 / 专辑关键字搜索，30 条分页 |
| 📻 播放同步 | 服务端维护权威播放状态（曲目 / 播放中 / 位置），客户端用时钟偏移估算对齐，误差 > 350ms 自动校正 |
| 🎤 开麦语音 | WebRTC Mesh P2P，成员之间点对点传输语音；使用完美协商（perfect negotiation）避免信令冲突 |
| 💬 文字聊天 | 房间内实时聊天，系统消息提示进房 / 离房 |
| 📃 歌词 | LRC 解析 + 逐行高亮滚动，支持原文 / 翻译切换 |
| 🖼️ 封面 | 服务端本地缓存 + 前端渐进加载，只拉取可视区域内的封面 |
| 👥 成员列表 | 头像、昵称、开麦状态指示 |
| 🔗 房间邀请 | 房间名 + 分享链接（`?room=<房间名>`） |

## 技术栈

- **服务端**：Node.js 18+（原生 `http`）+ `ws`（WebSocket）
- **前端**：原生 ES Module，无构建步骤、无框架
- **实时通信**：WebSocket（信令 / 聊天 / 状态同步）
- **语音**：WebRTC（`RTCPeerConnection` + STUN）

## 快速开始

```bash
# 1. 安装依赖
pnpm install      # 或 npm install

# 2. 启动服务
pnpm start        # 或 npm start

# 3. 打开浏览器
#    http://localhost:3000
```

自定义端口：

```bash
PORT=8080 pnpm start
```

### 局域网 / 公网访问

监听地址默认为 `0.0.0.0`，同一局域网内的其他设备可直接访问：

```bash
PORT=3000 HOST=0.0.0.0 pnpm start
# 朋友访问 http://<你的局域网IP>:3000/?room=房间名
```

> ⚠️ **开麦必须使用 HTTPS 或 localhost**。
> 浏览器只在安全上下文（`https://` 或 `localhost`）下开放 `getUserMedia`。
> 部署到公网时请在前面加一层 Nginx / Caddy 反向代理并配置 TLS，否则开麦按钮会失败。

## 使用方式

1. 打开页面先在**入口页**填写昵称与房间号，点「进入听歌房」。
   房间号相同的人会进入同一个房间；入口页还会列出当前有人的房间，点击可快速填入。
2. 左栏搜索歌曲，点 `▶` 立即播放并同步给全房间；点 `+` 只加入播放队列。
3. 任意成员切歌 / 暂停 / 拖动进度条，其他成员的播放器会自动对齐。
4. 点右上「🔇 开麦」授权麦克风，即可与其他成员语音聊天；再次点击静音。
5. 点「🔗 邀请」复制房间链接分享给朋友。
6. 顶部房间号可以直接改，点「进入」即切换到新房间（无需刷新）。

## 目录结构

```
music_room/
├── server/
│   ├── index.js        # HTTP 服务 + WebSocket 入口
│   ├── music.js        # GD Studio API 客户端（优先级队列 / 缓存 / 限流 / 重试）
│   ├── cover-cache.js  # 封面本地磁盘缓存
│   └── rooms.js        # 房间、成员、播放列表、播放状态
├── public/
│   ├── index.html
│   ├── styles.css
│   └── js/
│       ├── main.js         # 应用装配 + 入口页流程
│       ├── ws.js           # WebSocket 客户端（含时钟校准）
│       ├── player.js       # 同步播放器
│       ├── rtc.js          # WebRTC Mesh 语音
│       ├── chat.js         # 聊天面板
│       ├── search.js       # 搜索面板
│       ├── cover-loader.js # 封面渐进加载器
│       └── lyrics.js       # 歌词解析与滚动
├── test/
│   ├── integration.test.js   # 服务端 + WebSocket 集成测试
│   └── ui.test.js            # 浏览器端到端测试（puppeteer-core）
└── docs/
    ├── protocol.md     # 通信协议
    └── contracts.md    # 前端模块契约
```

## 测试

```bash
# 服务端集成测试（9 项）
node --test test/integration.test.js

# 浏览器端到端测试（25 项，需要本机 Chrome）
node test/ui.test.js
```

UI 测试会真实拉起两个浏览器标签页，验证：入口页流程、搜索、播放同步、
聊天、封面渐进加载、歌词与翻译切换、拖动进度条、开麦状态广播、
以及 **WebRTC 双向音轨是否真正建立**。

Chrome 路径可通过环境变量覆盖：

```bash
CHROME_PATH="C:\Program Files\Google\Chrome\Application\chrome.exe" node test/ui.test.js
```

## API 说明

服务端对外代理的接口（详见 [`docs/protocol.md`](docs/protocol.md)）：

| 路径 | 用途 |
| --- | --- |
| `GET /api/search?source=&name=&count=&pages=` | 搜索歌曲 |
| `GET /api/url?source=&id=&br=` | 获取播放地址 |
| `GET /api/pic?source=&id=&size=` | 获取封面 URL（JSON） |
| `GET /img/pic?source=&id=&size=` | 302 跳转封面，供 `<img src>` 直接使用 |
| `GET /api/lyric?source=&id=` | 获取 LRC 歌词 |
| `GET /api/rooms` | 房间列表 |
| `GET /api/health` | 健康检查 |

### 上游限流处理

GD 音乐台 API 限制为 **5 分钟内不超过 50 次请求**，突发请求会返回 503。
实测上游单次响应约 1.3 秒，且并发超过 4 就会开始失败。服务端为此实现了：

- **优先级串行队列**：所有上游请求排队，彼此至少间隔 350ms；
  播放地址 / 歌词 / 搜索为**高优先级**，封面为**低优先级**，
  封面再多也不会挡住播放
- **请求合并**：相同 URL 的并发请求只发一次上游
- **TTL 缓存**：搜索 60s、播放地址 5min、封面 24h、歌词 10min
- **封面本地缓存**：封面图片下载到 `.cache/covers/`，命中时直接读本地文件
  （实测 5.0s → 0.04s），上游每个 `pic_id` 只被访问一次，重启后依然有效
- **前端渐进加载**：只为**可视区域内**的列表条目请求封面，并发限制为 3，
  滚动时再补其余部分
- **指数退避重试**：503 时自动退避重试

> 如果 `.cache` 目录被清空，首次浏览会有几秒等待（上游较慢），
> 之后所有封面都会从本地秒开。

## 已知限制

- **Mesh 拓扑**：语音为全连接，每个成员都会与房间内其他人建立 P2P 连接。
  适合 3～8 人的小房间；人数更多建议引入 SFU（如 mediasoup / LiveKit）。
- **NAT 对称型**：仅配置了 STUN，未配置 TURN。
  对称型 NAT 环境下部分成员可能无法建立 P2P 连接，
  生产部署建议在 `public/js/rtc.js` 的 `ICE_SERVERS` 中加入 TURN 服务器。
- **播放地址有效期**：上游返回的音频链接约 20 分钟过期，
  失效时客户端会自动重新请求地址。
- **上游可用性**：GD 音乐台 API 属于第三方服务，可能限流或临时不可用。

## 致谢与声明

音乐内容来自 **GD 音乐台（[music.gdstudio.org](https://music.gdstudio.org/)）**，
接口文档见 [music-api.gdstudio.xyz](https://music.gdstudio.xyz/api.php)。
该 API 采用 CC BY-NC 4.0 协议，**仅限学习参考，禁止商用**。

## License

MIT
