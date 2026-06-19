import fs from 'fs';
import path from 'path';
import type { DingClaude } from './cc-ding-cli';
import { sendDingMessage } from './messaging';
import { executeClaudeQuery } from './claude-process';
import { saveTask } from './task';
import { findActiveSession, getClientDir, timestamp } from './session';
import type { ISession } from './types';

// ==================== 接口定义 ====================

export interface ITimerJob {
  id: string;           // 格式: timer_{timestamp}
  conversationId: string;
  delayMs: number;      // 延时毫秒数
  fireAt: number;       // 触发时间戳
  prompt: string;       // 原始用户输入
  description: string;  // 可读描述
  createdAt: string;    // 创建时间字符串
  senderStaffId: string;
  senderNick: string;
  fired?: boolean;
}

// ==================== 时间解析 ====================

/**
 * 解析延时字符串，返回毫秒数
 * 支持 d/h/m/s 组合，如 "1h30m"、"2d"、"30s"
 * 无效输入返回 null
 */
export function parseDelay(input: string): number | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const regex = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/;
  const match = trimmed.match(regex);
  if (!match) return null;

  const days = parseInt(match[1] || '0', 10);
  const hours = parseInt(match[2] || '0', 10);
  const minutes = parseInt(match[3] || '0', 10);
  const seconds = parseInt(match[4] || '0', 10);

  // 至少需要有一个单位
  if (days === 0 && hours === 0 && minutes === 0 && seconds === 0) return null;

  return ((days * 24 + hours) * 60 + minutes) * 60 * 1000 + seconds * 1000;
}

// ==================== 格式化 ====================

/**
 * 将毫秒数格式化为中文可读描述，如 "1小时30分钟"
 */
export function formatDelay(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}天`);
  if (hours > 0) parts.push(`${hours}小时`);
  if (minutes > 0) parts.push(`${minutes}分钟`);
  if (seconds > 0) parts.push(`${seconds}秒`);

  return parts.join('') || '0秒';
}

/**
 * 格式化 Timer 列表为 Markdown
 */
export function formatTimerList(jobs: ITimerJob[]): string {
  if (jobs.length === 0) return ' 暂无待执行的定时任务';

  const lines = jobs.map(job => {
    const remaining = job.fireAt - Date.now();
    const remainingStr = remaining > 0 ? formatDelay(remaining) : '已到期';
    return `- \`${job.id}\` ${remainingStr}后触发 — ${job.description}`;
  });

  return `**⏰ 待执行定时任务 (${jobs.length})**\n\n${lines.join('\n')}`;
}

/**
 * 格式化单个 Timer 确认信息
 */
export function formatTimerInfo(job: ITimerJob): string {
  return `✅ 定时提醒已设置\n\n- ID: \`${job.id}\`\n- 延时: ${formatDelay(job.delayMs)}\n- 触发时间: ${new Date(job.fireAt).toLocaleString()}\n- 内容: ${job.description}`;
}

// ==================== 持久化 ====================

function getTimersFilePath(self: DingClaude): string {
  return path.join(getClientDir(self), 'timers.json');
}

