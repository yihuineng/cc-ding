import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { fileUtil, dateUtil } from 'utils-ok';
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
  /** API Token（用于认证） */
  token: string;
  /** 该 Console 管理的 client IDs */
  clientIds: string[];
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

/** 系统状态信息 */
interface ISystemStatus {
  ccDingVersion: string;
  nodeVersion: string;
  platform: string;
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

const CONSOLE_HTML = generateConsoleHtml();
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
function getGlobalConfig(): IConsoleGlobalConfig {
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
        port: parsed.console?.port || parsed.consolePort || 8080,
        host: parsed.console?.host || parsed.consoleHost || '0.0.0.0',
        authUsers: parsed.console?.authUsers || [],
        remoteConsoles: parsed.console?.remoteConsoles || [],
      };
    }
  } catch {
    // ignore parse errors
  }
  return {
    port: 8080,
    host: '0.0.0.0',
    authUsers: [{ account: 'admin', passwordHash: sha256('admin'), firstLogin: true }],
    remoteConsoles: [],
  };
}

/** 获取客户端所属的远程 Console 配置（如果是远程客户端） */
function getClientRemoteConsole(clientId: string): IRemoteConsole | null {
  const globalCfg = getGlobalConfig();
  return globalCfg.remoteConsoles?.find(rc => rc.clientIds.includes(clientId)) || null;
}

/** 代理请求到远程 Console */
async function proxyToRemoteConsole(
  remoteConsole: IRemoteConsole,
  method: string,
  apiPath: string,
  body?: string,
): Promise<{ status: number; data: any }> {
  const url = `${remoteConsole.url.replace(/\/$/, '')}${apiPath}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${remoteConsole.token}`,
  };

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.parse(body) : undefined,
  });

  const data = await res.json();
  return { status: res.status, data };
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
  return globalCfg.authUsers || [];
}

/** 更新认证用户密码 */
function updateAuthPassword(account: string, newPassword: string): boolean {
  const globalCfg = getGlobalConfig();
  const users = globalCfg.authUsers || [];
  const user = users.find(u => u.account === account);
  if (!user) return false;
  user.passwordHash = sha256(newPassword);
  user.firstLogin = false;
  saveGlobalConfig(globalCfg);
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
      apiKeyCount: config?.apiKeyCfg?.claudeSettings?.length || 0,
      apiKeysValid: (config?.apiKeyCfg?.claudeSettings || []).filter(s => s.isValid).length,
    };
  });

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
    if (maskedConfig.apiKeyCfg?.claudeSettings) {
      maskedConfig.apiKeyCfg.claudeSettings = maskedConfig.apiKeyCfg.claudeSettings.map((s: any) => {
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

  const remoteConsole = getClientRemoteConsole(clientId);

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

  const configPath = path.join(getHomeDir(), '.cc-ding', clientId, 'config.json');
  if (!fs.existsSync(configPath)) {
    jsonError(res, 404, '客户端配置不存在');
    return;
  }

  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    jsonResponse(res, 200, { content: raw });
  } catch (err) {
    jsonError(res, 500, '读取失败');
  }
}

/** PUT /api/clients/:id/config/raw */
async function handlePutRawConfig(req: http.IncomingMessage, res: http.ServerResponse, clientId: string): Promise<void> {
  if (!requireAuth(req, res)) return;

  const configPath = path.join(getHomeDir(), '.cc-ding', clientId, 'config.json');
  if (!fs.existsSync(configPath)) {
    jsonError(res, 404, '客户端配置不存在');
    return;
  }

  try {
    const body = await readBody(req);
    const data = JSON.parse(body || '{}');
    // 验证 JSON
    JSON.parse(data.content || '');
    // 备份
    backupFile(configPath);
    // 原子写入
    atomicWrite(configPath, data.content);
    jsonResponse(res, 200, { message: '原始配置已保存' });
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
    const keys = (config.apiKeyCfg?.claudeSettings || []).map((setting, index) => ({
      index,
      isValid: setting.isValid,
      apiKey: maskSecret(setting.apiKey),
      baseUrl: setting.baseUrl,
      model: setting.model,
      smallModel: setting.smallModel || '',
      memo: setting.memo || '',
      cfuseTokenValid: true, // 社区版不支持 cfuse，固定为 true
    }));
    jsonResponse(res, 200, { apiKeys: keys, resetTime: config.apiKeyCfg?.resetTime || '' });
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
    if (!config.apiKeyCfg) config.apiKeyCfg = { claudeSettings: [] };
    if (!config.apiKeyCfg.claudeSettings) config.apiKeyCfg.claudeSettings = [];

    const newKey: IClaudeSetting = {
      isValid: data.isValid !== false,
      apiKey: data.apiKey || '',
      baseUrl: data.baseUrl || 'https://api.anthropic.com',
      model: data.model || 'claude-3-opus-latest',
      smallModel: data.smallModel || '',
      memo: data.memo || '',
    };
    config.apiKeyCfg.claudeSettings.push(newKey);
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
    const settings = config.apiKeyCfg?.claudeSettings || [];
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
    const settings = config.apiKeyCfg?.claudeSettings || [];
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

/** POST /api/clients/:id/apikeys/reset */
async function handleResetApiKeys(req: http.IncomingMessage, res: http.ServerResponse, clientId: string): Promise<void> {
  if (!requireAuth(req, res)) return;

  const configPath = path.join(getHomeDir(), '.cc-ding', clientId, 'config.json');
  if (!fs.existsSync(configPath)) {
    jsonError(res, 404, '客户端配置不存在');
    return;
  }

  try {
    const config = fileUtil.getJSON(configPath) as IConfig;
    if (config.apiKeyCfg?.claudeSettings) {
      for (const setting of config.apiKeyCfg.claudeSettings) {
        setting.isValid = true;
      }
      config.apiKeyCfg.resetTime = dateUtil.mm(Date.now()).format('YYYY-MM-DD HH:mm:ss');
    }
    backupFile(configPath);
    atomicWrite(configPath, JSON.stringify(config, null, 2));
    jsonResponse(res, 200, { message: 'API Key 已全部重置为有效' });
  } catch (err) {
    jsonError(res, 500, '重置失败');
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

  const config = getGlobalConfig();
  jsonResponse(res, 200, { config });
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
    uptime: process.uptime(),
    clients: clientDirs.length,
    onlineClients: onlineCount,
  };
  jsonResponse(res, 200, { status });
}

// 需要从 common.ts 导入
function projUtil() {
  const { projUtil: pu } = require('../common');
  return pu();
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
  const clientApiKeysMatch = pathname.match(/^\/api\/clients\/([^\/]+)\/apikeys(?:\/(\d+))?(?:\/reset)?$/);
  const clientApiKeyIndexMatch = pathname.match(/^\/api\/clients\/([^\/]+)\/apikeys\/(\d+)$/);
  const clientApiKeyResetMatch = pathname.match(/^\/api\/clients\/([^\/]+)\/apikeys\/reset$/);
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

  // GET /api/status
  if (pathname === '/api/status' && req.method === 'GET') {
    await handleGetStatus(req, res);
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

  // GET /api/clients/:id/apikeys
  if (clientApiKeysMatch && req.method === 'GET' && !clientApiKeyIndexMatch && !clientApiKeyResetMatch) {
    await handleGetApiKeys(req, res, clientApiKeysMatch[1]);
    return;
  }

  // POST /api/clients/:id/apikeys
  if (clientApiKeysMatch && req.method === 'POST' && !clientApiKeyIndexMatch && !clientApiKeyResetMatch) {
    await handleAddApiKey(req, res, clientApiKeysMatch[1]);
    return;
  }

  // DELETE /api/clients/:id/apikeys
  if (clientApiKeysMatch && req.method === 'DELETE' && !clientApiKeyIndexMatch && !clientApiKeyResetMatch) {
    // DELETE 不带 index 时，不支持
    jsonError(res, 400, '请指定 API Key 索引');
    return;
  }

  // PUT /api/clients/:id/apikeys (不推荐，使用 POST 或 PATCH)
  if (clientApiKeysMatch && req.method === 'PUT' && !clientApiKeyIndexMatch && !clientApiKeyResetMatch) {
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

  // POST /api/clients/:id/apikeys/reset
  if (clientApiKeyResetMatch && req.method === 'POST') {
    await handleResetApiKeys(req, res, clientApiKeyResetMatch[1]);
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
    this.port = options.port ?? globalCfg.port ?? 8080;
    this.host = options.host ?? globalCfg.host ?? '0.0.0.0';
    this.autoOpen = options.autoOpen ?? false;
    this.noBrowser = options.noBrowser ?? false;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer(async (req, res) => {
        const { pathname, query } = parseUrl(req.url || '/');

        // 静态页面
        if (pathname === '/' && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(CONSOLE_HTML);
          return;
        }

        // favicon
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

        // API 请求
        if (pathname.startsWith('/api/')) {
          await handleApiRequest(req, res, pathname, query);
          return;
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
  const p = port ?? globalCfg.port ?? 8080;
  const h = host ?? globalCfg.host ?? '0.0.0.0';
  // 绑定地址 0.0.0.0/:: 无法在浏览器中访问，替换为 localhost
  const urlHost = (h === '0.0.0.0' || h === '::') ? 'localhost' : h;
  return `http://${urlHost}:${p}`;
}

/** 解析客户端端口（用于 SIGUSR2 后自动更新端口信息） */
export function getConsolePort(): number {
  return getGlobalConfig().port ?? 8080;
}

export function getConsoleHost(): string {
  return getGlobalConfig().host ?? '0.0.0.0';
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

function generateConsoleHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>cc-ding Console</title>
<link rel="icon" href="/favicon.ico" type="image/x-icon">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
/* ===== CSS Variables - Industrial Terminal ===== */
:root {
  --bg: #0a0e14;
  --bg-secondary: #0f1419;
  --bg-tertiary: #151b23;
  --border: #1e2733;
  --border-bright: #2d3d4f;
  --text: #d4dce6;
  --text-secondary: #6b7d93;
  --text-dim: #3d4f63;
  --accent: #00ff9d;
  --accent-dim: #00cc7d;
  --accent-glow: rgba(0, 255, 157, 0.15);
  --amber: #ffb454;
  --amber-dim: #cc9044;
  --red: #ff4757;
  --red-dim: #cc3945;
  --yellow: #ffd93d;
  --card-radius: 2px;
  --font: 'IBM Plex Mono', 'JetBrains Mono', 'SF Mono', 'Fira Code', monospace;
  --mono: 'JetBrains Mono', 'IBM Plex Mono', 'SF Mono', monospace;
}

/* ===== Reset & Base ===== */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

body {
  font-family: var(--font);
  background: var(--bg);
  background-image:
    linear-gradient(var(--border) 1px, transparent 1px),
    linear-gradient(90deg, var(--border) 1px, transparent 1px);
  background-size: 40px 40px;
  background-position: -1px -1px;
  color: var(--text);
  line-height: 1.6;
  min-height: 100vh;
  font-size: 13px;
  font-feature-settings: 'liga' 1, 'calt' 1;
}

a { color: var(--accent); text-decoration: none; transition: text-shadow 0.2s; }
a:hover { text-decoration: underline; text-shadow: 0 0 8px var(--accent-glow); }
button { cursor: pointer; font-family: var(--font); }
input, textarea, select {
  font-family: var(--font);
  background: var(--bg);
  color: var(--text);
  border: 1px solid var(--border-bright);
  border-radius: var(--card-radius);
  padding: 8px 12px;
  font-size: 13px;
  transition: border-color 0.2s, box-shadow 0.2s;
}
input:focus, textarea:focus, select:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent-glow), inset 0 0 8px var(--accent-glow);
}
textarea { font-family: var(--mono); font-size: 12px; resize: vertical; line-height: 1.5; }
::placeholder { color: var(--text-dim); }

/* ===== Layout ===== */
.container { max-width: 1400px; margin: 0 auto; padding: 24px; }

.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 24px;
  border-bottom: 1px solid var(--border-bright);
  background: var(--bg-secondary);
  position: sticky;
  top: 0;
  z-index: 100;
  backdrop-filter: blur(8px);
}
.header::before {
  content: '>';
  color: var(--accent);
  margin-right: 12px;
  font-weight: bold;
  animation: blink 1s step-end infinite;
}
@keyframes blink { 50% { opacity: 0; } }

.header h1 {
  font-size: 14px;
  font-weight: 500;
  letter-spacing: 2px;
  text-transform: uppercase;
  color: var(--text);
}
.header-actions { display: flex; gap: 12px; align-items: center; }
.user-info { color: var(--text-secondary); font-size: 12px; margin-right: 12px; font-family: var(--mono); }

/* ===== Buttons ===== */
.btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  border: 1px solid var(--border-bright);
  border-radius: var(--card-radius);
  background: var(--bg-tertiary);
  color: var(--text);
  font-size: 12px;
  font-weight: 500;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  transition: all 0.15s;
}
.btn:hover {
  background: var(--border-bright);
  border-color: var(--text-dim);
}
.btn-primary {
  background: transparent;
  color: var(--accent);
  border-color: var(--accent-dim);
}
.btn-primary:hover {
  background: var(--accent-glow);
  border-color: var(--accent);
  box-shadow: 0 0 12px var(--accent-glow);
}
.btn-danger {
  background: transparent;
  color: var(--red);
  border-color: var(--red-dim);
}
.btn-danger:hover {
  background: rgba(255, 71, 87, 0.1);
  border-color: var(--red);
  box-shadow: 0 0 12px rgba(255, 71, 87, 0.2);
}
.btn-sm { padding: 4px 10px; font-size: 11px; }
.btn:disabled { opacity: 0.4; cursor: not-allowed; }

/* ===== Cards ===== */
.card {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--card-radius);
  padding: 20px;
  margin-bottom: 16px;
  position: relative;
}
.card::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  width: 4px;
  height: 100%;
  background: var(--accent);
  opacity: 0;
  transition: opacity 0.2s;
}
.card:hover::before { opacity: 0.6; }

.card-title {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 2px;
  text-transform: uppercase;
  color: var(--text-secondary);
  margin-bottom: 16px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border);
}
.card-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 16px; }

/* ===== Client Cards ===== */
.client-card { cursor: pointer; transition: all 0.2s; }
.client-card:hover {
  border-color: var(--accent-dim);
  transform: translateY(-2px);
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3), 0 0 0 1px var(--accent-glow);
}
.client-card:hover::before { opacity: 1; }
.client-card .card-title { margin-bottom: 8px; border-bottom: none; padding-bottom: 0; }
.client-name { font-size: 15px; font-weight: 600; color: var(--text); }
.client-id { font-size: 11px; color: var(--text-dim); font-family: var(--mono); margin-top: 2px; }

.status-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  border-radius: 2px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.5px;
  text-transform: uppercase;
}
.status-badge::before {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 50%;
  animation: pulse 2s ease-in-out infinite;
}
.status-online {
  background: rgba(0, 255, 157, 0.1);
  color: var(--accent);
  border: 1px solid rgba(0, 255, 157, 0.3);
}
.status-online::before {
  background: var(--accent);
  box-shadow: 0 0 6px var(--accent);
}
.status-offline {
  background: rgba(255, 71, 87, 0.1);
  color: var(--red);
  border: 1px solid rgba(255, 71, 87, 0.3);
}
.status-offline::before {
  background: var(--red);
  animation: none;
}
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

