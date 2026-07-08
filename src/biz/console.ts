import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { fileUtil } from 'utils-ok';
import { spawnCommand, commandExists, isWindows } from './platform';
import { getHomeDir } from './session';
import { isEnvRef } from './secrets';
import { setCorsHeaders, readBody } from './a2a/http-utils';
import type { IConfig, IClaudeSetting } from './types';
import { execFile } from 'child_process';
import { promisify } from 'util';
const execFileAsync = promisify(execFile);

// ==================== 类型定义 ====================

/** 认证用户信息 */
interface IAuthUser {
  account: string;
  passwordHash: string; // SHA-256 hash
  firstLogin: boolean;
}

/** 远程 Console 配置 */
interface IRemoteConsole {
  /** Console 访问地址（如 http://192.168.1.100:8080） */
  url: string;
  /** 自定义主机名（用于展示，不填则显示 URL） */
  hostname?: string;
  /** API Token（用于认证，与 username/password 二选一） */
  token?: string;
  /** 登录账号（与 token 二选一） */
  username?: string;
  /** 登录密码（与 token 二选一） */
  password?: string;
  /** 该 Console 管理的 client IDs（可选，不配置则自动获取） */
  clientIds?: string[];
}

/** 全局 Console 配置 */
interface IConsoleGlobalConfig {
  /** HTTP 监听端口，默认 8080 */
  port?: number;
  /** HTTP 监听地址，默认 '0.0.0.0' */
  host?: string;
  /** 认证用户列表 */
  authUsers?: IAuthUser[];
  /** 远程 Console 列表（用于跨机器管理） */
  remoteConsoles?: IRemoteConsole[];
}

/** 全局配置文件（~/.cc-ding/config.json） */
interface IGlobalConfigFile {
  /** Console 配置 */
  console?: IConsoleGlobalConfig;
  /** 更新包 URL（/reboot --update 时优先从此 URL 下载安装包） */
  updatePkgUrl?: string;
  /** 其他根级别字段 */
  [key: string]: unknown;
}

/** 系统状态信息 */
interface ISystemStatus {
  ccDingVersion: string;
  nodeVersion: string;
  platform: string;
  hostname: string;
  uptime: number;
  clients: number;
  onlineClients: number;
}

/** Bearer Token 记录 */
interface IAuthToken {
  token: string;
  account: string;
  expiresAt: number; // timestamp
}

// ==================== 常量 ====================

const FAVICON_PATH = path.join(__dirname, '..', '..', '..', 'favicon.ico');
const FAVICON_DATA = fs.existsSync(FAVICON_PATH) ? fs.readFileSync(FAVICON_PATH) : Buffer.alloc(0);
const GLOBAL_CONFIG_PATH = path.join(getHomeDir(), '.cc-ding', 'config.json');
const SETTINGS_TPL_PATH = path.join(getHomeDir(), '.cc-ding', 'settings-tpl.json');

// 内存中存储的 token（重启后失效，24h 过期）
const activeTokens = new Map<string, IAuthToken>();
const TOKEN_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 小时

// ==================== 工具函数 ====================

/** SHA-256 哈希 */
function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/** 掩码显示敏感字段：仅显示前后4位 */
function maskSecret(value: string | undefined): string {
  if (!value) return '';
  if (isEnvRef(value)) return value; // $ENV:xxx 不解密，不掩码
  if (value.length <= 8) return '****';
  return value.substring(0, 4) + '****' + value.substring(value.length - 4);
}

/** 原子写入：先写 .tmp 再 rename 覆盖 */
function atomicWrite(filePath: string, content: string): void {
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, content, { encoding: 'utf-8' });
  fs.renameSync(tmpPath, filePath);
  // 设置权限
  if (!isWindows()) {
    try { fs.chmodSync(filePath, 0o600); } catch { /* ignore */ }
  }
}

/** 安全备份文件 */
function backupFile(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  const backupPath = filePath + '.bak';
  try {
    fs.copyFileSync(filePath, backupPath);
    return backupPath;
  } catch {
    return null;
  }
}

/** 解析逗号分隔字符串或直接返回数组 */
function parseStringList(val: unknown): string[] {
  if (Array.isArray(val)) return val;
  if (typeof val === 'string') return val.split(',').map(s => s.trim()).filter(Boolean);
  return [];
}

/** 设置 dot-path 嵌套值 */
function dotPathSet(obj: any, pathStr: string, value: any): void {
  const keys = pathStr.split('.');
  let current = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (!(key in current)) current[key] = {};
    current = current[key];
  }
  const lastKey = keys[keys.length - 1];
  current[lastKey] = value;
}

/** 获取全局 Console 配置 */
function getGlobalConfig(): IGlobalConfigFile {
  try {
    if (fs.existsSync(GLOBAL_CONFIG_PATH)) {
      const content = fs.readFileSync(GLOBAL_CONFIG_PATH, 'utf-8');
      const parsed = JSON.parse(content);
      const users = parsed.console?.authUsers || [];
      // 如果没有配置用户，自动创建默认 admin 用户
      if (users.length === 0) {
        parsed.console = parsed.console || {};
        parsed.console.authUsers = [{ account: 'admin', passwordHash: sha256('admin'), firstLogin: true }];
        atomicWrite(GLOBAL_CONFIG_PATH, JSON.stringify(parsed, null, 2));
      }
      return {
        console: {
          port: parsed.console?.port || parsed.consolePort || 8080,
          host: parsed.console?.host || parsed.consoleHost || '0.0.0.0',
          authUsers: parsed.console?.authUsers || [],
          remoteConsoles: parsed.console?.remoteConsoles || [],
        },
        updatePkgUrl: parsed.updatePkgUrl,
      };
    }
  } catch {
    // ignore parse errors
  }
  return {
    console: {
      port: 8080,
      host: '0.0.0.0',
      authUsers: [{ account: 'admin', passwordHash: sha256('admin'), firstLogin: true }],
      remoteConsoles: [],
    },
  };
}

/** 获取有效的 apiKeyCfg：client 维度优先，fallback 到全局维度 */
function getEffectiveApiKeyCfg(clientConfig: IConfig | null): any {
  // 仅当 client 有实际配置的 keys 时才使用 client 配置
  if (clientConfig?.apiKeyCfg?.modelSettings?.length) {
    return clientConfig.apiKeyCfg;
  }
  // fallback 到全局配置
  try {
    const globalRaw = fs.existsSync(GLOBAL_CONFIG_PATH)
      ? JSON.parse(fs.readFileSync(GLOBAL_CONFIG_PATH, 'utf-8'))
      : {};
    return globalRaw.apiKeyCfg;
  } catch {
    return undefined;
  }
}

/** 获取客户端所属的远程 Console 配置（如果是远程客户端） */
// Token 缓存：remoteConsoleUrl -> { token, expiresAt }
const tokenCache = new Map<string, { token: string; expiresAt: number }>();
const TOKEN_CACHE_TTL = 23 * 60 * 60 * 1000; // 23 小时（略小于 24 小时的 token 有效期）

// 远程客户端映射缓存：clientId -> remoteConsoleUrl
const remoteClientMap = new Map<string, string>();

function getClientRemoteConsole(clientId: string): IRemoteConsole | null {
  const globalCfg = getGlobalConfig();
  const remoteConsoles = globalCfg.console?.remoteConsoles || [];

  // 先检查 clientIds 配置
  const byClientIds = remoteConsoles.find(rc => rc.clientIds?.includes(clientId));
  if (byClientIds) return byClientIds;

  // 再检查缓存的映射关系
  const remoteUrl = remoteClientMap.get(clientId);
  if (remoteUrl) {
    const byCache = remoteConsoles.find(rc => rc.url === remoteUrl);
    if (byCache) return byCache;
  }

  return null;
}

