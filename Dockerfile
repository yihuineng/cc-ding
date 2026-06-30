# ================================================
# cc-ding Docker 部署镜像
# 基于 Playwright 镜像（内置 Chromium 等浏览器）
# 预装: Claude Code、pm2（cc-ding 每次启动时安装最新版）
# ================================================
FROM mcr.microsoft.com/playwright:v1.61.0-noble

LABEL maintainer="cc-ding"
LABEL description="cc-ding Docker 部署镜像 - 基于 Playwright，内置 Claude Code + pm2"

# ── 环境变量 ──────────────────────────────────────────
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=0 \
    PNPM_HOME=/usr/local/share/pnpm

# ── 安装 Node.js 22（如镜像自带版本 < 22）────────────
RUN CURRENT_NODE=$(node -v 2>/dev/null | sed 's/v//' | cut -d. -f1) && \
    if [ -z "$CURRENT_NODE" ] || [ "$CURRENT_NODE" -lt 22 ]; then \
      echo "📦 安装 Node.js 22 (当前: ${CURRENT_NODE:-未安装})..." && \
      curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
      apt-get install -y nodejs && \
      apt-get clean && rm -rf /var/lib/apt/lists/*; \
    else \
      echo "✅ Node.js $(node -v) 已满足要求"; \
    fi

# ── 全局安装基础工具 ───────────────────────────────────
# Claude Code: Anthropic 官方 AI 编程工具
# pm2: Node.js 进程管理器（用于同时启动 console + a2a-server）
# 注意: cc-ding 不在镜像中预装，每次启动时通过 npm 安装最新版
RUN npm install -g @anthropic-ai/claude-code pm2 && \
    npm cache clean --force

# ── 创建数据目录 ───────────────────────────────────────
RUN mkdir -p /root/.cc-ding /root/.playwright

# ── 暴露端口 ───────────────────────────────────────────
# 8080: cc-ding Console Web 管理界面
# 3000: cc-ding A2A Hub 服务
EXPOSE 8080 3000

# ── 数据卷（持久化配置）────────────────────────────────
VOLUME ["/root/.cc-ding"]

# ── 启动入口 ───────────────────────────────────────────
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENTRYPOINT ["docker-entrypoint.sh"]
