import { baseUtil, dateUtil, fileUtil } from 'utils-ok';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { utils } from '../common';
import type { DingClaude } from './cc-ding-cli';
import { IClaudeSetting, ITask } from './types';
import { sendDingMessage } from './messaging';
import { isRetryableApiError, resolveClaudeSettingsPath } from './claude-process';
import { runOneShotPrompt } from './claude-sdk';
import { getConversationConfig, getConversationDir, getTasksDir, debugLog, timestamp } from './session';
import {
  rotateApiKey,
  pickValidApiKey,
  ensureSettingsWithApiKey,
  isQuotaExhaustedError,
  isAuthenticationError,
  getForceEnabledSettingsPath,
  settingLabel,
} from './api-key-manager';

const MAX_RETRY_COUNT = 3;
/** 任务重置为待办后，延迟多久唤醒 handler 重试 */
const RETRY_NOTIFY_DELAY_MS = 10_000;
/** 队列空闲时的兜底扫描间隔（捕获外部写入的任务文件等异常场景） */
const IDLE_SWEEP_INTERVAL_MS = 60_000;

// ==================== 任务队列唤醒信号 ====================
// 任务提交/重试时即时唤醒 handler，替代固定间隔轮询

const taskWaiters: Array<() => void> = [];

/** 唤醒所有等待中的任务 handler */
export function notifyTaskQueue(): void {
  while (taskWaiters.length > 0) {
    const wake = taskWaiters.shift()!;
    wake();
  }
}

/** 等待新任务信号，超时后自动返回（兜底扫描） */
function waitForTaskSignal(timeoutMs: number): Promise<void> {
  return new Promise(resolve => {
    const wake = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      const idx = taskWaiters.indexOf(wake);
      if (idx !== -1) taskWaiters.splice(idx, 1);
      resolve();
    }, timeoutMs);
    timer.unref?.();
    taskWaiters.push(wake);
  });
}

/**
 * 格式化任务队列信息：处理中、待办队列、最近完成 top5、失败任务
 */
export function formatTaskInfo(self: DingClaude): string {
  const todoTasks: ITask[] = [];
  const doingTasks: ITask[] = [];
  const doneTasks: ITask[] = [];
  const failedTasks: ITask[] = [];

  for (const conv of self.config.conversations) {
    const tasksDir = getTasksDir(self, conv.conversationId);
    if (!fs.existsSync(tasksDir)) continue;

    const files = fileUtil.dirWalker(tasksDir);
    for (const f of files) {
      const basename = path.basename(f);
      try {
        const task = fileUtil.getJSON(f) as ITask | null;
        if (!task) continue;
        if (basename === 'task.json') {
          todoTasks.push(task);
        } else if (basename === 'task-doing.json') {
          doingTasks.push(task);
        } else if (basename === 'task-done.json') {
          doneTasks.push(task);
        } else if (basename === 'task-failed.json') {
          failedTasks.push(task);
        }
      } catch { /* skip invalid task files */ }
    }
  }

  // 排序：待办按开始时间升序(FIFO)，完成/失败按开始时间降序(最近优先)
  todoTasks.sort((a, b) => a.startTime - b.startTime);
  doingTasks.sort((a, b) => a.startTime - b.startTime);
  doneTasks.sort((a, b) => b.startTime - a.startTime);
  failedTasks.sort((a, b) => b.startTime - a.startTime);

  const parts: string[] = [];

  // 正在处理中
  if (doingTasks.length > 0) {
    const lines = doingTasks.map(t =>
      `#${t.startTime} ${t.senderNickName || t.senderStaffId}: ${taskDisplayName(t)}`,
    );
    parts.push(`**⏳ 处理中 (${doingTasks.length})**\n${lines.join('\n')}`);
  } else {
    parts.push('**⏳ 处理中**\n无');
  }

  // 待办队列
  if (todoTasks.length > 0) {
    const lines = todoTasks.map(t =>
      `#${t.startTime} ${t.senderNickName || t.senderStaffId}: ${taskDisplayName(t)}`,
    );
    parts.push(`**📋 待办队列 (${todoTasks.length})**\n${lines.join('\n')}`);
  } else {
    parts.push('**📋 待办队列**\n无');
  }

  // 最近完成 top5
  const top5Done = doneTasks.slice(0, 5);
  if (top5Done.length > 0) {
    const lines = top5Done.map(t =>
      `#${t.startTime} ${t.senderNickName || t.senderStaffId}: ${taskDisplayName(t)}`,
    );
    parts.push(`**✅ 最近完成 (top ${top5Done.length}/${doneTasks.length})**\n${lines.join('\n')}`);
  } else {
    parts.push('**✅ 最近完成**\n无');
  }

  // 失败任务
  if (failedTasks.length > 0) {
    const lines = failedTasks.map(t =>
      `#${t.startTime} ${t.senderNickName || t.senderStaffId}: ${taskDisplayName(t)}${t.retryCount ? ` (重试${t.retryCount}次)` : ''}`,
    );
    parts.push(`**❌ 失败 (${failedTasks.length})**\n${lines.join('\n')}`);
  }

  return parts.join('\n\n');
}

