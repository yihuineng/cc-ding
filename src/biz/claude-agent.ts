import { IAgent, IAgentQueryOpts } from './agent';
import type { DingClaude } from './cc-ding-cli';
import type { ISession, IActiveSession } from './types';
import { executeClaudeQuery, interruptClaudeProcess } from './claude-process';

export class ClaudeAgent implements IAgent {
  readonly type = 'claude';

  async executeQuery(dc: DingClaude, session: ISession, opts: IAgentQueryOpts): Promise<void> {
    const convCfg = dc.getConversationConfig(session.conversationId);
    return executeClaudeQuery(dc, session, opts.message, {
      skill: opts.skill,
      senderNick: opts.senderNick,
      senderStaffId: opts.senderStaffId,
      newSessionId: opts.newSessionId,
      permissionMode: convCfg?.permissionMode,
      model: convCfg?.model || dc.config.model,
    });
  }

  interrupt(activeSession: IActiveSession, reason: string): boolean {
    return interruptClaudeProcess(activeSession, reason);
  }

  getEntryCommand(): string {
    return 'claude';
  }
}
