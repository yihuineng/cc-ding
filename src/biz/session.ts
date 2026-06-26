import { dateUtil, fileUtil } from 'utils-ok';
import fs from 'fs';
import os from 'os';
import assert from 'assert';
import crypto from 'crypto';
import path from 'path';
import type { DingClaude } from './cc-ding-cli';
import { IActiveSession, IActiveSessionPersist, IConfig, IMessageQueueItem, ISession } from './types';
import { parseEndCommand } from './commands';
import { sendDingMessage, queryUserIdByMobile, queryUserIdByJobNumber, queryDingUser, attachReaction, recallReaction } from './messaging';
import { createAgent } from './agent-registry';
import { isWindows } from './platform';
import { userMessageWatermark } from './dedup';

// ==================== 消息确认辅助函数 ====================

/**
 * 发送消息确认（Reaction 表情 或 文本消息）
 * - receiveReplyMode === 'reaction' 且有 msgId 时，贴表情
 * - 否则发文本消息（text 模式 或 无 msgId 降级）
 * - best-effort: Reaction 失败不影响主流程
 */
async function sendAckConfirmation(
  self: DingClaude,
  conversationId: string,
  sessionWebhook: string,
  conversationConfig: IConfig['conversations'][0],
  msgId: string | undefined,
  textContent: string,
): Promise<void> {
  const mode = conversationConfig.receiveReplyMode ?? 'reaction';
  // ackReaction 未配置时默认 '👀'，配置为空字符串时不发送表情
  const emoji = conversationConfig.ackReaction !== undefined ? conversationConfig.ackReaction : '👀';

  if (mode === 'reaction' && msgId && emoji) {
    // Reaction 模式：有 msgId 且 emoji 非空时贴表情
    await attachReaction(self, conversationId, msgId, emoji).catch(() => {});
  } else {
    // text 模式、无 msgId 降级、或 emoji 为空时发文本
    await sendDingMessage(self, {
      conversationId, sessionWebhook,
      content: textContent,
    }).catch(() => {});
  }
}

/**
 * 撤回确认表情（处理完成时）
 */
async function recallAckReaction(
  self: DingClaude,
  conversationId: string,
  msgId: string | undefined,
  conversationConfig: IConfig['conversations'][0],
): Promise<void> {
  const mode = conversationConfig.receiveReplyMode ?? 'reaction';
  const emoji = conversationConfig.ackReaction !== undefined ? conversationConfig.ackReaction : '👀';

  if (mode === 'reaction' && msgId && emoji) {
    await recallReaction(self, conversationId, msgId, emoji).catch(() => {});
  }
}

/**
 * 获取当前时间戳字符串 (YYYY-MM-DD HH:mm:ss)
 */
export function timestamp(): string {
  return dateUtil.mm(Date.now()).format('YYYY-MM-DD HH:mm:ss');
}

// ==================== 配置与鉴权 ====================

/** 跨平台获取用户 HOME 目录 */
export function getHomeDir(): string {
  return os.homedir();
}

export function getClientDir(self: DingClaude): string {
  return path.join(getHomeDir(), '.cc-ding', self.clientId);
}

/**
 * 初始化客户端目录：创建目录并写入配置文件
 * @returns 配置文件路径
 */
export function initClientDir(clientId: string, config: IConfig): string {
  const clientDir = path.join(getHomeDir(), '.cc-ding', clientId);
  const cfgFile = path.join(clientDir, 'config.json');
  fs.mkdirSync(clientDir, { recursive: true });
  // 配置包含密钥，限制为仅 owner 可读写
  fs.writeFileSync(cfgFile, JSON.stringify(config, null, 2), { encoding: 'utf-8', mode: isWindows() ? undefined : 0o600 });
  if (!isWindows()) fs.chmodSync(cfgFile, 0o600);
  return cfgFile;
}

/**
 * 检查客户端目录和 config.json 是否存在，不存在则自动初始化
 * 生成占位配置后 exit，提示用户编辑后重启
 */
export function ensureClientDir(clientId: string): void {
  const clientDir = path.join(getHomeDir(), '.cc-ding', clientId);
  const cfgFile = path.join(clientDir, 'config.json');

  if (fs.existsSync(cfgFile)) {
    return;
  }

  console.log(`[${timestamp()}] 客户端目录未初始化: ${clientDir}`);
  console.log(`[${timestamp()}] 正在自动初始化...`);

  const defaultConfig: IConfig = {
    clientName: 'cc助手',
    owner: '<owner手机号>',
    whiteUserList: [],
    clientSecret: '<clientSecret-钉钉Stream连接密钥>',
    defaultDingToken: '<兜底钉钉机器人Token>',
    conversations: [],
  };

  initClientDir(clientId, defaultConfig);
  console.log(`[${timestamp()}] 已生成默认配置文件: ${cfgFile}`);
  console.log(`[${timestamp()}] 请编辑 config.json 填写必要的配置项后重新启动`);
  process.exit(1);
}

export function getClientConfig(self: DingClaude): IConfig {
  const appCfgFile = path.join(getClientDir(self), 'config.json');
  assert(fs.existsSync(appCfgFile), `Could not find client config file: ${appCfgFile}`);
  const cfg = fileUtil.getJSON(appCfgFile) as IConfig;
  assert(cfg.clientSecret, 'config.json missing required field: clientSecret');
  assert(cfg.whiteUserList, 'config.json missing required field: whiteUserList');
  return cfg;
}

/**
 * 重新从磁盘读取并验证 config.json，用于 /cfg --reload
 * 失败时抛出 Error，不更新内存中的 config
 * @returns 验证通过的新 IConfig 对象
 */
export function reloadClientConfig(self: DingClaude): { config: IConfig; configPath: string } {
  const appCfgFile = path.join(getClientDir(self), 'config.json');
  if (!fs.existsSync(appCfgFile)) {
    throw new Error(`配置文件不存在: ${appCfgFile}`);
  }
  let cfg: IConfig;
  try {
    cfg = fileUtil.getJSON(appCfgFile) as IConfig;
  } catch (err) {
    throw new Error(`配置文件 JSON 解析失败: ${err instanceof Error ? err.message : String(err)}`);
  }
  // 验证必填字段
  const missing: string[] = [];
  if (!cfg.clientSecret) missing.push('clientSecret');
  if (!cfg.whiteUserList) missing.push('whiteUserList');
  if (!cfg.owner) missing.push('owner');
  if (!cfg.defaultDingToken) missing.push('defaultDingToken');
  if (!Array.isArray(cfg.conversations)) missing.push('conversations');
  if (missing.length > 0) {
    throw new Error(`config.json 缺少必要字段: ${missing.join(', ')}`);
  }
  return { config: cfg, configPath: appCfgFile };
}

