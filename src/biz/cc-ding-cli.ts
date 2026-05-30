import { exec as childExec } from 'child_process';
import { DingStreamClient, DWClientDownStream, dateUtil } from 'utils-ok';
import fs from 'fs';
import path from 'path';
import { projUtil } from '../common';
import { IConfig, IActiveSession, ISession, IRawCallbackData, IAuthRequest } from './types';
import { extractQuoteInfo, formatPromptWithQuote } from './quote';
import { fetchQuotedMessage, sendMessageToUser, sendOwnerMessage } from './messaging';
import { processPictureMessage, processRichTextMessage } from './image';
import {
  parseInfoCommand, formatConversationInfo, formatGlobalConfig, parseLogCommand,
  parseLsCommand, findSubdirByName, getDirectoryStructure,
  parseContinueSessionCommand, parseHelpCommand, parseCommandHelp,
  getCommandByName, formatHelpOverview, formatCommandHelp,
  parseCronCommand, parsePwdCommand, parseMkdirCommand, parseTouchCommand, parseRmCommand,
  parseVersionCommand, parseOpenCommand, parseCleanCommand, parseResetApiKeyCfgCommand, parseCfgCommand, parseAuthCommand,
  parseBashCommand, parseMqCommand, parseRecorderCommand,
  parseGoonCommand, parseCcCommand, parseClaudeMdCommand,
} from './commands';
import { sendDingMessage, sendClaudeResponseToDing } from './messaging';
import { parseClaudeStreamLine, interruptClaudeProcess, executeClaudeQuery } from './claude-process';
import { recordMessage, getRecorderDir } from './recorder';
import {
  getClientDir, getClientConfig, authCheck, isOwner, debugLog,
  hashConversationId, getConversationConfig,
  getConversationDir, getSessionsDir, getTasksDir,
  getSessionDir, getSessionId, formatSessionInfo, readSessionLogTail,
  findHistorySession, findLatestSession, updateSessionFile, appendSessionLog,
  getActiveSessionsFile, saveActiveSession, loadActiveSessions,
  endSession, switchToSession, startNewSession, handleSessionMessage,
  findActiveSession, cleanCache,
  timestamp,
  resolveAllPhonesInConfig, resolveUserId, resolveToUserId, userIdToPhone, isMobile,
} from './session';
import {
  countTodoTask, getOneTodoTask, finishTask,
  handleTask, runTaskHandlerLoop, saveTask, formatTaskInfo,
  cancelTask, parseTaskCancelCommand,
} from './task';
import { resetApiKeyCfg, scheduleApiKeyCfgDailyReset, startupCheck, saveClientConfig } from './api-key-manager';
import { CronEngine, formatCronJobList, formatCronJobInfo, isValidCronExpression } from './cron';

/** 工具版本号 */
const TOOL_VERSION = projUtil().getPkgVersion();

/**
 * 钉钉 Claude Code 机器人
 * 支持 session 模式（多轮对话）和 task 模式（任务队列）
 */
export class DingClaude {
  clientId: string;
  config: IConfig;
  dingStreamClient: DingStreamClient;

  /** 运行时手机号 → userId 映射（用于鉴权，不写入 config.json） */
  resolvedPhones: Record<string, string> = {};

  /** 活跃会话管理 (session模式) */
  activeSessions = new Map<string, IActiveSession>();

  /** 待审批的授权申请 */
  pendingAuthRequests = new Map<string, IAuthRequest>();

  /** Recorder 模式已开启的会话 ID 集合（运行时状态，不持久化） */
  recorderModeConversations = new Set<string>();

  /** 定时任务引擎 */
  cronEngine!: CronEngine;

  /** 默认最大并发会话数 */
  readonly DEFAULT_SESSION_MAX_CONCURRENCY = 5;
  /** 默认任务处理器数量 */
  readonly DEFAULT_TASK_HANDLER_COUNT = 1;
  /** 默认任务队列大小 */
  readonly DEFAULT_TASK_QUEUE_SIZE = 50;

  constructor(clientId: string) {
    this.clientId = clientId;
    this.config = getClientConfig(this);
    try {
      this.dingStreamClient = new DingStreamClient({
        clientId,
        clientSecret: this.config.clientSecret,
        keepAlive: true,
        debug: this.config.debug ?? false,
      });
    } catch (err) {
      console.error('Error: DingStreamClient init failed.', err);
      process.exit(1);
    }
    // 在 clientId 和 config 初始化完成后再创建 CronEngine
    this.cronEngine = new CronEngine(this);
  }

  // ==================== 委托方法 ====================

  // messaging
  sendDingMessage = (opts: import('./types').ISendMsgOpts) => sendDingMessage(this, opts);
  sendClaudeResponseToDing = (conversationId: string, sessionWebhook: string, atUserId: string, content: string) =>
    sendClaudeResponseToDing(this, conversationId, sessionWebhook, atUserId, content);
  sendMessageToUser = (userId: string, content: string, msgType?: 'text' | 'markdown') =>
    sendMessageToUser(this, userId, content, msgType);
  sendOwnerMessage = (content: string, msgType?: 'text' | 'markdown') =>
    sendOwnerMessage(this, content, msgType);

  // quote / image / session
  extractQuoteInfo = extractQuoteInfo;
  fetchQuotedMessage = (quoteInfo: import('./quote').IQuoteInfo) => fetchQuotedMessage(this, quoteInfo);
  processPictureMessage = (data: IRawCallbackData) => processPictureMessage(this, data);
  processRichTextMessage = (data: IRawCallbackData) => processRichTextMessage(this, data);

  // session management
  getConversationDir = (conversationId: string) => getConversationDir(this, conversationId);
  getConversationConfig = (conversationId: string) => getConversationConfig(this, conversationId);
  getSessionDir = (session: ISession) => getSessionDir(this, session);
  findHistorySession = (conversationId: string, sessionId: string) => findHistorySession(this, conversationId, sessionId);
  findLatestSession = (conversationId: string) => findLatestSession(this, conversationId);
  findActiveSession = (conversationId: string) => findActiveSession(this, conversationId);

  // session helpers (委托给 session.ts 的实现)
  updateSessionFile(session: ISession, updates: Partial<ISession>) { updateSessionFile(this, session, updates); }
  appendSessionLog(sessionDir: string, role: string, content: string) { appendSessionLog(this, sessionDir, role, content); }
  getSessionsDir(conversationId: string) { return getSessionsDir(this, conversationId); }
  getTasksDir(conversationId: string) { return getTasksDir(this, conversationId); }
  getSessionId(conversationId: string, sessionDir: string) { return getSessionId(this, conversationId, sessionDir); }
  formatSessionInfo(conversationId: string, sessionDir: string) { return formatSessionInfo(this, conversationId, sessionDir); }
  readSessionLogTail(conversationId: string, lines: number = 10) { return readSessionLogTail(this, conversationId, lines); }
  startNewSession(opts: { conversationId: string; sessionWebhook: string; senderStaffId: string; senderNick: string; taskMode?: boolean }) { return startNewSession(this, opts); }
  endSession(opts: { conversationId: string; senderStaffId?: string }) { return endSession(this, opts); }
  switchToSession(opts: { conversationId: string; sessionId: string }) { return switchToSession(this, opts); }
  handleSessionMessage(opts: { conversationId: string; sessionWebhook: string; senderStaffId: string; senderNick: string; message: string; conversationConfig?: IConfig['conversations'][0] }) { return handleSessionMessage(this, opts); }
  cleanCache(conversationId: string, cleanType: string, senderStaffId: string) { return cleanCache(this, conversationId, cleanType, senderStaffId); }
  resolveUserId = (identifier: string) => resolveUserId(this, identifier);
  resolveToUserId = (identifier: string) => resolveToUserId(this, identifier);
  userIdToPhone = (userId: string) => userIdToPhone(this, userId);
  isMobile = isMobile;

  // 便捷封装
  isOwner = (userId: string) => isOwner(this, userId);
  executeClaudeQuery = (session: ISession, message: string, opts?: { skill?: string; agent?: string; senderNick?: string; senderStaffId?: string }) =>
    executeClaudeQuery(this, session, message, opts);
  interruptClaudeProcess = (activeSession: IActiveSession, logReason: string) =>
    interruptClaudeProcess(activeSession, logReason);

