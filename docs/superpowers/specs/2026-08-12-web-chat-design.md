# Web Chat 会话功能设计文档

**日期**: 2026-08-12
**状态**: 草案
**目标**: 在 cc-ding console web 端直接进行钉钉会话聊天，与钉钉共享同一份 agent 上下文

---

## 1. 背景与目标

### 1.1 背景

cc-ding 当前的会话入口仅有钉钉：用户在钉钉群/单聊中 @ 机器人，触发 `DingClaude` 调用 Claude agent，结果通过钉钉 webhook 推回。console 只负责配置管理，与消息处理完全分离。

### 1.2 目标

- **复用现有钉钉会话**：web 端打开某个钉钉会话（群/单聊），查看历史消息、继续往下聊
- **共享上下文**：agent 上下文和钉钉那边共享同一份，`/new`、`/end`、消息队列等行为完全一致
- **双向同步**：web 发的消息在钉钉群里能看到，钉钉发的消息在 web 端也能看到

### 1.3 非目标

- **流式输出**：web 端等 agent 执行完拿最终结果即可（不追求打字机效果）
- **历史迁移**：旧会话不解析 `session.log`，结构化记录从启用起算
- **独立 web 会话**：所有 web 对话必须绑定一个真实钉钉会话

---

## 2. 架构

采用**方案 A：文件信号 + 磁盘轮询**，完全复用 cc-ding 已验证的「文件信号驱动」哲学（同 `send-queue`）。

```
[Web 浏览器]
    │ ① HTTP: 发消息 / 拉历史 / 轮询新消息
    ▼
[Console HTTP Server (8080)] ── 现有进程
    │ ② 写 chat-queue 信号文件          │ ③ 读 messages.json
    ▼                                    ▲
磁盘: ~/.cc-ding/{clientId}/             │
    ├─ .chat-queue/  (web 注入的消息)    │
    │   └─ {ts}_{rand}.json              │
    └─ {convHash}/                       │
        └─ messages.json  (结构化消息) ──┘
    ▲
    │ ④ 轮询消费 .chat-queue
[Client 进程 (DingClaude)] ── 现有进程，钉钉机器人
    │
    │ ⑤ 调用现有 handleSessionMessage（完全复用）
    │ ⑥ agent 执行时，往 messages.json 追加结果
    ▼
[钉钉] (同步收到回复，和现在一模一样)
```

**核心原则**：不碰 console ↔ client 的网络通道，纯磁盘文件通信。client 进程对 web 完全无感知，只多了一个轮询器和一个写消息的 hook。

### 2.1 为什么不用其他方案

| 方案 | 优点 | 缺点 | 决策 |
|------|------|------|------|
| A: 文件信号 + 磁盘轮询 | 零新端口、零 WebSocket、复用成熟模式、多 client 天然隔离 | 注入有 1-2 秒延迟 | ✅ **采纳**（"最终结果即可"完全可接受） |
| B: Client 内嵌 HTTP 端点 | 注入即时、接口标准 | 要管端口冲突/注册表/鉴权，改动较大 | ❌ |
| C: 合并 console 和 client 进程 | 调用最简单 | 违背现有架构、pm2 管理大改、风险高 | ❌ |

---

## 3. 数据结构

### 3.1 Web 消息注入信号

文件：`~/.cc-ding/{clientId}/.chat-queue/{ts}_{rand}.json`

```ts
interface IChatSignal {
  conversationId: string;      // 目标钉钉会话（复用现有会话）
  message: string;             // 用户输入的内容
  senderStaffId: string;       // web 用户标识（见身份映射）
  senderNick: string;          // 显示名（console 登录账号）
  timestamp: number;
}
```

仿照 `ISendSignal`（`send-queue.ts:16`）的写法。

### 3.2 结构化消息存储

文件：`~/.cc-ding/{clientId}/{MD5(conversationId)}/messages.json`