function truncatePrompt(prompt: string, maxLen: number = 80): string {
  const oneLine = prompt.replace(/\n/g, ' ').trim();
  return oneLine.length > maxLen ? oneLine.slice(0, maxLen) + '...' : oneLine;
}

function taskDisplayName(task: ITask): string {
  if (task.title) return task.title;
  return truncatePrompt(task.prompt);
}

/**
 * 预处理任务：调用 Claude 归纳标题、优化 prompt
 * 失败时返回 null，调用方应降级使用原始 prompt
 */
async function preprocessTask(
  self: DingClaude,
  conversationId: string,
  prompt: string,
): Promise<{ title: string; promptSimply: string } | null> {
  const conversationDir = getConversationDir(self, conversationId);
  const settingsPath = resolveClaudeSettingsPath(self, conversationDir);

  const prePrompt = [
    '请对以下任务需求进行预处理，生成简短标题和优化后的需求描述。',
    '直接返回JSON，不要markdown代码块或其他内容。',
    '格式: {"title":"简短标题(15字以内)","promptSimply":"优化后的需求描述，保留原始需求的所有关键信息，使描述更清晰、结构化"}',
    '',
    `原始需求: ${prompt}`,
  ].join('\n');

  const res = await runOneShotPrompt(prePrompt, { cwd: conversationDir, settingsPath, timeoutMs: 30_000 });

  if (!res.ok || !res.text.trim()) {
    const reason = res.timedOut ? '超时' : (res.errorOutput.trim().substring(0, 100) || '无输出');
    console.log(`[${timestamp()}] 任务预处理失败(${reason})，使用原始prompt`);
    return null;
  }

  try {
    let jsonStr = res.text.trim();
    const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (jsonMatch) jsonStr = jsonMatch[0];
    const result = JSON.parse(jsonStr);
    if (result.title && result.promptSimply) {
      console.log(`[${timestamp()}] 任务预处理完成: title="${result.title}"`);
      return { title: String(result.title), promptSimply: String(result.promptSimply) };
    }
    console.log(`[${timestamp()}] 任务预处理返回格式不正确，使用原始prompt`);
    return null;
  } catch (err) {
    console.log(`[${timestamp()}] 任务预处理JSON解析失败，使用原始prompt: ${err}`);
    return null;
  }
}

export function countTodoTask(self: DingClaude): number {
  let count = 0;
  for (const conv of self.config.conversations) {
    const tasksDir = getTasksDir(self, conv.conversationId);
    if (fs.existsSync(tasksDir)) {
      const files = fileUtil.dirWalker(tasksDir);
      const jsonFiles = files.filter(f => path.basename(f) === 'task.json');
      count += jsonFiles.length;
    }
  }
  return count;
}

export async function getOneTodoTask(self: DingClaude): Promise<ITask | undefined> {
  for (const conv of self.config.conversations) {
    const tasksDir = getTasksDir(self, conv.conversationId);
    if (!fs.existsSync(tasksDir)) continue;

    const files = fileUtil.dirWalker(tasksDir);
    const jsonFiles = files.filter(f => path.basename(f) === 'task.json');
    if (jsonFiles.length === 0) continue;

    const tasksWithFiles = jsonFiles
      .map(f => {
        try {
          const task = fileUtil.getJSON(f) as ITask | null;
          return task ? { file: f, task } : null;
        } catch {
          console.error(`任务文件解析失败，跳过: ${f}`);
          return null;
        }
      })
      .filter((item): item is { file: string; task: ITask } => item !== null)
      .sort((a, b) => a.task.startTime - b.task.startTime);

    if (tasksWithFiles.length > 0) {
      const { file, task } = tasksWithFiles[0];
      utils.addSuffixToFile(file, '-doing');
      return task;
    }
  }
  return undefined;
}

