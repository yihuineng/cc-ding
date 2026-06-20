import readline from 'readline';
import fs from 'fs';
import { IAgent, IAgentQueryOpts } from './agent';
import type { DingClaude } from './cc-ding-cli';
import type { ISession, IActiveSession } from './types';
import { sendDingMessage, sendClaudeResponseToDing } from './messaging';
import {
  timestamp,
  appendSessionLog,
} from './session';
import { spawnCommand } from './platform';
import { AgentWatchdog, defaultWatchdogOnTimeout, defaultWatchdogOnRecoveryFailed } from './watchdog';

/**
 * 解析 Codex CLI 的 JSON 流式事件
 * Codex CLI 使用 `--json` 标志输出 JSON Lines 格式
 */
function parseCodexEvent(line: string): { type: string; threadId?: string; content?: string } | null {
  if (!line.trim()) return null;
  try {
    const evt = JSON.parse(line);
    const evtType = evt.type as string || '';

    // 会话启动事件，包含 thread_id（用于 resume）
    if (evtType === 'thread.started' && evt.thread_id) {
      return { type: 'system', threadId: evt.thread_id };
    }

    // 消息完成事件
    if (evtType === 'item.completed' && evt.item) {
      const item = evt.item;
      // 文本消息
      if (item.type === 'message' && item.role === 'assistant') {
        const parts: string[] = [];
        if (Array.isArray(item.content)) {
          for (const block of item.content) {
            if (block.type === 'output_text' && block.text) {
              parts.push(block.text);
            }
          }
        }
        if (parts.length > 0) {
          return { type: 'assistant', content: parts.join('\n') };
        }
      }
      // 工具调用结果（不展示给用户）
      if (item.type === 'function_call_output') {
        return { type: 'tool' };
      }
    }

    // Turn 完成
    if (evtType === 'turn.completed') {
      return { type: 'result' };
    }

    // Turn 失败
    if (evtType === 'turn.failed') {
      const errorMsg = evt.error?.message || 'unknown error';
      return { type: 'error', content: errorMsg };
    }

    if (evtType === 'error') {
      return { type: 'error', content: evt.message || evt.error || 'unknown error' };
    }

    return { type: evtType || 'unknown' };
  } catch {
    return { type: 'text', content: line };
  }
}

export class CodexAgent implements IAgent {
  readonly type = 'codex';

  async executeQuery(dc: DingClaude, session: ISession, opts: IAgentQueryOpts): Promise<void> {
    const convCfg = dc.getConversationConfig(session.conversationId);
    const sessionDir = dc.getSessionDir(session);
    const dingGroupDir = dc.getConversationDir(session.conversationId);
    fs.mkdirSync(sessionDir, { recursive: true });

    const sender = opts.senderNick && opts.senderStaffId
      ? `${opts.senderNick}(${opts.senderStaffId})`
      : 'unknown';
    const safeMessage = !opts.rawMessage && opts.message.startsWith('/')
      ? ` ${opts.message}`
      : opts.message;
    const stdinMessage = opts.rawMessage
      ? opts.message
      : `${safeMessage} ── 消息来自: ${sender}`;

    appendSessionLog(sessionDir, 'user', stdinMessage);

    // 构造 codex 命令参数
    const cmdArgs: string[] = [ 'exec' ];
    const model = convCfg?.model || dc.config.model;

    if (session.agentSessionId) {
      // 恢复已有会话（使用 thread_id）
      cmdArgs.push('resume', '--skip-git-repo-check');
      cmdArgs.push('-c', 'sandbox_mode=full-auto');
      cmdArgs.push('-c', 'approval_policy=never');
      if (model) cmdArgs.push('--model', model);
      cmdArgs.push(session.agentSessionId);
      cmdArgs.push('--json', '-');
    } else {
      // 新会话
      cmdArgs.push('--skip-git-repo-check');
      cmdArgs.push('--sandbox', 'full-auto');
      cmdArgs.push('-c', 'approval_policy=never');
      if (model) cmdArgs.push('--model', model);
      cmdArgs.push('--json', '--cd', dingGroupDir, '-');
    }

    console.log(`[${timestamp()}] 执行 Codex 查询: codex ${cmdArgs.join(' ')}`);
    await this.runCodexOnce(dc, session, cmdArgs, dingGroupDir, stdinMessage);
  }

  interrupt(activeSession: IActiveSession, reason: string): boolean {
    if (!activeSession.currentProcess) return false;
    console.log(`[${timestamp()}] ${reason}`);
    activeSession.interrupted = true;
    activeSession.currentProcess.kill('SIGINT');
    return true;
  }

  getEntryCommand(): string {
    return 'codex';
  }

  private async runCodexOnce(
    dc: DingClaude,
    session: ISession,
    cmdArgs: string[],
    cwd: string,
    stdinMessage: string,
  ): Promise<void> {
    const activeSession = dc.activeSessions.get(session.conversationId);
    const startTime = Date.now();

    // 使用 spawnCommand（兼容 Windows）
    const child = spawnCommand('codex', cmdArgs, {
      cwd,
      stdio: [ 'pipe', 'pipe', 'pipe' ],
      env: { ...process.env },
    });

    if (activeSession) {
      activeSession.currentProcess = child;
      activeSession.lastActivityTime = startTime;
    }

    // Codex 通过 stdin 接收消息
    child.stdin?.write(stdinMessage + '\n');
    child.stdin?.end();

    const responseBuffer: string[] = [];
    let hasSentResponse = false;

    const updateActivity = () => {
      if (activeSession) activeSession.lastActivityTime = Date.now();
    };

    const watchdog = new AgentWatchdog(dc, session, activeSession, {
      killChild: () => {
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
        setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, 2000);
      },
      onTimeout: (attempts, maxAutoRecovery, timeoutSec) => {
        defaultWatchdogOnTimeout(dc, session, attempts, maxAutoRecovery, timeoutSec, 'codex');
      },
      onRecoveryFailed: (maxAutoRecovery) => {
        defaultWatchdogOnRecoveryFailed(dc, session, maxAutoRecovery, 'codex');
      },
    }, startTime);
    watchdog.start();

