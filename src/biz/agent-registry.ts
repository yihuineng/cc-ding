import { IAgent } from './agent';
import { ClaudeAgent } from './claude-agent';
import { CodexAgent } from './codex-agent';

const AGENT_REGISTRY: Map<string, IAgent> = new Map();
AGENT_REGISTRY.set('claude', new ClaudeAgent());
AGENT_REGISTRY.set('codex', new CodexAgent());

export function createAgent(type: string): IAgent {
  const agent = AGENT_REGISTRY.get(type);
  if (!agent) throw new Error(`Unknown agent type: ${type}`);
  return agent;
}

export function listAgentTypes(): string[] {
  return Array.from(AGENT_REGISTRY.keys());
}
