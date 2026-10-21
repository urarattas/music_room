#!/usr/bin/env bash
# ============================================================
#  音乐听歌房 - Linux / macOS 启动脚本
#  直接运行：./start.sh
#  无需 pnpm / npm，无需联网装包
# ============================================================

set -euo pipefail

cd "$(dirname "$0")"

# 可修改：端口与监听地址
PORT="${PORT:-3000}"
HOST="${HOST:-0.0.0.0}"

echo
echo "  =========================================="
echo "     音 乐 听 歌 房  ·  Music Room"
echo "  =========================================="
echo

# ---------- 1. 找到 Node.js ----------
if ! command -v node >/dev/null 2>&1; then
  echo "  [1/2] 未找到 Node.js"
  echo
  echo "  请先安装 Node.js 18 或更高版本："
  echo "    https://nodejs.org/"
  echo
  echo "  macOS:   brew install node"
  echo "  Debian:  sudo apt install nodejs"
  echo "  Fedora:  sudo dnf install nodejs"
  echo
  exit 1
fi
echo "  [1/2] 已找到 Node.js"
node -v

# ---------- 2. 检查 Node 版本 ----------
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "  [2/2] Node.js 版本过低（当前 v${NODE_MAJOR}，需要 >= 18）"
  echo "        WebRTC 与原生 ES Module 需要 Node 18 或更高版本"
  echo
  exit 1
fi
echo "  [2/2] Node.js 版本检查通过"

# ---------- 打印访问地址 ----------
LAN_IP=""
if command -v hostname >/dev/null 2>&1; then
  LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
elif command -v ip >/dev/null 2>&1; then
  LAN_IP="$(ip route get 1.1.1.1 2>/dev/null | awk '{print $7; exit}' || true)"
fi

echo
echo "  =========================================="
echo "    启动中..."
echo
echo "    本机访问:   http://localhost:${PORT}"
if [ -n "$LAN_IP" ]; then
  echo "    局域网访问: http://${LAN_IP}:${PORT}"
fi
echo
echo "    停止服务: 按 Ctrl+C"
echo "  =========================================="
echo

# ---------- 启动 ----------
export PORT HOST
exec node server/index.js
