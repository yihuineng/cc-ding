import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { exec as execCb } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'crypto';
import type { DingClaude } from './cc-ding-cli';

const exec = promisify(execCb);
import { IActiveSession, IClaudeSetting, ISession } from './types';
import { sendDingMessage, sendClaudeResponseToDing } from './messaging';
import { timestamp, getReplyWebhook, getReplyConversationId } from './session';
import {
  rotateApiKey,
  pickValidApiKey,
  ensureSettingsWithApiKey,
  isQuotaExhaustedError,
  isAuthenticationError,
  readApiKeyFromSettings,
  getForceEnabledSettingsPath,
  settingLabel,
} from './api-key-manager';
import { resolveSecret } from './secrets';
import { commandExists, formatClaudeCommandMissingMessage, isWindows, spawnCommand } from './platform';

const MAX_FAST_FAIL = 20;
const API_RETRY_DELAY_MS = 10_000;
const FAST_FAIL_THRESHOLD_MS = 10_000;
/** 最大总重试次数（含所有错误类型），超过此值视为无限重试循环 */
const MAX_TOTAL_RETRIES = 10;
/** 最大重试持续时间（ms），超过此值且重试 >=3 次视为无限重试循环 */
const MAX_RETRY_DURATION_MS = 5 * 60 * 1000;
/** Watchdog: 日志无更新超时时间（5 分钟） */
const WATCHDOG_TIMEOUT_MS = 5 * 60 * 1000;
/** Watchdog: 检查间隔 */
const WATCHDOG_CHECK_INTERVAL_MS = 30 * 1000;

/** CLAUDE.md 注入内容的内存缓存，key=conversationId，value=上次注入的完整内容字符串 */
const injectedContextCache = new Map<string, string>();

/**
 * 解析 Claude 的 settings 文件路径
 * 统一处理 forceEnable、apiKeyCfg 轮换等逻辑
 * 供 executeClaudeQuery 和 cron 分析等场景共用
 */
export function resolveClaudeSettingsPath(
  self: DingClaude,
  dingGroupDir: string,
  explicitSettings?: string,
): string | undefined {
  // FORCE_ENABLE 强制模式: 直接使用 settings-ding.json
  const forceSettingsPath = getForceEnabledSettingsPath(dingGroupDir);
  if (forceSettingsPath) {
    return forceSettingsPath;
  }

  // apiKeyCfg 管理的 API Key 轮换: 使用 settings-ding.json
  if (self.config.apiKeyCfg) {
    const savedApiKey = readApiKeyFromSettings(dingGroupDir);
    let currentSetting: IClaudeSetting | null = null;
    if (savedApiKey) {
      currentSetting = self.config.apiKeyCfg.claudeSettings.find(s => resolveSecret(s.apiKey) === savedApiKey && s.isValid) || null;
    }
    if (!currentSetting) {
      currentSetting = pickValidApiKey(self);
    }
    if (currentSetting) {
      return ensureSettingsWithApiKey(dingGroupDir, currentSetting);
    }
  }

  // 不传 settings
  if (self.config.apiKeyCfg) {
    return undefined;
  }

  // 无 apiKeyCfg: 优先使用传入的 settings，其次自动检测
  if (explicitSettings) return explicitSettings;
  const autoSettingsPath = path.join(dingGroupDir, '.claude', 'settings.json');
  if (fs.existsSync(autoSettingsPath)) {
    console.log(`[${timestamp()}] 自动检测到 settings.json: ${autoSettingsPath}`);
    return autoSettingsPath;
  }
  return undefined;
}

/**
 * 判断错误是否为可重试的 API 限流错误（422 TPM、429 临时限流等）
 * 注意：429 配额耗尽（Request rejected / 超过上限）由 isQuotaExhaustedError 单独处理，不可重试
 */
