# cc-ding

[![npm version](https://img.shields.io/npm/v/cc-ding.svg?style=flat-square)](https://www.npmjs.com/package/cc-ding)
[![npm downloads](https://img.shields.io/npm/dm/cc-ding.svg?style=flat-square)](https://www.npmjs.com/package/cc-ding)
[![License](https://img.shields.io/npm/l/cc-ding.svg?style=flat-square)](LICENSE)
[![Node.js](https://img.shields.io/node/v/cc-ding.svg?style=flat-square)](https://nodejs.org)
[![GitHub stars](https://img.shields.io/github/stars/yihuineng/cc-ding.svg?style=flat-square)](https://github.com/yihuineng/cc-ding/stargazers)

> 将 Claude Code 接入钉钉，构建企业级 AI 协作工作流。
>
> Connect Claude Code to DingTalk for enterprise-grade AI collaboration.

**[中文](#中文--简体中文)** | **[English](#english)**

---

## 中文 | 简体中文

将 Claude Code 接入钉钉，实现双向通信。支持多轮对话、任务队列、定时任务、图片识别，帮助团队以最低成本构建可私有化部署的 AI 助手。

### 目录

- [快速开始](#快速开始)
- [命令参考](#命令参考)
- [配置说明](#配置说明)
- [数据存储](#数据存储)
- [开发](#开发)

### 快速开始

#### 安装

```bash
pnpm i cc-ding -g
```

#### 初始化

```bash
cc-ding init -ci {clientId} -cs {clientSecret} -m {手机号}
```

| 参数 | 说明 |
|------|------|
| `-ci, --clientId` | 钉钉应用 ClientId |
| `-cs, --clientSecret` | 钉钉 Stream 连接密钥 |
| `-m, --mobile` | 管理员手机号（自动加入白名单） |
| `-cn, --clientName` | 机器人名称（可选，默认 "cc助手"） |

#### 编辑配置

配置文件位于 `~/.cc-ding/{clientId}/config.json`，参考下方 [配置文件示例](#配置文件示例)。

#### 启动

```bash
# 直接启动
cc-ding run -ci {clientId}

# 推荐：PM2 守护进程
pm2 start --name "cc-ding-{clientId}" npx -- -p cc-ding cc-ding run -ci {clientId}
```

### 命令参考

#### 会话

| 命令 | 说明 |
|------|------|
| `/help` | 查看所有命令 |
| `/log [行数]` | 查看会话日志 |
| `/new [消息]` | 开始新对话 |
| `/resume [ID]` | 恢复历史会话（不指定则恢复最近一个） |
| `/end` | 结束当前会话 |

> 会话自动持久化到 `active.json`，重启后无缝恢复。群内所有白名单用户均可参与。

#### 任务

```
/task <描述>       # 提交任务（自动排队顺序执行）
/task cancel       # 取消任务
```

#### 定时任务

```
/cron <自然语言>             # Claude 自动生成 cron 表达式
/cron 0 9 * * * <描述>       # 直接指定 cron
/cron list                   # 查看列表
/cron pause <id> | resume <id>   # 暂停 / 恢复
/cron delete <id>            # 删除
```

#### 文件操作

| 命令 | 说明 |
|------|------|
| `/pwd` | 显示工作目录 |
| `/ls [目录] [层数]` | 查看目录结构 |
| `/mkdir` / `/touch` / `/rm` | 创建目录 / 创建空文件 / 删除 |

#### 管理命令（仅 owner）

| 命令 | 说明 |
|------|------|
| `/info [robot\|session\|task]` | 查看配置/会话/任务信息 |
| `/version` | 版本信息 |
| `/open [shell]` | 打开工作目录 |
| `/clean [all]` | 清除历史和缓存 |
| `/reset-apikeycfg` | 重置 API Key 配置 |
| `/cfg` | 注册当前群到配置 |
| `/auth [add\|del <用户>]` | 管理群级白名单 |

### 配置说明

#### 配置文件示例

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
      "taskCfg": { "skill": "指定技能（可选）" }
    }
  ],
  "taskQueueSize": 50,
  "taskHandlerCount": 1,
  "sessionMaxConcurrency": 20,
  "includeThinking": false,
  "resultOnly": true,
  "debug": false,
  "skipSandbox": false
}
```

#### 配置项速查

| 配置 | 说明 |
|------|------|
| `whiteUserList` | 全局白名单（手机号或 userId） |
| `conversations[].whiteUserList` | 群级白名单，优先级高于全局 |
| `apiKeyCfg` | API Key 池化：429 自动切换、每日 0 点重置 |
| `useLocalOcr` | 图片本地 OCR（默认 `true`），模型支持图片时可设 `false` |
| `linkConversationId` | 关联群 ID，多群共享同一 Claude 会话上下文 |
| `skipSandbox` | 跳过沙箱，允许完整文件系统访问（默认 `false`） |

### 数据存储

所有数据存储在 `~/.cc-ding/{clientId}/` 目录下：

| 类型 | 路径 |
|------|------|
| 会话 | `{MD5}/.sessions/{claudeSessionId}/session.{json,log}` |
| 任务 | `{MD5}/.tasks/{时间戳}/task.{json,log}` |
| 定时任务 | `cron.json` |
| 图片缓存 | `{MD5}/.images/` |
| 手机号映射 | `phone-map.json` |

### 开发

```bash
pnpm install
pnpm run lint
pnpm run test
pnpm run build
```

**系统要求：** Node.js >= 24

---

## English

Connect Claude Code to DingTalk for bidirectional communication. Supports multi-turn conversations, task queues, scheduled jobs, and image recognition — helping teams build privately deployable AI assistants at minimal cost.

### Table of Contents

- [Quick Start](#quick-start)
- [Commands](#commands)
- [Configuration](#configuration)
- [Data Storage](#data-storage)
- [Development](#development)

### Quick Start

#### Install

```bash
pnpm i cc-ding -g
```

#### Initialize

```bash
cc-ding init -ci {clientId} -cs {clientSecret} -m {phone_number}
```

| Parameter | Description |
|-----------|-------------|
| `-ci, --clientId` | DingTalk app ClientId |
| `-cs, --clientSecret` | DingTalk Stream connection secret |
| `-m, --mobile` | Admin phone number (auto-added to whitelist) |
| `-cn, --clientName` | Bot name (optional, default "cc助手") |

#### Edit Config

Config file is at `~/.cc-ding/{clientId}/config.json`. See [config example](#configuration-example) below.

#### Start

```bash
# Direct start
cc-ding run -ci {clientId}

# Recommended: PM2 daemon
pm2 start --name "cc-ding-{clientId}" npx -- -p cc-ding cc-ding run -ci {clientId}
```

### Commands

#### Session

| Command | Description |
|---------|-------------|
| `/help` | View all commands |
| `/log [lines]` | View session logs |
| `/new [msg]` | Start a new conversation |
| `/resume [ID]` | Resume a previous session (latest if omitted) |
| `/end` | End the current session |

> Sessions are auto-persisted to `active.json` and restored on restart. All whitelisted users in the group can participate.

#### Task

```
/task <description>     # Submit task (auto-queued, sequential execution)
/task cancel            # Cancel a task
```

#### Scheduled

```
/cron <natural language>        # Claude auto-generates cron expression
/cron 0 9 * * * <description>   # Specify cron directly
/cron list                      # View all
/cron pause <id> | resume <id>  # Pause / resume
/cron delete <id>               # Delete
```

#### File Operations

| Command | Description |
|---------|-------------|
| `/pwd` | Show working directory |
| `/ls [dir] [depth]` | View directory structure |
| `/mkdir` / `/touch` / `/rm` | Create dir / Create empty file / Delete |

#### Admin (owner only)

| Command | Description |
|---------|-------------|
| `/info [robot\|session\|task]` | View config/session/task info |
| `/version` | Version info |
| `/open [shell]` | Open working directory |
| `/clean [all]` | Clear history and cache |
| `/reset-apikeycfg` | Reset API Key configuration |
| `/cfg` | Register current group to config |
| `/auth [add\|del <user>]` | Manage group whitelist |

### Configuration

#### Configuration Example

```json
{
  "clientName": "cc助手",
  "owner": "your_phone_number",
  "whiteUserList": ["your_phone_number"],
  "clientSecret": "dingtalk_stream_secret",
  "defaultDingToken": "fallback_dingtalk_bot_token",
  "conversations": [
    {
      "conversationId": "group_id",
      "conversationTitle": "group_name",
      "dingToken": "group_bot_token",
      "whiteUserList": ["emp_id_1", "emp_id_2"],
      "agent": "specified_agent (optional)",
      "useLocalOcr": true,
      "taskCfg": { "skill": "specified_skill (optional)" }
    }
  ],
  "taskQueueSize": 50,
  "taskHandlerCount": 1,
  "sessionMaxConcurrency": 20,
  "includeThinking": false,
  "resultOnly": true,
  "debug": false,
  "skipSandbox": false
}
```

#### Config Quick Reference

| Config | Description |
|--------|-------------|
| `whiteUserList` | Global whitelist (phone or userId) |
| `conversations[].whiteUserList` | Group-level whitelist, higher priority than global |
| `apiKeyCfg` | API Key pooling: auto-switch on 429, daily reset at midnight |
| `useLocalOcr` | Local image OCR (default `true`); set `false` if model supports images natively |
| `linkConversationId` | Link groups to share one Claude session context |
| `skipSandbox` | Skip sandbox for full filesystem access (default `false`) |

### Data Storage

All data is stored under `~/.cc-ding/{clientId}/`:

| Type | Path |
|------|------|
| Sessions | `{MD5}/.sessions/{claudeSessionId}/session.{json,log}` |
| Tasks | `{MD5}/.tasks/{timestamp}/task.{json,log}` |
| Cron jobs | `cron.json` |
| Image cache | `{MD5}/.images/` |
| Phone mapping | `phone-map.json` |

### Development

```bash
pnpm install
pnpm run lint
pnpm run test
pnpm run build
```

**Requirements:** Node.js >= 24

---

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=yihuineng/cc-ding&type=Date)](https://github.com/yihuineng/cc-ding/stargazers)

## Contributors

[![Contributors](https://contrib.rocks/image?repo=yihuineng/cc-ding)](https://github.com/yihuineng/cc-ding/graphs/contributors)

## License

MIT