```ts
interface IChatMessage {
  id: string;                  // uuid
  role: 'user' | 'assistant';
  content: string;             // markdown 正文
  senderStaffId?: string;      // user 消息的来源（钉钉/web 区分）
  senderNick?: string;
  source: 'ding' | 'web';      // 来源渠道
  timestamp: number;
}
// 文件结构: { messages: IChatMessage[] }
```

**存储层级**：放在**会话级**（`{convHash}/messages.json`）而非 session 级，跨 `/new` 连续。打开一个钉钉会话看到的是该会话所有 user/assistant 来回。

---

## 4. Console 后端 API（console.ts 新增）

在 `handleApiRequest`（`console.ts:2611`）路由分发处新增三个端点：

### 4.1 `POST /api/clients/:id/conversations/:convId/chat`

**发送消息**

**流程**：
1. 校验：会话在 client 配置中存在、client 在线
2. 写信号文件到 `.chat-queue/{ts}_{rand}.json`
3. **乐观追加** user 消息到 `{convHash}/messages.json`（web 立即看到自己的消息，不等 client 处理）
4. 返回 `{ ok: true, messageId }`

**响应**：
```json
{ "ok": true, "messageId": "uuid" }
```

### 4.2 `GET /api/clients/:id/conversations/:convId/messages?since=&limit=`

**拉取消息历史**

**参数**：
- `since`（可选）：时间戳，增量拉取
- `limit`（可选）：默认 100，最大 500

**响应**：
```json
{ "messages": [IChatMessage], "hasMore": false }
```

### 4.3 `GET /api/clients/:id/conversations/:convId/chat/status`

**查询会话状态**

**响应**：
```json
{
  "isProcessing": false,
  "queueLength": 0,
  "clientOnline": true
}
```

---

## 5. Client 端消费（DingClaude 新增）

### 5.1 ChatQueueProcessor

新增类 `ChatQueueProcessor`（位置：`src/biz/chat-queue.ts`），仿照 `SendQueueProcessor`：

```ts
export class ChatQueueProcessor {
  private dc: DingClaude;
  private timer: NodeJS.Timeout | null;
  private queueDir: string;

  constructor(dc: DingClaude) { ... }
  start(): void { /* 1000ms 轮询 */ }
  destroy(): void { ... }
  private async processQueue(): Promise<void> { ... }
}
```

**消费流程**：
1. 读取 `.chat-queue/` 下所有 `.json` 文件
2. 按文件名排序（时间戳自然排序）
3. 对每个信号：
   - 校验会话存在
   - 构造参数调用现有 `handleSessionMessage`：
     - `conversationId`: 信号里
     - `sessionWebhook`: 会话配置里的 `dingToken`（回复照样推钉钉，双向同步）
     - `senderStaffId`: 信号里（`web:${consoleAccount}` 格式）
     - `senderNick`: 信号里
     - `message`: 信号里
     - `conversationConfig`: 从 client config 里查
     - `msgCreateAt`: 信号 timestamp
     - `msgId`: 信号文件名（用于水印去重）
   - 处理完删信号文件

### 5.2 Agent 响应写入 messages.json

**新增工具函数**（位置：`src/biz/chat-messages.ts`）：

```ts
export function appendChatMessage(convHash: string, msg: IChatMessage): void
export function readChatMessages(convHash: string, opts?: { since?: number; limit?: number }): IChatMessage[]
```

**注入点**：

- **user 消息**（**谁发起谁写入，避免重复**）：
  - **Web 消息**：console 在 `POST /chat` 时写入（含 messageId），client 消费信号时**不再**重复写
  - **钉钉消息**：在 `botMsgGetCallback` 里、调用 `handleSessionMessage` 前写入

