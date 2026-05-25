# cc-ding

钉钉机器人对接本地 Claude Code 工具，支持群聊多轮对话、任务队列、定时任务等功能。

## 安装

```bash
pnpm i cc-ding -g
cc-ding --help
```

## 快速开始

### 1. 初始化配置

```bash
cc-ding init -ci {clientId} -cs {clientSecret} -m {手机号}
```

- `-ci, --clientId`: 钉钉应用的 ClientId
- `-cs, --clientSecret`: 钉钉 Stream 连接密钥
- `-m, --mobile`: 自己的手机号（自动加入白名单）
- `-cn, --clientName`: 机器人名称（可选，默认 "cc助手"）

### 2. 编辑配置

配置文件位于 `~/.cc-ding/{clientId}/config.json`，需要添加 `conversations` 配置（群聊需配置 `dingToken`）。

### 3. 启动机器人

```bash
# 直接启动
cc-ding run -ci {clientId}

# 推荐：PM2 方式启动
pm2 start --name "cc-ding-{clientId}" npx -- -p cc-ding cc-ding run -ci {clientId}
```

## 数据存储路径

| 数据类型 | 路径 |
|---------|------|
| 会话数据 | `~/.cc-ding/{clientId}/{MD5}/.sessions/{claudeSessionId}/session.{json\|log}` |
| 任务数据 | `~/.cc-ding/{clientId}/{MD5}/.tasks/{时间戳}/task.{json\|log}` |
| 定时任务 | `~/.cc-ding/{clientId}/cron.json` |
| 图片缓存 | `~/.cc-ding/{clientId}/{MD5}/.images/` |
| 手机号映射 | `~/.cc-ding/{clientId}/phone-map.json` |

## 功能特性

### 会话模式

- **会话ID**: 由 Claude 分配的 `claudeSessionId`
- **结束会话**: `/end`
- **新会话**: `/new [初始消息]` 强制结束当前会话并开启新会话
- **恢复会话**: `/resume [会话ID]` 恢复指定历史会话，不指定则恢复最近一个
- **会话持久化**: 活跃会话自动保存到 `active.json`，服务重启后自动恢复
- **群内多用户**: 允许群内所有白名单用户参与对话

### 任务模式

- 使用 `/task <任务描述>` 提交任务到队列
- 任务按队列顺序执行，完成后自动回复
- 使用 `/task cancel` 取消任务

### 定时任务

- `/cron <自然语言描述>` — Claude 自动分析并生成 cron 表达式
- `/cron 0 9 * * * 任务描述` — 直接指定 cron 表达式
- `/cron list` — 查看定时任务列表
- `/cron pause <id>` / `/cron resume <id>` — 暂停/恢复定时任务
- `/cron delete <id>` — 删除定时任务

### 图片消息支持

- 支持接收钉钉图片消息（`picture`）和富文本消息（`richText`，含内嵌图片）
- 图片自动下载保存到会话目录下的 `.images/` 目录
- `useLocalOcr`: 默认开启，使用本地 OCR 识别图片文字，同时传入原图路径供 Claude 自主查看
- 配置方式：`conversations[].useLocalOcr = false` 可关闭 OCR（适用于支持图片识别的模型）

### API Key 池化管理（可选）

配置 `apiKeyCfg` 后启用：

- **429 自动切换**: 自动切换到可用的 API Key
- **Key 轮换**: 遇到 429 或连续 TPM 不稳定时自动换 Key
- **跨天重置**: 每日 0 点自动重置 API Key 状态

### 白名单管理

- 全局白名单：`config.json` 中的 `whiteUserList`
- 群级白名单：`conversations[].whiteUserList`（优先级高于全局）
- 支持手机号和 userId 两种格式，手机号自动解析为 userId
- `/auth` 命令管理群级白名单（`/auth` 查看、`/auth add <手机号>`、`/auth del <手机号>`）

### 关联群功能

- 通过 `linkConversationId` 实现多个群共享同一个 Claude 会话上下文
- 关联群的消息会自动路由到同一个活跃会话

## 命令列表

### 💬 会话

| 命令 | 描述 |
|------|------|
| `/help` | 查看所有可用命令 |
| `/log [行数]` | 查看最近会话日志 |
| `/new [初始消息]` | 开始新的对话会话 |
| `/resume [会话ID]` | 继续指定的历史会话 |
| `/end` | 结束当前会话 |

### 📋 任务

| 命令 | 描述 |
|------|------|
| `/task <描述>` | 提交任务到队列 |
| `/cron <描述>` | 创建和管理定时任务 |

### 📂 文件

| 命令 | 描述 |
|------|------|
| `/pwd` | 显示当前工作目录的绝对路径 |
| `/ls [目录] [层数]` | 查看工作目录结构 |
| `/mkdir <路径>` | 创建文件夹 |
| `/touch <路径>` | 创建空文件 |
| `/rm <路径>` | 删除文件或目录 |

### ⚙️ 系统

| 命令 | 描述 |
|------|------|
| `/info [robot\|session\|task]` | 查看群配置、会话和任务信息 |
| `/version` | 查看工具版本信息 |

### 🔧 管理（仅 owner）

| 命令 | 描述 |
|------|------|
| `/open [shell]` | 在文件管理器或终端中打开工作目录 |
| `/clean [all]` | 清除历史会话和缓存 |
| `/reset-apikeycfg` | 重置 API Key 配置 |
| `/cfg` | 注册当前群到配置 |
| `/auth [add\|del <用户>]` | 管理当前群白名单 |

## 配置文件示例

```json
{
  "clientName": "cc助手",
  "owner": "你的手机号",
  "whiteUserList": ["你的手机号"],
  "clientSecret": "钉钉Stream连接密钥",
  "defaultDingToken": "兜底钉钉机器人Token",
  "conversations": [
    {
      "conversationId": "群ID",
      "conversationTitle": "群名称",
      "dingToken": "群机器人Token",
      "whiteUserList": ["工号1", "工号2"],
      "agent": "指定agent（可选）",
      "useLocalOcr": true,
      "taskCfg": {
        "skill": "指定技能（可选）"
      }
    }
  ],
  "taskQueueSize": 50,
  "taskHandlerCount": 1,
  "sessionMaxConcurrency": 20,
  "includeThinking": false,
  "resultOnly": true,
  "debug": false
}
```

## 开发

```bash
pnpm install
pnpm run lint
pnpm run test
pnpm run build
```

## 系统要求

- Node.js >= 24