  // ==================== 核心处理 ====================

  /**
   * Owner 权限检查，非 owner 时发送提示消息并返回 false
   */
  private async requireOwner(conversationId: string, sessionWebhook: string, senderStaffId: string): Promise<boolean> {
    if (!this.isOwner(senderStaffId)) {
      await this.sendDingMessage({
        conversationId,
        sessionWebhook,
        content: '❌ 只有机器人 owner 才能执行此操作',
        msgType: 'markdown',
      });
      return false;
    }
    return true;
  }

  /**
   * Owner 或单聊模式权限检查
   * 单聊已注册时允许非 owner 操作（仅限当前单聊）
   */
  private async requireOwnerOrSingleChat(
    conversationId: string,
    sessionWebhook: string,
    senderStaffId: string,
    conversationConfig: IConfig['conversations'][0],
  ): Promise<boolean> {
    if (this.isOwner(senderStaffId)) return true;
    if (conversationConfig?.conversationType === '1') return true;
    await this.sendDingMessage({
      conversationId,
      sessionWebhook,
      content: '❌ 只有机器人 owner 才能执行此操作',
      msgType: 'markdown',
    });
    return false;
  }

  /**
   * 处理未授权用户的授权申请
   */
  private async handleAuthRequest(opts: {
    senderStaffId: string;
    senderNick: string;
    conversationId: string;
    conversationType?: string;
    conversationTitle?: string;
    sessionWebhook: string;
  }): Promise<void> {
    const { senderStaffId, senderNick, conversationId, conversationType, conversationTitle, sessionWebhook } = opts;
    const existingConv = this.config.conversations.find(c => c.conversationId === conversationId);
    // 已注册群不需要授权
    if (existingConv && conversationType !== '1') {
      await this.sendDingMessage({
        conversationId,
        sessionWebhook,
        content: '❌ 当前群已注册，无需授权',
        msgType: 'markdown',
      });
      return;
    }
    // 检查是否已有待审批申请
    for (const [reqId, req] of this.pendingAuthRequests.entries()) {
      if (req.conversationId === conversationId && req.requesterStaffId === senderStaffId) {
        await this.sendDingMessage({
          conversationId,
          sessionWebhook,
          content: `⏳ 您已有待审批的授权申请（ID: ${reqId}），请等待 owner 处理`,
          msgType: 'markdown',
        });
        return;
      }
    }
    // 创建授权申请
    const requestId = generateRequestId();
    const authRequest: IAuthRequest = {
      requestId,
      conversationId,
      conversationType,
      conversationTitle,
      requesterStaffId: senderStaffId,
      requesterNick: senderNick,
      timestamp: Date.now(),
    };
    this.pendingAuthRequests.set(requestId, authRequest);
    await this.sendDingMessage({
      conversationId,
      sessionWebhook,
      content: `✅ 授权申请已提交，请等待 owner 审批\n申请 ID: ${requestId}`,
      msgType: 'markdown',
    });
    // 通知 owner
    if (this.config.ownerConversationId) {
      await this.sendOwnerMessage(
        `📋 收到新的授权申请\n申请人: ${senderNick}(${senderStaffId})\n群: ${conversationTitle || conversationId}\n审批: /auth approve ${requestId}\n拒绝: /auth reject ${requestId}`,
        'markdown',
      );
    }
  }

