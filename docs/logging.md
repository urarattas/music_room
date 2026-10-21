# 服务端日志

服务端会把运行日志写入 `logs/` 目录，**按天分文件**，超过大小上限自动轮转，过期文件自动清理。

## 日志位置

```
logs/
├── server-2026-10-21.log      # 今天的日志
├── server-2026-10-21.log.1    # 轮转出来的上一份
├── server-2026-10-21.log.2
└── server-2026-10-20.log      # 昨天的（超过保留天数会被删）
```

`logs/` 已加入 `.gitignore`，不会污染仓库。

## 记录内容

| 级别 | 记录什么 |
| --- | --- |
| `ERROR` | 处理消息出错、HTTP 请求失败、未捕获的异常、未处理的 Promise 拒绝 |
| `WARN` | 收到无法解析的消息、无效的曲目、WebSocket 连接错误 |
| `INFO` | 服务启动/停止、WebSocket 连接建立/断开、成员加入/离开/切换房间、播放曲目 |
| `DEBUG` | 收到聊天消息、HTTP 请求详情 |

日志格式：

```
[2026-10-21 12:55:22.942] [INFO ] 服务已启动 {"port":3000,"host":"0.0.0.0","pid":8380,…}
[2026-10-21 12:55:24.375] [INFO ] WebSocket 连接建立 {"connId":"c1","ip":"127.0.0.1","total":1}
[2026-10-21 12:55:24.378] [INFO ] 成员加入房间 {"connId":"c1","ip":"127.0.0.1","name":"小明","room":"大厅","members":1}
[2026-10-21 12:55:25.982] [DEBUG] 收到聊天消息 {"connId":"c1","ip":"127.0.0.1","room":"大厅","name":"小明","length":6}
[2026-10-21 12:55:56.484] [INFO ] WebSocket 连接断开 {"connId":"c1","ip":"127.0.0.1","name":"小明","room":"大厅","remaining":0}
```

每行都带**毫秒级时间戳、级别、消息**，后面的 JSON 是结构化附加信息（连接 ID、客户端 IP、房间、昵称等）。

## 配置

全部通过环境变量控制：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `LOG_LEVEL` | `info` | 最低输出级别：`debug` / `info` / `warn` / `error` |
| `LOG_DIR` | `<项目根>/logs` | 日志目录 |
| `LOG_MAX_SIZE` | `10485760`（10MB） | 单个文件大小上限，超过就轮转 |
| `LOG_MAX_FILES` | `5` | 每个日期最多保留几份轮转文件 |
| `LOG_MAX_DAYS` | `7` | 日志保留天数，超期自动删除 |
| `LOG_CONSOLE` | `1` | 是否同时输出到控制台（`0` 关闭） |

```bash
# 调试时打开详细日志
LOG_LEVEL=debug node server/index.js

# 只看警告和错误，且不输出到控制台
LOG_LEVEL=warn LOG_CONSOLE=0 node server/index.js

# 改日志目录与保留策略
LOG_DIR=/var/log/music-room LOG_MAX_DAYS=30 LOG_MAX_SIZE=52428800 node server/index.js
```

## 轮转与清理规则

**轮转**：当前文件写入前检查大小，超过 `LOG_MAX_SIZE` 就改名成 `.1`，
原来的 `.1` 变成 `.2` …… 超过 `LOG_MAX_FILES` 的最老一份直接删除。

**清理**：服务启动时执行一次，之后每次调用 `cleanup()` 也会执行。
删除规则：
- 主日志文件按**文件名里的日期**判断，超过 `LOG_MAX_DAYS` 就删
- 轮转文件按**修改时间**判断，超过 `LOG_MAX_DAYS` 就删
- 只处理 `server-*.log` 和 `server-*.log.N`，其他文件（别的服务的日志）不受影响

## Docker 部署

容器里的日志目录是 `/app/logs`，compose 已经挂载了卷，容器重建后日志不丢：

```yaml
    volumes:
      - ./logs:/app/logs
```

用 `docker run` 时手动挂：

```bash
docker run -d -p 3000:3000 \
  -v $(pwd)/logs:/app/logs \
  --env LOG_LEVEL=info \
  ghcr.io/urarattas/music_room:latest
```

查看日志：

```bash
# 容器内
docker compose exec music-room tail -f /app/logs/server-$(date +%F).log

# 或者直接看控制台（默认同时输出）
docker compose logs -f
```

## 查看日志概况

`/api/health` 会返回日志统计：

```bash
curl http://localhost:3000/api/health | jq .log
```

```json
{
  "dir": "/app/logs",
  "files": 3,
  "bytes": 52480,
  "level": "info"
}
```

## 异常捕获

服务端安装了全局处理器，把最容易丢失的线索写进日志：

- `uncaughtException` —— 未捕获的异常，记录堆栈后退出（进程状态已不可信）
- `unhandledRejection` —— 未处理的 Promise 拒绝
- `warning` —— Node 自身的警告（如 MaxListeners  exceeded）

## 日志不会拖垮服务

- 写文件失败（磁盘满、权限不足）时**自动降级为只输出控制台**，不影响服务运行
- 日志目录不存在会自动创建
- 目录无法创建时也不会崩溃，只在控制台提示一次
