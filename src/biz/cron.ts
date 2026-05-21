import fs from 'fs';
import readline from 'readline';
import { spawn } from 'child_process';
import { dateUtil } from 'utils-ok';
import { DingClaude } from '././cc-ding-cli';
import { ISession } from './types';
import { sendDingMessage } from './messaging';
import { parseClaudeStreamLine, executeClaudeQuery, resolveClaudeSettingsPath } from './claude-process';
import { saveTask } from './task';
import {
  getClientDir, timestamp,
  getSessionDir, findActiveSession, saveActiveSession,
} from './session';

// ==================== Types ====================

export interface ICronJob {
  id: string;
  conversationId: string;
  cronExpression: string; // 5-field: min hour dom month dow
  description: string;
  prompt: string;
  enabled: boolean;
  createdAt: string;
  lastRunAt?: string;
  senderStaffId: string;
  senderNick: string;
}

// ==================== Persistence ====================

function getCronFile(dc: DingClaude): string {
  return `${getClientDir(dc)}/cron.json`;
}

function loadCronJobs(dc: DingClaude): ICronJob[] {
  const file = getCronFile(dc);
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return Array.isArray(data) ? data : (data.jobs || []);
  } catch {
    return [];
  }
}

function saveCronJobs(dc: DingClaude, jobs: ICronJob[]): void {
  const file = getCronFile(dc);
  fs.writeFileSync(file, JSON.stringify(jobs, null, 2), 'utf-8');
}

// ==================== Cron Expression Matching ====================

function matchesCronField(field: string, value: number, min: number, max: number): boolean {
  if (field === '*') return true;

  if (field.includes(',')) {
    return field.split(',').some(part => matchesCronField(part.trim(), value, min, max));
  }

  if (field.includes('/')) {
    const slashIdx = field.indexOf('/');
    const range = field.substring(0, slashIdx);
    const step = parseInt(field.substring(slashIdx + 1), 10);
    if (isNaN(step) || step <= 0) return false;

    let rangeMin = min;
    let rangeMax = max;
    if (range !== '*') {
      if (range.includes('-')) {
        const parts = range.split('-').map(Number);
        rangeMin = parts[0];
        rangeMax = parts[1];
      } else {
        rangeMin = parseInt(range, 10);
        rangeMax = max;
      }
    }

    if (value < rangeMin || value > rangeMax) return false;
    return (value - rangeMin) % step === 0;
  }

  if (field.includes('-')) {
    const parts = field.split('-').map(Number);
    return value >= parts[0] && value <= parts[1];
  }

  const num = parseInt(field, 10);
  return !isNaN(num) && value === num;
}

function matchesCron(expression: string, now: Date): boolean {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return false;

  const minute = now.getMinutes();
  const hour = now.getHours();
  const dayOfMonth = now.getDate();
  const month = now.getMonth() + 1;
  const dayOfWeek = now.getDay(); // 0=Sunday

  if (!matchesCronField(fields[0], minute, 0, 59)) return false;
  if (!matchesCronField(fields[1], hour, 0, 23)) return false;
  if (!matchesCronField(fields[3], month, 1, 12)) return false;

  // Standard cron: if both dom and dow are non-*, OR logic; otherwise AND
  const domMatch = matchesCronField(fields[2], dayOfMonth, 1, 31);
  const dowMatch = matchesCronField(fields[4], dayOfWeek, 0, 7) ||
    (dayOfWeek === 0 && matchesCronField(fields[4], 7, 0, 7));

  const domIsStar = fields[2] === '*';
  const dowIsStar = fields[4] === '*';

  if (domIsStar && dowIsStar) return true;
  if (domIsStar) return dowMatch;
  if (dowIsStar) return domMatch;
  return domMatch || dowMatch;
}

export function isValidCronExpression(expression: string): boolean {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const fieldPattern = /^(\*|\d+|\d+-\d+|\*\/\d+|\d+\/\d+|\d+-\d+\/\d+|\d+(,\d+)+)$/;
  return fields.every(f => fieldPattern.test(f));
}

// ==================== Claude Analysis ====================

const ANALYSIS_PROMPT = `分析以下定时任务描述，提取cron表达式和任务内容。

用户输入: {INPUT}

请严格返回以下JSON格式（不要返回其他任何内容）：
{"cron":"5位cron表达式(分 时 日 月 周)","prompt":"要执行的任务提示词","desc":"简短的中文描述"}

常见cron格式：
- 每天早上9点: "0 9 * * *"
- 每周一早上9点: "0 9 * * 1"
- 工作日早上9点: "0 9 * * 1-5"
- 每小时: "0 * * * *"
- 每30分钟: "*/30 * * * *"
- 每天中午12点: "0 12 * * *"
- 每月1号早上9点: "0 9 1 * *"
- 每周五下午3点: "0 15 * * 5"`;

