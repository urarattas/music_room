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

用 `tini` 作为 PID 1，转发 `SIGTERM` / `SIGINT` 给 Node 进程。
服务端注册了这两个信号的处理器，收到后会：

1. 关闭所有 WebSocket 连接（关闭码 1001）
2. 关闭 HTTP 服务器
3. 以**退出码 0** 结束

因此 `docker stop` 表现为正常停止，而不是被强杀（`SIGKILL`，退出码 137）。
`docker compose down` 同理。

```bash
# 验证退出码
docker stop music-room && docker inspect --format '{{.State.ExitCode}}' music-room
# 期望输出 0
```

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

### CI 报错：Unable to locate executable file: pnpm

说明 `actions/setup-node` 的 `cache: pnpm` 跑在 pnpm 安装之前了。
`setup-node` 需要执行 `pnpm store path` 定位缓存目录，此时 pnpm 还不存在。

修法：把 `pnpm/action-setup` 挪到 `actions/setup-node` **前面**，
并去掉 `setup-node` 里的 `cache: pnpm`（缓存交给 `pnpm/action-setup`）。
详见上方「关于 pnpm 的安装顺序」。

### CI 报错：推送镜像时 denied / 403

说明 `GITHUB_TOKEN` 缺少 `packages: write` 权限。
去 **Settings → Actions → General → Workflow permissions**，
把 "Workflow permissions" 改成 **"Read and write permissions"**。

### CI 报错：403 Forbidden（拉取镜像时）

GHCR 的包默认是私有的。要么登录：

```bash
echo $GITHUB_TOKEN | docker login ghcr.io -u urarattas --password-stdin
```

要么把包改成公开：**Packages → music_room → Package settings → Change visibility → Public**。

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

---

## GitHub Actions 自动构建

仓库已配置 `.github/workflows/docker-publish.yml`，推送代码后会自动构建镜像
并推送到 **GitHub Container Registry (GHCR)**。

### 触发条件

| 事件 | 行为 |
| --- | --- |
| 推送到 `master` / `main` | 构建并推送镜像 |
| 推送 `v*` 标签 | 构建并推送镜像 |
| 拉取请求 (PR) | **只构建不推送**，并验证容器能否正常启动 |
| 手动触发 | 构建并推送镜像 |

### 生成的镜像标签

| 标签 | 示例 | 说明 |
| --- | --- | --- |
| `latest` | `ghcr.io/urarattas/music_room:latest` | 主分支最新 |
| `master` | `...:master` | 分支名 |
| `v1.2.3` | `...:v1.2.3` | 推送的 git 标签 |
| `1.2` / `1.2.3` | `...:1.2` | 从语义化标签推导 |
| `sha-a1b2c3d` | `...:sha-a1b2c3d` | 每次提交都可追溯 |
| `pr-123` | `...:pr-123` | PR 分支（仅构建） |

### 权限说明

**不需要配置任何 secret。** 工作流使用 GitHub 内置的 `GITHUB_TOKEN`：

```yaml
permissions:
  contents: read
  packages: write
```

`GITHUB_TOKEN` 的权限由仓库设置里的
**Settings → Actions → General → Workflow permissions** 决定。
如果默认是 "Read repository contents permissions"，需要改成
**"Read and write permissions"**，否则推送镜像会失败。

> 工作流里已显式声明 `permissions`，把授予范围限制在推送镜像所需的最小权限。

### 拉取镜像

镜像默认是**私有**的。拉取前需要登录：

```bash
echo $GITHUB_TOKEN | docker login ghcr.io -u urarattas --password-stdin
docker pull ghcr.io/urarattas/music_room:latest
```

想让镜像公开：在
**Packages → music_room → Package settings → Change visibility → Public**。

### 首次使用步骤

1. 把代码推到 GitHub（触发第一次构建）
2. 打开仓库的 **Actions** 标签页，确认 `Docker Image` 运行成功
3. 打开 **Packages**，找到 `music_room` 包
4. 需要公开就把可见性改为 Public

### 另有一个 CI 工作流

`.github/workflows/ci.yml` 在每次推送和 PR 时运行测试，
包括**真正执行一次 `docker build`** 来验证 Dockerfile 可用。
两个工作流相互独立：CI 失败不会阻止镜像构建。

### 关于 pnpm 的安装顺序（踩过的坑）

CI 里安装 pnpm 有个**顺序要求**，搞反了会报：

```
Unable to locate executable file: pnpm
```

原因是 `actions/setup-node` 的 `cache: pnpm` 需要执行 `pnpm store path`
来定位缓存目录 —— 如果此时 pnpm 还没装好就会失败。

正确做法是用 `pnpm/action-setup` 装 pnpm（它自带缓存能力），
并**放在 setup-node 之前**：

```yaml
      - name: 安装 pnpm
        uses: pnpm/action-setup@v6.1.0
        with:
          version: 11.28.6
          run_install: false
          cache: true
          cache_dependency_path: pnpm-lock.yaml

      - name: 安装 Node.js
        uses: actions/setup-node@v7.1.0
        with:
          node-version: 22
        # 注意：这里不要再写 cache: pnpm
```

pnpm 版本由 `package.json` 的 `packageManager` 字段统一声明：

```json
"packageManager": "pnpm@11.28.6"
```

本地与 CI 用同一个版本，避免 lockfile 格式被不同版本改写。

### 多架构镜像

构建同时产出 `linux/amd64` 与 `linux/arm64`，
所以同一份镜像能在 x86 服务器和树莓派 / ARM 云主机上运行。

---

## 推送到 Docker Hub（可选）

如果想同时推送到 Docker Hub，需要配置两个 secret：

| Secret | 内容 |
| --- | --- |
| `DOCKERHUB_USERNAME` | Docker Hub 用户名 |
| `DOCKERHUB_TOKEN` | Docker Hub Access Token |

然后在 `docker-publish.yml` 的登录步骤后加一段：

```yaml
      - name: 登录 Docker Hub
        uses: docker/login-action@v4.6.0
        with:
          username: ${{ secrets.DOCKERHUB_USERNAME }}
          password: ${{ secrets.DOCKERHUB_TOKEN }}
```

并在 `metadata-action` 的 `images` 里加上 Docker Hub 镜像名：

```yaml
          images: |
            ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}
            <你的用户名>/music-room
```

构建步骤的 `push` 条件也要改成：

```yaml
          push: ${{ github.event_name != 'pull_request' && secrets.DOCKERHUB_USERNAME != '' }}
```
