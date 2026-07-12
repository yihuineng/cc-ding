import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { authenticateRequest } from './auth';
import { setCorsHeaders, readBody } from './http-utils';

/**
 * Registered agent in the Hub
 */
interface IHubAgent {
  id: string;
  name: string;
  description?: string;
  registeredAt: number;
  lastHeartbeat: number;
  status: 'online' | 'offline';
  clientId: string;
  connectionId: string;
}

/**
 * Connected cc-ding client
 */
interface IHubClient {
  id: string;
  ws: WebSocket;
  agents: string[];
  connectedAt: number;
  lastHeartbeat: number;
  name: string;
}

/**
 * Task routing record
 */
interface ITaskRecord {
  taskId: string;
  targetAgentId: string;
  targetAgentName: string;
  clientId: string;
  state: string;
  method: string;
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  error?: string;
}

/**
 * Hub configuration
 */
export interface IHubConfig {
  port?: number;
  apiKey: string;
  heartbeatTimeout?: number; // seconds, default 60
}

/**
 * A2A Hub - WebSocket-based multi-client Agent registry and task router.
 *
 * Single global server. All cc-ding instances connect via WebSocket.
 * Hub pushes tasks to cc-ding through the WebSocket connection.
 */
export class A2AHub {
  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private config: IHubConfig;
  private agents = new Map<string, IHubAgent>();
  private clients = new Map<string, IHubClient>();
  private taskRecords: ITaskRecord[] = [];
  private totalRouted = 0;
  private totalErrors = 0;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private pendingRequests = new Map<string, { resolve:(v: unknown) => void; reject: (e: Error) => void }>();
  private readonly MAX_TASK_RECORDS = 200;
  private requestIdCounter = 0;

  constructor(config: IHubConfig) {
    this.config = config;
  }

