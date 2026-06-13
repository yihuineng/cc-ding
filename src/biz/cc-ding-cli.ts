import { exec as childExec } from 'child_process';
import { DingStreamClient, DWClientDownStream, dateUtil } from 'utils-ok';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { projUtil } from '../common';
import { IConfig, IActiveSession, ISession, IRawCallbackData, IAuthRequest } from './types';
import { extractQuoteInfo, formatPromptWithQuote, enrichQuoteInfo } from './quote';
import { sendMessageToUser, sendOwnerMessage } from './messaging';
import { processPictureMessage, processRichTextMessage, processFileMessage, extractDownloadCode } from './image';
import {
  parseInfoCommand, formatConversationInfo, formatGlobalConfig, parseLogCommand,
  parseLsCommand, findSubdirByName, getDirectoryStructure,
  parseContinueSessionCommand, parseHelpCommand, parseCommandHelp,
  getCommandByName, formatHelpOverview, formatCommandHelp,
  parseCronCommand, parseVersionCommand, parseOpenCommand, parseCleanCommand, parseResetApiKeyCfgCommand, parseCfgCommand, parseAuthCommand,
  parseBashCommand, parseMqCommand, parseRecorderCommandEnhanced,
  parseGoonCommand, parseCcCommand, parseClaudeMdCommand,
  parseRebootCommand, parseInterruptCommand, parseMenuCommand, parseDestroyCommand, parseFreedomCommand,
} from './commands';
import { sendDingMessage, sendClaudeResponseToDing } from './messaging';
import { parseClaudeStreamLine, interruptClaudeProcess, executeClaudeQuery, injectStartupContexts } from './claude-process';
import { recordMessage, getRecorderDir } from './recorder';
import {
  getMergedMenu, addMenuItem, deleteMenuItem, formatMenuDisplay, formatMenuList,
  setPendingSelection, hasPendingSelection, getPendingSelection, clearPendingSelection,
  getUserTrigger, setUserTrigger, loadMenuData, startSelectionCleanupTimer,
} from './menu';
import {
  getClientDir, getClientConfig, authCheck, isOwner, isAdmin, debugLog,
  hashConversationId, getConversationConfig,
  getConversationDir, getSessionsDir, getTasksDir,
  getSessionDir, getSessionId, formatSessionInfo, readSessionLogTail,
  findHistorySession, findLatestSession, updateSessionFile, appendSessionLog,
  getActiveSessionsFile, saveActiveSession, loadActiveSessions,
  endSession, switchToSession, startNewSession, handleSessionMessage,
  findActiveSession, cleanCache,
  timestamp,
  resolveAllPhonesInConfig, resolveUserId, resolveToUserId, userIdToPhone, isMobile,
  resolveUserIdName,
} from './session';
import {
  countTodoTask, getOneTodoTask, finishTask,
  handleTask, runTaskHandlerLoop, saveTask, formatTaskInfo,
  cancelTask, parseTaskCancelCommand,
} from './task';
import {
  addTodoItem, doneTodoItem, deleteTodoItem, clearAllTodoItems,
  getSortedTodoItems, formatTodoList, formatTodoItemCreated,
  setReminderHour, getReminderHour, getIdMode, setIdMode,
  parseDeadline, getDefaultDeadline,
} from './todo';
import { parseTodoCommand } from './commands';
import { resetApiKeyCfg, scheduleApiKeyCfgDailyReset, startupCheck, saveClientConfig } from './api-key-manager';
import { resolveSecret } from './secrets';
import { ICommandRoute, route } from './command-route';
import { CronEngine, formatCronJobList, formatCronJobInfo, isValidCronExpression } from './cron';
import { commandExists, isWindows, isWindowsPlatform, spawnCommand } from './platform';

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

  /** 等待确认开启自由模式的会话 ID -> 发起时间戳（60s 超时，不持久化） */
  pendingFreedomConvs = new Map<string, number>();

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
        clientSecret: resolveSecret(this.config.clientSecret),
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
  isAdmin = (userId: string) => isAdmin(this, userId);
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
   * Owner 或管理员权限检查
   */
  private async requireOwnerOrAdmin(conversationId: string, sessionWebhook: string, senderStaffId: string): Promise<boolean> {
    if (this.isOwner(senderStaffId) || this.isAdmin(senderStaffId)) return true;
    await this.sendDingMessage({
      conversationId,
      sessionWebhook,
      content: '❌ 只有机器人 owner 或管理员才能执行此操作',
      msgType: 'markdown',
    });
    return false;
  }

  /**
   * 记录 /bash 命令审计日志（追加到客户端目录 bash-audit.log）
   */
  private appendBashAudit(conversationId: string, senderStaffId: string, cmd: string): void {
    try {
      const auditFile = path.join(this.getClientDir(), 'bash-audit.log');
      const line = `[${timestamp()}] conversation=${conversationId} user=${senderStaffId} cmd=${JSON.stringify(cmd)}\n`;
      fs.appendFileSync(auditFile, line, { encoding: 'utf-8', mode: isWindows() ? undefined : 0o600 });
    } catch (err) {
      console.error('写入 bash 审计日志失败:', err);
    }
  }

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
          `- **群ID:** \`${conversationId}\``,
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

  // ==================== /menu 命令处理 ====================

  private async handleMenuCommand(
    cmd: import('./commands').MenuCommand,
    ctx: { conversationId: string; sessionWebhook: string; senderStaffId: string },
  ): Promise<void> {
    const { conversationId, sessionWebhook, senderStaffId } = ctx;

    if ((cmd.type === 'add' || cmd.type === 'del') && cmd.isGlobal && !this.isOwner(senderStaffId)) {
      await this.sendDingMessage({
        conversationId, sessionWebhook,
        content: '❌ 全局菜单仅 owner 可管理',
        msgType: 'markdown',
      });
      return;
    }

    switch (cmd.type) {
      case 'show': {
        const items = getMergedMenu(this, conversationId, senderStaffId);
        const globalCount = loadMenuData(this).global.length;
        if (items.length > 0) {
          setPendingSelection(conversationId, senderStaffId, sessionWebhook, items);
        }
        await this.sendDingMessage({
          conversationId, sessionWebhook,
          content: formatMenuDisplay(items, globalCount),
          msgType: 'markdown',
        });
        return;
      }

      case 'add': {
        const item = addMenuItem(this, conversationId, senderStaffId, cmd.isGlobal, '', cmd.command);
        await this.sendDingMessage({
          conversationId, sessionWebhook,
          content: `✅ 已添加${cmd.isGlobal ? '全局' : '个人'}快捷指令: **${item.label}** → \`${item.command}\``,
          msgType: 'markdown',
        });
        return;
      }

      case 'del': {
        const result = deleteMenuItem(this, conversationId, senderStaffId, cmd.isGlobal, String(cmd.index));
        await this.sendDingMessage({
          conversationId, sessionWebhook,
          content: result.success
            ? `✅ 已删除${cmd.isGlobal ? '全局' : '个人'}快捷指令: **${result.deletedItem!.label}**`
            : `⚠️ ${result.error}`,
          msgType: 'markdown',
        });
        return;
      }

      case 'list': {
        await this.sendDingMessage({
          conversationId, sessionWebhook,
          content: formatMenuList(this, conversationId, senderStaffId, cmd.isGlobal),
          msgType: 'markdown',
        });
        return;
      }

      case 'trigger': {
        setUserTrigger(this, senderStaffId, cmd.word);
        await this.sendDingMessage({
          conversationId, sessionWebhook,
          content: `✅ 菜单触发词已设置为 \`${cmd.word}\`，发送该词即可唤起菜单`,
          msgType: 'markdown',
        });
        return;
      }
    }
  }

  // ==================== /todo 命令处理 ====================

  private async handleTodoCommand(
    cmd: import('./commands').TodoCommand,
    ctx: { conversationId: string; sessionWebhook: string; senderStaffId: string; senderNick: string },
  ): Promise<void> {
    const { conversationId, sessionWebhook, senderStaffId, senderNick } = ctx;

    if (cmd.type === 'mode') {
      setIdMode(this, conversationId, cmd.mode);
      const modeLabel = cmd.mode === 'staffId' ? '工号(staffId)' : '钉钉ID(dingtalkId)';
      await this.sendDingMessage({
        conversationId, sessionWebhook,
        content: `✅ 用户标识模式已切换为: **${modeLabel}**\n\n新添加的待办将使用此模式记录负责人`,
        msgType: 'markdown',
      });
      return;
    }

    if (cmd.type === 'list') {
      const items = getSortedTodoItems(this, conversationId);
      const remindHour = getReminderHour(this, conversationId);
      const idMode = getIdMode(this, conversationId);
      const modeLabel = idMode === 'staffId' ? '工号模式' : '钉钉ID模式';
      const listText = formatTodoList(items, remindHour);
      const content = `📌 当前标识模式: **${modeLabel}**\n\n${listText}`;
      await this.sendDingMessage({
        conversationId, sessionWebhook,
        content, msgType: 'markdown',
      });
      return;
    }

    if (cmd.type === 'remind') {
      setReminderHour(this, conversationId, cmd.hour);
      const text = cmd.hour === null ? '⏰ 每日提醒已关闭' : `⏰ 每日提醒已设置为 ${cmd.hour}:00`;
      await this.sendDingMessage({ conversationId, sessionWebhook, content: text });
      return;
    }

    if (cmd.type === 'done') {
      const result = doneTodoItem(this, conversationId, cmd.index);
      if (result.success && result.item) {
        await this.sendDingMessage({
          conversationId, sessionWebhook,
          content: `✅ 已完成: ~~${result.item.content}~~ _@${result.item.assigneeNick}_`,
          msgType: 'markdown',
        });
      } else {
        await this.sendDingMessage({ conversationId, sessionWebhook, content: `❌ ${result.error}` });
      }
      return;
    }

    if (cmd.type === 'remove') {
      if (cmd.index === 'all') {
        const result = clearAllTodoItems(this, conversationId);
        if (result.success) {
          await this.sendDingMessage({ conversationId, sessionWebhook, content: `🗑️ 已清空 ${result.count} 条待办` });
        } else {
          await this.sendDingMessage({ conversationId, sessionWebhook, content: `❌ ${result.error}` });
        }
      } else {
        const result = deleteTodoItem(this, conversationId, cmd.index);
        if (result.success && result.item) {
          await this.sendDingMessage({
            conversationId, sessionWebhook,
            content: `🗑️ 已删除: ~~${result.item.content}~~`,
            msgType: 'markdown',
          });
        } else {
          await this.sendDingMessage({ conversationId, sessionWebhook, content: `❌ ${result.error}` });
        }
      }
      return;
    }

    if (cmd.type === 'add') {
      const idMode = getIdMode(this, conversationId);
      const assigneeId = cmd.assigneeId || senderStaffId;
      const assigneeNick = cmd.assigneeNick || senderNick;

      const deadline = cmd.deadline ? parseDeadline(cmd.deadline) || getDefaultDeadline() : getDefaultDeadline();

      const item = addTodoItem(this, conversationId, {
        content: cmd.content,
        assigneeStaffId: assigneeId,
        assigneeNick,
        deadline,
        assigneeIdType: idMode,
      });

      const items = getSortedTodoItems(this, conversationId);
      const index = items.findIndex(i => i.content === item.content && i.createdAt === item.createdAt) + 1;
      const replyText = formatTodoItemCreated(item, index);
      await this.sendDingMessage({
        conversationId, sessionWebhook,
        content: replyText, msgType: 'markdown',
      });
      return;
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
    const recorderCmd = parseRecorderCommandEnhanced(textContent);
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

    // ==================== 自由模式确认拦截 ====================
    const pendingTime = this.pendingFreedomConvs.get(conversationId);
    if (pendingTime && Date.now() - pendingTime < 60_000) {
      const normalizedText = textContent.trim().toLowerCase();
      if (normalizedText === '确认' || normalizedText === 'confirm') {
        this.pendingFreedomConvs.delete(conversationId);
        const convConfig = this.getConversationConfig(conversationId);
        if (convConfig) {
          convConfig.freedomMode = true;
          saveClientConfig(this);
        }
        await this.sendDingMessage({
          conversationId, sessionWebhook,
          content: '✅ 自由模式已开启\n💡 所有群成员现在均可使用机器人',
          msgType: 'markdown',
        });
        return;
      }
    } else if (pendingTime && Date.now() - pendingTime >= 60_000) {
      // 超时清理
      this.pendingFreedomConvs.delete(conversationId);
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
        const conversationDir = this.getConversationDir(conversationId);
        const useLocalOcr = conversationConfig?.useLocalOcr !== false;
        const quoteInfo = extractQuoteInfo(rawData);
        if (quoteInfo) {
          this.debugLog(`检测到引用消息(无正文): quoteMessageId=${quoteInfo.quoteMessageId}`);
          // 增强引用：下载文件/图片、OCR 等
          await enrichQuoteInfo(this, quoteInfo, rawData, conversationDir, useLocalOcr);
          if (quoteInfo.quoteText) {
            prompt = formatPromptWithQuote('', quoteInfo);
          }
        }
      }
      if (!prompt) return;
    }

    // 提取引用消息（命令消息忽略引用）
    if (!prompt.startsWith('/') && msgtype === 'text' && textContent) {
      const conversationDir = this.getConversationDir(conversationId);
      const useLocalOcr = conversationConfig?.useLocalOcr !== false;
      const quoteInfo = extractQuoteInfo(rawData);
      if (quoteInfo) {
        this.debugLog(`检测到引用消息: quoteMessageId=${quoteInfo.quoteMessageId}`);
        // 增强引用：下载文件/图片、OCR 等
        await enrichQuoteInfo(this, quoteInfo, rawData, conversationDir, useLocalOcr);
        // 注入引用上下文到 prompt
        if (quoteInfo.quoteText) {
          prompt = formatPromptWithQuote(prompt, quoteInfo);
        }
      }
    }

    // ==================== /menu 快捷指令：触发词唤起与待选序号执行 ====================
    if (msgtype === 'text' && prompt && !prompt.startsWith('/')) {
      if (prompt.toLowerCase() === getUserTrigger(this, senderStaffId).toLowerCase()) {
        // 触发词唤起菜单，转为 /menu 走正常命令分发
        prompt = '/menu';
      } else if (/^\d+$/.test(prompt) && hasPendingSelection(conversationId, senderStaffId)) {
        const pending = getPendingSelection(conversationId, senderStaffId)!;
        clearPendingSelection(conversationId, senderStaffId);
        const idx = parseInt(prompt, 10);
        if (idx < 1 || idx > pending.mergedItems.length) {
          await this.sendDingMessage({
            conversationId, sessionWebhook, atUserId: senderStaffId,
            content: `⚠️ 序号无效，菜单共 ${pending.mergedItems.length} 项`,
          });
          return;
        }
        const item = pending.mergedItems[idx - 1];
        console.log(`[${timestamp()}] [menu] ${senderNick} 选择快捷指令: ${item.label} → ${item.command}`);
        // 将选中的指令作为本条消息内容，走正常命令分发/会话处理
        prompt = item.command;
      }
    }

    // ==================== 命令分发（注册表，按注册顺序匹配） ====================
    // 未注册群也可用的命令
    const preRegistrationRoutes: ICommandRoute[] = [
      // /cfg 命令：注册当前群到配置（仅 owner 可用，单聊模式也允许操作）
      // 未注册群：创建新配置；已注册群：刷新指定字段
      // 支持 --conversationId <id> 指定目标群（仅 owner，单聊模式不允许指定）
      route('/cfg', () => parseCfgCommand(prompt), async cfgOpts => {
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
      }),

      // 帮助类命令：未注册群也可查看
      // /help 命令：查看所有可用命令
      route('/help', () => parseHelpCommand(prompt), async () => {
        await this.sendDingMessage({
          conversationId,
          sessionWebhook,
          content: formatHelpOverview(TOOL_VERSION, this.isOwner(senderStaffId)),
          msgType: 'markdown',
        });
      }),

      // /version 命令：查看工具版本
      route('/version', () => parseVersionCommand(prompt), async () => {
        let claudeCliVersion = '未安装';
        try {
          const { stdout } = await new Promise<{ stdout: string }>((resolve, reject) => {
            childExec('claude --version', { timeout: 5000 }, (err, stdout, _stderr) => {
              if (err) reject(err);
              else resolve({ stdout });
            });
          });
          claudeCliVersion = stdout.trim() || '未知';
        } catch { /* ignore */ }

        const md = [
          '### 📦 cc-ding 版本信息',
          '',
          `- **cc-ding:** ${TOOL_VERSION}`,
          `- **Claude CLI:** ${claudeCliVersion}`,
          `- **Node.js:** ${process.version}`,
          `- **系统:** ${os.platform()} ${os.release()}`,
        ].join('\n');
        await this.sendDingMessage({
          conversationId,
          sessionWebhook,
          content: md,
          msgType: 'markdown',
        });
      }),

      // /{cmd} --help 命令：查看单个命令详细帮助
      route('cmd-help', () => parseCommandHelp(prompt), async helpCmdName => {
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
      }),

      // /reboot 命令：重启 cc-ding 进程（owner/管理员可用，未注册群也可用）
      route('/reboot', () => parseRebootCommand(prompt), async rebootCmd => {
        if (!(await this.requireOwnerOrAdmin(conversationId, sessionWebhook, senderStaffId))) return;

        // 校验 tag 参数，防止 shell 注入
        if (rebootCmd.tag && !/^[\w.\-]+$/.test(rebootCmd.tag)) {
          await this.sendDingMessage({
            conversationId, sessionWebhook,
            content: '❌ 无效的 tag，仅允许字母、数字、点、横线和下划线',
            msgType: 'markdown',
          });
          return;
        }

        const tag = rebootCmd.tag ? `@${rebootCmd.tag}` : '@latest';
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
      }),
    ];

    for (const r of preRegistrationRoutes) {
      if (await r.tryHandle()) return;
    }

    if (!conversationConfig) {
      console.log(`未注册的机器人,群:${conversationTitle},${conversationId}`);
      if (this.isOwner(senderStaffId)) {
        await this.sendDingMessage({
          conversationId,
          sessionWebhook,
          content: `⚠️ 该群未注册，请先使用 \`/cfg\` 命令注册`,
          msgType: 'markdown',
        });
      } else {
        await this.sendDingMessage({
          conversationId,
          sessionWebhook,
          content: `抱歉,该群的机器人未在服务端注册,请联系应用机器人owner注册(${conversationId})...`,
        });
      }
      return;
    }

    // 已注册群的命令路由表
    const commandRoutes: ICommandRoute[] = [
      // /destroy 命令：注销当前群机器人，删除工作目录和配置（仅 owner 可用）
      route('/destroy', () => parseDestroyCommand(prompt), async destroyOpts => {
        if (!(await this.requireOwnerOrSingleChat(conversationId, sessionWebhook, senderStaffId, conversationConfig))) return;

        const targetConvId = destroyOpts.conversationId || conversationId;
        const isTargetOther = targetConvId !== conversationId;
        if (isTargetOther && !this.isOwner(senderStaffId)) {
          await this.sendDingMessage({
            conversationId, sessionWebhook,
            content: '❌ 只有 owner 才能操作其他群的配置',
            msgType: 'markdown',
          });
          return;
        }

        const convIndex = this.config.conversations.findIndex(c => c.conversationId === targetConvId);
        if (convIndex < 0) {
          await this.sendDingMessage({
            conversationId, sessionWebhook,
            content: '⚠️ 该群未在配置中注册，无需注销',
            msgType: 'markdown',
          });
          return;
        }

        const conv = this.config.conversations[convIndex];
        const convTitle = conv.conversationTitle || targetConvId;

        // 从配置中移除
        this.config.conversations.splice(convIndex, 1);

        // 删除工作目录
        const workDir = this.getConversationDir(targetConvId);
        let dirDeleted = false;
        try {
          if (fs.existsSync(workDir)) {
            fs.rmSync(workDir, { recursive: true, force: true });
            dirDeleted = true;
          }
        } catch (err) {
          console.error(`[${timestamp()}] 删除工作目录失败:`, err);
        }

        // 清除内存状态
        const activeSession = this.activeSessions.get(targetConvId);
        if (activeSession?.currentProcess) {
          try { activeSession.currentProcess.kill('SIGTERM'); } catch { /* ignore */ }
        }
        this.activeSessions.delete(targetConvId);
        this.recorderModeConversations.delete(targetConvId);

        // 持久化配置
        saveClientConfig(this);

        console.log(`[${timestamp()}] 已注销群: ${convTitle}(${targetConvId})`);

        const parts: string[] = [
          '✅ 群机器人已注销',
          `- **群名称:** ${convTitle}`,
          `- **群ID:** ${targetConvId}`,
        ];
        if (dirDeleted) parts.push('- **工作目录:** 已删除');
        else parts.push('- **工作目录:** (不存在或无法删除)');
        if (activeSession) parts.push('- **活跃会话:** 已清除');
        parts.push('\n⚠️ 该群下次发送消息时将收到"未注册"提示');
        parts.push('💡 如需重新注册，请使用 `/cfg` 命令');

        await this.sendDingMessage({
          conversationId, sessionWebhook,
          content: parts.join('\n'),
          msgType: 'markdown',
        });
      }),

      // /freedom 命令：自由模式，跳过群用户白名单限制（仅 owner 可用）
      route('/freedom', () => parseFreedomCommand(prompt), async freedomOpts => {
        if (!(await this.requireOwnerOrSingleChat(conversationId, sessionWebhook, senderStaffId, conversationConfig))) return;

        if (freedomOpts.action === 'enter') {
          if (conversationConfig?.freedomMode) {
            await this.sendDingMessage({
              conversationId, sessionWebhook,
              content: 'ℹ️ 当前已处于自由模式',
              msgType: 'markdown',
            });
            return;
          }
          // 记录发起时间，60s 内回复"确认"或"confirm"即可开启
          this.pendingFreedomConvs.set(conversationId, Date.now());
          await this.sendDingMessage({
            conversationId, sessionWebhook,
            content: '⚠️ 开启自由模式后，所有群成员均可使用机器人（跳过白名单限制）\n\n60 秒内回复「确认」或「confirm」即可开启',
            msgType: 'markdown',
          });
        } else if (freedomOpts.action === 'exit') {
          if (!conversationConfig?.freedomMode) {
            await this.sendDingMessage({
              conversationId, sessionWebhook,
              content: 'ℹ️ 当前未开启自由模式',
              msgType: 'markdown',
            });
            return;
          }
          conversationConfig.freedomMode = false;
          saveClientConfig(this);
          this.pendingFreedomConvs.delete(conversationId);
          await this.sendDingMessage({
            conversationId, sessionWebhook,
            content: '✅ 自由模式已关闭\n🔒 已恢复白名单限制',
            msgType: 'markdown',
          });
        }
      }),

      // /clean 命令：清除历史会话和缓存（单聊模式也允许操作）
      route('/clean', () => parseCleanCommand(prompt), async cleanType => {
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
      }),

      // /reset-apikeycfg 命令：手工重置 API Key 配置（仅 owner 可用）
      route('/reset-apikeycfg', () => parseResetApiKeyCfgCommand(prompt), async () => {
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
      }),

      // /auth 命令：管理当前群白名单（仅 owner 可用）
      route('/auth', () => parseAuthCommand(prompt), async authCmd => {
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

        // /auth admin 命令：管理全局管理员列表
        if (authCmd.type === 'adminList') {
          const adminList = this.config.adminUserList && this.config.adminUserList.length > 0
            ? this.config.adminUserList.map(id => {
              const phone = userIdToPhone(this, id);
              return `- ${phone || id}`;
            }).join('\n')
            : '(未配置管理员)';
          await this.sendDingMessage({
            conversationId,
            sessionWebhook,
            content: `👑 **管理员列表**\n${adminList}`,
            msgType: 'markdown',
          });
          return;
        }

        if (authCmd.type === 'adminAdd') {
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

          const alreadyExists = this.config.adminUserList?.some(item => resolveToUserId(this, item) === targetUserId);
          if (alreadyExists) {
            const display = userIdToPhone(this, targetUserId) || targetUserId;
            await this.sendDingMessage({
              conversationId,
              sessionWebhook,
              content: `⚠️ ${display} 已在管理员列表中`,
              msgType: 'markdown',
            });
            return;
          }
          if (!this.config.adminUserList) {
            this.config.adminUserList = [];
          }
          this.config.adminUserList.push(authCmd.staffId);
          saveClientConfig(this);
          const addedDisplay = isMobile(authCmd.staffId) ? authCmd.staffId : (userIdToPhone(this, authCmd.staffId) || authCmd.staffId);
          await this.sendDingMessage({
            conversationId,
            sessionWebhook,
            content: `✅ 已添加 ${addedDisplay} 到管理员列表`,
            msgType: 'markdown',
          });
          return;
        }

        if (authCmd.type === 'adminRm') {
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

          const foundIndex = this.config.adminUserList?.findIndex(item => resolveToUserId(this, item) === targetUserId) ?? -1;
          if (foundIndex < 0) {
            const display = userIdToPhone(this, targetUserId) || targetUserId;
            await this.sendDingMessage({
              conversationId,
              sessionWebhook,
              content: `⚠️ ${display} 不在管理员列表中`,
              msgType: 'markdown',
            });
            return;
          }
          const removedItem = this.config.adminUserList![foundIndex];
          this.config.adminUserList.splice(foundIndex, 1);
          if (this.config.adminUserList.length === 0) {
            delete this.config.adminUserList;
          }
          saveClientConfig(this);
          const removedDisplay = userIdToPhone(this, targetUserId) || removedItem;
          await this.sendDingMessage({
            conversationId,
            sessionWebhook,
            content: `✅ 已移除 ${removedDisplay}`,
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
      }),

      // /open 命令：在文件管理器或终端中打开工作目录（仅 owner 可用）
      route('/open', () => parseOpenCommand(prompt), async openTarget => {
        if (!(await this.requireOwner(conversationId, sessionWebhook, senderStaffId))) return;

        const conversationDir = this.getConversationDir(conversationId);
        const platform = process.platform;
        const launchDetached = (command: string, args: string[], cwd?: string) => new Promise<void>((resolve, reject) => {
          const child = spawnCommand(command, args, {
            cwd,
            detached: true,
            stdio: 'ignore',
          });
          child.once('error', reject);
          child.once('spawn', () => {
            child.unref();
            resolve();
          });
        });

        try {
          if (openTarget === 'folder') {
            if (platform === 'darwin') {
              await launchDetached('open', [ conversationDir ]);
            } else if (isWindowsPlatform(platform)) {
              await launchDetached('explorer.exe', [ conversationDir ]);
            } else if (commandExists('xdg-open')) {
              await launchDetached('xdg-open', [ conversationDir ]);
            } else {
              throw new Error('未检测到可用的文件管理器打开命令');
            }
            await this.sendDingMessage({
              conversationId, sessionWebhook,
              content: `📂 已在文件管理器中打开:\n\`\`\`\n${conversationDir}\n\`\`\``,
              msgType: 'markdown',
            });
          } else if (openTarget === 'code') {
            if (!commandExists('code')) {
              await this.sendDingMessage({
                conversationId, sessionWebhook,
                content: '❌ 未检测到 VS Code `code` 命令\n请安装 VS Code 并确认 `code` 已加入 PATH',
                msgType: 'markdown',
              });
              return;
            }
            await launchDetached('code', [ conversationDir ]);
            await this.sendDingMessage({
              conversationId, sessionWebhook,
              content: `💻 已在 VS Code 中打开:\n\`\`\`\n${conversationDir}\n\`\`\``,
              msgType: 'markdown',
            });
          } else {
            if (platform === 'darwin') {
              await launchDetached('open', [ '-a', 'Terminal', conversationDir ]);
            } else if (isWindowsPlatform(platform)) {
              await launchDetached('cmd.exe', [ '/K', 'cd', '/d', conversationDir ]);
            } else if (commandExists('x-terminal-emulator')) {
              await launchDetached('x-terminal-emulator', [], conversationDir);
            } else {
              throw new Error('未检测到可用的终端打开命令');
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
      }),

      // /cron 命令：定时任务管理
      route('/cron', () => parseCronCommand(prompt), async cronCmd => {
        await this.handleCronCommand(cronCmd, { conversationId, sessionWebhook, senderStaffId, senderNick, conversationConfig });
      }),

      // /todo 命令：待办管理
      route('/todo', () => parseTodoCommand(prompt, rawData.atUsers), async todoCmd => {
        await this.handleTodoCommand(todoCmd, { conversationId, sessionWebhook, senderStaffId, senderNick });
      }),

      // /menu 命令：快捷指令菜单
      route('/menu', () => parseMenuCommand(prompt), async menuCmd => {
        await this.handleMenuCommand(menuCmd, { conversationId, sessionWebhook, senderStaffId });
      }),

      // /bash 命令：在工作目录执行 bash 命令
      route('/bash', () => parseBashCommand(prompt), async bashCmd => {
      // /bash 可在宿主机执行任意命令，仅限 owner/管理员，并记录审计日志
        if (!(await this.requireOwnerOrAdmin(conversationId, sessionWebhook, senderStaffId))) return;
        this.appendBashAudit(conversationId, senderStaffId, bashCmd);
        const conversationDir = this.getConversationDir(conversationId);
        // 全局 preBash + 群级别 preBash 叠加执行
        const preBashParts: string[] = [];
        if (this.config.preBash) preBashParts.push(this.config.preBash);
        if (conversationConfig?.preBash) preBashParts.push(conversationConfig.preBash);
        const shellJoiner = isWindowsPlatform() ? ' && ' : ' ; ';
        const finalCmd = preBashParts.length > 0 ? [ ...preBashParts, bashCmd ].join(shellJoiner) : bashCmd;
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
      }),

      // /new 命令：开始新会话
      route('/new', () => /^\/new(?:\s|$)/i.test(prompt), async () => {
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
            content: '🚀 请输入您的问题开始新会话',
          });
        }
      }),

      // /resume 继续会话命令
      route('/resume', () => parseContinueSessionCommand(prompt), async targetSessionId => {
      // 空字符串表示恢复最近会话
        let sessionIdToResume = targetSessionId;
        if (!sessionIdToResume) {
          const latestSession = findLatestSession(this, conversationId);
          if (!latestSession) {
            await this.sendDingMessage({
              conversationId,
              sessionWebhook,
              content: '⚠️ 未找到已结束的会话',
              msgType: 'markdown',
            });
            return;
          }
          sessionIdToResume = getSessionId(latestSession);
        }
        await this.switchToSession(conversationId, sessionWebhook, sessionIdToResume, senderStaffId, conversationConfig);
      }),

      // /log 命令：读取最近 n 行会话日志
      route('/log', () => parseLogCommand(prompt), async logLines => {
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
      }),

      // /info 命令：查看群配置和会话信息
      route('/info', () => parseInfoCommand(prompt), async infoType => {
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
      }),

      // /ls 命令：查看目录结构
      route('/ls', () => parseLsCommand(prompt), async lsParsed => {
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
      }),

      // /task cancel 命令
      route('/task cancel', () => parseTaskCancelCommand(prompt) || null, async cancelQuery => {
        const result = this.cancelTask(cancelQuery, conversationId);
        await this.sendDingMessage({
          conversationId,
          sessionWebhook,
          content: result,
          msgType: 'markdown',
        });
      }),

      // /task 命令：提交任务到队列
      route('/task', () => prompt.startsWith('/task ') || null, async () => {
        const taskPrompt = prompt.substring(6).trim();
        if (taskPrompt) {
          await this.sendDingMessage({
            conversationId,
            sessionWebhook,
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
      }),

      // /mq 命令：查看和管理当前会话消息队列
      // 注意: front/rm 类型不在此处理，保持原有行为继续透传给会话
      route('/mq', () => parseMqCommand(prompt), async mqCmd => {
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

          case 'front': {
            if (queue.length === 0) {
              await this.sendDingMessage({
                conversationId, sessionWebhook,
                content: '📭 当前无排队消息',
                msgType: 'markdown',
              });
              return;
            }
            // 优先插队发送者自己最近排队的消息，没有则取队尾消息
            let frontIdx = queue.length - 1;
            for (let i = queue.length - 1; i >= 0; i--) {
              if (queue[i].senderStaffId === senderStaffId) { frontIdx = i; break; }
            }
            if (frontIdx === 0) {
              await this.sendDingMessage({
                conversationId, sessionWebhook,
                content: 'ℹ️ 该消息已在队首，无需插队',
                msgType: 'markdown',
              });
              return;
            }
            const [ moved ] = queue.splice(frontIdx, 1);
            queue.unshift(moved);
            await this.sendDingMessage({
              conversationId, sessionWebhook,
              content: `✅ 已插队到队首\n1. **${moved.senderNick || moved.senderStaffId}:** ${this.truncateMsg(moved.message)}`,
              msgType: 'markdown',
            });
            return;
          }

          case 'rm': {
            if (queue.length === 0) {
              await this.sendDingMessage({
                conversationId, sessionWebhook,
                content: '📭 当前无排队消息',
                msgType: 'markdown',
              });
              return;
            }
            // /mq rm 无参数：清空全部
            if (mqCmd.all) {
              const removedCount = queue.length;
              queue.length = 0;
              await this.sendDingMessage({
                conversationId, sessionWebhook,
                content: `✅ 已清空消息队列，共移除 ${removedCount} 条消息`,
                msgType: 'markdown',
              });
              return;
            }
            const unique = [ ...new Set(mqCmd.indices) ];
            const valid = unique.filter(n => n >= 1 && n <= queue.length).sort((a, b) => b - a);
            const invalid = unique.filter(n => n < 1 || n > queue.length);
            if (valid.length === 0) {
              await this.sendDingMessage({
                conversationId, sessionWebhook,
                content: `⚠️ 序号无效，当前队列共 ${queue.length} 条`,
                msgType: 'markdown',
              });
              return;
            }
            // 从大到小删除，避免删除过程中序号位移
            const removed: typeof queue = [];
            for (const n of valid) {
              removed.unshift(queue.splice(n - 1, 1)[0]);
            }
            const removedLines = removed.map(entry =>
              `- **${entry.senderNick || entry.senderStaffId}:** ${this.truncateMsg(entry.message)}`,
            );
            let content = `✅ 已删除 ${removed.length} 条消息\n${removedLines.join('\n')}`;
            if (invalid.length > 0) {
              content += `\n⚠️ 已忽略无效序号: ${invalid.join(', ')}`;
            }
            await this.sendDingMessage({
              conversationId, sessionWebhook,
              content,
              msgType: 'markdown',
            });
            return;
          }
        }
      }),

      // /! 命令：中断当前任务，立即处理队列中的消息
      route('/!', () => parseInterruptCommand(prompt), async () => {
        const found = this.findActiveSession(conversationId);
        if (!found) {
          await this.sendDingMessage({
            conversationId, sessionWebhook,
            content: '⚠️ 当前没有活跃会话',
          });
          return;
        }
        const activeSession = found.session;
        if (!activeSession.currentProcess) {
          await this.sendDingMessage({
            conversationId, sessionWebhook,
            content: 'ℹ️ 当前没有正在执行的任务',
          });
          return;
        }
        // 中断后原调用栈中的 executeClaudeQuery 会结束，finally 释放 isProcessing 并自动 drain 消息队列
        interruptClaudeProcess(activeSession, `/!: ${senderNick} 中断当前任务`);
        const queued = activeSession.messageQueue.length;
        await this.sendDingMessage({
          conversationId, sessionWebhook,
          content: queued > 0 ? `⏹ 已中断当前任务，开始处理队列中的 ${queued} 条消息` : '⏹ 已中断当前任务',
        });
      }),

      // /goon 命令：强制重启 Claude 进程
      route('/goon', () => parseGoonCommand(prompt), async () => {
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
          // Windows 不支持 SIGINT，使用默认 kill
          if (isWindows()) {
            activeSession.currentProcess.kill();
          } else {
            activeSession.currentProcess.kill('SIGINT');
          }
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
      }),

      // /cc 命令：直接透传消息给 Claude（不附加发送人信息）
      route('/cc', () => parseCcCommand(prompt), async ccMessage => {
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
          if (activeSession.conversationConfig.receiveReply !== false) {
            await this.sendDingMessage({
              conversationId, sessionWebhook,
              content: '📥 已收到，正在处理...',
            }).catch(() => {});
          }
          await executeClaudeQuery(this, activeSession.session, ccMessage, {
            senderNick,
            senderStaffId,
            permissionMode: activeSession.conversationConfig.permissionMode,
          });
        } finally {
          activeSession.isProcessing = false;
        }
      }),

      // /claude.md 命令：查看 CLAUDE.md 内容
      route('/claude.md', () => parseClaudeMdCommand(prompt), async () => {
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
      }),
    ];

    for (const r of commandRoutes) {
      if (await r.tryHandle()) return;
    }

    // 处理普通 session 消息
    // 将 atUsers 中的 @提及 userId 替换为 昵称(userId)，写入日志
    let finalPrompt = prompt;
    const mentionedIds: string[] = [];

    // 从 atUsers 提取（排除机器人自身、发送者、空值）
    if (rawData.atUsers && rawData.atUsers.length > 0) {
      const botId = rawData.chatbotUserId;
      for (const u of rawData.atUsers) {
        const id = u.staffId || u.dingtalkId;
        if (!id || id === senderStaffId || id === botId || id.startsWith('$:LWCP_v1:')) continue;
        mentionedIds.push(id);
      }
    }

    if (mentionedIds.length > 0) {
      // 逐个替换消息中的零宽空格占位符 (U+200B)
      for (const id of mentionedIds) {
        const name = await resolveUserIdName(this, id);
        const replacement = name ? `${name}(${id})` : id;
        finalPrompt = finalPrompt.replace(/\u200b/g, replacement);
      }
    }

    // 防止 / 开头的非 /cc 命令被 Claude CLI 误识别为未知命令
    // 在 / 前加空格，让 Claude 当作普通文本处理
    if (finalPrompt.startsWith('/') && !finalPrompt.startsWith('/cc ')) {
      finalPrompt = ` ${finalPrompt}`;
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
   * 连接健康监控：定期检查 dingStreamClient 是否已连接，
   * 如果长时间 disconnected 且未自动重连，强制重新 connect
   */
  private startConnectionWatchdog(): void {
    const CHECK_INTERVAL_MS = 30 * 1000;  // 每 30 秒检查一次
    const DISCONNECT_THRESHOLD_MS = 60 * 1000;  // 超过 60 秒未连接则强制重连
    let lastConnectedTime = Date.now();

    setInterval(() => {
      const client = this.dingStreamClient;
      if (client.connected) {
        lastConnectedTime = Date.now();
        return;
      }

      const elapsed = Date.now() - lastConnectedTime;
      if (elapsed >= DISCONNECT_THRESHOLD_MS) {
        console.log(`[${timestamp()}] 连接监控: 已断开 ${elapsed / 1000}s，强制重新连接`);
        lastConnectedTime = Date.now();
        // 强制清理并重新连接
        try {
          client.disconnect();
        } catch { /* ignore */ }
        client.connect().catch(err => {
          console.error(`[${timestamp()}] 强制重连失败:`, err);
        });
      } else {
        this.debugLog(`连接监控: 已断开 ${elapsed / 1000}s，等待自动重连...`);
      }
    }, CHECK_INTERVAL_MS);
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

    // 启动时注入一次群信息上下文到各群的 .claude/CLAUDE.md，后续仅在配置变更时才更新
    injectStartupContexts(this);

    // 检查是否有重启后待通知的消息
    await this.notifyPendingReboot();

    // 启动 Cron 引擎
    this.cronEngine.start();

    // 启动 /menu 待选状态过期清理定时器
    startSelectionCleanupTimer();

    // 启动连接健康监控
    this.startConnectionWatchdog();

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
