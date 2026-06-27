import http from 'http';
import fs from 'fs';
import type { IA2AConfig, IA2AMessage } from './types';
import { A2AErrorCode } from './types';
import { saveTask, updateTaskStatus, updateTaskResult, getTask } from './session-mapper';
import type { IA2AInternalTask } from './types';
import type { DingClaude } from '../cc-ding-cli';
import { handleSessionMessage, getSessionDir } from '../session';

function sendSuccess(res: http.ServerResponse, id: string | number, result: unknown): void {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
}

function sendError(res: http.ServerResponse, id: string | number, code: number, message: string): void {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }));
}

/**
 * Build message with A2A context prefix so the agent knows the task origin.
 */
function buildA2AMessagePrefix(taskId: string, conversationId: string, text: string): string {
  return [
    '━━━ A2A 远程任务 ━━━',
    `Task ID: ${taskId}`,
    `目标群: ${conversationId}`,
    '',
    text,
  ].join('\n');
}

/**
 * Read the last assistant response from the session log file.
 */
function readAssistantResponse(sessionDir: string): string | null {
  const logFile = `${sessionDir}/session.log`;
  if (!fs.existsSync(logFile)) return null;
  try {
    const content = fs.readFileSync(logFile, 'utf-8');
    // Find the last [ASSISTANT]: block
    const lines = content.split('\n');
    let result = '';
    let inAssistant = false;
    for (const line of lines) {
      if (line.match(/\[ASSISTANT\]: /)) {
        inAssistant = true;
        result = line.replace(/\[.*?\] \[ASSISTANT\]: /, '');
      } else if (inAssistant && line.match(/\[[A-Z]+\]: /)) {
        inAssistant = false;
      } else if (inAssistant) {
        result += '\n' + line;
      }
    }
    return result.trim() || null;
  } catch {
    return null;
  }
}

/**
 * agent/get - return the AgentCard
 */
export async function handleAgentGet(
  self: DingClaude,
  config: IA2AConfig,
  res: http.ServerResponse,
  id: string | number,
): Promise<void> {
  const { generateAgentCard } = require('./agent-card');
  sendSuccess(res, id, generateAgentCard(self, config));
}

/**
 * tasks/send - create and execute a task
 */