/** 将配置值解析为 userId：手机号走 resolvedPhones，userId 直接返回 */
export function resolveToUserId(self: DingClaude, value: string): string {
  return isMobile(value) ? (self.resolvedPhones[value] || value) : value;
}

export function authCheck(self: DingClaude, userId: string, conversationId?: string): boolean {
  // owner/admin 拥有所有权限，无需检查白名单
  if (isOwnerOrAdmin(self, userId)) return true;

  if (conversationId) {
    const conv = self.config.conversations.find(it => it.conversationId === conversationId);
    // 自由模式：跳过群用户白名单限制
    if (conv?.freedomMode) return true;
    // 问答模式：跳过白名单，所有群成员可用
    if (conv?.qaMode) return true;
    if (conv?.whiteUserList && conv.whiteUserList.length > 0) {
      return conv.whiteUserList.some(item => resolveToUserId(self, item) === userId);
    }
  }
  return self.config.whiteUserList.some(item => resolveToUserId(self, item) === userId);
}

/**
 * 检查用户是否为机器人 owner（owner 可填手机号或工号）
 */
export function isOwner(self: DingClaude, userId: string): boolean {
  const owner = self.config.owner;
  if (!owner) return false;
  const ownerUserId = self.resolvedPhones[owner];
  return !!ownerUserId && ownerUserId === userId;
}

/**
 * 检查用户是否为管理员
 */
export function isAdmin(self: DingClaude, userId: string): boolean {
  if (!self.config.adminUserList?.length) return false;
  return self.config.adminUserList.some(item => resolveToUserId(self, item) === userId);
}

/**
 * 检查用户是否为 owner 或管理员（统一权限判断）
 */
export function isOwnerOrAdmin(self: DingClaude, userId: string): boolean {
  return isOwner(self, userId) || isAdmin(self, userId);
}

export function debugLog(self: DingClaude, message: string, ...args: unknown[]): void {
  if (self.config.debug) {
    console.log(`[DEBUG] ${message}`, ...args);
  }
}

// ==================== 手机号解析与缓存 ====================

const PHONE_RE = /^1\d{10}$/;

/** 判断是否为手机号格式 */
export function isMobile(value: string): boolean {
  return PHONE_RE.test(value);
}

/** 判断是否为工号格式（非手机号且非userId的纯数字/字母数字组合） */
export function isJobNumber(value: string): boolean {
  // 工号通常位数较少（≤15位），长数字串大概率是 userId
  // 不是手机号，也不是userId格式（含下划线等），且为数字或字母数字组合
  return !isMobile(value) && !value.includes('_') && value.length <= 15 && /^[A-Za-z0-9]+$/.test(value);
}

export function getPhoneMapFile(self: DingClaude): string {
  return path.join(getClientDir(self), 'user-map.json');
}

export function loadPhoneMap(self: DingClaude): Record<string, string> {
  const file = getPhoneMapFile(self);
  if (!fs.existsSync(file)) return {};
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (typeof data === 'object' && data !== null) return data as Record<string, string>;
  } catch { /* ignore */ }
  return {};
}

export function savePhoneMap(self: DingClaude, map: Record<string, string>): void {
  const file = getPhoneMapFile(self);
  try {
    fs.writeFileSync(file, JSON.stringify(map, null, 2), 'utf-8');
  } catch (err) {
    console.error('保存 user-map.json 失败:', err);
  }
}

/** 通过运行时映射反向查找 userId 对应的手机号 */
export function userIdToPhone(self: DingClaude, userId: string): string | null {
  for (const [ phone, uid ] of Object.entries(self.resolvedPhones)) {
    if (uid === userId) return phone;
  }
  return null;
}

// ==================== userId 到昵称缓存 ====================

export function getUserIdNameMapFile(self: DingClaude): string {
  return path.join(getClientDir(self), 'user-id-name-map.json');
}

export function loadUserIdNameMap(self: DingClaude): Record<string, string> {
  const file = getUserIdNameMapFile(self);
  if (!fs.existsSync(file)) return {};
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (typeof data === 'object' && data !== null) return data as Record<string, string>;
  } catch { /* ignore */ }
  return {};
}

export function saveUserIdNameMap(self: DingClaude, map: Record<string, string>): void {
  const file = getUserIdNameMapFile(self);
  try {
    fs.writeFileSync(file, JSON.stringify(map, null, 2), 'utf-8');
  } catch (err) {
    console.error('保存 user-id-name-map.json 失败:', err);
  }
}

/** 解析 userId 为昵称：优先查缓存，查不到走 API 并缓存 */
export async function resolveUserIdName(self: DingClaude, userId: string): Promise<string | null> {
  if (!userId) return null;
  const cache = loadUserIdNameMap(self);
  if (cache[userId]) return cache[userId];

  const userDetail = await queryDingUser(self, userId);
  if (userDetail && userDetail.name) {
    cache[userId] = userDetail.name;
    saveUserIdNameMap(self, cache);
    return userDetail.name;
  }
  return null;
}

/** 解析单个值：手机号/工号走 API 解析并缓存，userId 直接返回 */
export async function resolveUserId(
  self: DingClaude,
  value: string,
): Promise<string | null> {
  if (!value) return null;
  // userId 格式（含下划线等）直接返回
  if (!isMobile(value) && !isJobNumber(value)) return value;
  if (self.resolvedPhones[value]) return self.resolvedPhones[value];
  let userId: string | null = null;
  if (isMobile(value)) {
    userId = await queryUserIdByMobile(self, value);
  } else if (isJobNumber(value)) {
    userId = await queryUserIdByJobNumber(self, value);
  }
  if (userId) {
    self.resolvedPhones[value] = userId;
    savePhoneMap(self, self.resolvedPhones);
  }
  return userId;
}

