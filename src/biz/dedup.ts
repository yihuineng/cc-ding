/**
 * 四层消息去重机制
 *
 * 解决以下生产环境问题：
 * 1. WebSocket 重连后同一条消息被重复投递
 * 2. 进程重启后钉钉缓冲区回放历史消息
 * 3. 钉钉客户端抖动（同一用户快速双击发送）
 * 4. 会话维度消息时序不一致（旧消息乱序处理）
 */

// ==================== 模块级常量 ====================

/** 进程启动时间，用于旧消息判断 */
const PROCESS_START_TIME = Date.now();
/** 旧消息宽限时间（ms），早于 PROCESS_START_TIME - GRACE 的消息丢弃 */
const OLD_MESSAGE_GRACE_MS = 2_000;

// ==================== MessageDedup：基于 msgId 的精确去重 ====================

/** 存储 msgId → 时间戳，Map 自动保证 O(1) 查找 */
const seenMessages = new Map<string, number>();
/** TTL 默认 60 秒 */
const MESSAGE_DEDUP_TTL = 60_000;
/** 触发懒清理的阈值 */
const MESSAGE_DEDUP_LAZY_THRESHOLD = 1_000;

export interface MessageDedup {
  /**
   * 检查消息是否重复
   * @param msgId 钉钉消息ID
   * @returns true=重复（已处理过），false=首次见
   */
  isDuplicate(msgId: string): boolean;
}

function cleanupExpiredMessages(): void {
  const now = Date.now();
  for (const [ msgId, ts ] of seenMessages) {
    if (now - ts > MESSAGE_DEDUP_TTL) {
      seenMessages.delete(msgId);
    }
  }
}

/** 基于 msgId 的精确去重器 */
export const messageDedup: MessageDedup = {
  isDuplicate(msgId: string): boolean {
    // 空 msgId 不拦截（避免误杀）
    if (!msgId) return false;

    if (seenMessages.has(msgId)) {
      return true;
    }

    seenMessages.set(msgId, Date.now());

    // 超过阈值时触发懒清理
    if (seenMessages.size > MESSAGE_DEDUP_LAZY_THRESHOLD) {
      cleanupExpiredMessages();
    }

    return false;
  },
};

// ==================== BounceDedup：钉钉抖动去重 ====================

/** 存储 "senderStaffId:conversationId:contentHash" → 时间戳 */
const bounceRecords = new Map<string, number>();
/** 抖动窗口默认 5 秒 */
const BOUNCE_WINDOW_MS = 5_000;
/** Bounce 记录最大数量 */
const BOUNCE_MAX_ENTRIES = 500;

/** 简单的字符串 hash（用于 content 去重 key） */
function simpleHash(str: string): string {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h) + str.charCodeAt(i);
    h |= 0;
  }
  return h.toString(36);
}

export interface BounceDedup {
  /**
   * 检查是否为抖动消息
   * @param senderStaffId 发送者 staffId
   * @param conversationId 会话ID
   * @param content 消息内容
   * @returns true=抖动（短时间重复），false=正常
   */
  isBounce(senderStaffId: string, conversationId: string, content: string): boolean;
}

function cleanupExpiredBounce(): void {
  const now = Date.now();
  for (const [ key, ts ] of bounceRecords) {
    if (now - ts > BOUNCE_WINDOW_MS) {
      bounceRecords.delete(key);
    }
  }
}

/** 钉钉抖动去重器 */
export const bounceDedup: BounceDedup = {
  isBounce(senderStaffId: string, conversationId: string, content: string): boolean {
    // 空内容不拦截
    if (!content) return false;

    const hash = simpleHash(content.trim());
    const key = `${senderStaffId}:${conversationId}:${hash}`;
    const now = Date.now();

    if (bounceRecords.has(key)) {
      const lastTime = bounceRecords.get(key)!;
      if (now - lastTime < BOUNCE_WINDOW_MS) {
        return true;
      }
    }

    bounceRecords.set(key, now);

    // 超过最大数量时触发清理
    if (bounceRecords.size > BOUNCE_MAX_ENTRIES) {
      cleanupExpiredBounce();
    }

    return false;
  },
};

// ==================== isOldMessage：旧消息判断 ====================

/**
 * 判断消息是否为旧消息（进程启动前的消息）
 * @param createdAt 消息创建时间戳（毫秒）
 * @returns true=旧消息（应丢弃），false=正常
 */
