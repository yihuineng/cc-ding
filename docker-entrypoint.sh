#!/bin/bash
# cc-ding Docker 容器入口脚本
# 每次启动时安装最新版 cc-ding，然后通过 pm2 同时启动 console + a2a-server

set -e

# ─────────────────────────────────────────────────────
# 环境检查
# ─────────────────────────────────────────────────────

# 检查 Node.js 版本
NODE_MAJOR=$(node -v 2>/dev/null | sed 's/v//' | cut -d. -f1)
if [ -z "$NODE_MAJOR" ] || [ "$NODE_MAJOR" -lt 22 ]; then
  echo "❌ Node.js 版本过低或未安装"
  echo "   当前: $(node -v 2>/dev/null || echo '未安装')"
  echo "   要求: >= 22"
  exit 1
fi
echo "✅ Node.js $(node -v)"

# 检查 claude 命令
if ! command -v claude &>/dev/null; then
  echo "❌ claude 命令未找到，请重新构建镜像"
  exit 1
fi
echo "✅ Claude Code $(claude --version 2>/dev/null || echo '已安装')"

# 确保数据目录存在
mkdir -p /root/.cc-ding

# ─────────────────────────────────────────────────────
# 安装最新版 cc-ding
# ─────────────────────────────────────────────────────

echo ""
echo "📦 安装最新版 cc-ding..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
npm install -g cc-ding@latest
CC_DING_VER=$(cc-ding --version 2>/dev/null || echo 'unknown')
echo "✅ cc-ding $CC_DING_VER"

# ─────────────────────────────────────────────────────
# 启动服务
# ─────────────────────────────────────────────────────

# 如果用户传入了自定义命令，直接执行（覆盖默认行为）
if [ $# -gt 0 ]; then
  # 跳过 -- 分隔符
  [ "$1" = "--" ] && shift
  if [ $# -gt 0 ]; then
    echo ""
    echo "🚀 执行自定义命令: $*"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    exec "$@"
  fi
fi

# 清理残留的 pm2 进程
pm2 kill 2>/dev/null || true

echo ""
echo "🚀 启动 cc-ding 服务..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# 1. Console 服务（必启动）
pm2 start "cc-ding console" \
  --name "cc-ding-console" \
  --log "/root/.cc-ding/logs/console.log" \
  --merge-logs \
  --time

# 2. A2A Hub 服务（可选，通过环境变量启用）
if [ -n "$CC_DING_A2A_API_KEY" ]; then
  A2A_PORT="${CC_DING_A2A_PORT:-3000}"
  A2A_TIMEOUT="${CC_DING_A2A_TIMEOUT:-60}"
  echo "🔗 A2A Hub 已启用 (port=$A2A_PORT, timeout=${A2A_TIMEOUT}s)"
  pm2 start "cc-ding a2a-server --apiKey $CC_DING_A2A_API_KEY --port $A2A_PORT --timeout $A2A_TIMEOUT" \
    --name "cc-ding-a2a" \
    --log "/root/.cc-ding/logs/a2a.log" \
    --merge-logs \
    --time
else
  echo "⚠️  A2A Hub 未启用（设置 CC_DING_A2A_API_KEY 环境变量可启用）"
fi

# 确保日志目录存在
mkdir -p /root/.cc-ding/logs

echo ""
echo "📊 pm2 服务状态:"
pm2 status

echo ""
echo "📌 服务端口:"
echo "  Console: http://0.0.0.0:8080"
if [ -n "$CC_DING_A2A_API_KEY" ]; then
  echo "  A2A Hub: http://0.0.0.0:${CC_DING_A2A_PORT:-3000}"
fi
echo ""
echo "💡 查看日志: docker exec <container> pm2 logs"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# 使用 pm2 logs 保持前台运行并输出日志
# SIGTERM/SIGINT 会被 pm2 捕获并转发给子进程，支持优雅退出
exec pm2 logs --raw
