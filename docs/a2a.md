# A2A (Agent-to-Agent) 协议

cc-ding 支持 A2A 协议，使不同物理主机上的钉钉机器人能够互相调度任务。

## 架构

### 全局单 Hub

全局只需启动一个 A2A Hub，所有 cc-ding 实例通过 WebSocket 连接到 Hub：

```
全局 Hub (a2a-server)
  │
  ├── WebSocket ── 主机 A: cc-ding 实例 1 (群1, 群2)
  ├── WebSocket ── 主机 B: cc-ding 实例 2 (群3)
  └── WebSocket ── 主机 C: cc-ding 实例 3 (群4)
```

- **Hub**: 唯一服务，提供 WebSocket 连接 + HTTP API + Dashboard
- **cc-ding**: 启动时 WebSocket 连 Hub，注册所有 conversation 为 agent
- **任务路由**: Hub 通过 WebSocket 推送任务到目标 cc-ding
- **心跳**: cc-ding 定时发送 WebSocket 心跳，断线自动标记 offline

### 启动 Hub

```bash
cc-ding a2a-server --apiKey your-hub-secret-key --port 3000
```

### cc-ding 实例配置

每个 cc-ding 实例连接 Hub：

```json
{
  "a2aCfg": {
    "hubUrl": "http://hub-host:3000",
    "apiKey": "your-hub-secret-key"
  }
}
```

| 字段 | 说明 |
|------|------|
| `hubUrl` | Hub 的 URL（配置后启动时 WebSocket 连接 + 注册 agent + 心跳） |
| `apiKey` | Hub 认证密钥 |

> **注册粒度**: 每个 conversation 注册为独立 agent（ID: `<clientId>:<conversationId>`）。
> **心跳**: 按 client 维度发送，每 30s 一次。
> **断线重连**: WebSocket 断开后自动标记所有 agent 为 offline。

## Hub 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | / | Dashboard 控制台 |
| GET | /health | 健康检查 |
| WS | /ws?token=KEY | WebSocket 连接（cc-ding 注册/心跳/任务推送） |
| GET | /hub/agents | 列出所有 Agent |
| GET | /hub/clients | 列出已连接 Client |
| GET | /hub/stats | 统计数据 |
| GET | /hub/tasks?limit=N | 最近任务记录 |
| POST | /a2a/{agentId}/tasks/send | HTTP 方式发送任务（备用） |

## Dashboard

访问 `http://hub-host:3000/` 可查看：
- 已连接 Client 列表
- 已注册 Agent 列表（含状态、所属 Client）
- 最近任务记录

## 命令列表

| 命令 | 说明 | 示例 |
|------|------|------|
| `/a2a agents` | 列出所有在线 Agent | `/a2a agents` |
| `/a2a send <id> <消息>` | 发送任务到指定 agent | `/a2a send dingdogx:cidEBK... 帮我分析` |
| `/a2a status <id> <taskId>` | 查看任务状态 | `/a2a status dingdogx:cidEBK... a2a-xxx` |

## Claude 自动调度

配置 `a2aCfg` 后，`.claude/CLAUDE.md` 和 `AGENTS.md` 会自动注入 A2A 使用说明。

## 文件结构

```
src/biz/a2a/
├── types.ts              # A2A 协议类型定义
├── hub.ts                # Hub 服务器（HTTP + WebSocket + Dashboard）
├── client.ts             # A2AClient + HubClient（WebSocket）
├── handlers.ts           # JSON-RPC 方法处理器
├── http-utils.ts         # 共享 HTTP 工具
├── agent-card.ts         # AgentCard 生成
├── auth.ts               # API Key 认证
└── session-mapper.ts     # 任务持久化
src/biz/commands-a2a.ts   # /a2a 命令
docs/a2a.md               # 本文档
bin/cc-ding.ts            # a2a-server CLI
```