- **assistant 消息**：
  - 在 `handleSessionMessage` 里，`agent.executeQuery` 成功分支（`finally` 前）调用 `appendChatMessage` 写入 assistant 响应
  - **实现方式**：在 `handleSessionMessage` 内部挂一个响应捕获钩子（如给 DingClaude 加一个 `responseCapture: ((content) => void) | null` 字段），`sendDingMessage` 调用时如果存在 capture 就同时记录；`executeQuery` 完成后把累积的内容写入 messages.json
  - 或备选方案：从 `session.log` 读取时间晚于本次 user 消息的最新 assistant 条目（实现更松耦合但略脆弱）

---

## 6. 身份映射

| 来源 | senderStaffId 格式 | 显示名 | 说明 |
|------|-------------------|--------|------|
| 钉钉 | 真实钉钉 staffId（如 `03634747521825871534`） | 钉钉用户名 | 现有行为 |
| Web | `web:${consoleAccount}`（如 `web:admin`） | console 登录账号 | 虚拟 ID，避免冲突 |

`web:` 前缀让钉钉侧能识别"这条消息来自 web 用户"，消息气泡可以显示不同样式。

---

## 7. 前端（console-web）

### 7.1 路由

新增：`/client/:clientId/chat/:convId`

### 7.2 组件结构

新建：
- `pages/ChatPage.tsx` — 聊天页面容器
- `components/ChatPanel.tsx` — 核心聊天界面（可独立复用）
- `components/ChatBubble.tsx` — 单条消息气泡（user/assistant 样式区分）

入口：在 `ConversationsTab.tsx` 的会话列表每行加一个"💬 打开对话"按钮，跳转到新页面。

### 7.3 布局

```
┌─────────────────────────────────────┐
│ [← 返回]  会话: {群名/单聊名}     [状态灯] │
├─────────────────────────────────────┤
│                                     │
│  [assistant 气泡 - 左对齐]         │
│                                     │
│            [user 气泡 - 右对齐]     │
│                                     │
│  [assistant 气泡 - 左对齐]         │
│                                     │
├─────────────────────────────────────┤
│ [输入框                      ] [发送] │
│ 状态: "Agent 处理中..." / "已就绪"   │
└─────────────────────────────────────┘
```

### 7.4 交互

- **加载历史**：进入页面 `GET /messages`
- **发送消息**：
  - 用户按回车或点发送
  - 乐观追加 user 气泡到列表
  - `POST /chat`，成功后记录 messageId
  - 失败则回滚气泡 + toast 报错
- **拉新消息**：
  - 每 2 秒 `GET /messages?since=lastTs`
  - 新消息追加到列表（assistant 自动滚动到底部）
- **状态轮询**：
  - 每 2 秒 `GET /chat/status`
  - `isProcessing=true` 时输入框禁用、显示 loading 指示器
  - `clientOnline=false` 时显示"Client 离线"错误

### 7.5 API 封装（api/client.ts 新增）

```ts
// ── Chat ──
sendChatMessage: (clientId: string, convId: string, message: string) =>
  request<{ ok: boolean; messageId: string }>(
    `/api/clients/${enc(clientId)}/conversations/${enc(convId)}/chat`,
    { method: 'POST', body: JSON.stringify({ message }) }
  ),

getChatMessages: (clientId: string, convId: string, opts?: { since?: number; limit?: number }) => {
  const params = new URLSearchParams()
  if (opts?.since) params.set('since', String(opts.since))
  if (opts?.limit) params.set('limit', String(opts.limit))
  return request<{ messages: IChatMessage[]; hasMore: boolean }>(
    `/api/clients/${enc(clientId)}/conversations/${enc(convId)}/messages?${params}`
  )
},

getChatStatus: (clientId: string, convId: string) =>
  request<{ isProcessing: boolean; queueLength: number; clientOnline: boolean }>(
    `/api/clients/${enc(clientId)}/conversations/${enc(convId)}/chat/status`
  ),
```

---

## 8. 错误处理与边界

