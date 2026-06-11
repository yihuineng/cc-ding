import fs from 'fs';
import { dateUtil } from 'utils-ok';
import type { DingClaude } from './cc-ding-cli';
import { getClientDir, timestamp } from './session';
import { sendDingMessage } from './messaging';

// ==================== 数据结构 ====================

/** ID 类型：工号(staffId) 或 钉钉用户ID(dingtalkId) */
export type IdMode = 'staffId' | 'dingtalkId';

/** 单条待办项 */
export interface ITodoItem {
  content: string;            // 待办内容
  assigneeStaffId: string;   // 负责人ID（根据 idMode 可能是 staffId 或 dingtalkId）
  assigneeNick: string;       // 负责人昵称
  /** 该条待办使用的 ID 类型，历史数据默认 'staffId' */
  assigneeIdType?: IdMode;
  deadline: string;           // "YYYY-MM-DD"
  createdAt: string;          // "YYYY-MM-DD HH:mm:ss"
  completed: boolean;
  completedAt?: string;
}

/** 持久化数据结构 */
export interface ITodoData {
  /** 按会话ID分组的待办列表 */
  conversations: Record<string, ITodoItem[]>;
  /** 按会话ID存储提醒配置 */
  reminders: Record<string, boolean | number>; // true=默认10点, false=关闭, number=整点小时(0-23)
  /** 按会话ID存储用户选择的 ID 模式 */
  idModes: Record<string, IdMode>;
}

// ==================== 持久化 ====================

function getTodoFile(dc: DingClaude): string {
  return `${getClientDir(dc)}/todo.json`;
}

export function loadTodoData(dc: DingClaude): ITodoData {
  const file = getTodoFile(dc);
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const data = JSON.parse(raw);
    return {
      conversations: data.conversations && typeof data.conversations === 'object' ? data.conversations : {},
      reminders: data.reminders && typeof data.reminders === 'object' ? data.reminders : {},
      idModes: data.idModes && typeof data.idModes === 'object' ? data.idModes : {},
    };
  } catch {
    return { conversations: {}, reminders: {}, idModes: {} };
  }
}

function saveTodoData(dc: DingClaude, data: ITodoData): void {
  const file = getTodoFile(dc);
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
}

// ==================== CRUD 操作 ====================

/** 排序待办列表（进行中按DDL排前，已完成排后） */
function sortTodoItems(items: ITodoItem[]): ITodoItem[] {
  const active = items.filter(i => !i.completed).sort(todoSortByDeadline);
  const done = items.filter(i => i.completed).sort((a, b) => {
    // 已完成按完成时间倒序
    return (b.completedAt || '').localeCompare(a.completedAt || '');
  });
  return [ ...active, ...done ];
}

/** 获取排序后的全部待办列表（进行中按DDL排前，已完成排后） */
export function getSortedTodoItems(dc: DingClaude, conversationId: string): ITodoItem[] {
  const data = loadTodoData(dc);
  return sortTodoItems(data.conversations[conversationId] || []);
}

/** 按 DDL 排序：无 DDL 排最后，有 DDL 按日期升序 */
function todoSortByDeadline(a: ITodoItem, b: ITodoItem): number {
  if (!a.deadline && !b.deadline) return 0;
  if (!a.deadline) return 1;
  if (!b.deadline) return -1;
  return a.deadline.localeCompare(b.deadline);
}

/** 添加待办项，默认 DDL 为 7 天后 */
export function addTodoItem(
  dc: DingClaude,
  conversationId: string,
  opts: {
    content: string;
    assigneeStaffId: string;
    assigneeNick: string;
    deadline: string;
    assigneeIdType?: IdMode;
  },
): ITodoItem {
  const data = loadTodoData(dc);
  if (!data.conversations[conversationId]) data.conversations[conversationId] = [];
  const item: ITodoItem = {
    content: opts.content,
    assigneeStaffId: opts.assigneeStaffId,
    assigneeNick: opts.assigneeNick,
    deadline: opts.deadline,
    createdAt: dateUtil.mm(Date.now()).format('YYYY-MM-DD HH:mm:ss'),
    completed: false,
    assigneeIdType: opts.assigneeIdType || 'staffId',
  };
  data.conversations[conversationId].push(item);
  saveTodoData(dc, data);
  console.log(`[${timestamp()}] [todo] 添加待办 in ${conversationId}: ${opts.content}`);
  return item;
}