/** 启动时批量解析 config 中的手机号/工号，填充到 self.resolvedPhones */
export async function resolveAllPhonesInConfig(self: DingClaude): Promise<void> {
  self.resolvedPhones = loadPhoneMap(self);
  const newEntries: string[] = [];

  const ensureResolved = async (value: string) => {
    if (self.resolvedPhones[value]) return;
    let userId: string | null = null;
    if (isMobile(value)) {
      userId = await queryUserIdByMobile(self, value);
    } else if (isJobNumber(value)) {
      userId = await queryUserIdByJobNumber(self, value);
    }
    if (userId) {
      self.resolvedPhones[value] = userId;
      newEntries.push(value);
    }
  };

  // 解析 owner（手机号或工号）
  if (self.config.owner) {
    if (isMobile(self.config.owner) || isJobNumber(self.config.owner)) {
      await ensureResolved(self.config.owner);
      if (!self.resolvedPhones[self.config.owner]) {
        console.warn(`[WARN] 无法解析 owner: ${self.config.owner}`);
      }
    } else {
      console.warn(`[WARN] owner 格式无效(需为手机号或工号): ${self.config.owner}`);
    }
  }

  // 解析全局 whiteUserList
  for (const item of self.config.whiteUserList) {
    if (isMobile(item) || isJobNumber(item)) {
      await ensureResolved(item);
      if (!self.resolvedPhones[item]) {
        console.warn(`[WARN] 无法解析 whiteUserList: ${item}`);
      }
    }
  }

  // 解析群级 whiteUserList
  for (const conv of self.config.conversations) {
    if (conv.whiteUserList) {
      for (const item of conv.whiteUserList) {
        if (isMobile(item) || isJobNumber(item)) {
          await ensureResolved(item);
          if (!self.resolvedPhones[item]) {
            console.warn(`[WARN] 无法解析群白名单: ${item}`);
          }
        }
      }
    }
  }

  if (newEntries.length > 0) {
    savePhoneMap(self, self.resolvedPhones);
  }
  console.log(`[用户解析] 已加载 ${Object.keys(self.resolvedPhones).length} 条记录 (${newEntries.length} 条新解析)`);
}

export function hashConversationId(self: DingClaude, conversationId: string): string {
  const convCfg = getConversationConfig(self, conversationId);
  const convId = convCfg?.linkConversationId || conversationId;
  return crypto.createHash('md5').update(convId).digest('hex');
}

/**
 * 获取回复用的webhook，优先使用当前提问来源的webhook（关联群场景）
 */
export function getReplyWebhook(session: ISession): string {
  return session.currentWebhook || session.sessionWebhook;
}

/**
 * 获取回复用的会话ID，优先使用当前提问来源的会话ID（关联群场景）
 */
export function getReplyConversationId(session: ISession): string {
  return session.currentConversationId || session.conversationId;
}

/**
 * 查找活跃会话，支持关联群查找
 * 先按当前群ID查找，未找到时查找相同linkConversationId的其他群的活跃会话
 */
export function findActiveSession(self: DingClaude, conversationId: string): { key: string; session: IActiveSession } | undefined {
  // 直接查找
  const directSession = self.activeSessions.get(conversationId);
  if (directSession) return { key: conversationId, session: directSession };

  // 查找关联群的活跃会话
  const convCfg = getConversationConfig(self, conversationId);
  if (convCfg?.linkConversationId) {
    for (const entry of self.activeSessions) {
      const otherCfg = getConversationConfig(self, entry[0]);
      if (otherCfg?.linkConversationId === convCfg.linkConversationId) {
        return { key: entry[0], session: entry[1] };
      }
    }
  }

  return undefined;
}

export function getConversationConfig(self: DingClaude, conversationId: string): IConfig['conversations'][0] | undefined {
  return self.config.conversations.find(it => it.conversationId === conversationId);
}

// ==================== 路径工具 ====================

export function getConversationDir(self: DingClaude, conversationId: string): string {
  const hashedId = hashConversationId(self, conversationId);
  return path.join(getClientDir(self), hashedId);
}

export function getSessionsDir(self: DingClaude, conversationId: string): string {
  return path.join(getConversationDir(self, conversationId), '.sessions');
}

export function getTasksDir(self: DingClaude, conversationId: string): string {
  return path.join(getConversationDir(self, conversationId), '.tasks');
}

export function getImagesDir(self: DingClaude, conversationId: string): string {
  return path.join(getConversationDir(self, conversationId), '.images');
}

export function getSessionDir(self: DingClaude, session: ISession): string {
  const dirName = session.agentSessionId || session.startTimeStr;
  return path.join(getSessionsDir(self, session.conversationId), dirName);
}

export function getSessionId(session: ISession): string {
  return session.agentSessionId || session.startTimeStr;
}

// ==================== 会话信息与日志 ====================

export function formatSessionInfo(self: DingClaude, conversationId: string): string | null {
  const found = findActiveSession(self, conversationId);
  if (!found) return null;

  const { session, isProcessing, messageQueue } = found.session;
  const lines = [
    `- **会话ID:** ${getSessionId(session)}`,
    `- **发起者:** ${session.startNickName}(${session.startStaffId})`,
    `- **开始时间:** ${session.startTimeStr}`,
    `- **最后发送者:** ${found.session.lastSenderStaffId}`,
    `- **处理中:** ${isProcessing}`,
    `- **排队消息:** ${messageQueue?.length || 0} 条`,
  ];
  return lines.join('\n');
}

export function readSessionLogTail(self: DingClaude, conversationId: string, n: number): string | null {
  const found = findActiveSession(self, conversationId);
  if (!found) return null;

  const activeSession = found.session;

  const logFile = `${getSessionDir(self, activeSession.session)}/session.log`;
  if (!fs.existsSync(logFile)) return null;

  try {
    const content = fs.readFileSync(logFile, 'utf-8');
    const lines = content.split('\n').filter(line => line.length > 0);
    return lines.slice(-n).join('\n');
  } catch {
    return null;
  }
}

// ==================== 会话持久化 ====================

export function findHistorySession(self: DingClaude, conversationId: string, sessionId: string): ISession | null {
  const sessionsDir = getSessionsDir(self, conversationId);

  const directFile = `${sessionsDir}/${sessionId}/session.json`;
  try {
    return fileUtil.getJSON(directFile) as ISession;
  } catch { /* continue */ }

  const numericId = parseInt(sessionId, 10);
  if (!isNaN(numericId) && numericId > 0) {
    const startTimeStr = dateUtil.mm(numericId).format('YYYY-MM-DD-HH-mm-ss');
    const fallbackFile = `${sessionsDir}/${startTimeStr}/session.json`;
    try {
      return fileUtil.getJSON(fallbackFile) as ISession;
    } catch { /* continue */ }
  }
  return null;
}

/**
 * 查找最近一个已结束的会话（按 startTime 降序）
 */
