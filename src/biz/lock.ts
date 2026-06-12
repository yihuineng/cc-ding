import { timestamp } from './session';
import { isWindows } from './platform';
import fs from 'fs';
import path from 'path';

/**
 * 检查并写入 PID 锁文件，防止同一 clientId 重复启动
 * 如果已有进程在运行则退出，否则写入当前 PID 并注册退出清理
 */
export function acquirePidLock(clientDir: string, clientId: string): void {
  const pidFile = path.join(clientDir, '.pid.lock');
  if (fs.existsSync(pidFile)) {
    try {
      const existingPid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
      if (!isNaN(existingPid)) {
        // 检查进程是否仍在运行
        try {
          process.kill(existingPid, 0); // signal 0 只检查进程是否存在，不发送信号
          console.error(`[FATAL] clientId "${clientId}" 已有运行中的进程 (PID: ${existingPid})`);
          console.error(`  如需强制启动，请先停止已有进程或删除锁文件: ${pidFile}`);
          process.exit(1);
        } catch {
          // 进程已不存在，清理过期的锁文件
          console.log(`[${timestamp()}] 检测到过期锁文件 (PID: ${existingPid} 已退出)，自动清理`);
        }
      }
    } catch {
      // 锁文件读取异常，忽略继续
    }
  }
  // 写入当前 PID
  fs.writeFileSync(pidFile, String(process.pid), 'utf-8');
  // 注册退出清理
  const cleanup = () => {
    try { fs.unlinkSync(pidFile); } catch { /* ignore */ }
  };
  process.on('exit', cleanup);
  // SIGINT/SIGTERM 在 Windows 上部分场景不支持，仅 Unix 注册
  if (!isWindows()) {
    process.on('SIGINT', () => { cleanup(); process.exit(130); });
    process.on('SIGTERM', () => { cleanup(); process.exit(143); });
  }
}
