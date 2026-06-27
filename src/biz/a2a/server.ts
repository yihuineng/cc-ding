import http from 'http';
import type { IA2AConfig } from './types';
import { authenticateRequest } from './auth';
import { generateAgentCard } from './agent-card';
import { setCorsHeaders, readBody } from './http-utils';
import type { DingClaude } from '../cc-ding-cli';
import {
  handleAgentGet,
  handleTasksSend,
  handleTasksGet,
  handleTasksCancel,
} from './handlers';

/**
 * A2A HTTP Server - runs alongside existing DingTalk Stream WebSocket.
 * Serves AgentCard at /.well-known/agent.json and JSON-RPC at /a2a.
 */
export class A2AServer {
  private server: http.Server | null = null;
  private self: DingClaude;
  private config: IA2AConfig;

  constructor(self: DingClaude, config: IA2AConfig) {
    this.self = self;
    this.config = config;
  }

  start(): void {
    const port = this.config.port ?? 3000;
    this.server = http.createServer(async (req, res) => {
      try {
        await this.handleRequest(req, res);
      } catch (err) {
        console.error('[A2A] Unhandled error:', err);
        this.json(res, 500, { jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal error' } });
      }
    });

    this.server.listen(port, () => {
      console.log(`[A2A] Server started on port ${port}`);
      console.log(`[A2A] Agent card: ${this.config.baseUrl}/.well-known/agent.json`);
    });
    this.server.on('error', (err) => console.error('[A2A] Server error:', err));
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) this.server.close(() => resolve());
      else resolve();
    });
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const pathname = url.pathname;

    // CORS
    setCorsHeaders(res);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // AgentCard - no auth
    if (pathname === '/.well-known/agent.json' && req.method === 'GET') {
      this.json(res, 200, generateAgentCard(this.self, this.config));
      return;
    }

    // Health check - no auth
    if (pathname === '/health' && req.method === 'GET') {
      this.json(res, 200, { status: 'ok', timestamp: Date.now() });
      return;
    }

    // A2A endpoint - auth required
    if (pathname === '/a2a' && req.method === 'POST') {
      const authErr = authenticateRequest(req, this.config.apiKey);
      if (authErr) {
        this.json(res, 200, { jsonrpc: '2.0', id: null, error: { code: authErr.code, message: authErr.message } });
        return;
      }

      const body = await readBody(req);

      let request: unknown;
      try {
        request = JSON.parse(body);
      } catch {
        this.json(res, 200, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        return;
      }

      await this.routeRequest(request as Record<string, unknown>, res);
      return;
    }

    // Not found
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }

  private async routeRequest(request: Record<string, unknown>, res: http.ServerResponse): Promise<void> {
    const { jsonrpc, id, method } = request;

    if (jsonrpc !== '2.0') {
      this.json(res, 200, { jsonrpc: '2.0', id: id ?? null, error: { code: -32600, message: 'Invalid Request' } });
      return;
    }
    if (!method || typeof method !== 'string') {
      this.json(res, 200, { jsonrpc: '2.0', id: id ?? null, error: { code: -32600, message: 'Invalid Request' } });
      return;
    }

    const params = (request.params ?? {}) as Record<string, unknown>;
    const rpcId = request.id as string | number;

    switch (method) {
      case 'agent/get':
        await handleAgentGet(this.self, this.config, res, rpcId);
        break;
      case 'tasks/send':
        await handleTasksSend(this.self, params, res, rpcId);
        break;
      case 'tasks/sendSubscribe':
        await handleTasksSend(this.self, params, res, rpcId);
        break;
      case 'tasks/get':
        await handleTasksGet(this.self, params, res, rpcId);
        break;
      case 'tasks/cancel':
        await handleTasksCancel(this.self, params, res, rpcId);
        break;
      default:
        this.json(res, 200, { jsonrpc: '2.0', id: rpcId, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  }

  private json(res: http.ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }
}