export function findLatestSession(self: DingClaude, conversationId: string): ISession | null {
  const sessionsDir = getSessionsDir(self, conversationId);
  if (!fs.existsSync(sessionsDir)) return null;

  // 提前查找活跃会话ID，避免在循环中重复查找
  const activeFound = findActiveSession(self, conversationId);
  const activeSessionId = activeFound ? getSessionId(activeFound.session.session) : null;

  let latestSession: ISession | null = null;
  let latestTime = 0;

  try {
    const entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const sessionFile = path.join(sessionsDir, entry.name, 'session.json');
      if (!fs.existsSync(sessionFile)) continue;

      try {
        const session = fileUtil.getJSON(sessionFile) as ISession;
        // 跳过当前活跃会话
        if (activeSessionId && getSessionId(session) === activeSessionId) {
          continue;
        }
        if (session.startTime > latestTime) {
          latestTime = session.startTime;
          latestSession = session;
        }
      } catch { continue; }
    }
  } catch { /* ignore */ }

  return latestSession;
}

export function updateSessionFile(
  self: DingClaude,
  session: ISession,
  opts: { agentSessionId?: string; sessionWebhook?: string; currentWebhook?: string; currentConversationId?: string },
): void {
  if (opts.agentSessionId && !session.agentSessionId) {
    session.agentSessionId = opts.agentSessionId;
  }

  const sessionFile = `${getSessionDir(self, session)}/session.json`;
  try {
    if (opts.sessionWebhook) session.sessionWebhook = opts.sessionWebhook;
    if (opts.currentWebhook !== undefined) session.currentWebhook = opts.currentWebhook || undefined;
    if (opts.currentConversationId !== undefined) session.currentConversationId = opts.currentConversationId || undefined;
    fs.writeFileSync(sessionFile, JSON.stringify(session, null, 2), 'utf-8');
    const changedField = opts.agentSessionId ? 'agentSessionId' : opts.currentWebhook !== undefined ? 'currentWebhook' : 'sessionWebhook';
    console.log(`[${timestamp()}] 会话文件已保存: ${changedField}`);
    saveActiveSession(self, session.conversationId);
  } catch (err) {
    console.error('更新 session.json 失败:', err);
  }
}

export function appendSessionLog(sessionDir: string, role: 'user' | 'assistant' | 'system' | 'tool', content: string): void {
  const logFile = `${sessionDir}/session.log`;
  const ts = timestamp();
  const logEntry = `[${ts}] [${role.toUpperCase()}]: ${content}\n`;
  try {
    fs.appendFileSync(logFile, logEntry, 'utf-8');
  } catch { /* 会话目录被清理则忽略 */ }
}

export function getActiveSessionsFile(self: DingClaude, conversationId: string): string {
  return `${getSessionsDir(self, conversationId)}/active.json`;
}

export function saveActiveSession(self: DingClaude, conversationId: string): void {
  const activeSession = self.activeSessions.get(conversationId);
  const filePath = getActiveSessionsFile(self, conversationId);
  try {
    if (!activeSession) {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      return;
    }
    const persistData: IActiveSessionPersist = {
      session: activeSession.session,
      lastSenderStaffId: activeSession.lastSenderStaffId,
      conversationConfig: activeSession.conversationConfig,
    };
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(persistData, null, 2), 'utf-8');
    debugLog(self, `活跃会话已持久化: 群=${conversationId}`);
  } catch (err) {
    console.error(`持久化活跃会话失败: 群=${conversationId}`, err);
  }
}

export function loadActiveSessions(self: DingClaude): void {
  for (const conv of self.config.conversations) {
    const filePath = getActiveSessionsFile(self, conv.conversationId);
    if (!fs.existsSync(filePath)) continue;
    try {
      const data = fileUtil.getJSON(filePath) as IActiveSessionPersist;
      if (!data?.session) {
        console.log(`活跃会话文件无效，跳过: ${filePath}`);
        continue;
      }
      const sessionDir = getSessionDir(self, data.session);
      if (!fs.existsSync(sessionDir)) {
        console.log(`活跃会话目录已不存在，清理持久化文件: ${filePath}`);
        fs.unlinkSync(filePath);
        continue;
      }
      self.activeSessions.set(conv.conversationId, {
        session: data.session,
        lastSenderStaffId: data.lastSenderStaffId || data.session.startStaffId,
        isProcessing: false,
        messageQueue: [],
        conversationConfig: data.conversationConfig,
      });
      console.log(`恢复活跃会话: 群=${conv.conversationId}, 会话ID=${getSessionId(data.session)}`);
    } catch (err) {
      console.error(`加载活跃会话失败: ${filePath}`, err);
    }
  }
}

// ==================== 会话生命周期 ====================

export async function endSession(self: DingClaude, conversationId: string, sessionWebhook: string): Promise<void> {
  const found = findActiveSession(self, conversationId);
  if (!found) {
    console.log(`群 ${conversationId} 无活跃会话`);
    await sendDingMessage(self, {
      conversationId,
      sessionWebhook,
      content: '⚠️ 当前没有活跃的会话，无需结束。\n可以通过 /new 开始新会话。',
    });
    return;
  }

  const { key: sessionKey, session: activeSession } = found;
  const { session } = activeSession;
  const sessionDir = getSessionDir(self, session);
  const sessionId = getSessionId(session);
  console.log(`结束会话: 群=${conversationId}, 会话ID=${sessionId}`);

  const agent = activeSession.agent;
  if (agent?.interrupt(activeSession, '结束会话时中断正在执行的 Agent 进程')) {
    fs.appendFileSync(
      `${sessionDir}/session.log`,
      `[${timestamp()}] [SYSTEM]: 结束会话时中断 Claude 进程\n`,
      'utf-8',
    );
  }

  // 清空消息队列
  const queueLen = activeSession.messageQueue?.length ?? 0;
  if (queueLen > 0) {
    activeSession.messageQueue = [];
    console.log(`[${timestamp()}] 结束会话时清空消息队列: 群=${conversationId}, 清空${queueLen}条消息`);
  }

  await sendDingMessage(self, {
    conversationId,
    sessionWebhook,
    content: `💬 会话已结束\n🆔 ${sessionId}${queueLen > 0 ? `\n🗑️ 已清空消息队列，丢弃${queueLen}条待处理消息` : ''}`,
  });

  self.activeSessions.delete(sessionKey);
  saveActiveSession(self, sessionKey);

  fs.appendFileSync(
    `${sessionDir}/session.log`,
    `[${timestamp()}] [SYSTEM]: 用户请求结束会话\n`,
    'utf-8',
  );
}

