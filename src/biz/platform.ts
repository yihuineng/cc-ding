#!/usr/bin/env ts-node
/**
 * 跨平台辅助函数
 */

/** 当前是否为 Windows 平台 */
export function isWindows(): boolean {
  return process.platform === 'win32';
}

/**
 * 安全地设置文件权限（仅 Unix/Linux 生效）
 * Windows 上 chmod 无意义，直接跳过
 */
export function safeChmodSync(filePath: string, mode: number): void {
  if (isWindows()) return;
  require('fs').chmodSync(filePath, mode);
}

/**
 * 检查指定 PID 的进程是否仍在运行（跨平台）
 */
export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