.client-meta {
  display: flex;
  gap: 20px;
  margin-top: 12px;
  font-size: 12px;
  color: var(--text-secondary);
  font-family: var(--mono);
}
.client-meta span { display: flex; align-items: center; gap: 6px; }

/* ===== Tabs ===== */
.tabs {
  display: flex;
  border-bottom: 1px solid var(--border);
  margin-bottom: 20px;
  overflow-x: auto;
  gap: 4px;
}
.tab {
  padding: 10px 18px;
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 1px;
  text-transform: uppercase;
  color: var(--text-secondary);
  border: none;
  background: none;
  cursor: pointer;
  white-space: nowrap;
  border-bottom: 2px solid transparent;
  transition: all 0.2s;
}
.tab:hover { color: var(--text); background: var(--bg-tertiary); }
.tab.active {
  color: var(--accent);
  border-bottom-color: var(--accent);
  text-shadow: 0 0 8px var(--accent-glow);
}

/* ===== Table ===== */
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 12px; font-family: var(--mono); }
th, td { padding: 10px 14px; text-align: left; border-bottom: 1px solid var(--border); }
th {
  font-weight: 600;
  color: var(--text-dim);
  text-transform: uppercase;
  letter-spacing: 1px;
  font-size: 10px;
}
tr:hover td { background: var(--bg-tertiary); }
td { color: var(--text-secondary); }

/* ===== Forms ===== */
.form-group { margin-bottom: 16px; }
.form-group label {
  display: block;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 1.5px;
  text-transform: uppercase;
  color: var(--text-dim);
  margin-bottom: 6px;
}
.form-row { display: flex; gap: 12px; align-items: end; }
.form-row .form-group { flex: 1; }
.form-actions { display: flex; gap: 12px; margin-top: 16px; }

/* ===== Login ===== */
.login-container { display: flex; align-items: center; justify-content: center; min-height: 100vh; }
.login-card {
  width: 100%;
  max-width: 380px;
  border: 1px solid var(--border-bright);
  position: relative;
}
.login-card::after {
  content: '';
  position: absolute;
  inset: -1px;
  background: linear-gradient(135deg, var(--accent-glow), transparent, var(--accent-glow));
  border-radius: var(--card-radius);
  pointer-events: none;
  opacity: 0.5;
}
.login-card .card-title {
  text-align: center;
  font-size: 12px;
  margin-bottom: 24px;
  border-bottom: none;
  padding-bottom: 0;
}
.login-card .form-group { margin-bottom: 20px; }
.login-card input { width: 100%; padding: 12px 14px; font-size: 14px; }
.login-card .btn { width: 100%; padding: 12px; font-size: 13px; justify-content: center; }

/* ===== Toast ===== */
.toast-container { position: fixed; top: 80px; right: 24px; z-index: 9999; display: flex; flex-direction: column; gap: 8px; }
.toast {
  padding: 12px 18px;
  border-radius: var(--card-radius);
  font-size: 12px;
  font-family: var(--mono);
  min-width: 280px;
  animation: slideIn 0.3s ease-out;
  border: 1px solid;
  position: relative;
  overflow: hidden;
}
.toast::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  width: 3px;
  height: 100%;
}
.toast-success { background: rgba(0, 255, 157, 0.08); border-color: var(--accent-dim); color: var(--accent); }
.toast-success::before { background: var(--accent); }
.toast-error { background: rgba(255, 71, 87, 0.08); border-color: var(--red-dim); color: var(--red); }
.toast-error::before { background: var(--red); }
.toast-info { background: rgba(255, 180, 84, 0.08); border-color: var(--amber-dim); color: var(--amber); }
.toast-info::before { background: var(--amber); }
@keyframes slideIn { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }

/* ===== Modal ===== */
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.8);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}
.modal {
  background: var(--bg-secondary);
  border: 1px solid var(--border-bright);
  border-radius: var(--card-radius);
  padding: 24px;
  width: 90%;
  max-width: 600px;
  max-height: 80vh;
  overflow-y: auto;
  position: relative;
}
.modal::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 2px;
  background: linear-gradient(90deg, transparent, var(--accent), transparent);
}
.modal-title {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 2px;
  text-transform: uppercase;
  color: var(--text);
  margin-bottom: 20px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border);
}
.modal-actions { display: flex; gap: 12px; justify-content: flex-end; margin-top: 24px; }

/* ===== Status Page ===== */
.status-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; }
.status-item {
  text-align: center;
  padding: 24px 16px;
  border: 1px solid var(--border);
  border-radius: var(--card-radius);
  background: var(--bg-tertiary);
}
.status-item .value {
  font-size: 32px;
  font-weight: 700;
  color: var(--accent);
  font-family: var(--mono);
  text-shadow: 0 0 20px var(--accent-glow);
}
.status-item .label {
  font-size: 10px;
  color: var(--text-dim);
  margin-top: 8px;
  letter-spacing: 1.5px;
  text-transform: uppercase;
}

/* ===== Env Vars ===== */
.env-list { font-family: var(--mono); font-size: 12px; }
.env-item { display: flex; gap: 12px; align-items: center; padding: 6px 0; }
.env-key { color: var(--accent); min-width: 200px; }
.env-val { color: var(--text-secondary); }

/* ===== Misc ===== */
.empty-state { text-align: center; padding: 60px 24px; color: var(--text-dim); }
.empty-state .icon { font-size: 56px; margin-bottom: 16px; opacity: 0.5; }
.divider { height: 1px; background: var(--border); margin: 20px 0; }
.text-mono { font-family: var(--mono); font-size: 12px; }
.text-muted { color: var(--text-secondary); }
.text-success { color: var(--accent); }
.text-danger { color: var(--red); }
.flex-between { display: flex; justify-content: space-between; align-items: center; }
.gap-8 { gap: 8px; }
.mt-8 { margin-top: 8px; }
.mt-16 { margin-top: 16px; }
.mb-8 { margin-bottom: 8px; }

.switch { position: relative; width: 40px; height: 22px; display: inline-block; }
.switch input { opacity: 0; width: 0; height: 0; }
.switch .slider {
  position: absolute;
  inset: 0;
  background: var(--bg-tertiary);
  border: 1px solid var(--border-bright);
  border-radius: 2px;
  cursor: pointer;
  transition: 0.2s;
}
.switch .slider::before {
  content: '';
  position: absolute;
  width: 14px;
  height: 14px;
  left: 3px;
  top: 3px;
  background: var(--text-dim);
  border-radius: 2px;
  transition: 0.2s;
}
.switch input:checked + .slider {
  background: var(--accent-glow);
  border-color: var(--accent);
}
.switch input:checked + .slider::before {
  transform: translateX(18px);
  background: var(--accent);
  box-shadow: 0 0 8px var(--accent);
}

/* ===== Scrollbar ===== */
::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-track { background: var(--bg); }
::-webkit-scrollbar-thumb { background: var(--border-bright); border-radius: 2px; }
::-webkit-scrollbar-thumb:hover { background: var(--text-dim); }

/* ===== Selection ===== */
::selection { background: var(--accent-glow); color: var(--accent); }

@media (max-width: 768px) {
  .container { padding: 16px; }
  .card-grid { grid-template-columns: 1fr; }
  .form-row { flex-direction: column; }
  .header { flex-wrap: wrap; gap: 12px; padding: 12px 16px; }
}
</style>
</head>
<body>

<div id="app"></div>
<div class="toast-container" id="toasts"></div>

