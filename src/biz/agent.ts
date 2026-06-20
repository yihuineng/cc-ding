import type { ISession, IActiveSession } from './types';
import type { DingClaude } from './cc-ding-cli';

/**
 * Agent 查询参数：只包含无法从会话上下文自动派生的字段。
 * agent、model、permissionMode 等由各 Agent 实现从 conversationConfig 自动读取。
 */
export interface IAgentQueryOpts {
  message: string;
  skill?: string;
  senderNick?: string;
  senderStaffId?: string;
  rawMessage?: boolean; // 是否不附加发送人前缀（Codex 需要）
  newSessionId?: string;
}

export interface IAgent {
  readonly type: string; // 'claude' | 'codex'
  executeQuery(dc: DingClaude, session: ISession, opts: IAgentQueryOpts): Promise<void>;
  interrupt(activeSession: IActiveSession, reason: string): boolean;
  getEntryCommand(): string;
}