export function isRetryableApiError(output: string): boolean {
  // 匹配 429 临时限流（非配额耗尽，可重试）
  if (/\b429\b/.test(output) && !isQuotaExhaustedError(output)) return true;
  // 匹配 422 TPM 限流: "API Error: 422 {"error":{"type":"api_error","message":"...请求额度超限(TPM)"}...}"
  if (/API\s*Error.*422/i.test(output)) return true;
  if (/\b422\b.*(?:TPM|额度超限|rate\s*limit|tokens?\s*per\s*minute)/i.test(output)) return true;
  if (/(?:TPM|额度超限).*\b422\b/i.test(output)) return true;
  // 通用限流关键词（非 429）
  const lowerOutput = output.toLowerCase();
  const keywords = [
    'rate limit', 'rate_limit', 'ratelimit', 'too many requests',
    'tokens per minute', 'requests per minute', 'rpm limit',
    'overloaded', 'capacity', 'temporarily unavailable',
  ];
  return keywords.some(keyword => lowerOutput.includes(keyword));
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class RetryableApiError extends Error {
  /** 是否为快速失败（进程启动后 FAST_FAIL_THRESHOLD_MS 内报错） */
  readonly isFastFail: boolean;
  /** 错误输出，用于判断具体错误类型 */
  readonly output: string;
  constructor(isFastFail: boolean, output: string = '') {
    super(`Retryable API error (TPM limit etc.)${isFastFail ? ' [fast fail]' : ''}`);
    this.name = 'RetryableApiError';
    this.isFastFail = isFastFail;
    this.output = output;
  }
}

/** Claude 会话已失效（会话被清理或过期），需清除 claudeSessionId 重新发起 */
class ConversationNotFoundError extends Error {
  constructor() {
    super('Claude conversation not found');
    this.name = 'ConversationNotFoundError';
  }
}

/** 上下文窗口超长错误：需要发送 /compact 压缩上下文后继续 */
class ContextWindowExceededError extends Error {
  constructor() {
    super('Context window exceeded: prompt tokens exceed maximum context window');
    this.name = 'ContextWindowExceededError';
  }
}

function readLastLogLines(logPath: string, n: number): string {
  try {
    const content = fs.readFileSync(logPath, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    return lines.slice(-n).join('\n');
  } catch {
    return '';
  }
}

function isContextWindowExceededError(output: string): boolean {
  return /prompt tokens?\s*\(\s*\d+\s*\)\s*exceeds/i.test(output) ||
    /exceeds?.*maximum context window/i.test(output);
}

/**
 * 判断错误是否为需要授权
 */
function isPermissionError(stderrOutput: string): boolean {
  const lowerOutput = stderrOutput.toLowerCase();
  const permissionKeywords = [
    'permission denied', 'permission_required', 'needs permission',
    'requires permission', 'authorization required', 'authorize',
    'not authorized', 'access denied', '需要授权', '权限不足', '没有权限',
  ];
  return permissionKeywords.some(keyword => lowerOutput.includes(keyword));
}

/**
 * 判断错误是否为会话已失效（Claude 侧会话被清理或过期）
 */
function isConversationNotFoundError(stderrOutput: string): boolean {
  return /no conversation found with session id/i.test(stderrOutput);
}

/**
 * 解析 Claude stream-json 输出
 */
export function parseClaudeStreamLine(
  line: string,
  includeThinking: boolean = false,
): { type: string; sessionId?: string; content?: string } | null {
  if (!line.trim()) return null;

  try {
    const parsed = JSON.parse(line);

    if (parsed.type === 'system' && parsed.subtype === 'init' && parsed.session_id) {
      return { type: 'system', sessionId: parsed.session_id };
    }

    if (parsed.type === 'assistant') {
      const contentArray = parsed.message?.content;
      if (Array.isArray(contentArray)) {
        const parts: string[] = [];
        for (const block of contentArray) {
          if (block.type === 'text' && block.text) {
            parts.push(block.text);
          } else if (block.type === 'thinking' && block.thinking && includeThinking) {
            parts.push(`💭 **思考过程**\n\`\`\`\n${block.thinking}\n\`\`\``);
          }
        }
        if (parts.length > 0) {
          return { type: 'assistant', content: parts.join('\n') };
        }
      } else if (parsed.content) {
        return {
          type: 'assistant',
          content: typeof parsed.content === 'string' ? parsed.content : JSON.stringify(parsed.content),
        };
      }
      return { type: 'assistant' };
    }

    if (parsed.type === 'result') {
      const content = parsed.result || '';
      return { type: 'result', content: typeof content === 'string' ? content : JSON.stringify(content) };
    }

    return { type: parsed.type || 'unknown' };
  } catch {
    return { type: 'text', content: line };
  }
}

/**
 * 中断正在执行的 Claude 进程
 */
export function interruptClaudeProcess(activeSession: IActiveSession, logReason: string): boolean {
  if (!activeSession.currentProcess) {
    return false;
  }
  console.log(`[${timestamp()}] ${logReason}`);
  activeSession.interrupted = true;
  // Windows 不支持 SIGINT，使用默认 kill（TerminateProcess）
  if (isWindows()) {
    activeSession.currentProcess.kill();
  } else {
    activeSession.currentProcess.kill('SIGINT');
  }
  return true;
}

/**
 * 执行单次 Claude 进程，spawn + stdin写入 + 收集结果
 * 成功返回 exitCode(0)，可重试 API 错误抛出 RetryableApiError，其他错误抛出 Error
 * RetryableApiError.isFastFail 标识是否为快速失败（启动后 FAST_FAIL_THRESHOLD_MS 内报错）
 */
function runClaudeOnce(
  self: DingClaude,
  session: ISession,
  cmdArgs: string[],
  entryCmd: string,
  dingGroupDir: string,
  stdinMessage: string,
  isRetry: boolean,
): Promise<number> {
  let sessionDir = self.getSessionDir(session);
  let sessionLog = `${sessionDir}/session.log`;

  // 确保 session 目录存在（可能被 /clean 清理了）
  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
  }

  const startTime = Date.now();

  return new Promise((resolve, reject) => {
    const child = spawnCommand(entryCmd, cmdArgs, {
      cwd: dingGroupDir,
      stdio: [ 'pipe', 'pipe', 'pipe' ],
    });

    const activeSession = self.activeSessions.get(session.conversationId);
    if (activeSession) {
      activeSession.currentProcess = child;
      activeSession.lastActivityTime = Date.now();
    }

    fs.appendFileSync(sessionLog, `[${timestamp()}] [SYSTEM]: Claude 查询启动${isRetry ? ' (重试)' : ''}\n`, 'utf-8');

    // 写入消息并关闭 stdin
    child.stdin?.write(`${stdinMessage}\n`);
    child.stdin?.end();

    let sessionIdCaptured = !isRetry && !!session.claudeSessionId;
    let responseBuffer: string[] = [];
    let stderrOutput = '';
    let stdoutOutput = ''; // 累积 stdout 原始输出，用于错误检测
    let hasSentResponse = false;
    let settled = false;
    let watchdogTimer: ReturnType<typeof setInterval> | null = null;
    const loggedToolUseIds = new Set<string>();

    const updateActivity = () => {
      if (activeSession) {
        activeSession.lastActivityTime = Date.now();
      }
    };

    // Watchdog: 定期检查是否长时间无活动
    watchdogTimer = setInterval(() => {
      if (settled) {
        if (watchdogTimer) clearInterval(watchdogTimer);
        return;
      }
      const lastActivity = activeSession?.lastActivityTime ?? startTime;
      const elapsed = Date.now() - lastActivity;
      if (elapsed >= WATCHDOG_TIMEOUT_MS) {
        console.warn(`[${timestamp()}] Watchdog: Claude 进程 ${WATCHDOG_TIMEOUT_MS / 1000}s 无活动，通知用户`);
        try { fs.appendFileSync(sessionLog, `[${timestamp()}] [SYSTEM]: Watchdog 超时，${WATCHDOG_TIMEOUT_MS / 1000}s 无活动，已通知用户\n`, 'utf-8'); } catch { /* ignore */ }
        if (watchdogTimer) clearInterval(watchdogTimer);
        watchdogTimer = null;
        const atUserId = activeSession?.lastSenderStaffId || session.startStaffId;
        sendDingMessage(self, {
          conversationId: getReplyConversationId(session),
          sessionWebhook: getReplyWebhook(session),
          atUserId,
          content: `⏰ Claude 进程超过 ${WATCHDOG_TIMEOUT_MS / 1000}s 无响应，可发送 /goon 强制重启恢复，或 /end 结束会话`,
        }).catch(err => console.error('发送 Watchdog 通知失败:', err));
      }
    }, WATCHDOG_CHECK_INTERVAL_MS);

    const rl = readline.createInterface({ input: child.stdout! });
    rl.on('line', (line) => {
      stdoutOutput += line + '\n';
      updateActivity();
      self.debugLog(`Claude stdout: ${line.substring(0, 200)}${line.length > 200 ? '...' : ''}`);
      if (self.config.debug) {
        try { fs.appendFileSync(sessionLog, `[${timestamp()}] [RAW]: ${line}\n`, 'utf-8'); } catch { /* ignore */ }
      }

      const parsed = parseClaudeStreamLine(line, self.config.includeThinking ?? false);

      if (parsed) {
        if (parsed.type === 'system' && parsed.sessionId && !sessionIdCaptured) {
          self.updateSessionFile(session, { claudeSessionId: parsed.sessionId });
          sessionIdCaptured = true;
          // updateSessionFile 可能重命名了 session 目录（从 startTimeStr 改为 claudeSessionId），
          // 需要重新计算路径，否则后续 appendFileSync 会因旧路径不存在而抛出 ENOENT
          sessionDir = self.getSessionDir(session);
          sessionLog = `${sessionDir}/session.log`;
        }

        if (parsed.type === 'assistant') {
          try {
            const rawParsed = JSON.parse(line);
            const contentArray = rawParsed?.message?.content;
            if (Array.isArray(contentArray)) {
              for (const block of contentArray) {
                if (block.type === 'tool_use' && block.id && !loggedToolUseIds.has(block.id)) {
                  loggedToolUseIds.add(block.id);
                  const toolName = block.name || 'unknown';
                  let toolDetail = '';
                  if (block.input) {
                    if (block.input.command) toolDetail = block.input.command.substring(0, 200);
                    else if (block.input.file_path) toolDetail = block.input.file_path;
                    else if (block.input.pattern) toolDetail = block.input.pattern;
                    else if (block.input.query) toolDetail = block.input.query;
                    else if (block.input.description) toolDetail = block.input.description;
                    else if (block.input.prompt) toolDetail = block.input.prompt.substring(0, 200);
                    else toolDetail = JSON.stringify(block.input).substring(0, 200);
                  }
                  self.appendSessionLog(sessionDir, 'tool', `${toolName}${toolDetail ? ': ' + toolDetail : ''}`);
                }
              }
            }
          } catch {
            // 忽略 JSON 解析错误
          }

          if (parsed.content) {
            responseBuffer.push(parsed.content);
          }
        }

        if (parsed.type === 'result') {
          const resultOnly = self.config.resultOnly ?? true;
          const resultContent = (parsed.content || '').trim();
          const bufferContent = responseBuffer.join('\n').trim();
          // resultOnly 时优先用 result 内容，为空则回退到 responseBuffer
          const fullResponse = resultOnly
            ? (resultContent || bufferContent)
            : bufferContent;

          if (fullResponse && !activeSession?.interrupted) {
            try { self.appendSessionLog(sessionDir, 'assistant', fullResponse); } catch { /* 日志写入失败不阻断消息发送 */ }
            const activeSessionRef = self.activeSessions.get(session.conversationId);
            const atUserId = activeSessionRef?.lastSenderStaffId || session.startStaffId;
            hasSentResponse = true;
            sendClaudeResponseToDing(self, getReplyConversationId(session), getReplyWebhook(session), atUserId, fullResponse)
              .catch(err => console.error('发送钉钉消息失败:', err));
          } else {
            console.warn(`[${timestamp()}] Claude 返回了空的 result 且 responseBuffer 也为空，无内容可发送`);
          }
          responseBuffer = [];
        }
      }
    });

    child.stderr?.on('data', (data) => {
      const str = data.toString();
      stderrOutput += str;
      updateActivity();
      if (isQuotaExhaustedError(str)) {
        console.log(`[${timestamp()}] [Claude stderr] 配额耗尽错误(429): ${str.trim()}`);
        try { fs.appendFileSync(sessionLog, `[${timestamp()}] [WARN]: ${str}`, 'utf-8'); } catch { /* ignore */ }
      } else if (isRetryableApiError(str)) {
        console.log(`[${timestamp()}] [Claude stderr] 可重试API错误(422 TPM限流): ${str.trim()}`);
        try { fs.appendFileSync(sessionLog, `[${timestamp()}] [WARN]: ${str}`, 'utf-8'); } catch { /* ignore */ }
      } else {
        console.error(`[Claude stderr]: ${str}`);
        try { fs.appendFileSync(sessionLog, `[${timestamp()}] [ERROR]: ${str}`, 'utf-8'); } catch { /* ignore */ }
      }
    });

    child.on('close', (code) => {
      settled = true;
      if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
      console.log(`[${timestamp()}] Claude 进程退出，代码: ${code}`);
      try { fs.appendFileSync(sessionLog, `[${timestamp()}] [SYSTEM]: Claude 查询结束，退出码: ${code}\n`, 'utf-8'); } catch { /* ignore */ }

      const activeSessionRef = self.activeSessions.get(session.conversationId);
      if (activeSessionRef) {
        activeSessionRef.currentProcess = undefined;
      }

      // 被中断时（/end、/new 等），丢弃未发送的 responseBuffer，不再发送残余消息
      if (activeSessionRef?.interrupted) {
        console.log(`[${timestamp()}] 用户主动中断，丢弃 responseBuffer (${responseBuffer.length} 段)`);
        activeSessionRef.interrupted = false;
        responseBuffer = [];
        resolve(0);
        return;
      }

      if (responseBuffer.length > 0) {
        const fullResponse = responseBuffer.join('\n').trim();
        if (fullResponse) {
          try { self.appendSessionLog(sessionDir, 'assistant', fullResponse); } catch { /* 日志写入失败不阻断消息发送 */ }
          const atUserId = activeSessionRef?.lastSenderStaffId || session.startStaffId;
          hasSentResponse = true;
          sendClaudeResponseToDing(self, getReplyConversationId(session), getReplyWebhook(session), atUserId, fullResponse)
            .catch(err => console.error('发送钉钉消息失败:', err));
        }
      }

      // 进程正常退出但从未发送过任何回复，通知用户
      if (code === 0 && !hasSentResponse && !activeSessionRef?.interrupted) {
        console.warn(`[${timestamp()}] Claude 进程正常退出但未产生任何回复内容`);
        try { fs.appendFileSync(sessionLog, `[${timestamp()}] [WARN]: Claude 进程正常退出但未产生任何回复内容\n`, 'utf-8'); } catch { /* ignore */ }
        const atUserId = activeSessionRef?.lastSenderStaffId || session.startStaffId;
        sendDingMessage(self, {
          conversationId: getReplyConversationId(session),
          sessionWebhook: getReplyWebhook(session),
          atUserId,
          content: '⚠️ Claude 处理完成但未返回任何内容',
        }).catch(err => console.error('发送钉钉消息失败:', err));
      }

      if (code === 0) {
        resolve(0);
        return;
      }

      // 合并 stdout + stderr 用于错误检测（claude 可能将错误输出到 stdout）
      const combinedOutput = stderrOutput + '\n' + stdoutOutput;

      if (isQuotaExhaustedError(combinedOutput)) {
        // 429 配额耗尽：不可重试，抛出特殊标记让外层处理 key 轮换
        const elapsed = Date.now() - startTime;
        const isFastFail = elapsed < FAST_FAIL_THRESHOLD_MS;
        console.log(`[${timestamp()}] 检测到配额耗尽错误(429)，stdout匹配=${isQuotaExhaustedError(stdoutOutput)}, stderr匹配=${isQuotaExhaustedError(stderrOutput)}`);
        reject(new RetryableApiError(isFastFail, combinedOutput));
        return;
      }

      if (isAuthenticationError(combinedOutput)) {
        // 401 认证错误：不可重试，直接通知用户
        console.log(`[${timestamp()}] 检测到认证错误(401)，通知用户`);
        const atUserId = activeSessionRef?.lastSenderStaffId || session.startStaffId;
        sendDingMessage(self, {
          conversationId: getReplyConversationId(session),
          sessionWebhook: getReplyWebhook(session),
          atUserId,
          content: '⚠️ 认证失败(401)，API Key 无效或服务未授权，请检查配置',
        }).catch(err => console.error('发送钉钉消息失败:', err));
        resolve(code ?? 1);
        return;
      }

      if (isRetryableApiError(combinedOutput)) {
        // 422 TPM 限流：可重试
        const elapsed = Date.now() - startTime;
        const isFastFail = elapsed < FAST_FAIL_THRESHOLD_MS;
        reject(new RetryableApiError(isFastFail, combinedOutput));
        return;
      }

      if (isPermissionError(combinedOutput)) {
        console.log(`[${timestamp()}] 检测到需要授权，通知用户`);
        const atUserId = activeSessionRef?.lastSenderStaffId || session.startStaffId;
        sendDingMessage(self, {
          conversationId: getReplyConversationId(session),
          sessionWebhook: getReplyWebhook(session),
          atUserId,
          content: '⚠️ Claude 需要授权，请人工介入',
        }).catch(err => console.error('发送钉钉消息失败:', err));
        resolve(code ?? 1);
        return;
      }

      // Claude 会话已失效（被清理或过期），抛出特殊错误让外层清除 claudeSessionId 后重试
      if (session.claudeSessionId && isConversationNotFoundError(combinedOutput)) {
        console.log(`[${timestamp()}] Claude 会话已失效: ${session.claudeSessionId}，通知外层重新发起新会话`);
        reject(new ConversationNotFoundError());
        return;
      }

      // 上下文窗口超长（400 错误），抛出特殊错误让外层自动 /compact
      if (isContextWindowExceededError(combinedOutput)) {
        console.log(`[${timestamp()}] 检测到上下文窗口超长错误(400)，将自动发送 /compact 压缩上下文`);
        try { fs.appendFileSync(sessionLog, `[${timestamp()}] [SYSTEM]: 上下文窗口超长，将自动 /compact\n`, 'utf-8'); } catch { /* ignore */ }
        reject(new ContextWindowExceededError());
        return;
      }

      reject(new Error(`Claude 进程退出，代码: ${code}`));
    });

    child.on('error', (err) => {
      settled = true;
      if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
      console.error('Claude 进程错误:', err);
      fs.appendFileSync(sessionLog, `[${timestamp()}] [ERROR]: 进程错误: ${err.message}\n`, 'utf-8');
      reject(err);
    });
  });
}

const START_MARK = '<!-- cc-ding:session-context-start (DO NOT EDIT) -->';
const END_MARK = '<!-- cc-ding:session-context-end (DO NOT EDIT) -->';

/**
 * 构建 cc-ding 上下文内容字符串。
 * 将 client 和 conversation 配置信息格式化为 CLAUDE.md 中可注入的段落。
 */
function buildContextContent(self: DingClaude, conversationId: string): string {
  const convCfg = self.getConversationConfig(conversationId);
  const config = self.config;

  const lines: string[] = [
    START_MARK,
    '# cc-ding Session Context',
    '## Client',
    `- clientId: \`${self.clientId}\``,
    config.clientName ? `- clientName: ${config.clientName}` : '',
    `- owner: ${config.owner}`,
    '## Conversation',
    `- conversationId: \`${conversationId}\``,
    convCfg?.conversationType ? `- conversationType: ${convCfg.conversationType === '1' ? '单聊' : '群聊'}` : '',
    convCfg?.conversationTitle ? `- conversationTitle: ${convCfg.conversationTitle}` : '',
    convCfg?.linkConversationId ? `- linkConversationId: \`${convCfg.linkConversationId}\` (关联群，共享工作目录)` : '',
    '## Settings',
    convCfg?.permissionMode ? `- permissionMode: ${convCfg.permissionMode}` : '',
    convCfg?.agent ? `- agent: ${convCfg.agent}` : '',
    convCfg?.taskCfg?.skill ? `- taskCfg.skill: ${convCfg.taskCfg.skill}` : '',
    config.resultOnly !== undefined ? `- resultOnly: ${config.resultOnly}` : '',
    config.includeThinking !== undefined ? `- includeThinking: ${config.includeThinking}` : '',
    config.preBash ? `- preBash(全局): \`${config.preBash}\`` : '',
    convCfg?.preBash ? `- preBash(群): \`${convCfg.preBash}\`` : '',
    convCfg?.qaMode ? '- qaMode: true (问答模式，仅回答问题，禁止执行命令、写入文件或运行代码)' : '',
    convCfg?.qaMode && convCfg.qaCfg?.docs?.length ? `- qaDocs: ${convCfg.qaCfg.docs.join(', ')}` : '',
    '## DingTalk Context',
    '当 prompt 中包含 "消息来自: xxx(用户ID)" 时，说明消息来自钉钉用户。',
    '- 回答时要考虑用户的使用场景（钉钉聊天界面，非终端环境）',
    '- 用户一般情况下只能通过 cc-ding 进行操作',
    '- cc-ding 文档: https://github.com/yihuineng/cc-ding',
    END_MARK,
  ].filter(Boolean);

  return lines.join('\n') + '\n';
}

/**
 * 将 cc-ding 上下文写入/更新到指定群的 .claude/CLAUDE.md 文件。
 * 不比对缓存，直接写入（用于启动时首次注入）。
 */
function writeContextToFile(self: DingClaude, conversationId: string, newSection: string): void {
  const dingGroupDir = self.getConversationDir(conversationId);
  const claudeDir = path.join(dingGroupDir, '.claude');
  if (!fs.existsSync(claudeDir)) fs.mkdirSync(claudeDir, { recursive: true });

  const claudeMdPath = path.join(claudeDir, 'CLAUDE.md');

  if (!fs.existsSync(claudeMdPath)) {
    fs.writeFileSync(claudeMdPath, newSection, 'utf-8');
    console.log(`[${timestamp()}] cc-ding 上下文已注入 CLAUDE.md: ${claudeMdPath}`);
    return;
  }

  const existing = fs.readFileSync(claudeMdPath, 'utf-8');
  const startIdx = existing.indexOf(START_MARK);
  const endIdx = existing.indexOf(END_MARK);

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const before = existing.substring(0, startIdx);
    const after = existing.substring(endIdx + END_MARK.length);
    const updated = before + newSection + after;
    fs.writeFileSync(claudeMdPath, updated, 'utf-8');
    console.log(`[${timestamp()}] cc-ding 上下文已更新: ${claudeMdPath}`);
  } else {
    fs.writeFileSync(claudeMdPath, newSection + '\n' + existing, 'utf-8');
    console.log(`[${timestamp()}] cc-ding 上下文已追加到现有 CLAUDE.md: ${claudeMdPath}`);
  }
}

