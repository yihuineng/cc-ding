/**
 * 任务运行器 —— 包装长时间运行的命令，完成后通过钉钉 API 主动通知到群。
 *
 * 使用场景：Claude Code 执行 docker build、npm install 等耗时操作时，
 * 通过 `cc-ding task` 包装，命令完成/失败后自动推送结果到钉钉会话。
 *
 * 两种运行模式：
 * - 前台模式（默认）：阻塞等待命令完成，实时输出到终端，同时记录日志
 * - 后台模式（--bg）：立即返回，命令在后台运行，完成后通知
 */

import { spawn, SpawnOptions } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { sendNotify } from './notify';

export interface ITaskRunOpts {
  /** 要执行的命令（argv 数组形式，避免 shell 转义问题） */
  commandArgs: string[];
  /** 显示用的命令字符串（用于日志/通知） */
  commandDisplay: string;
  /** cc-ding clientId，用于读取配置和发送通知 */
  clientId: string;
  /** 通知目标会话 ID */
  conversationId: string;
  /** 任务标识（展示用） */
  taskId?: string;
  /** 日志文件路径（默认自动生成） */
  logFile?: string;
  /** 工作目录 */
  cwd?: string;
  /** 超时时间（秒），0 = 不限 */
  timeout?: number;
  /** 后台模式：立即返回，命令在后台运行 */
  bg?: boolean;
  /** 是否在完成后发送通知（默认 true） */
  notify?: boolean;
}

export interface ITaskResult {
  taskId: string;
  command: string;
  success: boolean;
  exitCode: number | null;
  duration: number;
  logFile: string;
  outputTail: string;
  /** 后台模式下为子进程 PID */
  pid?: number;
}

const DEFAULT_LOG_DIR = path.join(os.homedir(), '.cc-ding', '.task-logs');

/** 生成默认日志路径 */
function resolveLogFile(taskId: string, logFile?: string): string {
  if (logFile) return logFile;
  fs.mkdirSync(DEFAULT_LOG_DIR, { recursive: true });
  return path.join(DEFAULT_LOG_DIR, `${taskId}-${Date.now()}.log`);
}

/** 生成任务 ID */
function generateTaskId(): string {
  return `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** 读取日志文件末尾内容 */
function readLogTail(logFile: string, maxBytes = 8192): string {
  try {
    if (!fs.existsSync(logFile)) return '(无日志)';
    const stat = fs.statSync(logFile);
    const start = Math.max(0, stat.size - maxBytes);
    const buf = Buffer.alloc(Math.min(stat.size, maxBytes));
    const fd = fs.openSync(logFile, 'r');
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return buf.toString('utf-8').trim() || '(空)';
  } catch {
    return '(无法读取日志)';
  }
}

/** 格式化耗时 */
function formatDuration(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}秒`;
  const min = Math.floor(sec / 60);
  const remainSec = sec % 60;
  if (min < 60) return `${min}分${remainSec}秒`;
  const hr = Math.floor(min / 60);
  const remainMin = min % 60;
  return `${hr}时${remainMin}分`;
}

/** 构建通知消息 */
function buildNotifyMessage(result: ITaskResult): string {
  const icon = result.success ? '✅' : '❌';
  const status = result.success ? '已完成' : '失败';
  const taskIdStr = result.taskId ? ` (${result.taskId})` : '';
  const exitInfo = result.exitCode != null && !result.success ? ` (exit: ${result.exitCode})` : '';

  const lines = [
    `${icon} **任务${status}**${taskIdStr}`,
    `命令: \`${result.command}\``,
    `耗时: ${formatDuration(result.duration)}${exitInfo}`,
    `日志: \`${result.logFile}\``,
    '',
    '**最新输出:**',
    '```',
    result.outputTail.slice(-2000),
    '```',
  ];

  return lines.join('\n');
}

/**
 * 发送任务完成通知到钉钉会话
 */