<script>
// ===== State =====
const SQ = String.fromCharCode(39); // single quote, survives minification
const state = {
  token: localStorage.getItem('ccding_token') || '',
  account: localStorage.getItem('ccding_account') || '',
  firstLogin: JSON.parse(localStorage.getItem('ccding_firstLogin') || 'false'),
  clients: [],
  selectedClient: null,
  activeTab: 'config',
  rawConfig: '',
  apiKeys: [],
  apiKeysResetTime: '',
  files: {},
  envVars: [],
  globalConfig: {},
  status: null,
  settingsTpl: '',
};

// 常用环境变量提示（用于添加时的 autocomplete）
const COMMON_ENV_VARS = [
  { key: 'ANTHROPIC_API_KEY', desc: 'Anthropic API Key' },
  { key: 'ANTHROPIC_BASE_URL', desc: 'Anthropic API Base URL' },
  { key: 'ANTHROPIC_MODEL', desc: '默认模型' },
  { key: 'CLAUDE_SMALL_FAST_MODEL', desc: '小模型（轻量任务）' },
  { key: 'CLAUDE_CODE_MAX_TURNS', desc: 'Claude Code 最大轮次' },
  { key: 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', desc: '禁用非必要流量' },
  { key: 'CLAUDE_CODE_ENABLE_BACKGROUND_TASKS', desc: '启用后台任务' },
  { key: 'CLAUDE_CODE_HOME', desc: 'Claude Code 家目录' },
  { key: 'CLAUDE_CODE_ENTRYPOINT', desc: 'Claude Code 入口点' },
  { key: 'CLAUDE_CODE_AUTO_COMPACT_WINDOW', desc: '自动压缩窗口大小' },
  { key: 'HTTP_PROXY', desc: 'HTTP 代理' },
  { key: 'HTTPS_PROXY', desc: 'HTTPS 代理' },
  { key: 'NO_PROXY', desc: '不走代理的地址' },
  { key: 'PATH', desc: '可执行文件路径' },
  { key: 'NODE_PATH', desc: 'Node.js 模块路径' },
  { key: 'TZ', desc: '时区（如 Asia/Shanghai）' },
];

// ===== API Client =====
const API_BASE = window.location.origin;

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.token) headers['Authorization'] = 'Bearer ' + state.token;
  const res = await fetch(API_BASE + path, {
    ...opts,
    headers: { ...headers, ...(opts.headers || {}) },
  });
  if (res.status === 401) {
    state.token = '';
    localStorage.removeItem('ccding_token');
    localStorage.removeItem('ccding_account');
    renderLogin();
    throw new Error('未认证');
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || '请求失败');
  }
  return res.json();
}

// ===== Toast =====
function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = 'toast toast-' + type;
  el.textContent = msg;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