/**
 * 启动时注入：为所有已注册的群写入 CLAUDE.md 上下文。
 * 应用启动时调用一次，确保工作目录中已有上下文信息。
 */
export function injectStartupContexts(self: DingClaude): void {
  const conversations = Array.isArray(self.config.conversations) ? self.config.conversations : [];
  for (const conv of conversations) {
    const newSection = buildContextContent(self, conv.conversationId);
    injectedContextCache.set(conv.conversationId, newSection);
    writeContextToFile(self, conv.conversationId, newSection);
  }
}

/**
 * 检查配置是否变更，仅在变更时写入 CLAUDE.md。
 * 避免每次消息都执行文件 I/O，提升性能。
 *
 * 策略：
 * - 首次消息：对比内存缓存，未缓存则写入
 * - 后续消息：仅当当前配置与上次注入的内容不同时才写入
 * - 不产生重复信息，配置变更时自动刷新
 */
export function injectSessionContextIfChanged(self: DingClaude, session: ISession): void {
  const conversationId = session.conversationId;
  const newSection = buildContextContent(self, conversationId);
  const cached = injectedContextCache.get(conversationId);

  if (cached === newSection) {
    // 内容未变更，跳过文件写入
    return;
  }

  // 内容变更或首次（此群），写入文件并更新缓存
  injectedContextCache.set(conversationId, newSection);
  writeContextToFile(self, conversationId, newSection);
}