/** 标记待办为已完成（按序号，1-based，对排序后的列表） */
export function doneTodoItem(
  dc: DingClaude,
  conversationId: string,
  index: number,
): { success: boolean; item?: ITodoItem; error?: string } {
  const data = loadTodoData(dc);
  const items = data.conversations[conversationId] || [];
  const sorted = sortTodoItems(items);
  // 从排序后的列表中找目标
  if (sorted.length === 0) return { success: false, error: '当前无待办事项' };
  if (index < 1 || index > sorted.length) return { success: false, error: `序号无效，范围 1-${sorted.length}` };

  const targetItem = sorted[index - 1];
  if (targetItem.completed) return { success: false, error: `#${index} 已完成` };

  // 在原数组中找到并更新
  const realIdx = items.findIndex(i => i.content === targetItem.content && i.createdAt === targetItem.createdAt && i.assigneeStaffId === targetItem.assigneeStaffId);
  if (realIdx === -1) return { success: false, error: `未找到待办项` };

  items[realIdx].completed = true;
  items[realIdx].completedAt = timestamp();
  saveTodoData(dc, data);
  console.log(`[${timestamp()}] [todo] 完成待办 in ${conversationId}: ${targetItem.content}`);
  return { success: true, item: targetItem };
}

/** 删除待办项（按序号，1-based，对排序后的列表） */
export function deleteTodoItem(
  dc: DingClaude,
  conversationId: string,
  index: number,
): { success: boolean; item?: ITodoItem; error?: string } {
  const data = loadTodoData(dc);
  const items = data.conversations[conversationId] || [];
  const sorted = sortTodoItems(items);
  if (sorted.length === 0) return { success: false, error: '当前无待办事项' };
  if (index < 1 || index > sorted.length) return { success: false, error: `序号无效，范围 1-${sorted.length}` };

  const targetItem = sorted[index - 1];
  // 在原数组中找到并删除
  const realIdx = items.findIndex(i => i.content === targetItem.content && i.createdAt === targetItem.createdAt && i.assigneeStaffId === targetItem.assigneeStaffId);
  if (realIdx === -1) return { success: false, error: `未找到待办项` };

  const [ removed ] = items.splice(realIdx, 1);
  if (items.length === 0) delete data.conversations[conversationId];
  saveTodoData(dc, data);
  console.log(`[${timestamp()}] [todo] 删除待办 in ${conversationId}: ${removed.content}`);
  return { success: true, item: removed };
}

/** 清空某群所有待办项 */
export function clearAllTodoItems(
  dc: DingClaude,
  conversationId: string,
): { success: boolean; count: number; error?: string } {
  const data = loadTodoData(dc);
  const items = data.conversations[conversationId] || [];
  if (items.length === 0) return { success: false, count: 0, error: '当前无待办事项' };
  const count = items.length;
  delete data.conversations[conversationId];
  saveTodoData(dc, data);
  console.log(`[${timestamp()}] [todo] 清空待办 in ${conversationId}: ${count} 条`);
  return { success: true, count };
}

// ==================== 提醒配置 ====================

/** 获取提醒整点时间（默认10点），返回 null 表示关闭 */
export function getReminderHour(dc: DingClaude, conversationId: string): number | null {
  const data = loadTodoData(dc);
  const val = data.reminders?.[conversationId];
  if (val === false) return null;       // 显式关闭
  if (typeof val === 'number') return val; // 自定义整点
  return 10; // 默认10点
}

/** 设置提醒整点时间 */
export function setReminderHour(dc: DingClaude, conversationId: string, hour: number | null): void {
  const data = loadTodoData(dc);
  if (!data.reminders) data.reminders = {};
  if (hour === null) {
    data.reminders[conversationId] = false;
  } else {
    data.reminders[conversationId] = hour;
  }
  saveTodoData(dc, data);
}

/** 获取某会话的 ID 模式，默认 'staffId' */
export function getIdMode(dc: DingClaude, conversationId: string): IdMode {
  const data = loadTodoData(dc);
  return data.idModes?.[conversationId] || 'staffId';
}

/** 设置某会话的 ID 模式 */
export function setIdMode(dc: DingClaude, conversationId: string, mode: IdMode): void {
  const data = loadTodoData(dc);
  if (!data.idModes) data.idModes = {};
  data.idModes[conversationId] = mode;
  saveTodoData(dc, data);
}