/** 获取远程 Console 的 API Token（支持自动登录和缓存） */
async function getRemoteConsoleToken(remoteConsole: IRemoteConsole): Promise<string> {
  // 如果已配置 token，直接返回
  if (remoteConsole.token) {
    return remoteConsole.token;
  }

  // 检查缓存
  const cached = tokenCache.get(remoteConsole.url);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.token;
  }

  // 如果配置了账号密码，自动登录获取 token
  if (remoteConsole.username && remoteConsole.password) {
    const loginUrl = `${remoteConsole.url.replace(/\/$/, '')}/api/login`;
    const res = await fetch(loginUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        account: remoteConsole.username,
        password: remoteConsole.password,
      }),
    });

    if (!res.ok) {
      throw new Error(`远程 Console 登录失败: ${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    if (!data.token) {
      throw new Error('远程 Console 登录失败: 未返回 token');
    }

    // 缓存 token
    tokenCache.set(remoteConsole.url, {
      token: data.token,
      expiresAt: Date.now() + TOKEN_CACHE_TTL,
    });

    return data.token;
  }

  throw new Error('远程 Console 未配置认证信息（需要 token 或 username/password）');
}

/** 代理请求到远程 Console */
async function proxyToRemoteConsole(
  remoteConsole: IRemoteConsole,
  method: string,
  apiPath: string,
  body?: string,
): Promise<{ status: number; data: any }> {
  const url = `${remoteConsole.url.replace(/\/$/, '')}${apiPath}`;
  const token = await getRemoteConsoleToken(remoteConsole);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
  };

  const res = await fetch(url, {
    method,
    headers,
    body: body || undefined,
  });

  const data = await res.json();
  // 远程 Console 返回 401 时映射为 502，避免前端误判为本地认证失败而清除 token
  const mappedStatus = res.status === 401 ? 502 : res.status;
  return { status: mappedStatus, data };
}

/** 保存全局 Console 配置 */
function saveGlobalConfig(config: IConsoleGlobalConfig): void {
  const globalCfg = fs.existsSync(GLOBAL_CONFIG_PATH)
    ? fileUtil.getJSON(GLOBAL_CONFIG_PATH) as any
    : {};
  if (!globalCfg.console) globalCfg.console = {};
  if (config.port !== undefined) globalCfg.console.port = config.port;
  if (config.host !== undefined) globalCfg.console.host = config.host;
  if (config.authUsers !== undefined) globalCfg.console.authUsers = config.authUsers;
  if (config.remoteConsoles !== undefined) globalCfg.console.remoteConsoles = config.remoteConsoles;
  atomicWrite(GLOBAL_CONFIG_PATH, JSON.stringify(globalCfg, null, 2));
}

/** 生成随机 token */
function generateToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

/** 验证 token 并返回账号 */
function verifyToken(authHeader: string | undefined): string | null {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.substring(7);
  const record = activeTokens.get(token);
  if (!record) return null;
  if (Date.now() > record.expiresAt) {
    activeTokens.delete(token);
    return null;
  }
  return record.account;
}

/** 获取所有认证用户 */
function getAllAuthUsers(): IAuthUser[] {
  const globalCfg = getGlobalConfig();
  return globalCfg.console?.authUsers || [];
}

/** 更新认证用户密码 */
function updateAuthPassword(account: string, newPassword: string): boolean {
  const globalCfg = getGlobalConfig();
  const users = globalCfg.console?.authUsers || [];
  const user = users.find(u => u.account === account);
  if (!user) return false;
  user.passwordHash = sha256(newPassword);
  user.firstLogin = false;
  if (globalCfg.console) {
    saveGlobalConfig(globalCfg.console);
  }
  return true;
}

/** 扫描所有客户端配置目录 */
function scanClientDirs(): Array<{ clientId: string; configPath: string; config: IConfig | null }> {
  const homeDir = getHomeDir();
  const ccDir = path.join(homeDir, '.cc-ding');
  if (!fs.existsSync(ccDir)) return [];

  const results: Array<{ clientId: string; configPath: string; config: IConfig | null }> = [];
  try {
    const entries = fs.readdirSync(ccDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const clientId = entry.name;
      if (clientId.startsWith('.')) continue; // 跳过隐藏目录
      const configPath = path.join(ccDir, clientId, 'config.json');
      let config: IConfig | null = null;
      if (fs.existsSync(configPath)) {
        try {
          config = fileUtil.getJSON(configPath) as IConfig;
        } catch {
          // config.json 解析失败
        }
      }
      results.push({ clientId, configPath, config });
    }
  } catch {
    // ignore readdir errors
  }
  return results;
}

/** 检查客户端进程是否在线 */
function checkClientOnline(clientId: string): { online: boolean; pid?: number } {
  const homeDir = getHomeDir();
  const pidFile = path.join(homeDir, '.cc-ding', clientId, 'cc-ding.pid');
  // 先尝试标准 PID 文件
  if (fs.existsSync(pidFile)) {
    try {
      const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
      if (!isNaN(pid)) {
        try {
          process.kill(pid, 0);
          return { online: true, pid };
        } catch {
          return { online: false, pid };
        }
      }
    } catch {
      // ignore
    }
  }
  // 尝试备用锁文件
  const lockFile = path.join(homeDir, '.cc-ding', clientId, '.pid.lock');
  if (fs.existsSync(lockFile)) {
    try {
      const pid = parseInt(fs.readFileSync(lockFile, 'utf-8').trim(), 10);
      if (!isNaN(pid)) {
        try {
          process.kill(pid, 0);
          return { online: true, pid };
        } catch {
          return { online: false, pid };
        }
      }
    } catch {
      // ignore
    }
  }
  return { online: false };
}

/** 发送 SIGUSR2 信号到客户端进程 */
function sendReloadSignal(clientId: string): { success: boolean; error?: string } {
  const { online, pid } = checkClientOnline(clientId);
  if (!online || !pid) {
    return { success: false, error: '进程未运行，无法热重载' };
  }
  try {
    process.kill(pid, 'SIGUSR2');
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 获取支持的辅助文件名列表 */
const SUPPORTED_FILE_NAMES = [ 'menu.json', 'model.json', 'cron.json', 'todo.json', 'user-map.json', 'active.json' ];

/** 获取客户端辅助文件路径 */
function getClientFilePath(clientId: string, name: string): string | null {
  if (!SUPPORTED_FILE_NAMES.includes(name)) return null;
  const homeDir = getHomeDir();
  return path.join(homeDir, '.cc-ding', clientId, name);
}

// ==================== HTTP 响应工具 ====================

function jsonResponse(res: http.ServerResponse, statusCode: number, data: unknown): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function jsonError(res: http.ServerResponse, statusCode: number, message: string): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: message }));
}

function requireAuth(req: http.IncomingMessage, res: http.ServerResponse): string | null {
  const account = verifyToken(req.headers.authorization);
  if (!account) {
    jsonError(res, 401, '未认证或 token 已过期');
    return null;
  }
  return account;
}

function parseUrl(urlStr: string): { pathname: string; query: URLSearchParams } {
  try {
    const url = new URL(urlStr, 'http://localhost');
    return { pathname: url.pathname, query: url.searchParams };
  } catch {
    return { pathname: urlStr.split('?')[0], query: new URLSearchParams() };
  }
}

// ==================== API 路由处理 ====================

/** POST /api/login */
async function handleLogin(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const body = await readBody(req);
    const { account, password } = JSON.parse(body || '{}');
    if (!account || !password) {
      jsonError(res, 400, '缺少 account 或 password');
      return;
    }

    const users = getAllAuthUsers();
    const user = users.find(u => u.account === account);
    if (!user) {
      jsonError(res, 401, '账号或密码错误');
      return;
    }

    if (sha256(password) !== user.passwordHash) {
      jsonError(res, 401, '账号或密码错误');
      return;
    }

    const token = generateToken();
    activeTokens.set(token, {
      token,
      account: user.account,
      expiresAt: Date.now() + TOKEN_EXPIRY_MS,
    });

    jsonResponse(res, 200, {
      token,
      account: user.account,
      firstLogin: user.firstLogin,
      expiresAt: Date.now() + TOKEN_EXPIRY_MS,
    });
  } catch (err) {
    jsonError(res, 400, '请求格式错误');
  }
}

/** POST /api/change-password */
async function handleChangePassword(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const account = requireAuth(req, res);
  if (!account) return;

  try {
    const body = await readBody(req);
    const { newPassword } = JSON.parse(body || '{}');
    if (!newPassword || newPassword.length < 4) {
      jsonError(res, 400, '新密码至少需要 4 位');
      return;
    }
    const success = updateAuthPassword(account, newPassword);
    if (!success) {
      jsonError(res, 400, '账号不存在');
      return;
    }
    jsonResponse(res, 200, { message: '密码修改成功' });
  } catch (err) {
    jsonError(res, 400, '请求格式错误');
  }
}

/** POST /api/clients — 创建新客户端 */
async function handleCreateClient(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!requireAuth(req, res)) return;

  try {
    const body = await readBody(req);
    const data = JSON.parse(body || '{}');

    const { clientId, clientName, owner, clientSecret, defaultDingToken } = data;
    if (!clientId || !owner || !clientSecret || !defaultDingToken) {
      jsonError(res, 400, '缺少必填字段: clientId, owner, clientSecret, defaultDingToken');
      return;
    }

    if (!/^[a-zA-Z0-9_-]+$/.test(clientId)) {
      jsonError(res, 400, 'clientId 只能包含字母、数字、连字符和下划线');
      return;
    }

    const clientDir = path.join(getHomeDir(), '.cc-ding', clientId);
    const configPath = path.join(clientDir, 'config.json');
    if (fs.existsSync(configPath)) {
      jsonError(res, 409, 'clientId 已存在');
      return;
    }

    const whiteUserList = parseStringList(data.whiteUserList);
    const config: IConfig = {
      clientName: clientName || 'cc助手',
      owner,
      whiteUserList,
      clientSecret,
      defaultDingToken,
      conversations: [],
    };

    fs.mkdirSync(clientDir, { recursive: true });
    atomicWrite(configPath, JSON.stringify(config, null, 2));
    jsonResponse(res, 201, { message: '客户端已创建', clientId, configPath });
  } catch (err) {
    jsonError(res, 400, '请求格式错误');
  }
}

/** GET /api/clients */
async function handleGetClients(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!requireAuth(req, res)) return;

  const clientDirs = scanClientDirs();
  const clients = clientDirs.map(({ clientId, config }) => {
    const { online, pid } = checkClientOnline(clientId);
    return {
      clientId,
      clientName: config?.clientName || clientId,
      owner: config?.owner || '',
      online,
      pid: pid || undefined,
      conversationCount: config?.conversations?.length || 0,
      conversations: (config?.conversations || []).map(conv => ({
        conversationId: conv.conversationId,
        conversationTitle: conv.conversationTitle || '',
        conversationType: conv.conversationType,
        qaMode: !!conv.qaMode,
        freedomMode: !!conv.freedomMode,
        streaming: !!conv.streaming,
      })),
      apiKeyCount: config?.apiKeyCfg?.modelSettings?.length || 0,
      apiKeysValid: (config?.apiKeyCfg?.modelSettings || []).filter((s: any) => s.isValid).length,
    };
  });

  // 添加远程 Console 管理的 clients
  const globalCfg = getGlobalConfig();
  const remoteConsoles = globalCfg.console?.remoteConsoles || [];

  // 并发请求所有远程 Console
  const remoteClientsPromises = remoteConsoles.map(async (rc) => {
    try {
      const { status, data } = await proxyToRemoteConsole(rc, 'GET', '/api/clients');
      if (status === 200 && data.clients) {
        let remoteClients = data.clients;
        // 如果配置了 clientIds，只保留指定的客户端
        if (rc.clientIds && rc.clientIds.length > 0) {
          remoteClients = remoteClients.filter((c: any) => rc.clientIds!.includes(c.clientId));
        }
        // 建立 clientId -> remoteUrl 的映射关系
        for (const client of remoteClients) {
          remoteClientMap.set(client.clientId, rc.url);
        }
        // 将远程 clients 添加到列表中，标记为远程
        return remoteClients.map((client: any) => ({
          ...client,
          remote: true,
          remoteUrl: rc.url,
        }));
      }
    } catch (e) {
      console.error(`Failed to fetch clients from remote console ${rc.url}:`, e);
    }
    return [];
  });

  const remoteClientsArrays = await Promise.all(remoteClientsPromises);
  const remoteClients = remoteClientsArrays.flat();
  clients.push(...remoteClients);

  jsonResponse(res, 200, { clients });
}

/** GET /api/clients/:id/config */
async function handleGetClientConfig(req: http.IncomingMessage, res: http.ServerResponse, clientId: string): Promise<void> {
  if (!requireAuth(req, res)) return;

  const remoteConsole = getClientRemoteConsole(clientId);

  try {
    let config: IConfig;

    if (remoteConsole) {
      // 远程客户端：通过 API 代理获取
      const { status, data } = await proxyToRemoteConsole(remoteConsole, 'GET', `/api/clients/${clientId}/config`);
      if (status !== 200) {
        jsonError(res, status, data.error || '远程配置读取失败');
        return;
      }
      config = data.config;
    } else {
      // 本地客户端
      const configPath = path.join(getHomeDir(), '.cc-ding', clientId, 'config.json');
      if (!fs.existsSync(configPath)) {
        jsonError(res, 404, '客户端配置不存在');
        return;
      }
      config = fileUtil.getJSON(configPath) as IConfig;
    }

    // 脱敏处理
    const maskedConfig = JSON.parse(JSON.stringify(config));
    if (maskedConfig.clientSecret) maskedConfig.clientSecret = maskSecret(maskedConfig.clientSecret);
    if (maskedConfig.defaultDingToken) maskedConfig.defaultDingToken = maskSecret(maskedConfig.defaultDingToken);
    if (maskedConfig.dingSecret) maskedConfig.dingSecret = maskSecret(maskedConfig.dingSecret);
    if (maskedConfig.conversations) {
      maskedConfig.conversations = maskedConfig.conversations.map((conv: any) => {
        if (conv.dingToken) conv.dingToken = maskSecret(conv.dingToken);
        return conv;
      });
    }
    // 显示有效的 apiKeyCfg（client 维度优先，fallback 全局）
    const effectiveApiKeyCfg = getEffectiveApiKeyCfg(maskedConfig);
    if (effectiveApiKeyCfg?.modelSettings) {
      maskedConfig.apiKeyCfg = effectiveApiKeyCfg;
      maskedConfig.apiKeyCfg.modelSettings = maskedConfig.apiKeyCfg.modelSettings.map((s: any) => {
        if (s.apiKey) s.apiKey = maskSecret(s.apiKey);
        return s;
      });
    }
    jsonResponse(res, 200, { config: maskedConfig });
  } catch (err) {
    jsonError(res, 500, `读取配置失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** PATCH /api/clients/:id/config */
async function handlePatchClientConfig(req: http.IncomingMessage, res: http.ServerResponse, clientId: string): Promise<void> {
  if (!requireAuth(req, res)) return;

  let remoteConsole = getClientRemoteConsole(clientId);

  // 如果缓存中没有找到，尝试从所有远程 Console 中查找
  if (!remoteConsole) {
    const globalCfg = getGlobalConfig();
    const remoteConsoles = globalCfg.console?.remoteConsoles || [];

    for (const rc of remoteConsoles) {
      try {
        const { status } = await proxyToRemoteConsole(rc, 'GET', `/api/clients/${clientId}/config`);
        if (status === 200) {
          // 找到了，建立映射关系
          remoteClientMap.set(clientId, rc.url);
          remoteConsole = rc;
          break;
        }
      } catch (e) {
        // 忽略错误，继续尝试下一个远程 Console
      }
    }
  }

  try {
    const body = await readBody(req);
    const patches = JSON.parse(body || '{}');

    if (remoteConsole) {
      // 远程客户端：通过 API 代理更新
      const { status, data } = await proxyToRemoteConsole(
        remoteConsole,
        'PATCH',
        `/api/clients/${clientId}/config`,
        body,
      );
      if (status !== 200) {
        jsonError(res, status, data.error || '远程配置更新失败');
        return;
      }
      jsonResponse(res, 200, data);
      return;
    }

    // 本地客户端
    const configPath = path.join(getHomeDir(), '.cc-ding', clientId, 'config.json');
    if (!fs.existsSync(configPath)) {
      jsonError(res, 404, '客户端配置不存在');
      return;
    }

    const config = fileUtil.getJSON(configPath) as IConfig;

    // 应用 patches
    for (const [ pathStr, value ] of Object.entries(patches)) {
      dotPathSet(config, pathStr, value);
    }

    // 备份并原子写入
    backupFile(configPath);
    atomicWrite(configPath, JSON.stringify(config, null, 2));

    jsonResponse(res, 200, { message: '配置已更新', path: configPath });
  } catch (err) {
    jsonError(res, 500, `更新配置失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** GET /api/clients/:id/pm2 — 获取 pm2 进程状态 */
async function handleGetClientPm2(req: http.IncomingMessage, res: http.ServerResponse, clientId: string): Promise<void> {
  if (!requireAuth(req, res)) return;

  try {
    const { stdout } = await execFileAsync('pm2', [ 'jlist' ], { encoding: 'utf-8' });
    const processes = JSON.parse(stdout);
    const processName = `cc-ding-${clientId}`;
    const proc = processes.find((p: any) => p.name === processName);

    if (!proc) {
      jsonError(res, 404, `未找到 pm2 进程: ${processName}`);
      return;
    }

    jsonResponse(res, 200, {
      pid: proc.pid,
      status: proc.pm2_env?.status || 'unknown',
      uptime: proc.pm2_env?.pm_uptime ? Date.now() - proc.pm2_env.pm_uptime : 0,
      memory: proc.monit?.memory || 0,
      cpu: proc.monit?.cpu || 0,
      restarts: proc.pm2_env?.restart_time || 0,
    });
  } catch (err) {
    jsonError(res, 500, `获取 pm2 状态失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** POST /api/clients/:id/pm2/restart — 重启 pm2 进程 */
async function handleRestartClientPm2(req: http.IncomingMessage, res: http.ServerResponse, clientId: string): Promise<void> {
  if (!requireAuth(req, res)) return;

  const processName = `cc-ding-${clientId}`;

  try {
    await execFileAsync('pm2', [ 'restart', processName ], { timeout: 30000 });
    jsonResponse(res, 200, { message: `已重启 ${processName}` });
  } catch (err) {
    jsonError(res, 500, `重启失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** POST /api/clients/:id/start — 启动 client 进程（非 pm2） */
async function handleStartClient(req: http.IncomingMessage, res: http.ServerResponse, clientId: string): Promise<void> {
  if (!requireAuth(req, res)) return;

  // 检查是否已在线
  const { online, pid: existingPid } = checkClientOnline(clientId);
  if (online) {
    jsonError(res, 409, `客户端已在线 (PID: ${existingPid})`);
    return;
  }

  // 检查配置是否存在
  const configPath = path.join(getHomeDir(), '.cc-ding', clientId, 'config.json');
  if (!fs.existsSync(configPath)) {
    jsonError(res, 404, '客户端配置不存在');
    return;
  }

  // 查找 cc-ding 可执行文件路径
  let ccDingCmd = 'cc-ding';
  let ccDingArgs = [ 'run', '-ci', clientId ];

  // 优先使用全局安装的 cc-ding，否则使用当前包的 dist
  if (!commandExists('cc-ding')) {
    const scriptPath = path.join(__dirname, '..', '..', 'dist', 'bin', 'cc-ding.js');
    if (fs.existsSync(scriptPath)) {
      ccDingCmd = process.execPath; // node
      ccDingArgs = [ scriptPath, 'run', '-ci', clientId ];
    } else {
      jsonError(res, 500, '找不到 cc-ding 可执行文件');
      return;
    }
  }

  const clientDir = path.join(getHomeDir(), '.cc-ding', clientId);
  const logPath = path.join(clientDir, 'cc-ding.log');
  const logFd = fs.openSync(logPath, 'a');

  try {
    const child = spawnCommand(ccDingCmd, ccDingArgs, {
      detached: true,
      stdio: [ 'ignore', logFd, logFd ],
      cwd: clientDir,
      env: { ...process.env },
    });
    child.unref();
    // 给进程一点时间启动
    await new Promise(r => setTimeout(r, 500));
    const { online: nowOnline, pid: newPid } = checkClientOnline(clientId);
    jsonResponse(res, 200, {
      message: nowOnline ? '客户端已启动' : '启动命令已发送，进程可能仍在初始化',
      pid: newPid || child.pid,
      logPath,
    });
  } catch (err) {
    try { fs.closeSync(logFd); } catch { /* ignore */ }
    jsonError(res, 500, `启动失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** POST /api/clients/:id/stop — 停止 client 进程 */
async function handleStopClient(req: http.IncomingMessage, res: http.ServerResponse, clientId: string): Promise<void> {
  if (!requireAuth(req, res)) return;

  const { online, pid } = checkClientOnline(clientId);
  if (!online || !pid) {
    jsonError(res, 409, '客户端未在线');
    return;
  }

  try {
    process.kill(pid, 'SIGTERM');
    jsonResponse(res, 200, { message: `已发送停止信号 (PID: ${pid})` });
  } catch (err) {
    jsonError(res, 500, `停止失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** POST /api/clients/:id/conversations — 添加会话 */
async function handleAddConversation(req: http.IncomingMessage, res: http.ServerResponse, clientId: string): Promise<void> {
  if (!requireAuth(req, res)) return;

  const configPath = path.join(getHomeDir(), '.cc-ding', clientId, 'config.json');
  if (!fs.existsSync(configPath)) {
    jsonError(res, 404, '客户端配置不存在');
    return;
  }

  try {
    const body = await readBody(req);
    const data = JSON.parse(body || '{}');

    if (!data.conversationId || !data.conversationType) {
      jsonError(res, 400, '缺少必填字段: conversationId, conversationType');
      return;
    }

    const config = fileUtil.getJSON(configPath) as IConfig;
    if (config.conversations?.some(c => c.conversationId === data.conversationId)) {
      jsonError(res, 409, 'conversationId 已存在');
      return;
    }

    const newConv: any = {
      conversationId: data.conversationId,
      conversationType: data.conversationType,
    };
    if (data.conversationTitle) newConv.conversationTitle = data.conversationTitle;
    if (data.dingToken) newConv.dingToken = data.dingToken;
    if (data.mobile) newConv.mobile = data.mobile;
    const wul = parseStringList(data.whiteUserList);
    if (wul.length) newConv.whiteUserList = wul;
    if (data.agent) newConv.agent = data.agent;
    if (data.model) newConv.model = data.model;
    if (data.useLocalOcr !== undefined) newConv.useLocalOcr = !!data.useLocalOcr;
    if (data.atSender !== undefined) newConv.atSender = !!data.atSender;
    if (data.receiveReply !== undefined) newConv.receiveReply = !!data.receiveReply;
    if (data.receiveReplyMode) newConv.receiveReplyMode = data.receiveReplyMode;
    if (data.ackReaction) newConv.ackReaction = data.ackReaction;
    if (data.qaMode) newConv.qaMode = true;
    if (data.freedomMode) newConv.freedomMode = true;
    if (data.streaming) newConv.streaming = true;
    if (data.permissionMode) newConv.permissionMode = data.permissionMode;
    if (data.preBash) newConv.preBash = data.preBash;
    if (data.linkConversationId) newConv.linkConversationId = data.linkConversationId;
    if (data.workDir) newConv.workDir = data.workDir;
    if (data.ensureAt) newConv.ensureAt = true;
    if (data.maxTurnTimeMins) newConv.maxTurnTimeMins = data.maxTurnTimeMins;
    if (data.taskCfg?.skill) newConv.taskCfg = { skill: data.taskCfg.skill };
    if (data.qaCfg) newConv.qaCfg = data.qaCfg;
    if (data.envs) newConv.envs = data.envs;

    if (!config.conversations) config.conversations = [];
    config.conversations.push(newConv);

    backupFile(configPath);
    atomicWrite(configPath, JSON.stringify(config, null, 2));
    jsonResponse(res, 201, { message: '会话已创建' });
  } catch (err) {
    jsonError(res, 400, '请求格式错误');
  }
}

/** PUT /api/clients/:id/conversations/:convId — 更新会话 */
async function handleUpdateConversation(req: http.IncomingMessage, res: http.ServerResponse, clientId: string, convId: string): Promise<void> {
  if (!requireAuth(req, res)) return;

  const configPath = path.join(getHomeDir(), '.cc-ding', clientId, 'config.json');
  if (!fs.existsSync(configPath)) {
    jsonError(res, 404, '客户端配置不存在');
    return;
  }

  try {
    const body = await readBody(req);
    const data = JSON.parse(body || '{}');
    const config = fileUtil.getJSON(configPath) as IConfig;

    const idx = config.conversations?.findIndex(c => c.conversationId === convId) ?? -1;
    if (idx < 0) {
      jsonError(res, 404, '会话不存在');
      return;
    }

    const conv = config.conversations![idx];
    const updatable: (keyof typeof data)[] = [
      'conversationType', 'conversationTitle', 'dingToken', 'mobile',
      'whiteUserList', 'agent', 'model', 'useLocalOcr', 'atSender',
      'receiveReply', 'receiveReplyMode', 'ackReaction', 'qaMode',
      'freedomMode', 'streaming', 'permissionMode', 'preBash',
      'linkConversationId', 'workDir', 'ensureAt', 'maxTurnTimeMins', 'taskCfg', 'qaCfg', 'envs',
    ];
    for (const field of updatable) {
      if (data[field] !== undefined) {
        if (field === 'whiteUserList') {
          (conv as any)[field] = parseStringList(data[field]);
        } else {
          (conv as any)[field] = data[field];
        }
      }
    }

    backupFile(configPath);
    atomicWrite(configPath, JSON.stringify(config, null, 2));
    jsonResponse(res, 200, { message: '会话已更新' });
  } catch (err) {
    jsonError(res, 400, '请求格式错误');
  }
}

/** DELETE /api/clients/:id/conversations/:convId — 删除会话 */
async function handleDeleteConversation(req: http.IncomingMessage, res: http.ServerResponse, clientId: string, convId: string): Promise<void> {
  if (!requireAuth(req, res)) return;

  const configPath = path.join(getHomeDir(), '.cc-ding', clientId, 'config.json');
  if (!fs.existsSync(configPath)) {
    jsonError(res, 404, '客户端配置不存在');
    return;
  }

  try {
    const config = fileUtil.getJSON(configPath) as IConfig;
    const idx = config.conversations?.findIndex(c => c.conversationId === convId) ?? -1;
    if (idx < 0) {
      jsonError(res, 404, '会话不存在');
      return;
    }

    config.conversations!.splice(idx, 1);
    backupFile(configPath);
    atomicWrite(configPath, JSON.stringify(config, null, 2));
    jsonResponse(res, 200, { message: '会话已删除' });
  } catch (err) {
    jsonError(res, 500, '删除失败');
  }
}

/** GET /api/clients/:id/config/raw */
async function handleGetRawConfig(req: http.IncomingMessage, res: http.ServerResponse, clientId: string): Promise<void> {
  if (!requireAuth(req, res)) return;

  const remoteConsole = getClientRemoteConsole(clientId);

  try {
    if (remoteConsole) {
      // 远程客户端：通过 API 代理获取
      const { status, data } = await proxyToRemoteConsole(remoteConsole, 'GET', `/api/clients/${clientId}/config/raw`);
      if (status !== 200) {
        jsonError(res, status, data.error || '远程原始配置读取失败');
        return;
      }
      jsonResponse(res, 200, data);
    } else {
      // 本地客户端
      const configPath = path.join(getHomeDir(), '.cc-ding', clientId, 'config.json');
      if (!fs.existsSync(configPath)) {
        jsonError(res, 404, '客户端配置不存在');
        return;
      }
      const raw = fs.readFileSync(configPath, 'utf-8');
      jsonResponse(res, 200, { content: raw });
    }
  } catch (err) {
    jsonError(res, 500, '读取失败');
  }
}

/** PUT /api/clients/:id/config/raw */
async function handlePutRawConfig(req: http.IncomingMessage, res: http.ServerResponse, clientId: string): Promise<void> {
  if (!requireAuth(req, res)) return;

  const remoteConsole = getClientRemoteConsole(clientId);

  try {
    const body = await readBody(req);
    const data = JSON.parse(body || '{}');
    // 验证 JSON
    JSON.parse(data.content || '');

    if (remoteConsole) {
      // 远程客户端：通过 API 代理保存
      const { status, data: responseData } = await proxyToRemoteConsole(
        remoteConsole,
        'PUT',
        `/api/clients/${clientId}/config/raw`,
        body,
      );
      if (status !== 200) {
        jsonError(res, status, responseData.error || '远程原始配置保存失败');
        return;
      }
      jsonResponse(res, 200, responseData);
    } else {
      // 本地客户端
      const configPath = path.join(getHomeDir(), '.cc-ding', clientId, 'config.json');
      if (!fs.existsSync(configPath)) {
        jsonError(res, 404, '客户端配置不存在');
        return;
      }
      // 备份
      backupFile(configPath);
      // 原子写入
      atomicWrite(configPath, data.content);
      jsonResponse(res, 200, { message: '原始配置已保存' });
    }
  } catch (err) {
    jsonError(res, 400, 'JSON 格式错误');
  }
}

/** POST /api/clients/:id/config/reload */
async function handleReloadConfig(req: http.IncomingMessage, res: http.ServerResponse, clientId: string): Promise<void> {
  if (!requireAuth(req, res)) return;

  const result = sendReloadSignal(clientId);
  if (result.success) {
    jsonResponse(res, 200, { message: '已发送重载信号 (SIGUSR2)' });
  } else {
    jsonError(res, 500, result.error || '重载失败');
  }
}

/** GET /api/clients/:id/apikeys */
async function handleGetApiKeys(req: http.IncomingMessage, res: http.ServerResponse, clientId: string): Promise<void> {
  if (!requireAuth(req, res)) return;

  const configPath = path.join(getHomeDir(), '.cc-ding', clientId, 'config.json');
  if (!fs.existsSync(configPath)) {
    jsonError(res, 404, '客户端配置不存在');
    return;
  }

  try {
    const config = fileUtil.getJSON(configPath) as IConfig;
    const effectiveApiKeyCfg = getEffectiveApiKeyCfg(config);
    const keys = (effectiveApiKeyCfg?.modelSettings || []).map((setting: any, index: number) => ({
      index,
      isValid: setting.isValid,
      apiKey: maskSecret(setting.apiKey),
      baseUrl: setting.baseUrl,
      model: setting.model,
      smallModel: setting.smallModel || '',
      memo: setting.memo || '',
      cfuseTokenValid: true, // 社区版不支持 cfuse，固定为 true
    }));
    jsonResponse(res, 200, { apiKeys: keys });
  } catch (err) {
    jsonError(res, 500, '读取失败');
  }
}

/** POST /api/clients/:id/apikeys */
async function handleAddApiKey(req: http.IncomingMessage, res: http.ServerResponse, clientId: string): Promise<void> {
  if (!requireAuth(req, res)) return;

  const configPath = path.join(getHomeDir(), '.cc-ding', clientId, 'config.json');
  if (!fs.existsSync(configPath)) {
    jsonError(res, 404, '客户端配置不存在');
    return;
  }

  try {
    const body = await readBody(req);
    const data = JSON.parse(body || '{}');
    const config = fileUtil.getJSON(configPath) as IConfig;
    if (!config.apiKeyCfg) config.apiKeyCfg = { modelSettings: [] };
    if (!config.apiKeyCfg.modelSettings) config.apiKeyCfg.modelSettings = [];

    const newKey: IClaudeSetting = {
      isValid: data.isValid !== false,
      apiKey: data.apiKey || '',
      baseUrl: data.baseUrl || 'https://api.anthropic.com',
      model: data.model || 'claude-3-opus-latest',
      smallModel: data.smallModel || '',
      memo: data.memo || '',
    };
    config.apiKeyCfg.modelSettings.push(newKey);
    backupFile(configPath);
    atomicWrite(configPath, JSON.stringify(config, null, 2));
    jsonResponse(res, 201, { message: 'API Key 已添加' });
  } catch (err) {
    jsonError(res, 400, '请求格式错误');
  }
}

/** PUT /api/clients/:id/apikeys/:index */
async function handleUpdateApiKey(req: http.IncomingMessage, res: http.ServerResponse, clientId: string, index: number): Promise<void> {
  if (!requireAuth(req, res)) return;

  const configPath = path.join(getHomeDir(), '.cc-ding', clientId, 'config.json');
  if (!fs.existsSync(configPath)) {
    jsonError(res, 404, '客户端配置不存在');
    return;
  }

  try {
    const body = await readBody(req);
    const data = JSON.parse(body || '{}');
    const config = fileUtil.getJSON(configPath) as IConfig;
    const settings = config.apiKeyCfg?.modelSettings || [];
    if (index < 0 || index >= settings.length) {
      jsonError(res, 404, 'API Key 索引不存在');
      return;
    }

    if (data.apiKey !== undefined) settings[index].apiKey = data.apiKey;
    if (data.baseUrl !== undefined) settings[index].baseUrl = data.baseUrl;
    if (data.model !== undefined) settings[index].model = data.model;
    if (data.smallModel !== undefined) settings[index].smallModel = data.smallModel;
    if (data.memo !== undefined) settings[index].memo = data.memo;
    if (data.isValid !== undefined) settings[index].isValid = data.isValid;

    backupFile(configPath);
    atomicWrite(configPath, JSON.stringify(config, null, 2));
    jsonResponse(res, 200, { message: 'API Key 已更新' });
  } catch (err) {
    jsonError(res, 400, '请求格式错误');
  }
}

/** DELETE /api/clients/:id/apikeys/:index */
async function handleDeleteApiKey(req: http.IncomingMessage, res: http.ServerResponse, clientId: string, index: number): Promise<void> {
  if (!requireAuth(req, res)) return;

  const configPath = path.join(getHomeDir(), '.cc-ding', clientId, 'config.json');
  if (!fs.existsSync(configPath)) {
    jsonError(res, 404, '客户端配置不存在');
    return;
  }

  try {
    const config = fileUtil.getJSON(configPath) as IConfig;
    const settings = config.apiKeyCfg?.modelSettings || [];
    if (index < 0 || index >= settings.length) {
      jsonError(res, 404, 'API Key 索引不存在');
      return;
    }
    settings.splice(index, 1);
    backupFile(configPath);
    atomicWrite(configPath, JSON.stringify(config, null, 2));
    jsonResponse(res, 200, { message: 'API Key 已删除' });
  } catch (err) {
    jsonError(res, 500, '删除失败');
  }
}

// ==================== 全局 API Key 管理 ====================

/** 读取全局 config.json 中的 apiKeyCfg */
function readGlobalApiKeyCfg(): any {
  try {
    if (!fs.existsSync(GLOBAL_CONFIG_PATH)) return undefined;
    const raw = JSON.parse(fs.readFileSync(GLOBAL_CONFIG_PATH, 'utf-8'));
    return raw.apiKeyCfg;
  } catch {
    return undefined;
  }
}

/** 保存 apiKeyCfg 到全局 config.json（仅更新 apiKeyCfg 字段，不影响其他配置） */
function writeGlobalApiKeyCfg(apiKeyCfg: any): void {
  const globalCfg = fs.existsSync(GLOBAL_CONFIG_PATH)
    ? fileUtil.getJSON(GLOBAL_CONFIG_PATH) as any
    : {};
  globalCfg.apiKeyCfg = apiKeyCfg;
  atomicWrite(GLOBAL_CONFIG_PATH, JSON.stringify(globalCfg, null, 2));
}

/** GET /api/global/apikeys — 获取全局 API Key 列表（mask 密钥） */
async function handleGetGlobalApiKeys(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!requireAuth(req, res)) return;
  const apiKeyCfg = readGlobalApiKeyCfg();
  if (!apiKeyCfg) {
    jsonResponse(res, 200, { apiKeys: [] });
    return;
  }
  const keys = (apiKeyCfg.modelSettings || []).map((setting: any, index: number) => ({
    index,
    isValid: setting.isValid,
    apiKey: maskSecret(setting.apiKey),
    baseUrl: setting.baseUrl,
    model: setting.model,
    smallModel: setting.smallModel || '',
    memo: setting.memo || '',
    retryLogs: apiKeyCfg.retryLogs || {},
  }));
  jsonResponse(res, 200, { apiKeys: keys });
}

/** POST /api/global/apikeys — 添加全局 API Key */
async function handleAddGlobalApiKey(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!requireAuth(req, res)) return;
  try {
    const body = await readBody(req);
    const data = JSON.parse(body || '{}');
    const apiKeyCfg = readGlobalApiKeyCfg() || { modelSettings: [] };
    if (!apiKeyCfg.modelSettings) apiKeyCfg.modelSettings = [];

    const newKey: IClaudeSetting = {
      isValid: data.isValid !== false,
      apiKey: data.apiKey || '',
      baseUrl: data.baseUrl || 'https://api.anthropic.com',
      model: data.model || 'claude-sonnet-4-20250514',
      smallModel: data.smallModel || '',
      memo: data.memo || '',
    };
    apiKeyCfg.modelSettings.push(newKey);
    writeGlobalApiKeyCfg(apiKeyCfg);
    jsonResponse(res, 201, { message: '全局 API Key 已添加' });
  } catch (err) {
    jsonError(res, 400, '请求格式错误');
  }
}

/** PUT /api/global/apikeys/:index — 更新全局 API Key */
async function handleUpdateGlobalApiKey(req: http.IncomingMessage, res: http.ServerResponse, index: number): Promise<void> {
  if (!requireAuth(req, res)) return;
  try {
    const body = await readBody(req);
    const data = JSON.parse(body || '{}');
    const apiKeyCfg = readGlobalApiKeyCfg();
    if (!apiKeyCfg?.modelSettings) {
      jsonError(res, 404, '全局 API Key 配置不存在');
      return;
    }
    if (index < 0 || index >= apiKeyCfg.modelSettings.length) {
      jsonError(res, 404, 'API Key 索引不存在');
      return;
    }
    const s = apiKeyCfg.modelSettings[index];
    if (data.apiKey !== undefined) s.apiKey = data.apiKey;
    if (data.baseUrl !== undefined) s.baseUrl = data.baseUrl;
    if (data.model !== undefined) s.model = data.model;
    if (data.smallModel !== undefined) s.smallModel = data.smallModel;
    if (data.memo !== undefined) s.memo = data.memo;
    if (data.isValid !== undefined) s.isValid = data.isValid;
    writeGlobalApiKeyCfg(apiKeyCfg);
    jsonResponse(res, 200, { message: '全局 API Key 已更新' });
  } catch (err) {
    jsonError(res, 400, '请求格式错误');
  }
}

/** DELETE /api/global/apikeys/:index — 删除全局 API Key */
async function handleDeleteGlobalApiKey(req: http.IncomingMessage, res: http.ServerResponse, index: number): Promise<void> {
  if (!requireAuth(req, res)) return;
  try {
    const apiKeyCfg = readGlobalApiKeyCfg();
    if (!apiKeyCfg?.modelSettings) {
      jsonError(res, 404, '全局 API Key 配置不存在');
      return;
    }
    if (index < 0 || index >= apiKeyCfg.modelSettings.length) {
      jsonError(res, 404, 'API Key 索引不存在');
      return;
    }
    apiKeyCfg.modelSettings.splice(index, 1);
    writeGlobalApiKeyCfg(apiKeyCfg);
    jsonResponse(res, 200, { message: '全局 API Key 已删除' });
  } catch (err) {
    jsonError(res, 400, '请求格式错误');
  }
}

/** GET /api/global/retrylogs — 获取全局 retryLogs 配置 */
async function handleGetGlobalRetryLogs(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!requireAuth(req, res)) return;
  const apiKeyCfg = readGlobalApiKeyCfg();
  jsonResponse(res, 200, { retryLogs: apiKeyCfg?.retryLogs || {} });
}

/** PUT /api/global/retrylogs — 更新全局 retryLogs 配置 */
async function handlePutGlobalRetryLogs(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!requireAuth(req, res)) return;
  try {
    const body = await readBody(req);
    const data = JSON.parse(body || '{}');
    if (typeof data.retryLogs !== 'object' || data.retryLogs === null) {
      jsonError(res, 400, 'retryLogs 格式错误，应为 { baseUrl: string[] } 对象');
      return;
    }
    const apiKeyCfg = readGlobalApiKeyCfg() || { modelSettings: [] };
    apiKeyCfg.retryLogs = data.retryLogs;
    writeGlobalApiKeyCfg(apiKeyCfg);
    jsonResponse(res, 200, { message: '全局 retryLogs 已保存' });
  } catch (err) {
    jsonError(res, 400, '请求格式错误');
  }
}

/** GET /api/clients/:id/files */
async function handleGetClientFile(req: http.IncomingMessage, res: http.ServerResponse, clientId: string, name: string): Promise<void> {
  if (!requireAuth(req, res)) return;

  const filePath = getClientFilePath(clientId, name);
  if (!filePath || !fs.existsSync(filePath)) {
    jsonError(res, 404, `文件 ${name} 不存在`);
    return;
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    jsonResponse(res, 200, { content });
  } catch (err) {
    jsonError(res, 500, '读取失败');
  }
}

/** PUT /api/clients/:id/files */
async function handlePutClientFile(req: http.IncomingMessage, res: http.ServerResponse, clientId: string, name: string): Promise<void> {
  if (!requireAuth(req, res)) return;

  const filePath = getClientFilePath(clientId, name);
  if (!filePath) {
    jsonError(res, 400, `不支持的文件名: ${name}`);
    return;
  }

  try {
    const body = await readBody(req);
    const data = JSON.parse(body || '{}');
    // 验证 JSON
    JSON.parse(data.content || '');
    if (fs.existsSync(filePath)) backupFile(filePath);
    atomicWrite(filePath, data.content);
    jsonResponse(res, 200, { message: `文件 ${name} 已保存` });
  } catch (err) {
    jsonError(res, 400, 'JSON 格式错误');
  }
}

/** GET /api/global/config */
async function handleGetGlobalConfig(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!requireAuth(req, res)) return;

  try {
    const raw = fs.existsSync(GLOBAL_CONFIG_PATH)
      ? JSON.parse(fs.readFileSync(GLOBAL_CONFIG_PATH, 'utf-8'))
      : {};
    // 返回完整配置：console + updatePkgUrl + apiKeyCfg
    const config: any = {
      console: raw.console,
      updatePkgUrl: raw.updatePkgUrl,
    };
    if (raw.apiKeyCfg) config.apiKeyCfg = raw.apiKeyCfg;
    jsonResponse(res, 200, { config });
  } catch (err) {
    jsonError(res, 500, '读取全局配置失败');
  }
}

/** PUT /api/global/config */
async function handlePutGlobalConfig(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!requireAuth(req, res)) return;

  try {
    const body = await readBody(req);
    const data = JSON.parse(body || '{}');
    saveGlobalConfig({
      port: data.port,
      host: data.host,
      authUsers: data.authUsers,
      remoteConsoles: data.remoteConsoles,
    });
    // 同时保存 apiKeyCfg（如果前端传了）
    if (data.apiKeyCfg !== undefined) {
      const globalCfg = fs.existsSync(GLOBAL_CONFIG_PATH)
        ? fileUtil.getJSON(GLOBAL_CONFIG_PATH) as any
        : {};
      globalCfg.apiKeyCfg = data.apiKeyCfg;
      atomicWrite(GLOBAL_CONFIG_PATH, JSON.stringify(globalCfg, null, 2));
    }
    jsonResponse(res, 200, { message: '全局配置已保存' });
  } catch (err) {
    jsonError(res, 400, '请求格式错误');
  }
}

/** GET /api/global/settings-tpl */
async function handleGetSettingsTpl(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!requireAuth(req, res)) return;

  if (!fs.existsSync(SETTINGS_TPL_PATH)) {
    jsonResponse(res, 200, { content: '{}' });
    return;
  }

  try {
    const content = fs.readFileSync(SETTINGS_TPL_PATH, 'utf-8');
    jsonResponse(res, 200, { content });
  } catch (err) {
    jsonError(res, 500, '读取失败');
  }
}

/** PUT /api/global/settings-tpl */
async function handlePutSettingsTpl(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!requireAuth(req, res)) return;

  try {
    const body = await readBody(req);
    const data = JSON.parse(body || '{}');
    JSON.parse(data.content || '');
    if (fs.existsSync(SETTINGS_TPL_PATH)) backupFile(SETTINGS_TPL_PATH);
    atomicWrite(SETTINGS_TPL_PATH, data.content);
    jsonResponse(res, 200, { message: 'settings-tpl.json 已保存' });
  } catch (err) {
    jsonError(res, 400, 'JSON 格式错误');
  }
}

/** PUT /api/global/update-pkg-url */
async function handlePutUpdatePkgUrl(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!requireAuth(req, res)) return;

  try {
    const body = await readBody(req);
    const data = JSON.parse(body || '{}');
    const globalCfg = fs.existsSync(GLOBAL_CONFIG_PATH)
      ? fileUtil.getJSON(GLOBAL_CONFIG_PATH) as any
      : {};

    if (data.updatePkgUrl) {
      globalCfg.updatePkgUrl = data.updatePkgUrl;
    } else {
      delete globalCfg.updatePkgUrl;
    }

    atomicWrite(GLOBAL_CONFIG_PATH, JSON.stringify(globalCfg, null, 2));
    jsonResponse(res, 200, { message: '更新包 URL 已保存' });
  } catch (err) {
    jsonError(res, 400, '请求格式错误');
  }
}

/** GET /api/global/raw-config — 获取全局 config.json 原始内容 */
async function handleGetGlobalRawConfig(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!requireAuth(req, res)) return;

  try {
    if (!fs.existsSync(GLOBAL_CONFIG_PATH)) {
      jsonResponse(res, 200, { content: '{}' });
      return;
    }
    const raw = fs.readFileSync(GLOBAL_CONFIG_PATH, 'utf-8');
    // Parse and re-stringify for consistent formatting
    const parsed = JSON.parse(raw);
    jsonResponse(res, 200, { content: JSON.stringify(parsed, null, 2) });
  } catch (err) {
    jsonError(res, 500, '读取全局配置失败');
  }
}

/** PUT /api/global/raw-config — 保存全局 config.json 原始内容 */
async function handlePutGlobalRawConfig(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!requireAuth(req, res)) return;

  try {
    const body = await readBody(req);
    const data = JSON.parse(body || '{}');
    const content = data.content;

    if (typeof content !== 'string') {
      jsonError(res, 400, 'content 必须是字符串');
      return;
    }

    // Validate JSON
    let parsed: any;
    try {
      parsed = JSON.parse(content);
    } catch {
      jsonError(res, 400, 'JSON 格式错误');
      return;
    }

    // Backup existing config
    if (fs.existsSync(GLOBAL_CONFIG_PATH)) {
      backupFile(GLOBAL_CONFIG_PATH);
    }

    atomicWrite(GLOBAL_CONFIG_PATH, JSON.stringify(parsed, null, 2));
    jsonResponse(res, 200, { message: '全局配置已保存' });
  } catch (err) {
    jsonError(res, 400, '请求格式错误');
  }
}

/** GET /api/ping - 公开端点，用于局域网扫描发现（无需认证） */
async function handlePing(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  jsonResponse(res, 200, {
    name: 'cc-ding-console',
    version: projUtil().getPkgVersion(),
    hostname: require('os').hostname(),
  });
}

/** GET /api/status */
async function handleGetStatus(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!requireAuth(req, res)) return;

  const clientDirs = scanClientDirs();
  let onlineCount = 0;
  for (const { clientId } of clientDirs) {
    if (checkClientOnline(clientId).online) onlineCount++;
  }

  const status: ISystemStatus = {
    ccDingVersion: projUtil().getPkgVersion(),
    nodeVersion: process.version,
    platform: process.platform,
    hostname: require('os').hostname(),
    uptime: process.uptime(),
    clients: clientDirs.length,
    onlineClients: onlineCount,
  };
  jsonResponse(res, 200, { status });
}

/** GET /api/remote/status?url=... - 获取远程 Console 的系统状态 */
async function handleGetRemoteStatus(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!requireAuth(req, res)) return;

  const urlMatch = req.url?.match(/[?&]url=([^&]+)/);
  if (!urlMatch) {
    jsonError(res, 400, '缺少 url 参数');
    return;
  }

  const remoteUrl = decodeURIComponent(urlMatch[1]);
  const globalCfg = getGlobalConfig();
  const remoteConsoles = globalCfg.console?.remoteConsoles || [];
  const remoteConsole = remoteConsoles.find(rc => rc.url === remoteUrl);

  if (!remoteConsole) {
    jsonError(res, 404, '远程 Console 未配置');
    return;
  }

  try {
    const { status, data } = await proxyToRemoteConsole(remoteConsole, 'GET', '/api/status');
    if (status !== 200) {
      jsonError(res, status, data.error || '获取远程状态失败');
      return;
    }
    jsonResponse(res, 200, data);
  } catch (err) {
    jsonError(res, 500, `获取远程状态失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** POST /api/remote/scan - 扫描局域网内的 cc-ding Console */
async function handleScanRemoteConsoles(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!requireAuth(req, res)) return;

  try {
    const body = await readBody(req);
    const data = JSON.parse(body || '{}');
    const subnet = data.subnet; // e.g., "192.168.3"

    if (!subnet || !/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(subnet)) {
      jsonError(res, 400, '无效的子网地址，格式如: 192.168.3');
      return;
    }

    // Get already configured remote console URLs
    const globalCfg = getGlobalConfig();
    const configuredUrls = new Set((globalCfg.console?.remoteConsoles || []).map(rc => rc.url));

    // Get local IP addresses to exclude
    const localIps = new Set<string>();
    const interfaces = os.networkInterfaces();
    for (const info of Object.values(interfaces)) {
      if (!info) continue;
      for (const addr of info) {
        if (addr.family === 'IPv4') {
          localIps.add(addr.address);
        }
      }
    }

    // Scan the subnet
    const port = data.port || 8080;
    const timeout = data.timeout || 2000; // 2 seconds per host
    const discovered: Array<{ url: string; hostname: string; ccDingVersion: string }> = [];

    // Generate IP range (1-254)
    const scanPromises: Promise<void>[] = [];
    for (let i = 1; i <= 254; i++) {
      const ip = `${subnet}.${i}`;

      // Skip local IPs
      if (localIps.has(ip)) continue;

      scanPromises.push(
        (async () => {
          try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeout);

            const response = await fetch(`http://${ip}:${port}/api/ping`, {
              signal: controller.signal,
              headers: { 'Content-Type': 'application/json' },
            });

            clearTimeout(timeoutId);

            if (response.ok) {
              const pingData = await response.json();

              // Check if it's a cc-ding console
              if (pingData.name === 'cc-ding-console') {
                const url = `http://${ip}:${port}`;
                // Skip if already configured
                if (!configuredUrls.has(url)) {
                  discovered.push({
                    url,
                    hostname: pingData.hostname || ip,
                    ccDingVersion: pingData.version || '',
                  });
                }
              }
            }
          } catch {
            // Host not reachable or timeout, skip
          }
        })(),
      );
    }

    await Promise.all(scanPromises);

    jsonResponse(res, 200, { discovered, count: discovered.length });
  } catch (err) {
    jsonError(res, 500, `扫描失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 从请求 URL 中提取 url 参数对应的远程 Console 配置 */
function getRemoteConsoleFromQuery(req: http.IncomingMessage): IRemoteConsole | null {
  const urlMatch = req.url?.match(/[?&]url=([^&]+)/);
  if (!urlMatch) return null;
  const remoteUrl = decodeURIComponent(urlMatch[1]);
  const globalCfg = getGlobalConfig();
  const remoteConsoles = globalCfg.console?.remoteConsoles || [];
  return remoteConsoles.find(rc => rc.url === remoteUrl) || null;
}

/** 通用远程全局配置代理辅助 */
async function proxyRemoteGlobal(
  remoteConsole: IRemoteConsole,
  method: string,
  remoteApiPath: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  actionLabel: string,
): Promise<void> {
  let bodyStr: string | undefined;
  if (method !== 'GET' && req.method !== 'GET') {
    bodyStr = await readBody(req);
  }
  try {
    const { status, data } = await proxyToRemoteConsole(remoteConsole, method, remoteApiPath, bodyStr);
    if (status !== 200 && status !== 201) {
      jsonError(res, status, data.error || `${actionLabel}失败`);
      return;
    }
    jsonResponse(res, 200, data);
  } catch (err) {
    jsonError(res, 500, `${actionLabel}失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** GET /api/remote/global/config?url=... - 获取远程 Console 的全局配置 */
async function handleGetRemoteGlobalConfig(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!requireAuth(req, res)) return;
  const rc = getRemoteConsoleFromQuery(req);
  if (!rc) { jsonError(res, 404, '远程 Console 未配置'); return; }
  await proxyRemoteGlobal(rc, 'GET', '/api/global/config', req, res, '获取远程全局配置');
}

/** PUT /api/remote/global/config?url=... - 更新远程 Console 的全局配置 */
async function handlePutRemoteGlobalConfig(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!requireAuth(req, res)) return;
  const rc = getRemoteConsoleFromQuery(req);
  if (!rc) { jsonError(res, 404, '远程 Console 未配置'); return; }
  await proxyRemoteGlobal(rc, 'PUT', '/api/global/config', req, res, '更新远程全局配置');
}

/** GET /api/remote/global/settings-tpl?url=... - 获取远程 Console 的 settings-tpl */
async function handleGetRemoteSettingsTpl(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!requireAuth(req, res)) return;
  const rc = getRemoteConsoleFromQuery(req);
  if (!rc) { jsonError(res, 404, '远程 Console 未配置'); return; }
  await proxyRemoteGlobal(rc, 'GET', '/api/global/settings-tpl', req, res, '获取远程 settings-tpl');
}

/** PUT /api/remote/global/settings-tpl?url=... - 更新远程 Console 的 settings-tpl */
async function handlePutRemoteSettingsTpl(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!requireAuth(req, res)) return;
  const rc = getRemoteConsoleFromQuery(req);
  if (!rc) { jsonError(res, 404, '远程 Console 未配置'); return; }
  await proxyRemoteGlobal(rc, 'PUT', '/api/global/settings-tpl', req, res, '更新远程 settings-tpl');
}

/** PUT /api/remote/global/update-pkg-url?url=... - 更新远程 Console 的 updatePkgUrl */
async function handlePutRemoteUpdatePkgUrl(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!requireAuth(req, res)) return;
  const rc = getRemoteConsoleFromQuery(req);
  if (!rc) { jsonError(res, 404, '远程 Console 未配置'); return; }
  await proxyRemoteGlobal(rc, 'PUT', '/api/global/update-pkg-url', req, res, '更新远程更新包 URL');
}

/** GET /api/remote/global/apikeys?url=... */
async function handleGetRemoteGlobalApiKeys(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!requireAuth(req, res)) return;
  const rc = getRemoteConsoleFromQuery(req);
  if (!rc) { jsonError(res, 404, '远程 Console 未配置'); return; }
  await proxyRemoteGlobal(rc, 'GET', '/api/global/apikeys', req, res, '获取远程全局 API Keys');
}

/** POST /api/remote/global/apikeys?url=... */
async function handleAddRemoteGlobalApiKey(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!requireAuth(req, res)) return;
  const rc = getRemoteConsoleFromQuery(req);
  if (!rc) { jsonError(res, 404, '远程 Console 未配置'); return; }
  await proxyRemoteGlobal(rc, 'POST', '/api/global/apikeys', req, res, '添加远程全局 API Key');
}

/** PUT /api/remote/global/apikeys/:index?url=... */
async function handleUpdateRemoteGlobalApiKey(req: http.IncomingMessage, res: http.ServerResponse, index: number): Promise<void> {
  if (!requireAuth(req, res)) return;
  const rc = getRemoteConsoleFromQuery(req);
  if (!rc) { jsonError(res, 404, '远程 Console 未配置'); return; }
  await proxyRemoteGlobal(rc, 'PUT', `/api/global/apikeys/${index}`, req, res, '更新远程全局 API Key');
}

/** DELETE /api/remote/global/apikeys/:index?url=... */
async function handleDeleteRemoteGlobalApiKey(req: http.IncomingMessage, res: http.ServerResponse, index: number): Promise<void> {
  if (!requireAuth(req, res)) return;
  const rc = getRemoteConsoleFromQuery(req);
  if (!rc) { jsonError(res, 404, '远程 Console 未配置'); return; }
  await proxyRemoteGlobal(rc, 'DELETE', `/api/global/apikeys/${index}`, req, res, '删除远程全局 API Key');
}

/** GET /api/remote/global/retrylogs?url=... */
async function handleGetRemoteGlobalRetryLogs(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!requireAuth(req, res)) return;
  const rc = getRemoteConsoleFromQuery(req);
  if (!rc) { jsonError(res, 404, '远程 Console 未配置'); return; }
  await proxyRemoteGlobal(rc, 'GET', '/api/global/retrylogs', req, res, '获取远程全局 retryLogs');
}

/** PUT /api/remote/global/retrylogs?url=... */
async function handlePutRemoteGlobalRetryLogs(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!requireAuth(req, res)) return;
  const rc = getRemoteConsoleFromQuery(req);
  if (!rc) { jsonError(res, 404, '远程 Console 未配置'); return; }
  await proxyRemoteGlobal(rc, 'PUT', '/api/global/retrylogs', req, res, '更新远程全局 retryLogs');
}

// 需要从 common.ts 导入
function projUtil() {
  const { projUtil: pu } = require('../common');
  return pu();
}

// ==================== 批量操作 API ====================

/** 构建 cc-ding 安装命令（与 /reboot --update 逻辑一致） */
function buildUpdateInstallCmd(tag = '@latest'): string {
  const globalCfg = getGlobalConfig();
  const updatePkgUrl = globalCfg.updatePkgUrl;
  if (updatePkgUrl) {
    return `(curl -sL -o /tmp/cc-ding-latest.tgz "${updatePkgUrl}" && npm install -g /tmp/cc-ding-latest.tgz && rm -f /tmp/cc-ding-latest.tgz) || npm install -g cc-ding${tag}`;
  }
  return `npm install -g cc-ding${tag}`;
}

/** 获取本机上所有 cc-ding client pm2 进程名（不含 console） */
function getCcDingClientProcessNames(): string[] {
  try {
    const { execSync } = require('child_process');
    const stdout = execSync('pm2 jlist', { encoding: 'utf-8', timeout: 10000 });
    const processes = JSON.parse(stdout);
    return processes
      .filter((p: any) => /^cc-ding-.+$/.test(p.name) && p.name !== 'cc-ding-console')
      .map((p: any) => p.name);
  } catch {
    return [];
  }
}

/** POST /api/update — 更新本机 cc-ding 到最新版并重启所有 client + console */
async function handleUpdateLocal(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!requireAuth(req, res)) return;

  try {
    let body: any = {};
    try {
      const bodyStr = await readBody(req);
      if (bodyStr) body = JSON.parse(bodyStr);
    } catch { /* ignore */ }

    const tag = body.tag ? `@${body.tag}` : '@latest';
    const restartConsole = body.restartConsole !== false; // 默认重启 console
    const installCmd = buildUpdateInstallCmd(tag);

    // 获取当前所有 client 进程名
    const clientNames = getCcDingClientProcessNames();

    if (clientNames.length === 0 && !restartConsole) {
      jsonError(res, 404, '未找到任何 cc-ding 进程');
      return;
    }

    // 后台执行：先安装，再重启 clients，最后重启 console（延迟 500ms 确保响应已发送）
    setTimeout(() => {
      const { execSync: eSync } = require('child_process');
      try {
        console.log(`[console] 开始更新 cc-ding: ${installCmd}`);
        eSync(installCmd, { timeout: 300000, stdio: 'ignore' });
        console.log(`[console] cc-ding 安装完成，开始重启 clients...`);
        // 先重启 clients
        if (clientNames.length > 0) {
          const pm2Cmd = `pm2 restart ${clientNames.map(n => `"${n}"`).join(' ')}`;
          eSync(pm2Cmd, { timeout: 60000, stdio: 'ignore' });
          console.log(`[console] 已重启 ${clientNames.length} 个 clients`);
        }
        // 最后重启 console
        if (restartConsole) {
          eSync('pm2 restart "cc-ding-console"', { timeout: 60000, stdio: 'ignore' });
          console.log('[console] 主 console 已重启（更新完成）');
        }
      } catch (err) {
        console.error(`[console] 更新失败:`, err);
      }
    }, 500);

    const totalTargets = clientNames.length + (restartConsole ? 1 : 0);
    jsonResponse(res, 200, {
      message: `更新已启动：安装 cc-ding${tag}，将重启 ${totalTargets} 个进程（console 最后）`,
      targets: [ ...clientNames, ...(restartConsole ? [ 'cc-ding-console' ] : []) ],
      tag: tag.substring(1),
    });
  } catch (err) {
    jsonError(res, 500, `更新失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** POST /api/remote/clients?url=... — 在远程机器创建新客户端 */
async function handleRemoteCreateClient(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!requireAuth(req, res)) return;
  const rc = getRemoteConsoleFromQuery(req);
  if (!rc) { jsonError(res, 404, '远程 Console 未配置'); return; }

  let bodyStr: string | undefined;
  try { bodyStr = await readBody(req); } catch { /* ignore */ }

  try {
    const { status, data } = await proxyToRemoteConsole(rc, 'POST', '/api/clients', bodyStr);
    if (status !== 201) {
      jsonError(res, status, data.error || '远程创建客户端失败');
      return;
    }
    jsonResponse(res, 201, data);
  } catch (err: any) {
    jsonError(res, 500, err.message || '远程创建客户端失败');
  }
}

/** POST /api/remote/update?url=... — 更新远程机器 cc-ding */
async function handleRemoteUpdate(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!requireAuth(req, res)) return;
  const rc = getRemoteConsoleFromQuery(req);
  if (!rc) { jsonError(res, 404, '远程 Console 未配置'); return; }

  let bodyStr: string | undefined;
  try { bodyStr = await readBody(req); } catch { /* ignore */ }

  try {
    const { status, data } = await proxyToRemoteConsole(rc, 'POST', '/api/update', bodyStr);
    if (status !== 200) {
      jsonError(res, status, data.error || '远程更新失败');
      return;
    }
    jsonResponse(res, 200, { ...data, remoteUrl: rc.url });
  } catch (err) {
    jsonError(res, 500, `远程更新失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** POST /api/batch/update — 一键更新所有机器（本地 + 所有远程） */
async function handleBatchUpdate(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!requireAuth(req, res)) return;

  let body: any = {};
  try {
    const bodyStr = await readBody(req);
    if (bodyStr) body = JSON.parse(bodyStr);
  } catch { /* ignore */ }

  const tag = body.tag || 'latest';
  const results: Array<{ url: string; success: boolean; message: string }> = [];

  // 1. 先触发所有远程机器更新（并行）
  const globalCfg = getGlobalConfig();
  const remoteConsoles = globalCfg.console?.remoteConsoles || [];

  const remotePromises = remoteConsoles.map(async (rc) => {
    try {
      const bodyForRemote = JSON.stringify({ tag, restartConsole: body.restartConsole !== false });
      const { status, data } = await proxyToRemoteConsole(rc, 'POST', '/api/update', bodyForRemote);
      return {
        url: rc.url,
        success: status === 200,
        message: status === 200 ? (data.message || '更新已启动') : (data.error || `HTTP ${status}`),
      };
    } catch (err) {
      return {
        url: rc.url,
        success: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  });

  const remoteResults = await Promise.all(remotePromises);
  results.push(...remoteResults);

  // 2. 本地机器更新（最后，因为可能会重启当前 console）
  try {
    const installCmd = buildUpdateInstallCmd(`@${tag}`);
    const clientNames = getCcDingClientProcessNames();
    const restartConsole = body.restartConsole !== false;

    // 后台异步执行：先安装，再重启 clients，最后重启 console
    setTimeout(() => {
      const { execSync: eSync } = require('child_process');
      try {
        console.log('[console] 开始更新 cc-ding:', installCmd);
        eSync(installCmd, { timeout: 300000, stdio: 'ignore' });
        console.log('[console] cc-ding 安装完成，开始重启 clients...');
        // 先重启 clients
        if (clientNames.length > 0) {
          eSync(`pm2 restart ${clientNames.map(n => `"${n}"`).join(' ')}`, { timeout: 60000, stdio: 'ignore' });
          console.log('[console] clients 已重启');
        }
        // 最后重启 console
        if (restartConsole) {
          eSync('pm2 restart "cc-ding-console"', { timeout: 60000, stdio: 'ignore' });
          console.log('[console] 主 console 已重启（更新完成）');
        }
      } catch (err) {
        console.error(`[console] 本地更新失败:`, err);
      }
    }, 500);

    const totalTargets = clientNames.length + (restartConsole ? 1 : 0);
    results.unshift({
      url: 'local',
      success: true,
      message: `更新已启动：将重启 ${totalTargets} 个进程（console 最后）`,
    });
  } catch (err) {
    results.unshift({
      url: 'local',
      success: false,
      message: err instanceof Error ? err.message : String(err),
    });
  }

  jsonResponse(res, 200, {
    message: `批量更新已启动，共 ${results.length} 台机器`,
    results,
  });
}

/** POST /api/batch/restart — 一键重启所有 cc-ding client */
async function handleBatchRestart(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!requireAuth(req, res)) return;

  let body: any = {};
  try {
    const bodyStr = await readBody(req);
    if (bodyStr) body = JSON.parse(bodyStr);
  } catch { /* ignore */ }

  // scope: 'local' | 'remote' | 'all' | 'remote-consoles' (默认 all)
  // target: 'clients' (默认) | 'console' | 'all' (clients + console)
  // 重启顺序：远程先于本地，client 先于 console，主 console 最后
  const scope: 'local' | 'remote' | 'all' | 'remote-consoles' = body.scope || 'all';
  const target: 'clients' | 'console' | 'all' = body.target || 'clients';
  const results: Array<{ clientId: string; url: string; success: boolean; message: string }> = [];

  const globalCfg = getGlobalConfig();
  const remoteConsoles = globalCfg.console?.remoteConsoles || [];

  // === 第一阶段：远程机器重启（clients + console，并行处理所有远程机器） ===
  if (scope === 'remote' || scope === 'all' || scope === 'remote-consoles') {
    const includeClients = scope !== 'remote-consoles' && (target === 'clients' || target === 'all');
    const includeConsole = scope === 'remote-consoles' || target === 'console' || target === 'all';

    const remotePromises = remoteConsoles.map(async (rc) => {
      try {
        const machineResults: any[] = [];
        // 远程 clients 重启（先于远程 console）
        if (includeClients) {
          const remoteBody = JSON.stringify({ scope: 'local', target: 'clients' });
          const { status, data } = await proxyToRemoteConsole(rc, 'POST', '/api/batch/restart', remoteBody);
          if (status === 200 && Array.isArray(data.results)) {
            machineResults.push(...data.results.map((r: any) => ({ ...r, url: rc.url })));
          } else {
            machineResults.push({ clientId: '*', url: rc.url, success: status === 200, message: data.error || `HTTP ${status}` });
          }
        }
        // 远程 console 重启（在远程 clients 之后）
        if (includeConsole) {
          try {
            const { status, data } = await proxyToRemoteConsole(rc, 'POST', '/api/console/restart');
            machineResults.push({
              clientId: 'console',
              url: rc.url,
              success: status === 200,
              message: status === 200 ? (data.message || '重启已启动') : (data.error || `HTTP ${status}`),
            });
          } catch (err) {
            machineResults.push({
              clientId: 'console',
              url: rc.url,
              success: false,
              message: err instanceof Error ? err.message : String(err),
            });
          }
        }
        return machineResults;
      } catch (err) {
        return [{ clientId: '*', url: rc.url, success: false, message: err instanceof Error ? err.message : String(err) }];
      }
    });
    const remoteResults = (await Promise.all(remotePromises)).flat();
    results.push(...remoteResults);
  }

  // === 第二阶段：本机 clients 重启（在远程之后） ===
  if ((scope === 'local' || scope === 'all') && (target === 'clients' || target === 'all')) {
    const clientNames = getCcDingClientProcessNames();
    if (clientNames.length === 0) {
      results.push({ clientId: '*', url: 'local', success: true, message: '无 client 进程' });
    } else {
      try {
        const { execSync: eSync } = require('child_process');
        eSync(`pm2 restart ${clientNames.map(n => `"${n}"`).join(' ')}`, { timeout: 60000, stdio: 'ignore' });
        for (const name of clientNames) {
          const cid = name.replace(/^cc-ding-/, '');
          results.push({ clientId: cid, url: 'local', success: true, message: '已重启' });
        }
      } catch (err) {
        for (const name of clientNames) {
          const cid = name.replace(/^cc-ding-/, '');
          results.push({ clientId: cid, url: 'local', success: false, message: err instanceof Error ? err.message : String(err) });
        }
      }
    }
  }

  // === 第三阶段：本机 console 重启（最后，确保主 console 在所有操作完成后才重启） ===
  if ((scope === 'local' || scope === 'all') && (target === 'console' || target === 'all')) {
    try {
      const { execSync: eSync } = require('child_process');
      let hasConsole = false;
      try {
        eSync('pm2 describe cc-ding-console', { stdio: 'ignore', timeout: 10000 });
        hasConsole = true;
      } catch { /* not running */ }
      if (hasConsole) {
        // 延迟重启，确保响应已发送
        setTimeout(() => {
          try {
            eSync('pm2 restart "cc-ding-console"', { timeout: 60000, stdio: 'ignore' });
            console.log('[console] 主 console 已重启（批量操作完成）');
          } catch (err) {
            console.error('[console] 重启主 console 失败:', err);
          }
        }, 500);
        results.push({ clientId: 'console', url: 'local', success: true, message: '重启已启动（最后执行）' });
      } else {
        results.push({ clientId: 'console', url: 'local', success: true, message: 'console 未运行' });
      }
    } catch (err) {
      results.push({ clientId: 'console', url: 'local', success: false, message: err instanceof Error ? err.message : String(err) });
    }
  }

  const successCount = results.filter(r => r.success).length;
  jsonResponse(res, 200, {
    message: `重启完成：${successCount}/${results.length} 成功（主 console 最后重启）`,
    scope,
    target,
    results,
  });
}

/** POST /api/batch/reload-config — 一键重载所有机器 client 配置 */
async function handleBatchReloadConfig(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!requireAuth(req, res)) return;

  const results: Array<{ clientId: string; url: string; success: boolean; message: string }> = [];
  const globalCfg = getGlobalConfig();
  const remoteConsoles = globalCfg.console?.remoteConsoles || [];

  // 本地重载
  const localClientNames = getCcDingClientProcessNames();
  for (const name of localClientNames) {
    const clientId = name.replace(/^cc-ding-/, '');
    const result = sendReloadSignal(clientId);
    results.push({
      clientId,
      url: 'local',
      success: result.success,
      message: result.success ? '已发送重载信号' : (result.error || '重载失败'),
    });
  }

  // 远程重载（并行）
  const remotePromises = remoteConsoles.map(async (rc) => {
    try {
      const { status, data } = await proxyToRemoteConsole(rc, 'POST', '/api/machine/reload-config?url=local', '');
      if (status === 200 && Array.isArray(data.results)) {
        return data.results.map((r: any) => ({ ...r, url: rc.url }));
      }
      return [{ clientId: '*', url: rc.url, success: false, message: data.error || `HTTP ${status}` }];
    } catch (err) {
      return [{ clientId: '*', url: rc.url, success: false, message: err instanceof Error ? err.message : String(err) }];
    }
  });

  const remoteResults = await Promise.all(remotePromises);
  for (const arr of remoteResults) {
    results.push(...arr);
  }

  const successCount = results.filter(r => r.success).length;
  jsonResponse(res, 200, {
    message: `重载配置完成：${successCount}/${results.length} 成功`,
    results,
  });
}

/** POST /api/machine/restart?url=local|<remoteUrl> — 重启单台机器的所有 client */
/** POST /api/machine/restart?url=local|<remoteUrl> — 重启单台机器的 client/console/全部 */
async function handleMachineRestart(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!requireAuth(req, res)) return;

  let body: any = {};
  try {
    const bodyStr = await readBody(req);
    if (bodyStr) body = JSON.parse(bodyStr);
  } catch { /* ignore */ }

  // target: 'clients' (默认) | 'console' | 'all'
  const target: 'clients' | 'console' | 'all' = body.target || 'clients';
  const urlParam = query_safe(req, 'url');
  const isLocal = !urlParam || urlParam === 'local';

  const results: Array<{ clientId: string; success: boolean; message: string }> = [];

  if (isLocal) {
    const { execSync: eSync } = require('child_process');

    // 重启 clients
    if (target === 'clients' || target === 'all') {
      const clientNames = getCcDingClientProcessNames();
      if (clientNames.length === 0) {
        results.push({ clientId: '*', success: true, message: '无 client 进程' });
      } else {
        try {
          eSync(`pm2 restart ${clientNames.map(n => `"${n}"`).join(' ')}`, { timeout: 60000, stdio: 'ignore' });
          for (const name of clientNames) {
            results.push({ clientId: name.replace(/^cc-ding-/, ''), success: true, message: '已重启' });
          }
        } catch (err) {
          for (const name of clientNames) {
            results.push({ clientId: name.replace(/^cc-ding-/, ''), success: false, message: err instanceof Error ? err.message : String(err) });
          }
        }
      }
    }

    // 重启 console
    if (target === 'console' || target === 'all') {
      try {
        let hasConsole = false;
        try {
          eSync('pm2 describe cc-ding-console', { stdio: 'ignore', timeout: 10000 });
          hasConsole = true;
        } catch { /* not running */ }
        if (hasConsole) {
          if (target === 'all') {
            // 如果同时重启 clients 和 console，延迟重启 console 确保响应已发送
            setTimeout(() => {
              try {
                eSync('pm2 restart "cc-ding-console"', { timeout: 60000, stdio: 'ignore' });
              } catch (err) {
                console.error('[console] 重启 console 失败:', err);
              }
            }, 500);
          } else {
            // 仅重启 console，也延迟确保响应
            setTimeout(() => {
              try {
                eSync('pm2 restart "cc-ding-console"', { timeout: 60000, stdio: 'ignore' });
              } catch (err) {
                console.error('[console] 重启 console 失败:', err);
              }
            }, 500);
          }
          results.push({ clientId: 'console', success: true, message: '重启已启动' });
        } else {
          results.push({ clientId: 'console', success: true, message: 'console 未运行' });
        }
      } catch (err) {
        results.push({ clientId: 'console', success: false, message: err instanceof Error ? err.message : String(err) });
      }
    }

    const successCount = results.filter(r => r.success).length;
    jsonResponse(res, 200, {
      message: `重启完成：${successCount}/${results.length} 成功`,
      target,
      results,
    });
  } else {
    // 远程机器
    const globalCfg = getGlobalConfig();
    const remoteConsoles = globalCfg.console?.remoteConsoles || [];
    const rc = remoteConsoles.find(r => r.url === urlParam);
    if (!rc) { jsonError(res, 404, '远程 Console 未配置'); return; }

    try {
      const remoteBody = JSON.stringify({ target });
      const { status, data } = await proxyToRemoteConsole(rc, 'POST', '/api/machine/restart?url=local', remoteBody);
      if (status !== 200) {
        jsonError(res, status, data.error || '远程重启失败');
        return;
      }
      jsonResponse(res, 200, { ...data, remoteUrl: rc.url });
    } catch (err) {
      jsonError(res, 500, `远程重启失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** POST /api/machine/reload-config?url=local|<remoteUrl> — 重载单台机器所有 client 配置 */
async function handleMachineReloadConfig(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!requireAuth(req, res)) return;

  const urlParam = query_safe(req, 'url');
  const isLocal = !urlParam || urlParam === 'local';

  const results: Array<{ clientId: string; success: boolean; message: string }> = [];

  if (isLocal) {
    const clientNames = getCcDingClientProcessNames();
    if (clientNames.length === 0) {
      results.push({ clientId: '*', success: true, message: '无 client 进程' });
    } else {
      for (const name of clientNames) {
        const clientId = name.replace(/^cc-ding-/, '');
        const result = sendReloadSignal(clientId);
        results.push({
          clientId,
          success: result.success,
          message: result.success ? '已发送重载信号' : (result.error || '重载失败'),
        });
      }
    }
    const successCount = results.filter(r => r.success).length;
    jsonResponse(res, 200, {
      message: `重载配置完成：${successCount}/${results.length} 成功`,
      results,
    });
  } else {
    const globalCfg = getGlobalConfig();
    const remoteConsoles = globalCfg.console?.remoteConsoles || [];
    const rc = remoteConsoles.find(r => r.url === urlParam);
    if (!rc) { jsonError(res, 404, '远程 Console 未配置'); return; }

    try {
      const { status, data } = await proxyToRemoteConsole(rc, 'POST', '/api/machine/reload-config?url=local', '');
      if (status !== 200) {
        jsonError(res, status, data.error || '远程重载失败');
        return;
      }
      jsonResponse(res, 200, { ...data, remoteUrl: rc.url });
    } catch (err) {
      jsonError(res, 500, `远程重载失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** POST /api/console/restart — 重启本机 console 进程 */
async function handleRestartConsole(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!requireAuth(req, res)) return;

  try {
    // 检查 console 进程是否存在
    const { execSync: eSync } = require('child_process');
    let hasConsole = false;
    try {
      eSync('pm2 describe cc-ding-console', { stdio: 'ignore', timeout: 10000 });
      hasConsole = true;
    } catch { /* console not running */ }

    if (!hasConsole) {
      jsonError(res, 404, '未找到 cc-ding-console 进程');
      return;
    }

    // 延迟 500ms 重启，确保响应已发送
    setTimeout(() => {
      try {
        eSync('pm2 restart "cc-ding-console"', { timeout: 60000, stdio: 'ignore' });
        console.log('[console] console 已重启');
      } catch (err) {
        console.error('[console] 重启 console 失败:', err);
      }
    }, 500);

    jsonResponse(res, 200, { message: 'Console 重启已启动' });
  } catch (err) {
    jsonError(res, 500, `重启 console 失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** POST /api/remote/console/restart?url=... — 重启单个远程 console */
async function handleRemoteConsoleRestart(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!requireAuth(req, res)) return;
  const rc = getRemoteConsoleFromQuery(req);
  if (!rc) { jsonError(res, 404, '远程 Console 未配置'); return; }

  try {
    const { status, data } = await proxyToRemoteConsole(rc, 'POST', '/api/console/restart');
    if (status !== 200) {
      jsonError(res, status, data.error || '远程 console 重启失败');
      return;
    }
    jsonResponse(res, 200, { ...data, remoteUrl: rc.url });
  } catch (err) {
    jsonError(res, 500, `远程 console 重启失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** POST /api/batch/console-restart — 重启所有远程 console */
async function handleBatchConsoleRestart(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!requireAuth(req, res)) return;

  const globalCfg = getGlobalConfig();
  const remoteConsoles = globalCfg.console?.remoteConsoles || [];

  if (remoteConsoles.length === 0) {
    jsonResponse(res, 200, { message: '无远程 Console 配置', results: [] });
    return;
  }

  const results = await Promise.all(remoteConsoles.map(async (rc) => {
    try {
      const { status, data } = await proxyToRemoteConsole(rc, 'POST', '/api/console/restart');
      return {
        url: rc.url,
        success: status === 200,
        message: status === 200 ? (data.message || '重启已启动') : (data.error || `HTTP ${status}`),
      };
    } catch (err) {
      return {
        url: rc.url,
        success: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }));

  const successCount = results.filter(r => r.success).length;
  jsonResponse(res, 200, {
    message: `远程 Console 重启完成：${successCount}/${results.length} 成功`,
    results,
  });
}

/** 安全获取 query 参数 */
function query_safe(req: http.IncomingMessage, key: string): string | null {
  try {
    const url = new URL(req.url || '', 'http://localhost');
    return url.searchParams.get(key);
  } catch {
    return null;
  }
}

// ==================== 路由分发 ====================

async function handleApiRequest(req: http.IncomingMessage, res: http.ServerResponse, pathname: string, query: URLSearchParams): Promise<void> {
  setCorsHeaders(res);

  // OPTIONS 预检
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // 匹配路由
  const clientConfigMatch = pathname.match(/^\/api\/clients\/([^\/]+)\/config(?:\/raw)?$/);
  const clientConfigRawMatch = pathname.match(/^\/api\/clients\/([^\/]+)\/config\/raw$/);
  const clientConfigReloadMatch = pathname.match(/^\/api\/clients\/([^\/]+)\/config\/reload$/);
  const clientPm2Match = pathname.match(/^\/api\/clients\/([^\/]+)\/pm2$/);
  const clientPm2RestartMatch = pathname.match(/^\/api\/clients\/([^\/]+)\/pm2\/restart$/);
  const clientStartMatch = pathname.match(/^\/api\/clients\/([^\/]+)\/start$/);
  const clientStopMatch = pathname.match(/^\/api\/clients\/([^\/]+)\/stop$/);
  const clientApiKeysMatch = pathname.match(/^\/api\/clients\/([^\/]+)\/apikeys(?:\/(\d+))?$/);
  const clientApiKeyIndexMatch = pathname.match(/^\/api\/clients\/([^\/]+)\/apikeys\/(\d+)$/);
  const clientFilesMatch = pathname.match(/^\/api\/clients\/([^\/]+)\/files$/);
  const clientIdMatch = pathname.match(/^\/api\/clients\/([^\/]+)$/);
  const clientConvMatch = pathname.match(/^\/api\/clients\/([^\/]+)\/conversations$/);
  const clientConvIdMatch = pathname.match(/^\/api\/clients\/([^\/]+)\/conversations\/(.+)$/);

  // POST /api/login
  if (pathname === '/api/login' && req.method === 'POST') {
    await handleLogin(req, res);
    return;
  }

  // POST /api/change-password
  if (pathname === '/api/change-password' && req.method === 'POST') {
    await handleChangePassword(req, res);
    return;
  }

  // GET /api/ping - 公开端点，用于局域网扫描
  if (pathname === '/api/ping' && req.method === 'GET') {
    await handlePing(req, res);
    return;
  }

  // GET /api/status
  if (pathname === '/api/status' && req.method === 'GET') {
    await handleGetStatus(req, res);
    return;
  }

  // GET /api/remote/status?url=...
  if (pathname === '/api/remote/status' && req.method === 'GET') {
    await handleGetRemoteStatus(req, res);
    return;
  }

  // POST /api/remote/scan
  if (pathname === '/api/remote/scan' && req.method === 'POST') {
    await handleScanRemoteConsoles(req, res);
    return;
  }

  // POST /api/remote/clients?url=...
  if (pathname === '/api/remote/clients' && req.method === 'POST') {
    await handleRemoteCreateClient(req, res);
    return;
  }

  // GET /api/global/config
  if (pathname === '/api/global/config' && req.method === 'GET') {
    await handleGetGlobalConfig(req, res);
    return;
  }

  // PUT /api/global/config
  if (pathname === '/api/global/config' && req.method === 'PUT') {
    await handlePutGlobalConfig(req, res);
    return;
  }

  // GET /api/global/settings-tpl
  if (pathname === '/api/global/settings-tpl' && req.method === 'GET') {
    await handleGetSettingsTpl(req, res);
    return;
  }

  // PUT /api/global/settings-tpl
  if (pathname === '/api/global/settings-tpl' && req.method === 'PUT') {
    await handlePutSettingsTpl(req, res);
    return;
  }

  // PUT /api/global/update-pkg-url
  if (pathname === '/api/global/update-pkg-url' && req.method === 'PUT') {
    await handlePutUpdatePkgUrl(req, res);
    return;
  }

  // GET /api/global/raw-config
  if (pathname === '/api/global/raw-config' && req.method === 'GET') {
    await handleGetGlobalRawConfig(req, res);
    return;
  }

  // PUT /api/global/raw-config
  if (pathname === '/api/global/raw-config' && req.method === 'PUT') {
    await handlePutGlobalRawConfig(req, res);
    return;
  }

  // 全局 API Key 路由
  const globalApiKeysMatch = pathname.match(/^\/api\/global\/apikeys(?:\/(\d+))?$/);
  const globalApiKeyIndexMatch = pathname.match(/^\/api\/global\/apikeys\/(\d+)$/);
  const globalRetryLogsMatch = pathname === '/api/global/retrylogs';

  // GET /api/global/apikeys
  if (globalApiKeysMatch && req.method === 'GET' && !globalApiKeyIndexMatch) {
    await handleGetGlobalApiKeys(req, res);
    return;
  }

  // POST /api/global/apikeys
  if (globalApiKeysMatch && req.method === 'POST' && !globalApiKeyIndexMatch) {
    await handleAddGlobalApiKey(req, res);
    return;
  }

  // PUT /api/global/apikeys/:index
  if (globalApiKeyIndexMatch && req.method === 'PUT') {
    await handleUpdateGlobalApiKey(req, res, parseInt(globalApiKeyIndexMatch[1], 10));
    return;
  }

  // DELETE /api/global/apikeys/:index
  if (globalApiKeyIndexMatch && req.method === 'DELETE') {
    await handleDeleteGlobalApiKey(req, res, parseInt(globalApiKeyIndexMatch[1], 10));
    return;
  }

  // GET /api/global/retrylogs
  if (globalRetryLogsMatch && req.method === 'GET') {
    await handleGetGlobalRetryLogs(req, res);
    return;
  }

  // PUT /api/global/retrylogs
  if (globalRetryLogsMatch && req.method === 'PUT') {
    await handlePutGlobalRetryLogs(req, res);
    return;
  }

  // GET /api/remote/global/config?url=...
  if (pathname === '/api/remote/global/config' && req.method === 'GET') {
    await handleGetRemoteGlobalConfig(req, res);
    return;
  }

  // PUT /api/remote/global/config?url=...
  if (pathname === '/api/remote/global/config' && req.method === 'PUT') {
    await handlePutRemoteGlobalConfig(req, res);
    return;
  }

  // GET /api/remote/global/settings-tpl?url=...
  if (pathname === '/api/remote/global/settings-tpl' && req.method === 'GET') {
    await handleGetRemoteSettingsTpl(req, res);
    return;
  }

  // PUT /api/remote/global/settings-tpl?url=...
  if (pathname === '/api/remote/global/settings-tpl' && req.method === 'PUT') {
    await handlePutRemoteSettingsTpl(req, res);
    return;
  }

  // PUT /api/remote/global/update-pkg-url?url=...
  if (pathname === '/api/remote/global/update-pkg-url' && req.method === 'PUT') {
    await handlePutRemoteUpdatePkgUrl(req, res);
    return;
  }

  // 远程全局 API Key 路由
  const remoteGlobalApiKeysMatch = pathname.match(/^\/api\/remote\/global\/apikeys(?:\/(\d+))?$/);
  const remoteGlobalApiKeyIndexMatch = pathname.match(/^\/api\/remote\/global\/apikeys\/(\d+)$/);
  const remoteGlobalRetryLogsMatch = pathname === '/api/remote/global/retrylogs';

  // GET /api/remote/global/apikeys?url=...
  if (remoteGlobalApiKeysMatch && req.method === 'GET' && !remoteGlobalApiKeyIndexMatch && req.url?.includes('url=')) {
    await handleGetRemoteGlobalApiKeys(req, res);
    return;
  }
  // POST /api/remote/global/apikeys?url=...
  if (remoteGlobalApiKeysMatch && req.method === 'POST' && !remoteGlobalApiKeyIndexMatch && req.url?.includes('url=')) {
    await handleAddRemoteGlobalApiKey(req, res);
    return;
  }
  // PUT /api/remote/global/apikeys/:index?url=...
  if (remoteGlobalApiKeyIndexMatch && req.method === 'PUT') {
    await handleUpdateRemoteGlobalApiKey(req, res, parseInt(remoteGlobalApiKeyIndexMatch[1], 10));
    return;
  }
  // DELETE /api/remote/global/apikeys/:index?url=...
  if (remoteGlobalApiKeyIndexMatch && req.method === 'DELETE') {
    await handleDeleteRemoteGlobalApiKey(req, res, parseInt(remoteGlobalApiKeyIndexMatch[1], 10));
    return;
  }
  // GET /api/remote/global/retrylogs?url=...
  if (remoteGlobalRetryLogsMatch && req.method === 'GET') {
    await handleGetRemoteGlobalRetryLogs(req, res);
    return;
  }
  // PUT /api/remote/global/retrylogs?url=...
  if (remoteGlobalRetryLogsMatch && req.method === 'PUT') {
    await handlePutRemoteGlobalRetryLogs(req, res);
    return;
  }

  // POST /api/update — 更新本机 cc-ding
  if (pathname === '/api/update' && req.method === 'POST') {
    await handleUpdateLocal(req, res);
    return;
  }

  // POST /api/remote/update?url=... — 更新远程机器 cc-ding
  if (pathname === '/api/remote/update' && req.method === 'POST') {
    await handleRemoteUpdate(req, res);
    return;
  }

  // POST /api/batch/update — 一键更新所有机器
  if (pathname === '/api/batch/update' && req.method === 'POST') {
    await handleBatchUpdate(req, res);
    return;
  }

  // POST /api/batch/restart — 一键重启所有 client
  if (pathname === '/api/batch/restart' && req.method === 'POST') {
    await handleBatchRestart(req, res);
    return;
  }

  // POST /api/batch/reload-config — 一键重载所有机器 client 配置
  if (pathname === '/api/batch/reload-config' && req.method === 'POST') {
    await handleBatchReloadConfig(req, res);
    return;
  }

  // POST /api/machine/restart?url=... — 重启单台机器的所有 client
  if (pathname === '/api/machine/restart' && req.method === 'POST') {
    await handleMachineRestart(req, res);
    return;
  }

  // POST /api/machine/reload-config?url=... — 重载单台机器所有 client 配置
  if (pathname === '/api/machine/reload-config' && req.method === 'POST') {
    await handleMachineReloadConfig(req, res);
    return;
  }

  // POST /api/console/restart — 重启本机 console
  if (pathname === '/api/console/restart' && req.method === 'POST') {
    await handleRestartConsole(req, res);
    return;
  }

  // POST /api/remote/console/restart?url=... — 重启单个远程 console
  if (pathname === '/api/remote/console/restart' && req.method === 'POST') {
    await handleRemoteConsoleRestart(req, res);
    return;
  }

  // POST /api/batch/console-restart — 重启所有远程 console
  if (pathname === '/api/batch/console-restart' && req.method === 'POST') {
    await handleBatchConsoleRestart(req, res);
    return;
  }

  // GET /api/clients
  if (pathname === '/api/clients' && req.method === 'GET') {
    await handleGetClients(req, res);
    return;
  }

  // POST /api/clients
  if (pathname === '/api/clients' && req.method === 'POST') {
    await handleCreateClient(req, res);
    return;
  }

  // GET /api/clients/:id/config
  if (clientConfigMatch && req.method === 'GET' && !clientConfigRawMatch) {
    await handleGetClientConfig(req, res, clientConfigMatch[1]);
    return;
  }

  // PATCH /api/clients/:id/config
  if (clientConfigMatch && req.method === 'PATCH' && !clientConfigRawMatch) {
    await handlePatchClientConfig(req, res, clientConfigMatch[1]);
    return;
  }

  // GET /api/clients/:id/config/raw
  if (clientConfigRawMatch && req.method === 'GET') {
    await handleGetRawConfig(req, res, clientConfigRawMatch[1]);
    return;
  }

  // PUT /api/clients/:id/config/raw
  if (clientConfigRawMatch && req.method === 'PUT') {
    await handlePutRawConfig(req, res, clientConfigRawMatch[1]);
    return;
  }

  // POST /api/clients/:id/config/reload
  if (clientConfigReloadMatch && req.method === 'POST') {
    await handleReloadConfig(req, res, clientConfigReloadMatch[1]);
    return;
  }

  // GET /api/clients/:id/pm2
  if (clientPm2Match && req.method === 'GET') {
    const remoteConsole = getClientRemoteConsole(clientPm2Match[1]);
    if (remoteConsole) {
      const { status, data } = await proxyToRemoteConsole(remoteConsole, 'GET', `/api/clients/${clientPm2Match[1]}/pm2`);
      if (status !== 200) {
        jsonError(res, status, data.error || '获取远程 pm2 状态失败');
        return;
      }
      jsonResponse(res, 200, data);
    } else {
      await handleGetClientPm2(req, res, clientPm2Match[1]);
    }
    return;
  }

  // POST /api/clients/:id/pm2/restart
  if (clientPm2RestartMatch && req.method === 'POST') {
    const remoteConsole = getClientRemoteConsole(clientPm2RestartMatch[1]);
    if (remoteConsole) {
      const { status, data } = await proxyToRemoteConsole(remoteConsole, 'POST', `/api/clients/${clientPm2RestartMatch[1]}/pm2/restart`);
      if (status !== 200) {
        jsonError(res, status, data.error || '远程重启失败');
        return;
      }
      jsonResponse(res, 200, data);
    } else {
      await handleRestartClientPm2(req, res, clientPm2RestartMatch[1]);
    }
    return;
  }

  // POST /api/clients/:id/start
  if (clientStartMatch && req.method === 'POST') {
    const remoteConsole = getClientRemoteConsole(clientStartMatch[1]);
    if (remoteConsole) {
      const { status, data } = await proxyToRemoteConsole(remoteConsole, 'POST', `/api/clients/${clientStartMatch[1]}/start`);
      if (status !== 200) {
        jsonError(res, status, data.error || '远程启动失败');
        return;
      }
      jsonResponse(res, 200, data);
    } else {
      await handleStartClient(req, res, clientStartMatch[1]);
    }
    return;
  }

  // POST /api/clients/:id/stop
  if (clientStopMatch && req.method === 'POST') {
    const remoteConsole = getClientRemoteConsole(clientStopMatch[1]);
    if (remoteConsole) {
      const { status, data } = await proxyToRemoteConsole(remoteConsole, 'POST', `/api/clients/${clientStopMatch[1]}/stop`);
      if (status !== 200) {
        jsonError(res, status, data.error || '远程停止失败');
        return;
      }
      jsonResponse(res, 200, data);
    } else {
      await handleStopClient(req, res, clientStopMatch[1]);
    }
    return;
  }

  // GET /api/clients/:id/apikeys
  if (clientApiKeysMatch && req.method === 'GET' && !clientApiKeyIndexMatch) {
    await handleGetApiKeys(req, res, clientApiKeysMatch[1]);
    return;
  }

  // POST /api/clients/:id/apikeys
  if (clientApiKeysMatch && req.method === 'POST' && !clientApiKeyIndexMatch) {
    await handleAddApiKey(req, res, clientApiKeysMatch[1]);
    return;
  }

  // DELETE /api/clients/:id/apikeys
  if (clientApiKeysMatch && req.method === 'DELETE' && !clientApiKeyIndexMatch) {
    // DELETE 不带 index 时，不支持
    jsonError(res, 400, '请指定 API Key 索引');
    return;
  }

  // PUT /api/clients/:id/apikeys (不推荐，使用 POST 或 PATCH)
  if (clientApiKeysMatch && req.method === 'PUT' && !clientApiKeyIndexMatch) {
    jsonError(res, 400, '请使用 POST 添加 API Key');
    return;
  }

  // PUT /api/clients/:id/apikeys/:index
  if (clientApiKeyIndexMatch && req.method === 'PUT') {
    await handleUpdateApiKey(req, res, clientApiKeyIndexMatch[1], parseInt(clientApiKeyIndexMatch[2], 10));
    return;
  }

  // DELETE /api/clients/:id/apikeys/:index
  if (clientApiKeyIndexMatch && req.method === 'DELETE') {
    await handleDeleteApiKey(req, res, clientApiKeyIndexMatch[1], parseInt(clientApiKeyIndexMatch[2], 10));
    return;
  }

  // PATCH /api/clients/:id/apikeys/:index/cfuseTokenValid (社区版不支持，返回静态响应)
  if (pathname.match(/^\/api\/clients\/([^\/]+)\/apikeys\/(\d+)\/cfuseTokenValid$/) && req.method === 'PATCH') {
    // 社区版不支持 cfuse，返回成功但无操作
    jsonResponse(res, 200, { message: '社区版不支持 cfuseTokenValid 切换', cfuseTokenValid: true });
    return;
  }

  // GET /api/clients/:id/files
  if (clientFilesMatch && req.method === 'GET') {
    const name = query.get('name') || '';
    await handleGetClientFile(req, res, clientFilesMatch[1], name);
    return;
  }

  // PUT /api/clients/:id/files
  if (clientFilesMatch && req.method === 'PUT') {
    const name = query.get('name') || '';
    await handlePutClientFile(req, res, clientFilesMatch[1], name);
    return;
  }

  // POST /api/clients/:id/conversations
  if (clientConvMatch && req.method === 'POST') {
    await handleAddConversation(req, res, clientConvMatch[1]);
    return;
  }

  // PUT /api/clients/:id/conversations/:convId
  if (clientConvIdMatch && req.method === 'PUT') {
    await handleUpdateConversation(req, res, clientConvIdMatch[1], decodeURIComponent(clientConvIdMatch[2]));
    return;
  }

  // DELETE /api/clients/:id/conversations/:convId
  if (clientConvIdMatch && req.method === 'DELETE') {
    await handleDeleteConversation(req, res, clientConvIdMatch[1], decodeURIComponent(clientConvIdMatch[2]));
    return;
  }

  // GET /api/clients/:id
  if (clientIdMatch && req.method === 'GET') {
    // 返回客户端概要信息
    if (!requireAuth(req, res)) return;
    const clientId = clientIdMatch[1];
    const { online, pid } = checkClientOnline(clientId);
    jsonResponse(res, 200, {
      clientId,
      online,
      pid: pid || undefined,
    });
    return;
  }

  // 默认 404
  jsonError(res, 404, 'API 端点不存在');
}

// ==================== ConsoleServer 类 ====================

interface IConsoleServerOptions {
  port?: number;
  host?: string;
  autoOpen?: boolean;
  noBrowser?: boolean;
}

export class ConsoleServer {
  private server: http.Server | null = null;
  private port: number;
  private host: string;
  private autoOpen: boolean;
  private noBrowser: boolean;
  private url: string = '';

  constructor(options: IConsoleServerOptions = {}) {
    const globalCfg = getGlobalConfig();
    this.port = options.port ?? globalCfg.console?.port ?? 8080;
    this.host = options.host ?? globalCfg.console?.host ?? '0.0.0.0';
    this.autoOpen = options.autoOpen ?? false;
    this.noBrowser = options.noBrowser ?? false;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Resolve console-web/dist path (works from both src/ and dist/)
      const getConsoleWebDist = () => {
        const candidates = [
          path.join(__dirname, '..', '..', '..', 'console-web', 'dist'),
          path.join(__dirname, '..', '..', 'console-web', 'dist'),
        ];
        for (const p of candidates) {
          if (fs.existsSync(path.join(p, 'index.html'))) return p;
        }
        return candidates[0];
      };

      this.server = http.createServer(async (req, res) => {
        const { pathname, query } = parseUrl(req.url || '/');

        // Serve React frontend static assets
        if (pathname.startsWith('/assets/')) {
          const assetPath = path.join(getConsoleWebDist(), pathname);
          if (fs.existsSync(assetPath)) {
            const ext = path.extname(assetPath);
            const contentTypes: Record<string, string> = {
              '.js': 'application/javascript',
              '.css': 'text/css',
              '.svg': 'image/svg+xml',
              '.png': 'image/png',
              '.woff2': 'font/woff2',
            };
            res.writeHead(200, {
              'Content-Type': contentTypes[ext] || 'application/octet-stream',
              'Cache-Control': 'public, max-age=31536000',
            });
            fs.createReadStream(assetPath).pipe(res);
            return;
          }
        }

        // Serve favicon
        if (pathname === '/favicon.ico') {
          if (FAVICON_DATA.length > 0) {
            res.writeHead(200, { 'Content-Type': 'image/x-icon', 'Cache-Control': 'public, max-age=86400' });
            res.end(FAVICON_DATA);
          } else {
            res.writeHead(204);
            res.end();
          }
          return;
        }

        // Serve apple-touch-icon and other root-level static files
        if (pathname.match(/^\/(apple-touch-icon|favicon).*\.png$/)) {
          const consoleWebDist = getConsoleWebDist();
          const filePath = path.join(consoleWebDist, pathname);
          if (fs.existsSync(filePath)) {
            res.writeHead(200, {
              'Content-Type': 'image/png',
              'Cache-Control': 'public, max-age=86400',
            });
            fs.createReadStream(filePath).pipe(res);
            return;
          }
        }

        // API 请求
        if (pathname.startsWith('/api/')) {
          await handleApiRequest(req, res, pathname, query);
          return;
        }

        // SPA fallback: all non-API routes serve index.html
        if (req.method === 'GET') {
          const consoleWebDist = getConsoleWebDist();
          const indexPath = path.join(consoleWebDist, 'index.html');
          if (fs.existsSync(indexPath)) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            fs.createReadStream(indexPath).pipe(res);
            return;
          }
        }

        // 默认 404
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
      });

      this.server.on('error', (err) => {
        if ((err as any).code === 'EADDRINUSE') {
          console.error(`[Console] 端口 ${this.port} 已被占用，请更换端口`);
          reject(err);
        } else {
          console.error('[Console] 服务器错误:', err);
          reject(err);
        }
      });

      this.server.listen(this.port, this.host, () => {
        const address = this.server!.address();
        if (typeof address === 'string') {
          this.url = `http://${address}`;
        } else {
          this.url = `http://${this.host}:${address!.port}`;
        }
        console.log(`\n[Console] Web 管理界面已启动: ${this.url}`);
        console.log(`[Console] 默认账号: admin / admin（首次登录需修改密码）\n`);

        // 自动打开浏览器
        if (this.autoOpen && !this.noBrowser) {
          this.openBrowser();
        }

        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          console.log('\n[Console] 服务器已关闭');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  getUrl(): string {
    return this.url;
  }

  private openBrowser(): void {
    const url = this.url;
    const platform = process.platform;
    let cmd: string;
    let args: string[];

    if (platform === 'darwin') {
      cmd = 'open';
      args = [ url ];
    } else if (platform === 'win32') {
      cmd = 'cmd.exe';
      args = [ '/c', 'start', url ];
    } else {
      if (commandExists('xdg-open')) {
        cmd = 'xdg-open';
        args = [ url ];
      } else if (commandExists('firefox')) {
        cmd = 'firefox';
        args = [ url ];
      } else if (commandExists('google-chrome')) {
        cmd = 'google-chrome';
        args = [ url ];
      } else {
        console.log(`[Console] 请手动打开浏览器: ${url}`);
        return;
      }
    }

    try {
      const child = spawnCommand(cmd, args, { detached: true, stdio: 'ignore' });
      child.once('spawn', () => {
        child.unref();
      });
      console.log(`[Console] 已尝试打开浏览器: ${url}`);
    } catch (err) {
      console.log(`[Console] 无法自动打开浏览器，请手动访问: ${url}`);
    }
  }
}

// ==================== CLI 集成 ====================

/** 启动 Console 服务（用于 bin/cc-ding.ts 的 console 子命令） */
export async function startConsoleServer(options: IConsoleServerOptions = {}): Promise<ConsoleServer> {
  const server = new ConsoleServer(options);
  await server.start();
  return server;
}

/** 获取 Console 服务 URL（用于 /open console 命令） */
export function getConsoleUrl(port?: number, host?: string): string {
  const globalCfg = getGlobalConfig();
  const p = port ?? globalCfg.console?.port ?? 8080;
  const h = host ?? globalCfg.console?.host ?? '0.0.0.0';
  // 绑定地址 0.0.0.0/:: 无法在浏览器中访问，替换为 localhost
  const urlHost = (h === '0.0.0.0' || h === '::') ? 'localhost' : h;
  return `http://${urlHost}:${p}`;
}

/** 解析客户端端口（用于 SIGUSR2 后自动更新端口信息） */
export function getConsolePort(): number {
  return getGlobalConfig().console?.port ?? 8080;
}

export function getConsoleHost(): string {
  return getGlobalConfig().console?.host ?? '0.0.0.0';
}

/** 检查主机是否为本机（用于 /open console 命令的安全检查） */
export function isLocalHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/\[|\]/g, '');
  if (normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '0.0.0.0' || normalized === '::1' || normalized === '::') {
    return true;
  }
  // 检查是否为本机 IP
  const interfaces = os.networkInterfaces();
  for (const iface of Object.values(interfaces)) {
    if (!iface) continue;
    for (const info of iface) {
      if (info.address.toLowerCase() === normalized) return true;
    }
  }
  return false;
}

// ==================== 生成前端 HTML ====================

export function generateConsoleHtml(): string {
  // Try multiple paths to find console-web/dist (works from both src/ and dist/)
  const candidates = [
    path.join(__dirname, '..', '..', '..', 'console-web', 'dist'),
    path.join(__dirname, '..', '..', 'console-web', 'dist'),
  ];

  for (const consoleWebDist of candidates) {
    const indexPath = path.join(consoleWebDist, 'index.html');
    if (fs.existsSync(indexPath)) {
      return fs.readFileSync(indexPath, 'utf-8');
    }
  }

  // Fallback
  return `<!DOCTYPE html><html><body style="background:#0a0e14;color:#d4dce6;padding:40px;font-family:monospace;">
    <h2>Console frontend not built</h2>
    <p>Run: <code>cd console-web && npm run build</code></p>
  </body></html>`;
}