  /**
   * 处理钉钉 webhook 回调
   */
  async handleWebhookCallback(
    data: IRawCallbackData,
    sessionWebhook: string,
  ): Promise<void> {
    const {
      senderStaffId,
      senderNick,
      conversationId,
      conversationType,
      conversationTitle,
      msgtype,
    } = data;

    const conversationConfig = getConversationConfig(this, conversationId);

    // 权限检查：未注册用户直接返回提示
    if (!authCheck(this, conversationId, senderStaffId)) {
      // 未注册用户，提示申请授权
      await this.handleAuthRequest({
        senderStaffId,
        senderNick,
        conversationId,
        conversationType,
        conversationTitle,
        sessionWebhook,
      });
      return;
    }

    let prompt: string | null = null;
    const quoteInfo = extractQuoteInfo(data);

    // 根据消息类型提取 prompt
    if (msgtype === 'text') {
      prompt = (data.text as { content?: string })?.content?.trim() ?? null;
    } else if (msgtype === 'richText') {
      // 提取图片/文件等富文本信息
      const { richTextList } = data as IRawCallbackData;
      if (richTextList && richTextList.length > 0) {
        const firstPara = richTextList[0];
        if (firstPara.type === 'text') {
          prompt = firstPara.text?.trim() ?? null;
        }
      }
    }

    if (!prompt) {
      this.debugLog(`忽略空消息: ${conversationId}`);
      return;
    }

    // 处理引用消息（获取引用内容）
    if (quoteInfo && conversationConfig?.quoteFetchEnabled !== false) {
      const fetched = await this.fetchQuotedMessage(quoteInfo);
      if (fetched) quoteInfo.quoteText = fetched;
    }
    // 注入引用上下文到 prompt
    if (quoteInfo?.quoteText) {
      prompt = formatPromptWithQuote(prompt, quoteInfo);
    }

    // /cfg 命令
    const cfgOpts = parseCfgCommand(prompt);
    if (cfgOpts !== null) {
      // 指定 --conversationId 无条件要求 owner
      if (cfgOpts.conversationId && !this.isOwner(senderStaffId)) {
        await this.sendDingMessage({
          conversationId, sessionWebhook,
          content: '❌ 只有机器人 owner 才能操作其他群的配置',
          msgType: 'markdown',
        });
        return;
      }
      if (!(await this.requireOwnerOrSingleChat(conversationId, sessionWebhook, senderStaffId, conversationConfig))) return;

      const targetConvId = cfgOpts.conversationId || conversationId;
      const isTargetOther = targetConvId !== conversationId;
      const existingConv = isTargetOther
        ? this.config.conversations.find(c => c.conversationId === targetConvId)
        : conversationConfig;

      const hasUpdates = !!(cfgOpts.dingToken || cfgOpts.linkConversationId ||
        (cfgOpts.whiteUserList && cfgOpts.whiteUserList.length > 0) || cfgOpts.conversationTitle ||
        cfgOpts.atSender !== undefined || cfgOpts.receiveReply !== undefined || cfgOpts.preBash !== undefined);

      if (existingConv && hasUpdates) {
        const updated: string[] = [];
        if (cfgOpts.dingToken) { existingConv.dingToken = cfgOpts.dingToken; updated.push('dingToken'); }
        if (cfgOpts.linkConversationId) { existingConv.linkConversationId = cfgOpts.linkConversationId; updated.push('linkConversationId'); }
        if (cfgOpts.whiteUserList && cfgOpts.whiteUserList.length > 0) { existingConv.whiteUserList = cfgOpts.whiteUserList; updated.push('whiteUserList'); }
        if (cfgOpts.conversationTitle) { existingConv.conversationTitle = cfgOpts.conversationTitle; updated.push('conversationTitle'); }
        if (cfgOpts.atSender !== undefined) { existingConv.atSender = cfgOpts.atSender; updated.push(`atSender=${cfgOpts.atSender}`); }
        if (cfgOpts.receiveReply !== undefined) { existingConv.receiveReply = cfgOpts.receiveReply; updated.push(`receiveReply=${cfgOpts.receiveReply}`); }
        if (cfgOpts.preBash !== undefined) { existingConv.preBash = cfgOpts.preBash; updated.push('preBash'); }

        saveClientConfig(this.clientId, this.config);
        await this.sendDingMessage({
          conversationId, sessionWebhook,
          content: `✅ 已更新: ${updated.join(', ')}`,
          msgType: 'markdown',
        });
      } else if (!existingConv && (cfgOpts.dingToken || cfgOpts.conversationTitle)) {
        const newConv: IConfig['conversations'][0] = {
          conversationId: targetConvId,
          conversationType: conversationType,
          conversationTitle: cfgOpts.conversationTitle || conversationTitle || '未命名群',
          dingToken: cfgOpts.dingToken,
          linkConversationId: cfgOpts.linkConversationId,
          whiteUserList: cfgOpts.whiteUserList || [],
          atSender: cfgOpts.atSender ?? true,
          receiveReply: cfgOpts.receiveReply ?? true,
        };
        if (cfgOpts.preBash !== undefined) newConv.preBash = cfgOpts.preBash;
        this.config.conversations.push(newConv);
        saveClientConfig(this.clientId, this.config);
        await this.sendDingMessage({
          conversationId, sessionWebhook,
          content: `✅ 已将当前群注册到配置`,
          msgType: 'markdown',
        });
      } else if (!existingConv && !cfgOpts.dingToken) {
        await this.sendDingMessage({
          conversationId, sessionWebhook,
          content: '❌ 未注册的群需要提供 --dingToken 参数',
          msgType: 'markdown',
        });
      } else {
        await this.sendDingMessage({
          conversationId, sessionWebhook,
          content: '⚠️ 当前群已注册，如需刷新请使用: /cfg --字段名 新值',
          msgType: 'markdown',
        });
      }
      return;
    }

    // /info 命令
    if (parseInfoCommand(prompt)) {
      const info = conversationConfig
        ? formatConversationInfo(this.config, conversationConfig)
        : formatGlobalConfig(this.config);
      await this.sendDingMessage({
        conversationId, sessionWebhook,
        content: info,
        msgType: 'markdown',
      });
      return;
    }

    // /auth 命令
    const authOpts = parseAuthCommand(prompt);
    if (authOpts !== null) {
      if (!(await this.requireOwner(conversationId, sessionWebhook, senderStaffId))) return;
      if (authOpts.type === 'approve') {
        const req = this.pendingAuthRequests.get(authOpts.requestId!);
        if (!req) {
          await this.sendDingMessage({ conversationId, sessionWebhook, content: `❌ 未找到授权申请: ${authOpts.requestId}`, msgType: 'markdown' });
          return;
        }
        const conv = this.config.conversations.find(c => c.conversationId === req.conversationId);
        if (conv) {
          if (!conv.whiteUserList.includes(req.requesterStaffId)) conv.whiteUserList.push(req.requesterStaffId);
        } else {
          const newConv: IConfig['conversations'][0] = {
            conversationId: req.conversationId, conversationType: req.conversationType,
            conversationTitle: req.conversationTitle || '未命名群', whiteUserList: [req.requesterStaffId],
            atSender: true, receiveReply: true,
          };
          this.config.conversations.push(newConv);
        }
        this.pendingAuthRequests.delete(authOpts.requestId!);
        saveClientConfig(this.clientId, this.config);
        await this.sendOwnerMessage(`✅ 已批准 ${req.requesterNick}(${req.requesterStaffId}) 的授权申请`, 'text');
        await this.sendDingMessage({ conversationId, sessionWebhook, content: `✅ 已批准授权申请: ${req.requesterNick}(${req.requesterStaffId})`, msgType: 'markdown' });
        return;
      }
      if (authOpts.type === 'reject') {
        const req = this.pendingAuthRequests.get(authOpts.requestId!);
        if (!req) {
          await this.sendDingMessage({ conversationId, sessionWebhook, content: `❌ 未找到授权申请: ${authOpts.requestId}`, msgType: 'markdown' });
          return;
        }
        this.pendingAuthRequests.delete(authOpts.requestId!);
        await this.sendDingMessage({ conversationId, sessionWebhook, content: `❌ 已拒绝授权申请: ${authOpts.requestId}`, msgType: 'markdown' });
        return;
      }
      if (authOpts.type === 'add') {
        const resolvedId = this.resolveUserId(authOpts.staffId!);
        const conv = conversationConfig || this.config.conversations.find(c => c.conversationId === conversationId);
        if (conv) {
          if (!conv.whiteUserList.includes(resolvedId)) {
            conv.whiteUserList.push(resolvedId);
            saveClientConfig(this.clientId, this.config);
            await this.sendDingMessage({ conversationId, sessionWebhook, content: `✅ 已添加用户: ${resolvedId}`, msgType: 'markdown' });
          } else {
            await this.sendDingMessage({ conversationId, sessionWebhook, content: `⚠️ 用户已在白名单中: ${resolvedId}`, msgType: 'markdown' });
          }
        }
        return;
      }
      if (authOpts.type === 'del') {
        const resolvedId = this.resolveUserId(authOpts.staffId!);
        const conv = conversationConfig || this.config.conversations.find(c => c.conversationId === conversationId);
        if (conv) {
          const idx = conv.whiteUserList.indexOf(resolvedId);
          if (idx >= 0) {
            conv.whiteUserList.splice(idx, 1);
            saveClientConfig(this.clientId, this.config);
            await this.sendDingMessage({ conversationId, sessionWebhook, content: `✅ 已移除用户: ${resolvedId}`, msgType: 'markdown' });
          } else {
            await this.sendDingMessage({ conversationId, sessionWebhook, content: `⚠️ 用户不在白名单中: ${resolvedId}`, msgType: 'markdown' });
          }
        }
        return;
      }
    }

    // /ls 命令
    if (parseLsCommand(prompt)) {
      const sessions = findHistorySession(this, conversationId, '');
      if (sessions.length === 0) {
        await this.sendDingMessage({ conversationId, sessionWebhook, content: '📋 当前群没有历史会话记录', msgType: 'markdown' });
        return;
      }
      const info = sessions.map(s => formatSessionInfo(this, conversationId, this.getSessionDir(s))).join('\n\n');
      await this.sendDingMessage({ conversationId, sessionWebhook, content: `📋 历史会话\n\n${info}`, msgType: 'markdown' });
      return;
    }

    // /log 命令
    const logOpts = parseLogCommand(prompt);
    if (logOpts !== null) {
      const lines = logOpts.lines || 10;
      const log = readSessionLogTail(this, conversationId, lines);
      await this.sendDingMessage({ conversationId, sessionWebhook, content: `📄 最近 ${lines} 条日志\n\n\`\`\`\n${log}\n\`\`\``, msgType: 'markdown' });
      return;
    }

    // /pwd 命令
    if (parsePwdCommand(prompt)) {
      const sessionDir = this.getSessionDir({ conversationId, sessionWebhook } as ISession);
      await this.sendDingMessage({ conversationId, sessionWebhook, content: `📂 ${sessionDir}`, msgType: 'markdown' });
      return;
    }

    // /mkdir 命令
    const mkdirOpts = parseMkdirCommand(prompt);
    if (mkdirOpts !== null) {
      const sessionDir = this.getSessionDir({ conversationId, sessionWebhook } as ISession);
      const dirPath = path.join(sessionDir, mkdirOpts);
      fs.mkdirSync(dirPath, { recursive: true });
      await this.sendDingMessage({ conversationId, sessionWebhook, content: `✅ 已创建: ${dirPath}`, msgType: 'markdown' });
      return;
    }

    // /touch 命令
    const touchOpts = parseTouchCommand(prompt);
    if (touchOpts !== null) {
      const sessionDir = this.getSessionDir({ conversationId, sessionWebhook } as ISession);
      const filePath = path.join(sessionDir, touchOpts);
      fs.writeFileSync(filePath, '', 'utf-8');
      await this.sendDingMessage({ conversationId, sessionWebhook, content: `✅ 已创建: ${filePath}`, msgType: 'markdown' });
      return;
    }

    // /rm 命令
    const rmOpts = parseRmCommand(prompt);
    if (rmOpts !== null) {
      const sessionDir = this.getSessionDir({ conversationId, sessionWebhook } as ISession);
      const targetPath = path.join(sessionDir, rmOpts.path);
      if (!targetPath.startsWith(sessionDir)) {
        await this.sendDingMessage({ conversationId, sessionWebhook, content: '❌ 不允许删除当前会话目录外的文件', msgType: 'markdown' });
        return;
      }
      if (!fs.existsSync(targetPath)) {
        await this.sendDingMessage({ conversationId, sessionWebhook, content: `⚠️ 文件/目录不存在: ${rmOpts.path}`, msgType: 'markdown' });
        return;
      }
      fs.rmSync(targetPath, { recursive: rmOpts.recursive, force: true });
      await this.sendDingMessage({ conversationId, sessionWebhook, content: `✅ 已删除: ${rmOpts.path}`, msgType: 'markdown' });
      return;
    }

    // /open 命令
    const openOpts = parseOpenCommand(prompt);
    if (openOpts !== null) {
      const sessionDir = this.getSessionDir({ conversationId, sessionWebhook } as ISession);
      const filePath = path.join(sessionDir, openOpts);
      if (!fs.existsSync(filePath)) {
        await this.sendDingMessage({ conversationId, sessionWebhook, content: `⚠️ 文件不存在: ${openOpts}`, msgType: 'markdown' });
        return;
      }
      const content = fs.readFileSync(filePath, 'utf-8');
      const truncated = content.length > 8000 ? content.substring(0, 8000) + '\n...(内容过长已截断)' : content;
      await this.sendDingMessage({ conversationId, sessionWebhook, content: `📄 ${openOpts}\n\n\`\`\`\n${truncated}\n\`\`\``, msgType: 'markdown' });
      return;
    }

    // /version 命令
    if (parseVersionCommand(prompt)) {
      await this.sendDingMessage({ conversationId, sessionWebhook, content: `📦 版本信息\n\n- 工具版本: v${TOOL_VERSION}\n- Node.js: ${process.version}\n- 平台: ${process.platform}`, msgType: 'markdown' });
      return;
    }

    // /clean 命令
    const cleanOpts = parseCleanCommand(prompt);
    if (cleanOpts !== null) {
      if (!(await this.requireOwnerOrSingleChat(conversationId, sessionWebhook, senderStaffId, conversationConfig))) return;
      const result = await this.cleanCache(conversationId, cleanOpts.cleanType || 'all', senderStaffId);
      await this.sendDingMessage({ conversationId, sessionWebhook, content: result, msgType: 'markdown' });
      return;
    }

    // /reset-api-key-cfg 命令
    if (parseResetApiKeyCfgCommand(prompt)) {
      if (!(await this.requireOwner(conversationId, sessionWebhook, senderStaffId))) return;
      resetApiKeyCfg(this);
      await this.sendDingMessage({ conversationId, sessionWebhook, content: '✅ 已重置 API Key 配置', msgType: 'markdown' });
      return;
    }

    // /bash 命令
    const bashOpts = parseBashCommand(prompt);
    if (bashOpts !== null) {
      try {
        const { stdout, stderr } = await util.promisify(childExec)(bashOpts, { cwd: this.getSessionDir({ conversationId, sessionWebhook } as ISession), timeout: 30000 });
        const output = (stdout || stderr || '(无输出)').substring(0, 4000);
        await this.sendDingMessage({ conversationId, sessionWebhook, content: `🖥️ 命令执行结果\n\n\`\`\`\n${output}\n\`\`\``, msgType: 'markdown' });
      } catch (err: any) {
        const output = (err.stdout || err.stderr || err.message || '').substring(0, 4000);
        await this.sendDingMessage({ conversationId, sessionWebhook, content: `❌ 命令执行失败\n\n\`\`\`\n${output}\n\`\`\``, msgType: 'markdown' });
      }
      return;
    }

    // /mq 命令
    if (parseMqCommand(prompt)) {
      const sessions = loadActiveSessions(this);
      const sessionList = Array.from(sessions.entries())
        .filter(([, s]) => s.messageQueue && s.messageQueue.length > 0)
        .map(([id, s]) => `  - ${id}: ${s.messageQueue.length} 条`)
        .join('\n');
      if (sessionList) {
        await this.sendDingMessage({ conversationId, sessionWebhook, content: `📋 消息队列\n\n${sessionList}`, msgType: 'markdown' });
      } else {
        await this.sendDingMessage({ conversationId, sessionWebhook, content: '📋 消息队列为空', msgType: 'markdown' });
      }
      return;
    }

    // /recorder 命令
    const recorderOpts = parseRecorderCommand(prompt);
    if (recorderOpts !== null) {
      if (!(await this.requireOwner(conversationId, sessionWebhook, senderStaffId))) return;
      if (recorderOpts.action === 'on') {
        this.recorderModeConversations.add(conversationId);
        await this.sendDingMessage({ conversationId, sessionWebhook, content: '✅ Recorder 模式已开启，消息将记录到本地', msgType: 'markdown' });
      } else {
        this.recorderModeConversations.delete(conversationId);
        await this.sendDingMessage({ conversationId, sessionWebhook, content: '✅ Recorder 模式已关闭', msgType: 'markdown' });
      }
      return;
    }

    // /help 命令
    if (parseHelpCommand(prompt)) {
      await this.sendDingMessage({ conversationId, sessionWebhook, content: formatHelpOverview(TOOL_VERSION, this.isOwner(senderStaffId)), msgType: 'markdown' });
      return;
    }

    // /help <command> 命令
    const cmdHelpOpts = parseCommandHelp(prompt);
    if (cmdHelpOpts !== null) {
      const cmd = getCommandByName(cmdHelpOpts);
      if (cmd) {
        await this.sendDingMessage({ conversationId, sessionWebhook, content: formatCommandHelp(cmd), msgType: 'markdown' });
      } else {
        await this.sendDingMessage({ conversationId, sessionWebhook, content: `⚠️ 未找到命令: ${cmdHelpOpts}`, msgType: 'markdown' });
      }
      return;
    }

    // /cron 命令
    const cronOpts = parseCronCommand(prompt);
    if (cronOpts !== null) {
      if (!(await this.requireOwner(conversationId, sessionWebhook, senderStaffId))) return;
      if (cronOpts.action === 'list') {
        const jobs = this.cronEngine.listJobs();
        if (jobs.length === 0) {
          await this.sendDingMessage({ conversationId, sessionWebhook, content: '⏰ 没有已注册的定时任务', msgType: 'markdown' });
        } else {
          await this.sendDingMessage({ conversationId, sessionWebhook, content: `⏰ 定时任务列表\n\n${formatCronJobList(jobs)}`, msgType: 'markdown' });
        }
        return;
      }
      if (cronOpts.action === 'add' && cronOpts.expression && cronOpts.command) {
        if (!isValidCronExpression(cronOpts.expression)) {
          await this.sendDingMessage({ conversationId, sessionWebhook, content: '❌ 无效的 cron 表达式', msgType: 'markdown' });
          return;
        }
        const jobId = this.cronEngine.addJob(cronOpts.expression, cronOpts.command);
        await this.sendDingMessage({ conversationId, sessionWebhook, content: `✅ 已添加定时任务: ${jobId}\n表达式: ${cronOpts.expression}\n命令: ${cronOpts.command}`, msgType: 'markdown' });
        return;
      }
      if (cronOpts.action === 'remove' && cronOpts.jobId) {
        const removed = this.cronEngine.removeJob(cronOpts.jobId);
        if (removed) {
          await this.sendDingMessage({ conversationId, sessionWebhook, content: `✅ 已移除定时任务: ${cronOpts.jobId}`, msgType: 'markdown' });
        } else {
          await this.sendDingMessage({ conversationId, sessionWebhook, content: `⚠️ 未找到定时任务: ${cronOpts.jobId}`, msgType: 'markdown' });
        }
        return;
      }
    }

    // /continue 命令
    const continueOpts = parseContinueSessionCommand(prompt);
    if (continueOpts !== null) {
      if (!(await this.requireOwnerOrSingleChat(conversationId, sessionWebhook, senderStaffId, conversationConfig))) return;
      const latestSession = this.findLatestSession(conversationId);
      if (!latestSession) {
        await this.sendDingMessage({ conversationId, sessionWebhook, content: '⚠️ 未找到历史会话记录，请先发送消息开启新会话', msgType: 'markdown' });
        return;
      }
      const sessions = loadActiveSessions(this);
      let activeSession = sessions.get(conversationId);
      if (!activeSession) {
        activeSession = { conversationId, sessionWebhook, session: latestSession, messageQueue: [], isProcessing: false };
        sessions.set(conversationId, activeSession);
        saveActiveSessions(this, sessions);
      }
      activeSession.messageQueue.push({ message: continueOpts.message || '继续', senderStaffId, senderNick });
      if (!activeSession.isProcessing) {
        activeSession.isProcessing = true;
        handleSessionMessage(this, { conversationId, sessionWebhook, senderStaffId, senderNick, message: activeSession.messageQueue.shift()!.message, conversationConfig }).finally(() => { activeSession!.isProcessing = false; });
      }
      return;
    }

    // task cancel
    const taskCancelOpts = parseTaskCancelCommand(prompt);
    if (taskCancelOpts !== null) {
      const result = cancelTask(this, taskCancelOpts);
      await this.sendDingMessage({ conversationId, sessionWebhook, content: result, msgType: 'markdown' });
      return;
    }

    // task 模式
    if (this.config.taskMode?.enabled) {
      const taskMode = this.config.taskMode;
      const activeCount = countTodoTask(this);
      if (activeCount >= (taskMode.maxConcurrency || this.DEFAULT_TASK_HANDLER_COUNT)) {
        const queueSize = taskMode.queueSize || this.DEFAULT_TASK_QUEUE_SIZE;
        const queueLen = getOneTodoTask(this, 'queue')?.length || 0;
        if (queueLen >= queueSize) {
          await this.sendDingMessage({ conversationId, sessionWebhook, content: `⚠️ 任务队列已满（最大 ${queueSize}），请稍后再试`, msgType: 'markdown' });
          return;
        }
        const taskId = handleTask(this, { type: 'task', conversationId, senderStaffId, senderNick, message: prompt, conversationConfig });
        await this.sendDingMessage({ conversationId, sessionWebhook, content: `✅ 任务已加入队列，ID: ${taskId}\n当前队列位置: ${queueLen + 1}`, msgType: 'markdown' });
        return;
      }
      const taskId = handleTask(this, { type: 'task', conversationId, senderStaffId, senderNick, message: prompt, conversationConfig });
      await this.sendDingMessage({ conversationId, sessionWebhook, content: `✅ 任务已创建，ID: ${taskId}\n⏳ 正在处理中...`, msgType: 'markdown' });
      return;
    }

    // session 模式处理
    await this.handleSessionMessage({
      conversationId,
      sessionWebhook,
      senderStaffId,
      senderNick,
      message: prompt,
      conversationConfig,
    });
  }

