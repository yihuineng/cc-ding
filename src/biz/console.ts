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

// ==================== 类型定义 ====================

/** 认证用户信息 */
interface IAuthUser {
  account: string;
  passwordHash: string; // SHA-256 hash
  firstLogin: boolean;
}

/** 全局 Console 配置 */
interface IConsoleGlobalConfig {
  /** HTTP 监听端口，默认 8080 */
  port?: number;
  /** HTTP 监听地址，默认 '0.0.0.0' */
  host?: string;
  /** 认证用户列表 */
  authUsers?: IAuthUser[];
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
      };
    }
  } catch {
    // ignore parse errors
  }
  return {
    port: 8080,
    host: '0.0.0.0',
    authUsers: [{ account: 'admin', passwordHash: sha256('admin'), firstLogin: true }],
  };
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

  const configPath = path.join(getHomeDir(), '.cc-ding', clientId, 'config.json');
  if (!fs.existsSync(configPath)) {
    jsonError(res, 404, '客户端配置不存在');
    return;
  }

  try {
    const config = fileUtil.getJSON(configPath) as IConfig;
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
    jsonError(res, 500, '读取配置失败');
  }
}

/** PATCH /api/clients/:id/config */
async function handlePatchClientConfig(req: http.IncomingMessage, res: http.ServerResponse, clientId: string): Promise<void> {
  if (!requireAuth(req, res)) return;

  const configPath = path.join(getHomeDir(), '.cc-ding', clientId, 'config.json');
  if (!fs.existsSync(configPath)) {
    jsonError(res, 404, '客户端配置不存在');
    return;
  }

  try {
    const body = await readBody(req);
    const patches = JSON.parse(body || '{}');
    // patches 格式: { "conversations.0.qaMode": true }
    const config = fileUtil.getJSON(configPath) as IConfig;

    for (const [ pathStr, value ] of Object.entries(patches)) {
      dotPathSet(config, pathStr, value);
    }

    // 备份
    backupFile(configPath);
    // 原子写入
    atomicWrite(configPath, JSON.stringify(config, null, 2));

    jsonResponse(res, 200, { message: '配置已更新', path: configPath });
  } catch (err) {
    jsonError(res, 400, '请求格式错误');
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
  const clientApiKeysMatch = pathname.match(/^\/api\/clients\/([^\/]+)\/apikeys(?:\/(\d+))?(?:\/reset)?$/);
  const clientApiKeyIndexMatch = pathname.match(/^\/api\/clients\/([^\/]+)\/apikeys\/(\d+)$/);
  const clientApiKeyResetMatch = pathname.match(/^\/api\/clients\/([^\/]+)\/apikeys\/reset$/);
  const clientFilesMatch = pathname.match(/^\/api\/clients\/([^\/]+)\/files$/);
  const clientIdMatch = pathname.match(/^\/api\/clients\/([^\/]+)$/);

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
  return `http://${h}:${p}`;
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
<style>
/* ===== CSS Variables ===== */
:root {
  --bg: #0d1117;
  --bg-secondary: #161b22;
  --bg-tertiary: #21262d;
  --border: #30363d;
  --text: #c9d1d9;
  --text-secondary: #8b949e;
  --accent: #58a6ff;
  --accent-hover: #79b8ff;
  --green: #3fb950;
  --red: #f85149;
  --yellow: #d29922;
  --orange: #db6d28;
  --card-radius: 8px;
  --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  --mono: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
}
/* ===== Reset & Base ===== */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: var(--font); background: var(--bg); color: var(--text); line-height: 1.5; min-height: 100vh; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
button { cursor: pointer; font-family: var(--font); }
input, textarea, select { font-family: var(--font); background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 4px; padding: 6px 10px; }
input:focus, textarea:focus, select:focus { outline: none; border-color: var(--accent); }
textarea { font-family: var(--mono); font-size: 13px; resize: vertical; }

/* ===== Layout ===== */
.container { max-width: 1200px; margin: 0 auto; padding: 20px; }
.header { display: flex; align-items: center; justify-content: space-between; padding: 16px 20px; border-bottom: 1px solid var(--border); background: var(--bg-secondary); position: sticky; top: 0; z-index: 100; }
.header h1 { font-size: 18px; font-weight: 600; }
.header-actions { display: flex; gap: 8px; align-items: center; }
.user-info { color: var(--text-secondary); font-size: 13px; margin-right: 8px; }

/* ===== Buttons ===== */
.btn { display: inline-flex; align-items: center; gap: 4px; padding: 6px 14px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-tertiary); color: var(--text); font-size: 13px; transition: all 0.15s; }
.btn:hover { background: var(--border); }
.btn-primary { background: var(--accent); color: #fff; border-color: var(--accent); }
.btn-primary:hover { background: var(--accent-hover); }
.btn-danger { background: var(--red); color: #fff; border-color: var(--red); }
.btn-danger:hover { opacity: 0.85; }
.btn-sm { padding: 3px 8px; font-size: 12px; }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }

/* ===== Cards ===== */
.card { background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--card-radius); padding: 16px; margin-bottom: 16px; }
.card-title { font-size: 15px; font-weight: 600; margin-bottom: 12px; display: flex; align-items: center; gap: 8px; }
.card-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 16px; }

