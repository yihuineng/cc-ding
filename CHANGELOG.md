# Changelog

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
