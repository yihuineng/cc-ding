import { exec as childExec } from 'child_process';
import { DingStreamClient, DWClientDownStream, dateUtil } from 'utils-ok';
import fs from 'fs';
import path from 'path';
import { projUtil } from '../common';
import { IConfig, IActiveSession, ISession, IRawCallbackData, IAuthRequest } from './types';
import { extractQuoteInfo, formatPromptWithQuote } from './quote';
import { fetchQuotedMessage, sendMessageToUser, sendOwnerMessage } from './messaging';
import { processPictureMessage, processRichTextMessage, processFileMessage, extractDownloadCode } from './image';
import {
  parseInfoCommand, formatConversationInfo, formatGlobalConfig, parseLogCommand,
  parseLsCommand, findSubdirByName, getDirectoryStructure,
  parseContinueSessionCommand, parseHelpCommand, parseCommandHelp,
  getCommandByName, formatHelpOverview, formatCommandHelp,
  parseCronCommand, parseVersionCommand, parseOpenCommand, parseCleanCommand, parseResetApiKeyCfgCommand, parseCfgCommand, parseAuthCommand,
  parseBashCommand, parseMqCommand, parseRecorderCommand,
  parseGoonCommand, parseCcCommand, parseClaudeMdCommand,
  parseRebootCommand,
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

  // claude-process
  parseClaudeStreamLine = parseClaudeStreamLine;
  interruptClaudeProcess = (activeSession: import('./types').IActiveSession, logReason: string) =>
    interruptClaudeProcess(activeSession, logReason);
  executeClaudeQuery = (session: ISession, message: string, opts?: { skill?: string; agent?: string; senderNick?: string; senderStaffId?: string; permissionMode?: string }) =>
    executeClaudeQuery(this, session, message, opts);

  // session - config & auth
  getClientDir = () => getClientDir(this);
  getClientConfig = () => getClientConfig(this);
  authCheck = (userId: string, conversationId?: string) => authCheck(this, userId, conversationId);
  isOwner = (userId: string) => isOwner(this, userId);
  debugLog = (message: string, ...args: unknown[]) => debugLog(this, message, ...args);
  hashConversationId = (conversationId: string) => hashConversationId(this, conversationId);
  getConversationConfig = (conversationId: string) => getConversationConfig(this, conversationId);

  // session - paths
  getConversationDir = (conversationId: string) => getConversationDir(this, conversationId);
  getSessionsDir = (conversationId: string) => getSessionsDir(this, conversationId);
  getTasksDir = (conversationId: string) => getTasksDir(this, conversationId);
  getSessionDir = (session: ISession) => getSessionDir(this, session);
  getSessionId = getSessionId;

  // session - info & logs
  formatSessionInfo = (conversationId: string) => formatSessionInfo(this, conversationId);
  readSessionLogTail = (conversationId: string, n: number) => readSessionLogTail(this, conversationId, n);
  findActiveSession = (conversationId: string) => findActiveSession(this, conversationId);

  // session - persistence
  findHistorySession = (conversationId: string, sessionId: string) => findHistorySession(this, conversationId, sessionId);
  findLatestSession = (conversationId: string) => findLatestSession(this, conversationId);
  updateSessionFile = (session: ISession, opts: { claudeSessionId?: string; sessionWebhook?: string; currentWebhook?: string; currentConversationId?: string }) =>
    updateSessionFile(this, session, opts);
  appendSessionLog = appendSessionLog;
  getActiveSessionsFile = (conversationId: string) => getActiveSessionsFile(this, conversationId);
  saveActiveSession = (conversationId: string) => saveActiveSession(this, conversationId);
  loadActiveSessions = () => loadActiveSessions(this);

  // session - lifecycle
  endSession = (conversationId: string, sessionWebhook: string) => endSession(this, conversationId, sessionWebhook);
  switchToSession = (conversationId: string, sessionWebhook: string, targetSessionId: string, senderStaffId: string, conversationConfig: IConfig['conversations'][0]) =>
    switchToSession(this, conversationId, sessionWebhook, targetSessionId, senderStaffId, conversationConfig);
  startNewSession = (opts: {
    conversationId: string; sessionWebhook: string; senderStaffId: string;
    senderNick: string; message: string; conversationConfig: IConfig['conversations'][0];
  }) => startNewSession(this, opts);
  handleSessionMessage = (opts: {
    conversationId: string; sessionWebhook: string; senderStaffId: string;
    senderNick: string; message: string; conversationConfig: IConfig['conversations'][0];
  }) => handleSessionMessage(this, opts);
  cleanCache = (conversationId: string | null, keepActiveSession = true) => cleanCache(this, conversationId, keepActiveSession);

  // task
  formatTaskInfo = () => formatTaskInfo(this);
  cancelTask = (query: string, conversationId?: string) => cancelTask(this, query, conversationId);
  countTodoTask = () => countTodoTask(this);
  getOneTodoTask = () => getOneTodoTask(this);
  finishTask = (taskDir: string) => finishTask(this, taskDir);
  handleTask = () => handleTask(this);
  runTaskHandlerLoop = () => runTaskHandlerLoop(this);
  saveTask = (opts: { conversationId: string; prompt: string; senderStaffId: string; senderNickName?: string; sessionWebhook: string }) =>
    saveTask(this, opts);

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

    if (!this.config.ownerConversationId) {
      await this.sendDingMessage({
        conversationId, sessionWebhook,
        content: [
          '抱歉,您暂无使用权限',
          '请将以下信息发送给机器人管理员,由管理员通过命令注册:',
          `- **会话ID:** \`${conversationId}\``,
          `- **注册命令:** \`/cfg --conversationId ${conversationId}\``,
        ].join('\n'),
        msgType: 'markdown',
      });
      return;
    }

    for (const req of this.pendingAuthRequests.values()) {
      if (req.senderStaffId === senderStaffId && req.conversationId === conversationId) {
        await this.sendDingMessage({
          conversationId, sessionWebhook,
          content: '⏳ 授权申请已发送，请等待管理员审批...',
          msgType: 'markdown',
        });
        return;
      }
    }

    const requestId = `r${Date.now().toString(36)}`;
    const request: IAuthRequest = {
      id: requestId,
      senderStaffId,
      senderNick,
      conversationId,
      conversationType,
      conversationTitle,
      requestTime: Date.now(),
    };
    this.pendingAuthRequests.set(requestId, request);
    console.log(`[${timestamp()}] 新授权申请: id=${requestId}, userId=${senderStaffId}, 昵称=${senderNick}, 会话=${conversationId}`);

    const ownerMsg = [
      '📋 **收到授权申请**',
      `- **用户ID:** ${senderStaffId}`,
      `- **昵称:** ${senderNick}`,
      `- **会话ID:** ${conversationId}`,
      conversationTitle ? `- **会话标题:** ${conversationTitle}` : '',
      `- **会话类型:** ${conversationType === '1' ? '单聊' : conversationType === '2' ? '群聊' : conversationType || '-'}`,
      '',
      `回复 \`/auth approve ${requestId}\` 通过`,
      `回复 \`/auth reject ${requestId}\` 拒绝`,
    ].filter(Boolean).join('\n');

    const sent = await sendOwnerMessage(this, ownerMsg, 'markdown');

    if (sent) {
      await this.sendDingMessage({
        conversationId, sessionWebhook,
        content: '✅ 已向管理员发送授权申请，请等待审批...',
        msgType: 'markdown',
      });
    } else {
      this.pendingAuthRequests.delete(requestId);
      await this.sendDingMessage({
        conversationId, sessionWebhook,
        content: '❌ 授权申请发送失败，请联系管理员手动授权',
        msgType: 'markdown',
      });
    }
  }

  // ==================== 消息处理入口 ====================

  /**
   * 处理 /cron 命令
   * 操作日志会写入当前活跃 session，没有则新起会话
   */
  private async handleCronCommand(
    cmd: import('./commands').CronCommand,
    ctx: { conversationId: string; sessionWebhook: string; senderStaffId: string; senderNick: string; conversationConfig: IConfig['conversations'][0] },
  ): Promise<void> {
    const { conversationId, sessionWebhook, senderStaffId, senderNick, conversationConfig } = ctx;

    switch (cmd.type) {
      case 'list': {
        // list 操作：查询类，无活跃 session 时不创建临时目录
        const logSession = await this.getOrCreateLogSession(conversationId, sessionWebhook, senderStaffId, senderNick, conversationConfig, true);
        const jobs = this.cronEngine.listJobs(conversationId);
        if (logSession.sessionDir) {
          this.appendSessionLog(logSession.sessionDir, 'user', '/cron list');
          this.appendSessionLog(logSession.sessionDir, 'assistant', `列出 ${jobs.length} 个定时任务`);
        }
        await this.sendDingMessage({
          conversationId, sessionWebhook,
          content: formatCronJobList(jobs),
          msgType: 'markdown',
        });
        return;
      }

      case 'delete': {
        // 先执行操作，成功后再记录日志
        const ok = this.cronEngine.removeJob(cmd.id);
        const logSession = await this.getOrCreateLogSession(conversationId, sessionWebhook, senderStaffId, senderNick, conversationConfig);
        if (logSession.sessionDir) {
          this.appendSessionLog(logSession.sessionDir, 'user', `/cron delete ${cmd.id}`);
          this.appendSessionLog(logSession.sessionDir, 'assistant', ok ? `删除定时任务 ${cmd.id}` : `未找到定时任务: ${cmd.id}`);
        }
        await this.sendDingMessage({
          conversationId, sessionWebhook,
          content: ok
            ? `✅ 定时任务 **${cmd.id}** 已删除`
            : `❌ 未找到定时任务: ${cmd.id}`,
          msgType: 'markdown',
        });
        return;
      }

      case 'pause': {
        const ok = this.cronEngine.toggleJob(cmd.id, false);
        const logSession = await this.getOrCreateLogSession(conversationId, sessionWebhook, senderStaffId, senderNick, conversationConfig);
        if (logSession.sessionDir) {
          this.appendSessionLog(logSession.sessionDir, 'user', `/cron pause ${cmd.id}`);
          this.appendSessionLog(logSession.sessionDir, 'assistant', ok ? `暂停定时任务 ${cmd.id}` : `未找到定时任务: ${cmd.id}`);
        }
        await this.sendDingMessage({
          conversationId, sessionWebhook,
          content: ok
            ? `⏸️ 定时任务 **${cmd.id}** 已暂停`
            : `❌ 未找到定时任务: ${cmd.id}`,
          msgType: 'markdown',
        });
        return;
      }

      case 'resume': {
        const ok = this.cronEngine.toggleJob(cmd.id, true);
        const logSession = await this.getOrCreateLogSession(conversationId, sessionWebhook, senderStaffId, senderNick, conversationConfig);
        if (logSession.sessionDir) {
          this.appendSessionLog(logSession.sessionDir, 'user', `/cron resume ${cmd.id}`);
          this.appendSessionLog(logSession.sessionDir, 'assistant', ok ? `恢复定时任务 ${cmd.id}` : `未找到定时任务: ${cmd.id}`);
        }
        await this.sendDingMessage({
          conversationId, sessionWebhook,
          content: ok
            ? `▶️ 定时任务 **${cmd.id}** 已恢复`
            : `❌ 未找到定时任务: ${cmd.id}`,
          msgType: 'markdown',
        });
        return;
      }

      case 'create_cron': {
        // 先验证
        if (!isValidCronExpression(cmd.cronExpression)) {
          await this.sendDingMessage({
            conversationId, sessionWebhook,
            content: `❌ 无效的cron表达式: \`${cmd.cronExpression}\`\n\n💡 格式: \`分 时 日 月 周\`，如 \`0 9 * * *\``,
            msgType: 'markdown',
          });
          return;
        }
        if (!this.hasNotifyCapability(ctx.conversationConfig)) {
          await this.sendCronNoNotifyError(conversationId, sessionWebhook);
          return;
        }
        // 验证通过后执行并记录日志
        const job = this.cronEngine.addJob({
          conversationId,
          cronExpression: cmd.cronExpression,
          description: this.sanitizeLogContent(cmd.prompt.substring(0, 50)),
          prompt: cmd.prompt,
          senderStaffId,
          senderNick,
        });
        const logSession = await this.getOrCreateLogSession(conversationId, sessionWebhook, senderStaffId, senderNick, conversationConfig);
        if (logSession.sessionDir) {
          this.appendSessionLog(logSession.sessionDir, 'user', `/cron ${cmd.cronExpression} ${this.sanitizeLogContent(cmd.prompt)}`);
          this.appendSessionLog(logSession.sessionDir, 'assistant', `创建定时任务: ${job.id} [${job.cronExpression}] ${job.description}`);
        }
        await this.sendDingMessage({
          conversationId, sessionWebhook,
          content: formatCronJobInfo(job),
          msgType: 'markdown',
        });
        return;
      }

      case 'create_nl': {
        // 先验证
        if (!this.hasNotifyCapability(ctx.conversationConfig)) {
          await this.sendCronNoNotifyError(conversationId, sessionWebhook);
          return;
        }
        await this.sendDingMessage({
          conversationId, sessionWebhook,
          content: '⏳ 正在分析定时任务描述...',
        });
        const result = await this.cronEngine.analyzeAndCreate(
          conversationId, cmd.input, senderStaffId, senderNick,
        );
        // 分析完成后记录日志
        const logSession = await this.getOrCreateLogSession(conversationId, sessionWebhook, senderStaffId, senderNick, conversationConfig);
        if (result.job) {
          if (logSession.sessionDir) {
            this.appendSessionLog(logSession.sessionDir, 'user', `/cron ${this.sanitizeLogContent(cmd.input)}`);
            this.appendSessionLog(logSession.sessionDir, 'assistant', `创建定时任务: ${result.job.id} [${result.job.cronExpression}] ${result.job.description}`);
          }
          await this.sendDingMessage({
            conversationId, sessionWebhook,
            content: formatCronJobInfo(result.job),
            msgType: 'markdown',
          });
        } else {
          if (logSession.sessionDir) {
            this.appendSessionLog(logSession.sessionDir, 'user', `/cron ${this.sanitizeLogContent(cmd.input)}`);
            this.appendSessionLog(logSession.sessionDir, 'assistant', `定时任务分析失败: ${result.error}`);
          }
          await this.sendDingMessage({
            conversationId, sessionWebhook,
            content: `❌ 定时任务分析失败: ${result.error}\n\n💡 你也可以直接指定cron表达式: \`/cron 0 9 * * * 任务描述\``,
            msgType: 'markdown',
          });
        }
        return;
      }
    }
  }

  /**
   * 对日志内容进行转义，防止换行符破坏日志格式
   */
  private sanitizeLogContent(content: string): string {
    return content.replace(/\n/g, '\\n').replace(/\r/g, '\\r');
  }

  /**
   * 对命令输出进行截断和清理，防止过长或含特殊字符破坏钉钉消息
   */
  private sanitizeOutput(content: string): string {
    const cleaned = content.replace(/\r\n/g, '\n');
    const MAX_OUTPUT = 8000;
    if (cleaned.length > MAX_OUTPUT) {
      return cleaned.substring(0, MAX_OUTPUT) + '\n...(输出已截断)';
    }
    return cleaned;
  }

  /**
   * 截断消息文本，用于 /mq 队列显示
   */
  private truncateMsg(content: string, maxLen = 100): string {
    const oneLine = content.replace(/\n/g, ' ').trim();
    return oneLine.length > maxLen ? oneLine.slice(0, maxLen) + '...' : oneLine;
  }

  /**
   * 获取用于记录日志的 session
   * 如果有活跃 session 则复用，否则创建一个新的临时 session 目录
   * @param skipIfNoActiveSession 如果没有活跃 session 是否跳过创建（用于查询类操作）
   */
  private async getOrCreateLogSession(
    conversationId: string,
    sessionWebhook: string,
    senderStaffId: string,
    senderNick: string,
    _conversationConfig: IConfig['conversations'][0],
    skipIfNoActiveSession = false,
  ): Promise<{ sessionDir: string | null; isNew: boolean }> {
    // 查找活跃 session
    const activeFound = this.findActiveSession(conversationId);
    if (activeFound) {
      const sessionDir = this.getSessionDir(activeFound.session.session);
      return { sessionDir, isNew: false };
    }

    // 查询类操作不创建临时 session
    if (skipIfNoActiveSession) {
      return { sessionDir: null, isNew: false };
    }

    // 没有活跃 session，创建一个新的临时 session 目录用于记录日志
    const now = Date.now();
    const tempSession: ISession = {
      conversationId,
      sessionWebhook,
      startTime: now,
      startTimeStr: dateUtil.mm(now).format('YYYY-MM-DD-HH-mm-ss'),
      startStaffId: senderStaffId,
      startNickName: `[cron]${senderNick}`,
    };

    const sessionDir = this.getSessionDir(tempSession);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(`${sessionDir}/session.json`, JSON.stringify(tempSession, null, 2), 'utf-8');

    // 记录系统日志
    fs.appendFileSync(
      `${sessionDir}/session.log`,
      `[${timestamp()}] [SYSTEM]: 创建会话用于记录 /cron 命令操作\n`,
      'utf-8',
    );

    return { sessionDir, isNew: true };
  }

  private hasNotifyCapability(conv: IConfig['conversations'][0]): boolean {
    return !!(conv.dingToken || this.config.defaultDingToken);
  }

  private async sendCronNoNotifyError(conversationId: string, sessionWebhook: string): Promise<void> {
    await this.sendDingMessage({
      conversationId, sessionWebhook,
      content: '❌ 当前群未配置 dingToken 且无客户端级 defaultDingToken, 定时任务无法主动发送消息, 请联系管理员配置',
      msgType: 'markdown',
    });
  }

  /**
   * 处理机器人消息回调
   */
  private async botMsgGetCallback(res: DWClientDownStream): Promise<void> {
    this.dingStreamClient.socketCallBackResponse(res.headers.messageId, '');
    const rawData = JSON.parse(res.data) as IRawCallbackData;
    // console.log('rawData', rawData);
    const { senderNick, senderStaffId, conversationId, conversationTitle, sessionWebhook, msgtype, conversationType } = rawData;
    const textContent = rawData.text?.content?.trim() ?? '';

    this.debugLog(`收到消息: 群=${conversationTitle}(${conversationId}), 发送者=${senderNick}(${senderStaffId}), 类型=${msgtype}, 内容=${textContent.substring(0, 50)}`);

    // 权限校验
    if (!this.authCheck(senderStaffId, conversationId)) {
      await this.handleAuthRequest({
        senderStaffId,
        senderNick,
        conversationId,
        conversationType,
        conversationTitle: rawData.conversationTitle,
        sessionWebhook,
      });
      return;
    }

    const conversationConfig = this.getConversationConfig(conversationId);

    // ==================== Recorder 模式处理 ====================
    const recorderCmd = parseRecorderCommand(textContent);
    if (recorderCmd !== null) {
      if (!this.isOwner(senderStaffId) || conversationType !== '1') {
        await this.sendDingMessage({
          conversationId, sessionWebhook,
          content: '❌ Recorder 模式仅限 owner 单聊使用',
          msgType: 'markdown',
        });
        return;
      }

      if (recorderCmd === 'on') {
        this.recorderModeConversations.add(conversationId);
        const dir = getRecorderDir(this, conversationId);
        console.log(`[${timestamp()}] [recorder] 开启 recorder 模式: conversationId=${conversationId}, dir=${dir}`);
        await this.sendDingMessage({
          conversationId, sessionWebhook,
          content: `🔴 Recorder 模式已开启\n- 所有消息将被分类记录到本地\n- 保存目录: \`${dir}\`\n- 发送 \`/recorder exit\` 关闭`,
          msgType: 'markdown',
        });
      } else {
        this.recorderModeConversations.delete(conversationId);
        console.log(`[${timestamp()}] [recorder] 关闭 recorder 模式: conversationId=${conversationId}`);
        await this.sendDingMessage({
          conversationId, sessionWebhook,
          content: '⬜ Recorder 模式已关闭，恢复正常处理',
          msgType: 'markdown',
        });
      }
      return;
    }

    // Recorder 模式拦截：开启时所有消息都记录，不执行正常处理
    if (this.recorderModeConversations.has(conversationId)) {
      try {
        await recordMessage(this, rawData, conversationId);
        await this.sendDingMessage({
          conversationId, sessionWebhook,
          content: `✅ 已记录 ${msgtype}`,
        });
      } catch (err) {
        console.error(`[${timestamp()}] [recorder] 记录消息失败:`, err);
        await this.sendDingMessage({
          conversationId, sessionWebhook,
          content: `❌ 记录失败: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      return;
    }

    // 根据 msgtype 处理不同消息类型
    let prompt: string;

    if (msgtype === 'picture' && rawData.pictureDownloadCode) {
      const conversationDir = this.getConversationDir(conversationId);
      const useLocalOcr = conversationConfig?.useLocalOcr !== false;
      const result = await processPictureMessage(
        this, rawData.pictureDownloadCode, rawData.robotCode, conversationDir,
        useLocalOcr, textContent || undefined,
      );
      if (!result) {
        await this.sendDingMessage({
          conversationId, sessionWebhook, atUserId: senderStaffId,
          content: '⚠️ 图片下载失败，请重试或使用文字描述',
        });
        return;
      }
      prompt = result;
    } else if (msgtype === 'richText' && rawData.content?.richText) {
      const conversationDir = this.getConversationDir(conversationId);
      const useLocalOcr = conversationConfig?.useLocalOcr !== false;
      prompt = await processRichTextMessage(
        this, rawData.content.richText, rawData.robotCode, conversationDir, useLocalOcr,
      );
    } else if (msgtype === 'file') {
      const downloadCode = extractDownloadCode(rawData);
      if (downloadCode) {
        const conversationDir = this.getConversationDir(conversationId);
        const result = await processFileMessage(
          this, downloadCode, rawData.robotCode, conversationDir,
          textContent || undefined,
        );
        if (!result) {
          await this.sendDingMessage({
            conversationId, sessionWebhook, atUserId: senderStaffId,
            content: '⚠️ 文件下载失败，请重试',
          });
          return;
        }
        prompt = result;
      } else {
        await this.sendDingMessage({
          conversationId, sessionWebhook, atUserId: senderStaffId,
          content: '⚠️ 无法获取文件下载链接，请重新发送',
        });
        return;
      }
    } else {
      prompt = textContent;
      // 引用消息只 @机器人（无额外文本）时 textContent 为空，但仍有引用内容需要处理
      if (!prompt) {
        const quoteInfo = extractQuoteInfo(rawData);
        if (quoteInfo) {
          this.debugLog(`检测到引用消息(无正文): quoteMessageId=${quoteInfo.quoteMessageId}`);
          if (quoteInfo.quoteMessageId && !quoteInfo.quoteText) {
            const fetched = await fetchQuotedMessage(this, quoteInfo.quoteMessageId);
            if (fetched) quoteInfo.quoteText = fetched;
          }
          if (quoteInfo.quoteText) {
            prompt = formatPromptWithQuote('', quoteInfo);
          }
        }
      }
      if (!prompt) return;
    }

    // 提取引用消息（命令消息忽略引用）
    if (!prompt.startsWith('/') && msgtype === 'text' && textContent) {
      const quoteInfo = extractQuoteInfo(rawData);
      if (quoteInfo) {
        this.debugLog(`检测到引用消息: quoteMessageId=${quoteInfo.quoteMessageId}`);
        // 如有 messageId 但无文本内容,通过 API 获取
        if (quoteInfo.quoteMessageId && !quoteInfo.quoteText) {
          const fetched = await fetchQuotedMessage(this, quoteInfo.quoteMessageId);
          if (fetched) quoteInfo.quoteText = fetched;
        }
        // 注入引用上下文到 prompt
        if (quoteInfo.quoteText) {
          prompt = formatPromptWithQuote(prompt, quoteInfo);
        }
      }
    }

    // /cfg 命令：注册当前群到配置（仅 owner 可用，单聊模式也允许操作）
    // 未注册群：创建新配置；已注册群：刷新指定字段
    // 支持 --conversationId <id> 指定目标群（仅 owner，单聊模式不允许指定）
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

      // 确定目标 conversationId
      const targetConvId = cfgOpts.conversationId || conversationId;
      const isTargetOther = targetConvId !== conversationId;

      // 查找目标群配置
      const existingConv = isTargetOther
        ? this.config.conversations.find(c => c.conversationId === targetConvId)
        : conversationConfig;

      // 如果传入了任何字段，执行更新
      const hasUpdates = !!(cfgOpts.dingToken || cfgOpts.linkConversationId ||
        (cfgOpts.whiteUserList && cfgOpts.whiteUserList.length > 0) || cfgOpts.conversationTitle ||
        cfgOpts.atSender !== undefined || cfgOpts.receiveReply !== undefined || cfgOpts.preBash !== undefined ||
        cfgOpts.permissionMode !== undefined);

      if (existingConv && hasUpdates) {
        // 已注册群，刷新指定字段
        if (cfgOpts.conversationTitle) existingConv.conversationTitle = cfgOpts.conversationTitle;
        if (conversationType && !isTargetOther) existingConv.conversationType = conversationType;
        if (cfgOpts.dingToken) existingConv.dingToken = cfgOpts.dingToken;
        if (cfgOpts.linkConversationId) existingConv.linkConversationId = cfgOpts.linkConversationId;
        if (cfgOpts.atSender !== undefined) existingConv.atSender = cfgOpts.atSender;
        if (cfgOpts.receiveReply !== undefined) existingConv.receiveReply = cfgOpts.receiveReply;
        if (cfgOpts.preBash !== undefined) existingConv.preBash = cfgOpts.preBash;
        if (cfgOpts.permissionMode !== undefined) existingConv.permissionMode = cfgOpts.permissionMode;
        if (cfgOpts.whiteUserList && cfgOpts.whiteUserList.length > 0) {
          existingConv.whiteUserList = cfgOpts.whiteUserList;
          for (const item of cfgOpts.whiteUserList) {
            if (isMobile(item)) {
              await resolveUserId(this, item);
            }
          }
        }
        saveClientConfig(this);
        console.log(`[${timestamp()}] 刷新群配置: ${existingConv.conversationTitle || targetConvId}(${targetConvId})`);
      } else if (!existingConv) {
        // 未注册群，创建新配置
        const newConv: IConfig['conversations'][0] = {
          conversationId: targetConvId,
          conversationType: isTargetOther ? '1' : conversationType,
          conversationTitle: cfgOpts.conversationTitle || (isTargetOther ? '' : conversationTitle),
        };
        if (cfgOpts.dingToken) newConv.dingToken = cfgOpts.dingToken;
        if (cfgOpts.linkConversationId) newConv.linkConversationId = cfgOpts.linkConversationId;
        if (cfgOpts.atSender !== undefined) newConv.atSender = cfgOpts.atSender;
        if (cfgOpts.receiveReply !== undefined) newConv.receiveReply = cfgOpts.receiveReply;
        if (cfgOpts.preBash !== undefined) newConv.preBash = cfgOpts.preBash;
        if (cfgOpts.permissionMode !== undefined) newConv.permissionMode = cfgOpts.permissionMode;
        if (cfgOpts.whiteUserList && cfgOpts.whiteUserList.length > 0) {
          newConv.whiteUserList = cfgOpts.whiteUserList;
          for (const item of cfgOpts.whiteUserList) {
            if (isMobile(item)) {
              await resolveUserId(this, item);
            }
          }
        }
        this.config.conversations.push(newConv);
        saveClientConfig(this);
        console.log(`[${timestamp()}] 注册新群: ${newConv.conversationTitle || targetConvId}(${targetConvId}) 类型=${newConv.conversationType || '-'}`);
      }

      // 确保工作目录已创建
      const workDir = this.getConversationDir(targetConvId);
      if (!fs.existsSync(workDir)) {
        fs.mkdirSync(workDir, { recursive: true });
        console.log(`[${timestamp()}] 创建工作目录: ${workDir}`);
      }

      // 统一返回当前群配置信息
      const convToShow = existingConv || this.getConversationConfig(targetConvId);
      const info: string[] = [
        existingConv ? `✅ 群配置已刷新` : `✅ 群已注册`,
        `- **群名称:** ${convToShow?.conversationTitle || targetConvId}`,
        `- **群ID:** ${targetConvId}`,
      ];
      if (convToShow?.conversationType) info.push(`- **会话类型:** ${convToShow.conversationType === '1' ? '单聊' : convToShow.conversationType === '2' ? '群聊' : convToShow.conversationType}`);
      if (convToShow?.dingToken) info.push(`- **dingToken:** ${convToShow.dingToken.substring(0, 8)}...`);
      else info.push('- **dingToken:** (未指定, 使用 defaultDingToken)');
      if (convToShow?.linkConversationId) info.push(`- **linkConversationId:** ${convToShow.linkConversationId}`);
      if (convToShow?.atSender === false) info.push('- **atSender:** false (不 @ 发送人)');
      if (convToShow?.receiveReply === false) info.push('- **receiveReply:** false (不回复确认消息)');
      if (convToShow?.permissionMode) info.push(`- **permissionMode:** ${convToShow.permissionMode}`);
      if (convToShow?.whiteUserList?.length) {
        const display = convToShow.whiteUserList.map(item => {
          if (isMobile(item)) return item;
          return userIdToPhone(this, item) || item;
        }).join(', ');
        info.push(`- **whiteUserList:** ${display}`);
      }
      info.push(`- **工作目录:** ${workDir}`);
      info.push('\n💡 可编辑 config.json 补充更多配置');
      await this.sendDingMessage({
        conversationId,
        sessionWebhook,
        content: info.join('\n'),
        msgType: 'markdown',
      });
      return;
    }

    // 帮助类命令：未注册群也可查看
    // /help 命令：查看所有可用命令
    if (parseHelpCommand(prompt)) {
      await this.sendDingMessage({
        conversationId,
        sessionWebhook,
        content: formatHelpOverview(TOOL_VERSION, this.isOwner(senderStaffId)),
        msgType: 'markdown',
      });
      return;
    }

    // /version 命令：查看工具版本
    if (parseVersionCommand(prompt)) {
      await this.sendDingMessage({
        conversationId,
        sessionWebhook,
        content: `**版本:** ${TOOL_VERSION}`,
        msgType: 'markdown',
      });
      return;
    }

    // /{cmd} --help 命令：查看单个命令详细帮助
    const helpCmdName = parseCommandHelp(prompt);
    if (helpCmdName) {
      const cmdDef = getCommandByName(helpCmdName);
      if (cmdDef) {
        await this.sendDingMessage({
          conversationId,
          sessionWebhook,
          content: formatCommandHelp(cmdDef),
          msgType: 'markdown',
        });
      } else {
        await this.sendDingMessage({
          conversationId,
          sessionWebhook,
          content: `❌ 未找到命令: **${helpCmdName}**\n\n💡 输入 \`/help\` 查看所有可用命令`,
          msgType: 'markdown',
        });
      }
      return;
    }

    // /reboot 命令：重启 cc-ding 进程（仅 owner 可用，未注册群也可用）
    const rebootCmd = parseRebootCommand(prompt);
    if (rebootCmd) {
      if (!(await this.requireOwner(conversationId, sessionWebhook, senderStaffId))) return;

      // 校验 tag 参数，防止 shell 注入
      if (rebootCmd.tag && !/^[\w.\-]+$/.test(rebootCmd.tag)) {
        await this.sendDingMessage({
          conversationId, sessionWebhook,
          content: '❌ 无效的 tag，仅允许字母、数字、点、横线和下划线',
          msgType: 'markdown',
        });
        return;
      }

      const tag = rebootCmd.tag ? `@${rebootCmd.tag}` : '';
      const cmd = rebootCmd.update
        ? `pnpm add -g cc-ding${tag}`
        : null;
      const processName = `cc-ding-${this.clientId}`;

      await this.sendDingMessage({
        conversationId,
        sessionWebhook,
        content: cmd
          ? `✅ 更新并重启，正在执行 ${cmd}...`
          : `✅ cc-ding 正在重启中...`,
        msgType: 'markdown',
      });

      // 先写 flag 文件，避免进程 crash 丢失
      const rebootFlagFile = path.join(this.getClientDir(), '.reboot_pending');
      fs.writeFileSync(rebootFlagFile, JSON.stringify({
        conversationId,
        senderStaffId,
        sessionWebhook,
        update: rebootCmd.update,
      }), 'utf-8');

      setTimeout(() => {
        console.log(`[${timestamp()}] 执行 pm2 restart ${processName}${cmd ? ' (含更新)' : ''}`);
        childExec(`${cmd ? `${cmd} && ` : ''}pm2 restart "${processName}"`, { timeout: 60_000 }, (err) => {
          if (err) console.error(`[${timestamp()}] pm2 restart 失败:`, err);
        });
      }, 1000);
      return;
    }

    if (!conversationConfig) {
      console.log(`未注册的机器人,群:${conversationTitle},${conversationId}`);
      if (this.isOwner(senderStaffId)) {
        await this.sendDingMessage({
          conversationId,
          sessionWebhook,
          atUserId: senderStaffId,
          content: `⚠️ 该群未注册，请先使用 \`/cfg\` 命令注册`,
          msgType: 'markdown',
        });
      } else {
        await this.sendDingMessage({
          conversationId,
          sessionWebhook,
          atUserId: senderStaffId,
          content: `抱歉,该群的机器人未在服务端注册,请联系应用机器人owner注册(${conversationId})...`,
        });
      }
      return;
    }

    // /clean 命令：清除历史会话和缓存（单聊模式也允许操作）
    const cleanType = parseCleanCommand(prompt);
    if (cleanType !== null) {
      // 单聊模式仅限 clean 当前群
      if (cleanType === 'all' && conversationConfig?.conversationType !== '1' && !this.isOwner(senderStaffId)) {
        await this.sendDingMessage({
          conversationId, sessionWebhook,
          content: '❌ 只有机器人 owner 才能清除所有群缓存',
          msgType: 'markdown',
        });
        return;
      }
      if (!(await this.requireOwnerOrSingleChat(conversationId, sessionWebhook, senderStaffId, conversationConfig))) return;

      const targetConvId = cleanType === 'all' ? null : conversationId;
      const result = this.cleanCache(targetConvId, true);

      const parts: string[] = [];
      parts.push(`🧹 缓存清理完成`);
      if (result.sessionsDeleted > 0) parts.push(`- 会话目录: ${result.sessionsDeleted} 个`);
      if (result.tasksDeleted > 0) parts.push(`- 任务目录: ${result.tasksDeleted} 个`);
      if (result.imagesDeleted > 0) parts.push(`- 图片文件: ${result.imagesDeleted} 个`);
      if (result.sessionsDeleted === 0 && result.tasksDeleted === 0 && result.imagesDeleted === 0) {
        parts.push('(无历史数据)');
      }
      parts.push('\n💡 活跃会话已保留');

      if (result.errors.length > 0) {
        parts.push(`\n⚠️ 错误: ${result.errors.join('; ')}`);
      }

      await this.sendDingMessage({
        conversationId,
        sessionWebhook,
        content: parts.join('\n'),
        msgType: 'markdown',
      });
      return;
    }

    // /reset-apikeycfg 命令：手工重置 API Key 配置（仅 owner 可用）
    if (parseResetApiKeyCfgCommand(prompt)) {
      if (!(await this.requireOwner(conversationId, sessionWebhook, senderStaffId))) return;

      if (!this.config.apiKeyCfg) {
        await this.sendDingMessage({
          conversationId,
          sessionWebhook,
          content: '⚠️ 未配置 apiKeyCfg，无需重置',
          msgType: 'markdown',
        });
        return;
      }

      resetApiKeyCfg(this);
      const validCount = this.config.apiKeyCfg.claudeSettings.filter(s => s.isValid).length;
      await this.sendDingMessage({
        conversationId,
        sessionWebhook,
        content: `✅ apiKeyCfg 已重置\n- 有效 Key 数: ${validCount}/${this.config.apiKeyCfg.claudeSettings.length}\n- 重置时间: ${this.config.apiKeyCfg.resetTime || '-'}`,
        msgType: 'markdown',
      });
      return;
    }

    // /auth 命令：管理当前群白名单（仅 owner 可用）
    const authCmd = parseAuthCommand(prompt);
    if (authCmd) {
      if (!(await this.requireOwner(conversationId, sessionWebhook, senderStaffId))) return;

      // /auth approve|reject <requestId>
      if (authCmd.type === 'approve' || authCmd.type === 'reject') {
        const request = this.pendingAuthRequests.get(authCmd.requestId);
        if (!request) {
          await this.sendDingMessage({
            conversationId, sessionWebhook,
            content: `❌ 未找到授权申请: ${authCmd.requestId}`,
            msgType: 'markdown',
          });
          return;
        }

        this.pendingAuthRequests.delete(authCmd.requestId);

        if (authCmd.type === 'approve') {
          let targetConv = this.config.conversations.find(c => c.conversationId === request.conversationId);
          if (!targetConv) {
            targetConv = {
              conversationId: request.conversationId,
              conversationType: request.conversationType || '1',
              conversationTitle: request.conversationTitle,
            };
            this.config.conversations.push(targetConv);
          }
          if (!targetConv.whiteUserList) {
            targetConv.whiteUserList = [];
          }
          if (!targetConv.whiteUserList.includes(request.senderStaffId)) {
            targetConv.whiteUserList.push(request.senderStaffId);
          }
          saveClientConfig(this);
          console.log(`[${timestamp()}] 授权申请通过将: id=${authCmd.requestId}, userId=${request.senderStaffId}`);
          await sendMessageToUser(this, request.senderStaffId,
            '✅ 您的授权申请已通过，现在可以开始使用了', 'markdown');
          await this.sendDingMessage({
            conversationId, sessionWebhook,
            content: `✅ 已通过授权申请\n- **用户ID:** ${request.senderStaffId}\n- **昵称:** ${request.senderNick}\n- **会话ID:** ${request.conversationId}`,
            msgType: 'markdown',
          });
        } else {
          console.log(`[${timestamp()}] 授权申请拒绝: id=${authCmd.requestId}, userId=${request.senderStaffId}`);
          await sendMessageToUser(this, request.senderStaffId,
            '❌ 您的授权申请已被拒绝', 'markdown');
          await this.sendDingMessage({
            conversationId, sessionWebhook,
            content: `✅ 已拒绝授权申请\n- **用户ID:** ${request.senderStaffId}\n- **昵称:** ${request.senderNick}`,
            msgType: 'markdown',
          });
        }
        return;
      }

      const convWhiteList = conversationConfig.whiteUserList;

      if (authCmd.type === 'list') {
        const list = convWhiteList && convWhiteList.length > 0
          ? convWhiteList.map(id => {
            const phone = userIdToPhone(this, id);
            return `- ${phone || id}`;
          }).join('\n')
          : '(未配置群级白名单，使用全局白名单)';
        await this.sendDingMessage({
          conversationId,
          sessionWebhook,
          content: `📋 **当前群白名单**\n${list}`,
          msgType: 'markdown',
        });
        return;
      }

      if (authCmd.type === 'add') {
        // 解析手机号为 userId（用于去重检查），但 config 中存储原始值
        let targetUserId = authCmd.staffId;
        if (isMobile(authCmd.staffId)) {
          targetUserId = await resolveUserId(this, authCmd.staffId);
          if (!targetUserId) {
            await this.sendDingMessage({
              conversationId,
              sessionWebhook,
              content: `⚠️ 无法解析手机号: ${authCmd.staffId}`,
              msgType: 'markdown',
            });
            return;
          }
        }

        // 去重检查：比较 resolved userId
        const alreadyExists = convWhiteList?.some(item => resolveToUserId(this, item) === targetUserId);
        if (alreadyExists) {
          const display = userIdToPhone(this, targetUserId) || targetUserId;
          await this.sendDingMessage({
            conversationId,
            sessionWebhook,
            content: `⚠️ ${display} 已在当前群白名单中`,
            msgType: 'markdown',
          });
          return;
        }
        if (!conversationConfig.whiteUserList) {
          conversationConfig.whiteUserList = [];
        }
        conversationConfig.whiteUserList.push(authCmd.staffId);
        saveClientConfig(this);
        const displayItems = conversationConfig.whiteUserList.map(item => {
          const uid = resolveToUserId(this, item);
          return userIdToPhone(this, uid) || item;
        });
        const addedDisplay = isMobile(authCmd.staffId) ? authCmd.staffId : (userIdToPhone(this, authCmd.staffId) || authCmd.staffId);
        await this.sendDingMessage({
          conversationId,
          sessionWebhook,
          content: `✅ 已添加 ${addedDisplay} 到当前群白名单\n当前白名单: ${displayItems.join(', ')}`,
          msgType: 'markdown',
        });
        return;
      }

      if (authCmd.type === 'del') {
        // 解析手机号为 userId（用于查找），但 config 中删除匹配项
        let targetUserId = authCmd.staffId;
        if (isMobile(authCmd.staffId)) {
          targetUserId = await resolveUserId(this, authCmd.staffId);
          if (!targetUserId) {
            await this.sendDingMessage({
              conversationId,
              sessionWebhook,
              content: `⚠️ 无法解析手机号: ${authCmd.staffId}`,
              msgType: 'markdown',
            });
            return;
          }
        }

        // 查找匹配项：比较 resolved userId
        const foundIndex = convWhiteList?.findIndex(item => resolveToUserId(this, item) === targetUserId) ?? -1;
        if (foundIndex < 0) {
          const display = userIdToPhone(this, targetUserId) || targetUserId;
          await this.sendDingMessage({
            conversationId,
            sessionWebhook,
            content: `⚠️ ${display} 不在当前群白名单中`,
            msgType: 'markdown',
          });
          return;
        }
        const removedItem = conversationConfig.whiteUserList![foundIndex];
        conversationConfig.whiteUserList.splice(foundIndex, 1);
        // 清理空数组
        if (conversationConfig.whiteUserList.length === 0) {
          delete conversationConfig.whiteUserList;
        }
        saveClientConfig(this);
        const display = conversationConfig.whiteUserList?.length
          ? conversationConfig.whiteUserList.map(item => {
            const uid = resolveToUserId(this, item);
            return userIdToPhone(this, uid) || item;
          }).join(', ')
          : '(空，使用全局白名单)';
        const removedDisplay = userIdToPhone(this, targetUserId) || removedItem;
        await this.sendDingMessage({
          conversationId,
          sessionWebhook,
          content: `✅ 已移除 ${removedDisplay}\n当前白名单: ${display}`,
          msgType: 'markdown',
        });
        return;
      }
    }

    // /open 命令：在文件管理器或终端中打开工作目录（仅 owner 可用）
    const openTarget = parseOpenCommand(prompt);
    if (openTarget !== null) {
      if (!(await this.requireOwner(conversationId, sessionWebhook, senderStaffId))) return;

      const conversationDir = this.getConversationDir(conversationId);
      const { exec } = await import('child_process');
      const platform = process.platform;

      try {
        if (openTarget === 'folder') {
          if (platform === 'darwin') {
            exec(`open "${conversationDir}"`);
          } else {
            exec(`explorer "${conversationDir}"`);
          }
          await this.sendDingMessage({
            conversationId, sessionWebhook,
            content: `📂 已在文件管理器中打开:\n\`\`\`\n${conversationDir}\n\`\`\``,
            msgType: 'markdown',
          });
        } else if (openTarget === 'code') {
          exec('which code', (err) => {
            if (err) {
              this.sendDingMessage({
                conversationId, sessionWebhook,
                content: '❌ 未检测到 VS Code `code` 命令\n请安装 VS Code 并通过 Command Palette 安装 Shell Command',
                msgType: 'markdown',
              });
              return;
            }
            exec(`code "${conversationDir}"`);
            this.sendDingMessage({
              conversationId, sessionWebhook,
              content: `💻 已在 VS Code 中打开:\n\`\`\`\n${conversationDir}\n\`\`\``,
              msgType: 'markdown',
            });
          });
        } else {
          if (platform === 'darwin') {
            exec(`open -a Terminal "${conversationDir}"`);
          } else {
            exec(`start cmd /k "cd /d ${conversationDir}"`, { shell: 'cmd.exe' });
          }
          await this.sendDingMessage({
            conversationId, sessionWebhook,
            content: `💻 已在终端中打开:\n\`\`\`\n${conversationDir}\n\`\`\``,
            msgType: 'markdown',
          });
        }
      } catch (err) {
        await this.sendDingMessage({
          conversationId, sessionWebhook,
          content: `❌ 打开失败: ${err instanceof Error ? err.message : String(err)}`,
          msgType: 'markdown',
        });
      }
      return;
    }

    // /cron 命令：定时任务管理
    const cronCmd = parseCronCommand(prompt);
    if (cronCmd) {
      await this.handleCronCommand(cronCmd, { conversationId, sessionWebhook, senderStaffId, senderNick, conversationConfig });
      return;
    }

    // /bash 命令：在工作目录执行 bash 命令
    const bashCmd = parseBashCommand(prompt);
    if (bashCmd !== null) {
      const conversationDir = this.getConversationDir(conversationId);
      // 全局 preBash + 群级别 preBash 叠加执行
      const preBashParts: string[] = [];
      if (this.config.preBash) preBashParts.push(this.config.preBash);
      if (conversationConfig?.preBash) preBashParts.push(conversationConfig.preBash);
      const finalCmd = preBashParts.length > 0 ? `${preBashParts.join(' ; ')} ; ${bashCmd}` : bashCmd;
      const self = this;

      childExec(finalCmd, {
        cwd: conversationDir,
        timeout: 30000,
        maxBuffer: 1024 * 1024, // 1MB
      }, async (error, stdout, stderr) => {
        try {
          let replyContent: string;
          if (error) {
            replyContent = `❌ 命令执行失败\n\`\`\`\n${error.message}\n\`\`\``;
            if (stderr) {
              replyContent += `\n\n**stderr:**\n\`\`\`\n${self.sanitizeOutput(stderr)}\n\`\`\``;
            }
          } else {
            const output = stdout || '(无输出)';
            replyContent = `✅ 执行成功\n\`\`\`\n${self.sanitizeOutput(output)}\n\`\`\``;
            if (stderr) {
              replyContent += `\n\n**stderr:**\n\`\`\`\n${self.sanitizeOutput(stderr)}\n\`\`\``;
            }
          }

          await self.sendDingMessage({
            conversationId, sessionWebhook,
            content: replyContent,
            msgType: 'markdown',
          });
        } catch (sendErr) {
          console.error(`[bash] 发送消息失败:`, sendErr);
        }
      });
      return;
    }

    // 处理特殊命令
    // /new 命令
    if (/^\/new(?:\s|$)/i.test(prompt)) {
      const activeFound = this.findActiveSession(conversationId);
      if (activeFound) {
        console.log(`收到新会话命令，结束旧会话: 群=${activeFound.session.session.conversationId}, 会话ID=${this.getSessionId(activeFound.session.session)}`);
        this.interruptClaudeProcess(activeFound.session, '新会话命令中断正在执行的 Claude 进程');
        this.activeSessions.delete(activeFound.key);
        this.saveActiveSession(activeFound.key);
      }
      const actualMsg = prompt.replace(/^\/new\s*/i, '').trim();
      if (actualMsg) {
        await this.startNewSession({
          conversationId,
          sessionWebhook,
          senderStaffId,
          senderNick,
          message: actualMsg,
          conversationConfig,
        });
      } else {
        await this.sendDingMessage({
          conversationId,
          sessionWebhook,
          atUserId: senderStaffId,
          content: '🚀 请输入您的问题开始新会话',
        });
      }
      return;
    }

    // 继续会话命令
    const targetSessionId = parseContinueSessionCommand(prompt);
    if (targetSessionId !== null && conversationConfig) {
      // 空字符串表示恢复最近会话
      let sessionIdToResume = targetSessionId;
      if (!sessionIdToResume) {
        const latestSession = findLatestSession(this, conversationId);
        if (!latestSession) {
          await this.sendDingMessage({
            conversationId,
            sessionWebhook,
            atUserId: senderStaffId,
            content: '⚠️ 未找到已结束的会话',
            msgType: 'markdown',
          });
          return;
        }
        sessionIdToResume = getSessionId(latestSession);
      }
      await this.switchToSession(conversationId, sessionWebhook, sessionIdToResume, senderStaffId, conversationConfig);
      return;
    }

    // /log 命令：读取最近 n 行会话日志
    const logLines = parseLogCommand(prompt);
    if (logLines !== null) {
      const logContent = this.readSessionLogTail(conversationId, logLines);
      if (logContent) {
        await this.sendDingMessage({
          conversationId,
          sessionWebhook,
          content: `📋 最近 ${logLines} 行日志:\n\`\`\`\n${logContent}\n\`\`\``,
          msgType: 'markdown',
        });
      } else {
        await this.sendDingMessage({
          conversationId,
          sessionWebhook,
          content: '⚠️ 当前无活跃会话或暂无日志',
        });
      }
      return;
    }

    // /info 命令：查看群配置和会话信息
    const infoType = parseInfoCommand(prompt);
    if (infoType !== null) {
      const parts: string[] = [];
      const workDir = this.getConversationDir(conversationId);
      if (infoType === 'all' || infoType === 'robot') {
        parts.push('### 🌐 全局核心配置\n' + formatGlobalConfig(this.config));
        parts.push('### 🤖 群配置信息\n' + formatConversationInfo(conversationConfig, conversationId, (uid) => userIdToPhone(this, uid), workDir));
      }
      if (infoType === 'all' || infoType === 'session') {
        const sessionInfo = this.formatSessionInfo(conversationId);
        if (sessionInfo) {
          parts.push('### 💬 当前会话信息\n' + sessionInfo);
        } else {
          parts.push('### 💬 当前会话信息\n无活跃会话');
        }
      }
      if (infoType === 'all' || infoType === 'task') {
        parts.push('### 📝 任务队列信息\n' + this.formatTaskInfo());
      }
      await this.sendDingMessage({
        conversationId,
        sessionWebhook,
        content: parts.join('\n\n'),
        msgType: 'markdown',
      });
      return;
    }

    // /ls 命令：查看目录结构
    const lsParsed = parseLsCommand(prompt);
    if (lsParsed !== null) {
      const { target, depth } = lsParsed;
      const conversationDir = this.getConversationDir(conversationId);
      let targetDir = conversationDir;
      let targetLabel = '当前工作目录';

      if (target && target !== 'root') {
        if (target.startsWith('./') || target.startsWith('../') || target.startsWith('/')) {
          const resolved = path.resolve(conversationDir, target);
          if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
            if (!resolved.startsWith(conversationDir)) {
              await this.sendDingMessage({
                conversationId, sessionWebhook,
                content: `❌ 路径超出工作目录范围`,
                msgType: 'markdown',
              });
              return;
            }
            targetDir = resolved;
            targetLabel = target;
          } else {
            await this.sendDingMessage({
              conversationId, sessionWebhook,
              content: `❌ 路径不存在或不是目录: **${target}**`,
              msgType: 'markdown',
            });
            return;
          }
        } else {
          const found = findSubdirByName(conversationDir, target);
          if (found) {
            targetDir = found;
            targetLabel = target;
          } else {
            await this.sendDingMessage({
              conversationId, sessionWebhook,
              content: `❌ 未找到名为 **${target}** 的目录`,
              msgType: 'markdown',
            });
            return;
          }
        }
      }

      const structure = getDirectoryStructure(targetDir, 0, depth);
      await this.sendDingMessage({
        conversationId,
        sessionWebhook,
        content: `📂 ${targetLabel} (展开${depth}层):\n\`\`\`\n${structure}\n\`\`\``,
        msgType: 'markdown',
      });
      return;
    }

    // /task cancel 命令
    const cancelQuery = parseTaskCancelCommand(prompt);
    if (cancelQuery) {
      const result = this.cancelTask(cancelQuery, conversationId);
      await this.sendDingMessage({
        conversationId,
        sessionWebhook,
        content: result,
        msgType: 'markdown',
      });
      return;
    }

    if (prompt.startsWith('/task ')) {
      const taskPrompt = prompt.substring(6).trim();
      if (taskPrompt) {
        await this.sendDingMessage({
          conversationId,
          sessionWebhook,
          atUserId: senderStaffId,
          content: '📋 任务已收到,完成后我会回复',
        });
        await this.saveTask({
          conversationId,
          prompt: taskPrompt,
          senderStaffId,
          senderNickName: senderNick,
          sessionWebhook,
        });
      }
      return;
    }

    // /mq 命令：查看和管理当前会话消息队列
    const mqCmd = parseMqCommand(prompt);
    if (mqCmd) {
      const activeSession = this.findActiveSession(conversationId);
      const queue = activeSession?.session.messageQueue ?? [];

      switch (mqCmd.type) {
        case 'list': {
          if (queue.length === 0) {
            await this.sendDingMessage({
              conversationId, sessionWebhook,
              content: '📭 当前无排队消息',
              msgType: 'markdown',
            });
          } else {
            const lines = queue.map((entry, i) =>
              `${i + 1}. **${entry.senderNick || entry.senderStaffId}:** ${this.truncateMsg(entry.message)}`,
            );
            await this.sendDingMessage({
              conversationId, sessionWebhook,
              content: `📨 消息队列 (${queue.length} 条)\n${lines.join('\n')}`,
              msgType: 'markdown',
            });
          }
          return;
        }

        case 'cancel': {
          if (queue.length === 0) {
            await this.sendDingMessage({
              conversationId, sessionWebhook,
              content: '📭 当前无排队消息',
              msgType: 'markdown',
            });
            return;
          }
          const removeCount = Math.min(mqCmd.count, queue.length);
          const removed = queue.splice(queue.length - removeCount, removeCount);
          const removedLines = removed.map((entry, i) =>
            `${i + 1}. **${entry.senderNick || entry.senderStaffId}:** ${this.truncateMsg(entry.message)}`,
          );
          await this.sendDingMessage({
            conversationId, sessionWebhook,
            content: `✅ 已从队尾移除 ${removeCount} 条消息\n${removedLines.join('\n')}`,
            msgType: 'markdown',
          });
          return;
        }

        case 'cancelAll': {
          if (queue.length === 0) {
            await this.sendDingMessage({
              conversationId, sessionWebhook,
              content: '📭 当前无排队消息',
              msgType: 'markdown',
            });
            return;
          }
          const removedCount = queue.length;
          queue.length = 0;
          await this.sendDingMessage({
            conversationId, sessionWebhook,
            content: `✅ 已清空消息队列，共移除 ${removedCount} 条消息`,
            msgType: 'markdown',
          });
          return;
        }
      }
    }

    // /goon 命令：强制重启 Claude 进程
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
            permissionMode: activeSession.conversationConfig.permissionMode,
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
            permissionMode: activeSession.conversationConfig.permissionMode,
          });
        } finally {
          activeSession.isProcessing = false;
        }
      }
      return;
    }

    // /cc 命令：直接透传消息给 Claude（不附加发送人信息）
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
          permissionMode: activeSession.conversationConfig.permissionMode,
        });
      } finally {
        activeSession.isProcessing = false;
      }
      return;
    }

    // /claude.md 命令：查看 CLAUDE.md 内容
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
    // 注入 @提及上下文（从钉钉回调的 atUsers 字段提取）
    let finalPrompt = prompt;
    if (rawData.atUsers && rawData.atUsers.length > 0) {
      const atInfo = rawData.atUsers
        .filter(u => u.staffId !== senderStaffId)  // 排除 @自己（通常是 @机器人）
        .map(u => `@${u.staffId}`)
        .join(', ');
      if (atInfo) {
        finalPrompt = `[提及用户: ${atInfo}]\n${finalPrompt}`;
      }
    }

    await this.handleSessionMessage({
      conversationId,
      sessionWebhook,
      senderStaffId,
      senderNick,
      message: finalPrompt,
      conversationConfig,
    });
  }

  /**
   * 启动时检查是否有重启后待通知的消息
   */
  private async notifyPendingReboot(): Promise<void> {
    const rebootFlagFile = path.join(this.getClientDir(), '.reboot_pending');
    if (!fs.existsSync(rebootFlagFile)) return;

    try {
      const rebootData = JSON.parse(fs.readFileSync(rebootFlagFile, 'utf-8')) as {
        conversationId: string;
        senderStaffId: string;
        sessionWebhook?: string;
        update?: boolean;
      };
      fs.unlinkSync(rebootFlagFile);

      let content = '✅ cc-ding 已重启完成';
      if (rebootData.update) {
        content += `\n**版本:** ${TOOL_VERSION}`;
      }

      // 优先使用 activeSession 的 webhook（关联群场景可能不同），回退到 flag 文件保存的 webhook
      let sessionWebhook: string | undefined;
      const activeSession = this.activeSessions.get(rebootData.conversationId);
      if (activeSession) {
        sessionWebhook = activeSession.session.sessionWebhook;
      } else if (rebootData.sessionWebhook) {
        sessionWebhook = rebootData.sessionWebhook;
        console.log(`[${timestamp()}] 重启后未找到活跃会话，使用保存的 sessionWebhook 发送通知`);
      } else {
        console.log(`[${timestamp()}] 重启后未找到活跃会话且无保存的 webhook，跳过通知`);
        return;
      }

      await this.sendDingMessage({
        conversationId: rebootData.conversationId,
        sessionWebhook,
        content,
        msgType: 'markdown',
        atUserId: rebootData.senderStaffId,
      });
      console.log(`[${timestamp()}] 重启完成通知已发送`);
    } catch (err) {
      try {
        const raw = fs.readFileSync(rebootFlagFile, 'utf-8');
        console.error(`[${timestamp()}] .reboot_pending 内容:`, raw);
      } catch { /* file may already be deleted */ }
      console.error(`[${timestamp()}] 处理重启通知失败:`, err);
      try { fs.unlinkSync(rebootFlagFile); } catch { /* ignore */ }
    }
  }

  /**
   * 启动服务
   */
  async run(): Promise<void> {
    // 防御：config.conversations 可能为 null/undefined（虽然 startupCheck 会拦截，但在 startupCheck 之前已访问）
    const conversations = Array.isArray(this.config.conversations) ? this.config.conversations : [];
    const taskHandlerCount = this.config.taskHandlerCount ?? this.DEFAULT_TASK_HANDLER_COUNT;
    const hasTaskEnabled = conversations.length > 0;

    console.log(`[${timestamp()}] 钉钉机器人服务启动，clientId: ${this.clientId}`);
    console.log(`[${timestamp()}] 群配置: ${conversations.map(c => c.conversationTitle || c.conversationId).join(', ')}`);

    // 启动自检
    startupCheck(this);

    // 解析 config 中的手机号为 userId
    await resolveAllPhonesInConfig(this);

    // 启动时重置 apiKeyCfg（仅当已配置时）
    if (this.config.apiKeyCfg) {
      resetApiKeyCfg(this);
      // 调度每天 0 点自动重置 apiKeyCfg
      scheduleApiKeyCfgDailyReset(this);
    }

    this.loadActiveSessions();

    // 检查是否有重启后待通知的消息
    await this.notifyPendingReboot();

    // 启动 Cron 引擎
    this.cronEngine.start();

    if (hasTaskEnabled) {
      console.log(`[${timestamp()}] 任务处理器数量: ${taskHandlerCount}`);
    }

    this.dingStreamClient.registerCallbackListener('/v1.0/im/bot/messages/get', async (res) => {
      await this.botMsgGetCallback(res);
    });

    const handlerPromises: Promise<void>[] = [];
    if (hasTaskEnabled) {
      for (let i = 0; i < taskHandlerCount; i++) {
        console.log(`[${timestamp()}] 启动任务处理器 #${i + 1}`);
        handlerPromises.push(this.runTaskHandlerLoop().catch(e => console.error(`任务处理器 #${i + 1} 错误:`, e)));
      }
    }

    const receiverPromise = this.dingStreamClient.connect().catch(error => {
      console.error('Fatal error', error);
      process.exit(1);
    });

    await Promise.all([ receiverPromise, ...handlerPromises ]);
  }
}

// 重新 export 类型
export type { IConfig, ISession, ITask, IActiveSession, IActiveSessionPersist, ISendMsgOpts, IRawCallbackData, IQuoteInfo, IDownloadedImage, ImageMediaType, IRichTextParagraph } from './types';
