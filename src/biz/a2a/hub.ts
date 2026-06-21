import http from 'http';
import { authenticateRequest } from './auth';
import { setCorsHeaders, readBody } from './http-utils';

/**
 * Registered agent in the Hub
 */
interface IHubAgent {
  id: string;
  name: string;
  baseUrl: string;
  apiKey?: string;
  description?: string;
  registeredAt: number;
  lastHeartbeat: number;
  status: 'online' | 'offline';
  /** 所属 server（用于跨主机路由） */
  serverId?: string;
}

/**
 * Registered peer server
 */
interface IHubServer {
  id: string;
  baseUrl: string;
  registeredAt: number;
  lastHeartbeat: number;
  status: 'online' | 'offline';
  agentCount: number;
}

/**
 * Task routing record
 */
interface ITaskRecord {
  taskId: string;
  targetAgentId: string;
  targetAgentName: string;
  targetServerId?: string;
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
  /** 本机 server 标识 */
  serverId?: string;
  /** 其他 peer server 列表（可选，用于互相发现） */
  peerServers?: string[];
}

/**
 * A2A Hub - multi-host Agent registry and task router.
 *
 * Each physical host runs one a2a-server. cc-ding instances on that host
 * register to their local server. Servers with the same apiKey discover
 * each other and share agent registries for cross-host task routing.
 */
export class A2AHub {
  private server: http.Server | null = null;
  private config: IHubConfig;
  private agents = new Map<string, IHubAgent>();
  private peerServers = new Map<string, IHubServer>();
  private taskRecords: ITaskRecord[] = [];
  private totalRouted = 0;
  private totalErrors = 0;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private peerSyncTimer: NodeJS.Timeout | null = null;
  private readonly MAX_TASK_RECORDS = 200;

  constructor(config: IHubConfig) {
    this.config = config;
  }

