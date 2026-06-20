import type { DingClaude } from './cc-ding-cli';
import type { IActiveSession, ISession } from './types';
import { sendDingMessage } from './messaging';
import { getReplyConversationId, getReplyWebhook } from './session';

const CHECK_INTERVAL_MS = 30 * 1000;
const DEFAULT_MAX_AUTO_RECOVERY = 2;

export interface IWatchdogOpts {
  /** 超时发生时终止子进程 */
  killChild: () => void;
  /** 超时通知消息（支持 ${timeoutSec} ${attempts} ${maxAutoRecovery} 占位符） */
  onTimeout: (attempts: number, maxAutoRecovery: number, timeoutSec: number) => void;
  /** 恢复失败通知消息 */
  onRecoveryFailed: (maxAutoRecovery: number) => void;
}

/**
 * Agent 进程看门狗：定期检查进程是否长时间无活动，
 * 超时则自动 kill + 发送恢复通知，支持有限次数的自动恢复。
 */
export class AgentWatchdog {
  private timer: ReturnType<typeof setInterval> | null = null;
  private settled = false;
  private startTime: number;

  constructor(
    private dc: DingClaude,
    private session: ISession,
    private activeSession: IActiveSession | undefined,
    private opts: IWatchdogOpts,
    startTime?: number,
  ) {
    this.startTime = startTime ?? Date.now();
  }

  start() {
    const convCfg = this.dc.getConversationConfig(this.session.conversationId);
    const timeoutMs = ((convCfg?.maxTurnTimeMins ?? this.dc.config.maxTurnTimeMins) || 5) * 60 * 1000;
    const maxAutoRecovery = this.dc.config.maxAutoRecovery ?? DEFAULT_MAX_AUTO_RECOVERY;

    this.timer = setInterval(() => {
      if (this.settled) { this.stop(); return; }
      const lastActivity = this.activeSession?.lastActivityTime ?? this.startTime;
      const elapsed = Date.now() - lastActivity;
      if (elapsed >= timeoutMs) {
        this.stop();
        const attempts = this.activeSession?.autoRecoveryAttempts ?? 0;
        const timeoutSec = Math.round(timeoutMs / 1000);
        if (this.activeSession && attempts < maxAutoRecovery) {
          this.activeSession.autoRecoveryAttempts = attempts + 1;
          this.activeSession.goonPending = true;
          this.activeSession.interrupted = true;
          this.opts.killChild();
          this.opts.onTimeout(attempts, maxAutoRecovery, timeoutSec);
        } else {
          this.opts.onRecoveryFailed(maxAutoRecovery);
        }
      }
    }, CHECK_INTERVAL_MS);
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  markSettled() {
    this.settled = true;
  }

  get isSettled(): boolean {
    return this.settled;
  }
}

/**
 * 默认超时通知：发送钉钉消息告知自动恢复中
 */
export function defaultWatchdogOnTimeout(
  dc: DingClaude,
  session: ISession,
  attempts: number,
  maxAutoRecovery: number,
  timeoutSec: number,
  entryCommand: string,
): void {
  sendDingMessage(dc, {
    conversationId: getReplyConversationId(session),
    sessionWebhook: getReplyWebhook(session),
    atUserId: session.startStaffId,
    content: ` ${entryCommand} 进程超时 (${timeoutSec}s 无活动)，自动恢复中 (${attempts + 1}/${maxAutoRecovery})...`,
  }).catch(() => {});
}

/**
 * 默认恢复失败通知
 */
export function defaultWatchdogOnRecoveryFailed(
  dc: DingClaude,
  session: ISession,
  maxAutoRecovery: number,
  entryCommand: string,
): void {
  sendDingMessage(dc, {
    conversationId: getReplyConversationId(session),
    sessionWebhook: getReplyWebhook(session),
    atUserId: session.startStaffId,
    content: `⏰ ${entryCommand} 进程已连续 ${maxAutoRecovery} 次超时自动恢复失败，请发送 /goon 手动恢复或 /new 开始新会话`,
  }).catch(() => {});
}
