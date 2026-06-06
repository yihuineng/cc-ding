import { spawn } from 'child_process';
import { RobotTextMessage } from 'utils-ok';

// config.json
export interface IConfig {
  clientName?: string;
  whiteUserList: string[]; // 白名单
  owner: string; // 机器人 owner（手机号，可执行敏感操作如 /clean）
  /** 管理员列表（手机号或userId），除 /reboot、/open、/cfg 注册外与 owner 同权 */
  adminUserList?: string[];
  clientSecret: string; // 钉钉 Stream Client 密钥
  dingSecret?: string; // 搭配 dingToken 发送群消息的签名密钥
  /** 默认 dingToken，当会话无 dingToken 时使用（必填） */
  defaultDingToken: string;
  /** owner 单聊会话ID，配置后兜底消息/通知通过该会话发送给 owner */
  ownerConversationId?: string;
  /** 是否开启单聊消息能力（通过 oToMessages API 向用户发私聊消息），默认 false */
  enableMsgToUser?: boolean;
  conversations: IConversation[];
  taskQueueSize?: number; // 默认50
  taskHandlerCount?: number; // 默认1个
  sessionMaxConcurrency?: number; // 最大并发cc会话, session场景, 默认5
  /** 是否在回复中包含思考过程，默认 false */
  includeThinking?: boolean;
  /** 是否只返回最终结果（不包含过程信息），默认 true */
  resultOnly?: boolean;
  /** API Key 池化管理（可选，配置后启用 API Key 轮换） */
  apiKeyCfg?: {
    resetTime?: string; // 最近一次重置时间 yyyy-MM-dd HH:mm:ss
    claudeSettings: IClaudeSetting[];
  };
  /** 是否开启 DEBUG 日志，默认 false */
  debug?: boolean;
  /** /bash 执行前的前置命令，与群级别 preBash 叠加执行，顺序为 `全局 && 群 && userCmd` */
  preBash?: string;
  /** Recorder 模式配置（owner 单聊专用） */
  recorderCfg?: {
    /** 保存目录，默认为会话工作目录下的 .recorder */
    dist?: string;
  };
}

export interface IConversation {
  conversationId: string;
  conversationType: string; // 1 为单聊 2 为群聊
  linkConversationId?: string; // 关联会话ID, 指定时共用该id的工作目录(多个群机器人记忆共享场景, 同时也需要注意并发控制避免文件操作冲突)
  conversationTitle?: string;
  dingToken?: string; // 机器人单聊时, 不存在
  whiteUserList?: string[]; // 机器人实例维度白名单, 定义时优先级高于Client维度
  agent?: string; // 指定agent
  useLocalOcr?: boolean; // 本地 OCR 降级（用于不支持图片识别的模型），默认 true
  atSender?: boolean; // 回复时是否 at 发送人，默认 true
  /** 是否回复"收到"等确认消息，默认 true */
  receiveReply?: boolean;
  /** /bash 执行前的前置命令（群级别，与全局 preBash 叠加执行） */
  preBash?: string;
  sessionCfg?: {
    // task 功能默认开启，无需配置开关
  }; // 群维度session相关配置
  taskCfg?: {
    skill?: string; // 指定技能处理
  }; // 群维度task相关配置
}

// 会话信息
export interface ISession {
  conversationId: string;
  sessionWebhook: string;
  currentWebhook?: string; // 当前提问来源的回复webhook(关联群场景)
  currentConversationId?: string;  // 当前提问来源的会话ID(关联群场景)
  startTime: number;
  startTimeStr: string;
  startStaffId: string;
  startNickName: string;
  claudeSessionId?: string;
}

// 任务信息
export interface ITask {
  conversationId: string;
  sessionWebhook: string;
  startTime: number; // 用于taskId
  startTimeStr: string; // 任务开始时间字符串，用于目录命名
  senderStaffId: string;
  senderNickName: string;
  prompt: string;
  promptSimply?: string; // 预处理优化后的需求描述
  title?: string; // 预处理生成的简短标题
  retryCount?: number; // 重试次数，超过上限标记为失败
  type?: 'cron' | 'normal'; // 任务类型：cron-定时任务，normal-普通任务
}

// 活跃会话状态
export interface IActiveSession {
  session: ISession;
  lastSenderStaffId: string;
  isProcessing: boolean;
  conversationConfig: IConfig['conversations'][0];
  currentProcess?: ReturnType<typeof spawn>; // 当前执行的 Claude 进程
  interrupted?: boolean; // 是否被用户中断
  goonPending?: boolean; // 是否收到 /goon 请求，待重启
  lastActivityTime?: number; // 最近一次 Claude 进程活动时间（watchdog 用）
  /** 排队中的消息，当前查询完成后依次处理 */
  messageQueue: Array<{ message: string; senderStaffId: string; senderNick: string }>;
}

