/**
 * Claude 子进程封装（one-shot 模式）
 * 通过 spawn `claude` CLI + stream-json 解析实现单次纯文本生成。
 * 无工具调用、单轮请求场景（cron 分析、任务预处理等）。
 * 不抛异常：所有失败通过返回值的 ok/errorOutput/timedOut 表达。
 */
import readline from 'readline';
import { commandExists, formatClaudeCommandMissingMessage, spawnCommand } from './platform';
import { parseClaudeStreamLine } from './claude-process';

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

  if (!commandExists('claude')) {
    return {
      ok: false,
      text: '',
      errorOutput: formatClaudeCommandMissingMessage('claude'),
      timedOut: false,
    };
  }

  const cmdArgs = [
    '--output-format', 'stream-json',
    '--max-turns', '1',
    '--permission-mode', 'default',
  ];
  if (settingsPath) {
    cmdArgs.push('--settings', settingsPath);
  }

  let stderrOutput = '';
  let resultText = '';
  let resultOk = false;
  let errorMessage = '';
  let timedOut = false;

  try {
    const child = spawnCommand('claude', cmdArgs, {
      cwd,
      stdio: [ 'pipe', 'pipe', 'pipe' ],
    });

    // 写入 prompt 到 stdin 并关闭
    child.stdin!.write(`${prompt}\n`);
    child.stdin!.end();

    // 超时控制
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    timer.unref?.();

    // 累积 stderr
    child.stderr!.on('data', (chunk: Buffer) => {
      stderrOutput += chunk.toString();
    });

    // 逐行解析 stdout
    const rl = readline.createInterface({ input: child.stdout! });
    for await (const line of rl) {
      const parsed = parseClaudeStreamLine(line);
      if (parsed?.type === 'result') {
        resultText = parsed.content || '';
        resultOk = true;
      }
    }

    // 等待进程退出
    const exitCode = await new Promise<number | null>((resolve) => {
      child.on('close', (code) => {
        resolve(code);
      });
      child.on('error', () => {
        resolve(1);
      });
    });

    clearTimeout(timer);

    if (timedOut) {
      errorMessage = 'One-shot prompt 超时';
    } else if (!resultOk && exitCode !== 0) {
      errorMessage = stderrOutput.trim() || `子进程退出码: ${exitCode}`;
    }
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
  }

  return {
    ok: resultOk,
    text: resultText,
    errorOutput: [ stderrOutput, errorMessage ].filter(Boolean).join('\n'),
    timedOut,
  };
}