/**
 * 强制刷新指定会话的上下文注入（用于 qaMode 切换等场景）
 */
export function refreshSessionContext(self: DingClaude, conversationId: string): void {
  injectedContextCache.delete(conversationId);
  const newSection = buildContextContent(self, conversationId);
  const dingGroupDir = self.getConversationDir(conversationId);
  const claudeDir = path.join(dingGroupDir, '.claude');
  if (!fs.existsSync(claudeDir)) fs.mkdirSync(claudeDir, { recursive: true });
  const claudeMdPath = path.join(claudeDir, 'CLAUDE.md');
  fs.writeFileSync(claudeMdPath, newSection, 'utf-8');
  console.log(`[${timestamp()}] QA 模式切换，CLAUDE.md 已刷新: ${claudeMdPath}`);
}

/**
 * 执行 Claude 查询（session 模式），支持 TPM 额度超限自动重试和 API Key 配额管理
 */
export async function executeClaudeQuery(
  self: DingClaude,
  session: ISession,
  message: string,
  opts?: { skill?: string; agent?: string; settings?: string; senderNick?: string; senderStaffId?: string; permissionMode?: string; newSessionId?: string; conversationConfig?: { qaMode?: boolean; qaCfg?: { gitRepos?: string[]; docs?: string[]; autoPull?: boolean } } },
): Promise<void> {
  const { skill, agent, senderNick, senderStaffId, newSessionId, conversationConfig } = opts || {};
  let sessionDir = self.getSessionDir(session);
  let sessionLog = `${sessionDir}/session.log`;
  const dingGroupDir = self.getConversationDir(session.conversationId);

  // 会话开始时，检查配置是否变更并注入 Claude 上下文（仅在变更时写入）
  injectSessionContextIfChanged(self, session);

  fs.mkdirSync(sessionDir, { recursive: true });
  // 从 settings-ding.json 恢复上次使用的 Claude Setting
  let currentSetting: IClaudeSetting | null = null;
  const savedApiKey = readApiKeyFromSettings(dingGroupDir);
  if (savedApiKey && self.config.apiKeyCfg) {
    currentSetting = self.config.apiKeyCfg.claudeSettings.find(s => resolveSecret(s.apiKey) === savedApiKey && s.isValid) || null;
    if (currentSetting) {
      console.log(`[${timestamp()}] 从 settings-ding.json 恢复 Claude Setting: ${settingLabel(currentSetting)}`);
    }
  }
  const forceSettingsPath = getForceEnabledSettingsPath(dingGroupDir);
  if (!forceSettingsPath && self.config.apiKeyCfg) {
    // 使用 API Key 模式
    currentSetting = pickValidApiKey(self);
    if (!currentSetting) {
      // 无可用配额
      const atUserId = senderStaffId || session.startStaffId;
      await sendDingMessage(self, {
        conversationId: getReplyConversationId(session),
        sessionWebhook: getReplyWebhook(session),
        atUserId,
        content: '⚠️ 当前无可用配额（无可用 API Key），请明天再试或联系管理员',
      });
      return;
    }
  }

  const messageWithPrefix = senderNick && senderStaffId
    ? `${message} ── 消息来自: ${senderNick}(${senderStaffId})`
    : message;

  self.appendSessionLog(sessionDir, 'user', messageWithPrefix);

  const entryCmd = 'claude';
  if (!commandExists(entryCmd)) {
    const message = formatClaudeCommandMissingMessage(entryCmd);
    console.error(`[${timestamp()}] ${message.replace(/\n/g, ' ')}`);
    fs.appendFileSync(sessionLog, `[${timestamp()}] [ERROR]: ${message}\n`, 'utf-8');
    await sendDingMessage(self, {
      conversationId: getReplyConversationId(session),
      sessionWebhook: getReplyWebhook(session),
      atUserId: senderStaffId || session.startStaffId,
      content: `❌ ${message}`,
    });
    return;
  }

  // ---- QA 模式处理 ----
  let actualMessage = skill ? `/${skill} ${messageWithPrefix}` : messageWithPrefix;

  if (conversationConfig?.qaMode) {
    // 强制使用 plan 模式（只读，禁止写入和执行命令）
    opts.permissionMode = 'plan';

    // 自动拉取最新代码
    if (conversationConfig.qaCfg?.autoPull && conversationConfig.qaCfg.gitRepos?.length) {
      try {
        for (const repoUrl of conversationConfig.qaCfg.gitRepos) {
          // 从 URL 中提取仓库名(如 https://github.com/user/repo.git -> repo)
          const base = repoUrl.replace(/\/$/, '').replace(/\.git$/, '');
          const repoName = base.split('/').pop() || repoUrl;
          const repoDir = path.join(dingGroupDir, repoName);
          if (fs.existsSync(path.join(repoDir, '.git'))) {
            await exec('git pull', { cwd: repoDir, timeout: 60_000 });
            console.log(`[${timestamp()}] QA 模式 git pull: ${repoName}`);
          } else {
            await exec(`git clone ${repoUrl}`, { cwd: dingGroupDir, timeout: 120_000 });
            console.log(`[${timestamp()}] QA 模式 git clone: ${repoUrl} -> ${repoName}`);
          }
        }
      } catch (err) {
        console.error(`[${timestamp()}] QA 模式 git 操作失败:`, err);
      }
    }

    // 注入 QA 模式规则 + 文档链接
    const qaRules = '【重要规则】当前为问答模式，请严格遵守：\n1. 仅回答问题，不要执行任何命令\n2. 不要修改或写入任何文件\n3. 不要尝试运行代码、脚本或工具\n4. 不要进行 git push、commit 等写操作';
    const docLinks = conversationConfig.qaCfg?.docs?.length
      ? `\n\n【参考资料链接】\n${conversationConfig.qaCfg.docs.map((d, i) => `${i + 1}. ${d}`).join('\n')}\n你可以使用 WebFetch 工具访问上述链接获取详细内容`
      : '';

    actualMessage = `${qaRules}${docLinks}\n\n---\n\n用户问题：\n${actualMessage}`;
  }

  // 默认 bypassPermissions（cc-ding 通过钉钉交互，无终端审批能力）；如需更严格权限可在配置中显式设置 acceptEdits
  const permissionMode = opts?.permissionMode ?? 'bypassPermissions';
  const fixedCmdArgs = [
    '--permission-mode', permissionMode,
    '--print',
    '--output-format', 'stream-json',
    '--verbose',
  ];
  if (agent) {
    fixedCmdArgs.push('--agent', agent);
  }

  let consecutiveFastFail = 0;
  let totalRetries = 0;
  let retryStartTime = 0;
  const retryHistory: string[] = [];
  const originalActiveSession = self.activeSessions.get(session.conversationId);

  /** 检查会话是否仍在活跃状态（未被 /end 终止或 /goon 请求重启） */
  const isSessionStillActive = (reason: string): boolean => {
    const current = self.activeSessions.get(session.conversationId);
    if (!current || current !== originalActiveSession) {
      console.log(`[${timestamp()}] 会话已被终止，${reason}`);
      return false;
    }
    if (current.goonPending) {
      console.log(`[${timestamp()}] 收到 /goon 请求，${reason}`);
      return false;
    }
    return true;
  };

  while (true) {
    if (!isSessionStillActive('停止重试')) return;

    const isRetry = consecutiveFastFail > 0;

    // 无限重试循环检测
    if (totalRetries >= MAX_TOTAL_RETRIES || (totalRetries >= 3 && retryStartTime > 0 && Date.now() - retryStartTime > MAX_RETRY_DURATION_MS)) {
      const reason = totalRetries >= MAX_TOTAL_RETRIES
        ? `总重试次数已达 ${MAX_TOTAL_RETRIES} 次`
        : `重试持续时间超过 ${MAX_RETRY_DURATION_MS / 1000}s（已重试 ${totalRetries} 次）`;
      console.error(`[${timestamp()}] 检测到无限重试循环: ${reason}`);
      fs.appendFileSync(sessionLog, `[${timestamp()}] [SYSTEM]: 检测到无限重试循环，${reason}，终止重试\n`, 'utf-8');

      const recentLogs = readLastLogLines(sessionLog, 1);
      const errorSummary = retryHistory.slice(-1)[0] || '';
      const atUserId = senderStaffId || session.startStaffId;
      await sendDingMessage(self, {
        conversationId: getReplyConversationId(session),
        sessionWebhook: getReplyWebhook(session),
        atUserId,
        content: `🔄 检测到 Claude 陷入无限重试，已终止（${reason}）\n\n📋 最近重试记录：\n${errorSummary}\n\n📝 最近日志：\n\`\`\`\n${recentLogs}\n\`\`\`\n\n💡 可尝试发送 /new 开始新会话，或 /end 结束当前会话`,
      });
      return;
    }

    // 每次循环动态构建命令参数（settings 和 resume 可能在重试时变化）
    const cmdArgs = [ ...fixedCmdArgs ];
    if (session.claudeSessionId) {
      cmdArgs.push('--resume', session.claudeSessionId);
      if (!isRetry) {
        console.log(`[${timestamp()}] 恢复 Claude 会话: ${session.claudeSessionId}`);
      }
    } else if (!isRetry) {
      // 首轮新会话：显式指定 session-id，确保 session 从开始就被持久化到磁盘，
      // 这样后续 --resume 一定能找到该会话。不预先设置 claudeSessionId，
      // 因为 Claude 可能在内部使用不同的 UUID；改为依赖 stream 中返回的真实 session_id。
      const explicitSessionId = newSessionId || randomUUID();
      cmdArgs.push('--session-id', explicitSessionId);
      console.log(`[${timestamp()}] 创建 Claude 会话(显式 session-id): ${explicitSessionId}`);
    }
    const settingsPath = resolveClaudeSettingsPath(self, dingGroupDir, opts?.settings);
    if (settingsPath) {
      cmdArgs.push('--settings', settingsPath);
    }

    let stdinMessage: string;

    if (isRetry) {
      stdinMessage = '继续';
      console.log(`[${timestamp()}] 发送"继续"重试 (快速失败连续${consecutiveFastFail}/${MAX_FAST_FAIL}次)`);
      fs.appendFileSync(sessionLog, `[${timestamp()}] [SYSTEM]: TPM 限流，发送"继续"重试 (快速失败连续${consecutiveFastFail}/${MAX_FAST_FAIL})\n`, 'utf-8');
    } else {
      stdinMessage = actualMessage;
    }

    console.log(`[${timestamp()}] 执行 Claude 查询[原生claude 模式]: ${entryCmd} ${cmdArgs.join(' ')}`);
    self.debugLog(`发送消息: ${stdinMessage.substring(0, 100)}...`);

    try {
      await runClaudeOnce(self, session, cmdArgs, entryCmd, dingGroupDir, stdinMessage, isRetry);
      return; // 成功，退出
    } catch (err) {
      // runClaudeOnce 可能因获取 claudeSessionId 而重命名了目录，需要重新计算路径
      sessionDir = self.getSessionDir(session);
      sessionLog = `${sessionDir}/session.log`;

      if (err instanceof RetryableApiError) {
        totalRetries++; retryStartTime = retryStartTime || Date.now();
        // 配额耗尽 (429): 尝试切换/轮换 Key
        if (isQuotaExhaustedError(err.output) && self.config.apiKeyCfg) {
          retryHistory.push(`[${timestamp()}] 429 配额耗尽，尝试轮换 Key`);
          if (currentSetting) {
            // API Key 配额耗尽/不稳定 → 轮换 Key
            const newSetting = rotateApiKey(self, currentSetting.apiKey);
            if (newSetting) {
              currentSetting = newSetting;
              consecutiveFastFail = 0;
              console.log(`[${timestamp()}] API Key 配额耗尽(429)，切换到新 Key: ${settingLabel(newSetting)}`);
              fs.appendFileSync(sessionLog, `[${timestamp()}] [SYSTEM]: API Key 配额耗尽(429)，切换到新 Key\n`, 'utf-8');
              continue;
            }
          }
          // 无可用配额
          const atUserId = senderStaffId || session.startStaffId;
          await sendDingMessage(self, {
            conversationId: getReplyConversationId(session),
            sessionWebhook: getReplyWebhook(session),
            atUserId,
            content: '⚠️ 当前无可用配额/API Key，请明天再试或联系管理员',
          });
          return;
        }
        if (err.isFastFail) {
          // 422 TPM 限流快速失败：累计计数，超过阈值则轮换 Key 或放弃
          consecutiveFastFail++;
          if (consecutiveFastFail >= MAX_FAST_FAIL) {
            if (currentSetting && self.config.apiKeyCfg) {
              const newSetting = rotateApiKey(self, currentSetting.apiKey);
              if (newSetting) {
                currentSetting = newSetting;
                consecutiveFastFail = 0;
                console.log(`[${timestamp()}] TPM 限流连续快速失败 ${MAX_FAST_FAIL} 次，切换到新 Key: ${settingLabel(newSetting)}`);
                fs.appendFileSync(sessionLog, `[${timestamp()}] [SYSTEM]: TPM 限流连续快速失败，切换到新 Key\n`, 'utf-8');
                continue;
              }
              // 无可用key
            }
            console.log(`[${timestamp()}] TPM 限流快速失败连续${MAX_FAST_FAIL}次，放弃`);
            fs.appendFileSync(sessionLog, `[${timestamp()}] [SYSTEM]: TPM 限流快速失败连续${MAX_FAST_FAIL}次，放弃\n`, 'utf-8');
            throw new Error(`TPM 限流，快速失败连续 ${MAX_FAST_FAIL} 次`);
          }
          console.log(`[${timestamp()}] 检测到 TPM 限流(快速失败)，${API_RETRY_DELAY_MS / 1000}s 后重试 (${consecutiveFastFail}/${MAX_FAST_FAIL})`);
        } else {
          // 超过阈值时间才报错，说明有进展，重置快速失败计数
          consecutiveFastFail = 0;
          console.log(`[${timestamp()}] 检测到 TPM 限流(进程已运行一段时间)，重置快速失败计数，${API_RETRY_DELAY_MS / 1000}s 后重试`);
        }
        fs.appendFileSync(sessionLog, `[${timestamp()}] [SYSTEM]: TPM 限流，${API_RETRY_DELAY_MS / 1000}s 后重试\n`, 'utf-8');
        retryHistory.push(`[${timestamp()}] TPM 限流，${API_RETRY_DELAY_MS / 1000}s 后重试`);
        await sleep(API_RETRY_DELAY_MS);
        if (!isSessionStillActive('停止当前重试')) return;
        continue;
      }
      if (err instanceof ConversationNotFoundError) {
        totalRetries++; retryStartTime = retryStartTime || Date.now();
        retryHistory.push(`[${timestamp()}] 会话失效，清除旧会话`);
        // Claude 会话已失效，清除 claudeSessionId 后重新发起新会话
        console.log(`[${timestamp()}] Claude 会话失效，清除 claudeSessionId 并重新发起`);
        fs.appendFileSync(sessionLog, `[${timestamp()}] [SYSTEM]: Claude 会话已失效，清除旧会话并重新发起\n`, 'utf-8');
        if (session.claudeSessionId) {
          session.claudeSessionId = undefined;
          self.updateSessionFile(session, {});
        }
        consecutiveFastFail = 0;
        continue;
      }
      // 上下文窗口超长：自动发送 /compact 压缩上下文后继续
      if (err instanceof ContextWindowExceededError) {
        totalRetries++; retryStartTime = retryStartTime || Date.now();
        retryHistory.push(`[${timestamp()}] 上下文窗口超长，自动 /compact`);
        console.log(`[${timestamp()}] 上下文窗口超长，自动发送 /compact 压缩上下文`);
        fs.appendFileSync(sessionLog, `[${timestamp()}] [SYSTEM]: 上下文窗口超长，自动发送 /compact 压缩上下文\n`, 'utf-8');
        const atUserId = senderStaffId || session.startStaffId;
        await sendDingMessage(self, {
          conversationId: getReplyConversationId(session),
          sessionWebhook: getReplyWebhook(session),
          atUserId,
          content: '📦 上下文超长，正在自动压缩上下文(/compact)后继续...',
        });
        const compactCmdArgs = [ ...fixedCmdArgs ];
        if (session.claudeSessionId) {
          compactCmdArgs.push('--resume', session.claudeSessionId);
        }
        const compactSettingsPath = resolveClaudeSettingsPath(self, dingGroupDir, opts?.settings);
        if (compactSettingsPath) {
          compactCmdArgs.push('--settings', compactSettingsPath);
        }
        try {
          await runClaudeOnce(self, session, compactCmdArgs, entryCmd, dingGroupDir, '/compact', false);
          console.log(`[${timestamp()}] /compact 执行成功，发送"继续"恢复执行`);
          fs.appendFileSync(sessionLog, `[${timestamp()}] [SYSTEM]: /compact 执行成功，发送"继续"恢复执行\n`, 'utf-8');
        } catch (compactErr) {
          console.error(`[${timestamp()}] /compact 执行失败:`, compactErr);
          fs.appendFileSync(sessionLog, `[${timestamp()}] [SYSTEM]: /compact 执行失败: ${compactErr instanceof Error ? compactErr.message : String(compactErr)}\n`, 'utf-8');
          await sendDingMessage(self, {
            conversationId: getReplyConversationId(session),
            sessionWebhook: getReplyWebhook(session),
            atUserId,
            content: '❌ 自动压缩上下文(/compact)失败，请手动发送 /compact 或 /new 开始新会话',
          });
          throw new Error(`上下文超长且 /compact 失败: ${compactErr instanceof Error ? compactErr.message : String(compactErr)}`);
        }
        consecutiveFastFail = 0;
        continue;
      }
      throw err;
    }
  }
}
