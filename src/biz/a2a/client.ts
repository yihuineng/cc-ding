import type { IRemoteAgent, IA2AMessage, IJsonRpcRequest, IJsonRpcResponse, IJsonRpcSuccessResponse } from './types';

/**
 * A2A Client for calling remote agents via JSON-RPC 2.0 (direct mode)
 */
export class A2AClient {
  private agent: IRemoteAgent;

  constructor(agent: IRemoteAgent) {
    this.agent = agent;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.agent.apiKey) h['X-API-Key'] = this.agent.apiKey;
    return h;
  }

  private async rpc(method: string, params: Record<string, unknown>, id: string): Promise<unknown> {
    const body: IJsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    const res = await fetch(`${this.agent.baseUrl}/a2a`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    const data: IJsonRpcResponse = await res.json();
    if ('error' in data && data.error) {
      throw new Error(`A2A ${data.error.message} (code: ${data.error.code})`);
    }
    return (data as IJsonRpcSuccessResponse<unknown>).result;
  }

  async sendTask(taskId: string, message: IA2AMessage, skillId?: string): Promise<unknown> {
    return this.rpc('tasks/send', {
      taskId,
      message,
      skillId: skillId || this.agent.defaultSkill || 'claude-query',
    }, taskId);
  }

  async getTaskStatus(taskId: string): Promise<unknown> {
    return this.rpc('tasks/get', { taskId }, `get-${taskId}`);
  }

  async cancelTask(taskId: string): Promise<unknown> {
    return this.rpc('tasks/cancel', { taskId }, `cancel-${taskId}`);
  }

  async getAgentCard(): Promise<unknown> {
    const res = await fetch(`${this.agent.baseUrl}/.well-known/agent.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    return res.json();
  }
}

/**
 * A2A Hub Client - calls remote agents through a centralized Hub
 */
export class HubClient {
  private hubUrl: string;
  private apiKey: string;

  constructor(hubUrl: string, apiKey: string) {
    this.hubUrl = hubUrl.replace(/\/+$/, '');
    this.apiKey = apiKey;
  }

  private headers(): Record<string, string> {
    return { 'Content-Type': 'application/json', 'X-API-Key': this.apiKey };
  }

  private async rpc(agentId: string, method: string, params: Record<string, unknown>, id: string): Promise<unknown> {
    const body: IJsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    const res = await fetch(`${this.hubUrl}/a2a/${agentId}/${method.replace('/', '')}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    const data: IJsonRpcResponse = await res.json();
    if ('error' in data && data.error) {
      throw new Error(`A2A Hub ${data.error.message} (code: ${data.error.code})`);
    }
    return (data as IJsonRpcSuccessResponse<unknown>).result;
  }

  async sendTask(agentId: string, taskId: string, message: IA2AMessage, skillId?: string): Promise<unknown> {
    return this.rpc(agentId, 'tasks/send', {
      taskId,
      message,
      skillId: skillId || 'claude-query',
    }, taskId);
  }

  async getTaskStatus(agentId: string, taskId: string): Promise<unknown> {
    return this.rpc(agentId, 'tasks/get', { taskId }, `get-${taskId}`);
  }

  async cancelTask(agentId: string, taskId: string): Promise<unknown> {
    return this.rpc(agentId, 'tasks/cancel', { taskId }, `cancel-${taskId}`);
  }

  async listAgents(): Promise<unknown> {
    const res = await fetch(`${this.hubUrl}/hub/agents`);
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    return res.json();
  }

  async registerAgent(opts: { id: string; name: string; baseUrl: string; apiKey?: string; description?: string }): Promise<unknown> {
    const res = await fetch(`${this.hubUrl}/hub/register`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(opts),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    return res.json();
  }

  async heartbeat(agentId: string): Promise<unknown> {
    const res = await fetch(`${this.hubUrl}/hub/heartbeat`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ id: agentId }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    return res.json();
  }
}

export function createA2AClient(agentId: string, self: import('../cc-ding-cli').DingClaude): A2AClient | null {
  const agent = self.config.a2aCfg?.remoteAgents?.find(a => a.id === agentId);
  if (!agent) return null;
  return new A2AClient(agent);
}

export function createHubClient(self: import('../cc-ding-cli').DingClaude): HubClient | null {
  const hubUrl = self.config.a2aCfg?.hubUrl;
  const apiKey = self.config.a2aCfg?.apiKey;
  if (!hubUrl || !apiKey) return null;
  return new HubClient(hubUrl, apiKey);
}
