# cc-ding

[![npm version](https://img.shields.io/npm/v/cc-ding.svg?style=flat-square)](https://www.npmjs.com/package/cc-ding)
[![npm downloads](https://img.shields.io/npm/dm/cc-ding.svg?style=flat-square)](https://www.npmjs.com/package/cc-ding)
[![License](https://img.shields.io/npm/l/cc-ding.svg?style=flat-square)](LICENSE)
[![Node.js](https://img.shields.io/node/v/cc-ding.svg?style=flat-square)](https://nodejs.org)

将钉钉机器人接入本地 [Claude Code](https://claude.ai/code)，实现群聊多轮对话、任务队列、定时任务等能力。

## 功能特性

- **多轮对话** — 支持私聊 / 群聊多轮会话，`/new` `/end` `/resume` 灵活切换
- **群内多用户** — 白名单内所有成员均可参与同一会话
- **任务队列** — `/task` 提交任务，按队列顺序执行，完成后自动回复
- **定时任务** — 自然语言创建 cron，支持暂停 / 恢复 / 删除
- **图片消息** — 自动接收钉钉图片 / 富文本内嵌图片，可选本地 OCR 识别
- **API Key 池化** — 429 自动切换、跨天重置，提升服务稳定性
- **关联群** — 多个群共享同一个 Claude 会话上下文

## 快速开始

### 安装

```bash
pnpm i cc-ding -g
cc-ding --help
```

### 1. 初始化配置

```bash
cc-ding init -ci {clientId} -cs {clientSecret} -m {手机号}
```

| 参数 | 说明 |
|------|------|
| `-ci, --clientId` | 钉钉应用的 ClientId |
| `-cs, --clientSecret` | 钉钉 Stream 连接密钥 |
| `-m, --mobile` | 管理员手机号（自动加入白名单） |
| `-cn, --clientName` | 机器人名称（可选，默认 "cc助手"） |

### 2. 编辑配置

配置文件位于 `~/.cc-ding/{clientId}/config.json`，按 [配置文件示例](#配置文件示例) 补充 `conversations` 等字段。

### 3. 启动

```bash
# 直接启动
cc-ding run -ci {clientId}

# 推荐：PM2 守护进程方式
pm2 start --name "cc-ding-{clientId}" npx -- -p cc-ding cc-ding run -ci {clientId}
```

## 使用指南

### 会话模式

| 命令 | 说明 |
|------|------|
| `/help` | 查看所有可用命令 |
| `/log [行数]` | 查看最近会话日志 |
| `/new [初始消息]` | 开始新的对话 |
| `/resume [会话ID]` | 继续历史会话（不指定则恢复最近一个） |
| `/end` | 结束当前会话 |

- 会话自动持久化到 `active.json`，服务重启后自动恢复
- 群内所有白名单用户均可参与对话

### 任务模式

```
/task <任务描述>      # 提交任务到队列
/task cancel          # 取消任务
```

### 定时任务

```
/cron <自然语言描述>              # Claude 自动生成 cron 表达式
/cron 0 9 * * * <任务描述>        # 直接指定 cron 表达式
/cron list                        # 查看列表
/cron pause <id> / resume <id>    # 暂停 / 恢复
/cron delete <id>                 # 删除
```

### 文件操作

| 命令 | 说明 |
|------|------|
| `/pwd` | 显示工作目录绝对路径 |
| `/ls [目录] [层数]` | 查看目录结构 |
| `/mkdir <路径>` | 创建文件夹 |
| `/touch <路径>` | 创建空文件 |
| `/rm <路径>` | 删除文件或目录 |

### 管理命令（仅 owner）

| 命令 | 说明 |
|------|------|
| `/info [robot\|session\|task]` | 查看群配置、会话和任务信息 |
| `/version` | 查看版本信息 |
| `/open [shell]` | 在文件管理器或终端中打开工作目录 |
| `/clean [all]` | 清除历史会话和缓存 |
| `/reset-apikeycfg` | 重置 API Key 配置 |
| `/cfg` | 注册当前群到配置 |
| `/auth [add\|del <用户>]` | 管理群级白名单 |

## 配置说明

### 白名单

- **全局白名单**：`config.json` 中的 `whiteUserList`
- **群级白名单**：`conversations[].whiteUserList`（优先级高于全局）
- 支持手机号和 userId 两种格式，手机号自动解析为 userId

### API Key 池化

配置 `apiKeyCfg` 后启用：

- 429 错误自动切换到可用 Key
- 连续 TPM 不稳定时自动换 Key
- 每日 0 点自动重置 API Key 状态

### 图片消息

- 支持 `picture` 和 `richText`（含内嵌图片）消息类型
- 图片自动下载到 `.images/` 目录
- `useLocalOcr: true`（默认）使用本地 OCR 识别，同时传入原图路径供 Claude 自主查看
- 设置 `useLocalOcr: false` 关闭 OCR（适用于支持图片识别的模型）

### 关联群

通过 `linkConversationId` 实现多个群共享同一个 Claude 会话上下文，消息自动路由到同一活跃会话。

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

## 数据存储

所有数据存储在 `~/.cc-ding/{clientId}/` 目录下：

| 类型 | 路径 |
|------|------|
| 会话数据 | `{MD5}/.sessions/{claudeSessionId}/session.{json,log}` |
| 任务数据 | `{MD5}/.tasks/{时间戳}/task.{json,log}` |
| 定时任务 | `cron.json` |
| 图片缓存 | `{MD5}/.images/` |
| 手机号映射 | `phone-map.json` |

## 开发

```bash
pnpm install
pnpm run lint       # 代码检查
pnpm run test       # 运行测试
pnpm run build      # 构建
```

## 系统要求

- Node.js >= 24

## License

MIT