export async function handleTasksSend(
  self: DingClaude,
  params: Record<string, unknown> | undefined,
  res: http.ServerResponse,
  id: string | number,
): Promise<void> {
  if (!params || typeof params.taskId !== 'string' || !params.message) {
    sendError(res, id, A2AErrorCode.InvalidParams, 'Missing required params: taskId, message');
    return;
  }

  const taskId = params.taskId as string;

  // Check duplicate
  if (getTask(self, taskId)) {
    sendError(res, id, A2AErrorCode.TaskAlreadyExists, `Task ${taskId} already exists`);
    return;
  }

  // Extract text from message
  const msg = params.message as IA2AMessage;
  const text = (msg.parts || [])
    .filter(p => !p.type || p.type === 'text')
    .map(p => (p as { text?: string }).text || '')
    .join('\n');

  if (!text) {
    sendError(res, id, A2AErrorCode.InvalidParams, 'Message must contain text content');
    return;
  }

  // Find target conversation
  const convs = self.config.conversations;
  if (!convs || convs.length === 0) {
    sendError(res, id, A2AErrorCode.AgentUnavailable, 'No conversations configured');
    return;
  }
  const targetConv = convs[0];

  // Create internal task
  const task: IA2AInternalTask = {
    taskId,
    conversationId: targetConv.conversationId,
    prompt: text,
    status: { state: 'submitted', message: 'Task received', timestamp: new Date().toISOString() },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  saveTask(self, task);

  updateTaskStatus(self, taskId, { state: 'working', message: 'Processing', timestamp: new Date().toISOString() });

  console.log(`[A2A] Task ${taskId}: executing "${text.slice(0, 80)}..." in conversation ${targetConv.conversationId}`);

  // Execute task as regular session message
  try {
    const convCfg = self.getConversationConfig(targetConv.conversationId);
    if (!convCfg) {
      throw new Error(`No conversation config for ${targetConv.conversationId}`);
    }

    // Use default webhook for response if no token
    const sessionWebhook = targetConv.dingToken
      ? ''
      : self.config.defaultDingToken || '';

    await handleSessionMessage(self, {
      conversationId: targetConv.conversationId,
      sessionWebhook,
      senderStaffId: 'a2a-remote',
      senderNick: `A2A[${(params.skillId as string) || 'query'}]`,
      message: buildA2AMessagePrefix(taskId, targetConv.conversationId, text),
      conversationConfig: convCfg,
    });

    // Read Claude's actual response from the session log
    const activeSession = self.activeSessions.get(targetConv.conversationId);
    const sessionDir = activeSession ? getSessionDir(self, activeSession.session) : null;
    const assistantResponse = sessionDir ? readAssistantResponse(sessionDir) : null;

    updateTaskStatus(self, taskId, { state: 'completed', message: 'Completed', timestamp: new Date().toISOString() });
    updateTaskResult(self, taskId, assistantResponse || text);

    sendSuccess(res, id, {
      taskId,
      status: { state: 'completed', message: 'Task completed' },
      message: assistantResponse ? { role: 'assistant', parts: [{ type: 'text', text: assistantResponse }] } : undefined,
    });
  } catch (err) {
    console.error('[A2A] Task execution error:', err);
    updateTaskStatus(self, taskId, {
      state: 'failed',
      message: err instanceof Error ? err.message : String(err),
      timestamp: new Date().toISOString(),
    });
    sendError(res, id, A2AErrorCode.InternalError, `Task execution failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * tasks/get - get task status
 */
export async function handleTasksGet(
  self: DingClaude,
  params: Record<string, unknown> | undefined,
  res: http.ServerResponse,
  id: string | number,
): Promise<void> {
  if (!params || typeof params.taskId !== 'string') {
    sendError(res, id, A2AErrorCode.InvalidParams, 'Missing required param: taskId');
    return;
  }

  const task = getTask(self, params.taskId);
  if (!task) {
    sendError(res, id, A2AErrorCode.TaskNotFound, `Task ${params.taskId} not found`);
    return;
  }

  sendSuccess(res, id, {
    taskId: task.taskId,
    status: task.status,
    message: task.result ? { role: 'assistant', parts: [{ type: 'text', text: task.result }] } : undefined,
    createdAt: new Date(task.createdAt).toISOString(),
    updatedAt: new Date(task.updatedAt).toISOString(),
  });
}

/**
 * tasks/cancel - cancel a task
 */
export async function handleTasksCancel(
  self: DingClaude,
  params: Record<string, unknown> | undefined,
  res: http.ServerResponse,
  id: string | number,
): Promise<void> {
  if (!params || typeof params.taskId !== 'string') {
    sendError(res, id, A2AErrorCode.InvalidParams, 'Missing required param: taskId');
    return;
  }

  const task = getTask(self, params.taskId);
  if (!task) {
    sendError(res, id, A2AErrorCode.TaskNotFound, `Task ${params.taskId} not found`);
    return;
  }

  updateTaskStatus(self, params.taskId, {
    state: 'canceled',
    message: 'Task canceled',
    timestamp: new Date().toISOString(),
  });

  // Try to interrupt active session
  const active = self.activeSessions.get(task.conversationId);
  if (active?.isProcessing) {
    try {
      const { interruptClaudeProcess } = require('../claude-process');
      interruptClaudeProcess(active, 'A2A task canceled');
    } catch { /* ignore */ }
  }

  sendSuccess(res, id, {
    taskId: params.taskId,
    status: { state: 'canceled', message: 'Task canceled' },
  });
}