  /**
   * 处理钉钉 Stream 消息（新入口）
   */
  async handleStreamMessage(
    data: IRawCallbackData,
    sessionWebhook: string,
  ): Promise<void> {
    const {
      senderStaffId,
      senderNick,
      conversationId,
      conversationType,
      conversationTitle,
      msgtype,
    } = data;

    const conversationConfig = getConversationConfig(this, conversationId);

    // 权限检查
    if (!authCheck(this, conversationId, senderStaffId)) {
      await this.handleAuthRequest({
        senderStaffId,
        senderNick,
        conversationId,
        conversationType,
        conversationTitle,
        sessionWebhook,
      });
      return;
    }

    let prompt: string | null = null;
    const quoteInfo = extractQuoteInfo(data);

    // 提取消息内容
    if (msgtype === 'text') {
      prompt = (data.text as { content?: string })?.content?.trim() ?? null;
    } else if (msgtype === 'richText') {
      const { richTextList } = data as IRawCallbackData;
      if (richTextList && richTextList.length > 0) {
        const firstPara = richTextList[0];
        if (firstPara.type === 'text') {
          prompt = firstPara.text?.trim() ?? null;
        }
      }
    }

    if (!prompt) {
      this.debugLog(`忽略空消息: ${conversationId}`);
      return;
    }

    // 处理引用
    if (quoteInfo && conversationConfig?.quoteFetchEnabled !== false) {
      const fetched = await this.fetchQuotedMessage(quoteInfo);
      if (fetched) quoteInfo.quoteText = fetched;
    }
    if (quoteInfo?.quoteText) {
      prompt = formatPromptWithQuote(prompt, quoteInfo);
    }

    // Recorder 模式
    if (this.config.recorderCfg?.enabled && this.recorderModeConversations.has(conversationId)) {
      await recordMessage(this, data, conversationId);
    }

    // /cfg 命令
    const cfgOpts = parseCfgCommand(prompt);
    if (cfgOpts !== null) {
      // 指定 --conversationId 无条件要求 owner
      if (cfgOpts.conversationId && !this.isOwner(senderStaffId)) {
        await this.sendDingMessage({
          conversationId, sessionWebhook,
          content: '❌ 只有机器人 owner 才能操作其他群的配置',
          msgType: 'markdown',
        });
        return;
      }
      if (!(await this.requireOwnerOrSingleChat(conversationId, sessionWebhook, senderStaffId, conversationConfig))) return;

      const targetConvId = cfgOpts.conversationId || conversationId;
      const isTargetOther = targetConvId !== conversationId;
      const existingConv = isTargetOther
        ? this.config.conversations.find(c => c.conversationId === targetConvId)
        : conversationConfig;

      const hasUpdates = !!(cfgOpts.dingToken || cfgOpts.linkConversationId ||
        (cfgOpts.whiteUserList && cfgOpts.whiteUserList.length > 0) || cfgOpts.conversationTitle ||
        cfgOpts.atSender !== undefined || cfgOpts.receiveReply !== undefined || cfgOpts.preBash !== undefined);

      if (existingConv && hasUpdates) {
        const updated: string[] = [];
        if (cfgOpts.dingToken) { existingConv.dingToken = cfgOpts.dingToken; updated.push('dingToken'); }
        if (cfgOpts.linkConversationId) { existingConv.linkConversationId = cfgOpts.linkConversationId; updated.push('linkConversationId'); }
        if (cfgOpts.whiteUserList && cfgOpts.whiteUserList.length > 0) { existingConv.whiteUserList = cfgOpts.whiteUserList; updated.push('whiteUserList'); }
        if (cfgOpts.conversationTitle) { existingConv.conversationTitle = cfgOpts.conversationTitle; updated.push('conversationTitle'); }
        if (cfgOpts.atSender !== undefined) { existingConv.atSender = cfgOpts.atSender; updated.push(`atSender=${cfgOpts.atSender}`); }
        if (cfgOpts.receiveReply !== undefined) { existingConv.receiveReply = cfgOpts.receiveReply; updated.push(`receiveReply=${cfgOpts.receiveReply}`); }
        if (cfgOpts.preBash !== undefined) { existingConv.preBash = cfgOpts.preBash; updated.push('preBash'); }

        saveClientConfig(this.clientId, this.config);
        await this.sendDingMessage({
          conversationId, sessionWebhook,
          content: `✅ 已更新: ${updated.join(', ')}`,
          msgType: 'markdown',
        });
      } else if (!existingConv && (cfgOpts.dingToken || cfgOpts.conversationTitle)) {
        const newConv: IConfig['conversations'][0] = {
          conversationId: targetConvId,
          conversationType: conversationType,
          conversationTitle: cfgOpts.conversationTitle || conversationTitle || '未命名群',
          dingToken: cfgOpts.dingToken,
          linkConversationId: cfgOpts.linkConversationId,
          whiteUserList: cfgOpts.whiteUserList || [],
          atSender: cfgOpts.atSender ?? true,
          receiveReply: cfgOpts.receiveReply ?? true,
        };
        if (cfgOpts.preBash !== undefined) newConv.preBash = cfgOpts.preBash;
        this.config.conversations.push(newConv);
        saveClientConfig(this.clientId, this.config);
        await this.sendDingMessage({
          conversationId, sessionWebhook,
          content: `✅ 已将当前群注册到配置`,
          msgType: 'markdown',
        });
      } else if (!existingConv && !cfgOpts.dingToken) {
        await this.sendDingMessage({
          conversationId, sessionWebhook,
          content: '❌ 未注册的群需要提供 --dingToken 参数',
          msgType: 'markdown',
        });
      } else {
        await this.sendDingMessage({
          conversationId, sessionWebhook,
          content: '⚠️ 当前群已注册，如需刷新请使用: /cfg --字段名 新值',
          msgType: 'markdown',
        });
      }
      return;
    }

    // /info 命令
    if (parseInfoCommand(prompt)) {
      const info = conversationConfig
        ? formatConversationInfo(this.config, conversationConfig)
        : formatGlobalConfig(this.config);
      await this.sendDingMessage({ conversationId, sessionWebhook, content: info, msgType: 'markdown' });
      return;
    }

    // /auth 命令
    const authOpts = parseAuthCommand(prompt);
    if (authOpts !== null) {
      if (!(await this.requireOwner(conversationId, sessionWebhook, senderStaffId))) return;
      if (authOpts.type === 'approve') {
        const req = this.pendingAuthRequests.get(authOpts.requestId!);
        if (!req) {
          await this.sendDingMessage({ conversationId, sessionWebhook, content: `❌ 未找到授权申请: ${authOpts.requestId}`, msgType: 'markdown' });
          return;
        }
        const conv = this.config.conversations.find(c => c.conversationId === req.conversationId);
        if (conv) {
          if (!conv.whiteUserList.includes(req.requesterStaffId)) conv.whiteUserList.push(req.requesterStaffId);
        } else {
          const newConv: IConfig['conversations'][0] = {
            conversationId: req.conversationId, conversationType: req.conversationType,
            conversationTitle: req.conversationTitle || '未命名群', whiteUserList: [req.requesterStaffId],
            atSender: true, receiveReply: true,
          };
          this.config.conversations.push(newConv);
        }
        this.pendingAuthRequests.delete(authOpts.requestId!);
        saveClientConfig(this.clientId, this.config);
        await this.sendOwnerMessage(`✅ 已批准 ${req.requesterNick}(${req.requesterStaffId}) 的授权申请`, 'text');
        await this.sendDingMessage({ conversationId, sessionWebhook, content: `✅ 已批准授权申请: ${req.requesterNick}(${req.requesterStaffId})`, msgType: 'markdown' });
        return;
      }
      if (authOpts.type === 'reject') {
        const req = this.pendingAuthRequests.get(authOpts.requestId!);
        if (!req) {
          await this.sendDingMessage({ conversationId, sessionWebhook, content: `❌ 未找到授权申请: ${authOpts.requestId}`, msgType: 'markdown' });
          return;
        }
        this.pendingAuthRequests.delete(authOpts.requestId!);
        await this.sendDingMessage({ conversationId, sessionWebhook, content: `❌ 已拒绝授权申请: ${authOpts.requestId}`, msgType: 'markdown' });
        return;
      }
      if (authOpts.type === 'add') {
        const resolvedId = this.resolveUserId(authOpts.staffId!);
        const conv = conversationConfig || this.config.conversations.find(c => c.conversationId === conversationId);
        if (conv) {
          if (!conv.whiteUserList.includes(resolvedId)) {
            conv.whiteUserList.push(resolvedId);
            saveClientConfig(this.clientId, this.config);
            await this.sendDingMessage({ conversationId, sessionWebhook, content: `✅ 已添加用户: ${resolvedId}`, msgType: 'markdown' });
          } else {
            await this.sendDingMessage({ conversationId, sessionWebhook, content: `⚠️ 用户已在白名单中: ${resolvedId}`, msgType: 'markdown' });
          }
        }
        return;
      }
      if (authOpts.type === 'del') {
        const resolvedId = this.resolveUserId(authOpts.staffId!);
        const conv = conversationConfig || this.config.conversations.find(c => c.conversationId === conversationId);
        if (conv) {
          const idx = conv.whiteUserList.indexOf(resolvedId);
          if (idx >= 0) {
            conv.whiteUserList.splice(idx, 1);
            saveClientConfig(this.clientId, this.config);
            await this.sendDingMessage({ conversationId, sessionWebhook, content: `✅ 已移除用户: ${resolvedId}`, msgType: 'markdown' });
          } else {
            await this.sendDingMessage({ conversationId, sessionWebhook, content: `⚠️ 用户不在白名单中: ${resolvedId}`, msgType: 'markdown' });
          }
        }
        return;
      }
    }

    // /ls 命令
    if (parseLsCommand(prompt)) {
      const sessions = findHistorySession(this, conversationId, '');
      if (sessions.length === 0) {
        await this.sendDingMessage({ conversationId, sessionWebhook, content: '📋 当前群没有历史会话记录', msgType: 'markdown' });
        return;
      }
      const info = sessions.map(s => formatSessionInfo(this, conversationId, this.getSessionDir(s))).join('\n\n');
      await this.sendDingMessage({ conversationId, sessionWebhook, content: `📋 历史会话\n\n${info}`, msgType: 'markdown' });
      return;
    }

    // /log 命令
    const logOpts = parseLogCommand(prompt);
    if (logOpts !== null) {
      const lines = logOpts.lines || 10;
      const log = readSessionLogTail(this, conversationId, lines);
      await this.sendDingMessage({ conversationId, sessionWebhook, content: `📄 最近 ${lines} 条日志\n\n\`\`\`\n${log}\n\`\`\``, msgType: 'markdown' });
      return;
    }

    // /pwd 命令
    if (parsePwdCommand(prompt)) {
      const sessionDir = this.getSessionDir({ conversationId, sessionWebhook } as ISession);
      await this.sendDingMessage({ conversationId, sessionWebhook, content: `📂 ${sessionDir}`, msgType: 'markdown' });
      return;
    }

    // /mkdir 命令
    const mkdirOpts = parseMkdirCommand(prompt);
    if (mkdirOpts !== null) {
      const sessionDir = this.getSessionDir({ conversationId, sessionWebhook } as ISession);
      const dirPath = path.join(sessionDir, mkdirOpts);
      fs.mkdirSync(dirPath, { recursive: true });
      await this.sendDingMessage({ conversationId, sessionWebhook, content: `✅ 已创建: ${dirPath}`, msgType: 'markdown' });
      return;
    }

    // /touch 命令
    const touchOpts = parseTouchCommand(prompt);
    if (touchOpts !== null) {
      const sessionDir = this.getSessionDir({ conversationId, sessionWebhook } as ISession);
      const filePath = path.join(sessionDir, touchOpts);
      fs.writeFileSync(filePath, '', 'utf-8');
      await this.sendDingMessage({ conversationId, sessionWebhook, content: `✅ 已创建: ${filePath}`, msgType: 'markdown' });
      return;
    }

    // /rm 命令
    const rmOpts = parseRmCommand(prompt);
    if (rmOpts !== null) {
      const sessionDir = this.getSessionDir({ conversationId, sessionWebhook } as ISession);
      const targetPath = path.join(sessionDir, rmOpts.path);
      if (!targetPath.startsWith(sessionDir)) {
        await this.sendDingMessage({ conversationId, sessionWebhook, content: '❌ 不允许删除当前会话目录外的文件', msgType: 'markdown' });
        return;
      }
      if (!fs.existsSync(targetPath)) {
        await this.sendDingMessage({ conversationId, sessionWebhook, content: `⚠️ 文件/目录不存在: ${rmOpts.path}`, msgType: 'markdown' });
        return;
      }
      fs.rmSync(targetPath, { recursive: rmOpts.recursive, force: true });
      await this.sendDingMessage({ conversationId, sessionWebhook, content: `✅ 已删除: ${rmOpts.path}`, msgType: 'markdown' });
      return;
    }

    // /open 命令
    const openOpts = parseOpenCommand(prompt);
    if (openOpts !== null) {
      const sessionDir = this.getSessionDir({ conversationId, sessionWebhook } as ISession);
      const filePath = path.join(sessionDir, openOpts);
      if (!fs.existsSync(filePath)) {
        await this.sendDingMessage({ conversationId, sessionWebhook, content: `⚠️ 文件不存在: ${openOpts}`, msgType: 'markdown' });
        return;
      }
      const content = fs.readFileSync(filePath, 'utf-8');
      const truncated = content.length > 8000 ? content.substring(0, 8000) + '\n...(内容过长已截断)' : content;
      await this.sendDingMessage({ conversationId, sessionWebhook, content: `📄 ${openOpts}\n\n\`\`\`\n${truncated}\n\`\`\``, msgType: 'markdown' });
      return;
    }

    // /version 命令
    if (parseVersionCommand(prompt)) {
      await this.sendDingMessage({ conversationId, sessionWebhook, content: `📦 版本信息\n\n- 工具版本: v${TOOL_VERSION}\n- Node.js: ${process.version}\n- 平台: ${process.platform}`, msgType: 'markdown' });
      return;
    }

    // /clean 命令
    const cleanOpts = parseCleanCommand(prompt);
    if (cleanOpts !== null) {
      if (!(await this.requireOwnerOrSingleChat(conversationId, sessionWebhook, senderStaffId, conversationConfig))) return;
      const result = await this.cleanCache(conversationId, cleanOpts.cleanType || 'all', senderStaffId);
      await this.sendDingMessage({ conversationId, sessionWebhook, content: result, msgType: 'markdown' });
      return;
    }

    // /reset-api-key-cfg 命令
    if (parseResetApiKeyCfgCommand(prompt)) {
      if (!(await this.requireOwner(conversationId, sessionWebhook, senderStaffId))) return;
      resetApiKeyCfg(this);
      await this.sendDingMessage({ conversationId, sessionWebhook, content: '✅ 已重置 API Key 配置', msgType: 'markdown' });
      return;
    }

    // /bash 命令
    const bashOpts = parseBashCommand(prompt);
    if (bashOpts !== null) {
      try {
        const { stdout, stderr } = await util.promisify(childExec)(bashOpts, { cwd: this.getSessionDir({ conversationId, sessionWebhook } as ISession), timeout: 30000 });
        const output = (stdout || stderr || '(无输出)').substring(0, 4000);
        await this.sendDingMessage({ conversationId, sessionWebhook, content: `🖥️ 命令执行结果\n\n\`\`\`\n${output}\n\`\`\``, msgType: 'markdown' });
      } catch (err: any) {
        const output = (err.stdout || err.stderr || err.message || '').substring(0, 4000);
        await this.sendDingMessage({ conversationId, sessionWebhook, content: `❌ 命令执行失败\n\n\`\`\`\n${output}\n\`\`\``, msgType: 'markdown' });
      }
      return;
    }

    // /mq 命令
    if (parseMqCommand(prompt)) {
      const sessions = loadActiveSessions(this);
      const sessionList = Array.from(sessions.entries())
        .filter(([, s]) => s.messageQueue && s.messageQueue.length > 0)
        .map(([id, s]) => `  - ${id}: ${s.messageQueue.length} 条`)
        .join('\n');
      if (sessionList) {
        await this.sendDingMessage({ conversationId, sessionWebhook, content: `📋 消息队列\n\n${sessionList}`, msgType: 'markdown' });
      } else {
        await this.sendDingMessage({ conversationId, sessionWebhook, content: '📋 消息队列为空', msgType: 'markdown' });
      }
      return;
    }

    // /recorder 命令
    const recorderOpts = parseRecorderCommand(prompt);
    if (recorderOpts !== null) {
      if (!(await this.requireOwner(conversationId, sessionWebhook, senderStaffId))) return;
      if (recorderOpts.action === 'on') {
        this.recorderModeConversations.add(conversationId);
        await this.sendDingMessage({ conversationId, sessionWebhook, content: '✅ Recorder 模式已开启，消息将记录到本地', msgType: 'markdown' });
      } else {
        this.recorderModeConversations.delete(conversationId);
        await this.sendDingMessage({ conversationId, sessionWebhook, content: '✅ Recorder 模式已关闭', msgType: 'markdown' });
      }
      return;
    }

    // /help 命令
    if (parseHelpCommand(prompt)) {
      await this.sendDingMessage({ conversationId, sessionWebhook, content: formatHelpOverview(TOOL_VERSION, this.isOwner(senderStaffId)), msgType: 'markdown' });
      return;
    }

    // /help <command> 命令
    const cmdHelpOpts = parseCommandHelp(prompt);
    if (cmdHelpOpts !== null) {
      const cmd = getCommandByName(cmdHelpOpts);
      if (cmd) {
        await this.sendDingMessage({ conversationId, sessionWebhook, content: formatCommandHelp(cmd), msgType: 'markdown' });
      } else {
        await this.sendDingMessage({ conversationId, sessionWebhook, content: `⚠️ 未找到命令: ${cmdHelpOpts}`, msgType: 'markdown' });
      }
      return;
    }

    // /cron 命令
    const cronOpts = parseCronCommand(prompt);
    if (cronOpts !== null) {
      if (!(await this.requireOwner(conversationId, sessionWebhook, senderStaffId))) return;
      if (cronOpts.action === 'list') {
        const jobs = this.cronEngine.listJobs();
        if (jobs.length === 0) {
          await this.sendDingMessage({ conversationId, sessionWebhook, content: '⏰ 没有已注册的定时任务', msgType: 'markdown' });
        } else {
          await this.sendDingMessage({ conversationId, sessionWebhook, content: `⏰ 定时任务列表\n\n${formatCronJobList(jobs)}`, msgType: 'markdown' });
        }
        return;
      }
      if (cronOpts.action === 'add' && cronOpts.expression && cronOpts.command) {
        if (!isValidCronExpression(cronOpts.expression)) {
          await this.sendDingMessage({ conversationId, sessionWebhook, content: '❌ 无效的 cron 表达式', msgType: 'markdown' });
          return;
        }
        const jobId = this.cronEngine.addJob(cronOpts.expression, cronOpts.command);
        await this.sendDingMessage({ conversationId, sessionWebhook, content: `✅ 已添加定时任务: ${jobId}\n表达式: ${cronOpts.expression}\n命令: ${cronOpts.command}`, msgType: 'markdown' });
        return;
      }
      if (cronOpts.action === 'remove' && cronOpts.jobId) {
        const removed = this.cronEngine.removeJob(cronOpts.jobId);
        if (removed) {
          await this.sendDingMessage({ conversationId, sessionWebhook, content: `✅ 已移除定时任务: ${cronOpts.jobId}`, msgType: 'markdown' });
        } else {
          await this.sendDingMessage({ conversationId, sessionWebhook, content: `⚠️ 未找到定时任务: ${cronOpts.jobId}`, msgType: 'markdown' });
        }
        return;
      }
    }

    // /continue 命令
    const continueOpts = parseContinueSessionCommand(prompt);
    if (continueOpts !== null) {
      if (!(await this.requireOwnerOrSingleChat(conversationId, sessionWebhook, senderStaffId, conversationConfig))) return;
      const latestSession = this.findLatestSession(conversationId);
      if (!latestSession) {
        await this.sendDingMessage({ conversationId, sessionWebhook, content: '⚠️ 未找到历史会话记录，请先发送消息开启新会话', msgType: 'markdown' });
        return;
      }
      const sessions = loadActiveSessions(this);
      let activeSession = sessions.get(conversationId);
      if (!activeSession) {
        activeSession = { conversationId, sessionWebhook, session: latestSession, messageQueue: [], isProcessing: false };
        sessions.set(conversationId, activeSession);
        saveActiveSessions(this, sessions);
      }
      activeSession.messageQueue.push({ message: continueOpts.message || '继续', senderStaffId, senderNick });
      if (!activeSession.isProcessing) {
        activeSession.isProcessing = true;
        handleSessionMessage(this, { conversationId, sessionWebhook, senderStaffId, senderNick, message: activeSession.messageQueue.shift()!.message, conversationConfig }).finally(() => { activeSession!.isProcessing = false; });
      }
      return;
    }

    // task cancel
    const taskCancelOpts = parseTaskCancelCommand(prompt);
    if (taskCancelOpts !== null) {
      const result = cancelTask(this, taskCancelOpts);
      await this.sendDingMessage({ conversationId, sessionWebhook, content: result, msgType: 'markdown' });
      return;
    }

    // task 模式
    if (this.config.taskMode?.enabled) {
      const taskMode = this.config.taskMode;
      const activeCount = countTodoTask(this);
      if (activeCount >= (taskMode.maxConcurrency || this.DEFAULT_TASK_HANDLER_COUNT)) {
        const queueSize = taskMode.queueSize || this.DEFAULT_TASK_QUEUE_SIZE;
        const queueLen = getOneTodoTask(this, 'queue')?.length || 0;
        if (queueLen >= queueSize) {
          await this.sendDingMessage({ conversationId, sessionWebhook, content: `⚠️ 任务队列已满（最大 ${queueSize}），请稍后再试`, msgType: 'markdown' });
          return;
        }
        const taskId = handleTask(this, { type: 'task', conversationId, senderStaffId, senderNick, message: prompt, conversationConfig });
        await this.sendDingMessage({ conversationId, sessionWebhook, content: `✅ 任务已加入队列，ID: ${taskId}\n当前队列位置: ${queueLen + 1}`, msgType: 'markdown' });
        return;
      }
      const taskId = handleTask(this, { type: 'task', conversationId, senderStaffId, senderNick, message: prompt, conversationConfig });
      await this.sendDingMessage({ conversationId, sessionWebhook, content: `✅ 任务已创建，ID: ${taskId}\n⏳ 正在处理中...`, msgType: 'markdown' });
      return;
    }

    // /new 命令
    if (parseNewCommand(prompt)) {
      if (!(await this.requireOwnerOrSingleChat(conversationId, sessionWebhook, senderStaffId, conversationConfig))) return;
      const newSession = this.startNewSession({ conversationId, sessionWebhook, senderStaffId, senderNick });
      await this.sendDingMessage({
        conversationId, sessionWebhook,
        content: `✅ 已开启新会话，ID: ${newSession.sessionId}`,
        msgType: 'markdown',
      });
      return;
    }

    // /end 命令
    if (parseEndCommand(prompt)) {
      if (!(await this.requireOwnerOrSingleChat(conversationId, sessionWebhook, senderStaffId, conversationConfig))) return;
      const result = this.endSession({ conversationId, senderStaffId });
      await this.sendDingMessage({ conversationId, sessionWebhook, content: result, msgType: 'markdown' });
      return;
    }

    // /switch 命令
    if (parseSwitchCommand(prompt)) {
      if (!(await this.requireOwnerOrSingleChat(conversationId, sessionWebhook, senderStaffId, conversationConfig))) return;
      const sessionId = prompt.replace(/^\/switch\s+/, '').trim();
      if (!sessionId) {
        await this.sendDingMessage({ conversationId, sessionWebhook, content: '❌ 请提供 sessionId', msgType: 'markdown' });
        return;
      }
      const result = this.switchToSession({ conversationId, sessionId });
      await this.sendDingMessage({ conversationId, sessionWebhook, content: result, msgType: 'markdown' });
      return;
    }

    // /session 命令
    if (parseSessionCommand(prompt)) {
      const sessionId = prompt.replace(/^\/session\s+/, '').trim();
      if (!sessionId) {
        await this.sendDingMessage({ conversationId, sessionWebhook, content: '❌ 请提供 sessionId', msgType: 'markdown' });
        return;
      }
      const sessionDir = findSubdirByName(this.getConversationDir(conversationId), sessionId);
      if (sessionDir) {
        const info = formatSessionInfo(this, conversationId, sessionDir);
        await this.sendDingMessage({ conversationId, sessionWebhook, content: `📋 Session 信息\n\n${info}`, msgType: 'markdown' });
      } else {
        await this.sendDingMessage({ conversationId, sessionWebhook, content: `⚠️ 未找到 sessionId: ${sessionId}`, msgType: 'markdown' });
      }
      return;
    }

    // /tasks 命令
    if (parseTasksCommand(prompt)) {
      const taskList = formatTaskInfo(this, getOneTodoTask(this, 'todo') || []);
      if (taskList) {
        await this.sendDingMessage({ conversationId, sessionWebhook, content: `📋 任务列表\n\n${taskList}`, msgType: 'markdown' });
      } else {
        await this.sendDingMessage({ conversationId, sessionWebhook, content: '📋 暂无任务', msgType: 'markdown' });
      }
      return;
    }

    // /goon 命令
    if (parseGoonCommand(prompt)) {
      const activeSession = this.activeSessions.get(conversationId);
      if (!activeSession) {
        await this.sendDingMessage({
          conversationId, sessionWebhook,
          content: '⚠️ 当前没有活跃会话',
        });
        return;
      }
      if (activeSession.currentProcess) {
        console.log(`[${timestamp()}] /goon: 终止当前 Claude 进程`);
        activeSession.interrupted = true;
        activeSession.currentProcess.kill('SIGINT');
        await this.sendDingMessage({
          conversationId, sessionWebhook,
          content: '🔄 正在重启 Claude 进程...',
        });
        // 直接在当前处理 goonPending，避免依赖 processMessageQueue（队列为空时会跳过 goonPending 检查）
        activeSession.goonPending = false;
        activeSession.isProcessing = true;
        try {
          await executeClaudeQuery(this, activeSession.session, '继续', {
            senderNick: activeSession.session.startNickName,
            senderStaffId: activeSession.lastSenderStaffId,
          });
        } finally {
          activeSession.isProcessing = false;
        }
      } else {
        console.log(`[${timestamp()}] /goon: 无运行中进程，直接发送"继续"`);
        activeSession.isProcessing = true;
        try {
          await executeClaudeQuery(this, activeSession.session, '继续', {
            senderNick,
            senderStaffId,
          });
        } finally {
          activeSession.isProcessing = false;
        }
      }
      return;
    }

    // /cc 命令
    const ccMessage = parseCcCommand(prompt);
    if (ccMessage !== null) {
      const activeSession = this.activeSessions.get(conversationId);
      if (!activeSession) {
        await this.sendDingMessage({
          conversationId, sessionWebhook,
          content: '⚠️ 当前没有活跃会话，请先发送消息开始会话',
        });
        return;
      }
      if (activeSession.isProcessing) {
        await this.sendDingMessage({
          conversationId, sessionWebhook,
          content: '⏳ 正在处理中，请稍等...',
        });
        return;
      }
      activeSession.isProcessing = true;
      try {
        await executeClaudeQuery(this, activeSession.session, ccMessage, {
          senderNick,
          senderStaffId,
        });
      } finally {
        activeSession.isProcessing = false;
      }
      return;
    }

    // /claude.md 命令
    if (parseClaudeMdCommand(prompt)) {
      const conversationDir = this.getConversationDir(conversationId);
      const claudeMdPath = path.join(conversationDir, '.claude', 'CLAUDE.md');
      if (fs.existsSync(claudeMdPath)) {
        const content = fs.readFileSync(claudeMdPath, 'utf-8');
        const truncated = content.length > 8000 ? content.substring(0, 8000) + '\n...(内容过长已截断)' : content;
        await this.sendDingMessage({
          conversationId, sessionWebhook,
          content: `📄 **CLAUDE.md**\n\`\`\`\n${truncated}\n\`\`\``,
          msgType: 'markdown',
        });
      } else {
        await this.sendDingMessage({
          conversationId, sessionWebhook,
          content: `⚠️ 未找到 CLAUDE.md\n路径: \`${claudeMdPath}\``,
          msgType: 'markdown',
        });
      }
      return;
    }

    // 处理普通 session 消息
    await this.handleSessionMessage({
      conversationId,
      sessionWebhook,
      senderStaffId,
      senderNick,
      message: prompt,
      conversationConfig,
    });
  }