export async function switchToSession(
  self: DingClaude,
  conversationId: string,
  sessionWebhook: string,
  targetSessionId: string,
  senderStaffId: string,
  conversationConfig: IConfig['conversations'][0],
): Promise<boolean> {
  const targetSession = findHistorySession(self, conversationId, targetSessionId);
  if (!targetSession) {
    await sendDingMessage(self, {
      conversationId, sessionWebhook,
      content: `❌ 未找到会话 ${targetSessionId}，该会话可能已被清理，请发送新消息开始新会话`,
    });
    return false;
  }

  const sessionDir = getSessionDir(self, targetSession);
  if (!fs.existsSync(sessionDir)) {
    await sendDingMessage(self, {
      conversationId, sessionWebhook,
      content: `❌ 会话 ${targetSessionId} 的数据已被清理，无法恢复，请发送新消息开始新会话`,
    });
    return false;
  }

  const currentActive = findActiveSession(self, conversationId);
  if (currentActive) {
    console.log(`切换会话，先结束当前会话: ${getSessionId(currentActive.session.session)}`);
    const agent = currentActive.session.agent;
    agent?.interrupt(currentActive.session, '切换会话时中断正在执行的 Agent 进程');
    self.activeSessions.delete(currentActive.key);
    saveActiveSession(self, currentActive.key);
    fs.appendFileSync(
      `${getSessionDir(self, currentActive.session.session)}/session.log`,
      `[${timestamp()}] [SYSTEM]: 会话被切换到 ${targetSessionId}，结束当前会话\n`,
      'utf-8',
    );
  }

  self.activeSessions.set(conversationId, {
    session: targetSession,
    lastSenderStaffId: senderStaffId,
    isProcessing: false,
    messageQueue: [],
    conversationConfig,
  });
  saveActiveSession(self, conversationId);

  const hasAgentSession = !!targetSession.agentSessionId;
  const displayId = getSessionId(targetSession);
  await sendDingMessage(self, {
    conversationId, sessionWebhook,
    content: `✅ 已切换到历史会话 (🆔 ${displayId})\n${hasAgentSession ? '🔄 已恢复对话上下文' : '⚠️ 该会话无历史上下文，将从头开始'}\n💡 回复 /end 可结束本轮对话`,
  });

  console.log(`已切换到历史会话: 群=${conversationId}, 会话ID=${displayId}, 有Claude上下文=${hasAgentSession}`);
  return true;
}

/**
 * 确保 activeSession.agent 已设置（agent 是运行时对象，无法持久化，重启或新会话都需要创建）
 */
export function ensureAgent(self: DingClaude, activeSession: IActiveSession): void {
  if (!activeSession.agent) {
    activeSession.agent = createAgent(activeSession.conversationConfig.agent || 'claude');
  }
}

export async function startNewSession(self: DingClaude, opts: {
  conversationId: string;
  sessionWebhook: string;
  senderStaffId: string;
  senderNick: string;
  message: string;
  conversationConfig: IConfig['conversations'][0];
  msgCreateAt?: number; // 消息创建时间戳（用于水印）
  msgId?: string; // 钉钉消息ID（用于 Reaction 确认）
}): Promise<void> {
  const { conversationId, sessionWebhook, senderStaffId, senderNick, message, conversationConfig, msgCreateAt, msgId } = opts;

  const maxConcurrency = self.config.sessionMaxConcurrency ?? self.DEFAULT_SESSION_MAX_CONCURRENCY;
  if (self.activeSessions.size >= maxConcurrency) {
    console.log(`达到最大并发数 (${maxConcurrency})，拒绝新会话: 群=${conversationId}`);
    await sendDingMessage(self, {
      conversationId, sessionWebhook,
      content: '🤯 当前繁忙，请稍后再试...',
    });
    return;
  }

  const now = Date.now();
  const newSessionId = crypto.randomUUID();
  const session: ISession = {
    conversationId,
    sessionWebhook,
    startTime: now,
    startTimeStr: dateUtil.mm(now).format('YYYY-MM-DD-HH-mm-ss'),
    startStaffId: senderStaffId,
    startNickName: senderNick,
  };

  console.log(`创建新会话: 群=${conversationId}, 会话ID=${newSessionId}, 发起者=${senderStaffId}, 当前并发=${self.activeSessions.size + 1}/${maxConcurrency}`);

  const sessionDir = getSessionDir(self, session);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(`${sessionDir}/session.json`, JSON.stringify(session, null, 2), 'utf-8');

  const agent = createAgent(conversationConfig.agent || 'claude');
  self.activeSessions.set(conversationId, {
    session,
    lastSenderStaffId: senderStaffId,
    isProcessing: true,
    messageQueue: [],
    conversationConfig,
    agent,
  });
  saveActiveSession(self, conversationId);

  // 水印：新会话标记进入处理中
  if (msgCreateAt) userMessageWatermark.markInFlight(conversationId, msgCreateAt);

  if (conversationConfig.receiveReply !== false && !conversationConfig.streaming) {
    await sendAckConfirmation(
      self, conversationId, sessionWebhook, conversationConfig, msgId,
      `✅ 收到，我来处理...\n🆔 ${newSessionId}`,
    );
  }

  try {
    await agent.executeQuery(self, session, {
      message,
      skill: conversationConfig.taskCfg?.skill,
      senderNick,
      senderStaffId,
      newSessionId,
    });
  } catch (err) {
    console.error('执行 Agent 查询失败:', err);
    await sendDingMessage(self, {
      conversationId, sessionWebhook, atUserId: senderStaffId,
      content: `❌ 处理消息时发生错误: ${err instanceof Error ? err.message : String(err)}`,
    });
  } finally {
    const activeSession = self.activeSessions.get(conversationId);
    if (activeSession) {
      activeSession.isProcessing = false;
    }
    // 水印：新会话处理完成
    if (msgCreateAt) userMessageWatermark.markCompleted(conversationId, msgCreateAt);
    // 处理完成，撤回确认表情
    if (conversationConfig.receiveReply !== false && !conversationConfig.streaming) {
      await recallAckReaction(self, conversationId, msgId, conversationConfig);
    }
  }
  // 检查并处理排队消息（含 /new 后的 drain）
  const finalSession = self.activeSessions.get(conversationId);
  if (finalSession && finalSession.messageQueue.length > 0) {
    await processMessageQueue(self, conversationId);
  }
}

