# ============================================================
#  音乐听歌房 · Music Room
#
#  多阶段构建：
#  - deps 阶段：只装生产依赖（服务端本身零运行时依赖，这里留作扩展余地）
#  - runtime 阶段：只拷贝运行所需文件，镜像精简
#
#  构建：docker build -t music-room .
#  运行：docker run -d -p 3000:3000 --name music-room music-room
# ============================================================

# ---------- 构建阶段：安装生产依赖 ----------
FROM node:22-alpine AS deps

WORKDIR /app

# 先拷贝清单文件，利用 Docker 层缓存：
# 只要 package.json 没变，重新构建时这层不会失效
COPY package.json ./

# 只装生产依赖（--omit=dev），避免把 puppeteer-core 等测试工具打进镜像。
# 这里用 npm 而非 pnpm：npm 生成的是扁平目录结构，跨 stage 拷贝时
# 不会有 pnpm 虚拟存储的符号链接问题。
#
# 当前生产依赖为空，npm 可能不会创建 node_modules 目录，
# 后面 COPY 会因源路径不存在而失败 —— 所以先确保目录存在。
RUN npm install --omit=dev --no-audit --no-fund \
  && mkdir -p /app/node_modules

# ---------- 运行阶段 ----------
FROM node:22-alpine AS runtime

# tini 作为 PID 1：转发信号并回收僵尸进程，
# 保证 `docker stop` 时 Node 能优雅退出
RUN apk add --no-cache tini

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0

# 生产依赖（当前服务端零运行时依赖，此处为空，后续加依赖时自动生效）
COPY --from=deps /app/node_modules ./node_modules

# 运行所需文件
COPY server ./server
COPY public ./public
COPY package.json ./

# 日志目录：交给 node 用户写入。
# 容器里建议挂载卷持久化：docker run -v $(pwd)/logs:/app/logs
RUN mkdir -p /app/logs && chown -R node:node /app/logs

# OCI 元数据：让镜像在 GHCR / Docker Hub 上显示来源与说明，
# 并把容器包与本仓库关联起来（GITHUB_TOKEN 推送时需要这个标签）
LABEL org.opencontainers.image.title="音乐听歌房 Music Room" \
      org.opencontainers.image.description="在线多人音乐听歌房：浏览器直连 GD 音乐台 API，WebRTC P2P 语音 + 文字聊天" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.source="https://github.com/urarattas/music_room" \
      org.opencontainers.image.vendor="urarattas"

# 日志配置（可用环境变量覆盖）
ENV LOG_DIR=/app/logs \
    LOG_LEVEL=info \
    LOG_MAX_SIZE=10485760 \
    LOG_MAX_FILES=5 \
    LOG_MAX_DAYS=7

# 以非 root 用户运行
USER node

EXPOSE 3000

# 健康检查：容器内自检，服务异常时 Docker 能感知
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# tini 作为 PID 1，node 作为子进程
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server/index.js"]
