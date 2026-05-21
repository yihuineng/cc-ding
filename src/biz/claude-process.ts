import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { spawn } from 'child_process';
import { DingClaude } from '././cc-ding-cli';
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

const MAX_FAST_FAIL = 20;
const API_RETRY_DELAY_MS = 10_000;
const FAST_FAIL_THRESHOLD_MS = 10_000;

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
      currentSetting = self.config.apiKeyCfg.claudeSettings.find(s => s.apiKey === savedApiKey && s.isValid) || null;
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
  activeSession.currentProcess.kill('SIGINT');
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
  const startTime = Date.now();

  return new Promise((resolve, reject) => {
    const child = spawn(entryCmd, cmdArgs, {
      cwd: dingGroupDir,
      stdio: [ 'pipe', 'pipe', 'pipe' ],
    });

    const activeSession = self.activeSessions.get(session.conversationId);
    if (activeSession) {
      activeSession.currentProcess = child;
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
    const loggedToolUseIds = new Set<string>();

    const rl = readline.createInterface({ input: child.stdout! });
    rl.on('line', (line) => {
      stdoutOutput += line + '\n';
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

          if (fullResponse) {
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
      console.log(`[${timestamp()}] Claude 进程退出，代码: ${code}`);
      try { fs.appendFileSync(sessionLog, `[${timestamp()}] [SYSTEM]: Claude 查询结束，退出码: ${code}\n`, 'utf-8'); } catch { /* ignore */ }

      const activeSessionRef = self.activeSessions.get(session.conversationId);
      if (activeSessionRef) {
        activeSessionRef.currentProcess = undefined;
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
          content: '⚠️ Claude 处理完成但未返回任何内容，请重试或换种方式提问',
        }).catch(err => console.error('发送钉钉消息失败:', err));
      }

      if (code === 0) {
        resolve(0);
        return;
      }

      if (activeSessionRef?.interrupted) {
        console.log(`[${timestamp()}] 用户主动中断，忽略错误`);
        activeSessionRef.interrupted = false;
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

      reject(new Error(`Claude 进程退出，代码: ${code}`));
    });

    child.on('error', (err) => {
      console.error('Claude 进程错误:', err);
      fs.appendFileSync(sessionLog, `[${timestamp()}] [ERROR]: 进程错误: ${err.message}\n`, 'utf-8');
      reject(err);
    });
  });
}

/**
 * 执行 Claude 查询（session 模式），支持 TPM 额度超限自动重试和 API Key 配额管理
 */
export async function executeClaudeQuery(
  self: DingClaude,
  session: ISession,
  message: string,
  opts?: { skill?: string; agent?: string; settings?: string; senderNick?: string; senderStaffId?: string },
): Promise<void> {
  const { skill, agent, senderNick, senderStaffId } = opts || {};
  let sessionDir = self.getSessionDir(session);
  let sessionLog = `${sessionDir}/session.log`;
  const dingGroupDir = self.getConversationDir(session.conversationId);

  fs.mkdirSync(sessionDir, { recursive: true });
  // 从 settings-ding.json 恢复上次使用的 Claude Setting
  let currentSetting: IClaudeSetting | null = null;
  const savedApiKey = readApiKeyFromSettings(dingGroupDir);
  if (savedApiKey && self.config.apiKeyCfg) {
    currentSetting = self.config.apiKeyCfg.claudeSettings.find(s => s.apiKey === savedApiKey && s.isValid) || null;
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

  const sender = senderNick && senderStaffId ? `${senderNick}(${senderStaffId})` : 'unknown';
  const messageWithPrefix = `${message} ── 消息来自: ${sender}`;

  self.appendSessionLog(sessionDir, 'user', messageWithPrefix);

  const entryCmd = 'claude';
  const baseCmdArgs = [
    '--permission-mode', 'bypassPermissions',
    '--print',
    '--output-format', 'stream-json',
    '--verbose',
  ];
  if (agent) {
    baseCmdArgs.push('--agent', agent);
  }
  if (session.claudeSessionId) {
    baseCmdArgs.push('--resume', session.claudeSessionId);
    console.log(`[${timestamp()}] 恢复 Claude 会话: ${session.claudeSessionId}`);
  }

  const actualMessage = skill ? `/${skill} ${messageWithPrefix}` : messageWithPrefix;

  let consecutiveFastFail = 0;
  while (true) {
    const isRetry = consecutiveFastFail > 0;

    // 动态构建命令参数（settings 可能在重试时变化）
    const cmdArgs = [ ...baseCmdArgs ];
    const settingsPath = resolveClaudeSettingsPath(self, dingGroupDir, opts?.settings);
    if (settingsPath) {
      cmdArgs.push('--settings', settingsPath);
    }

    let stdinMessage: string;

    if (isRetry) {
      if (session.claudeSessionId && !cmdArgs.includes('--resume')) {
        cmdArgs.push('--resume', session.claudeSessionId);
      }
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
        // 配额耗尽 (429): 尝试切换/轮换 Key
        if (isQuotaExhaustedError(err.output) && self.config.apiKeyCfg) {
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
        await sleep(API_RETRY_DELAY_MS);
        continue;
      }
      throw err;
    }
  }
}