export async function finishTask(self: DingClaude, taskDir: string): Promise<void> {
  const taskJson = `${taskDir}/task-doing.json`;
  let task: ITask;
  try {
    task = fileUtil.getJSON(taskJson) as ITask;
  } catch (err) {
    console.error(`读取任务文件失败: ${taskJson}`, err);
    return;
  }

  const resultFile = `${taskDir}/result.md`;
  const resultMd = fs.existsSync(resultFile)
    ? fileUtil.getFileStr(resultFile)
    : '抱歉,任务处理异常...';

  await sendDingMessage(self, {
    conversationId: task.conversationId,
    sessionWebhook: task.sessionWebhook,
    atUserId: task.senderStaffId,
    content: resultMd,
    msgType: 'markdown',
  });

  const doneTaskJson = taskJson.replace('-doing.json', '-done.json');
  fileUtil.rename(taskJson, doneTaskJson);
}

/**
 * 将任务标记为失败（task-doing.json → task-failed.json），并通知用户
 */
async function failTask(self: DingClaude, taskDir: string, reason: string): Promise<void> {
  const taskJson = `${taskDir}/task-doing.json`;
  let task: ITask;
  try {
    task = fileUtil.getJSON(taskJson) as ITask;
  } catch (err) {
    console.error(`读取任务文件失败: ${taskJson}`, err);
    return;
  }

  await sendDingMessage(self, {
    conversationId: task.conversationId,
    sessionWebhook: task.sessionWebhook,
    atUserId: task.senderStaffId,
    content: `❌ 任务失败: ${taskDisplayName(task)}\n原因: ${reason}`,
    msgType: 'markdown',
  });

  const failedTaskJson = taskJson.replace('-doing.json', '-failed.json');
  fileUtil.rename(taskJson, failedTaskJson);
}

/**
 * 重置任务为待办（task-doing.json → task.json），递增 retryCount
 * 超过 MAX_RETRY_COUNT 则标记为失败
 * 返回 true 表示已重置为待办，false 表示已标记为失败
 */
async function resetTaskToTodo(self: DingClaude, taskDir: string, reason: string): Promise<boolean> {
  const doingFile = `${taskDir}/task-doing.json`;
  const todoFile = `${taskDir}/task.json`;
  if (!fs.existsSync(doingFile)) return false;

  // 读取并更新 retryCount
  try {
    const task = fileUtil.getJSON(doingFile) as ITask;
    const retryCount = (task.retryCount || 0) + 1;
    if (retryCount >= MAX_RETRY_COUNT) {
      console.log(`[${timestamp()}] 任务重试次数已达上限(${retryCount}/${MAX_RETRY_COUNT})，标记为失败: ${task.title || task.prompt}`);
      // 更新 retryCount 后标记为失败
      task.retryCount = retryCount;
      fs.writeFileSync(doingFile, JSON.stringify(task, null, 2), 'utf-8');
      await failTask(self, taskDir, `${reason} (已重试${retryCount}次)`);
      return false;
    }
    task.retryCount = retryCount;
    fs.writeFileSync(doingFile, JSON.stringify(task, null, 2), 'utf-8');
    console.log(`[${timestamp()}] 任务重置为待办 (重试${retryCount}/${MAX_RETRY_COUNT}): ${task.title || task.prompt}`);
  } catch (err) {
    console.error(`[${timestamp()}] 更新任务重试计数失败:`, err);
  }

  if (fs.existsSync(doingFile)) {
    fileUtil.rename(doingFile, todoFile);
  }
  // 延迟唤醒 handler 重试（与旧轮询间隔一致）
  const timer = setTimeout(() => notifyTaskQueue(), RETRY_NOTIFY_DELAY_MS);
  timer.unref?.();
  return true;
}

/**
 * 取消待办任务，支持按 startTime(taskId) 精确匹配或 title 模糊匹配
 * 返回取消结果描述
 */
