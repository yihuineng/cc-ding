// Client config.json 类型定义
// 每个 client 的配置，位于 ~/.cc-ding/{clientId}/config.json

/** Client 配置根结构 */
export interface IClientConfig {
  /** 客户端显示名称 */
  clientName?: string;
  /** Owner 手机号或工号 */
  owner?: string;
  /** 默认模型 */
  model?: string;
  /** 钉钉 Stream Client 密钥 */
  clientSecret: string;
  /** 兜底钉钉机器人 Token */
  defaultDingToken?: string;
  /** 白名单用户列表 */
  whiteUserList: string[];
  /** 管理员列表 */
  adminUserList?: string[];
  /** Owner 单聊会话 ID */
  ownerConversationId?: string;
  /** 前置命令 */
  preBash?: string;
  /** 钉钉签名密钥 */
  dingSecret?: string;
  /** DEBUG 模式 */
  debug?: boolean;
  /** 结果模式 */
  resultOnly?: boolean;
  /** 包含思考过程 */
  includeThinking?: boolean;
  /** 启用单聊消息 */
  enableMsgToUser?: boolean;
  /** 任务队列大小 */
  taskQueueSize?: number;
  /** 最大并发会话数 */
  sessionMaxConcurrency?: number;
  /** Watchdog 超时时间（分钟） */
  maxTurnTimeMins?: number;
  /** 自动恢复次数 */
  maxAutoRecovery?: number;
  /** AI Card 模板 ID */
  cardTemplateId?: string;
  /** AI Card 模板变量名 */
  cardTemplateKey?: string;
  /** 会话列表 */
  conversations: IConversation[];
  /** A2A 配置 */
  a2aCfg?: IA2ACfg;
  /** API Key 池化配置（可选，优先级高于全局） */
  apiKeyCfg?: IApiKeyCfg;
}

/** 会话配置 */
export interface IConversation {
  /** 会话 ID */
  conversationId: string;
  /** 会话标题 */
  conversationTitle?: string;
  /** 会话类型：1=单聊，2=群聊 */
  conversationType: '1' | '2';
  /** 钉钉机器人 Token */
  dingToken?: string;
  /** 白名单用户列表 */
  whiteUserList?: string[];
  /** 关联的主会话 ID */
  linkConversationId?: string;
  /** 使用的模型 */
  model?: string;
  /** Agent 类型 */
  agent?: string;
  /** 是否流式输出 */
  streaming?: boolean;
  /** QA 模式 */
  qaMode?: boolean;
  /** 自由模式 */
  freedomMode?: boolean;
  /** 权限模式 */
  permissionMode?: 'acceptEdits' | 'bypassPermissions' | 'plan' | 'auto' | 'dontAsk';
  /** 前置命令 */
  preBash?: string;
  /** 工作目录 */
  workDir?: string;
  /** 是否接收回复 */
  receiveReply?: boolean;
  /** 接收回复模式 */
  receiveReplyMode?: 'reaction' | 'text';
  /** 确认反应表情 */
  ackReaction?: string;
  /** 是否 @发送者 */
  atSender?: boolean;
  /** 是否确保 @ */
  ensureAt?: boolean;
  /** 是否使用本地 OCR */
  useLocalOcr?: boolean;
  /** 最大回合时间（分钟） */
  maxTurnTimeMins?: number;
}

/** A2A 配置 */
export interface IA2ACfg {
  /** Hub URL */
  hubUrl?: string;
  /** API Key */
  apiKey?: string;
  /** 远程 Agents 列表 */
  remoteAgents?: any[];
}

/** API Key 池化配置 */
export interface IApiKeyCfg {
  /** API Key 列表 */
  modelSettings: IApiKeySetting[];
  /** 重试日志 */
  retryLogs?: Record<string, string[]>;
  /** 重置时间 */
  resetTime?: string;
}

/** 单个 API Key 配置 */
export interface IApiKeySetting {
  /** API Key */
  apiKey: string;
  /** Base URL */
  baseUrl: string;
  /** 主模型 */
  model: string;
  /** 小模型 */
  smallModel?: string;
  /** 是否有效 */
  isValid: boolean;
  /** 备注 */
  memo?: string;
}