    return new Promise<void>((resolve, reject) => {
      // 逐行解析 stdout（JSON Lines）
      const rl = readline.createInterface({ input: child.stdout! });
      rl.on('line', (line) => {
        updateActivity();
        dc.debugLog(`Codex stdout: ${line.substring(0, 200)}`);

        const parsed = parseCodexEvent(line);
        if (!parsed) return;

        // 保存 thread_id 用于会话恢复
        if (parsed.type === 'system' && parsed.threadId) {
          if (!session.agentSessionId) {
            dc.updateSessionFile(session, { agentSessionId: parsed.threadId });
          }
          console.log(`[${timestamp()}] Codex thread_id: ${parsed.threadId}`);
        }

        // 收集 assistant 回复
        if (parsed.type === 'assistant' && parsed.content) {
          responseBuffer.push(parsed.content);
        }

        // 结果完成
        if (parsed.type === 'result') {
          watchdog.markSettled();
          watchdog.stop();
          const fullResponse = responseBuffer.join('\n').trim();
          if (fullResponse && !activeSession?.interrupted) {
            try { appendSessionLog(cwd, 'assistant', fullResponse); } catch { /* ignore */ }
            const atUserId = activeSession?.lastSenderStaffId || session.startStaffId;
            hasSentResponse = true;
            sendClaudeResponseToDing(dc, session.currentConversationId || session.conversationId, session.currentWebhook || session.sessionWebhook, atUserId, fullResponse)
              .catch(err => console.error('发送钉钉消息失败:', err));
          }
          resolve();
        }

        // 错误处理
        if (parsed.type === 'error') {
          watchdog.markSettled();
          watchdog.stop();
          const atUserId = activeSession?.lastSenderStaffId || session.startStaffId;
          sendDingMessage(dc, {
            conversationId: session.currentConversationId || session.conversationId,
            sessionWebhook: session.currentWebhook || session.sessionWebhook,
            atUserId,
            content: `❌ Codex 执行失败: ${parsed.content}`,
          }).catch(() => {});
          resolve();
        }
      });

      child.stderr?.on('data', (data) => {
        const str = data.toString();
        updateActivity();
        console.error(`[Codex stderr]: ${str}`);
        try {
          const sessionDir = dc.getSessionDir(session);
          fs.appendFileSync(`${sessionDir}/session.log`, `[${timestamp()}] [ERROR]: ${str}`, 'utf-8');
        } catch { /* ignore */ }
      });

      child.on('close', (code) => {
        watchdog.markSettled();
        watchdog.stop();
        console.log(`[${timestamp()}] Codex 进程退出，代码: ${code}`);

        const activeSessionRef = dc.activeSessions.get(session.conversationId);
        if (activeSessionRef) {
          activeSessionRef.currentProcess = undefined;
        }

        // 被中断时丢弃 responseBuffer
        if (activeSessionRef?.interrupted) {
          activeSessionRef.interrupted = false;
          responseBuffer.length = 0;
          resolve();
          return;
        }

        // 已发送过回复，跳过后续处理
        if (hasSentResponse) {
          if (code === 0) { resolve(); return; }
          reject(new Error(`Codex 进程退出，代码: ${code}`));
          return;
        }

        // 如果还未发送回复且有内容
        if (responseBuffer.length > 0) {
          const fullResponse = responseBuffer.join('\n').trim();
          if (fullResponse) {
            try {
              const sessionDir = dc.getSessionDir(session);
              appendSessionLog(sessionDir, 'assistant', fullResponse);
            } catch { /* ignore */ }
            const atUserId = activeSessionRef?.lastSenderStaffId || session.startStaffId;
            sendClaudeResponseToDing(dc, session.currentConversationId || session.conversationId, session.currentWebhook || session.sessionWebhook, atUserId, fullResponse)
              .catch(err => console.error('发送钉钉消息失败:', err));
          }
        }

        // 正常退出但无回复
        if (code === 0 && !activeSessionRef?.interrupted) {
          console.warn(`[${timestamp()}] Codex 进程正常退出但未产生任何回复内容`);
          const atUserId = activeSessionRef?.lastSenderStaffId || session.startStaffId;
          sendDingMessage(dc, {
            conversationId: session.currentConversationId || session.conversationId,
            sessionWebhook: session.currentWebhook || session.sessionWebhook,
            atUserId,
            content: '⚠️ Codex 处理完成但未返回任何内容',
          }).catch(() => {});
        }

        if (code === 0) {
          resolve();
          return;
        }

        reject(new Error(`Codex 进程退出，代码: ${code}`));
      });

      child.on('error', (err) => {
        watchdog.markSettled();
        watchdog.stop();
        console.error('Codex 进程错误:', err);
        try {
          const sessionDir = dc.getSessionDir(session);
          fs.appendFileSync(`${sessionDir}/session.log`, `[${timestamp()}] [ERROR]: 进程错误: ${err.message}\n`, 'utf-8');
        } catch { /* ignore */ }
        reject(err);
      });
    });
  }
}