/**
 * 处理消息队列：依次处理排队中的消息
 */
export async function processMessageQueue(self: DingClaude, conversationId: string): Promise<void> {
  const activeSession = self.activeSessions.get(conversationId);
  if (!activeSession || !activeSession.messageQueue || activeSession.messageQueue.length === 0) return;

  const entry = activeSession.messageQueue.shift()!;
  const { message, senderStaffId, senderNick, sessionWebhook, conversationId: entryConvId, enqueueTime, createAt: entryCreateAt } = entry;

  // 检查消息是否过期（超过 10 分钟跳过）
  const MAX_QUEUE_AGE_MS = 10 * 60 * 1000;
  if (Date.now() - enqueueTime > MAX_QUEUE_AGE_MS) {
    console.log(`队列消息已过期，跳过: 入队时间=${new Date(enqueueTime).toLocaleString()}, 群=${entryConvId}`);
    // 继续处理下一条
    if (activeSession.messageQueue.length > 0) {
      await processMessageQueue(self, conversationId);
    }
    return;
  }

  // 第四层：出队排水阶段时序检查
  if (entryCreateAt && userMessageWatermark.isExpired(conversationId, entryCreateAt, 'drain')) {
    console.log(`水印[跳过旧消息-排水]: 群=${entryConvId}, createAt=${entryCreateAt}`);
    // 继续处理下一条
    if (activeSession.messageQueue.length > 0) {
      await processMessageQueue(self, conversationId);
    }
    return;
  }

  console.log(`处理队列消息: 群=${entryConvId}, 剩余 ${activeSession.messageQueue.length} 条`);

  activeSession.isProcessing = true;
  activeSession.lastSenderStaffId = senderStaffId;
  saveActiveSession(self, conversationId);

  // 水印：出队标记进入处理中
  if (entryCreateAt) userMessageWatermark.markInFlight(conversationId, entryCreateAt);

  if (activeSession.conversationConfig.receiveReply !== false) {
    const preview = message.length > 50 ? message.substring(0, 50) + '…' : message;
    // 队列消息无 msgId，自动降级为文本确认
    await sendAckConfirmation(
      self, entryConvId, sessionWebhook, activeSession.conversationConfig, undefined,
      `🚀 开始处理消息「${preview}」`,
    );
  }

  try {
    ensureAgent(self, activeSession);
    const agent = activeSession.agent!;
    await agent.executeQuery(self, activeSession.session, {
      message,
      skill: activeSession.conversationConfig.taskCfg?.skill,
      senderNick,
      senderStaffId,
    });
  } catch (err) {
    console.error('执行队列 Agent 查询失败:', err);
    await sendDingMessage(self, {
      conversationId: entryConvId, sessionWebhook, atUserId: senderStaffId,
      content: ` 处理消息时发生错误: ${err instanceof Error ? err.message : String(err)}`,
    });
  } finally {
    activeSession.isProcessing = false;
    // 水印：队列消息处理完成
    if (entryCreateAt) userMessageWatermark.markCompleted(conversationId, entryCreateAt);
  }

  // goonPending: /goon 命令触发的强制重启，发送"继续"恢复执行
  if (activeSession.goonPending) {
    activeSession.goonPending = false;
    activeSession.interrupted = false;
    activeSession.isProcessing = true;
    try {
      ensureAgent(self, activeSession);
      const agent = activeSession.agent!;
      await agent.executeQuery(self, activeSession.session, {
        message: '继续',
        senderNick: activeSession.session.startNickName,
        senderStaffId: activeSession.lastSenderStaffId,
      });
    } catch (err) {
      console.error('goonPending 恢复执行失败:', err);
    } finally {
      activeSession.isProcessing = false;
    }
  }

  // 如果队列还有消息，继续处理
  if (activeSession.messageQueue && activeSession.messageQueue.length > 0) {
    await processMessageQueue(self, conversationId);
  }
}

