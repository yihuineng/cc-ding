# Changelog

## 1.0.1 (2026-06-13)

### 优化
- 所有 `/xxx` 命令回复不再 @ 发送人，减少钉钉群内无关提醒
- `/cc` 命令"已收到"回复同样不再 @ 用户
- 空响应提示文案精简：`⚠️ Claude 处理完成但未返回任何内容`
- `/!` 中断命令支持四种触发方式：`/!` `/！` `!` `！`
- 消息队列入队回复不再 @ 用户
- 队列消费回复优化为：`🚀 开始处理消息「xxx」`并 @ 用户

### 新功能
- `/destroy` 命令：注销群机器人，删除工作目录和配置
- `/freedom` 命令：自由模式，开启后所有群成员均可使用机器人（跳过白名单限制，需二次确认开启，`/freedom exit` 退出）

## 0.3.1 (2026-06-13)

### 优化
- 所有 `/xxx` 命令回复不再 @ 发送人，减少钉钉群内无关提醒
- 空响应提示文案精简：`⚠️ Claude 处理完成但未返回任何内容`

## 0.3.0 (2026-06-07)

### 新功能
- `/todo` 工号模式适配：用户可选 `staffId` 或 `dingtalkId` 标识
- 会话自动注入 `clientId` 和 `conversation` 信息

### 修复
- 发送消息中包含 `@` 人员时信息丢失的问题
- `/cc` 命令透传消息不携带用户信息的问题（多次迭代修复）
- `--conversationId` 权限检查和 `/goon` 命令处理
- `sendOwnerMessage` 手机号解析为 `userId` 的问题
- recorder 文件名同秒覆盖问题（加入毫秒后缀）
- reboot 相关问题

### 优化
- `recorder.ts` 复用 `image.ts` 导出的工具函数，删除重复代码
- 支持跳过 sandbox 模式
- README 文档更新

## 0.2.0 (2026-06-06)

### 新功能

#### `/todo` 待办管理
- `/todo <内容> [@人] [ddl 截止时间]` 添加待办（默认 7 天到期）
- `/todo done <序号>` 标记完成
- `/todo rm <序号>` 删除单条，`/todo rm all` 清空全部
- `/todo list` 查看列表（含 DDL 逾期标记和提醒时间）
- `/todo remind <0-23>` 设置每日提醒整点时间，`/todo remind -1` 关闭提醒
- DDL 支持自然语言：`明天`、`后天`、`大后天`、`下周一`~`下周日`、`这周五`、`2025-06-10`、`6/10`、`0610`
- 已完成待办 1 天后自动清理
- 数据持久化到 `.cc-ding/{clientId}/todo.json`

#### `/menu` 快捷指令菜单
- `/menu add <指令>` 添加个人菜单（名称自动截取指令前 20 字符）
- `/menu del <序号>` 删除个人菜单
- `/menu list` 查看个人菜单列表
- `/menu trigger <词>` 自定义触发词（默认 `cc`）
- `/menu -g add/del/list` owner 管理全局菜单（所有群可见）
- 菜单持久化到 `.cc-ding/{clientId}/menu.json`

#### 新命令
- **`/!` 中断命令**: 中断当前 Claude 执行并立即处理新消息
- **`/mq front` 插队**: 将消息插入队列头部优先处理
- **`/mq rm` 增强**: 支持按序号精确删除（`/mq rm 2`、`/mq rm 1-3`、`/mq rm 1 3 5`）
- **`/reboot`**: 重启 cc-ding 应用，支持 `--update [tag]` 更新后重启
- **`/recorder` 快捷方式**: `/r` 作为 `/recorder` 别名，`/exit` 作为退出别名
- **`/auth rm`**: 作为 `/auth del` 的别名

#### 多类型引用消息
- 支持引用 picture/richText/chatRecord/file/video/audio/actionCard/interactiveCard 等消息类型
- 引用图片消息时自动下载并处理 OCR
- 引用文件消息时自动下载到 `.files/{type}/` 目录
- 引用消息格式化增强：显示引用类型和发送者信息

