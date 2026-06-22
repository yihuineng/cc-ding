import { WebSocket } from 'ws';
import type { IRemoteAgent, IA2AMessage, IJsonRpcRequest, IJsonRpcResponse, IJsonRpcSuccessResponse } from './types';

/**
 * A2A Client for calling remote agents via JSON-RPC 2.0 (direct HTTP mode)
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
 * HubClient - connects to A2A Hub via WebSocket, registers agents, and routes tasks through Hub.
 */
export class HubClient {
  private hubUrl: string;
  private apiKey: string;
  private ws: WebSocket | null = null;
  private connected = false;
  private messageHandlers: Map<string, (data: unknown) => void> = new Map();

  constructor(hubUrl: string, apiKey: string) {
    this.hubUrl = hubUrl.replace(/\/+$/, '');
    this.apiKey = apiKey;
  }

  /**
   * Connect to Hub via WebSocket and register agents.
   */
  connect(clientId: string, clientName: string, agents: Array<{ id: string; name: string; description?: string }>): Promise<void> {
    const wsUrl = this.hubUrl.replace(/^http/, 'ws') + `/ws?token=${encodeURIComponent(this.apiKey)}`;

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(wsUrl);

      this.ws.on('open', () => {
        console.log(`[A2A-Hub] WebSocket connected to ${this.hubUrl}`);
        // Register agents
        this.ws?.send(JSON.stringify({
          type: 'register',
          clientId,
          clientName,
          agents,
        }));
      });

      this.ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString()) as Record<string, unknown>;

          if (msg.type === 'registered') {
            this.connected = true;
            resolve();
          } else if (msg.type === 'heartbeat_ack') {
            // Silent ack
          } else if (msg.type === 'task_request') {
            // Forward task to local cc-ding handler
            const handler = this.messageHandlers.get('task');
            if (handler) handler(msg);
          }
        } catch { /* ignore */ }
      });

      this.ws.on('close', () => {
        console.log('[A2A-Hub] WebSocket disconnected');
        this.connected = false;
      });

      this.ws.on('error', (err) => {
        reject(err);
      });
    });
  }

  /**
   * Send heartbeat to Hub.
   */
  heartbeat(clientId: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'heartbeat', clientId }));
    }
  }

  /**
   * Send task through Hub (WebSocket mode).
   */
  async sendTask(agentId: string, taskId: string, message: IA2AMessage, skillId?: string): Promise<unknown> {
    if (!this.connected || !this.ws) throw new Error('Not connected to Hub');

    const body: IJsonRpcRequest = {
      jsonrpc: '2.0',
      id: taskId,
      method: 'tasks/send',
      params: {
        taskId,
        message,
        skillId: skillId || 'claude-query',
      },
    };

    this.ws.send(JSON.stringify({
      type: 'task_request',
      requestId: `client-${Date.now()}`,
      agentId,
      action: 'send',
      body,
    }));

    // Wait for result (simplified - in production use proper request tracking)
    return new Promise((resolve) => {
      setTimeout(() => resolve({ status: { state: 'sent', message: 'Task sent via Hub' } }), 100);
    });
  }

  async getTaskStatus(_agentId: string, _taskId: string): Promise<unknown> {
    return { status: { state: 'unknown' } };
  }

  async cancelTask(_agentId: string, _taskId: string): Promise<unknown> {
    return { status: { state: 'canceled' } };
  }

  async listAgents(): Promise<unknown> {
    const res = await fetch(`${this.hubUrl}/hub/agents`);
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    return res.json();
  }

  disconnect(): void {
    this.ws?.close();
    this.connected = false;
  }

  get isConnected(): boolean {
    return this.connected;
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