export async function handleSessionMessage(self: DingClaude, opts: {
  conversationId: string;
  sessionWebhook: string;
  senderStaffId: string;
  senderNick: string;
  message: string;
  conversationConfig: IConfig['conversations'][0];
  msgCreateAt?: number; // 消息创建时间戳（用于水印时序检查）
  msgId?: string; // 钉钉消息ID（用于 Reaction 确认）
}): Promise<void> {
  const { conversationId, sessionWebhook, senderStaffId, senderNick, message, conversationConfig, msgCreateAt, msgId } = opts;

  // 剥离可能存在的 [提及用户: ...] 前缀，确保命令精确匹配
  const rawMessage = message.replace(/^\[提及用户: .+\]\n/, '');

  if (parseEndCommand(rawMessage)) {
    await endSession(self, conversationId, sessionWebhook);
    return;
  }

  const found = findActiveSession(self, conversationId);
  const activeSession = found?.session;

  if (activeSession) {
    const activeSessionDir = getSessionDir(self, activeSession.session);
    if (!fs.existsSync(activeSessionDir)) {
      // 目录不存在，重新创建（可能因目录重命名或清理导致）
      fs.mkdirSync(activeSessionDir, { recursive: true });
      fs.writeFileSync(`${activeSessionDir}/session.json`, JSON.stringify(activeSession.session, null, 2), 'utf-8');
      console.log(`会话目录已重建: 群=${conversationId}, 路径=${activeSessionDir}`);
    }

    if (activeSession.isProcessing) {
      // 第四层：队列阶段时序检查
      if (msgCreateAt && userMessageWatermark.isExpired(conversationId, msgCreateAt, 'queue')) {
        console.log(`水印[跳过旧消息]: 群=${conversationId}, createAt=${msgCreateAt}`);
        return;
      }

      // 正在处理中，将消息加入队列
      const queueEntry: IMessageQueueItem = {
        message, senderStaffId, senderNick,
        sessionWebhook, conversationId,
        enqueueTime: Date.now(),
        createAt: msgCreateAt || 0,
      };
      if (!activeSession.messageQueue) activeSession.messageQueue = [];
      activeSession.messageQueue.push(queueEntry);
      // 更新排队水印
      if (msgCreateAt) userMessageWatermark.markQueued(conversationId, msgCreateAt);
      const queuePos = activeSession.messageQueue.length;
      console.log(`会话 ${conversationId} 消息已入队，排队第 ${queuePos} 条`);
      await sendDingMessage(self, {
        conversationId, sessionWebhook,
        content: `⏳ 正在处理中，已加入队列（排队第 ${queuePos} 条）`,
      });
      return;
    }

    const isFromSessionOwner = activeSession.session.conversationId === conversationId;
    console.log(`追加消息到活跃会话: 群=${conversationId}, 会话ID=${getSessionId(activeSession.session)}${isFromSessionOwner ? '' : `(关联群,会话归属=${activeSession.session.conversationId})`}`);
    activeSession.lastSenderStaffId = senderStaffId;
    activeSession.isProcessing = true;
    saveActiveSession(self, found!.key);

    // 第四层：直接处理阶段时序检查
    if (msgCreateAt && userMessageWatermark.isExpired(conversationId, msgCreateAt, 'process')) {
      console.log(`水印[跳过旧消息-直接处理]: 群=${conversationId}, createAt=${msgCreateAt}`);
      activeSession.isProcessing = false;
      await processMessageQueue(self, conversationId);
      return;
    }
    // 标记进入处理中状态
    if (msgCreateAt) userMessageWatermark.markInFlight(conversationId, msgCreateAt);

    // 同群消息刷新sessionWebhook，关联群消息只更新currentWebhook/currentConversationId
    if (isFromSessionOwner && sessionWebhook !== activeSession.session.sessionWebhook) {
      activeSession.session.sessionWebhook = sessionWebhook;
      updateSessionFile(self, activeSession.session, { sessionWebhook });
    }
    // 始终更新提问来源信息，确保回复到正确的群
    activeSession.session.currentWebhook = sessionWebhook;
    activeSession.session.currentConversationId = conversationId;
    updateSessionFile(self, activeSession.session, { currentWebhook: sessionWebhook, currentConversationId: conversationId });

    if (conversationConfig.receiveReply !== false && !conversationConfig.streaming) {
      await sendAckConfirmation(
        self, conversationId, sessionWebhook, conversationConfig, msgId,
        '✅ 收到，我来处理...',
      );
    }

    try {
      ensureAgent(self, activeSession);
      const agent = activeSession.agent!;
      await agent.executeQuery(self, activeSession.session, {
        message,
        skill: conversationConfig.taskCfg?.skill,
        senderNick,
        senderStaffId,
      });
    } catch (err) {
      // 恢复会话失败（可能会话已失效），清除 agentSessionId 重新发起一次
      if (activeSession.session.agentSessionId) {
        console.log(`[会话恢复失败] 清除 agentSessionId 并重新发起: ${activeSession.session.agentSessionId}`);
        activeSession.session.agentSessionId = undefined;
        self.updateSessionFile(activeSession.session, {});
        try {
          ensureAgent(self, activeSession);
          const agent = activeSession.agent!;
          await agent.executeQuery(self, activeSession.session, {
            message,
            skill: conversationConfig.taskCfg?.skill,
            senderNick,
            senderStaffId,
          });
          return;
        } catch (retryErr) {
          console.error('重试执行 Agent 查询失败:', retryErr);
          await sendDingMessage(self, {
            conversationId, sessionWebhook, atUserId: senderStaffId,
            content: `❌ 处理消息时发生错误: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`,
          });
          activeSession.isProcessing = false;
          await processMessageQueue(self, conversationId);
          return;
        }
      }
      console.error('执行 Agent 查询失败:', err);
      await sendDingMessage(self, {
        conversationId, sessionWebhook, atUserId: senderStaffId,
        content: ` 处理消息时发生错误: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      activeSession.isProcessing = false;
      // 水印：标记处理完成
      if (msgCreateAt) userMessageWatermark.markCompleted(conversationId, msgCreateAt);
      // 处理完成，撤回确认表情
      if (conversationConfig.receiveReply !== false && !conversationConfig.streaming) {
        await recallAckReaction(self, conversationId, msgId, conversationConfig);
      }
    }
    // 检查并处理排队消息
    await processMessageQueue(self, conversationId);
  } else {
    await startNewSession(self, {
      conversationId, sessionWebhook, senderStaffId, senderNick, message, conversationConfig,
    });
  }
}

// ==================== 缓存清理 ====================

export interface ICleanResult {
  sessionsDeleted: number;
  tasksDeleted: number;
  imagesDeleted: number;
  errors: string[];
}

/**
 * 清除历史会话和缓存（包括 .sessions, .tasks, .images）
 * @param conversationId 群会话ID，传入 null 表示清除所有群
 * @param keepActiveSession 是否保留活跃会话（true=保留，false=全部清除）
 */
export function cleanCache(self: DingClaude, conversationId: string | null, keepActiveSession = true): ICleanResult {
  const result: ICleanResult = {
    sessionsDeleted: 0,
    tasksDeleted: 0,
    imagesDeleted: 0,
    errors: [],
  };

  const targetConversations = conversationId
    ? [ conversationId ]
    : self.config.conversations.map(c => c.conversationId);

  for (const convId of targetConversations) {
    // 获取活跃会话ID（保留用）
    let activeSessionId: string | null = null;
    if (keepActiveSession) {
      const activeFound = findActiveSession(self, convId);
      if (activeFound) {
        activeSessionId = getSessionId(activeFound.session.session);
      }
    }

    // 清除 .sessions（保留活跃会话）
    const sessionsDir = getSessionsDir(self, convId);
    if (fs.existsSync(sessionsDir)) {
      try {
        const entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          // 跳过活跃会话
          if (activeSessionId && entry.name === activeSessionId) continue;
          const dirPath = path.join(sessionsDir, entry.name);
          try {
            fs.rmSync(dirPath, { recursive: true, force: true });
            result.sessionsDeleted++;
          } catch (e) {
            result.errors.push(`删除会话目录失败: ${dirPath}`);
          }
        }
      } catch (e) {
        result.errors.push(`读取sessions目录失败: ${sessionsDir}`);
      }
    }

    // 清除 .tasks
    const tasksDir = getTasksDir(self, convId);
    if (fs.existsSync(tasksDir)) {
      try {
        const entries = fs.readdirSync(tasksDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const dirPath = path.join(tasksDir, entry.name);
          try {
            fs.rmSync(dirPath, { recursive: true, force: true });
            result.tasksDeleted++;
          } catch (e) {
            result.errors.push(`删除任务目录失败: ${dirPath}`);
          }
        }
      } catch (e) {
        result.errors.push(`读取tasks目录失败: ${tasksDir}`);
      }
    }

    // 清除 .images
    const imagesDir = getImagesDir(self, convId);
    if (fs.existsSync(imagesDir)) {
      try {
        const entries = fs.readdirSync(imagesDir, { withFileTypes: true });
        for (const entry of entries) {
          const filePath = path.join(imagesDir, entry.name);
          try {
            fs.unlinkSync(filePath);
            result.imagesDeleted++;
          } catch (e) {
            result.errors.push(`删除图片失败: ${filePath}`);
          }
        }
      } catch (e) {
        result.errors.push(`读取images目录失败: ${imagesDir}`);
      }
    }

    // 清除 .playwright-cli
    const playwrightDir = path.join(getConversationDir(self, convId), '.playwright-cli');
    if (fs.existsSync(playwrightDir)) {
      try {
        fs.rmSync(playwrightDir, { recursive: true, force: true });
      } catch (e) {
        result.errors.push(`删除 playwright-cli 缓存失败: ${playwrightDir}`);
      }
    }

    // 仅清理活跃会话持久化文件（不删除内存中的活跃会话）
    if (!keepActiveSession) {
      const activeFile = getActiveSessionsFile(self, convId);
      if (fs.existsSync(activeFile)) {
        try {
          fs.unlinkSync(activeFile);
        } catch (e) {
          result.errors.push(`删除活跃会话文件失败: ${activeFile}`);
        }
      }
      // 从内存中移除该群的活跃会话
      if (self.activeSessions.has(convId)) {
        self.activeSessions.delete(convId);
      }
    }
  }

  return result;
}

// ==================== 群销毁 ====================

export interface IDestroyResult {
  success: boolean;
  steps: Array<{ label: string; ok: boolean; detail?: string }>;
}

/**
 * 完整清理指定会话的所有数据
 */
export async function destroyConversation(self: DingClaude, conversationId: string): Promise<IDestroyResult> {
  const steps: Array<{ label: string; ok: boolean; detail?: string }> = [];
  const convCfg = self.getConversationConfig(conversationId);
  const hasLinkConv = !!convCfg?.linkConversationId;

  // 1. 停止该会话的活跃 Claude 进程
  const activeSession = self.activeSessions.get(conversationId);
  if (activeSession?.currentProcess) {
    try { activeSession.currentProcess.kill('SIGTERM'); } catch { /* ignore */ }
  }
  self.activeSessions.delete(conversationId);
  steps.push({ label: '停止活跃会话', ok: true, detail: activeSession ? '已清除' : '无活跃会话' });

  // 2. 清理定时任务 (cronEngine)
  try {
    const cronJobs = self.cronEngine?.listJobs(conversationId) || [];
    let removed = 0;
    for (const job of cronJobs) {
      if (self.cronEngine?.removeJob(job.id)) removed++;
    }
    steps.push({ label: '清理定时任务', ok: true, detail: `移除 ${removed} 个` });
  } catch (err) {
    steps.push({ label: '清理定时任务', ok: false, detail: err instanceof Error ? err.message : String(err) });
  }

  // 3. 清理 Todo 数据
  try {
    const todoFile = path.join(getClientDir(self), 'todo.json');
    if (fs.existsSync(todoFile)) {
      const data = fileUtil.getJSON(todoFile) as { conversations?: Record<string, unknown[]> };
      if (data?.conversations?.[conversationId]) {
        delete data.conversations[conversationId];
        fs.writeFileSync(todoFile, JSON.stringify(data, null, 2), 'utf-8');
      }
    }
    steps.push({ label: '清理 Todo 数据', ok: true });
  } catch (err) {
    steps.push({ label: '清理 Todo 数据', ok: false, detail: err instanceof Error ? err.message : String(err) });
  }

  // 4. 清理快捷菜单数据
  try {
    const menuFile = path.join(getClientDir(self), 'menu.json');
    if (fs.existsSync(menuFile)) {
      const data = fileUtil.getJSON(menuFile) as { user?: Record<string, unknown> };
      if (data?.user) {
        const keysToDelete = Object.keys(data.user).filter(k => k.startsWith(`${conversationId}:`));
        for (const k of keysToDelete) delete data.user[k];
        fs.writeFileSync(menuFile, JSON.stringify(data, null, 2), 'utf-8');
      }
    }
    steps.push({ label: '清理快捷菜单', ok: true });
  } catch (err) {
    steps.push({ label: '清理快捷菜单', ok: false, detail: err instanceof Error ? err.message : String(err) });
  }

  // 5. 清理延时任务 (timerEngine)
  try {
    const timers = self.timerEngine?.listTimers(conversationId) || [];
    let removed = 0;
    for (const t of timers) {
      if (self.timerEngine?.removeTimer(t.id)) removed++;
    }
    steps.push({ label: '清理延时任务', ok: true, detail: `移除 ${removed} 个` });
  } catch (err) {
    steps.push({ label: '清理延时任务', ok: false, detail: err instanceof Error ? err.message : String(err) });
  }

  // 6. 清理会话工作目录（关联群不删除关联目录）
  try {
    const convDir = getConversationDir(self, conversationId);
    if (fs.existsSync(convDir)) {
      fs.rmSync(convDir, { recursive: true, force: true });
      steps.push({ label: '删除工作目录', ok: true });
    } else {
      steps.push({ label: '删除工作目录', ok: true, detail: '目录不存在' });
    }
    // 如果有 linkConversationId，不删除关联目录
    if (hasLinkConv) {
      steps.push({ label: '关联目录', ok: true, detail: `保留 (linkConversationId=${convCfg!.linkConversationId})` });
    }
  } catch (err) {
    steps.push({ label: '删除工作目录', ok: false, detail: err instanceof Error ? err.message : String(err) });
  }

  // 7. 从 config.conversations 中移除该会话
  const convIndex = self.config.conversations.findIndex(c => c.conversationId === conversationId);
  if (convIndex >= 0) {
    self.config.conversations.splice(convIndex, 1);
    steps.push({ label: '移除配置', ok: true });
  } else {
    steps.push({ label: '移除配置', ok: true, detail: '未在配置中找到' });
  }

  // 8. 移除活跃会话持久化
  try {
    saveActiveSession(self, conversationId);
    steps.push({ label: '清理持久化文件', ok: true });
  } catch (err) {
    steps.push({ label: '清理持久化文件', ok: false, detail: err instanceof Error ? err.message : String(err) });
  }

  // 持久化配置
  try {
    const { saveClientConfig } = require('./api-key-manager');
    saveClientConfig(self);
  } catch (err) {
    console.error(`[${timestamp()}] 销毁后保存配置失败:`, err);
  }

  const allOk = steps.every(s => s.ok);
  return { success: allOk, steps };
}