export function cancelTask(self: DingClaude, query: string, conversationId?: string): string {
  const matchedTasks: { file: string; task: ITask }[] = [];
  const trimmedQuery = query.trim();

  const conversations = conversationId
    ? self.config.conversations.filter(c => c.conversationId === conversationId)
    : self.config.conversations;

  for (const conv of conversations) {
    const tasksDir = getTasksDir(self, conv.conversationId);
    if (!fs.existsSync(tasksDir)) continue;

    const files = fileUtil.dirWalker(tasksDir);
    const jsonFiles = files.filter(f => path.basename(f) === 'task.json');

    for (const f of jsonFiles) {
      try {
        const task = fileUtil.getJSON(f) as ITask | null;
        if (!task) continue;
        // 精确匹配 startTime (taskId)
        if (String(task.startTime) === trimmedQuery) {
          matchedTasks.push({ file: f, task });
          continue;
        }
        // 模糊匹配 title
        if (task.title && task.title.includes(trimmedQuery)) {
          matchedTasks.push({ file: f, task });
          continue;
        }
      } catch { /* skip */ }
    }
  }

  if (matchedTasks.length === 0) {
    return `未找到匹配的待办任务: ${trimmedQuery}`;
  }

  // 删除匹配的 task.json
  let cancelled = 0;
  for (const { file, task } of matchedTasks) {
    try {
      fs.unlinkSync(file);
      cancelled++;
      console.log(`[${timestamp()}] 已取消任务: #${task.startTime} ${task.title || task.prompt}`);
    } catch (err) {
      console.error(`[${timestamp()}] 取消任务失败: ${file}`, err);
    }
  }

  const displayNames = matchedTasks.slice(0, 5).map(t => `#${t.task.startTime} ${taskDisplayName(t.task)}`).join('\n');
  const suffix = cancelled > 5 ? `\n...共取消 ${cancelled} 个任务` : '';
  return `已取消 ${cancelled} 个待办任务:\n${displayNames}${suffix}`;
}

/**
 * 解析 /task cancel 命令，返回要取消的任务标识，非 cancel 命令返回 null
 */
