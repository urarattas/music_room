# Docker 部署

## 快速开始

### 方式一：docker compose（推荐）

```bash
# 启动（后台运行）
docker compose up -d

# 查看日志
docker compose logs -f

# 查看状态（含健康检查结果）
docker compose ps

# 停止并移除容器
docker compose down
```

启动后访问 **http://localhost:3000**。

### 方式二：docker run

```bash
# 构建镜像
docker build -t music-room .

# 运行
docker run -d \
  --name music-room \
  -p 3000:3000 \
  --restart unless-stopped \
  music-room
```

常用参数：

| 参数 | 说明 |
| --- | --- |
| `-p 3000:3000` | 端口映射，左边是宿主机端口 |
| `-e PORT=8080` | 改容器内端口（需同步改 `-p` 的右边） |
| `-e TZ=Asia/Shanghai` | 时区 |
| `--restart unless-stopped` | 崩溃自动重启、停止时不自动启动 |

---

## 镜像设计

### 多阶段构建

```
deps 阶段                        runtime 阶段
├─ node:22-alpine                ├─ node:22-alpine
├─ 拷贝 package.json             ├─ apk add tini
├─ pnpm install --prod           ├─ 拷贝生产 node_modules
└─                               ├─ 拷贝 server/ public/
                                  ├─ USER node（非 root）
                                  ├─ HEALTHCHECK
                                  └─ ENTRYPOINT tini + CMD node
```

- **依赖阶段**先拷贝 `package.json` 再安装，利用 Docker 层缓存 ——
  只要依赖清单没变，重新构建时这一层直接复用。
- **只装生产依赖**（`--prod`），不会把 `puppeteer-core` 等测试工具打进镜像。
- **运行阶段**只拷贝 `server/` 与 `public/`，测试与文档不进镜像。

### 镜像体积

服务端**零运行时依赖**（WebSocket 是自研实现），所以生产依赖为空，
镜像大小基本就是 `node:22-alpine` 本身的体积（约 130MB）。

### 安全

- 以 `USER node`（uid 1000）运行，**不是 root**
- 服务端只读文件、不写磁盘，因此可以配合只读根文件系统运行
- `.dockerignore` 排除了 `.git`、`.env`、`node_modules` 等

### 信号处理

用 `tini` 作为 PID 1，转发 `SIGTERM` / `SIGINT` 给 Node 进程，
因此 `docker stop` 会让服务**优雅退出**而不是被强杀（`SIGKILL`）。

### 健康检查

容器内每 30 秒请求一次 `/api/health`，失败 3 次标记为 `unhealthy`：

```bash
docker inspect --format '{{.State.Health.Status}}' music-room
```

---

## 配合 Nginx / Caddy 反向代理

> ⚠️ **开麦（麦克风）必须使用 HTTPS**。
> 浏览器只在安全上下文（`https://` 或 `localhost`）下开放 `getUserMedia`，
> 直接用 HTTP + IP 访问时开麦会失败。

```nginx
server {
    listen 443 ssl;
    server_name music.example.com;

    ssl_certificate     /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;

        # WebSocket 升级支持
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host       $host;
        proxy_set_header X-Real-IP  $remote_addr;
    }
}
```

Caddy 更简单，会自动申请证书并处理 WebSocket：

```
music.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

---

## 反向代理后的真实 IP

通过 Nginx 转发时，服务端拿到的 `req.socket.remoteAddress` 是代理的 IP。
当前项目**未使用客户端 IP**（没有按 IP 限流），所以无需额外配置。

如果将来要加"按 IP 限流"或"按 IP 记录成员"，需要在 Nginx 里加：

```nginx
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
```

然后在服务端读取 `req.headers['x-real-ip']`。

---

## 常见问题

### 端口被占用

```bash
# 换端口启动
PORT=8080 docker compose up -d
# 或
docker run -d -p 8080:3000 music-room
```

### 容器起不来 / 反复重启

```bash
docker compose logs --tail=50
```

常见原因：
- 端口冲突 → 换端口
- `HOST` 没设成 `0.0.0.0` → 容器外访问不到

### 重建镜像

```bash
docker compose build --no-cache
docker compose up -d
```

### 查看镜像体积

```bash
docker images music-room
```

---

## 与本机运行的对比

| | 本机 / 脚本 | Docker |
| --- | --- | --- |
| 需要 Node.js | 是 | 容器内自带 |
| 需要 pnpm / npm | 否 | 否（构建时用） |
| 依赖安装 | 不需要（零运行时依赖） | 构建时自动 |
| 端口占用 | 占用宿主机 3000 | 占用宿主机映射的端口 |
| 隔离性 | 无 | 容器隔离 |
| 开机自启 | 需手动 | `--restart unless-stopped` |