async function analyzeCronWithClaude(
  dc: DingClaude,
  conversationId: string,
  input: string,
): Promise<{ cron: string; prompt: string; desc: string }> {
  const dingGroupDir = dc.getConversationDir(conversationId);
  const entryCmd = 'claude';

  const prompt = ANALYSIS_PROMPT.replace('{INPUT}', input);

  const args = [
    '--permission-mode', 'bypassPermissions',
    '--print',
    '--output-format', 'stream-json',
    '--verbose',
  ];

  const settingsPath = resolveClaudeSettingsPath(dc, dingGroupDir);
  if (settingsPath) {
    args.push('--settings', settingsPath);
  }

  console.log(`[${timestamp()}] Cron分析: ${entryCmd} ${args.join(' ')}`);

  return new Promise((resolve, reject) => {
    const child = spawn(entryCmd, args, {
      cwd: dingGroupDir,
      stdio: [ 'pipe', 'pipe', 'pipe' ],
    });

    child.stdin?.write(`${prompt}\n`);
    child.stdin?.end();

    let resultContent = '';
    let stderrOutput = '';
    const rl = readline.createInterface({ input: child.stdout! });
    rl.on('line', (line) => {
      const parsed = parseClaudeStreamLine(line);
      if (parsed?.type === 'result' && parsed.content) {
        resultContent = parsed.content;
      }
    });

    child.stderr?.on('data', (data) => {
      stderrOutput += data.toString();
    });

    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('分析超时(60s)'));
    }, 60_000);

    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0 && resultContent) {
        try {
          const jsonMatch = resultContent.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const result = JSON.parse(jsonMatch[0]);
            if (result.cron && result.prompt) {
              resolve(result);
              return;
            }
          }
          reject(new Error('Claude 返回格式不正确'));
        } catch {
          reject(new Error('JSON 解析失败'));
        }
      } else {
        // 记录 stderr 以便诊断
        const stderrHint = stderrOutput.trim()
          ? ` (${stderrOutput.trim().substring(0, 200)})`
          : '';
        console.error(`[${timestamp()}] Cron分析进程退出(${code})${stderrHint}`);
        // 根据错误类型给出更具体的提示
        const combined = stderrOutput;
        if (/\b429\b/.test(combined)) {
          reject(new Error('Claude 配额已耗尽(429)，请稍后重试或明天再试'));
        } else if (/\b422\b/.test(combined) || /TPM|额度超限/i.test(combined)) {
          reject(new Error('Claude TPM 限流(422)，请稍后重试'));
        } else if (/\b401\b/.test(combined) || /auth|认证|permission/i.test(combined)) {
          reject(new Error('Claude 认证失败(401)，请检查 API Key 配置'));
        } else if (code === 1 && !resultContent && !stderrOutput.trim()) {
          reject(new Error('Claude 进程异常退出，无输出。请检查 claude 命令是否可用'));
        } else {
          reject(new Error(`分析失败 (退出码: ${code})${stderrHint}`));
        }
      }
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(new Error(`启动 Claude 进程失败: ${err.message}`));
    });
  });
}

// ==================== Formatting ====================

export function formatCronJobList(jobs: ICronJob[]): string {
  if (jobs.length === 0) return '📭 暂无定时任务';

  const lines = [ '### ⏰ 定时任务列表\n' ];
  for (const job of jobs) {
    const status = job.enabled ? '✅' : '⏸️';
    const lastRun = job.lastRunAt || '-';
    lines.push(`**${status} ${job.id}**`);
    lines.push(`- Cron: \`${job.cronExpression}\``);
    lines.push(`- 描述: ${job.description}`);
    lines.push(`- 任务: ${job.prompt}`);
    lines.push(`- 创建者: ${job.senderNick}`);
    lines.push(`- 上次执行: ${lastRun}`);
    lines.push('');
  }
  lines.push('💡 \`/cron pause <id>\` 暂停 | \`/cron resume <id>\` 恢复 | \`/cron delete <id>\` 删除');
  return lines.join('\n');
}

export function formatCronJobInfo(job: ICronJob): string {
  const status = job.enabled ? '✅ 启用' : '⏸️ 暂停';
  return [
    `### ⏰ 定时任务 ${job.id}`,
    '',
    `- **状态:** ${status}`,
    `- **Cron:** \`${job.cronExpression}\``,
    `- **描述:** ${job.description}`,
    `- **任务:** ${job.prompt}`,
    `- **创建者:** ${job.senderNick}`,
    `- **创建时间:** ${job.createdAt}`,
    `- **上次执行:** ${job.lastRunAt || '-'}`,
  ].join('\n');
}