// TypeScript 类型定义文本（用于页面展示）
export const clientConfigTypeDefinition = `// Client config.json 类型定义
// 每个 client 的配置，位于 ~/.cc-ding/{clientId}/config.json

/** Client 配置根结构 */
interface IClientConfig {
  /** 客户端显示名称 */
  clientName?: string;
  /** Owner 手机号或工号 */
  owner?: string;
  /** 默认模型 */
  model?: string;
  /** 钉钉 Stream Client 密钥 */
  clientSecret: string;
  /** 兜底钉钉机器人 Token */
  defaultDingToken?: string;
  /** 白名单用户列表 */
  whiteUserList: string[];
  /** 管理员列表 */
  adminUserList?: string[];
  /** Owner 单聊会话 ID */
  ownerConversationId?: string;
  /** 前置命令 */
  preBash?: string;
  /** 钉钉签名密钥 */
  dingSecret?: string;
  /** DEBUG 模式 */
  debug?: boolean;
  /** 结果模式 */
  resultOnly?: boolean;
  /** 包含思考过程 */
  includeThinking?: boolean;
  /** 启用单聊消息 */
  enableMsgToUser?: boolean;
  /** 任务队列大小 */
  taskQueueSize?: number;
  /** 最大并发会话数 */
  sessionMaxConcurrency?: number;
  /** Watchdog 超时时间（分钟） */
  maxTurnTimeMins?: number;
  /** 自动恢复次数 */
  maxAutoRecovery?: number;
  /** AI Card 模板 ID */
  cardTemplateId?: string;
  /** AI Card 模板变量名 */
  cardTemplateKey?: string;
  /** 会话列表 */
  conversations: IConversation[];
  /** A2A 配置 */
  a2aCfg?: IA2ACfg;
  /** API Key 池化配置（可选） */
  apiKeyCfg?: IApiKeyCfg;
}

/** 会话配置 */
interface IConversation {
  /** 会话 ID */
  conversationId: string;
  /** 会话标题 */
  conversationTitle?: string;
  /** 会话类型：1=单聊，2=群聊 */
  conversationType: '1' | '2';
  /** 钉钉机器人 Token */
  dingToken?: string;
  /** 白名单用户列表 */
  whiteUserList?: string[];
  /** 关联的主会话 ID */
  linkConversationId?: string;
  /** 使用的模型 */
  model?: string;
  /** Agent 类型 */
  agent?: string;
  /** 是否流式输出 */
  streaming?: boolean;
  /** QA 模式 */
  qaMode?: boolean;
  /** 自由模式 */
  freedomMode?: boolean;
  /** 权限模式 */
  permissionMode?: 'acceptEdits' | 'bypassPermissions' | 'plan' | 'auto' | 'dontAsk';
  /** 前置命令 */
  preBash?: string;
  /** 工作目录 */
  workDir?: string;
  /** 是否接收回复 */
  receiveReply?: boolean;
  /** 接收回复模式 */
  receiveReplyMode?: 'reaction' | 'text';
  /** 确认反应表情 */
  ackReaction?: string;
  /** 是否 @发送者 */
  atSender?: boolean;
  /** 是否确保 @ */
  ensureAt?: boolean;
  /** 是否使用本地 OCR */
  useLocalOcr?: boolean;
  /** 最大回合时间（分钟） */
  maxTurnTimeMins?: number;
}

/** A2A 配置 */
interface IA2ACfg {
  /** Hub URL */
  hubUrl?: string;
  /** API Key */
  apiKey?: string;
  /** 远程 Agents 列表 */
  remoteAgents?: any[];
}

/** API Key 池化配置 */
interface IApiKeyCfg {
  /** API Key 列表 */
  modelSettings: IApiKeySetting[];
  /** 重试日志 */
  retryLogs?: Record<string, string[]>;
  /** 重置时间 */
  resetTime?: string;
}

/** 单个 API Key 配置 */
interface IApiKeySetting {
  /** API Key */
  apiKey: string;
  /** Base URL */
  baseUrl: string;
  /** 主模型 */
  model: string;
  /** 小模型 */
  smallModel?: string;
  /** 是否有效 */
  isValid: boolean;
  /** 备注 */
  memo?: string;
}
`;