#### 文件消息增强
- 新增 `downloadToFilesDir` 通用文件下载函数，支持同名文件自动追加序号
- 新增 `extractFileName` 从 rawData 提取文件名
- 新增 `detectExtFromBuffer` 通过魔数检测文件类型（PDF/DOCX/XLSX 等）
- `extractDownloadCode` 优先级修正：`downloadCode` 优先于 `pictureDownloadCode`

#### 管理员体系
- 新增 `adminUserList` 配置，管理员除 `/reboot`、`/open`、`/cfg` 注册外与 owner 同权
- `/auth admin add <userId>` 添加管理员
- `/auth admin rm <userId>` 移除管理员
- `/auth admin` 查看管理员列表
- owner/admin 始终放行白名单检查

#### 私聊消息能力
- 新增 `enableMsgToUser` 配置，开启后支持通过钉钉 oToMessages API 向用户发送私聊消息
- `sendMessageToUser` 增加开关检查，未配置时跳过发送

### 修复
- **`/end` 后仍收到 AI 回复**: close 事件和 result 流增加 `interrupted` 标志检查，中断后丢弃残余消息
- **消息队列未自动执行**: `/new` 结束当前会话后 finally 中补充队列 drain 逻辑
- **图片下载 ENOENT**: downloadCode 中含 `/`、`+` 等 Base64 特殊字符时文件名清理
- **引用消息无响应**: 引用消息只 @机器人（无额外文本）时不再提前 return，改为检查引用内容后继续处理
- **`/cc` 命令自动补全 `/`**: `/cc compact` 自动转换为 `/compact`
- **会话重试循环不停**: 新增 `isSessionStillActive` 检查，`/end` 后停止重试

### 优化
- `endSession` 时清空消息队列，避免残留消息干扰
- `goonPending` 处理时重置 `interrupted` 标志
- `/cc` 命令描述更新为"透传命令给 Claude（无需 / 前缀）"

## 0.1.0 (2026-05-30)

### 新功能

#### P0 可靠性增强
- **Watchdog 超时检测**: Claude 进程 5 分钟无活动自动通知用户，防止进程假死
- **无限重试检测**: 跟踪重试历史，总重试超 10 次或持续超 5 分钟自动终止并通知用户，防止死循环
- **Context Window 自动恢复**: 检测上下文窗口超长错误(400)后自动发送 `/compact` 压缩上下文，恢复会话而不是直接失败

#### 新命令
- **`/goon`**: 强制重启 Claude 进程并发送"继续"恢复执行，用于进程卡住时恢复
- **`/cc <消息>`**: 直接透传消息给 Claude，不附加发送人信息
- **`/claude.md`**: 查看当前工作目录的 CLAUDE.md 文件内容
- **`/open code`**: 支持用 VS Code 打开工作目录
- **`/recorder on|exit`**: Recorder 模式，owner 单聊专用，开启后所有消息按类型分类记录到本地 Markdown 文件，支持 text/picture/file/video/audio/chatRecord/richText/actionCard/interactiveCard 等消息类型，附件自动下载保存

#### 通知与审批
- **notify CLI 命令**: `cc-ding notify -ci <clientId> -c <会话ID> -m <消息>` 从命令行向指定会话发送消息，支持多会话、@人、Markdown 格式，适用于 CI/CD 通知和脚本告警
- **Owner 私聊通知**: 通过钉钉 oToMessages API 支持给 owner 发送私聊通知
- **授权申请流程**: 未授权用户可发起授权申请，owner 通过 `/auth approve|reject <requestId>` 审批，支持完整闭环（申请 → owner 私聊通知 → 审批 → 用户收到结果）

### 配置变更
- `config.json` 新增可选字段:
  - `ownerConversationId`: owner 单聊会话 ID，配置后支持授权审批通知和系统告警
  - `dingSecret`: 搭配 dingToken 的签名密钥
  - `recorderCfg.dist`: Recorder 模式自定义保存目录

### 优化
- `/clean` 额外清理 `.playwright-cli` 缓存目录
- `getImageDownloadUrl` / `downloadImageBuffer` 改为导出函数，支持 Recorder 等模块复用

## 0.0.5

- 初始版本