  start(): void {
    const port = this.config.port ?? 3000;

    this.server = http.createServer(async (req, res) => {
      try {
        await this.handleHttpRequest(req, res);
      } catch (err) {
        console.error('[A2A-Hub] HTTP error:', err);
        this.json(res, 500, { error: 'Internal server error' });
      }
    });

    this.wss = new WebSocketServer({ server: this.server });
    this.wss.on('connection', (ws, req) => this.handleWebSocket(ws, req));

    this.server.listen(port, () => {
      console.log(`[A2A-Hub] Server started on port ${port}`);
      console.log(`[A2A-Hub] WebSocket: ws://localhost:${port}/ws`);
      console.log(`[A2A-Hub] API: http://localhost:${port}/`);
    });
    this.server.on('error', (err) => console.error('[A2A-Hub] Server error:', err));

    this.heartbeatTimer = setInterval(() => this.checkHeartbeats(), 15000);
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      // Close all WebSocket connections
      for (const [ , client ] of this.clients) {
        client.ws.close();
      }
      this.wss?.close();
      if (this.server) this.server.close(() => resolve());
      else resolve();
    });
  }

  getAgentCount(): number {
    return this.agents.size;
  }

  getOnlineAgents(): IHubAgent[] {
    return Array.from(this.agents.values()).filter(a => a.status === 'online');
  }

  addTaskRecord(record: ITaskRecord): void {
    this.taskRecords.unshift(record);
    if (this.taskRecords.length > this.MAX_TASK_RECORDS) {
      this.taskRecords.pop();
    }
  }

  // ==================== HTTP Handlers ====================

  private async handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const pathname = url.pathname;
    const method = req.method;

    setCorsHeaders(res);
    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Root — 纯 API 服务，返回状态 JSON
    if (pathname === '/' && method === 'GET') {
      this.json(res, 200, {
        service: 'A2A Hub',
        clients: this.clients.size,
        agents: this.agents.size,
        onlineAgents: this.getOnlineAgents().length,
        totalRouted: this.totalRouted,
        totalErrors: this.totalErrors,
        uptime: process.uptime(),
        timestamp: Date.now(),
      });
      return;
    }

    // Health
    if (pathname === '/health' && method === 'GET') {
      this.json(res, 200, {
        status: 'ok',
        clients: this.clients.size,
        agents: this.agents.size,
        online: this.getOnlineAgents().length,
        totalRouted: this.totalRouted,
        totalErrors: this.totalErrors,
        timestamp: Date.now(),
      });
      return;
    }

    // List agents
    if (pathname === '/hub/agents' && method === 'GET') {
      const agents = this.getOnlineAgents().map(a => ({
        id: a.id,
        name: a.name,
        description: a.description,
        clientId: a.clientId,
        status: a.status,
        registeredAt: new Date(a.registeredAt).toISOString(),
        lastHeartbeat: new Date(a.lastHeartbeat).toISOString(),
      }));
      this.json(res, 200, { agents, clientCount: this.clients.size });
      return;
    }

    // List connected clients
    if (pathname === '/hub/clients' && method === 'GET') {
      const clients = Array.from(this.clients.values()).map(c => ({
        id: c.id,
        name: c.name,
        agentCount: c.agents.length,
        connectedAt: new Date(c.connectedAt).toISOString(),
        lastHeartbeat: new Date(c.lastHeartbeat).toISOString(),
      }));
      this.json(res, 200, { clients });
      return;
    }

    // Stats
    if (pathname === '/hub/stats' && method === 'GET') {
      this.json(res, 200, {
        clients: this.clients.size,
        agents: this.agents.size,
        onlineAgents: this.getOnlineAgents().length,
        totalRouted: this.totalRouted,
        totalErrors: this.totalErrors,
        taskRecords: this.taskRecords.length,
        uptime: process.uptime(),
      });
      return;
    }

    // Tasks
    if (pathname === '/hub/tasks' && method === 'GET') {
      const limit = parseInt(url.searchParams.get('limit') || '50', 10);
      const records = this.taskRecords.slice(0, Math.min(limit, this.MAX_TASK_RECORDS));
      this.json(res, 200, { records, total: this.taskRecords.length });
      return;
    }

    // REST API: register agent (for non-WebSocket clients)
    if (pathname === '/hub/register' && method === 'POST') {
      const authErr = authenticateRequest(req, this.config.apiKey);
      if (authErr) { this.json(res, 401, authErr); return; }
      const body = await readBody(req);
      let data: Record<string, unknown>;
      try { data = JSON.parse(body); } catch { this.json(res, 400, { error: 'Invalid JSON' }); return; }
      if (typeof data.id !== 'string' || typeof data.name !== 'string') {
        this.json(res, 400, { error: 'Missing: id, name' }); return;
      }
      this.json(res, 200, { error: 'WebSocket connection required for agent registration' });
      return;
    }

    // REST API: a2a task routing (for non-WebSocket callers)
    const a2aMatch = pathname.match(/^\/a2a\/([^/]+)\/tasks\/(send|get|cancel)(Subscribe)?$/);
    if (a2aMatch && method === 'POST') {
      const [ , agentId, action ] = a2aMatch;
      const body = await readBody(req);
      let requestId: string | number = 'rest';
      try { requestId = JSON.parse(body).id || requestId; } catch { /* ignore */ }

      const result = await this.routeTask(agentId, action, body, requestId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }

  // ==================== WebSocket Handlers ====================

  private handleWebSocket(ws: WebSocket, req: http.IncomingMessage): void {
    // Authenticate via query param or header
    const url = new URL(req.url || '', 'http://localhost');
    const token = url.searchParams.get('token') || req.headers['x-api-key'] as string;

    if (token !== this.config.apiKey) {
      ws.close(1008, 'Unauthorized');
      return;
    }

    let clientId = '';
    let clientName = '';

    ws.on('message', async (data) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString());
      } catch { return; }

      const type = msg.type as string;

      switch (type) {
        case 'register': {
          // Client registration
          clientId = msg.clientId as string;
          clientName = (msg.clientName as string) || clientId;
          const agents = (msg.agents as Array<Record<string, unknown>>) || [];

          // Clean up old connection if exists
          const oldClient = this.clients.get(clientId);
          if (oldClient) {
            oldClient.ws.close();
            // Mark old agents offline
            for (const agentId of oldClient.agents) {
              const agent = this.agents.get(agentId);
              if (agent) agent.status = 'offline';
            }
          }

          // Register client
          const connectionId = `conn-${Date.now()}`;
          this.clients.set(clientId, {
            id: clientId,
            ws,
            agents: agents.map(a => a.id as string),
            connectedAt: Date.now(),
            lastHeartbeat: Date.now(),
            name: clientName,
          });

          // Register agents
          for (const a of agents) {
            this.agents.set(a.id as string, {
              id: a.id as string,
              name: (a.name as string) || a.id as string,
              description: a.description as string,
              registeredAt: Date.now(),
              lastHeartbeat: Date.now(),
              status: 'online',
              clientId,
              connectionId,
            });
          }

          console.log(`[A2A-Hub] Client connected: ${clientId} (${clientName}), ${agents.length} agents`);
          this.sendWs(ws, { type: 'registered', clientId, agentCount: agents.length });
          break;
        }

        case 'heartbeat': {
          // Client heartbeat
          clientId = msg.clientId as string;
          const client = this.clients.get(clientId);
          if (client) {
            client.lastHeartbeat = Date.now();
            // Update all agents of this client
            for (const agentId of client.agents) {
              const agent = this.agents.get(agentId);
              if (agent) {
                agent.lastHeartbeat = Date.now();
                agent.status = 'online';
              }
            }
          }
          this.sendWs(ws, { type: 'heartbeat_ack' });
          break;
        }

        case 'task_result': {
          // Task execution result from cc-ding
          const reqId = msg.requestId as string;
          const pending = this.pendingRequests.get(reqId);
          if (pending) {
            this.pendingRequests.delete(reqId);
            pending.resolve(msg.result);
          }
          break;
        }

        case 'task_error': {
          // Task execution error from cc-ding
          const reqId = msg.requestId as string;
          const pending = this.pendingRequests.get(reqId);
          if (pending) {
            this.pendingRequests.delete(reqId);
            pending.reject(new Error(msg.error as string));
          }
          break;
        }
      }
    });

    ws.on('close', () => {
      if (clientId) {
        console.log(`[A2A-Hub] Client disconnected: ${clientId}`);
        const client = this.clients.get(clientId);
        if (client) {
          // Mark agents offline
          for (const agentId of client.agents) {
            const agent = this.agents.get(agentId);
            if (agent) agent.status = 'offline';
          }
          this.clients.delete(clientId);
        }
      }
    });
  }

  private sendWs(ws: WebSocket, data: Record<string, unknown>): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }

  // ==================== Task Routing ====================

  private async routeTask(
    agentId: string,
    action: string,
    body: string,
    requestId: string | number,
  ): Promise<unknown> {
    const now = Date.now();
    const agent = this.agents.get(agentId);

    if (!agent) {
      return { jsonrpc: '2.0', id: requestId, error: { code: -32002, message: `Agent ${agentId} not found` } };
    }
    if (agent.status !== 'online') {
      return { jsonrpc: '2.0', id: requestId, error: { code: -32004, message: `Agent ${agentId} is offline` } };
    }

    const record: ITaskRecord = {
      taskId: '',
      targetAgentId: agentId,
      targetAgentName: agent.name,
      clientId: agent.clientId,
      state: 'routing',
      method: action,
      startedAt: now,
    };

    try {
      const parsed = JSON.parse(body);
      if (parsed.params?.taskId) record.taskId = parsed.params.taskId as string;
    } catch { /* ignore */ }

    // Send task to cc-ding via WebSocket
    const client = this.clients.get(agent.clientId);
    if (!client || client.ws.readyState !== WebSocket.OPEN) {
      record.state = 'failed';
      record.error = 'Client disconnected';
      record.completedAt = Date.now();
      this.totalErrors++;
      this.addTaskRecord(record);
      return { jsonrpc: '2.0', id: requestId, error: { code: -32004, message: 'Client disconnected' } };
    }

    const reqId = `req-${++this.requestIdCounter}`;
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(reqId);
        record.state = 'failed';
        record.error = 'Timeout';
        record.completedAt = Date.now();
        record.durationMs = Date.now() - now;
        this.totalErrors++;
        this.addTaskRecord(record);
        resolve({ jsonrpc: '2.0', id: requestId, error: { code: -32004, message: 'Task timeout' } });
      }, 120000); // 2 min timeout

      this.pendingRequests.set(reqId, {
        resolve: (result) => {
          clearTimeout(timeout);
          this.pendingRequests.delete(reqId);
          record.state = 'completed';
          record.completedAt = Date.now();
          record.durationMs = Date.now() - now;
          this.totalRouted++;
          this.addTaskRecord(record);
          resolve(result);
        },
        reject: (err) => {
          clearTimeout(timeout);
          this.pendingRequests.delete(reqId);
          record.state = 'failed';
          record.error = err.message;
          record.completedAt = Date.now();
          record.durationMs = Date.now() - now;
          this.totalErrors++;
          this.addTaskRecord(record);
          resolve({ jsonrpc: '2.0', id: requestId, error: { code: -32603, message: err.message } });
        },
      });

      // Forward the task to cc-ding
      let parsed: Record<string, unknown> = {};
      try { parsed = JSON.parse(body); } catch { /* ignore */ }
      this.sendWs(client.ws, {
        type: 'task_request',
        requestId: reqId,
        agentId,
        action,
        body: parsed,
      });
    });
  }

  // ==================== Heartbeat Checker ====================

  private checkHeartbeats(): void {
    const timeout = (this.config.heartbeatTimeout ?? 60) * 1000;
    const now = Date.now();
    for (const [ id, client ] of this.clients) {
      if (now - client.lastHeartbeat > timeout) {
        console.log(`[A2A-Hub] Client ${id} (${client.name}) timeout, disconnecting`);
        client.ws.close();
        for (const agentId of client.agents) {
          const agent = this.agents.get(agentId);
          if (agent) agent.status = 'offline';
        }
        this.clients.delete(id);
      }
    }
  }

  private json(res: http.ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }
}