function loadTimerJobs(self: DingClaude): ITimerJob[] {
  const filePath = getTimersFilePath(self);
  if (!fs.existsSync(filePath)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as ITimerJob[];
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function saveTimerJobs(self: DingClaude, jobs: ITimerJob[]): void {
  const filePath = getTimersFilePath(self);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // 过滤掉 fired 的任务
  const pending = jobs.filter(j => !j.fired);
  fs.writeFileSync(filePath, JSON.stringify(pending, null, 2), 'utf-8');
}

// ==================== TimerEngine ====================

export class TimerEngine {
  private dc: DingClaude;
  private jobs: ITimerJob[] = [];
  private handles: Map<string, NodeJS.Timeout> = new Map();

  constructor(dc: DingClaude) {
    this.dc = dc;
    // 加载持久化数据
    this.jobs = loadTimerJobs(this.dc);
  }

  /**
   * 启动时调度所有未执行任务，已过期的立即执行
   */
  start(): void {
    const now = Date.now();
    for (const job of this.jobs) {
      if (job.fired) continue;
      const delay = job.fireAt - now;
      if (delay <= 0) {
        // 已过期，立即执行
        console.log(`[${timestamp()}] Timer 任务 ${job.id} 已过期，立即执行`);
        this.executeJob(job);
      } else {
        // 设置定时器
        this.scheduleJob(job, delay);
      }
    }
  }

  /**
   * 清理所有定时器
   */
  destroy(): void {
    for (const [ , handle ] of this.handles) {
      clearTimeout(handle);
    }
    this.handles.clear();
  }

  /**
   * 添加新任务并持久化
   */
  addTimer(opts: ITimerJob): ITimerJob {
    this.jobs.push(opts);
    saveTimerJobs(this.dc, this.jobs);
    this.scheduleJob(opts, opts.delayMs);
    return opts;
  }

  /**
   * 取消任务并持久化
   */
  removeTimer(id: string): boolean {
    const idx = this.jobs.findIndex(j => j.id === id);
    if (idx === -1) return false;
    const job = this.jobs[idx];
    job.fired = true; // 标记为已处理（取消也视为不再执行）
    const handle = this.handles.get(id);
    if (handle) {
      clearTimeout(handle);
      this.handles.delete(id);
    }
    saveTimerJobs(this.dc, this.jobs);
    return true;
  }

  /**
   * 列出待执行任务
   */
  listTimers(conversationId?: string): ITimerJob[] {
    return this.jobs.filter(j => {
      if (j.fired) return false;
      if (conversationId) return j.conversationId === conversationId;
      return true;
    });
  }

  // ==================== 内部方法 ====================

  private scheduleJob(job: ITimerJob, delayMs: number): void {
    const handle = setTimeout(() => {
      this.handles.delete(job.id);
      this.executeJob(job);
    }, delayMs);
    // 避免阻塞进程退出
    handle.unref?.();
    this.handles.set(job.id, handle);
  }

  /**
   * 执行 Timer 任务
   * 1. 检查会话配置是否存在
   * 2. 如果有活跃会话 → 降级到 task 队列
   * 3. 如果无活跃会话 → 创建新 session 执行
   */
  private async executeJob(job: ITimerJob): Promise<void> {
    // 标记为已触发
    job.fired = true;
    saveTimerJobs(this.dc, this.jobs);

    // 检查会话配置是否存在
    const convCfg = this.dc.config.conversations.find(c => c.conversationId === job.conversationId);
    if (!convCfg) {
      console.log(`[${timestamp()}] Timer 任务 ${job.id} 的会话 ${job.conversationId} 已不存在，跳过`);
      return;
    }

    // 检查是否有活跃会话
    const activeEntry = findActiveSession(this.dc, job.conversationId);
    if (activeEntry) {
      // 有活跃会话 → 降级到 task 队列
      console.log(`[${timestamp()}] Timer ${job.id}: 会话活跃中，降级到 task 队列`);
      await saveTask(this.dc, {
        conversationId: job.conversationId,
        prompt: this.buildTimerPrompt(job),
        senderStaffId: job.senderStaffId,
        senderNickName: job.senderNick,
        sessionWebhook: convCfg.dingToken ? '' : '', // task 会使用自己的 webhook 逻辑
        type: 'cron',
      });
      // 通知用户
      await sendDingMessage(this.dc, {
        conversationId: job.conversationId,
        sessionWebhook: convCfg.dingToken || '',
        atUserId: job.senderStaffId,
        content: `⏰ 定时提醒触发: ${job.description}\n已加入任务队列，完成后通知你`,
      }).catch(() => {});
    } else {
      // 无活跃会话 → 创建新 session 并执行 Claude 查询
      console.log(`[${timestamp()}] Timer ${job.id}: 无活跃会话，创建新 session 执行`);
      const now = Date.now();
      const session: ISession = {
        conversationId: job.conversationId,
        sessionWebhook: convCfg.dingToken || '',
        startTime: now,
        startTimeStr: new Date(now).toISOString().replace(/[:.]/g, '-'),
        startStaffId: job.senderStaffId,
        startNickName: job.senderNick,
      };

      try {
        await executeClaudeQuery(this.dc, session, this.buildTimerPrompt(job), {
          senderNick: job.senderNick,
          senderStaffId: job.senderStaffId,
          permissionMode: convCfg.permissionMode,
          conversationConfig: {
            qaMode: convCfg.qaMode,
            qaCfg: convCfg.qaCfg,
          },
        });
        console.log(`[${timestamp()}] Timer ${job.id} 执行完成`);
      } catch (err) {
        console.error(`[${timestamp()}] Timer ${job.id} 执行失败:`, err);
        await sendDingMessage(this.dc, {
          conversationId: job.conversationId,
          sessionWebhook: convCfg.dingToken || '',
          atUserId: job.senderStaffId,
          content: `⏰ 定时提醒触发: ${job.description}\n但执行失败: ${err instanceof Error ? err.message : String(err)}`,
        }).catch(() => {});
      }
    }
  }

  /**
   * 构建 Timer 执行的 prompt
   */
  private buildTimerPrompt(job: ITimerJob): string {
    return `[系统] 这是一个定时提醒通知，不是新的用户指令。
用户 ${job.senderNick} 在 ${job.createdAt} 设置了 ${formatDelay(job.delayMs)} 后的提醒，现在时间已到。
提醒内容: ${job.prompt}

请直接用简短友好的方式通知用户该提醒内容，不要创建新的定时任务、日历事件或其他操作。`;
  }
}
