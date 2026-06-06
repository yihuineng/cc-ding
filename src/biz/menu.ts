import fs from 'fs';
import { dateUtil } from 'utils-ok';
import { DingClaude } from './cc-ding-cli';
import { getClientDir, timestamp } from './session';

// ==================== Types ====================

export interface IMenuItem {
  id: string;
  label: string;
  command: string;
  createdAt: string;
}

export interface IMenuData {
  global: IMenuItem[];
  user: Record<string, IMenuItem[]>; // key: "{conversationId}:{staffId}"
  triggers?: Record<string, string>; // key: staffId, value: 自定义触发词
}

export interface IMenuPendingSelection {
  staffId: string;
  conversationId: string;
  sessionWebhook: string;
  mergedItems: IMenuItem[];
  createdAt: number;
}

// ==================== Persistence ====================

function getMenuFile(dc: DingClaude): string {
  return `${getClientDir(dc)}/menu.json`;
}

export function loadMenuData(dc: DingClaude): IMenuData {
  const file = getMenuFile(dc);
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return {
      global: Array.isArray(data.global) ? data.global : [],
      user: data.user && typeof data.user === 'object' ? data.user : {},
      triggers: data.triggers && typeof data.triggers === 'object' ? data.triggers : {},
    };
  } catch {
    return { global: [], user: {}, triggers: {} };
  }
}

function saveMenuData(dc: DingClaude, data: IMenuData): void {
  const file = getMenuFile(dc);
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
}

// ==================== Pending Selection State ====================

const pendingSelections = new Map<string, IMenuPendingSelection>();
const SELECTION_TIMEOUT_MS = 60_000;

function getPendingKey(conversationId: string, staffId: string): string {
  return `${conversationId}:${staffId}`;
}

export function setPendingSelection(
  conversationId: string, staffId: string,
  sessionWebhook: string, mergedItems: IMenuItem[],
): void {
  pendingSelections.set(getPendingKey(conversationId, staffId), {
    staffId, conversationId, sessionWebhook, mergedItems, createdAt: Date.now(),
  });
}

export function getPendingSelection(conversationId: string, staffId: string): IMenuPendingSelection | undefined {
  return pendingSelections.get(getPendingKey(conversationId, staffId));
}

export function clearPendingSelection(conversationId: string, staffId: string): void {
  pendingSelections.delete(getPendingKey(conversationId, staffId));
}

export function hasPendingSelection(conversationId: string, staffId: string): boolean {
  const pending = pendingSelections.get(getPendingKey(conversationId, staffId));
  if (!pending) return false;
  if (Date.now() - pending.createdAt > SELECTION_TIMEOUT_MS) {
    pendingSelections.delete(getPendingKey(conversationId, staffId));
    return false;
  }
  return true;
}

export function startSelectionCleanupTimer(): void {
  setInterval(() => {
    const now = Date.now();
    for (const [ key, val ] of pendingSelections) {
      if (now - val.createdAt > SELECTION_TIMEOUT_MS) {
        pendingSelections.delete(key);
      }
    }
  }, 15_000);
}

// ==================== Trigger Word ====================

export function getUserTrigger(dc: DingClaude, staffId: string): string {
  const data = loadMenuData(dc);
  return data.triggers?.[staffId] || 'cc';
}

export function setUserTrigger(dc: DingClaude, staffId: string, trigger: string): void {
  const data = loadMenuData(dc);
  if (!data.triggers) data.triggers = {};
  data.triggers[staffId] = trigger;
  saveMenuData(dc, data);
}

export function getAllTriggerWords(dc: DingClaude): Set<string> {
  const data = loadMenuData(dc);
  const words = new Set<string>([ 'cc' ]);
  if (data.triggers) {
    for (const t of Object.values(data.triggers)) {
      if (t) words.add(t.toLowerCase());
    }
  }
  return words;
}

// ==================== Menu Key ====================

function getUserMenuKey(conversationId: string, staffId: string): string {
  return `${conversationId}:${staffId}`;
}

// ==================== CRUD ====================

function generateId(): string {
  return `m_${Date.now().toString(36)}`;
}

export function getMergedMenu(dc: DingClaude, conversationId: string, staffId: string): IMenuItem[] {
  const data = loadMenuData(dc);
  const userKey = getUserMenuKey(conversationId, staffId);
  const userItems = data.user[userKey] || [];
  return [ ...data.global, ...userItems ];
}