  start(): void {
    const port = this.config.port ?? 3000;

    this.server = http.createServer(async (req, res) => {
      try {
        await this.handleRequest(req, res);
      } catch (err) {
        console.error('[A2A-Hub] Unhandled error:', err);
        this.json(res, 500, { error: 'Internal server error' });
      }
    });

    this.server.listen(port, () => {
      console.log(`[A2A-Hub] Server started on port ${port}`);
      console.log(`[A2A-Hub] Server ID: ${this.config.serverId || '(default)'}`);
      console.log(`[A2A-Hub] Dashboard: http://localhost:${port}/`);
    });
    this.server.on('error', (err) => console.error('[A2A-Hub] Server error:', err));

    // Heartbeat timeout checker
    this.heartbeatTimer = setInterval(() => this.checkHeartbeats(), 15000);

    // Peer server sync (every 30s)
    if (this.config.peerServers?.length) {
      this.peerSyncTimer = setInterval(() => this.syncWithPeers(), 30000);
      // Initial sync
      setTimeout(() => this.syncWithPeers(), 2000);
    }
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      if (this.peerSyncTimer) clearInterval(this.peerSyncTimer);
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

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const pathname = url.pathname;
    const method = req.method;

    // CORS
    setCorsHeaders(res);
    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // === Public endpoints ===

    // Dashboard HTML
    if (pathname === '/' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(DASHBOARD_HTML);
      return;
    }

    // Health check
    if (pathname === '/health' && method === 'GET') {
      this.json(res, 200, {
        status: 'ok',
        serverId: this.config.serverId,
        agents: this.agents.size,
        online: this.getOnlineAgents().length,
        peerServers: this.peerServers.size,
        totalRouted: this.totalRouted,
        totalErrors: this.totalErrors,
        timestamp: Date.now(),
      });
      return;
    }

    // List agents (all servers)
    if (pathname === '/hub/agents' && method === 'GET') {
      const agents = Array.from(this.agents.values()).map(a => ({
        id: a.id,
        name: a.name,
        description: a.description,
        baseUrl: a.baseUrl,
        status: a.status,
        serverId: a.serverId || this.config.serverId,
        registeredAt: new Date(a.registeredAt).toISOString(),
        lastHeartbeat: new Date(a.lastHeartbeat).toISOString(),
      }));
      this.json(res, 200, { agents, serverId: this.config.serverId });
      return;
    }

    // Stats
    if (pathname === '/hub/stats' && method === 'GET') {
      this.json(res, 200, {
        serverId: this.config.serverId,
        localAgents: this.agents.size,
        onlineAgents: this.getOnlineAgents().length,
        peerServers: this.peerServers.size,
        totalRouted: this.totalRouted,
        totalErrors: this.totalErrors,
        taskRecords: this.taskRecords.length,
        uptime: process.uptime(),
      });
      return;
    }

    // List peer servers
    if (pathname === '/hub/servers' && method === 'GET') {
      const servers = Array.from(this.peerServers.values()).map(s => ({
        id: s.id,
        baseUrl: s.baseUrl,
        status: s.status,
        agentCount: s.agentCount,
        lastHeartbeat: new Date(s.lastHeartbeat).toISOString(),
      }));
      this.json(res, 200, { servers, localServerId: this.config.serverId });
      return;
    }

    // Recent task records
    if (pathname === '/hub/tasks' && method === 'GET') {
      const limit = parseInt(url.searchParams.get('limit') || '50', 10);
      const records = this.taskRecords.slice(0, Math.min(limit, this.MAX_TASK_RECORDS));
      this.json(res, 200, { records, total: this.taskRecords.length });
      return;
    }

    // === Auth required ===
    const authErr = authenticateRequest(req, this.config.apiKey);
    if (authErr) {
      this.json(res, 401, { error: authErr });
      return;
    }

    // === Peer server registration ===
    if (pathname === '/hub/server/register' && method === 'POST') {
      const body = await readBody(req);
      let data: Record<string, unknown>;
      try { data = JSON.parse(body); } catch { this.json(res, 400, { error: 'Invalid JSON' }); return; }

      if (typeof data.id !== 'string' || typeof data.baseUrl !== 'string') {
        this.json(res, 400, { error: 'Missing required fields: id, baseUrl' });
        return;
      }
      // Don't register self
      if (data.id === this.config.serverId) {
        this.json(res, 200, { ok: true, message: 'self' });
        return;
      }

      const srv: IHubServer = {
        id: data.id,
        baseUrl: data.baseUrl,
        registeredAt: Date.now(),
        lastHeartbeat: Date.now(),
        status: 'online',
        agentCount: 0,
      };
      this.peerServers.set(srv.id, srv);
      console.log(`[A2A-Hub] Peer server registered: ${srv.id} (${srv.baseUrl})`);
      this.json(res, 200, { ok: true, server: { id: srv.id, baseUrl: srv.baseUrl } });
      return;
    }

    // Peer server heartbeat
    if (pathname === '/hub/server/heartbeat' && method === 'POST') {
      const body = await readBody(req);
      let data: Record<string, unknown>;
      try { data = JSON.parse(body); } catch { this.json(res, 400, { error: 'Invalid JSON' }); return; }
      const srvId = data.id as string;
      const srv = this.peerServers.get(srvId);
      if (!srv) { this.json(res, 404, { error: `Server ${srvId} not registered` }); return; }
      srv.lastHeartbeat = Date.now();
      srv.status = 'online';
      srv.agentCount = (data.agentCount as number) || 0;
      this.json(res, 200, { ok: true });
      return;
    }

    // Peer agent sync (receive agents from peer server)
    if (pathname === '/hub/server/sync-agents' && method === 'POST') {
      const body = await readBody(req);
      let data: Record<string, unknown>;
      try { data = JSON.parse(body); } catch { this.json(res, 400, { error: 'Invalid JSON' }); return; }
      const peerAgents = (data.agents as Array<Record<string, unknown>>) || [];
      const peerId = data.serverId as string;

      for (const pa of peerAgents) {
        const agentId = pa.id as string;
        const existing = this.agents.get(agentId);
        if (existing && existing.serverId === peerId) {
          // Update existing peer agent
          existing.lastHeartbeat = Date.now();
          existing.status = 'online';
        } else if (!existing) {
          // Register new peer agent
          this.agents.set(agentId, {
            id: agentId,
            name: (pa.name as string) || agentId,
            baseUrl: '',
            description: (pa.description as string) || '',
            registeredAt: Date.now(),
            lastHeartbeat: Date.now(),
            status: 'online',
            serverId: peerId,
          });
        }
      }
      this.json(res, 200, { ok: true, synced: peerAgents.length });
      return;
    }

    // Register agent
    if (pathname === '/hub/register' && method === 'POST') {
      const body = await readBody(req);
      let data: Record<string, unknown>;
      try { data = JSON.parse(body); } catch { this.json(res, 400, { error: 'Invalid JSON' }); return; }

      if (typeof data.id !== 'string' || typeof data.name !== 'string') {
        this.json(res, 400, { error: 'Missing required fields: id, name' });
        return;
      }

      const agent: IHubAgent = {
        id: data.id,
        name: data.name,
        baseUrl: (data.baseUrl as string) || '',
        apiKey: (data.apiKey as string) || undefined,
        description: (data.description as string) || undefined,
        registeredAt: Date.now(),
        lastHeartbeat: Date.now(),
        status: 'online',
      };
      this.agents.set(agent.id, agent);
      console.log(`[A2A-Hub] Agent registered: ${agent.id} (${agent.name})`);
      this.json(res, 200, { ok: true, agent: { id: agent.id, name: agent.name } });
      return;
    }

    // Heartbeat — client dimension: heartbeat for one agent = all agents of same client online
    if (pathname === '/hub/heartbeat' && method === 'POST') {
      const body = await readBody(req);
      let data: Record<string, unknown>;
      try { data = JSON.parse(body); } catch { this.json(res, 400, { error: 'Invalid JSON' }); return; }
      const agentId = data.id as string;
      // Extract clientId (agentId format: <clientId>:<conversationId>)
      const clientId = agentId.includes(':') ? agentId.split(':')[0] : agentId;

      const agent = this.agents.get(agentId);
      if (!agent) { this.json(res, 404, { error: `Agent ${agentId} not registered` }); return; }

      // Update all agents of the same client
      const now = Date.now();
      for (const [ id, a ] of this.agents) {
        if (id.startsWith(`${clientId}:`) || id.startsWith(`${this.config.serverId}:`)) {
          a.lastHeartbeat = now;
          a.status = 'online';
        }
      }
      this.json(res, 200, { ok: true });
      return;
    }

    // Unregister
    if (pathname === '/hub/unregister' && method === 'POST') {
      const body = await readBody(req);
      let data: Record<string, unknown>;
      try { data = JSON.parse(body); } catch { this.json(res, 400, { error: 'Invalid JSON' }); return; }
      this.agents.delete(data.id as string);
      this.json(res, 200, { ok: true });
      return;
    }

    // Route: /a2a/{agentId}/tasks/send|get|cancel
    const a2aMatch = pathname.match(/^\/a2a\/([^/]+)\/tasks\/(send|get|cancel)(Subscribe)?$/);
    if (a2aMatch && method === 'POST') {
      const [ , agentId ] = a2aMatch;
      const agent = this.agents.get(agentId);
      if (!agent) { this.json(res, 404, { error: `Agent ${agentId} not found` }); return; }
      if (agent.status !== 'online') { this.json(res, 503, { error: `Agent ${agentId} is offline` }); return; }

      const now = Date.now();
      const record: ITaskRecord = {
        taskId: '',
        targetAgentId: agentId,
        targetAgentName: agent.name,
        targetServerId: agent.serverId,
        state: 'routing',
        method: pathname.split('/').pop() || '',
        startedAt: now,
      };

      const body = await readBody(req);
      try {
        try {
          const parsed = JSON.parse(body);
          if (parsed.params && parsed.params.taskId) {
            record.taskId = parsed.params.taskId as string;
          }
        } catch { /* ignore */ }

        // If agent is on a peer server, forward the request
        if (agent.serverId && agent.serverId !== this.config.serverId) {
          const peerSrv = this.findPeerServer(agent.serverId);
          if (peerSrv) {
            const startTime = Date.now();
            const response = await fetch(`${peerSrv.baseUrl}/a2a/${agentId}/${record.method}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-API-Key': this.config.apiKey },
              body,
            });
            const resultText = await response.text();
            record.completedAt = Date.now();
            record.durationMs = Date.now() - startTime;
            try {
              const respData = JSON.parse(resultText);
              if (respData.result && respData.result.status) {
                record.state = respData.result.status.state || 'completed';
              }
            } catch { /* ignore */ }
            this.totalRouted++;
            this.addTaskRecord(record);
            res.writeHead(response.status, { 'Content-Type': 'application/json' });
            res.end(resultText);
            return;
          }
        }

        // Local execution: agent is on this server
        // For local agents without baseUrl, just acknowledge (task handled by local cc-ding)
        if (!agent.baseUrl) {
          console.log(`[A2A-Hub] Task ${record.taskId} routed to ${agentId} (local)`);
          record.state = 'completed';
          record.completedAt = Date.now();
          record.durationMs = 0;
          this.totalRouted++;
          this.addTaskRecord(record);

          let requestId: string | number = record.taskId || 'unknown';
          try { requestId = JSON.parse(body).id || requestId; } catch { /* ignore */ }
          this.json(res, 200, {
            jsonrpc: '2.0', id: requestId,
            result: { taskId: record.taskId, status: { state: 'completed', message: 'Task routed to local agent' } },
          });
          return;
        }

        // Cross-machine forward (baseUrl set)
        const targetUrl = `${agent.baseUrl}/a2a`;
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (agent.apiKey) headers['X-API-Key'] = agent.apiKey;

        const startTime = Date.now();
        const response = await fetch(targetUrl, { method: 'POST', headers, body });
        const resultText = await response.text();
        const duration = Date.now() - startTime;

        record.completedAt = Date.now();
        record.durationMs = duration;
        try {
          const respData = JSON.parse(resultText);
          if (respData.result && respData.result.status) {
            record.state = respData.result.status.state || 'completed';
          }
        } catch { /* ignore */ }
        this.totalRouted++;
        this.addTaskRecord(record);
        res.writeHead(response.status, { 'Content-Type': 'application/json' });
        res.end(resultText);
      } catch (err) {
        console.error(`[A2A-Hub] Failed to route to ${agentId}:`, err);
        this.totalRouted++;
        this.totalErrors++;
        record.state = 'failed';
        record.completedAt = Date.now();
        record.durationMs = Date.now() - now;
        record.error = err instanceof Error ? err.message : String(err);
        this.addTaskRecord(record);
        this.json(res, 502, { error: `Failed to reach agent ${agentId}: ${err instanceof Error ? err.message : String(err)}` });
      }
      return;
    }

    // Not found
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }

  private findPeerServer(serverId: string): IHubServer | undefined {
    if (serverId === this.config.serverId) return undefined;
    return this.peerServers.get(serverId);
  }

  private async syncWithPeers(): Promise<void> {
    // Send local agents to peers
    const localAgents = Array.from(this.agents.values()).map(a => ({
      id: a.id, name: a.name, description: a.description,
    }));

    for (const [ , srv ] of this.peerServers) {
      try {
        await fetch(`${srv.baseUrl}/hub/server/sync-agents`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-API-Key': this.config.apiKey },
          body: JSON.stringify({ serverId: this.config.serverId, agents: localAgents }),
        });
        // Heartbeat to peer
        await fetch(`${srv.baseUrl}/hub/server/heartbeat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-API-Key': this.config.apiKey },
          body: JSON.stringify({ id: this.config.serverId, agentCount: localAgents.length }),
        });
      } catch (err) {
        console.warn(`[A2A-Hub] Failed to sync with peer ${srv.id}: ${err instanceof Error ? err.message : String(err)}`);
        srv.status = 'offline';
      }
    }
  }

  private checkHeartbeats(): void {
    const timeout = (this.config.heartbeatTimeout ?? 60) * 1000;
    const now = Date.now();
    for (const [ id, agent ] of this.agents) {
      if (now - agent.lastHeartbeat > timeout && agent.status === 'online') {
        agent.status = 'offline';
        console.log(`[A2A-Hub] Agent ${id} (${agent.name}) marked offline (heartbeat timeout)`);
      }
    }
    // Also check peer servers
    for (const [ id, srv ] of this.peerServers) {
      if (now - srv.lastHeartbeat > timeout && srv.status === 'online') {
        srv.status = 'offline';
        console.log(`[A2A-Hub] Peer server ${id} marked offline`);
      }
    }
  }

  private json(res: http.ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }
}

/**
 * Dashboard HTML - served at GET /
 */
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>A2A Hub 控制台</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0d1117;--card:#161b22;--border:#30363d;--text:#c9d1d9;--muted:#8b949e;--green:#3fb950;--red:#f85149;--blue:#58a6ff;--yellow:#d29922;--purple:#bc8cff}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;background:var(--bg);color:var(--text);padding:20px}
h1{font-size:24px;margin-bottom:20px;display:flex;align-items:center;gap:10px}
h1::before{content:'🌐';font-size:28px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:24px}
.stat{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:16px;text-align:center}
.stat .num{font-size:32px;font-weight:700;color:var(--blue)}
.stat .label{font-size:13px;color:var(--muted);margin-top:4px}
section{margin-bottom:24px}
h2{font-size:18px;margin-bottom:12px;display:flex;align-items:center;gap:8px}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--border);border-radius:8px;overflow:hidden}
th{background:#1c2128;padding:10px 12px;text-align:left;font-size:13px;color:var(--muted);border-bottom:1px solid var(--border)}
td{padding:8px 12px;font-size:13px;border-bottom:1px solid var(--border)}
tr:hover td{background:rgba(88,166,255,0.04)}
.badge{display:inline-block;padding:2px 8px;border-radius:12px;font-size:12px;font-weight:600}
.online{background:rgba(63,185,80,0.15);color:var(--green)}
.offline{background:rgba(248,81,73,0.15);color:var(--red)}
.completed{background:rgba(63,185,80,0.15);color:var(--green)}
.failed{background:rgba(248,81,73,0.15);color:var(--red)}
.working{background:rgba(88,166,255,0.15);color:var(--blue)}
.routing{background:rgba(188,140,255,0.15);color:var(--purple)}
.mono{font-family:'SF Mono',Monaco,Consolas,monospace;font-size:12px}
#lastUpdate{font-size:12px;color:var(--muted);text-align:right;margin-top:8px}
.empty{text-align:center;padding:32px;color:var(--muted)}
</style>
</head>
<body>
<h1>A2A Hub 控制台</h1>
<div class="stats" id="stats"></div>
<section>
  <h2>🖥️ 集群 Server</h2>
  <table><thead><tr><th>Server ID</th><th>URL</th><th>状态</th><th>Agent 数</th><th>最后心跳</th></tr></thead><tbody id="servers"></tbody></table>
</section>
<section>
  <h2>🤖 已注册 Agent</h2>
  <table><thead><tr><th>ID</th><th>名称</th><th>描述</th><th>Server</th><th>状态</th><th>最后心跳</th></tr></thead><tbody id="agents"></tbody></table>
</section>
<section>
  <h2>📋 最近任务记录</h2>
  <table><thead><tr><th>Task ID</th><th>目标 Agent</th><th>Server</th><th>方法</th><th>状态</th><th>耗时</th><th>时间</th></tr></thead><tbody id="tasks"></tbody></table>
  <div id="lastUpdate"></div>
</section>
<script>
const fmtTime=t=>{if(!t)return'-';const d=new Date(t);return d.toLocaleString('zh-CN')};
const fmtDur=ms=>{if(!ms&&ms!==0)return'-';if(ms<1000)return ms+'ms';return(ms/1000).toFixed(1)+'s'};
const badge=(cls,txt)=>'<span class="badge '+cls+'">'+txt+'</span>';
async function load(){
  try{
    const[s,a,t,srv]=await Promise.all([
      fetch('/hub/stats').then(r=>r.json()),
      fetch('/hub/agents').then(r=>r.json()),
      fetch('/hub/tasks?limit=50').then(r=>r.json()),
      fetch('/hub/servers').then(r=>r.json()),
    ]);
    document.getElementById('stats').innerHTML=
      '<div class="stat"><div class="num">'+s.localAgents+'</div><div class="label">本地 Agent</div></div>'+
      '<div class="stat"><div class="num" style="color:var(--green)">'+s.onlineAgents+'</div><div class="label">在线 Agent</div></div>'+
      '<div class="stat"><div class="num" style="color:var(--purple)">'+s.peerServers+'</div><div class="label">Peer Server</div></div>'+
      '<div class="stat"><div class="num" style="color:var(--yellow)">'+s.totalRouted+'</div><div class="label">路由任务</div></div>'+
      '<div class="stat"><div class="num">'+fmtDur(s.uptime*1000)+'</div><div class="label">运行时长</div></div>';
    // Servers
    const servers=srv.servers||[];
    document.getElementById('servers').innerHTML=servers.length?servers.map(x=>{
      const st=x.status==='online'?'online':'offline';
      return '<tr><td class="mono">'+x.id+'</td><td class="mono">'+x.baseUrl+'</td><td>'+badge(st,x.status)+'</td><td>'+x.agentCount+'</td><td>'+fmtTime(x.lastHeartbeat)+'</td></tr>';
    }).join(''):'<tr><td colspan="5" class="empty">暂无 peer server</td></tr>';
    // Agents
    const agents=a.agents||[];
    document.getElementById('agents').innerHTML=agents.length?agents.map(x=>{
      const st=x.status==='online'?'online':'offline';
      return '<tr><td class="mono">'+x.id+'</td><td>'+x.name+'</td><td style="color:var(--muted)">'+(x.description||'')+'</td><td class="mono">'+(x.serverId||'local')+'</td><td>'+badge(st,x.status)+'</td><td>'+fmtTime(x.lastHeartbeat)+'</td></tr>';
    }).join(''):'<tr><td colspan="6" class="empty">暂无 Agent</td></tr>';
    // Tasks
    const tasks=t.records||[];
    document.getElementById('tasks').innerHTML=tasks.length?tasks.map(x=>{
      const st=x.state==='completed'?'completed':x.state==='failed'?'failed':x.state==='working'?'working':x.state==='routing'?'routing':'submitted';
      return '<tr><td class="mono">'+(x.taskId||'-')+'</td><td>'+x.targetAgentName+'</td><td class="mono">'+(x.targetServerId||'local')+'</td><td>'+x.method+'</td><td>'+badge(st,x.state)+'</td><td>'+fmtDur(x.durationMs)+'</td><td>'+fmtTime(x.startedAt)+'</td></tr>';
    }).join(''):'<tr><td colspan="7" class="empty">暂无任务记录</td></tr>';
    document.getElementById('lastUpdate').textContent='最后更新: '+new Date().toLocaleTimeString('zh-CN');
  }catch(e){console.error(e)}
}
load();
setInterval(load,5000);
</script>
</body>
</html>`;