// ===== Render: Login =====
function renderLogin() {
  document.getElementById('app').innerHTML = \`
    <div class="login-container">
      <div class="login-card card">
        <div class="card-title">🔐 cc-ding Console</div>
        <div class="form-group">
          <label>账号</label>
          <input type="text" id="login-account" value="admin" placeholder="admin" autocomplete="username">
        </div>
        <div class="form-group">
          <label>密码</label>
          <input type="password" id="login-password" placeholder="默认: admin" autocomplete="current-password"
                 onkeydown="if(event.key==='Enter')doLogin()">
        </div>
        <button class="btn btn-primary" onclick="doLogin()">登 录</button>
      </div>
    </div>
  \`;
  setTimeout(() => {
    const pw = document.getElementById('login-password');
    if (pw) pw.focus();
  }, 100);
}

async function doLogin() {
  const account = document.getElementById('login-account').value.trim();
  const password = document.getElementById('login-password').value;
  if (!account || !password) { toast('请填写账号和密码', 'error'); return; }
  try {
    const data = await api('/api/login', { method: 'POST', body: JSON.stringify({ account, password }) });
    state.token = data.token;
    state.account = data.account;
    state.firstLogin = data.firstLogin;
    localStorage.setItem('ccding_token', data.token);
    localStorage.setItem('ccding_account', data.account);
    localStorage.setItem('ccding_firstLogin', JSON.stringify(data.firstLogin));
    if (data.firstLogin) {
      toast('首次登录，请修改密码', 'info');
      renderApp();
    } else {
      toast('登录成功', 'success');
      renderApp();
    }
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ===== Render: Password Change =====
function renderPasswordChange() {
  const main = document.getElementById('app');
  main.innerHTML = \`
    <div class="login-container">
      <div class="login-card card">
        <div class="card-title">🔑 修改密码</div>
        <p class="text-muted mb-8" style="text-align:center;font-size:13px;">首次登录，请修改默认密码</p>
        <div class="form-group">
          <label>新密码</label>
          <input type="password" id="new-password" placeholder="至少4位"
                 onkeydown="if(event.key==='Enter')doChangePassword()">
        </div>
        <div class="form-group">
          <label>确认密码</label>
          <input type="password" id="confirm-password" placeholder="再次输入"
                 onkeydown="if(event.key==='Enter')doChangePassword()">
        </div>
        <button class="btn btn-primary" onclick="doChangePassword()">确认修改</button>
      </div>
    </div>
  \`;
  setTimeout(() => document.getElementById('new-password')?.focus(), 100);
}

async function doChangePassword() {
  const pw = document.getElementById('new-password').value;
  const confirm = document.getElementById('confirm-password').value;
  if (!pw || pw.length < 4) { toast('密码至少需要4位', 'error'); return; }
  if (pw !== confirm) { toast('两次输入的密码不一致', 'error'); return; }
  try {
    await api('/api/change-password', { method: 'POST', body: JSON.stringify({ newPassword: pw }) });
    state.firstLogin = false;
    localStorage.setItem('ccding_firstLogin', 'false');
    toast('密码修改成功', 'success');
    renderApp();
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ===== Render: Main App =====
async function renderApp() {
  if (!state.token) { renderLogin(); return; }
  if (state.firstLogin) { renderPasswordChange(); return; }

  const main = document.getElementById('app');
  main.innerHTML = \`
    <div class="header">
      <h1>🖥️ cc-ding Console</h1>
      <div class="header-actions">
        <span class="user-info" id="user-info">👤 admin</span>
        <button class="btn btn-sm" onclick="loadStatus();showTab('status')">系统</button>
        <button class="btn btn-sm" onclick="loadGlobalConfig()">全局</button>
        <button class="btn btn-sm" onclick="doLogout()">退出</button>
      </div>
    </div>
    <div class="container">
      <div id="client-list-section"></div>
      <div id="client-detail-section" style="display:none"></div>
      <div id="global-section" style="display:none"></div>
      <div id="status-section" style="display:none"></div>
    </div>
  \`;

  document.getElementById('user-info').textContent = '👤 ' + state.account;
  await loadClients();
}

function doLogout() {
  state.token = '';
  state.account = '';
  state.firstLogin = false;
  localStorage.removeItem('ccding_token');
  localStorage.removeItem('ccding_account');
  localStorage.removeItem('ccding_firstLogin');
  renderLogin();
}

// ===== Load Clients =====
async function loadClients() {
  try {
    const data = await api('/api/clients');
    state.clients = data.clients;
    renderClientList();
  } catch (e) {
    toast('加载客户端列表失败: ' + e.message, 'error');
  }
}

function renderClientList() {
  const section = document.getElementById('client-list-section');
  if (!section) return;

  if (state.clients.length === 0) {
    section.innerHTML = '<div class="card"><div class="flex-between"><div class="card-title" style="margin-bottom:0">客户端列表</div><button class="btn btn-primary" onclick="showCreateClientModal()">➕ 新建 Client</button></div></div><div class="empty-state"><div class="icon">📭</div><p>暂无客户端配置</p><p class="text-muted">请创建新 Client 或运行 cc-ding init 初始化</p></div>';
    return;
  }

  // 构建远程 client 映射
  const remoteMap = new Map<string, string>();
  const remoteConsoles = state.globalConfig.remoteConsoles || [];
  for (const rc of remoteConsoles) {
    for (const cid of rc.clientIds) {
      remoteMap.set(cid, rc.url);
    }
  }

  let html = '<div class="card"><div class="flex-between"><div class="card-title" style="margin-bottom:0">客户端列表 (' + state.clients.length + ')</div><button class="btn btn-primary" onclick="showCreateClientModal()">➕ 新建 Client</button></div></div><div class="card-grid">';
  for (const c of state.clients) {
    const remoteUrl = remoteMap.get(c.clientId);
    const isRemote = !!remoteUrl;
    const remoteIndicator = isRemote ? '<span class="text-muted" style="font-size:11px;margin-left:8px;" title="远程: ' + escHtml(remoteUrl) + '"> 远程</span>' : '';

    html += \`
      <div class="card client-card" onclick="selectClient('\${c.clientId}')">
        <div class="flex-between">
          <div>
            <div class="client-name">\${escHtml(c.clientName || c.clientId)}\${remoteIndicator}</div>
            <div class="client-id">\${escHtml(c.clientId)}</div>
          </div>
          <span class="status-badge \${c.online ? 'status-online' : 'status-offline'}">\${c.online ? '● 在线' : '○ 离线'}</span>
        </div>
        <div class="client-meta">
          \${c.pid != null ? '<span>🆔 PID: ' + c.pid + '</span>' : ''}
          <span>💬 \${c.conversationCount} 会话</span>
          <span>🔑 \${c.apiKeysValid}/\${c.apiKeyCount} Key</span>
        </div>
      </div>
    \`;
  }
  html += '</div>';
  section.innerHTML = html;
}

// ===== Create Client Modal =====
function showCreateClientModal() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'create-client-modal';
  overlay.onclick = function(e) { if (e.target === overlay) overlay.remove(); };
  overlay.innerHTML = '<div class="modal">' +
    '<div class="modal-title">新建 Client</div>' +
    '<div class="form-group"><label>ClientId *</label><input type="text" id="cc-clientId" placeholder="唯一标识，如 my-project" pattern="[a-zA-Z0-9_-]+"></div>' +
    '<div class="form-group"><label>Client 名称</label><input type="text" id="cc-clientName" value="cc助手"></div>' +
    '<div class="form-group"><label>Owner * (手机号或工号)</label><input type="text" id="cc-owner" placeholder="owner手机号"></div>' +
    '<div class="form-group"><label>Client Secret *</label><input type="text" id="cc-clientSecret" placeholder="钉钉Stream Client密钥"></div>' +
    '<div class="form-group"><label>默认 Ding Token *</label><input type="text" id="cc-defaultDingToken" placeholder="兜底钉钉机器人Token"></div>' +
    '<div class="form-group"><label>白名单 (逗号分隔)</label><input type="text" id="cc-whiteUserList" placeholder="手机号1,手机号2"></div>' +
    '<div class="modal-actions">' +
    '<button class="btn" onclick="document.getElementById(' + SQ + 'create-client-modal' + SQ + ').remove()">取消</button>' +
    '<button class="btn btn-primary" onclick="doCreateClient()">创建</button>' +
    '</div></div>';
  document.body.appendChild(overlay);
  setTimeout(() => { const el = document.getElementById('cc-clientId'); if (el) el.focus(); }, 100);
}

async function doCreateClient() {
  var clientId = document.getElementById('cc-clientId').value.trim();
  var clientName = document.getElementById('cc-clientName').value.trim();
  var owner = document.getElementById('cc-owner').value.trim();
  var clientSecret = document.getElementById('cc-clientSecret').value.trim();
  var defaultDingToken = document.getElementById('cc-defaultDingToken').value.trim();
  var whiteUserList = document.getElementById('cc-whiteUserList').value.trim();

  if (!clientId || !owner || !clientSecret || !defaultDingToken) {
    toast('请填写所有必填字段', 'error'); return;
  }

  try {
    await api('/api/clients', {
      method: 'POST',
      body: JSON.stringify({ clientId: clientId, clientName: clientName, owner: owner, clientSecret: clientSecret, defaultDingToken: defaultDingToken, whiteUserList: whiteUserList }),
    });
    var modal = document.getElementById('create-client-modal');
    if (modal) modal.remove();
    toast('客户端已创建', 'success');
    await loadClients();
  } catch (e) { toast(e.message, 'error'); }
}

// ===== Select Client =====
async function selectClient(clientId) {
  state.selectedClient = clientId;
  state.activeTab = 'config';
  document.getElementById('client-list-section').style.display = 'none';
  const detail = document.getElementById('client-detail-section');
  detail.style.display = 'block';

  // Load all data in parallel
  await Promise.allSettled([
    loadClientConfig(clientId),
    loadClientApiKeys(clientId),
    loadRawConfig(clientId),
  ]);

  renderClientDetail(clientId);
}

async function loadClientConfig(clientId) {
  try {
    const data = await api('/api/clients/' + encodeURIComponent(clientId) + '/config');
    state.clientConfig = data.config;
  } catch (e) {
    state.clientConfig = null;
  }
}

async function loadClientApiKeys(clientId) {
  try {
    const data = await api('/api/clients/' + encodeURIComponent(clientId) + '/apikeys');
    state.apiKeys = data.apiKeys || [];
    state.apiKeysResetTime = data.resetTime || '';
  } catch (e) {
    state.apiKeys = [];
    state.apiKeysResetTime = '';
  }
}

async function loadRawConfig(clientId) {
  try {
    const data = await api('/api/clients/' + encodeURIComponent(clientId) + '/config/raw');
    state.rawConfig = data.content || '';
  } catch (e) {
    state.rawConfig = '';
  }
}

// ===== Render: Client Detail =====
function renderClientDetail(clientId) {
  const c = state.clients.find(x => x.clientId === clientId);
  const detail = document.getElementById('client-detail-section');
  if (!detail) return;

  const tabs = ['config', 'conversations', 'keys', 'files', 'env', 'raw'];
  let tabHtml = '<div class="tabs">';
  const tabLabels = { config: '️ 配置', conversations: ' 会话管理', keys: ' API Key', files: ' 文件', env: '🌍 环境变量', raw: '📝 原始JSON' };
  for (const t of tabs) {
    tabHtml += '<button class="tab' + (state.activeTab === t ? ' active' : '') + '" onclick="switchTab(' + SQ + t + SQ + ')">' + tabLabels[t] + '</button>';
  }
  tabHtml += '</div>';

  let contentHtml = '';
  if (state.activeTab === 'config') contentHtml = renderConfigTab(clientId);
  else if (state.activeTab === 'conversations') contentHtml = renderConvTab(clientId);
  else if (state.activeTab === 'keys') contentHtml = renderKeysTab(clientId);
  else if (state.activeTab === 'files') contentHtml = renderFilesTab(clientId);
  else if (state.activeTab === 'env') contentHtml = renderEnvTab(clientId);
  else if (state.activeTab === 'raw') contentHtml = renderRawTab(clientId);

  // 构建远程标识
  const remoteConsoles = state.globalConfig.remoteConsoles || [];
  const remoteConsole = remoteConsoles.find(rc => rc.clientIds.includes(clientId));
  const remoteIndicator = remoteConsole ? '<span class="text-muted" style="font-size:11px;margin-left:8px;" title="远程: ' + escHtml(remoteConsole.url) + '"> 远程</span>' : '';

  detail.innerHTML = \`
    <div class="flex-between mb-8">
      <button class="btn btn-sm" onclick="backToList()">← 返回</button>
      <span>
        <span class="client-name">\${escHtml(c?.clientName || clientId)}\${remoteIndicator}</span>
        <span class="status-badge \${c?.online ? 'status-online' : 'status-offline'}" style="margin-left:8px;">\${c?.online ? '● 在线' : '○ 离线'}</span>
      </span>
      <div style="display:flex;gap:8px;">
        <button class="btn btn-sm" onclick="getPm2Status('\${clientId}')" title="查看 pm2 状态">📊 状态</button>
        <button class="btn btn-sm btn-danger" onclick="restartClient('\${clientId}')" title="重启进程">🔄 重启</button>
        <button class="btn btn-sm" onclick="reloadClientConfig('\${clientId}')" title="发送 SIGUSR2 热重载"> 重载</button>
      </div>
    </div>
    \${tabHtml}
    <div class="mt-16">\${contentHtml}</div>
    <div id="pm2-status-section" style="display:none;margin-top:16px;"></div>
  \`;
}

async function getPm2Status(clientId: string) {
  const section = document.getElementById('pm2-status-section');
  if (!section) return;

  try {
    const data = await api(\`/api/clients/\${clientId}/pm2\`);
    section.style.display = 'block';
    section.innerHTML = \`
      <div class="card">
        <div class="card-title">📊 pm2 进程状态</div>
        <div class="form-row">
          <div class="form-group"><label>PID</label><div class="text-mono">\${data.pid || '-'}</div></div>
          <div class="form-group"><label>状态</label><div>\${data.status || '-'}</div></div>
          <div class="form-group"><label>内存</label><div class="text-mono">\${formatBytes(data.memory || 0)}</div></div>
          <div class="form-group"><label>CPU</label><div class="text-mono">\${data.cpu || 0}%</div></div>
          <div class="form-group"><label>重启次数</label><div class="text-mono">\${data.restarts || 0}</div></div>
          <div class="form-group"><label>运行时间</label><div class="text-mono">\${formatUptime(data.uptime || 0)}</div></div>
        </div>
      </div>
    \`;
  } catch (e) {
    section.style.display = 'block';
    section.innerHTML = '<div class="card"><div class="text-danger">获取状态失败: ' + escHtml(e.message) + '</div></div>';
  }
}

async function restartClient(clientId: string) {
  if (!confirm('确定重启 ' + clientId + '？')) return;

  try {
    await api(\`/api/clients/\${clientId}/pm2/restart\`, { method: 'POST' });
    toast('已发送重启命令', 'success');
    setTimeout(() => loadClients(), 2000);
  } catch (e) {
    toast(e.message, 'error');
  }
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return days + '天 ' + (hours % 24) + '小时';
  if (hours > 0) return hours + '小时 ' + (minutes % 60) + '分钟';
  if (minutes > 0) return minutes + '分钟';
  return seconds + '秒';
}

function switchTab(tab) {
  state.activeTab = tab;
  const c = state.selectedClient;
  if (c) renderClientDetail(c);
}

function backToList() {
  state.selectedClient = null;
  document.getElementById('client-detail-section').style.display = 'none';
  document.getElementById('client-list-section').style.display = 'block';
  loadClients();
}

async function reloadClientConfig(clientId) {
  try {
    await api('/api/clients/' + encodeURIComponent(clientId) + '/config/reload', { method: 'POST' });
    toast('已发送重载信号', 'success');
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ===== Render: Config Tab =====
function renderConfigTab(clientId) {
  const cfg = state.clientConfig;
  if (!cfg) return '<div class="empty-state">配置加载中...</div>';

  const convs = cfg.conversations || [];

  // === 可编辑的基本信息卡片 ===
  let html = '<div class="card">' +
    '<div class="flex-between"><div class="card-title" style="margin-bottom:0">基本信息</div>' +
    '<button class="btn btn-primary btn-sm" onclick="saveClientConfig(' + SQ + clientId + SQ + ')">💾 保存配置</button></div>' +
    '<div class="divider"></div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;font-size:13px;">' +
    '<div class="form-group"><label>Client 名称</label><input type="text" id="cfg-clientName" value="' + escHtml(cfg.clientName || '') + '"></div>' +
    '<div class="form-group"><label>Owner</label><input type="text" id="cfg-owner" value="' + escHtml(cfg.owner || '') + '"></div>' +
    '<div class="form-group"><label>默认模型</label><input type="text" id="cfg-model" value="' + escHtml(cfg.model || '') + '"></div>' +
    '<div class="form-group"><label>白名单 (逗号分隔)</label><input type="text" id="cfg-whiteUserList" value="' + escHtml((cfg.whiteUserList || []).join(',')) + '"></div>' +
    '<div class="form-group"><label>管理员列表 (逗号分隔)</label><input type="text" id="cfg-adminUserList" value="' + escHtml((cfg.adminUserList || []).join(',')) + '"></div>' +
    '<div class="form-group"><label>Owner 单聊会话ID</label><input type="text" id="cfg-ownerConvId" value="' + escHtml(cfg.ownerConversationId || '') + '"></div>' +
    '<div class="form-group"><label>前置命令 (preBash)</label><input type="text" id="cfg-preBash" value="' + escHtml(cfg.preBash || '') + '"></div>' +
    '<div class="form-group"><label>钉钉签名密钥</label><input type="text" id="cfg-dingSecret" value="" placeholder="留空不变"></div>' +
    '</div>' +
    '<div style="display:flex;gap:16px;margin-top:12px;flex-wrap:wrap;font-size:13px;">' +
    '<label><input type="checkbox" id="cfg-debug" ' + (cfg.debug ? 'checked' : '') + '> DEBUG</label>' +
    '<label><input type="checkbox" id="cfg-resultOnly" ' + (cfg.resultOnly !== false ? 'checked' : '') + '> 结果模式</label>' +
    '<label><input type="checkbox" id="cfg-includeThinking" ' + (cfg.includeThinking ? 'checked' : '') + '> 思考过程</label>' +
    '<label><input type="checkbox" id="cfg-enableMsgToUser" ' + (cfg.enableMsgToUser ? 'checked' : '') + '> 单聊消息</label>' +
    '</div>' +
    '<div class="form-row" style="margin-top:12px;">' +
    '<div class="form-group"><label>任务队列大小</label><input type="number" id="cfg-taskQueueSize" value="' + (cfg.taskQueueSize ?? 50) + '"></div>' +
    '<div class="form-group"><label>最大并发</label><input type="number" id="cfg-sessionMaxConcurrency" value="' + (cfg.sessionMaxConcurrency ?? 5) + '"></div>' +
    '<div class="form-group"><label>Watchdog 超时(分钟)</label><input type="number" id="cfg-maxTurnTimeMins" value="' + (cfg.maxTurnTimeMins ?? '') + '"></div>' +
    '<div class="form-group"><label>自动恢复次数</label><input type="number" id="cfg-maxAutoRecovery" value="' + (cfg.maxAutoRecovery ?? '') + '"></div>' +
    '</div>' +
    '<div class="form-row" style="margin-top:8px;">' +
    '<div class="form-group"><label>AI Card 模板 ID</label><input type="text" id="cfg-cardTemplateId" value="' + escHtml(cfg.cardTemplateId || '') + '"></div>' +
    '<div class="form-group"><label>AI Card 模板变量名</label><input type="text" id="cfg-cardTemplateKey" value="' + escHtml(cfg.cardTemplateKey || 'content') + '"></div>' +
    '</div></div>';

  // === A2A 配置 ===
  const a2a = cfg.a2aCfg || {};
  html += '<div class="card"><div class="card-title">A2A 配置</div>' +
    '<div class="form-row">' +
    '<div class="form-group"><label>Hub URL</label><input type="text" id="a2a-hubUrl" value="' + escHtml(a2a.hubUrl || '') + '"></div>' +
    '<div class="form-group"><label>API Key</label><input type="text" id="a2a-apiKey" value="" placeholder="留空不变"></div>' +
    '</div>' +
    '<div class="form-group"><label>远端 Agents (JSON 数组)</label>' +
    '<textarea id="a2a-remoteAgents" rows="4" style="width:100%;">' + escHtml(JSON.stringify(a2a.remoteAgents || [], null, 2)) + '</textarea></div></div>';

  // === 提示：会话配置已移至独立 tab ===
  html += '<div class="card"><div class="card-title">💡 提示</div>' +
    '<p class="text-muted" style="font-size:13px;">会话配置已移至「会话管理」Tab，请点击上方标签页进行管理。</p></div>';

  return html;
}

// ===== Render: Conversations Tab =====
function renderConvTab(clientId) {
  const cfg = state.clientConfig;
  if (!cfg) return '<div class="empty-state">配置加载中...</div>';

  const convs = cfg.conversations || [];
  let html = '<div class="flex-between mb-8">' +
    '<div class="card-title" style="margin-bottom:0">会话管理 (' + convs.length + ')</div>' +
    '<button class="btn btn-primary btn-sm" onclick="showAddConvModal(' + SQ + clientId + SQ + ')">➕ 注册会话</button></div>';

  if (convs.length === 0) {
    html += '<div class="card"><div class="empty-state"><div class="icon">💬</div><p>暂无会话配置</p>' +
      '<p class="text-muted">点击「➕ 注册会话」添加新会话</p></div></div>';
    return html;
  }

  html += '<div class="card"><div class="table-wrap"><table>' +
    '<thead><tr><th>会话</th><th>类型</th><th>QA</th><th>Streaming</th><th>Freedom</th><th>Model</th><th>Agent</th><th>权限</th><th>操作</th></tr></thead><tbody>';

  for (let i = 0; i < convs.length; i++) {
    const conv = convs[i];
    html += '<tr>' +
      '<td>' + escHtml(conv.conversationTitle || conv.conversationId) +
        (conv.workDir ? ' <span title="自定义工作目录: ' + escHtml(conv.workDir) + '">📁</span>' : '') +
        (conv.linkConversationId ? ' <span title="关联会话: ' + escHtml(conv.linkConversationId) + '">🔗</span>' : '') +
        '<br><span class="text-mono text-muted">' + escHtml(conv.conversationId) + '</span></td>' +
      '<td>' + (conv.conversationType === '2' ? '群聊' : '单聊') + '</td>' +
      '<td>' + (conv.qaMode ? '<span class="text-success">开</span>' : '<span class="text-muted">关</span>') + '</td>' +
      '<td>' + (conv.streaming ? '<span class="text-success">开</span>' : '<span class="text-muted">关</span>') + '</td>' +
      '<td>' + (conv.freedomMode ? '<span class="text-success">开</span>' : '<span class="text-muted">关</span>') + '</td>' +
      '<td class="text-mono">' + escHtml(conv.model || cfg.model || '-') + '</td>' +
      '<td class="text-mono">' + escHtml(conv.agent || 'claude') + '</td>' +
      '<td>' + (conv.permissionMode ? '<span class="text-mono">' + escHtml(conv.permissionMode) + '</span>' : '<span class="text-muted">默认</span>') + '</td>' +
      '<td style="white-space:nowrap;">' +
      '<button class="btn btn-sm" onclick="showEditConvModal(' + SQ + clientId + SQ + ',' + i + ')">编辑</button> ' +
      '<button class="btn btn-sm btn-danger" onclick="deleteConv(' + SQ + clientId + SQ + ',' + i + ')">删除</button></td></tr>';
  }

  html += '</tbody></table></div></div>';

  // === 白名单快速查看 ===
  const convsWithWhitelist = convs.filter(function(c) { return c.whiteUserList && c.whiteUserList.length > 0; });
  if (convsWithWhitelist.length > 0) {
    html += '<div class="card"><div class="card-title">会话白名单</div>';
    for (let i = 0; i < convsWithWhitelist.length; i++) {
      const c = convsWithWhitelist[i];
      html += '<div style="margin-bottom:8px;font-size:13px;">' +
        '<strong>' + escHtml(c.conversationTitle || c.conversationId) + '</strong>: ' +
        '<span class="text-mono">' + escHtml(c.whiteUserList.join(', ')) + '</span></div>';
    }
    html += '</div>';
  }

  return html;
}

// ===== Render: Keys Tab =====
function renderKeysTab(clientId) {
  const keys = state.apiKeys;
  const resetTime = state.apiKeysResetTime || '';
  const validCount = keys.filter(function(k) { return k.isValid; }).length;
  const invalidCount = keys.length - validCount;

  let html = '<div class="card"><div class="flex-between"><div class="card-title" style="margin-bottom:0;">API Key 池</div>';
  html += '<div style="display:flex;gap:8px;align-items:center;">';
  html += '<button class="btn btn-sm" onclick="deleteAllInvalidKeys(' + SQ + clientId + SQ + ')"' + (invalidCount === 0 ? ' disabled' : '') + '>清除无效 Key (' + invalidCount + ')</button>';
  html += '<button class="btn btn-sm" onclick="showApiKeyModal(' + SQ + clientId + SQ + ', -1)">+ 添加</button>';
  html += '</div></div>';
  html += '<div class="divider"></div>';

  if (keys.length === 0) {
    html += '<div class="empty-state" style="padding:24px 0;"><div class="icon">🔑</div><p>未配置 API Key</p></div>';
  } else {
    html += '<table><thead><tr><th>#</th><th>状态</th><th>Key</th><th>模型</th><th>小模型</th><th>Base URL</th><th>备注</th><th>操作</th></tr></thead><tbody>';
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var badgeClass = key.isValid ? 'status-online' : 'status-offline';
      var badgeText = key.isValid ? '有效' : '无效';
      var toggleText = key.isValid ? '禁用' : '启用';
      html += '<tr>';
      html += '<td>' + i + '</td>';
      html += '<td><span class="status-badge ' + badgeClass + '">' + badgeText + '</span></td>';
      html += '<td class="text-mono" title="' + escHtml(key.apiKey || '') + '">' + escHtml(key.apiKey || '-') + '</td>';
      html += '<td class="text-mono">' + escHtml(key.model || '-') + '</td>';
      html += '<td class="text-mono">' + escHtml(key.smallModel || '-') + '</td>';
      html += '<td class="text-mono" style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + escHtml(key.baseUrl || '') + '">' + escHtml(key.baseUrl || '-') + '</td>';
      html += '<td>' + escHtml(key.memo || '-') + '</td>';
      html += '<td style="white-space:nowrap;">';
      html += '<button class="btn btn-sm" onclick="toggleApiKey(' + SQ + clientId + SQ + ',' + i + ')">' + toggleText + '</button> ';
      html += '<button class="btn btn-sm" onclick="showApiKeyModal(' + SQ + clientId + SQ + ',' + i + ')">编辑</button> ';
      html += '<button class="btn btn-sm btn-danger" onclick="deleteKey(' + SQ + clientId + SQ + ',' + i + ')">删除</button>';
      html += '</td>';
      html += '</tr>';
    }
    html += '</tbody></table>';
  }

  html += '<div class="divider"></div>';
  html += '<div class="flex-between"><span class="text-muted text-mono">上次重置: ' + (resetTime || '-') + ' · 有效 ' + validCount + '/' + keys.length + '</span>';
  html += '<button class="btn btn-sm" onclick="resetAllKeys(' + SQ + clientId + SQ + ')"' + (keys.length === 0 ? ' disabled' : '') + '>一键重置所有 Key</button></div>';
  html += '</div>';
  return html;
}

// ===== Shared Modal Helper =====
function showModal(id, title, bodyHtml, focusId) {
  var overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = id;
  overlay.onclick = function(e) { if (e.target === overlay) overlay.remove(); };
  overlay.innerHTML = '<div class="modal">' +
    '<div class="modal-title">' + title + '</div>' +
    bodyHtml + '</div>';
  document.body.appendChild(overlay);
  if (focusId) document.getElementById(focusId).focus();
  return overlay;
}

// ===== Shared Env Patch Helper =====
async function patchEnvs(clientId, envs) {
  await api('/api/clients/' + encodeURIComponent(clientId) + '/config', {
    method: 'PATCH',
    body: JSON.stringify({ envs: envs }),
  });
  await loadClientConfig(clientId);
  renderClientDetail(clientId);
}

// ===== Shared Global Config Persist Helper =====
async function persistGlobalConfig() {
  const gc = state.globalConfig;
  await api('/api/global/config', {
    method: 'PUT',
    body: JSON.stringify({ port: gc.port, host: gc.host, remoteConsoles: gc.remoteConsoles || [] }),
  });
  state.globalConfig = gc;
  renderGlobalSection();
}

function showApiKeyModal(clientId, index) {
  var isEdit = index >= 0;
  var key = isEdit ? (state.apiKeys[index] || {}) : {};

  var bodyHtml = '<div class="form-row">' +
    '<div class="form-group" style="flex:2;"><label>API Key' + (isEdit ? ' (留空保持不变)' : ' *') + '</label><input type="text" id="ak-apiKey" value="' + escHtml(isEdit ? key.apiKey || '' : '') + '" placeholder="sk-ant-... 或 $ENV:VAR_NAME"></div>' +
    '<div class="form-group" style="flex:1;"><label>状态</label><select id="ak-isValid"><option value="true"' + (!isEdit || key.isValid ? ' selected' : '') + '>有效</option><option value="false"' + (isEdit && !key.isValid ? ' selected' : '') + '>无效</option></select></div>' +
    '</div>' +
    '<div class="form-group"><label>Base URL *</label><input type="text" id="ak-baseUrl" value="' + escHtml(key.baseUrl || 'https://api.anthropic.com') + '" placeholder="https://api.anthropic.com"></div>' +
    '<div class="form-row">' +
    '<div class="form-group"><label>模型 *</label><input type="text" id="ak-model" value="' + escHtml(key.model || 'claude-3-opus-latest') + '"></div>' +
    '<div class="form-group"><label>小模型 (可选)</label><input type="text" id="ak-smallModel" value="' + escHtml(key.smallModel || '') + '" placeholder="claude-haiku-4-5-20251001"></div>' +
    '</div>' +
    '<div class="form-group"><label>备注</label><input type="text" id="ak-memo" value="' + escHtml(key.memo || '') + '" placeholder="标签/说明"></div>' +
    '<div class="modal-actions">' +
    '<button class="btn" onclick="document.getElementById(' + SQ + 'apikey-modal' + SQ + ').remove()">取消</button>' +
    '<button class="btn btn-primary" onclick="doSaveApiKey(' + SQ + clientId + SQ + ',' + index + ')">' + (isEdit ? '保存' : '添加') + '</button>' +
    '</div>';
  showModal('apikey-modal', isEdit ? '编辑 API Key' : '添加 API Key', bodyHtml, 'ak-apiKey');
}

async function doSaveApiKey(clientId, index) {
  var isEdit = index >= 0;
  var apiKey = document.getElementById('ak-apiKey').value.trim();
  var baseUrl = document.getElementById('ak-baseUrl').value.trim();
  var model = document.getElementById('ak-model').value.trim();
  if (!isEdit && !apiKey) { toast('请填写 API Key', 'error'); return; }
  if (!baseUrl) { toast('请填写 Base URL', 'error'); return; }
  if (!model) { toast('请填写模型', 'error'); return; }
  var smallModel = document.getElementById('ak-smallModel').value.trim() || undefined;
  var memo = document.getElementById('ak-memo').value.trim() || undefined;
  var isValid = document.getElementById('ak-isValid').value === 'true';

  var payload = { baseUrl: baseUrl, model: model, smallModel: smallModel, memo: memo, isValid: isValid };
  // 编辑时：apiKey 为掩码值则跳过，避免把掩码存回配置
  if (isEdit) {
    var origKey = (state.apiKeys[index] || {}).apiKey || '';
    if (apiKey && apiKey !== origKey && apiKey.indexOf('****') === -1) {
      payload.apiKey = apiKey;
    }
  } else {
    payload.apiKey = apiKey;
  }
  try {
    if (isEdit) {
      await api('/api/clients/' + encodeURIComponent(clientId) + '/apikeys/' + index, { method: 'PUT', body: JSON.stringify(payload) });
      toast('已更新', 'success');
    } else {
      await api('/api/clients/' + encodeURIComponent(clientId) + '/apikeys', { method: 'POST', body: JSON.stringify(payload) });
      toast('已添加', 'success');
    }
    document.getElementById('apikey-modal').remove();
    await loadClientApiKeys(clientId);
    var c = state.selectedClient; if (c) renderClientDetail(c);
  } catch (e) { toast(e.message, 'error'); }
}

async function toggleApiKey(clientId, index) {
  var key = state.apiKeys[index];
  if (!key) return;
  try {
    await api('/api/clients/' + encodeURIComponent(clientId) + '/apikeys/' + index, {
      method: 'PUT', body: JSON.stringify({ isValid: !key.isValid })
    });
    await loadClientApiKeys(clientId);
    var c = state.selectedClient; if (c) renderClientDetail(c);
  } catch (e) { toast(e.message, 'error'); }
}

async function resetAllKeys(clientId) {
  if (!confirm('确定要重置所有 API Key 为有效状态吗？')) return;
  try {
    await api('/api/clients/' + encodeURIComponent(clientId) + '/apikeys/reset', { method: 'POST' });
    toast('已重置', 'success');
    await loadClientApiKeys(clientId);
    var c = state.selectedClient; if (c) renderClientDetail(c);
  } catch (e) { toast(e.message, 'error'); }
}

async function deleteKey(clientId, index) {
  if (!confirm('确定删除此 API Key？')) return;
  try {
    await api('/api/clients/' + encodeURIComponent(clientId) + '/apikeys/' + index, { method: 'DELETE' });
    toast('已删除', 'success');
    await loadClientApiKeys(clientId);
    var c = state.selectedClient; if (c) renderClientDetail(c);
  } catch (e) { toast(e.message, 'error'); }
}

async function deleteAllInvalidKeys(clientId) {
  var invalidIndices = [];
  for (var i = state.apiKeys.length - 1; i >= 0; i--) {
    if (!state.apiKeys[i].isValid) invalidIndices.push(i);
  }
  if (invalidIndices.length === 0) { toast('没有无效的 Key', 'info'); return; }
  if (!confirm('确定删除所有 ' + invalidIndices.length + ' 个无效 Key？')) return;
  try {
    for (var j = 0; j < invalidIndices.length; j++) {
      await api('/api/clients/' + encodeURIComponent(clientId) + '/apikeys/' + invalidIndices[j], { method: 'DELETE' });
    }
    toast('已删除 ' + invalidIndices.length + ' 个无效 Key', 'success');
    await loadClientApiKeys(clientId);
    var c = state.selectedClient; if (c) renderClientDetail(c);
  } catch (e) { toast(e.message, 'error'); }
}

// ===== Save Client Config (top-level fields) =====
async function saveClientConfig(clientId) {
  var patches = {};
  var v;

  v = document.getElementById('cfg-clientName').value.trim();
  if (v) patches['clientName'] = v;
  v = document.getElementById('cfg-owner').value.trim();
  if (v) patches['owner'] = v;
  v = document.getElementById('cfg-model').value.trim();
  patches['model'] = v || undefined;
  v = document.getElementById('cfg-preBash').value.trim();
  patches['preBash'] = v || undefined;
  v = document.getElementById('cfg-ownerConvId').value.trim();
  patches['ownerConversationId'] = v || undefined;
  v = document.getElementById('cfg-cardTemplateId').value.trim();
  patches['cardTemplateId'] = v || undefined;
  v = document.getElementById('cfg-cardTemplateKey').value.trim();
  patches['cardTemplateKey'] = v || 'content';

  // Array fields
  patches['whiteUserList'] = document.getElementById('cfg-whiteUserList').value.split(',').map(function(s) { return s.trim(); }).filter(Boolean);
  patches['adminUserList'] = document.getElementById('cfg-adminUserList').value.split(',').map(function(s) { return s.trim(); }).filter(Boolean);

  // Number fields
  patches['taskQueueSize'] = parseInt(document.getElementById('cfg-taskQueueSize').value) || 50;
  patches['sessionMaxConcurrency'] = parseInt(document.getElementById('cfg-sessionMaxConcurrency').value) || 5;
  v = document.getElementById('cfg-maxTurnTimeMins').value;
  if (v) patches['maxTurnTimeMins'] = parseInt(v) || undefined;
  v = document.getElementById('cfg-maxAutoRecovery').value;
  if (v) patches['maxAutoRecovery'] = parseInt(v) || undefined;

  // Booleans
  patches['debug'] = document.getElementById('cfg-debug').checked;
  patches['resultOnly'] = document.getElementById('cfg-resultOnly').checked;
  patches['includeThinking'] = document.getElementById('cfg-includeThinking').checked;
  patches['enableMsgToUser'] = document.getElementById('cfg-enableMsgToUser').checked;

  // dingSecret (only if user entered a new value)
  v = document.getElementById('cfg-dingSecret').value.trim();
  if (v && v.indexOf('****') !== 0) patches['dingSecret'] = v;

  // a2aCfg
  var a2aCfg = {};
  var hubUrl = document.getElementById('a2a-hubUrl').value.trim();
  if (hubUrl) a2aCfg.hubUrl = hubUrl;
  var a2aKey = document.getElementById('a2a-apiKey').value.trim();
  if (a2aKey) a2aCfg.apiKey = a2aKey;
  try {
    var ra = JSON.parse(document.getElementById('a2a-remoteAgents').value || '[]');
    if (Array.isArray(ra)) a2aCfg.remoteAgents = ra;
  } catch(e) { /* ignore */ }
  if (Object.keys(a2aCfg).length > 0) patches['a2aCfg'] = a2aCfg;

  try {
    await api('/api/clients/' + encodeURIComponent(clientId) + '/config', {
      method: 'PATCH',
      body: JSON.stringify(patches),
    });
    toast('配置已保存', 'success');
    await loadClientConfig(clientId);
    renderClientDetail(clientId);
  } catch (e) { toast(e.message, 'error'); }
}

// ===== Conversation Modal =====
function showAddConvModal(clientId) {
  showConversationModal(null, clientId, '注册会话');
}

function showEditConvModal(clientId, index) {
  var conv = state.clientConfig.conversations[index];
  showConversationModal(conv, clientId, '编辑会话');
}

function showConversationModal(conv, clientId, title) {
  var c = conv || {};
  var overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'conv-modal';
  overlay.onclick = function(e) { if (e.target === overlay) overlay.remove(); };

  var isEdit = conv !== null;
  var readonlyAttr = isEdit ? 'readonly' : '';
  var titleAttr = isEdit ? '保存' : '创建';

  overlay.innerHTML = '<div class="modal" style="max-width:700px;">' +
    '<div class="modal-title">' + title + '</div>' +
    '<div class="form-row">' +
    '<div class="form-group"><label>会话ID *</label><input type="text" id="cm-convId" value="' + escHtml(c.conversationId || '') + '" ' + readonlyAttr + '></div>' +
    '<div class="form-group"><label>类型 *</label><select id="cm-convType"><option value="1"' + (c.conversationType === '1' ? ' selected' : '') + '>单聊</option><option value="2"' + (c.conversationType === '2' ? ' selected' : '') + '>群聊</option></select></div>' +
    '</div>' +
    '<div class="form-group"><label>会话标题</label><input type="text" id="cm-title" value="' + escHtml(c.conversationTitle || '') + '"></div>' +
    '<div class="form-row">' +
    '<div class="form-group"><label>Ding Token</label><input type="text" id="cm-dingToken" value="' + escHtml(c.dingToken || '') + '"></div>' +
    '<div class="form-group"><label>模型</label><input type="text" id="cm-model" value="' + escHtml(c.model || state.clientConfig.model || '') + '"></div>' +
    '</div>' +
    '<div class="form-row">' +
    '<div class="form-group"><label>白名单 (逗号分隔)</label><input type="text" id="cm-whiteList" value="' + escHtml((c.whiteUserList || []).join(',')) + '"></div>' +
    '<div class="form-group"><label>关联会话ID</label><input type="text" id="cm-linkConv" value="' + escHtml(c.linkConversationId || '') + '"></div>' +
    '</div>' +
    '<div class="form-group"><label>自定义工作目录 (绝对路径)</label><input type="text" id="cm-workDir" value="' + escHtml(c.workDir || '') + '" placeholder="留空使用默认目录"></div>' +
    '<div class="form-row">' +
    '<div class="form-group"><label>Agent</label><input type="text" id="cm-agent" value="' + escHtml(c.agent || '') + '"></div>' +
    '<div class="form-group"><label>前置命令 (preBash)</label><input type="text" id="cm-preBash" value="' + escHtml(c.preBash || '') + '"></div>' +
    '</div>' +
    '<div class="form-row">' +
    '<div class="form-group"><label>权限模式</label><select id="cm-permMode"><option value="">默认</option><option value="acceptEdits"' + (c.permissionMode === 'acceptEdits' ? ' selected' : '') + '>acceptEdits</option><option value="bypassPermissions"' + (c.permissionMode === 'bypassPermissions' ? ' selected' : '') + '>bypassPermissions</option><option value="plan"' + (c.permissionMode === 'plan' ? ' selected' : '') + '>plan</option><option value="auto"' + (c.permissionMode === 'auto' ? ' selected' : '') + '>auto</option><option value="dontAsk"' + (c.permissionMode === 'dontAsk' ? ' selected' : '') + '>dontAsk</option></select></div>' +
    '<div class="form-group"><label>确认模式</label><select id="cm-ackMode"><option value="reaction"' + (c.receiveReplyMode === 'text' ? '' : ' selected') + '>表情</option><option value="text"' + (c.receiveReplyMode === 'text' ? ' selected' : '') + '>文本</option></select></div>' +
    '</div>' +
    '<div class="form-row">' +
    '<div class="form-group"><label>确认表情</label><input type="text" id="cm-ackEmoji" value="' + escHtml(c.ackReaction || '👀') + '" style="width:80px;"></div>' +
    '<div class="form-group"><label>最大轮次时间(分钟)</label><input type="number" id="cm-maxTurn" value="' + (c.maxTurnTimeMins || '') + '"></div>' +
    '</div>' +
    '<div class="form-group"><label>任务技能 (taskCfg.skill)</label><input type="text" id="cm-taskSkill" value="' + escHtml((c.taskCfg && c.taskCfg.skill) || '') + '"></div>' +
    '<div style="display:flex;gap:16px;margin-top:8px;flex-wrap:wrap;font-size:13px;">' +
    '<label><input type="checkbox" id="cm-qaMode"' + (c.qaMode ? ' checked' : '') + '> 问答模式</label>' +
    '<label><input type="checkbox" id="cm-freedomMode"' + (c.freedomMode ? ' checked' : '') + '> 自由模式</label>' +
    '<label><input type="checkbox" id="cm-streaming"' + (c.streaming ? ' checked' : '') + '> 流式输出</label>' +
    '<label><input type="checkbox" id="cm-atSender"' + (c.atSender !== false ? ' checked' : '') + '> 回复@发送人</label>' +
    '<label><input type="checkbox" id="cm-receiveReply"' + (c.receiveReply !== false ? ' checked' : '') + '> 回复确认</label>' +
    '<label><input type="checkbox" id="cm-ensureAt"' + (c.ensureAt ? ' checked' : '') + '> 追加@通知</label>' +
    '<label><input type="checkbox" id="cm-localOcr"' + (c.useLocalOcr !== false ? ' checked' : '') + '> 本地OCR</label>' +
    '</div>' +
    '<div class="modal-actions">' +
    '<button class="btn" onclick="document.getElementById(' + SQ + 'conv-modal' + SQ + ').remove()">取消</button>' +
    '<button class="btn btn-primary" onclick="doSaveConversation(' + SQ + clientId + SQ + ',' + (isEdit ? 'true' : 'false') + ')">' + titleAttr + '</button>' +
    '</div></div>';
  document.body.appendChild(overlay);
}

async function doSaveConversation(clientId, isEdit) {
  var convId = document.getElementById('cm-convId').value.trim();
  if (!convId) { toast('请填写会话ID', 'error'); return; }

  var payload = {
    conversationId: convId,
    conversationType: document.getElementById('cm-convType').value,
    conversationTitle: document.getElementById('cm-title').value.trim() || undefined,
    dingToken: document.getElementById('cm-dingToken').value.trim() || undefined,
    model: document.getElementById('cm-model').value.trim() || undefined,
    whiteUserList: document.getElementById('cm-whiteList').value.trim(),
    linkConversationId: document.getElementById('cm-linkConv').value.trim() || undefined,
    workDir: document.getElementById('cm-workDir').value.trim() || undefined,
    agent: document.getElementById('cm-agent').value.trim() || undefined,
    preBash: document.getElementById('cm-preBash').value.trim() || undefined,
    permissionMode: document.getElementById('cm-permMode').value || undefined,
    receiveReplyMode: document.getElementById('cm-ackMode').value,
    ackReaction: document.getElementById('cm-ackEmoji').value.trim() || undefined,
    maxTurnTimeMins: parseInt(document.getElementById('cm-maxTurn').value) || undefined,
    taskCfg: { skill: document.getElementById('cm-taskSkill').value.trim() || undefined },
    qaMode: document.getElementById('cm-qaMode').checked,
    freedomMode: document.getElementById('cm-freedomMode').checked,
    streaming: document.getElementById('cm-streaming').checked,
    atSender: document.getElementById('cm-atSender').checked,
    receiveReply: document.getElementById('cm-receiveReply').checked,
    ensureAt: document.getElementById('cm-ensureAt').checked,
    useLocalOcr: document.getElementById('cm-localOcr').checked,
  };

  // Clean up empty taskCfg
  if (!payload.taskCfg.skill) delete payload.taskCfg;
  // Clean up empty strings to undefined
  Object.keys(payload).forEach(function(k) {
    if (payload[k] === '' && k !== 'receiveReplyMode') payload[k] = undefined;
  });

  try {
    if (isEdit) {
      await api('/api/clients/' + encodeURIComponent(clientId) + '/conversations/' + encodeURIComponent(convId), {
        method: 'PUT', body: JSON.stringify(payload)
      });
    } else {
      await api('/api/clients/' + encodeURIComponent(clientId) + '/conversations', {
        method: 'POST', body: JSON.stringify(payload)
      });
    }
    var modal = document.getElementById('conv-modal');
    if (modal) modal.remove();
    toast(isEdit ? '会话已更新' : '会话已创建', 'success');
    await loadClientConfig(clientId);
    renderClientDetail(clientId);
  } catch (e) { toast(e.message, 'error'); }
}

async function deleteConv(clientId, index) {
  var conv = state.clientConfig.conversations[index];
  if (!confirm('确定删除会话 "' + (conv.conversationTitle || conv.conversationId) + '"？')) return;
  try {
    await api('/api/clients/' + encodeURIComponent(clientId) + '/conversations/' + encodeURIComponent(conv.conversationId), {
      method: 'DELETE'
    });
    toast('会话已删除', 'success');
    await loadClientConfig(clientId);
    renderClientDetail(clientId);
  } catch (e) { toast(e.message, 'error'); }
}

// ===== Render: Files Tab =====
function renderFilesTab(clientId) {
  const fileNames = ['menu.json', 'model.json', 'cron.json', 'todo.json', 'user-map.json', 'active.json'];
  let html = '<div class="card"><div class="card-title">客户端文件管理</div>';
  html += '<div class="form-group"><label>选择文件</label><select id="file-select" onchange="loadFile(' + SQ + clientId + SQ + ')">';
  html += '<option value="">-- 选择文件 --</option>';
  for (const f of fileNames) {
    html += '<option value="' + f + '">' + f + '</option>';
  }
  html += '</select></div>';
  html += '<div id="file-content-area" style="display:none;"><textarea id="file-editor" rows="12" style="width:100%;"></textarea><div class="form-actions"><button class="btn btn-primary" onclick="saveFile(' + SQ + clientId + SQ + ')">💾 保存</button></div></div>';
  html += '</div>';
  return html;
}

async function loadFile(clientId) {
  const name = document.getElementById('file-select').value;
  if (!name) { document.getElementById('file-content-area').style.display = 'none'; return; }
  try {
    const data = await api('/api/clients/' + encodeURIComponent(clientId) + '/files?name=' + encodeURIComponent(name));
    document.getElementById('file-editor').value = data.content || '';
    document.getElementById('file-content-area').style.display = 'block';
  } catch (e) {
    toast(e.message, 'error');
    document.getElementById('file-content-area').style.display = 'none';
  }
}

async function saveFile(clientId) {
  const name = document.getElementById('file-select').value;
  const content = document.getElementById('file-editor').value;
  try {
    await api('/api/clients/' + encodeURIComponent(clientId) + '/files?name=' + encodeURIComponent(name), { method: 'PUT', body: JSON.stringify({ content }) });
    toast('文件已保存', 'success');
  } catch (e) { toast(e.message, 'error'); }
}

// ===== Render: Env Tab =====
function renderEnvTab(clientId) {
  const cfg = state.clientConfig;
  if (!cfg) return '<div class="empty-state">配置加载中...</div>';

  // 提取所有 $ENV: 引用
  const envRefs = new Set();
  function scanEnvRefs(obj) {
    if (typeof obj === 'string' && obj.startsWith('$ENV:')) {
      envRefs.add(obj.substring(5));
    } else if (Array.isArray(obj)) {
      for (const item of obj) scanEnvRefs(item);
    } else if (obj && typeof obj === 'object') {
      for (const val of Object.values(obj)) scanEnvRefs(val);
    }
  }
  scanEnvRefs(cfg);

  const existingEnvs = cfg.envs || {};
  const envKeys = Object.keys(existingEnvs).sort();

  let html = '<div class="card">' +
    '<div class="flex-between"><div class="card-title" style="margin-bottom:0">环境变量 (' + envKeys.length + ')</div>' +
    '<button class="btn btn-primary btn-sm" onclick="showAddEnvModal(' + SQ + clientId + SQ + ')">+ 添加</button></div>' +
    '<div class="divider"></div>' +
    '<p class="text-muted mb-8" style="font-size:13px;">配置中使用 $ENV:VAR 语法引用环境变量。🔗 表示被引用</p>';

  if (envKeys.length === 0) {
    html += '<div class="empty-state" style="padding:24px 0;"><div class="icon">🌿</div><p>未配置环境变量</p></div>';
  } else {
    html += '<table><thead><tr><th>变量名</th><th>状态</th><th>值</th><th>操作</th></tr></thead><tbody>';
    for (const key of envKeys) {
      const val = existingEnvs[key];
      const isUsed = envRefs.has(key);
      html += '<tr>';
      html += '<td class="text-mono">' + escHtml(key) + '</td>';
      html += '<td>' + (isUsed ? '<span class="status-badge status-online">被引用</span>' : '<span class="text-muted">未引用</span>') + '</td>';
      html += '<td class="text-mono" style="max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + escHtml(val) + '">' + escHtml(val) + '</td>';
      html += '<td style="white-space:nowrap;">';
      html += '<button class="btn btn-sm" onclick="showEditEnvModal(' + SQ + clientId + SQ + ',' + SQ + key + SQ + ')">编辑</button> ';
      html += '<button class="btn btn-sm btn-danger" onclick="deleteEnv(' + SQ + clientId + SQ + ',' + SQ + key + SQ + ')">删除</button>';
      html += '</td>';
      html += '</tr>';
    }
    html += '</tbody></table>';
  }
  html += '</div>';
  return html;
}

function showAddEnvModal(clientId) {
  var datalistHtml = '<datalist id="env-key-suggestions">';
  for (var i = 0; i < COMMON_ENV_VARS.length; i++) {
    datalistHtml += '<option value="' + COMMON_ENV_VARS[i].key + '" label="' + COMMON_ENV_VARS[i].desc + '"></option>';
  }
  datalistHtml += '</datalist>';

  var bodyHtml = '<div class="form-group"><label>变量名 *</label><input type="text" id="env-key" list="env-key-suggestions" placeholder="输入或选择常用变量">' + datalistHtml + '</div>' +
    '<div class="form-group"><label>值 *</label><input type="text" id="env-val" placeholder="变量值"></div>' +
    '<div class="modal-actions">' +
    '<button class="btn" onclick="document.getElementById(' + SQ + 'env-modal' + SQ + ').remove()">取消</button>' +
    '<button class="btn btn-primary" onclick="doSaveEnv(' + SQ + clientId + SQ + ', null)">添加</button>' +
    '</div>';
  showModal('env-modal', '添加环境变量', bodyHtml, 'env-key');
}

function showEditEnvModal(clientId, key) {
  var cfg = state.clientConfig;
  if (!cfg || !cfg.envs || !cfg.envs.hasOwnProperty(key)) return;

  var bodyHtml = '<div class="form-group"><label>变量名</label><input type="text" id="env-key" value="' + escHtml(key) + '" readonly></div>' +
    '<div class="form-group"><label>值 *</label><input type="text" id="env-val" value="' + escHtml(cfg.envs[key]) + '"></div>' +
    '<div class="modal-actions">' +
    '<button class="btn" onclick="document.getElementById(' + SQ + 'env-modal' + SQ + ').remove()">取消</button>' +
    '<button class="btn btn-primary" onclick="doSaveEnv(' + SQ + clientId + SQ + ',' + SQ + key + SQ + ')">保存</button>' +
    '</div>';
  showModal('env-modal', '编辑环境变量', bodyHtml, 'env-val');
}

async function doSaveEnv(clientId, origKey) {
  var isEdit = origKey !== null;
  var key = document.getElementById('env-key').value.trim();
  var val = document.getElementById('env-val').value;
  if (!key) { toast('请填写变量名', 'error'); return; }

  var cfg = state.clientConfig;
  var envs = Object.assign({}, cfg.envs || {});

  if (!isEdit && envs.hasOwnProperty(key)) { toast('变量名已存在', 'error'); return; }
  envs[key] = val;

  try {
    await patchEnvs(clientId, envs);
    toast(isEdit ? '已更新' : '已添加', 'success');
    document.getElementById('env-modal').remove();
  } catch (e) { toast(e.message, 'error'); }
}

async function deleteEnv(clientId, key) {
  if (!confirm('确定删除环境变量 ' + key + '？')) return;
  var cfg = state.clientConfig;
  var envs = Object.assign({}, cfg.envs || {});
  delete envs[key];

  try {
    await patchEnvs(clientId, envs);
    toast('已删除', 'success');
  } catch (e) { toast(e.message, 'error'); }
}

// ===== Render: Raw JSON Tab =====
function renderRawTab(clientId) {
  return '<div class="card">' +
    '<div class="flex-between">' +
    '<div class="card-title" style="margin-bottom:0;">原始 JSON 编辑</div>' +
    '<div style="display:flex;gap:8px;">' +
    '<button class="btn btn-sm" onclick="loadRawConfig(' + "'" + clientId + "'" + ')">🔄 刷新</button>' +
    '<button class="btn btn-sm btn-primary" onclick="saveRawConfig(' + "'" + clientId + "'" + ')">💾 保存</button>' +
    '</div>' +
    '</div>' +
    '<div class="divider"></div>' +
    '<textarea id="raw-editor" rows="20" style="width:100%;font-size:13px;">' + escHtml(state.rawConfig) + '</textarea>' +
    '</div>';
}

async function saveRawConfig(clientId) {
  const content = document.getElementById('raw-editor').value;
  try {
    JSON.parse(content); // 验证
    await api('/api/clients/' + encodeURIComponent(clientId) + '/config/raw', { method: 'PUT', body: JSON.stringify({ content }) });
    toast('原始配置已保存', 'success');
  } catch (e) {
    if (e instanceof SyntaxError) toast('JSON 格式错误', 'error');
    else toast(e.message, 'error');
  }
}

// ===== Render: Global Config =====
async function loadGlobalConfig() {
  try {
    const data = await api('/api/global/config');
    state.globalConfig = data.config;
    renderGlobalSection();
  } catch (e) {
    toast(e.message, 'error');
  }
}

function renderGlobalSection() {
  document.getElementById('client-list-section').style.display = 'none';
  document.getElementById('client-detail-section').style.display = 'none';
  document.getElementById('status-section').style.display = 'none';
  const section = document.getElementById('global-section');
  section.style.display = 'block';

  const gc = state.globalConfig;
  const remoteConsoles = gc.remoteConsoles || [];

  let remoteHtml = '';
  if (remoteConsoles.length === 0) {
    remoteHtml = '<div class="text-muted" style="padding:16px 0;">暂无远程 Console</div>';
  } else {
    remoteHtml = '<table><thead><tr><th>地址</th><th>Client IDs</th><th>操作</th></tr></thead><tbody>';
    for (let i = 0; i < remoteConsoles.length; i++) {
      const rc = remoteConsoles[i];
      remoteHtml += '<tr>' +
        '<td class="text-mono">' + escHtml(rc.url) + '</td>' +
        '<td class="text-mono" style="max-width:300px;overflow:hidden;text-overflow:ellipsis;">' + escHtml(rc.clientIds.join(', ')) + '</td>' +
        '<td style="white-space:nowrap;">' +
        '<button class="btn btn-sm" onclick="editRemoteConsole(' + i + ')">编辑</button> ' +
        '<button class="btn btn-sm btn-danger" onclick="deleteRemoteConsole(' + i + ')">删除</button>' +
        '</td></tr>';
    }
    remoteHtml += '</tbody></table>';
  }

  section.innerHTML = \`
    <div class="flex-between mb-8">
      <button class="btn btn-sm" onclick="showClientList()">← 返回</button>
      <span class="client-name">🌐 全局配置</span>
    </div>
    <div class="card">
      <div class="card-title">Console 配置</div>
      <div class="form-row">
        <div class="form-group"><label>端口</label><input type="number" id="gc-port" value="\${gc.port || 8080}"></div>
        <div class="form-group"><label>Host</label><input type="text" id="gc-host" value="\${gc.host || '0.0.0.0'}"></div>
      </div>
      <div class="form-actions"><button class="btn btn-primary" onclick="saveGlobalConfig()">💾 保存</button></div>
    </div>
    <div class="card">
      <div class="flex-between">
        <div class="card-title" style="margin-bottom:0">远程 Console 管理</div>
        <button class="btn btn-sm btn-primary" onclick="showAddRemoteConsole()">+ 添加</button>
      </div>
      <div class="divider"></div>
      \${remoteHtml}
    </div>
    <div class="card">
      <div class="card-title">settings-tpl.json</div>
      <textarea id="settings-tpl-editor" rows="12" style="width:100%;">\${escHtml(state.settingsTpl)}</textarea>
      <div class="form-actions"><button class="btn btn-sm" onclick="loadSettingsTpl()">🔄 刷新</button><button class="btn btn-primary" onclick="saveSettingsTpl()">💾 保存</button></div>
    </div>
  \`;
  loadSettingsTpl();
}

function showAddRemoteConsole() {
  showRemoteConsoleModal(null, -1);
}

function editRemoteConsole(index: number) {
  const rc = (state.globalConfig.remoteConsoles || [])[index];
  showRemoteConsoleModal(rc, index);
}

function showRemoteConsoleModal(rc: any, index: number) {
  const isEdit = index >= 0;
  const bodyHtml = \`
      <div class="form-group">
        <label>Console 地址 *</label>
        <input type="text" id="rc-url" value="\${isEdit ? escHtml(rc.url) : 'http://'}" placeholder="http://192.168.1.100:8080">
      </div>
      <div class="form-group">
        <label>API Token *</label>
        <input type="text" id="rc-token" value="\${isEdit ? escHtml(rc.token) : ''}" placeholder="Bearer Token">
      </div>
      <div class="form-group">
        <label>Client IDs (逗号分隔) *</label>
        <input type="text" id="rc-clientIds" value="\${isEdit ? escHtml(rc.clientIds.join(', ')) : ''}" placeholder="client-a, client-b">
      </div>
      <div class="modal-actions">
        <button class="btn" onclick="document.getElementById('remote-console-modal').remove()">取消</button>
        <button class="btn btn-primary" onclick="saveRemoteConsole(\${index})">\${isEdit ? '保存' : '添加'}</button>
      </div>
  \`;
  showModal('remote-console-modal', isEdit ? '编辑远程 Console' : '添加远程 Console', bodyHtml, 'rc-url');
}

async function saveRemoteConsole(index: number) {
  const url = document.getElementById('rc-url').value.trim();
  const token = document.getElementById('rc-token').value.trim();
  const clientIdsStr = document.getElementById('rc-clientIds').value.trim();

  if (!url || !token || !clientIdsStr) {
    toast('请填写所有必填字段', 'error');
    return;
  }

  const clientIds = clientIdsStr.split(',').map(s => s.trim()).filter(Boolean);
  const remoteConsole = { url, token, clientIds };

  try {
    const gc = state.globalConfig;
    if (!gc.remoteConsoles) gc.remoteConsoles = [];

    if (index >= 0) {
      gc.remoteConsoles[index] = remoteConsole;
    } else {
      gc.remoteConsoles.push(remoteConsole);
    }

    await persistGlobalConfig();
    document.getElementById('remote-console-modal').remove();
    toast(index >= 0 ? '远程 Console 已更新' : '远程 Console 已添加', 'success');
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function deleteRemoteConsole(index: number) {
  if (!confirm('确定删除此远程 Console？')) return;

  try {
    const gc = state.globalConfig;
    gc.remoteConsoles.splice(index, 1);

    await persistGlobalConfig();
    toast('远程 Console 已删除', 'success');
  } catch (e) {
    toast(e.message, 'error');
  }
}

function showClientList() {
  document.getElementById('global-section').style.display = 'none';
  document.getElementById('status-section').style.display = 'none';
  document.getElementById('client-detail-section').style.display = 'none';
  document.getElementById('client-list-section').style.display = 'block';
}

async function saveGlobalConfig() {
  const port = parseInt(document.getElementById('gc-port').value, 10);
  const host = document.getElementById('gc-host').value.trim();
  const gc = state.globalConfig;
  gc.port = port;
  gc.host = host;
  try {
    await persistGlobalConfig();
    toast('全局配置已保存', 'success');
  } catch (e) { toast(e.message, 'error'); }
}

async function loadSettingsTpl() {
  try {
    const data = await api('/api/global/settings-tpl');
    state.settingsTpl = data.content || '';
    const editor = document.getElementById('settings-tpl-editor');
    if (editor) editor.value = state.settingsTpl;
  } catch (e) { toast(e.message, 'error'); }
}

async function saveSettingsTpl() {
  const content = document.getElementById('settings-tpl-editor').value;
  try {
    JSON.parse(content);
    await api('/api/global/settings-tpl', { method: 'PUT', body: JSON.stringify({ content }) });
    toast('settings-tpl.json 已保存', 'success');
  } catch (e) {
    if (e instanceof SyntaxError) toast('JSON 格式错误', 'error');
    else toast(e.message, 'error');
  }
}

// ===== Render: Status =====
async function loadStatus() {
  try {
    const data = await api('/api/status');
    state.status = data.status;
    renderStatusSection();
  } catch (e) {
    toast(e.message, 'error');
  }
}

function renderStatusSection() {
  document.getElementById('client-list-section').style.display = 'none';
  document.getElementById('client-detail-section').style.display = 'none';
  document.getElementById('global-section').style.display = 'none';
  const section = document.getElementById('status-section');
  section.style.display = 'block';

  const s = state.status;
  if (!s) { section.innerHTML = '<div class="empty-state">加载中...</div>'; return; }

  section.innerHTML = \`
    <div class="flex-between mb-8">
      <button class="btn btn-sm" onclick="showClientList()">← 返回</button>
      <span class="client-name">📊 系统信息</span>
    </div>
    <div class="card">
      <div class="status-grid">
        <div class="status-item"><div class="value">\${escHtml(s.ccDingVersion)}</div><div class="label">cc-ding 版本</div></div>
        <div class="status-item"><div class="value">\${escHtml(s.nodeVersion)}</div><div class="label">Node.js 版本</div></div>
        <div class="status-item"><div class="value">\${escHtml(s.platform)}</div><div class="label">平台</div></div>
        <div class="status-item"><div class="value">\${s.clients}</div><div class="label">客户端总数</div></div>
        <div class="status-item"><div class="value" style="color:var(--accent);">\${s.onlineClients}</div><div class="label">在线客户端</div></div>
        <div class="status-item"><div class="value">\${Math.round(s.uptime)}s</div><div class="label">运行时间</div></div>
      </div>
    </div>
  \`;
}

// ===== Utilities =====
function escHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ===== Init =====
(function initFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const targetClient = params.get('client');
  const targetTab = params.get('tab');

  if (state.token && !state.firstLogin) {
    // 已登录，检查 URL 参数是否需要自动导航
    if (targetClient) {
      // 先加载客户列表，然后自动选中目标客户
      loadClients().then(() => {
        const client = state.clients.find(c => c.clientId === targetClient);
        if (client) {
          selectClient(targetClient).then(() => {
            if (targetTab && ['config', 'keys', 'files', 'env', 'raw'].includes(targetTab)) {
              switchTab(targetTab);
            }
          });
        }
      });
      renderApp();
      return;
    }
  }
  renderApp();
})();
</script>
</body>
</html>`;
}