// 活跃会话持久化数据（不含运行时字段）
export interface IActiveSessionPersist {
  session: ISession;
  lastSenderStaffId: string;
  conversationConfig: IConfig['conversations'][0];
}

// 待审批的授权申请
export interface IAuthRequest {
  id: string;
  senderStaffId: string;
  senderNick: string;
  conversationId: string;
  conversationType?: string;
  conversationTitle?: string;
  requestTime: number;
}

// Claude 配置项（API Key 池化管理的单个配置）
export interface IClaudeSetting {
  isValid: boolean;   // 是否有效，429 或连续 TPM 快速失败时置 false，跨天自动重置为 true
  apiKey: string;     // API Key
  baseUrl: string;    // API Base URL
  model: string;      // 使用的模型
  smallModel?: string; // 可选的小模型（预处理等轻量场景）
  memo?: string; // 备注信息
}

/** 钉钉回调中被引用的消息结构 */
export interface IRepliedMsg {
  createdAt?: number;
  senderId?: string;
  senderNick?: string;
  senderStaffId?: string;
  msgType?: string;
  msgId?: string;
  content?: {
    text?: string;
    richText?: IRichTextParagraph[];
    chatRecords?: IChatRecordItem[];
    fileName?: string;
    fileSize?: string;
    downloadCode?: string;
    title?: string;
    markdown?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** 聊天记录中的单条消息 */
export interface IChatRecordItem {
  senderNick?: string;
  senderName?: string;
  content?: string;
  text?: string;
  msgtype?: string;
  msgType?: string;
  [key: string]: unknown;
}

/** 钉钉回调 text 字段(扩展 RobotTextMessage.text,包含引用相关字段) */
export interface ITextWithReply {
  content: string;
  isReply?: boolean;
  repliedMsg?: IRepliedMsg;
}

/** 图��� MIME 类型 */
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

/** 下载后的图片信息 */
export interface IDownloadedImage {
  mediaType: ImageMediaType;
  filePath: string;
  sizeBytes: number;
}

/** richText 段落结构 */
export interface IRichTextParagraph {
  type: 'text' | 'picture' | 'mention';
  text?: string;
  downloadCode?: string;           // 图片下载码(用于 /v1.0/robot/messageFiles/download API)
  pictureDownloadCode?: string;    // 图片下载码(备用字段)
  userId?: string;
}

/** 钉钉回调原始数据(扩展 RobotTextMessage,包含引用相关字段) */
export interface IRawCallbackData extends Omit<RobotTextMessage, 'text' | 'msgtype'> {
  msgtype: string;
  text?: ITextWithReply;
  content?: { richText: IRichTextParagraph[] };  // richText 消息内容(msgtype=richText 时)
  pictureDownloadCode?: string;                  // 独立图片消息的下载码(msgtype=picture 时)
  fileDownloadCode?: string;                     // 文件下载码(msgtype=file 时)
  fileName?: string;                             // 文件名(msgtype=file 时)
  downloadCode?: string;                         // 通用下载码(多种消息类型)
  originalMsgId?: string;   // 原始消息ID(钉钉回调可选字段)
}

/** 解析后的引用信息 */
export interface IQuoteInfo {
  quoteText: string;           // 引用消息的文本内容
  quoteMessageId?: string;     // 引用消息ID(调试用)
  quoteSenderNick?: string;    // 引用消息的发送者昵称(如可获取)
  quoteMsgType?: string;       // 被引用消息类型(picture/richText/file等)
  quoteDownloadCode?: string;  // 引用消息中的下载码(图片/文件)
  quoteFileName?: string;      // 引用消息中的文件名(文件消息)
  quoteRichText?: IRichTextParagraph[]; // 引用的富文本段落(用于下载内嵌图片)
}

export interface ISendMsgOpts {
  conversationId: string;
  sessionWebhook: string;
  atUserId?: string;
  content: string;
  msgType?: 'text' | 'markdown';
}

/** 钉钉 /topapi/v2/user/get 返回的用户详情 */
export interface IDingUserDetail {
  userid: string;
  unionid?: string;
  name: string;
  avatar?: string;
  mobile?: string;
  email?: string;
  orgEmail?: string;
  telephone?: string;
  jobNumber?: string;
  title?: string;
  workPlace?: string;
  remark?: string;
  leader?: boolean;
  dept?: number[];
  deptOrder?: number[];
  isLeaderInDept?: boolean[];
  active?: boolean;
  hiredDate?: number;
  roleList?: Array<{
    id: number;
    name: string;
    groupName: string;
    type: number;
  }>;
  extattr?: string;
  senior?: boolean;
  userId?: string; // 兼容字段
}