export function parseTaskCancelCommand(text: string): string | null {
  const trimmed = text.trim();
  const match = trimmed.match(/^\/task\s+cancel\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

/**
 * 更新 cmdArgs 中的 --settings 参数
 */
function updateCmdArgsSettings(cmdArgs: string[], settingsPath: string | undefined): void {
  const idx = cmdArgs.indexOf('--settings');
  if (idx !== -1) {
    cmdArgs.splice(idx, 2);
  }
  if (settingsPath) {
    cmdArgs.push('--settings', settingsPath);
  }
}

/**
 * 处理一个待办任务
 * @returns true 表示已处理完一个任务（可立即尝试下一个）；false 表示队列为空或需要退避等待
 */
export async function handleTask(self: DingClaude): Promise<boolean> {
  const task = await getOneTodoTask(self);
  if (!task) {
    debugLog(self, '未发现待办任务...');
    return false;
  }

  const convCfg = getConversationConfig(self, task.conversationId);
  const conversationDir = getConversationDir(self, task.conversationId);
  const taskDir = `${getTasksDir(self, task.conversationId)}/${task.startTimeStr}`;
  if (!fs.existsSync(taskDir)) {
    console.error(`任务目录不存在: ${taskDir}`);
    return true;
  }

  // 通知用户任务开始处理（cron 任务不发送开始提醒）
  if (task.type !== 'cron') {
    await sendDingMessage(self, {
      conversationId: task.conversationId,
      sessionWebhook: task.sessionWebhook,
      atUserId: task.senderStaffId,
      content: `🔄 开始处理任务: ${taskDisplayName(task)}`,
    });
  }

  const resultMd = `${taskDir}/result.md`;
  const logFile = `${taskDir}/task.log`;
  console.log(`[${timestamp()}] 任务处理中: ${task.title || task.prompt}`);

  const sender = task.senderNickName && task.senderStaffId
    ? `${task.senderNickName}(${task.senderStaffId}), `
    : 'unknown';

  // apiKeyCfg 配额逻辑
  const apiKeyCfg = self.config.apiKeyCfg;
  const forceSettingsPath = getForceEnabledSettingsPath(conversationDir);
  let useApiMode = false;
  let currentSetting: IClaudeSetting | null = null;

  if (forceSettingsPath) {
    console.log(`[${timestamp()}] 检测到 FORCE_ENABLE，强制使用 settings-ding.json`);
  } else if (apiKeyCfg) {
    currentSetting = pickValidApiKey(self);
    if (!currentSetting) {
      // 无可用配额，重置任务为待办
      console.log(`[${timestamp()}] 无可用配额，任务重置为待办`);
      await resetTaskToTodo(self, taskDir, '无可用配额');
      return false;
    }
    useApiMode = true;
    console.log(`[${timestamp()}] 切换到 API Key 模式`);
  }

  const skill = convCfg?.taskCfg?.skill;
  const agent = convCfg?.agent;
  const taskPrompt = task.promptSimply || task.prompt;
  const promptWithSkill = `${skill ? `/${skill}` : ''} 用户: ${sender}, 需求: ${taskPrompt}; 最后将回复内容保存至: ${resultMd}`.trim();

  const cmdArgs = [
    '--permission-mode', convCfg?.permissionMode || 'acceptEdits',
    '--print',
    promptWithSkill,
  ];

  // 构建 settings 参数
  if (forceSettingsPath) {
    cmdArgs.push('--settings', forceSettingsPath);
  } else if (useApiMode && currentSetting) {
    const settingsPath = ensureSettingsWithApiKey(conversationDir, currentSetting);
    cmdArgs.push('--settings', settingsPath);
  } else if (!apiKeyCfg) {
    // 无 apiKeyCfg: 自动检测 settings.json
    const autoSettingsPath = path.join(conversationDir, '.claude', 'settings.json');
    if (fs.existsSync(autoSettingsPath)) {
      cmdArgs.push('--settings', autoSettingsPath);
      console.log(`[${timestamp()}] 自动检测到 settings.json: ${autoSettingsPath}`);
    }
  }
  if (agent) {
    cmdArgs.push('--agent', agent);
  }

  debugLog(self, `执行命令: claude ${cmdArgs.join(' ')}`);

  const MAX_FAST_FAIL = 20;
  const RETRY_DELAY_MS = 10_000;
  const FAST_FAIL_THRESHOLD_MS = 10_000;
  const WATCHDOG_TIMEOUT_MS = 5 * 60 * 1000;
  const WATCHDOG_CHECK_INTERVAL_MS = 60 * 1000;
  const entryCmd = 'claude';

  const runTaskOnce = (args: string[]): Promise<{ exitCode: number; output: string; elapsed: number }> => {
    const startTime = Date.now();
    return new Promise((resolve) => {
      const logChunks: string[] = [];
      let exited = false;
      let lastActivityTime = Date.now();

      const child = spawn(entryCmd, args, {
        cwd: conversationDir,
        stdio: [ 'ignore', 'pipe', 'pipe' ],
      });

      // Watchdog: 定期检查是否长时间无活动，发送提醒（不终止进程）
      const watchdogTimer = setInterval(() => {
        if (exited) {
          clearInterval(watchdogTimer);
          return;
        }
        const elapsed = Date.now() - lastActivityTime;
        if (elapsed >= WATCHDOG_TIMEOUT_MS) {
          console.warn(`[${timestamp()}] 任务 Watchdog: ${WATCHDOG_TIMEOUT_MS / 1000}s 无日志输出，通知用户`);
          clearInterval(watchdogTimer);
          sendDingMessage(self, {
            conversationId: task.conversationId,
            sessionWebhook: task.sessionWebhook,
            atUserId: task.senderStaffId,
            content: `⏰ 任务超过 ${WATCHDOG_TIMEOUT_MS / 1000}s 无响应，仍在执行中，请稍候`,
          }).catch(err => console.error('发送任务 Watchdog 通知失败:', err));
        }
      }, WATCHDOG_CHECK_INTERVAL_MS);

      const updateActivity = () => { lastActivityTime = Date.now(); };

      child.stdout.on('data', (data) => {
        const str = data.toString();
        process.stdout.write(str);
        logChunks.push(str);
        updateActivity();
      });

      child.stderr.on('data', (data) => {
        const str = data.toString();
        process.stderr.write(str);
        logChunks.push(str);
        updateActivity();
      });

      child.on('close', (code) => {
        exited = true;
        clearInterval(watchdogTimer);
        resolve({ exitCode: code ?? 1, output: logChunks.join(''), elapsed: Date.now() - startTime });
      });

      child.on('error', (err) => {
        console.error('进程执行错误:', err);
        logChunks.push(`进程执行错误: ${err.message}`);
      });
    });
  };

  let exitCode: number;
  let combinedOutput: string;
  let consecutiveFastFail = 0;

  while (true) {
    const result = await runTaskOnce(cmdArgs);
    exitCode = result.exitCode;
    combinedOutput = result.output;

    if (exitCode !== 0) {

      // 配额耗尽 (429): 尝试切换/轮换 Key
      if (isQuotaExhaustedError(combinedOutput) && apiKeyCfg) {
        if (!useApiMode) {
          // 切换到 API Key 模式
          currentSetting = pickValidApiKey(self);
          if (currentSetting) {
            useApiMode = true;
            consecutiveFastFail = 0;
            const settingsPath = ensureSettingsWithApiKey(conversationDir, currentSetting);
            updateCmdArgsSettings(cmdArgs, settingsPath);
            console.log(`[${timestamp()}] 切换到 API Key 模式`);
            continue;
          }
        } else if (currentSetting) {
          // API Key 配额耗尽 → 轮换 Key
          const newSetting = rotateApiKey(self, currentSetting.apiKey);
          if (newSetting) {
            currentSetting = newSetting;
            consecutiveFastFail = 0;
            const settingsPath = ensureSettingsWithApiKey(conversationDir, currentSetting);
            updateCmdArgsSettings(cmdArgs, settingsPath);
            console.log(`[${timestamp()}] API Key 配额耗尽(429)，切换到新 Key: ${settingLabel(newSetting)}`);
            continue;
          }
        }
        // 无可用配额，重置任务为待办
        console.log(`[${timestamp()}] 无可用配额，任务重置为待办`);
        const logContent = [
          `[${timestamp()}] 执行命令: ${entryCmd} ${cmdArgs.join(' ')}`,
          `[${timestamp()}] 退出码: ${exitCode}`,
          combinedOutput,
        ].join('\n');
        fs.writeFileSync(logFile, logContent);
        await resetTaskToTodo(self, taskDir, '无可用配额(429)');
        return false;
      }

      // 认证错误(401)：不可重试，直接标记失败
      if (isAuthenticationError(combinedOutput)) {
        console.log(`[${timestamp()}] 检测到认证错误(401)，标记任务失败`);
        const logContent = [
          `[${timestamp()}] 执行命令: ${entryCmd} ${cmdArgs.join(' ')}`,
          `[${timestamp()}] 退出码: ${exitCode}`,
          combinedOutput,
        ].join('\n');
        fs.writeFileSync(logFile, logContent);
        await failTask(self, taskDir, '认证失败(401)，API Key 无效或服务未授权');
        return true;
      }

      // 可重试 API 错误（422 TPM 限流等）
      if (isRetryableApiError(combinedOutput)) {
        // API Key 模式下连续快速失败 → 轮换 Key
        if (result.elapsed < FAST_FAIL_THRESHOLD_MS && useApiMode && currentSetting && apiKeyCfg) {
          consecutiveFastFail++;
          if (consecutiveFastFail >= MAX_FAST_FAIL) {
            const newSetting = rotateApiKey(self, currentSetting.apiKey);
            if (newSetting) {
              currentSetting = newSetting;
              consecutiveFastFail = 0;
              const settingsPath = ensureSettingsWithApiKey(conversationDir, currentSetting);
              updateCmdArgsSettings(cmdArgs, settingsPath);
              console.log(`[${timestamp()}] TPM 限流连续快速失败 ${MAX_FAST_FAIL} 次，切换到新 Key: ${settingLabel(newSetting)}`);
              await baseUtil.sleep(RETRY_DELAY_MS);
              continue;
            }
            // 无可用 Key，继续原有重试逻辑
          }
        } else if (result.elapsed < FAST_FAIL_THRESHOLD_MS) {
          consecutiveFastFail++;
          if (consecutiveFastFail >= MAX_FAST_FAIL) {
            console.log(`[${timestamp()}] TPM 限流快速失败连续${MAX_FAST_FAIL}次，重置任务为待办`);
            const logContent = [
              `[${timestamp()}] 执行命令: ${entryCmd} ${cmdArgs.join(' ')}`,
              `[${timestamp()}] 退出码: ${exitCode}`,
              combinedOutput,
            ].join('\n');
            fs.writeFileSync(logFile, logContent);
            await resetTaskToTodo(self, taskDir, 'TPM限流快速失败次数过多');
            return false;
          }
          console.log(`[${timestamp()}] 检测到 TPM 限流(快速失败)，${RETRY_DELAY_MS / 1000}s 后重试 (${consecutiveFastFail}/${MAX_FAST_FAIL})`);
        } else {
          consecutiveFastFail = 0;
          console.log(`[${timestamp()}] 检测到 TPM 限流(进程已运行一段时间)，重置快速失败计数，${RETRY_DELAY_MS / 1000}s 后重试`);
        }
        await baseUtil.sleep(RETRY_DELAY_MS);
        continue;
      }
    }
    break;
  }

  const logContent = [
    `[${timestamp()}] 执行命令: ${entryCmd} ${cmdArgs.join(' ')}`,
    `[${timestamp()}] 退出码: ${exitCode}`,
    combinedOutput,
  ].join('\n');
  fs.writeFileSync(logFile, logContent);

  if (exitCode !== 0) {
    // 非超时、非429、非422的其他错误 → 标记为失败
    console.error(`命令执行失败, 退出码: ${exitCode}`);
    await failTask(self, taskDir, `执行失败(退出码: ${exitCode})`);
    return true;
  }

  if (fs.existsSync(resultMd)) {
    console.log(`[${timestamp()}] 任务处理完成`);
  } else {
    console.error('任务未按预期处理');
    await failTask(self, taskDir, '未生成结果文件');
    return true;
  }

  await finishTask(self, taskDir);
  return true;
}

/**
 * 任务处理循环：事件驱动
 * - 处理完一个任务立即尝试下一个（排空队列）
 * - 队列为空时等待 saveTask 的唤醒信号，IDLE_SWEEP_INTERVAL_MS 兜底扫描
 */
export async function runTaskHandlerLoop(self: DingClaude): Promise<void> {
  while (true) {
    const processed = await handleTask(self).catch((e): boolean => {
      console.error(e);
      return false;
    });
    if (processed) continue;
    await waitForTaskSignal(IDLE_SWEEP_INTERVAL_MS);
  }
}

export async function saveTask(self: DingClaude, opts: {
  conversationId: string;
  prompt: string;
  senderStaffId: string;
  senderNickName?: string;
  sessionWebhook: string;
  type?: 'cron' | 'normal';
}): Promise<void> {
  const { conversationId, prompt, senderStaffId, senderNickName, sessionWebhook, type = 'normal' } = opts;

  const now = Date.now();
  const startTimeStr = dateUtil.mm(now).format('YYYY-MM-DD-HH-mm-ss');
  const taskDir = `${getTasksDir(self, conversationId)}/${startTimeStr}`;
  const todoFile = `${taskDir}/task.json`;

  // 先写入任务（无 title/promptSimply），确保不阻塞用户提交
  const taskData: ITask = {
    conversationId,
    startTime: now,
    startTimeStr,
    prompt,
    senderStaffId,
    senderNickName: senderNickName || '',
    sessionWebhook,
    type,
  };
  await fileUtil.saveFileStr(JSON.stringify(taskData, null, 2), todoFile);
  debugLog(self, `任务已保存: ${todoFile}`);
  // 即时唤醒任务 handler，无需等待轮询
  notifyTaskQueue();

  // 异步预处理：后台调用 Claude 归纳标题和优化 prompt，完成后更新 task.json
  preprocessTask(self, conversationId, prompt).then(preResult => {
    if (!preResult) return;
    try {
      // 重新读取 task.json（可能已被 handler 改为 task-doing.json）
      const doingFile = `${taskDir}/task-doing.json`;
      const targetFile = fs.existsSync(doingFile) ? doingFile : (fs.existsSync(todoFile) ? todoFile : null);
      if (!targetFile) {
        console.log(`[${timestamp()}] 预处理完成但任务文件已不存在: ${taskDir}`);
        return;
      }
      const existing = fileUtil.getJSON(targetFile) as ITask;
      existing.title = preResult.title;
      existing.promptSimply = preResult.promptSimply;
      fs.writeFileSync(targetFile, JSON.stringify(existing, null, 2), 'utf-8');
      console.log(`[${timestamp()}] 任务预处理结果已更新: ${preResult.title}`);
    } catch (err) {
      console.error(`[${timestamp()}] 更新任务预处理结果失败:`, err);
    }
  }).catch(err => {
    console.error(`[${timestamp()}] 任务预处理异常:`, err);
  });
}
