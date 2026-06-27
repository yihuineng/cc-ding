import type { IRemoteAgent } from './a2a/types';

export type A2ACommand =
  | { type: 'list' }
  | { type: 'agents' }
  | { type: 'info'; agentId: string }
  | { type: 'send'; agentId: string; message: string }
  | { type: 'status'; agentId: string; taskId: string }
  | { type: 'cancel'; agentId: string; taskId: string }
  | { type: 'discover'; url: string };

/**
 * Parse /a2a command
 *   /a2a list
 *   /a2a info <id>
 *   /a2a send <id> <message>
 *   /a2a status <id> <taskId>
 *   /a2a cancel <id> <taskId>
 *   /a2a discover <url>
 */
export function parseA2ACommand(text: string): A2ACommand | null {
  const trimmed = text.trim();
  if (!/^\/a2a(\b|$)/i.test(trimmed)) return null;

  const rest = trimmed.substring(4).trim();
  if (!rest) return { type: 'list' };

  const parts = rest.split(/\s+/);
  const sub = parts[0].toLowerCase();

  switch (sub) {
    case 'list':
    case 'ls':
      return { type: 'list' };
    case 'agents':
      return { type: 'agents' };
    case 'info':
      return parts[1] ? { type: 'info', agentId: parts[1] } : null;
    case 'send':
      if (parts[1] && parts.slice(2).join(' ')) {
        return { type: 'send', agentId: parts[1], message: parts.slice(2).join(' ') };
      }
      return null;
    case 'status':
      return (parts[1] && parts[2]) ? { type: 'status', agentId: parts[1], taskId: parts[2] } : null;
    case 'cancel':
      return (parts[1] && parts[2]) ? { type: 'cancel', agentId: parts[1], taskId: parts[2] } : null;
    case 'discover':
      return parts[1] ? { type: 'discover', url: parts[1] } : null;
    default:
      return null;
  }
}

export function formatAgentList(agents: IRemoteAgent[]): string {
  if (!agents.length) return '未配置远端 Agent\n\n在 config.json 的 a2aCfg.remoteAgents 中添加';

  const lines: string[] = [ '**本地配置的远端 Agent**', '' ];
  for (const a of agents) {
    lines.push(`- **${a.id}**: ${a.name}`);
    lines.push(`  - URL: \`${a.baseUrl}\``);
  }
  return lines.join('\n');
}

export function formatHubAgents(agents: Array<{ id: string; name: string; description?: string; status: string; baseUrl: string }>): string {
  if (!agents.length) return 'Hub 上暂无已注册 Agent';

  const lines: string[] = [ '**Hub 已注册 Agent**', '' ];
  for (const a of agents) {
    const statusIcon = a.status === 'online' ? '🟢' : '⚫';
    lines.push(`- ${statusIcon} **${a.id}**: ${a.name}`);
    if (a.description) lines.push(`  - 描述: ${a.description}`);
    lines.push(`  - URL: \`${a.baseUrl}\``);
  }
  return lines.join('\n');
}

export function formatAgentInfo(agent: IRemoteAgent, card?: Record<string, unknown>): string {
  const lines = [
    `**Agent: ${agent.name}**`,
    '',
    `- **ID:** ${agent.id}`,
    `- **URL:** \`${agent.baseUrl}\``,
  ];
  if (card) {
    lines.push(`- **描述:** ${card.description || ''}`);
    lines.push(`- **版本:** ${card.version || ''}`);
    if (Array.isArray(card.skills)) {
      lines.push(`- **Skills:** ${(card.skills as Array<{ name?: string }>).map(s => s.name).join(', ')}`);
    }
  }
  return lines.join('\n');
}

export function formatTaskStatus(taskId: string, state: string, message?: string): string {
  const stateMap: Record<string, string> = {
    submitted: '⏳ 已提交',
    working: '🔄 处理中',
    completed: '✅ 已完成',
    failed: '❌ 失败',
    canceled: '⛔ 已取消',
    'input-required': '📝 需要输入',
  };
  const label = stateMap[state] || state;
  let text = `**任务状态**\n\n**ID:** ${taskId}\n**状态:** ${label}`;
  if (message) text += `\n**消息:** ${message}`;
  return text;
}
