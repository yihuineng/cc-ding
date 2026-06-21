# A2A (Agent-to-Agent) 协议

cc-ding 支持 A2A 协议，使不同物理主机上的钉钉机器人能够互相调度任务。

## 架构

### 多主机集群

每台物理主机运行一个 `a2a-server`，相同 `apiKey` 的 server 自动组成集群：

```
物理主机 A (a2a-server :3000)              物理主机 B (a2a-server :3001)
┌───────────────────────────────┐          ┌───────────────────────────────┐
│ a2a-server                    │◄────────►│ a2a-server                    │
│  ├─ Dashboard                 │  互相发现  │  ├─ Dashboard                 │
│  ├─ 任务路由(跨主机转发)       │  Agent同步  │  ├─ 任务路由(跨主机转发)       │
│  └─ 本地 Agent 注册表         │          │  └─ 本地 Agent 注册表         │
│                               │          │                               │
│ cc-ding 实例 1 ───┐           │          │ cc-ding 实例 3                │
│ cc-ding 实例 2 ───┘           │          │ cc-ding 实例 4                │
└───────────────────────────────┘          └───────────────────────────────┘
```

### 启动命令

```bash
# 主机 A
cc-ding a2a-server --apiKey shared-secret --port 3000 \
  --serverId host-a --baseUrl http://host-a-ip:3000 \
  --peers http://host-b-ip:3001

# 主机 B
cc-ding a2a-server --apiKey shared-secret --port 3001 \
  --serverId host-b --baseUrl http://host-b-ip:3001 \
  --peers http://host-a-ip:3000
```

### cc-ding 实例配置

每个 cc-ding 实例连接本地 a2a-server：

```json
{
  "a2aCfg": {
    "hubUrl": "http://localhost:3000",
    "apiKey": "shared-secret"
  }
}
```

| 字段 | 说明 |
|------|------|
| `hubUrl` | 本地 a2a-server 的 URL |
| `apiKey` | 与 a2a-server 相同的认证密钥 |

> **注册粒度**: 每个 conversation 注册为独立 agent（ID: `<clientId>:<conversationId>`）。
> **心跳**: 按 client 维度发送（一个心跳 = 该 client 下所有 conversation 在线）。

## Hub 端点

| 方法 | 路径 | 说明 | 认证 |
|------|------|------|------|
| GET | / | Dashboard 控制台 | 无 |
| GET | /health | 健康检查 | 无 |
| GET | /hub/agents | 列出所有 Agent（含跨主机） | 无 |
| GET | /hub/servers | 列出集群中所有 server | 无 |
| GET | /hub/stats | 统计数据 | 无 |
| GET | /hub/tasks?limit=N | 最近任务记录 | 无 |
| POST | /hub/server/register | Peer server 注册 | Hub API Key |
| POST | /hub/server/heartbeat | Peer server 心跳 | Hub API Key |
| POST | /hub/server/sync-agents | 同步 Agent 列表 | Hub API Key |
| POST | /hub/register | Agent 注册 | Hub API Key |
| POST | /hub/heartbeat | Agent 心跳 | Hub API Key |
| POST | /hub/unregister | Agent 注销 | Hub API Key |
| POST | /a2a/{agentId}/tasks/send | 路由任务到指定 Agent | Hub API Key |
| POST | /a2a/{agentId}/tasks/get | 查询任务状态 | Hub API Key |
| POST | /a2a/{agentId}/tasks/cancel | 取消任务 | Hub API Key |

## 命令列表

| 命令 | 说明 | 示例 |
|------|------|------|
| `/a2a agents` | 列出所有在线 Agent（含跨主机） | `/a2a agents` |
| `/a2a list` | 列出本地配置的远端 Agent | `/a2a list` |
| `/a2a send <id> <消息>` | 发送任务到指定 conversation | `/a2a send dingdogx:cidEBK... 帮我分析` |
| `/a2a status <id> <taskId>` | 查看任务状态 | `/a2a status dingdogx:cidEBK... a2a-xxx` |
| `/a2a cancel <id> <taskId>` | 取消任务 | `/a2a cancel dingdogx:cidEBK... a2a-xxx` |

## Dashboard 控制台

访问 `http://localhost:3000/` 可查看：

- **统计卡片**：本地 Agent 数、在线数、Peer Server 数、路由任务数、运行时长
- **集群 Server**：所有 peer server 的 ID、URL、状态、Agent 数量、最后心跳
- **Agent 列表**：所有已注册 Agent（含跨主机），显示所属 Server
- **任务记录**：最近 50 条任务，显示目标 Server
- **自动刷新**：每 5 秒自动轮询更新

## 跨主机任务路由

```
用户在主机 A 发 /a2a send host-b:client:cid "消息"
  ↓
主机 A 的 a2a-server 收到请求
  ↓
查找 agent: host-b:client:cid → 发现属于 peer server host-b
  ↓
POST http://host-b-ip:3001/a2a/host-b:client:cid/tasks/send
  ↓
主机 B 的 a2a-server 收到请求 → 在本地执行 Claude
  ↓
结果通过 HTTP 响应返回 → 返回给主机 A → 返回给用户
```

## Claude 自动调度

配置 `a2aCfg` 后，`.claude/CLAUDE.md` 会自动注入 A2A 使用说明。

## 文件结构

```
src/biz/a2a/
├── types.ts              # A2A 协议类型定义
├── hub.ts                # 多主机 Hub 服务器（含 Dashboard）
├── handlers.ts           # JSON-RPC 方法处理器
├── client.ts             # A2AClient + HubClient
├── http-utils.ts         # 共享 HTTP 工具
├── agent-card.ts         # AgentCard 生成
├── auth.ts               # API Key 认证
└── session-mapper.ts     # 任务持久化
src/biz/commands-a2a.ts   # /a2a 命令
docs/a2a.md               # 本文档
bin/cc-ding.ts            # a2a-server CLI
```