| 场景 | 处理 |
|------|------|
| client 离线 | console 写信号文件成功，但 status 端点返回 `clientOnline: false`，前端显示"等待 client 上线" |
| 信号积压 | client 恢复后按时间顺序处理 |
| messages.json 并发写 | `appendChatMessage` 用 `fs.readFileSync` + `fs.writeFileSync` 原子读改写，外层 try-catch + 指数退避重试（最多 3 次） |
| 信号重复 | 文件名唯一 + 处理完即删，幂等 |
| 消息过长 | 前端截断显示 + "展开"按钮；单条消息无上限（后端不限制） |
| 历史清理 | 现有 `/clean` 命令联动，清理会话目录时一并清空 `messages.json` |
| 钉钉和 web 同时发消息 | 复用现有 messageQueue 队列机制，串行处理，web 用户收到"⏳ 已加入队列"提示 |
| 旧会话无 messages.json | 返回空数组，前端显示"暂无历史" |

---

## 9. 测试策略

### 9.1 单元测试

- `chat-queue.ts` 的 `ChatQueueProcessor.processQueue`：mock DingClaude，验证信号消费、去重、顺序
- `chat-messages.ts` 的 `appendChatMessage` / `readChatMessages`：验证读写、并发安全、since 过滤
- Console API 端点：mock 文件系统，验证信号写入、messages 读取

### 9.2 集成测试

- Web 发消息 → client 处理 → 钉钉收到回复 → messages.json 有 assistant 记录
- 钉钉发消息 → web 端轮询能看到
- `/new` 命令后，messages.json 继续追加（会话级连续）

### 9.3 手动测试清单

- [ ] Web 发消息，钉钉群里能看到
- [ ] 钉钉发消息，Web 端能看到
- [ ] Web 发消息时 agent 在忙，显示"已加入队列"
- [ ] Client 离线时，前端有明确提示
- [ ] 消息历史分页加载正确
- [ ] `/new` 命令后历史仍然连续

---

## 10. 新增/修改文件清单

| 文件 | 类型 | 说明 |
|------|------|------|
| `src/biz/chat-queue.ts` | 新增 | `ChatQueueProcessor` 类 + `writeChatSignal` |
| `src/biz/chat-messages.ts` | 新增 | `appendChatMessage` / `readChatMessages` 工具函数 |
| `src/biz/types.ts` | 修改 | 新增 `IChatMessage` / `IChatSignal` 类型 |
| `src/biz/cc-ding-cli.ts` | 修改 | 实例化并启动 `ChatQueueProcessor`；`botMsgGetCallback` 里写入 user 消息 |
| `src/biz/session.ts` | 修改 | `handleSessionMessage` 里 `executeQuery` 成功处写入 assistant 消息 |
| `src/biz/console.ts` | 修改 | 新增 3 个 API 端点 |
| `console-web/src/App.tsx` | 修改 | 新增 `/client/:clientId/chat/:convId` 路由 |
| `console-web/src/pages/ChatPage.tsx` | 新增 | 聊天页面容器 |
| `console-web/src/components/ChatPanel.tsx` | 新增 | 核心聊天界面 |
| `console-web/src/components/ChatBubble.tsx` | 新增 | 消息气泡 |
| `console-web/src/components/ConversationsTab.tsx` | 修改 | 会话列表加"💬 打开对话"按钮 |
| `console-web/src/api/client.ts` | 修改 | 新增 3 个 chat API 方法 |
| `console-web/src/types/index.ts` | 修改 | 新增 `IChatMessage` 前端类型 |

---

## 11. 部署与升级

- 无需新端口、新依赖、新环境变量
- Client 版本升级后自动开始记录新消息（旧会话无 messages.json 时优雅降级）
- 现有钉钉行为零破坏：`handleSessionMessage` 复用，不改变既有流程

---

## 12. 后续可扩展

- 流式输出（需 SSE/WebSocket 通道，当前方案 A 不支持，未来可平滑升级）
- 富文本消息（图片、文件、markdown 预览）
- 消息搜索
- 多 web 用户同时在线（WebSocket 广播）
- Web 端发起 `/new`、`/end` 命令