/* ===== Client Cards ===== */
.client-card { cursor: pointer; transition: border-color 0.2s; }
.client-card:hover { border-color: var(--accent); }
.client-card .card-title { margin-bottom: 8px; }
.client-name { font-size: 16px; font-weight: 600; }
.client-id { font-size: 12px; color: var(--text-secondary); font-family: var(--mono); }
.status-badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 12px; font-weight: 500; }
.status-online { background: rgba(63,185,80,0.15); color: var(--green); }
.status-offline { background: rgba(248,81,73,0.15); color: var(--red); }
.client-meta { display: flex; gap: 16px; margin-top: 8px; font-size: 13px; color: var(--text-secondary); }
.client-meta span { display: flex; align-items: center; gap: 4px; }

/* ===== Tabs ===== */
.tabs { display: flex; border-bottom: 1px solid var(--border); margin-bottom: 16px; overflow-x: auto; }
.tab { padding: 10px 16px; font-size: 13px; color: var(--text-secondary); border: none; background: none; cursor: pointer; white-space: nowrap; border-bottom: 2px solid transparent; transition: all 0.15s; }
.tab:hover { color: var(--text); }
.tab.active { color: var(--accent); border-bottom-color: var(--accent); }

/* ===== Table ===== */
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid var(--border); }
th { font-weight: 600; color: var(--text-secondary); white-space: nowrap; }
tr:hover td { background: var(--bg-tertiary); }

/* ===== Forms ===== */
.form-group { margin-bottom: 12px; }
.form-group label { display: block; font-size: 13px; color: var(--text-secondary); margin-bottom: 4px; }
.form-row { display: flex; gap: 8px; align-items: end; }
.form-row .form-group { flex: 1; }
.form-actions { display: flex; gap: 8px; margin-top: 12px; }

/* ===== Login ===== */
.login-container { display: flex; align-items: center; justify-content: center; min-height: 100vh; }
.login-card { width: 100%; max-width: 380px; }
.login-card .card-title { text-align: center; font-size: 20px; margin-bottom: 20px; }
.login-card .form-group { margin-bottom: 16px; }
.login-card input { width: 100%; padding: 10px 12px; font-size: 14px; }
.login-card .btn { width: 100%; padding: 10px; font-size: 14px; justify-content: center; }

/* ===== Toast ===== */
.toast-container { position: fixed; top: 80px; right: 20px; z-index: 9999; display: flex; flex-direction: column; gap: 8px; }
.toast { padding: 10px 16px; border-radius: 6px; font-size: 13px; min-width: 250px; animation: slideIn 0.2s ease-out; border: 1px solid var(--border); }
.toast-success { background: rgba(63,185,80,0.15); border-color: var(--green); color: var(--green); }
.toast-error { background: rgba(248,81,73,0.15); border-color: var(--red); color: var(--red); }
.toast-info { background: rgba(88,166,255,0.15); border-color: var(--accent); color: var(--accent); }
@keyframes slideIn { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }

/* ===== Modal ===== */
.modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center; z-index: 1000; }
.modal { background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--card-radius); padding: 20px; width: 90%; max-width: 600px; max-height: 80vh; overflow-y: auto; }
.modal-title { font-size: 16px; font-weight: 600; margin-bottom: 16px; }
.modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }

/* ===== Status Page ===== */
.status-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
.status-item { text-align: center; padding: 16px; }
.status-item .value { font-size: 28px; font-weight: 700; color: var(--accent); }
.status-item .label { font-size: 13px; color: var(--text-secondary); margin-top: 4px; }

/* ===== Env Vars ===== */
.env-list { font-family: var(--mono); font-size: 13px; }
.env-item { display: flex; gap: 8px; align-items: center; padding: 4px 0; }
.env-key { color: var(--accent); min-width: 200px; }
.env-val { color: var(--text-secondary); }

