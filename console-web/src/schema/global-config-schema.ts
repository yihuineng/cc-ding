// 全局 config.json 类型定义
// 机器级别配置，位于 ~/.cc-ding/config.json

/** 全局配置根结构 */
export interface IGlobalConfigFile {
  /** Console 服务配置 */
  console?: IConsoleConfig;
  /** API Key 池化配置 */
  apiKeyCfg?: IApiKeyCfg;
  /** 更新包下载地址 */
  updatePkgUrl?: string;
}

/** Console 服务配置 */
export interface IConsoleConfig {
  /** 服务端口，默认 8080 */
  port?: number;
  /** 服务绑定地址 */
  host?: string;
  /** 认证用户列表 */
  authUsers?: IAuthUser[];
  /** 远程 Console 列表 */
  remoteConsoles?: IRemoteConsoleConfig[];
}

/** 认证用户 */
export interface IAuthUser {
  /** 登录账号 */
  account: string;
  /** 密码哈希（SHA-256） */
  passwordHash: string;
  /** 是否首次登录（需要修改密码） */
  firstLogin?: boolean;
}

/** 远程 Console 配置 */
export interface IRemoteConsoleConfig {
  /** Console 地址，如 http://192.168.1.100:8080 */
  url: string;
  /** 显示名称 */
  hostname?: string;
  /** 登录账号 */
  username?: string;
  /** 登录密码 */
  password?: string;
  /** API Token（与账号密码二选一） */
  token?: string;
  /** 该远程机器上的 Client ID 列表（留空表示全部） */
  clientIds?: string[];
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
  /** Base URL，如 https://api.anthropic.com */
  baseUrl: string;
  /** 主模型，如 claude-sonnet-4-20250514 */
  model: string;
  /** 小模型（用于轻量任务） */
  smallModel?: string;
  /** 是否有效 */
  isValid: boolean;
  /** 备注说明 */
  memo?: string;
}

// JSON Schema 用于 Monaco Editor 校验
export const globalConfigSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  properties: {
    console: {
      type: 'object',
      description: 'Console 服务配置',
      properties: {
        port: { type: 'integer', description: '服务端口', minimum: 1, maximum: 65535 },
        host: { type: 'string', description: '服务绑定地址' },
        authUsers: {
          type: 'array',
          description: '认证用户列表',
          items: {
            type: 'object',
            required: ['account', 'passwordHash'],
            properties: {
              account: { type: 'string', description: '登录账号' },
              passwordHash: { type: 'string', description: '密码哈希（SHA-256）' },
              firstLogin: { type: 'boolean', description: '是否首次登录' },
            },
          },
        },
        remoteConsoles: {
          type: 'array',
          description: '远程 Console 列表',
          items: {
            type: 'object',
            required: ['url'],
            properties: {
              url: { type: 'string', description: 'Console 地址', format: 'uri' },
              hostname: { type: 'string', description: '显示名称' },
              username: { type: 'string', description: '登录账号' },
              password: { type: 'string', description: '登录密码' },
              token: { type: 'string', description: 'API Token' },
              clientIds: { type: 'array', items: { type: 'string' }, description: 'Client ID 列表' },
            },
          },
        },
      },
    },
    apiKeyCfg: {
      type: 'object',
      description: 'API Key 池化配置（全局）',
      properties: {
        modelSettings: {
          type: 'array',
          description: 'API Key 列表',
          items: {
            type: 'object',
            required: ['apiKey', 'baseUrl', 'model', 'isValid'],
            properties: {
              apiKey: { type: 'string', description: 'API Key' },
              baseUrl: { type: 'string', description: 'Base URL', format: 'uri' },
              model: { type: 'string', description: '主模型' },
              smallModel: { type: 'string', description: '小模型' },
              isValid: { type: 'boolean', description: '是否有效' },
              memo: { type: 'string', description: '备注' },
            },
          },
        },
        retryLogs: { type: 'object', description: '重试日志' },
        resetTime: { type: 'string', description: '重置时间' },
      },
    },
    updatePkgUrl: { type: 'string', description: '更新包下载地址', format: 'uri' },
  },
};

// TypeScript 类型定义文本（用于页面展示）
export const globalConfigTypeDefinition = `// 全局 config.json 类型定义
// 机器级别配置，位于 ~/.cc-ding/config.json

/** 全局配置根结构 */
interface IGlobalConfigFile {
  /** Console 服务配置 */
  console?: IConsoleConfig;
  /** API Key 池化配置 */
  apiKeyCfg?: IApiKeyCfg;
  /** 更新包下载地址 */
  updatePkgUrl?: string;
}

/** Console 服务配置 */
interface IConsoleConfig {
  /** 服务端口，默认 8080 */
  port?: number;
  /** 服务绑定地址 */
  host?: string;
  /** 认证用户列表 */
  authUsers?: IAuthUser[];
  /** 远程 Console 列表 */
  remoteConsoles?: IRemoteConsoleConfig[];
}

/** 认证用户 */
interface IAuthUser {
  /** 登录账号 */
  account: string;
  /** 密码哈希（SHA-256） */
  passwordHash: string;
  /** 是否首次登录 */
  firstLogin?: boolean;
}

/** 远程 Console 配置 */
interface IRemoteConsoleConfig {
  /** Console 地址 */
  url: string;
  /** 显示名称 */
  hostname?: string;
  /** 登录账号 */
  username?: string;
  /** 登录密码 */
  password?: string;
  /** API Token */
  token?: string;
  /** Client ID 列表 */
  clientIds?: string[];
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