// ==================== DDL 自然语言解析 ====================

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

export function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getNextWeekday(from: Date, targetDay: number, forceNextWeek: boolean): string {
  const currentDay = from.getDay() === 0 ? 7 : from.getDay();
  let diff = targetDay - currentDay;
  if (forceNextWeek) {
    if (diff <= 0) diff += 7;
  } else {
    if (diff < 0) diff += 7;
    if (diff === 0) diff = 7;
  }
  return formatDate(addDays(from, diff));
}

/** 默认 DDL：7 天后 */
export function getDefaultDeadline(): string {
  return formatDate(addDays(new Date(), 7));
}

/**
 * 解析自然语言截止时间为 "YYYY-MM-DD" 格式
 * 支持: 明天、后天、大后天、下周一~下周日、这周五、周一~周日、
 *       2025-06-10、6/10、0610
 */
export function parseDeadline(input: string): string {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const trimmed = input.trim();

  // "YYYY-MM-DD" 或 "YYYY/MM/DD"
  const isoMatch = trimmed.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (isoMatch) {
    return `${isoMatch[1]}-${isoMatch[2].padStart(2, '0')}-${isoMatch[3].padStart(2, '0')}`;
  }

  // "MM-DD" 或 "M/D"（当年，已过则下一年）
  const mdMatch = trimmed.match(/^(\d{1,2})[-/](\d{1,2})$/);
  if (mdMatch) {
    const m = parseInt(mdMatch[1], 10);
    const d = parseInt(mdMatch[2], 10);
    let date = new Date(now.getFullYear(), m - 1, d);
    if (date < today) date = new Date(now.getFullYear() + 1, m - 1, d);
    return formatDate(date);
  }

  // "MMDD" 四位数字简写
  const mmddMatch = trimmed.match(/^(\d{2})(\d{2})$/);
  if (mmddMatch) {
    const m = parseInt(mmddMatch[1], 10);
    const d = parseInt(mmddMatch[2], 10);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      let date = new Date(now.getFullYear(), m - 1, d);
      if (date < today) date = new Date(now.getFullYear() + 1, m - 1, d);
      return formatDate(date);
    }
  }

  // 中文自然语言
  const dayMap: Record<string, number> = {
    '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 7, '天': 7,
  };

  if (trimmed === '今天') return formatDate(today);
  if (trimmed === '明天') return formatDate(addDays(today, 1));
  if (trimmed === '后天') return formatDate(addDays(today, 2));
  if (trimmed === '大后天') return formatDate(addDays(today, 3));

  const weekMatch = trimmed.match(/^(这|下)周([一二三四五六日天])$/);
  if (weekMatch) {
    const targetDay = dayMap[weekMatch[2]];
    if (targetDay !== undefined) {
      return getNextWeekday(today, targetDay, weekMatch[1] === '下');
    }
  }

  const simpleWeekMatch = trimmed.match(/^(?:周|星期)([一二三四五六日天])$/);
  if (simpleWeekMatch) {
    const targetDay = dayMap[simpleWeekMatch[1]];
    if (targetDay !== undefined) {
      return getNextWeekday(today, targetDay, false);
    }
  }

  return '';
}

/** 计算截止时间距今的天数（负数=已逾期，0=今天） */
function getDeadlineDiffDays(deadline: string): number {
  const today = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate());
  const ddl = new Date(deadline + 'T00:00:00');
  return Math.floor((ddl.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));
}

/** 格式化截止时间显示（含逾期标记） */
export function formatDeadlineDisplay(deadline: string): string {
  if (!deadline) return '';
  const diffDays = getDeadlineDiffDays(deadline);
  if (diffDays < 0) return `${deadline} 🔴已逾期${Math.abs(diffDays)}天`;
  if (diffDays === 0) return `${deadline} ⚡今天`;
  if (diffDays === 1) return `${deadline} 🟡明天`;
  if (diffDays <= 3) return `${deadline} 🟡${diffDays}天后`;
  if (diffDays <= 7) return `${deadline} ${diffDays}天后`;
  return deadline;
}

// ==================== 格式化输出 ====================