/* ===== Misc ===== */
.empty-state { text-align: center; padding: 40px 20px; color: var(--text-secondary); }
.empty-state .icon { font-size: 48px; margin-bottom: 12px; }
.divider { height: 1px; background: var(--border); margin: 16px 0; }
.text-mono { font-family: var(--mono); font-size: 12px; }
.text-muted { color: var(--text-secondary); }
.text-success { color: var(--green); }
.text-danger { color: var(--red); }
.flex-between { display: flex; justify-content: space-between; align-items: center; }
.gap-8 { gap: 8px; }
.mt-8 { margin-top: 8px; }
.mt-16 { margin-top: 16px; }
.mb-8 { margin-bottom: 8px; }
.switch { position: relative; width: 36px; height: 20px; display: inline-block; }
.switch input { opacity: 0; width: 0; height: 0; }
.switch .slider { position: absolute; inset: 0; background: var(--bg-tertiary); border: 1px solid var(--border); border-radius: 20px; cursor: pointer; transition: 0.2s; }
.switch .slider::before { content: ''; position: absolute; width: 14px; height: 14px; left: 2px; top: 2px; background: var(--text-secondary); border-radius: 50%; transition: 0.2s; }
.switch input:checked + .slider { background: var(--accent); border-color: var(--accent); }
.switch input:checked + .slider::before { transform: translateX(16px); background: #fff; }

@media (max-width: 768px) {
  .container { padding: 12px; }
  .card-grid { grid-template-columns: 1fr; }
  .form-row { flex-direction: column; }
  .header { flex-wrap: wrap; gap: 8px; }
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
  files: {},
  envVars: [],
  globalConfig: {},
  status: null,
  settingsTpl: '',
};

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
    section.innerHTML = '<div class="empty-state"><div class="icon">📭</div><p>暂无客户端配置</p><p class="text-muted">请先运行 cc-ding init 初始化</p></div>';
    return;
  }

  let html = '<div class="card-grid">';
  for (const c of state.clients) {
    html += \`
      <div class="card client-card" onclick="selectClient('\${c.clientId}')">
        <div class="flex-between">
          <div>
            <div class="client-name">\${escHtml(c.clientName || c.clientId)}</div>
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
    loadStatus(),
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
  } catch (e) {
    state.apiKeys = [];
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

  const tabs = ['config', 'keys', 'files', 'env', 'raw'];
  let tabHtml = '<div class="tabs">';
  const tabLabels = { config: '️ 配置', keys: ' API Key', files: ' 文件', env: '🌍 环境变量', raw: '📝 原始JSON' };
  for (const t of tabs) {
    tabHtml += '<button class="tab' + (state.activeTab === t ? ' active' : '') + '" onclick="switchTab(' + SQ + t + SQ + ')">' + tabLabels[t] + '</button>';
  }
  tabHtml += '</div>';

  let contentHtml = '';
  if (state.activeTab === 'config') contentHtml = renderConfigTab(clientId);
  else if (state.activeTab === 'keys') contentHtml = renderKeysTab(clientId);
  else if (state.activeTab === 'files') contentHtml = renderFilesTab(clientId);
  else if (state.activeTab === 'env') contentHtml = renderEnvTab(clientId);
  else if (state.activeTab === 'raw') contentHtml = renderRawTab(clientId);

  detail.innerHTML = \`
    <div class="flex-between mb-8">
      <button class="btn btn-sm" onclick="backToList()">← 返回</button>
      <span>
        <span class="client-name">\${escHtml(c?.clientName || clientId)}</span>
        <span class="status-badge \${c?.online ? 'status-online' : 'status-offline'}" style="margin-left:8px;">\${c?.online ? '● 在线' : '○ 离线'}</span>
      </span>
      <div style="display:flex;gap:8px;">
        <button class="btn btn-sm" onclick="reloadClientConfig('\${clientId}')" title="发送 SIGUSR2 热重载">🔄 重载</button>
      </div>
    </div>
    \${tabHtml}
    <div class="mt-16">\${contentHtml}</div>
  \`;
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
  let convHtml = '';
  if (convs.length > 0) {
    convHtml = '<table><thead><tr><th>会话</th><th>类型</th><th>QA</th><th>Streaming</th><th>Freedom</th><th>Model</th></tr></thead><tbody>';
    for (const conv of convs) {
      convHtml += '<tr><td>' + escHtml(conv.conversationTitle || conv.conversationId) + '<br><span class="text-mono text-muted">' + escHtml(conv.conversationId) + '</span></td><td>' + (conv.conversationType === '2' ? '群聊' : '单聊') + '</td><td>' + (conv.qaMode ? '<span class="text-success">开</span>' : '<span class="text-muted">关</span>') + '</td><td>' + (conv.streaming ? '<span class="text-success">开</span>' : '<span class="text-muted">关</span>') + '</td><td>' + (conv.freedomMode ? '<span class="text-success">开</span>' : '<span class="text-muted">关</span>') + '</td><td>' + escHtml(conv.model || cfg.model || '-') + '</td></tr>';
    }
    convHtml += '</tbody></table>';
  } else {
    convHtml = '<p class="text-muted">暂无会话配置</p>';
  }

  return \`
    <div class="card">
      <div class="card-title">基本信息</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:13px;">
        <div><span class="text-muted">Client:</span> \${escHtml(cfg.clientName || '-')}</div>
        <div><span class="text-muted">Owner:</span> \${escHtml(cfg.owner || '-')}</div>
        <div><span class="text-muted">白名单:</span> \${(cfg.whiteUserList || []).join(', ') || '-'}</div>
        <div><span class="text-muted">任务队列:</span> \${cfg.taskQueueSize ?? 50}</div>
        <div><span class="text-muted">并发:</span> \${cfg.sessionMaxConcurrency ?? 5}</div>
        <div><span class="text-muted">DEBUG:</span> \${cfg.debug ? '<span class="text-success">开</span>' : '<span class="text-muted">关</span>'}</div>
        <div><span class="text-muted">结果模式:</span> \${cfg.resultOnly ? '<span class="text-success">仅结果</span>' : '<span class="text-muted">详细</span>'}</div>
        <div><span class="text-muted">思考过程:</span> \${cfg.includeThinking ? '<span class="text-success">显示</span>' : '<span class="text-muted">隐藏</span>'}</div>
      </div>
    </div>
    <div class="card">
      <div class="card-title">会话配置 (\${convs.length})</div>
      \${convHtml}
    </div>
  \`;
}

// ===== Render: Keys Tab =====
function renderKeysTab(clientId) {
  const keys = state.apiKeys;
  if (keys.length === 0) return '<div class="empty-state"><div class="icon">🔑</div><p>未配置 API Key</p></div>';

  let html = '<div class="card"><div class="flex-between"><div class="card-title" style="margin-bottom:0;">API Key 池</div><button class="btn btn-sm btn-primary" onclick="showAddKeyModal()">+ 添加</button></div><div class="divider"></div>';
  html += '<table><thead><tr><th>#</th><th>状态</th><th>Key</th><th>模型</th><th>Base URL</th><th>备注</th><th>操作</th></tr></thead><tbody>';
  for (const key of keys) {
    html += '<tr>';
    html += '<td>' + key.index + '</td>';
    html += '<td><span class="status-badge ' + (key.isValid ? 'status-online' : 'status-offline') + '">' + (key.isValid ? '有效' : '无效') + '</span></td>';
    html += '<td class="text-mono">' + escHtml(key.apiKey || '-') + '</td>';
    html += '<td class="text-mono">' + escHtml(key.model || '-') + '</td>';
    html += '<td class="text-mono" style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escHtml(key.baseUrl || '-') + '</td>';
    html += '<td>' + escHtml(key.memo || '-') + '</td>';
    html += '<td style="white-space:nowrap;"><button class="btn btn-sm" onclick="toggleKey(' + SQ + clientId + SQ + ',' + key.index + ')">切换</button> <button class="btn btn-sm" onclick="editKey(' + SQ + clientId + SQ + ',' + key.index + ')">编辑</button> <button class="btn btn-sm btn-danger" onclick="deleteKey(' + SQ + clientId + SQ + ',' + key.index + ')">删除</button></td>';
    html += '</tr>';
  }
  html += '</tbody></table>';
  html += '<div class="divider"></div>';
  html += '<div class="flex-between"><span class="text-muted text-mono">重置时间: ' + (keys[0]?.resetTime || '-') + '</span><button class="btn btn-sm" onclick="resetAllKeys(' + SQ + clientId + SQ + ')">一键重置所有 Key</button></div>';
  html += '</div>';
  return html;
}

async function toggleKey(clientId, index) {
  try {
    await api('/api/clients/' + encodeURIComponent(clientId) + '/apikeys/' + index + '/cfuseTokenValid', { method: 'PATCH', body: JSON.stringify({}) });
    toast('社区版不支持 cfuse 切换', 'info');
  } catch (e) { toast(e.message, 'error'); }
}

async function resetAllKeys(clientId) {
  if (!confirm('确定要重置所有 API Key 为有效状态吗？')) return;
  try {
    await api('/api/clients/' + encodeURIComponent(clientId) + '/apikeys/reset', { method: 'POST' });
    toast('已重置', 'success');
    loadClientApiKeys(clientId).then(() => { const c = state.selectedClient; if (c) renderClientDetail(c); });
  } catch (e) { toast(e.message, 'error'); }
}

function showAddKeyModal() {
  // 简化处理：弹出 prompt
  const baseUrl = prompt('Base URL:', 'https://api.anthropic.com');
  if (!baseUrl) return;
  const apiKey = prompt('API Key:', '');
  if (!apiKey) return;
  const model = prompt('Model:', 'claude-3-opus-latest');
  const memo = prompt('备注:', '') || '';
  addKey(state.selectedClient, { baseUrl, apiKey, model, memo });
}

async function addKey(clientId, data) {
  try {
    await api('/api/clients/' + encodeURIComponent(clientId) + '/apikeys', { method: 'POST', body: JSON.stringify(data) });
    toast('API Key 已添加', 'success');
    loadClientApiKeys(clientId).then(() => { const c = state.selectedClient; if (c) renderClientDetail(c); });
  } catch (e) { toast(e.message, 'error'); }
}

async function editKey(clientId, index) {
  const key = state.apiKeys[index];
  if (!key) return;
  const baseUrl = prompt('Base URL:', key.baseUrl);
  if (baseUrl === null) return;
  const model = prompt('Model:', key.model);
  if (model === null) return;
  const memo = prompt('备注:', key.memo || '');
  if (memo === null) return;
  try {
    await api('/api/clients/' + encodeURIComponent(clientId) + '/apikeys/' + index, { method: 'PUT', body: JSON.stringify({ baseUrl, model, memo }) });
    toast('已更新', 'success');
    loadClientApiKeys(clientId).then(() => { const c = state.selectedClient; if (c) renderClientDetail(c); });
  } catch (e) { toast(e.message, 'error'); }
}

async function deleteKey(clientId, index) {
  if (!confirm('确定删除此 API Key？')) return;
  try {
    await api('/api/clients/' + encodeURIComponent(clientId) + '/apikeys/' + index, { method: 'DELETE' });
    toast('已删除', 'success');
    loadClientApiKeys(clientId).then(() => { const c = state.selectedClient; if (c) renderClientDetail(c); });
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

  // 常用 Claude Code 环境变量
  const commonEnvVars = [
    'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL',
    'CLAUDE_SMALL_FAST_MODEL', 'CLAUDE_CODE_ENABLE_BACKGROUND_TASKS',
    'CLAUDE_CODE_HOME', 'PATH',
  ];
  const allVars = new Set([...commonEnvVars, ...envRefs]);

  let html = '<div class="card"><div class="card-title">环境变量编辑器</div>';
  html += '<p class="text-muted mb-8" style="font-size:13px;">配置中使用 \\$ENV:VAR 语法引用环境变量</p>';
  html += '<div class="env-list">';
  for (const v of [...allVars].sort()) {
    const val = process.env[v] || '<span class="text-danger">未设置</span>';
    const isUsed = envRefs.has(v);
    html += '<div class="env-item"><span class="env-key">' + (isUsed ? '🔗 ' : '') + escHtml(v) + '</span><span class="env-val">= ' + (typeof val === 'string' ? escHtml(val.substring(0, 60)) : val) + '</span></div>';
  }
  html += '</div></div>';
  return html;
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
    '<textarea id="raw-editor" rows="20" style="width:100%;font-size:13px;">' + '$' + '{escHtml(state.rawConfig)}</textarea>' +
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
      <div class="card-title">settings-tpl.json</div>
      <textarea id="settings-tpl-editor" rows="12" style="width:100%;">\${escHtml(state.settingsTpl)}</textarea>
      <div class="form-actions"><button class="btn btn-sm" onclick="loadSettingsTpl()">🔄 刷新</button><button class="btn btn-primary" onclick="saveSettingsTpl()">💾 保存</button></div>
    </div>
  \`;
  loadSettingsTpl();
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
  try {
    await api('/api/global/config', { method: 'PUT', body: JSON.stringify({ port, host }) });
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
        <div class="status-item"><div class="value" style="color:var(--green);">\${s.onlineClients}</div><div class="label">在线客户端</div></div>
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
renderApp();
</script>
</body>
</html>`;
}