// ==================== CronEngine ====================

export class CronEngine {
  private dc: DingClaude;
  private jobs: ICronJob[] = [];
  private timer: NodeJS.Timeout | null = null;
  private lastCheckedTime: number = -1;
  private runningJobIds = new Set<string>();
  readonly MAX_CONCURRENT_JOBS = 3;

  constructor(dc: DingClaude) {
    this.dc = dc;
    this.jobs = loadCronJobs(dc);
  }

  start(): void {
    this.startScheduler();
    const enabledCount = this.jobs.filter(j => j.enabled).length;
    console.log(`[${timestamp()}] Cron引擎已启动, 共 ${this.jobs.length} 个任务 (${enabledCount} 启用)`);
  }

  destroy(): void {
    this.stopScheduler();
  }

  addJob(opts: {
    conversationId: string;
    cronExpression: string;
    description: string;
    prompt: string;
    senderStaffId: string;
    senderNick: string;
  }): ICronJob {
    const job: ICronJob = {
      id: `cron_${Date.now()}`,
      conversationId: opts.conversationId,
      cronExpression: opts.cronExpression,
      description: opts.description,
      prompt: opts.prompt,
      enabled: true,
      createdAt: timestamp(),
      senderStaffId: opts.senderStaffId,
      senderNick: opts.senderNick,
    };
    this.jobs.push(job);
    this.persist();
    console.log(`[${timestamp()}] 新增定时任务: ${job.id} [${job.cronExpression}] ${job.description}`);
    return job;
  }

  removeJob(id: string): boolean {
    const idx = this.jobs.findIndex(j => j.id === id);
    if (idx === -1) return false;
    const removed = this.jobs.splice(idx, 1)[0];
    this.persist();
    console.log(`[${timestamp()}] 删除定时任务: ${removed.id}`);
    return true;
  }

  toggleJob(id: string, enabled: boolean): boolean {
    const job = this.jobs.find(j => j.id === id);
    if (!job) return false;
    job.enabled = enabled;
    this.persist();
    console.log(`[${timestamp()}] 定时任务 ${job.id} ${enabled ? '已恢复' : '已暂停'}`);
    return true;
  }

  listJobs(conversationId?: string): ICronJob[] {
    if (conversationId) {
      return this.jobs.filter(j => j.conversationId === conversationId);
    }
    return [ ...this.jobs ];
  }

  getJob(id: string): ICronJob | undefined {
    return this.jobs.find(j => j.id === id);
  }