async function sendTaskNotification(result: ITaskResult, clientId: string, conversationId: string): Promise<void> {
  const message = buildNotifyMessage(result);
  try {
    const res = await sendNotify({
      clientId,
      message,
      conversationIds: [ conversationId ],
      markdown: true,
    });
    if (res.success > 0) {
      console.log(`[task] 📤 通知已发送到 ${conversationId}`);
    } else {
      console.error(`[task] ❌ 通知发送失败`);
    }
  } catch (err) {
    console.error(`[task] ❌ 通知异常: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * 前台运行命令（阻塞直到完成）
 * 使用 spawn argv 数组，不经过 shell 二次解析，保证参数精确传递。
 */
async function runForeground(
  commandArgs: string[], commandDisplay: string, logFile: string,
  cwd?: string, timeoutSec?: number,
): Promise<Omit<ITaskResult, 'taskId'>> {
  return new Promise((resolve) => {
    const logFd = fs.openSync(logFile, 'w');
    const startTime = Date.now();

    const [ cmd, ...args ] = commandArgs;
    const child = spawn(cmd, args, {
      cwd,
      detached: false,
      stdio: [ 'ignore', 'pipe', 'pipe' ],
      env: process.env,
    } as SpawnOptions);

    // tee: 同时输出到终端和日志
    child.stdout!.on('data', (chunk: Buffer) => {
      process.stdout.write(chunk);
      try { fs.writeSync(logFd, chunk); } catch { /* ignore */ }
    });
    child.stderr!.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk);
      try { fs.writeSync(logFd, chunk); } catch { /* ignore */ }
    });

    let timer: NodeJS.Timeout | undefined;
    if (timeoutSec && timeoutSec > 0) {
      timer = setTimeout(() => {
        console.error(`\n[task] ⏰ 超时 (${timeoutSec}s)，正在终止...`);
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 5000);
      }, timeoutSec * 1000);
    }

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      try { fs.closeSync(logFd); } catch { /* ignore */ }
      resolve({
        command: commandDisplay,
        success: code === 0,
        exitCode: code,
        duration: Date.now() - startTime,
        logFile,
        outputTail: readLogTail(logFile),
      });
    });

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      try { fs.writeSync(logFd, `\n[ERROR] ${err.message}\n`); } catch { /* ignore */ }
      try { fs.closeSync(logFd); } catch { /* ignore */ }
      resolve({
        command: commandDisplay,
        success: false,
        exitCode: -1,
        duration: Date.now() - startTime,
        logFile,
        outputTail: `[ERROR] ${err.message}`,
      });
    });
  });
}

/**
 * 后台运行命令（立即返回，命令在后台执行）
 *
 * 机制：spawn 一个 detached 的子 Node 进程，运行相同的 cc-ding task 命令（不带 --bg），
 * 子进程完成后自行发送通知。父进程立即退出。
 *
 * 关键：通过 __TASK_ARGV__ 环境变量传递原始 argv 数组（JSON），
 * 避免 shell 转义导致参数丢失。
 */
function runInBackground(logFile: string, childTaskArgv: string[], cwd?: string): number {
  const logFd = fs.openSync(logFile, 'w');

  // 关键：把原始参数传给子进程的 process.argv，
  // 让 commander 正常解析 requiredOption。
  // argv 格式: [ execPath, scriptPath, 'task', ...args ]
  const child = spawn(process.execPath, [ process.argv[1], 'task', ...childTaskArgv ], {
    detached: true,
    stdio: [ 'ignore', logFd, logFd ],
    cwd,
    env: process.env,
  } as SpawnOptions);

  child.unref();
  fs.closeSync(logFd);

  return child.pid ?? -1;
}

/**
 * 执行任务入口
 */
export async function runTask(opts: ITaskRunOpts): Promise<ITaskResult> {
  const taskId = opts.taskId || generateTaskId();
  const logFile = resolveLogFile(taskId, opts.logFile);
  const startTime = Date.now();

  console.log(`[task] 📋 任务: ${taskId}`);
  console.log(`[task] 📝 命令: ${opts.commandDisplay}`);
  console.log(`[task] 📂 目录: ${opts.cwd || process.cwd()}`);
  console.log(`[task] 📄 日志: ${logFile}`);
  console.log(`[task] 🔔 通知: ${opts.notify !== false ? `→ ${opts.conversationId}` : '关闭'}`);
  console.log('');

  // ── 后台模式 ──
  if (opts.bg) {
    // 从 process.argv 提取 task 后的所有参数，去掉 --bg 标志
    // 子进程会以这些参数重新启动（不带 --bg），以前台模式运行并发送通知
    const taskIdx = process.argv.indexOf('task');
    const rawArgs = taskIdx >= 0 ? process.argv.slice(taskIdx + 1) : [];
    const childTaskArgv = rawArgs.filter(a => a !== '--bg' && a !== '-bg');

    const pid = runInBackground(logFile, childTaskArgv, opts.cwd);
    console.log(`[task] 🚀 后台启动成功 (PID: ${pid})`);
    console.log(`[task] 💡 查看日志: tail -f ${logFile}`);

    return {
      taskId,
      command: opts.commandDisplay,
      success: true,
      exitCode: 0,
      duration: Date.now() - startTime,
      logFile,
      outputTail: `(后台运行中, PID: ${pid})`,
      pid,
    };
  }

  // ── 前台模式 ──
  const result: Omit<ITaskResult, 'taskId'> = await runForeground(
    opts.commandArgs, opts.commandDisplay, logFile, opts.cwd, opts.timeout,
  );

  const fullResult: ITaskResult = { taskId, ...result };

  console.log('');
  console.log(`[task] ${fullResult.success ? '✅ 完成' : '❌ 失败'} | 耗时: ${formatDuration(fullResult.duration)}`);

  // ── 发送通知 ──
  if (opts.notify !== false) {
    await sendTaskNotification(fullResult, opts.clientId, opts.conversationId);
  }

  return fullResult;
}