export function isOldMessage(createdAt: number): boolean {
  if (!createdAt || createdAt <= 0) return false;
  return createdAt < PROCESS_START_TIME - OLD_MESSAGE_GRACE_MS;
}

/** 导出进程启动时间供外部使用（如日志） */
export { PROCESS_START_TIME };

// ==================== UserMessageWatermark：会话维度时序水印 ====================

/** 单个会话的三层水印 */
interface Watermark {
  /** 已处理完成的最大时间戳 */
  completed: number;
  /** 正在处理中的最大时间戳 */
  inFlight: number;
  /** 排队中消息的最大时间戳 */
  queued: number;
}

/** conversationId -> Watermark 映射 */
const watermarks = new Map<string, Watermark>();

export interface UserMessageWatermark {
  /**
   * 判断消息时序是否过期（乱序的旧消息）
   * @param conversationId 会话ID
   * @param createdAt 消息创建时间戳
   * @param state 当前阶段：'queue'(入队时) | 'drain'(出队时) | 'process'(直接处理前)
   * @returns true=时序过期（不应处理），false=时序正常
   */
  isExpired(conversationId: string, createdAt: number, state: 'queue' | 'drain' | 'process'): boolean;

  /**
   * 更新会话水印（消息处理完成后调用）
   * @param conversationId 会话ID
   * @param createdAt 消息创建时间戳
   */
  markCompleted(conversationId: string, createdAt: number): void;

  /**
   * 标记消息进入处理中状态（出队时调用）
   * @param conversationId 会话ID
   * @param createdAt 消息创建时间戳
   */
  markInFlight(conversationId: string, createdAt: number): void;

  /**
   * 标记消息入队（排队时调用）
   * @param conversationId 会话ID
   * @param createdAt 消息创建时间戳
   */
  markQueued(conversationId: string, createdAt: number): void;

  /**
   * 获取会话当前水印状态（用于调试/日志）
   */
  getWatermark(conversationId: string): Watermark | undefined;

  /**
   * 清除会话水印（会话结束/切换时调用）
   */
  clearWatermark(conversationId: string): void;
}

/** 会话维度时序水印 */
export const userMessageWatermark: UserMessageWatermark = {
  isExpired(conversationId: string, createdAt: number, state: 'queue' | 'drain' | 'process'): boolean {
    if (!createdAt || createdAt <= 0) return false;

    const wm = watermarks.get(conversationId);
    if (!wm) return false;

    // 根据阶段检查是否明显落后于已完成的消息
    switch (state) {
      case 'queue':
        // 入队时：如果比已完成的消息还旧很多（超过30秒），可能是重放
        return createdAt < wm.completed - 30_000;
      case 'drain':
        // 出队时：如果比正在处理的消息还旧，说明是重放
        return createdAt < wm.inFlight - 10_000;
      case 'process':
        // 直接处理前：如果比最近处理的旧很多，跳过
        return createdAt < wm.completed - 15_000;
    }
  },

  markCompleted(conversationId: string, createdAt: number): void {
    const wm = watermarks.get(conversationId);
    if (wm) {
      wm.completed = Math.max(wm.completed, createdAt);
    }
  },

  markInFlight(conversationId: string, createdAt: number): void {
    const wm = watermarks.get(conversationId);
    if (wm) {
      wm.inFlight = Math.max(wm.inFlight, createdAt);
    }
  },

  markQueued(conversationId: string, createdAt: number): void {
    let wm = watermarks.get(conversationId);
    if (!wm) {
      wm = { completed: 0, inFlight: 0, queued: 0 };
      watermarks.set(conversationId, wm);
    }
    wm.queued = Math.max(wm.queued, createdAt);
  },

  getWatermark(conversationId: string): Watermark | undefined {
    return watermarks.get(conversationId);
  },

  clearWatermark(conversationId: string): void {
    watermarks.delete(conversationId);
  },
};

// ==================== 模块级水印清理（防止内存泄漏） ====================

// 每 5 分钟清理长时间无活动的会话水印
setInterval(() => {
  const now = Date.now();
  const MAX_IDLE_MS = 5 * 60 * 1_000; // 5 分钟
  for (const [ convId, wm ] of watermarks) {
    if (wm.completed > 0 && now - wm.completed > MAX_IDLE_MS) {
      watermarks.delete(convId);
    }
  }
}, 5 * 60 * 1_000);

// ==================== 测试用重置函数 ====================

/**
 * 重置所有去重器状态（仅用于测试环境）
 */
export function resetAllDedup(): void {
  seenMessages.clear();
  bounceRecords.clear();
  watermarks.clear();
}
