# Web Console 管理界面

cc-ding 内置了一个 Web 管理界面（Console），提供浏览器可视化的方式来管理所有客户端、会话、API Key 和辅助文件。

## 启动

通过 `/open console` 命令或手动启动：

```bash
cc-ding console          # 默认端口 8080，自动打开浏览器
cc-ding console --port 9090  # 指定端口
cc-ding console --no-browser  # 不打开浏览器
```

启动后访问 `http://localhost:8080` 即可打开管理界面。

## 登录认证

- 默认账号：`admin` / `admin`
- 首次登录强制要求修改密码
- 登录后获得 Bearer Token，24 小时有效
- Token 存储在内存中，重启 Console 后失效

## 配置 Console 端口和账号

在 `~/.cc-ding/config.json` 中配置：

```json
{
  "console": {
    "port": 8080,
    "host": "0.0.0.0",
    "authUsers": [
      {
        "account": "admin",
        "passwordHash": "<sha256>",
        "firstLogin": false
      }
    ]
  }
}
```

## 功能总览

### 系统状态

首页显示系统概览：
- cc-ding 版本、Node.js 版本、平台信息
- 客户端总数、在线客户端数

### 客户端管理

| 功能 | 说明 |
|------|------|
| 客户端列表 | 显示所有客户端，含在线状态、PID、会话数量、API Key 数量 |
| 新建客户端 | 创建新的 cc-ding 实例配置（clientId、clientSecret、dingToken 等） |
| 查看配置 | 脱敏显示客户端配置（密钥自动掩码） |
| 编辑配置 | 通过 dot-path 路径更新任意配置字段 |
| 原始配置 | 直接查看/编辑 config.json 原始内容 |
| 热重载 | 发送 SIGUSR2 信号让运行中的实例重新加载配置 |

### 会话管理

| 功能 | 说明 |
|------|------|
| 添加会话 | 为新群/单聊创建配置 |
| 更新会话 | 修改会话参数（标题、模型、QA 模式、流式等） |
| 删除会话 | 移除群配置 |

支持的会话字段：`conversationId`、`conversationType`、`conversationTitle`、`dingToken`、`mobile`、`whiteUserList`、`agent`、`model`、`useLocalOcr`、`atSender`、`receiveReply`、`receiveReplyMode`、`ackReaction`、`qaMode`、`freedomMode`、`streaming`、`permissionMode`、`preBash`、`linkConversationId`、`ensureAt`、`maxTurnTimeMins`、`taskCfg`、`qaCfg`、`envs`

### API Key 管理

| 功能 | 说明 |
|------|------|
| 查看列表 | 显示所有 API Key，含状态（isValid）、模型、备注（脱敏显示） |
| 添加 Key | 新增一个 Claude API Key 配置 |
| 编辑 Key | 修改 baseUrl、model、smallModel、memo、isValid |
| 删除 Key | 移除指定 API Key |
| 重置状态 | 将所有 API Key 重置为有效（清除限额耗尽标记） |

### 辅助文件管理

支持在线查看和编辑以下客户端辅助文件：

| 文件名 | 用途 |
|--------|------|
| `menu.json` | 自定义菜单配置 |
| `model.json` | 模型配置 |
| `cron.json` | 定时任务配置 |
| `todo.json` | 待办事项 |
| `user-map.json` | 手机号到 userId 映射 |
| `active.json` | 活跃会话记录 |

编辑时自动备份原文件（`.bak`），使用原子写入（先写 `.tmp` 再 rename）。

### pm2 进程管理

| 功能 | 说明 |
|------|------|
| 查看状态 | 显示 PID、状态、内存、CPU、重启次数、运行时间 |
| 重启进程 | 确认后立即重启 cc-ding client 进程 |

### 远程 Console 管理（v1.2.1+）

支持通过 HTTP API 跨机器管理 cc-ding clients，无需 SSH。

#### 架构

```
主 Console (http://localhost:8080)
    ↓ HTTP API (Bearer Token)
从 Console (http://192.168.1.100:8080)
    ↓ 管理本地 clients
~/.cc-ding/<clientId>/config.json
```

#### 配置

在 `~/.cc-ding/config.json` 中添加 `remoteConsoles`：

```json
{
  "console": {
    "port": 8080,
    "host": "0.0.0.0",
    "authUsers": [...],
    "remoteConsoles": [
      {
        "url": "http://192.168.1.100:8080",
        "token": "从 Console 的 Bearer Token",
        "clientIds": ["client-a", "client-b"]
      }
    ]
  }
}
```

#### 使用步骤

1. **从机器**：启动 cc-ding console，登录获取 Bearer Token
   ```bash
   cc-ding console
   # 登录 admin/admin → 获取 token
   ```

2. **主机器**：Console → 全局配置 → 远程 Console 管理 → 添加
   - 填入从机器 console 地址
   - 填入 Bearer Token
   - 填入管理的 client IDs（逗号分隔）

3. **管理远程 clients**：
   - 客户端列表显示远程标识（鼠标悬停显示来源地址）
   - 点击远程 client 可查看/编辑配置
   - 点击「📊 状态」查看远程 pm2 状态
   - 点击「🔄 重启」远程重启进程

#### 支持的远程操作

| API | 说明 |
|-----|------|
| `GET /api/clients/:id/config` | 查看配置（脱敏） |
| `PATCH /api/clients/:id/config` | 更新配置 |
| `GET /api/clients/:id/pm2` | 查看 pm2 状态 |
| `POST /api/clients/:id/pm2/restart` | 重启进程 |
