import { IAgent } from './agent';
import { ClaudeAgent } from './claude-agent';
import { CodexAgent } from './codex-agent';

export function createAgent(type: string): IAgent {
  if (type === 'claude') return new ClaudeAgent();
  if (type === 'codex') return new CodexAgent();
  throw new Error(`Unknown agent type: ${type}`);
}

export function listAgentTypes(): string[] {
  return [ 'claude', 'codex' ];
}
