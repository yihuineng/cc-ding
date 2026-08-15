export interface IClient {
  clientId: string
  clientName?: string
  online: boolean
  pid?: number
  conversationCount: number
  apiKeysValid: number
  apiKeyCount: number
  remote?: boolean
  remoteUrl?: string
}

export interface IConfig {
  clientName?: string
  owner?: string
  model?: string
  whiteUserList?: string[]
  adminUserList?: string[]
  ownerConversationId?: string
  preBash?: string
  dingSecret?: string
  debug?: boolean
  resultOnly?: boolean
  includeThinking?: boolean
  enableMsgToUser?: boolean
  taskQueueSize?: number
  sessionMaxConcurrency?: number
  maxTurnTimeMins?: number
  maxAutoRecovery?: number
  cardTemplateId?: string
  cardTemplateKey?: string
  a2aCfg?: { hubUrl?: string; apiKey?: string; remoteAgents?: any[] }
  conversations?: IConversation[]
}

export interface IConversation {
  conversationId: string
  conversationTitle?: string
  conversationType: '1' | '2'
  dingToken?: string
  whiteUserList?: string[]
  linkConversationId?: string
  model?: string
  agent?: string
  streaming?: boolean
  qaMode?: boolean
  freedomMode?: boolean
  permissionMode?: string
  preBash?: string
  workDir?: string
  receiveReply?: boolean
  receiveReplyMode?: 'reaction' | 'text'
  ackReaction?: string
  atSender?: boolean
  ensureAt?: boolean
  useLocalOcr?: boolean
  maxTurnTimeMins?: number
  taskCfg?: { skill?: string }
  /** 团队协作 Agent 列表（clientId:conversationId 格式） */
  teamAgents?: string[]
}

export interface IApiKey {
  key: string
  model: string
  smallModel?: string
  baseUrl?: string
  isValid: boolean
  remark?: string
}

export interface IGlobalConfig {
  port?: number
  host?: string
  remoteConsoles?: IRemoteConsole[]
  updatePkgUrl?: string
}

export interface IRemoteConsole {
  url: string
  hostname?: string
  token?: string
  username?: string
  password?: string
  clientIds?: string[]
}

export interface IStatus {
  hostname: string
  ccDingVersion: string
  nodeVersion: string
  platform: string
  uptime: number
  buildTime?: string
}

export interface IAttachment {
  type: 'image' | 'file';
  fileId: string;
  fileName: string;
  mimeType: string;
  size: number;
  url: string;
}

export interface IChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  senderStaffId?: string;
  senderNick?: string;
  source: 'ding' | 'web';
  timestamp: number;
  attachments?: IAttachment[];
}