  /**
   * 启动钉钉 Stream 客户端
   */
  async start(): Promise<void> {
    startupCheck(this);

    this.dingStreamClient.onMessage(async (data: IRawCallbackData, respond: any) => {
      try {
        const sessionWebhook = await this.dingStreamClient.getReplyWebhook(data.conversationId);
        await this.handleStreamMessage(data, sessionWebhook);
      } catch (err) {
        console.error('handleStreamMessage error:', err);
      }
    });

    this.cronEngine.start();
    await this.dingStreamClient.start();
    console.log(`[${timestamp()}] DingTalk Stream 客户端启动成功`);
  }

  async stop(): Promise<void> {
    this.cronEngine.stop();
    await this.dingStreamClient.stop();
    console.log(`[${timestamp()}] DingTalk Stream 客户端已停止`);
  }
}

function generateRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
}

export { getClientDir, getClientConfig, authCheck, isOwner, debugLog, hashConversationId, getConversationConfig, getConversationDir, getSessionsDir, getTasksDir, getSessionDir, getSessionId, formatSessionInfo, readSessionLogTail, findHistorySession, findLatestSession, updateSessionFile, appendSessionLog, getActiveSessionsFile, saveActiveSession, loadActiveSessions, endSession, switchToSession, startNewSession, handleSessionMessage, findActiveSession, cleanCache, timestamp, resolveAllPhonesInConfig, resolveUserId, resolveToUserId, userIdToPhone, isMobile, countTodoTask, getOneTodoTask, finishTask, handleTask, runTaskHandlerLoop, saveTask, formatTaskInfo, cancelTask, parseTaskCancelCommand };