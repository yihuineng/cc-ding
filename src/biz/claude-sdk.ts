/**
 * Claude Agent SDK 封装
 * 用于替代「spawn claude CLI + 手工解析 stream-json」的调用方式。
 * 当前覆盖单次纯文本生成场景（cron 分析、任务预处理等无工具调用的 one-shot 请求），
 * 结构化消息流由 SDK 保证，无需再逐行解析 stdout。
 */
import { query } from '@anthropic-ai/claude-agent-sdk';

export interface IOneShotOpts {
  /** 工作目录 */
  cwd: string;
  /** Claude settings 文件路径（API Key 轮换等场景），透传给 CLI --settings */
  settingsPath?: string;
  /** 超时时间，默认 60s */
  timeoutMs?: number;
}

export interface IOneShotResult {
  /** 是否成功拿到 result */
  ok: boolean;
  /** 成功时的 result 文本 */
  text: string;
  /** 失败时的错误输出（stderr + 错误消息），供上层做错误分类 */
  errorOutput: string;
  /** 是否因超时被中止 */
  timedOut: boolean;
}

/**
 * 执行单次纯文本生成请求（无工具调用、单轮）
 * 不抛异常：所有失败通过返回值的 ok/errorOutput/timedOut 表达
 */
export async function runOneShotPrompt(prompt: string, opts: IOneShotOpts): Promise<IOneShotResult> {
  const { cwd, settingsPath, timeoutMs = 60_000 } = opts;
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), timeoutMs);
  timer.unref?.();

  let stderrOutput = '';
  let resultText = '';
  let resultOk = false;
  let errorMessage = '';

  try {
    const q = query({
      prompt,
      options: {
        cwd,
        permissionMode: 'default',
        allowedTools: [],
        maxTurns: 1,
        abortController,
        stderr: (data: string) => { stderrOutput += data; },
        ...(settingsPath ? { extraArgs: { settings: settingsPath } } : {}),
      },
    });
    for await (const msg of q) {
      if (msg.type === 'result') {
        if (msg.subtype === 'success') {
          resultText = msg.result;
          resultOk = true;
        } else {
          errorMessage = `result: ${msg.subtype}`;
        }
      }
    }
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
  } finally {
    clearTimeout(timer);
  }

  return {
    ok: resultOk,
    text: resultText,
    errorOutput: [ stderrOutput, errorMessage ].filter(Boolean).join('\n'),
    timedOut: abortController.signal.aborted,
  };
}
