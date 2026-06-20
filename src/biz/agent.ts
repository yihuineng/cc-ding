import type { ISession, IActiveSession } from './types';
import type { DingClaude } from './cc-ding-cli';

export interface IAgentQueryOpts {
  message: string;
  skill?: string;
  agent?: string;       // Claude --agent 参数
  model?: string;
  senderNick?: string;
  senderStaffId?: string;
  rawMessage?: boolean; // 是否不附加发送人前缀（Codex 需要）
  newSessionId?: string;
  permissionMode?: string; // 仅 Claude Agent 使用
}

export interface IAgent {
  readonly type: string; // 'claude' | 'codex'
  executeQuery(dc: DingClaude, session: ISession, opts: IAgentQueryOpts): Promise<void>;
  interrupt(activeSession: IActiveSession, reason: string): boolean;
  getEntryCommand(): string;
}
