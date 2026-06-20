import { IAgent, IAgentQueryOpts } from './agent';
import type { DingClaude } from './cc-ding-cli';
import type { ISession, IActiveSession } from './types';
import { executeClaudeQuery, interruptClaudeProcess } from './claude-process';

export class ClaudeAgent implements IAgent {
  readonly type = 'claude';

  async executeQuery(dc: DingClaude, session: ISession, opts: IAgentQueryOpts): Promise<void> {
    return executeClaudeQuery(dc, session, opts.message, {
      skill: opts.skill,
      agent: opts.agent,
      senderNick: opts.senderNick,
      senderStaffId: opts.senderStaffId,
      newSessionId: opts.newSessionId,
      permissionMode: opts.permissionMode,
    });
  }

  interrupt(activeSession: IActiveSession, reason: string): boolean {
    return interruptClaudeProcess(activeSession, reason);
  }

  getEntryCommand(): string {
    return 'claude';
  }
}