  async analyzeAndCreate(
    conversationId: string,
    input: string,
    senderStaffId: string,
    senderNick: string,
  ): Promise<{ job?: ICronJob; error?: string }> {
    try {
      const result = await analyzeCronWithClaude(this.dc, conversationId, input);

      if (!isValidCronExpression(result.cron)) {
        return { error: `Claude 返回的cron表达式无效: ${result.cron}` };
      }

      const job = this.addJob({
        conversationId,
        cronExpression: result.cron,
        description: result.desc || input.substring(0, 50),
        prompt: result.prompt,
        senderStaffId,
        senderNick,
      });
      return { job };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  private persist(): void {
    saveCronJobs(this.dc, this.jobs);
  }

  private startScheduler(): void {
    // 首次对齐到下一个整分钟，之后每60s检查一次
    const now = Date.now();
    const msToNextMinute = 60_000 - (now % 60_000);
    setTimeout(() => {
      this.tick();
      this.timer = setInterval(() => this.tick(), 60_000);
    }, msToNextMinute);
  }

  private stopScheduler(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * 补查从 lastCheckedTime 到 now 之间所有应触发的分钟
   * 防止因事件循环阻塞导致跳过某个整分钟
   */
  private tick(): void {
    const nowMs = Date.now();
    // 从 lastCheckedTime 的下一个整分钟开始，逐分钟检查到当前分钟
    const startMs = this.lastCheckedTime < 0
      ? nowMs - (nowMs % 60_000) // 首次：从当前分钟开始
      : this.lastCheckedTime + 60_000 - (this.lastCheckedTime % 60_000); // 下一个整分钟
    // 上限为当前分钟（不查未来）
    const endMs = nowMs - (nowMs % 60_000);

    for (let ms = startMs; ms <= endMs; ms += 60_000) {
      const checkTime = new Date(ms);
      if (!this.checkJobsAt(checkTime)) break;
    }

    this.lastCheckedTime = nowMs;
  }

  private checkJobsAt(checkTime: Date): boolean {
    if (this.runningJobIds.size >= this.MAX_CONCURRENT_JOBS) {
      console.warn(`[${timestamp()}] Cron并发上限(${this.MAX_CONCURRENT_JOBS}), 跳过 ${checkTime.toISOString()} 的检查`);
      return false;
    }

    for (const job of this.jobs) {
      if (!job.enabled) continue;
      if (this.runningJobIds.has(job.id)) continue;
      if (this.runningJobIds.size >= this.MAX_CONCURRENT_JOBS) break;
      if (!matchesCron(job.cronExpression, checkTime)) continue;

      console.log(`[${timestamp()}] Cron触发: ${job.id} [${job.cronExpression}] ${job.description}`);
      this.executeJob(job).catch(err => {
        console.error(`[${timestamp()}] Cron执行失败: ${job.id}`, err);
      });
    }
    return true;
  }

  private async executeJob(job: ICronJob): Promise<void> {
    this.runningJobIds.add(job.id);
    try {
      const convCfg = this.dc.getConversationConfig(job.conversationId);
      if (!convCfg) {
        console.warn(`[${timestamp()}] Cron任务 ${job.id} 的会话配置不存在, 跳过执行`);
        return;
      }

      // 检查通知能力: 会话级 dingToken 或 客户端级 defaultDingToken
      const hasNotifyCapability = !!(convCfg.dingToken || this.dc.config.defaultDingToken);
      if (!hasNotifyCapability) {
        console.warn(`[${timestamp()}] Cron任务 ${job.id} 无通知能力(无dingToken且无defaultDingToken), 跳过执行`);
        return;
      }

      // 有活跃 session 时降级到任务队列
      const activeSession = findActiveSession(this.dc, job.conversationId);
      if (activeSession) {
        console.log(`[${timestamp()}] Cron任务 ${job.id} 的会话有活跃session, 降级到任务队列`);
        await this.enqueueAsTask(job);
        return;
      }

      const now = Date.now();
      const session: ISession = {
        conversationId: job.conversationId,
        sessionWebhook: '',
        startTime: now,
        startTimeStr: dateUtil.mm(now).format('YYYY-MM-DD-HH-mm-ss'),
        startStaffId: job.senderStaffId,
        startNickName: `[cron]${job.senderNick}`,
      };

      const sessionDir = getSessionDir(this.dc, session);
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(`${sessionDir}/session.json`, JSON.stringify(session, null, 2), 'utf-8');

      this.dc.activeSessions.set(job.conversationId, {
        session,
        lastSenderStaffId: job.senderStaffId,
        isProcessing: true,
        conversationConfig: convCfg,
      });
      saveActiveSession(this.dc, job.conversationId);

      // 记录日志，不发送触发提示
      console.log(`[${timestamp()}] Cron任务 ${job.id} 开始执行: ${job.description}`);
      fs.appendFileSync(
        `${sessionDir}/session.log`,
        `[${timestamp()}] [SYSTEM]: 定时任务触发: ${job.description}\n`,
        'utf-8',
      );

      try {
        await executeClaudeQuery(this.dc, session, job.prompt, {
          skill: convCfg.taskCfg?.skill,
          agent: convCfg.agent,
          senderNick: job.senderNick,
          senderStaffId: job.senderStaffId,
        });
      } catch (err) {
        console.error(`[${timestamp()}] Cron执行Claude查询失败: ${job.id}`, err);
        await sendDingMessage(this.dc, {
          conversationId: job.conversationId,
          sessionWebhook: '',
          atUserId: job.senderStaffId,
          content: `❌ 定时任务执行失败: ${err instanceof Error ? err.message : String(err)}`,
        });
      } finally {
        this.dc.activeSessions.delete(job.conversationId);
        saveActiveSession(this.dc, job.conversationId);
      }

      job.lastRunAt = timestamp();
      this.persist();
    } finally {
      this.runningJobIds.delete(job.id);
    }
  }

  /**
   * 将 cron 任务降级到 task 队列执行
   * 当会话有活跃 session 时使用，避免冲突
   */
  private async enqueueAsTask(job: ICronJob): Promise<void> {
    try {
      await saveTask(this.dc, {
        conversationId: job.conversationId,
        prompt: job.prompt,
        senderStaffId: job.senderStaffId,
        senderNickName: `[cron]${job.senderNick}`,
        sessionWebhook: '',
        type: 'cron',
      });
      console.log(`[${timestamp()}] Cron任务 ${job.id} 已降级到任务队列: ${job.description}`);
    } catch (err) {
      console.error(`[${timestamp()}] Cron任务 ${job.id} 降级到任务队列失败:`, err);
    }

    job.lastRunAt = timestamp();
    this.persist();
  }
}
