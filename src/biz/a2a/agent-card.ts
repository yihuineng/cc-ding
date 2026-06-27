import type { IAgentCard, IA2AConfig } from './types';
import type { DingClaude } from '../cc-ding-cli';

export function generateAgentCard(self: DingClaude, config: IA2AConfig): IAgentCard {
  const baseUrl = config.baseUrl || `http://localhost:${config.port ?? 3000}`;
  const name = self.config.clientName || 'cc-ding';

  return {
    name,
    description: `DingTalk AI bot (${name})`,
    url: baseUrl,
    version: require('../../../package.json').version,
    capabilities: {
      streaming: false,
    },
    securitySchemes: config.apiKey ? [{
      apiKey: {
        type: 'apiKey',
        in: 'header',
        name: 'X-API-Key',
      },
    }] : undefined,
    skills: [{
      id: 'agent-query',
      name: 'Agent Query',
      description: 'Execute an AI query in a DingTalk group context',
      tags: [ 'ai', 'agent', 'chat' ],
      inputMode: [ 'text' ],
      outputMode: [ 'text' ],
    }],
  };
}
