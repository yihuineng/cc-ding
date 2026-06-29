#!/bin/bash
# cc-ding Docker 容器入口脚本
# 默认启动 cc-ding console（Web 管理界面）
# 也可通过 docker run <image> <command> 覆盖执行其他命令

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

# 检查 cc-ding 命令
if ! command -v cc-ding &>/dev/null; then
  echo "❌ cc-ding 命令未找到，请重新构建镜像"
  exit 1
fi
echo "✅ cc-ding $(cc-ding --version 2>/dev/null || echo '已安装')"

# 确保数据目录存在
mkdir -p /root/.cc-ding

# ─────────────────────────────────────────────────────
# 启动服务
# ─────────────────────────────────────────────────────

# 默认命令: 启动 Console Web 管理界面
# 可通过 docker run <image> <cmd> 覆盖
set -- cc-ding console "$@"

echo ""
echo "🚀 启动: $*"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# exec 替换当前进程为 cc-ding console，使其成为 PID 1
# 容器停止时 SIGTERM 会直接发给 cc-ding，支持优雅退出
exec "$@"
