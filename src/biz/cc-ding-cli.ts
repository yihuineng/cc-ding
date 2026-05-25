import { exec as childExec } from 'child_process';
import { DingStreamClient, DWClientDownStream, dateUtil } from 'utils-ok';
import fs from 'fs';
import path from 'path';
import { projUtil } from '../common';
import { IConfig, IActiveSession, ISession, IRawCallbackData } from './types';
import { extractQuoteInfo, formatPromptWithQuote } from './quote';
import { fetchQuotedMessage } from './messaging';
import { processPictureMessage, processRichTextMessage } from './image';
import {
  parseInfoCommand, formatConversationInfo, formatGlobalConfig, parseLogCommand,
  parseLsCommand, findSubdirByName, getDirectoryStructure,
  parseContinueSessionCommand, parseHelpCommand, parseCommandHelp,
  getCommandByName, formatHelpOverview, formatCommandHelp,
  parseCronCommand, parsePwdCommand, parseMkdirCommand, parseTouchCommand, parseRmCommand,
  parseVersionCommand, parseOpenCommand, parseCleanCommand, parseResetApiKeyCfgCommand, parseCfgCommand, parseAuthCommand,
  parseBashCommand, parseMqCommand,
} from './commands';
import { sendDingMessage, sendClaudeResponseToDing } from './messaging';
import { parseClaudeStreamLine, interruptClaudeProcess, executeClaudeQuery } from './claude-process';
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
  executeClaudeQuery = (session: ISession, message: string, opts?: { skill?: string; agent?: string; senderNick?: string; senderStaffId?: string }) =>
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
   * 解析并验证相对路径，确保不超出工作目录范围
   * @returns 解析后的绝对路径，验证失败返回 null
   */
  private resolveAndValidatePath(conversationId: string, relativePath: string): { absolutePath: string; error?: string } {
    const conversationDir = this.getConversationDir(conversationId);

    // 拒绝绝对路径
    if (relativePath.startsWith('/')) {
      return { absolutePath: '', error: '❌ 路径不能使用绝对路径（不能以 / 开头）' };
    }

    // 解析路径
    const resolvedPath = path.resolve(conversationDir, relativePath);

    // 确保解析后的路径在工作目录内
    if (!resolvedPath.startsWith(conversationDir)) {
      return { absolutePath: '', error: '❌ 路径超出工作目录范围' };
    }

    return { absolutePath: resolvedPath };
  }

  /**
   * 处理 /mkdir 命令
   */
  private async handleMkdirCommand(
    conversationId: string,
    sessionWebhook: string,
    relativePath: string,
  ): Promise<void> {
    const { absolutePath, error } = this.resolveAndValidatePath(conversationId, relativePath);
    if (error) {
      await this.sendDingMessage({
        conversationId, sessionWebhook,
        content: error,
        msgType: 'markdown',
      });
      return;
    }

    // 检查是否已存在
    try {
      const stat = fs.statSync(absolutePath);
      if (stat.isDirectory()) {
        await this.sendDingMessage({
          conversationId, sessionWebhook,
          content: `⚠️ 目录已存在: \`${relativePath}\``,
          msgType: 'markdown',
        });
      } else {
        await this.sendDingMessage({
          conversationId, sessionWebhook,
          content: `❌ 路径已存在但不是目录: \`${relativePath}\``,
          msgType: 'markdown',
        });
      }
      return;
    } catch {
      // 路径不存在，继续创建
    }

    try {
      fs.mkdirSync(absolutePath, { recursive: true });
      await this.sendDingMessage({
        conversationId, sessionWebhook,
        content: `✅ 目录创建成功: \`${relativePath}\``,
        msgType: 'markdown',
      });
    } catch (err) {
      await this.sendDingMessage({
        conversationId, sessionWebhook,
        content: `❌ 目录创建失败: \`${relativePath}\`\n原因: ${err instanceof Error ? err.message : String(err)}`,
        msgType: 'markdown',
      });
    }
  }

  /**
   * 处理 /rm 命令
   */
  private async handleRmCommand(
    conversationId: string,
    sessionWebhook: string,
    relativePath: string,
  ): Promise<void> {
    const { absolutePath, error } = this.resolveAndValidatePath(conversationId, relativePath);
    if (error) {
      await this.sendDingMessage({
        conversationId, sessionWebhook,
        content: error,
        msgType: 'markdown',
      });
      return;
    }

    // 检查是否存在
    let stat: fs.Stats;
    try {
      stat = fs.statSync(absolutePath);
    } catch {
      await this.sendDingMessage({
        conversationId, sessionWebhook,
        content: `❌ 路径不存在: \`${relativePath}\``,
        msgType: 'markdown',
      });
      return;
    }

    const isDir = stat.isDirectory();

    try {
      if (isDir) {
        fs.rmSync(absolutePath, { recursive: true, force: true });
      } else {
        fs.unlinkSync(absolutePath);
      }
      await this.sendDingMessage({
        conversationId, sessionWebhook,
        content: `✅ 已删除${isDir ? '目录' : '文件'}: \`${relativePath}\``,
        msgType: 'markdown',
      });
    } catch (err) {
      await this.sendDingMessage({
        conversationId, sessionWebhook,
        content: `❌ 删除失败: \`${relativePath}\`\n原因: ${err instanceof Error ? err.message : String(err)}`,
        msgType: 'markdown',
      });
    }
  }

  /**
   * 处理 /touch 命令
   */
  private async handleTouchCommand(
    conversationId: string,
    sessionWebhook: string,
    relativePath: string,
  ): Promise<void> {
    const { absolutePath, error } = this.resolveAndValidatePath(conversationId, relativePath);
    if (error) {
      await this.sendDingMessage({
        conversationId, sessionWebhook,
        content: error,
        msgType: 'markdown',
      });
      return;
    }

    // 检查是否已存在
    try {
      const stat = fs.statSync(absolutePath);
      if (stat.isFile()) {
        await this.sendDingMessage({
          conversationId, sessionWebhook,
          content: `⚠️ 文件已存在: \`${relativePath}\`\n最后修改时间: ${dateUtil.mm(stat.mtime).format('YYYY-MM-DD HH:mm:ss')}`,
          msgType: 'markdown',
        });
      } else {
        await this.sendDingMessage({
          conversationId, sessionWebhook,
          content: `❌ 路径已存在但不是文件: \`${relativePath}\``,
          msgType: 'markdown',
        });
      }
      return;
    } catch {
      // 路径不存在，继续创建
    }

    try {
      // 确保父目录存在（recursive: true 已处理已存在的情况）
      const parentDir = path.dirname(absolutePath);
      fs.mkdirSync(parentDir, { recursive: true });
      // 创建空文件
      fs.writeFileSync(absolutePath, '', 'utf-8');
      await this.sendDingMessage({
        conversationId, sessionWebhook,
        content: `✅ 文件创建成功: \`${relativePath}\``,
        msgType: 'markdown',
      });
    } catch (err) {
      await this.sendDingMessage({
        conversationId, sessionWebhook,
        content: `❌ 文件创建失败: \`${relativePath}\`\n原因: ${err instanceof Error ? err.message : String(err)}`,
        msgType: 'markdown',
      });
    }
  }

  /**
   * 处理机器人消息回调
   */
  private async botMsgGetCallback(res: DWClientDownStream): Promise<void> {
    this.dingStreamClient.socketCallBackResponse(res.headers.messageId, '');
    const rawData = JSON.parse(res.data) as IRawCallbackData;
    // console.log('rawData', rawData);
    const { senderNick, senderStaffId, conversationId, conversationTitle, sessionWebhook, msgtype } = rawData;
    const textContent = rawData.text?.content?.trim() ?? '';

    this.debugLog(`收到消息: 群=${conversationTitle}(${conversationId}), 发送者=${senderNick}(${senderStaffId}), 类型=${msgtype}, 内容=${textContent.substring(0, 50)}`);

    // 权限校验
    if (!this.authCheck(senderStaffId, conversationId)) {
      await this.sendDingMessage({
        conversationId,
        sessionWebhook,
        atUserId: senderStaffId,
        content: '抱歉,您暂无使用权限,请联系应用机器人owner授权...',
      });
      return;
    }

    const conversationConfig = this.getConversationConfig(conversationId);

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
    } else {
      prompt = textContent;
      if (!prompt) return;
    }

    // 提取引用消息（命令消息忽略引用）
    if (!prompt.startsWith('/') && msgtype === 'text') {
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

    // /cfg 命令：注册当前群到配置（仅 owner 可用）
    // 未注册群：创建新配置；已注册群：刷新指定字段
    const cfgOpts = parseCfgCommand(prompt);
    if (cfgOpts !== null) {
      if (!(await this.requireOwner(conversationId, sessionWebhook, senderStaffId))) return;

      const existingConv = conversationConfig;

      // 如果传入了任何字段，执行更新
      const hasUpdates = !!(cfgOpts.dingToken || cfgOpts.linkConversationId ||
        (cfgOpts.whiteUserList && cfgOpts.whiteUserList.length > 0) || cfgOpts.conversationTitle ||
        cfgOpts.atSender !== undefined || cfgOpts.receiveReply !== undefined || cfgOpts.preBash !== undefined);

      if (existingConv && hasUpdates) {
        // 已注册群，刷新指定字段
        if (cfgOpts.conversationTitle) existingConv.conversationTitle = cfgOpts.conversationTitle;
        if (cfgOpts.dingToken) existingConv.dingToken = cfgOpts.dingToken;
        if (cfgOpts.linkConversationId) existingConv.linkConversationId = cfgOpts.linkConversationId;
        if (cfgOpts.atSender !== undefined) existingConv.atSender = cfgOpts.atSender;
        if (cfgOpts.receiveReply !== undefined) existingConv.receiveReply = cfgOpts.receiveReply;
        if (cfgOpts.preBash !== undefined) existingConv.preBash = cfgOpts.preBash;
        if (cfgOpts.whiteUserList && cfgOpts.whiteUserList.length > 0) {
          existingConv.whiteUserList = cfgOpts.whiteUserList;
          // 预解析手机号到缓存
          for (const item of cfgOpts.whiteUserList) {
            if (isMobile(item)) {
              await resolveUserId(this, item);
            }
          }
        }
        saveClientConfig(this);
        console.log(`[${timestamp()}] 刷新群配置: ${existingConv.conversationTitle || conversationTitle}(${conversationId})`);
      } else if (!existingConv) {
        // 未注册群，创建新配置
        const newConv: IConfig['conversations'][0] = {
          conversationId,
          conversationTitle: cfgOpts.conversationTitle || conversationTitle,
        };
        if (cfgOpts.dingToken) newConv.dingToken = cfgOpts.dingToken;
        if (cfgOpts.linkConversationId) newConv.linkConversationId = cfgOpts.linkConversationId;
        if (cfgOpts.atSender !== undefined) newConv.atSender = cfgOpts.atSender;
        if (cfgOpts.receiveReply !== undefined) newConv.receiveReply = cfgOpts.receiveReply;
        if (cfgOpts.preBash !== undefined) newConv.preBash = cfgOpts.preBash;
        if (cfgOpts.whiteUserList && cfgOpts.whiteUserList.length > 0) {
          newConv.whiteUserList = cfgOpts.whiteUserList;
          // 预解析手机号到缓存
          for (const item of cfgOpts.whiteUserList) {
            if (isMobile(item)) {
              await resolveUserId(this, item);
            }
          }
        }
        this.config.conversations.push(newConv);
        saveClientConfig(this);
        console.log(`[${timestamp()}] 注册新群: ${newConv.conversationTitle || conversationTitle}(${conversationId})`);
      }

      // 确保工作目录已创建
      const workDir = this.getConversationDir(conversationId);
      if (!fs.existsSync(workDir)) {
        fs.mkdirSync(workDir, { recursive: true });
        console.log(`[${timestamp()}] 创建工作目录: ${workDir}`);
      }

      // 统一返回当前群配置信息
      const convToShow = existingConv || this.getConversationConfig(conversationId);
      const info: string[] = [
        existingConv ? `✅ 群配置已刷新` : `✅ 群已注册`,
        `- **群名称:** ${convToShow?.conversationTitle || conversationTitle || '-'}`,
        `- **群ID:** ${conversationId}`,
      ];
      if (convToShow?.dingToken) info.push(`- **dingToken:** ${convToShow.dingToken.substring(0, 8)}...`);
      else info.push('- **dingToken:** (未指定, 使用 defaultDingToken)');
      if (convToShow?.linkConversationId) info.push(`- **linkConversationId:** ${convToShow.linkConversationId}`);
      if (convToShow?.atSender === false) info.push('- **atSender:** false (不 @ 发送人)');
      if (convToShow?.receiveReply === false) info.push('- **receiveReply:** false (不回复确认消息)');
      if (convToShow?.whiteUserList?.length) {
        const display = convToShow.whiteUserList.map(item => {
          if (isMobile(item)) return item;
          return userIdToPhone(this, item) || item;
        }).join(', ');
        info.push(`- **whiteUserList:** ${display}`);
      }
      info.push('\n💡 可编辑 config.json 补充更多配置');
      info.push(`📂 工作目录: \`${workDir}\``);

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

    // /clean 命令：清除历史会话和缓存（仅 owner 可用）
    const cleanType = parseCleanCommand(prompt);
    if (cleanType !== null) {
      if (!(await this.requireOwner(conversationId, sessionWebhook, senderStaffId))) return;

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

    // /pwd 命令：显示当前工作目录
    if (parsePwdCommand(prompt)) {
      const conversationDir = this.getConversationDir(conversationId);
      await this.sendDingMessage({
        conversationId, sessionWebhook,
        content: `📂 当前工作目录:\n\`\`\`\n${conversationDir}\n\`\`\``,
        msgType: 'markdown',
      });
      return;
    }

    // /mkdir 命令：创建目录
    const mkdirPath = parseMkdirCommand(prompt);
    if (mkdirPath !== null) {
      await this.handleMkdirCommand(conversationId, sessionWebhook, mkdirPath);
      return;
    }

    // /touch 命令：创建文件
    const touchPath = parseTouchCommand(prompt);
    if (touchPath !== null) {
      await this.handleTouchCommand(conversationId, sessionWebhook, touchPath);
      return;
    }

    // /rm 命令：删除文件或目录
    const rmPath = parseRmCommand(prompt);
    if (rmPath !== null) {
      await this.handleRmCommand(conversationId, sessionWebhook, rmPath);
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
      const finalCmd = preBashParts.length > 0 ? `${preBashParts.join(' && ')} && ${bashCmd}` : bashCmd;
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