/** 格式化待办列表（进行中按DDL排序 + 已完成排最后） */
export function formatTodoList(items: ITodoItem[], remindHour?: number | null): string {
  if (items.length === 0) {
    const remindStr = remindHour === null ? '' : `\n⏰ 每日提醒: ${remindHour}:00`;
    return `📭 暂无待办事项${remindStr}\n\n💡 \`/todo <内容> ddl 明天\` 添加（默认7天到期）`;
  }

  const activeItems = items.filter(i => !i.completed);
  const doneItems = items.filter(i => i.completed);
  const parts: string[] = [];

  if (activeItems.length > 0) {
    parts.push('### 📋 进行中', '');
    for (let i = 0; i < activeItems.length; i++) {
      const item = activeItems[i];
      const ddlStr = item.deadline ? ` 📅${formatDeadlineDisplay(item.deadline)}` : '';
      parts.push(`${i + 1}. ${item.content} _@${item.assigneeNick}_${ddlStr}`);
    }
  }

  if (doneItems.length > 0) {
    if (activeItems.length > 0) parts.push('');
    parts.push('### ✅ 已完成', '');
    for (let i = 0; i < doneItems.length; i++) {
      const item = doneItems[i];
      const idx = activeItems.length + i + 1;
      parts.push(`${idx}. ~~${item.content}~~ _@${item.assigneeNick}_`);
    }
  }

  parts.push('', '---', '💡 `/todo done <序号>` 完成 | `/todo rm <序号>` 删除 | `/todo <内容> ddl 明天`');
  if (remindHour !== undefined) {
    const remindStr = remindHour === null ? '⏰ 每日提醒: 已关闭' : `⏰ 每日提醒: ${remindHour}:00`;
    parts.push(remindStr);
  }
  return parts.join('\n');
}

/** 格式化待办项创建成功消息 */
export function formatTodoItemCreated(item: ITodoItem, index: number): string {
  const ddlStr = item.deadline ? `\n- **截止:** ${formatDeadlineDisplay(item.deadline)}` : '';
  return [
    `✅ 已添加待办 #${index}`,
    '',
    `- **内容:** ${item.content}`,
    `- **负责人:** @${item.assigneeNick}${ddlStr}`,
  ].join('\n');
}

// ==================== TodoEngine 提醒引擎 + 自动清理 ====================

/** 完成 1 天后自动清理 */
const AUTO_CLEAN_DAYS = 1;

export class TodoEngine {
  private dc: DingClaude;
  private timer: NodeJS.Timeout | null = null;

  constructor(dc: DingClaude) {
    this.dc = dc;
  }

  start(): void {
    this.scheduleNext();
    console.log(`[${timestamp()}] Todo引擎已启动`);
  }

  destroy(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNext(): void {
    const now = new Date();
    // 找到最近一个需要触发的整点（遍历所有群配置，取最近的提醒时间）
    const nextHour = this.findNextReminderHour(now);
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), nextHour, 0, 0, 0);
    if (next.getTime() <= now.getTime()) {
      next.setDate(next.getDate() + 1);
    }
    const msUntil = next.getTime() - now.getTime();

    this.timer = setTimeout(() => {
      console.log(`[${timestamp()}] [todo] 定时触发 (${nextHour}:00)`);
      this.cleanExpiredItems();
      this.sendReminders(nextHour);
      this.scheduleNext(); // 重新校准
    }, msUntil);