export function addMenuItem(
  dc: DingClaude, conversationId: string, staffId: string,
  isOwner: boolean, label: string, command: string,
): IMenuItem {
  const data = loadMenuData(dc);
  const finalLabel = label.trim() || command.trim().substring(0, 20);
  const item: IMenuItem = {
    id: generateId(),
    label: finalLabel,
    command: command.trim(),
    createdAt: dateUtil.mm().format('YYYY-MM-DD HH:mm:ss'),
  };

  if (isOwner) {
    data.global.push(item);
  } else {
    const key = getUserMenuKey(conversationId, staffId);
    if (!data.user[key]) data.user[key] = [];
    data.user[key].push(item);
  }

  saveMenuData(dc, data);
  console.log(`[${timestamp()}] [menu] 添加菜单: ${isOwner ? '全局' : '个人'} label=${item.label} id=${item.id}`);
  return item;
}

export function deleteMenuItem(
  dc: DingClaude, conversationId: string, staffId: string,
  isOwner: boolean, indexStr: string,
): { success: boolean; deletedItem?: IMenuItem; error?: string } {
  const data = loadMenuData(dc);
  const index = parseInt(indexStr, 10);

  if (isOwner) {
    if (isNaN(index) || index < 1 || index > data.global.length) {
      return { success: false, error: `序号无效，全局菜单共 ${data.global.length} 项` };
    }
    const [ deleted ] = data.global.splice(index - 1, 1);
    saveMenuData(dc, data);
    console.log(`[${timestamp()}] [menu] 删除全局菜单: label=${deleted.label} id=${deleted.id}`);
    return { success: true, deletedItem: deleted };
  }

  const key = getUserMenuKey(conversationId, staffId);
  const userItems = data.user[key] || [];
  if (isNaN(index) || index < 1 || index > userItems.length) {
    return { success: false, error: `序号无效，个人菜单共 ${userItems.length} 项` };
  }
  const [ deleted ] = userItems.splice(index - 1, 1);
  if (userItems.length === 0) {
    delete data.user[key];
  }
  saveMenuData(dc, data);
  console.log(`[${timestamp()}] [menu] 删除个人菜单: label=${deleted.label} id=${deleted.id}`);
  return { success: true, deletedItem: deleted };
}

// ==================== Formatting ====================

export function formatMenuDisplay(items: IMenuItem[], globalCount: number): string {
  if (items.length === 0) {
    return '📭 暂无快捷指令\n\n💡 使用 `/menu add <指令>` 添加';
  }

  const parts: string[] = [ '### 📋 快捷指令', '' ];

  if (globalCount > 0) {
    parts.push('🌐 **全局**');
    for (let i = 0; i < globalCount; i++) {
      parts.push(`${i + 1}. ${items[i].label}`);
    }
  }

  if (items.length > globalCount) {
    if (globalCount > 0) parts.push('');
    parts.push('👤 **我的**');
    for (let i = globalCount; i < items.length; i++) {
      parts.push(`${i + 1}. ${items[i].label}`);
    }
  }

  parts.push('', '---', '💡 回复序号执行 (60s) | `/menu add/del/list` 管理');
  return parts.join('\n');
}

export function formatMenuList(dc: DingClaude, conversationId: string, staffId: string, isGlobal: boolean): string {
  const data = loadMenuData(dc);
  const parts: string[] = [];

  if (isGlobal) {
    parts.push('### 📋 全局快捷指令管理', '');
    if (data.global.length > 0) {
      for (let i = 0; i < data.global.length; i++) {
        parts.push(`${i + 1}. **${data.global[i].label}** → \`${data.global[i].command}\``);
      }
    } else {
      parts.push('📭 暂无全局菜单项，使用 `/menu -g add <指令>` 添加');
    }
  } else {
    parts.push('### 📋 个人快捷指令管理', '');
    const key = getUserMenuKey(conversationId, staffId);
    const userItems = data.user[key] || [];
    if (userItems.length > 0) {
      for (let i = 0; i < userItems.length; i++) {
        parts.push(`${i + 1}. **${userItems[i].label}** → \`${userItems[i].command}\``);
      }
    } else {
      parts.push('📭 暂无个人菜单项，使用 `/menu add <指令>` 添加');
    }
    parts.push('');
    const trigger = getUserTrigger(dc, staffId);
    parts.push(`当前触发词: \`${trigger}\` (使用 \`/menu trigger <词>\` 修改)`);
  }

  return parts.join('\n');
}