    console.log(`[${timestamp()}] [todo] 下次触发: ${next.toISOString()}`);
  }

  /** 找到从当前时间起下一个需要触发的整点小时 */
  private findNextReminderHour(now: Date): number {
    const currentHour = now.getHours();
    const data = loadTodoData(this.dc);
    const hours = new Set<number>();

    // 直接从已加载的数据中提取提醒时间，避免 N+1 文件读取
    for (const convId of Object.keys(data.reminders)) {
      const val = data.reminders[convId];
      if (val === false) continue;       // 显式关闭
      if (typeof val === 'number') { hours.add(val); continue; }
      hours.add(10); // 默认10点
    }

    // 如果没有配置，默认10点
    if (hours.size === 0) hours.add(10);

    // 找 >= currentHour 的最小值，否则取全天最小值（明天）
    const sorted = Array.from(hours).sort((a, b) => a - b);
    for (const h of sorted) {
      if (h > currentHour) return h;
    }
    return sorted[0]; // 今天已过，取最小的（明天触发）
  }

  /** 清理已完成超过 AUTO_CLEAN_DAYS 天的待办项 */
  private cleanExpiredItems(): void {
    const data = loadTodoData(this.dc);
    const now = Date.now();
    let totalCleaned = 0;

    for (const convId of Object.keys(data.conversations)) {
      const items = data.conversations[convId];
      const before = items.length;
      const filtered = items.filter(item => {
        if (!item.completed || !item.completedAt) return true;
        const completedTime = new Date(item.completedAt).getTime();
        if (isNaN(completedTime)) return true;
        const daysSinceCompleted = (now - completedTime) / (24 * 60 * 60 * 1000);
        return daysSinceCompleted < AUTO_CLEAN_DAYS;
      });
      if (filtered.length < before) {
        data.conversations[convId] = filtered;
        totalCleaned += before - filtered.length;
        if (filtered.length === 0) delete data.conversations[convId];
      }
    }

    if (totalCleaned > 0) {
      saveTodoData(this.dc, data);
      console.log(`[${timestamp()}] [todo] 自动清理 ${totalCleaned} 条已完成待办`);
    }
  }

  /** 向配置了当前整点提醒的群发送提醒 */
  private async sendReminders(hour: number): Promise<void> {
    const data = loadTodoData(this.dc);
    const conversationIds = Object.keys(data.conversations);

    for (const conversationId of conversationIds) {
      // 直接从已加载的数据中读取，避免 N+1 文件读取
      const reminderVal = data.reminders?.[conversationId];
      const reminderHour: number | null = reminderVal === false ? null : (typeof reminderVal === 'number' ? reminderVal : 10);
      if (reminderHour !== hour) continue; // 不是这个群的提醒时间

      const items = (data.conversations[conversationId] || []).filter(i => !i.completed);
      if (items.length === 0) continue;

      const convCfg = this.dc.getConversationConfig(conversationId);
      if (!convCfg) continue;
      if (!(convCfg.dingToken || this.dc.config.defaultDingToken || this.dc.config.ownerConversationId)) continue;

      const overdue: ITodoItem[] = [];
      const upcoming: ITodoItem[] = [];

      for (const item of items) {
        if (!item.deadline) continue;
        const diffDays = getDeadlineDiffDays(item.deadline);
        if (diffDays < 0) overdue.push(item);
        else if (diffDays <= 3) upcoming.push(item);
      }

      if (overdue.length === 0 && upcoming.length === 0) continue;

      const parts: string[] = [ '### ⏰ 每日待办提醒', '' ];
      const mentionStaffIds: string[] = [];  // 仅 staffId 类型可被 at
      let hasNonStaffIdMention = false;

      if (overdue.length > 0) {
        parts.push('🔴 **已逾期:**');
        for (const item of overdue) {
          parts.push(`- ${item.content} _@${item.assigneeNick}_ 📅${formatDeadlineDisplay(item.deadline)}`);
          if (item.assigneeIdType === 'dingtalkId') {
            hasNonStaffIdMention = true;
          } else {
            mentionStaffIds.push(item.assigneeStaffId);
          }
        }
        parts.push('');
      }

      if (upcoming.length > 0) {
        parts.push('🟡 **即将到期 (3天内):**');
        for (const item of upcoming) {
          parts.push(`- ${item.content} _@${item.assigneeNick}_ 📅${formatDeadlineDisplay(item.deadline)}`);
          if (item.assigneeIdType === 'dingtalkId') {
            hasNonStaffIdMention = true;
          } else {
            mentionStaffIds.push(item.assigneeStaffId);
          }
        }
        parts.push('');
      }

      // dingtalkId 类型的 ID 无法通过 atUserIds 字段 @ 提及，在文本中追加
      if (hasNonStaffIdMention) {
        const dingtalkIdMentions = overdue.concat(upcoming)
          .filter(i => i.assigneeIdType === 'dingtalkId')
          .map(i => `@${i.assigneeStaffId}`);
        parts.push(dingtalkIdMentions.join(' '));
        parts.push('');
      }

      parts.push('---');
      parts.push('💡 `/todo done <序号>` 完成 | `/todo` 查看全部');

      try {
        await sendDingMessage(this.dc, {
          conversationId,
          sessionWebhook: '',
          content: parts.join('\n'),
          msgType: 'markdown',
          atUserId: mentionStaffIds.length > 0 ? mentionStaffIds[0] : '',  // 仅 at 第一个 staffId 用户
        });
      } catch (err) {
        console.error(`[${timestamp()}] [todo] 发送提醒失败 ${conversationId}:`, err);
      }
    }
  }
}
