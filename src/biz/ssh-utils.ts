/**
 * SSH 工具模块
 * 用于远程管理 cc-ding 客户端
 * 通过 SSH 连接远程机器，读写配置文件和执行 pm2 命令
 */

import { Client } from 'ssh2';
import type { ConnectConfig } from 'ssh2';

export interface ISshConfig {
  host: string;
  port: number;
  user: string;
  password: string;
}

export interface IRemoteClient {
  clientId: string;
  ssh: ISshConfig;
}

// SSH 连接池（保留用于未来扩展）
const sshConnections = new Map<string, Client>();

/**
 * 获取 SSH 连接
 */
function getSshConnection(config: ISshConfig): Promise<Client> {
  return new Promise((resolve, reject) => {
    // 简单实现：每次创建新连接（避免连接状态检查问题）
    const conn = new Client();

    conn.on('ready', () => {
      resolve(conn);
    });

    conn.on('error', (err) => {
      reject(err);
    });

    conn.on('close', () => {
      // 连接关闭时自动清理
    });

    const connectConfig: ConnectConfig = {
      host: config.host,
      port: config.port,
      username: config.user,
      password: config.password,
      readyTimeout: 10000,
    };

    conn.connect(connectConfig);
  });
}

/**
 * 读取远程文件内容
 */
export async function sshReadFile(
  config: ISshConfig,
  remotePath: string,
): Promise<string> {
  const conn = await getSshConnection(config);

  return new Promise((resolve, reject) => {
    conn.exec(`cat ${remotePath}`, (err, stream) => {
      if (err) {
        reject(err);
        return;
      }

      let data = '';
      stream.on('data', (chunk: Buffer) => {
        data += chunk.toString();
      });

      stream.stderr.on('data', (chunk: Buffer) => {
        reject(new Error(chunk.toString()));
      });

      stream.on('close', (code: number) => {
        if (code === 0) {
          resolve(data);
        } else {
          reject(new Error(`Command failed with code ${code}`));
        }
      });

      stream.on('error', reject);
    });
  });
}

/**
 * 写入远程文件
 */
export async function sshWriteFile(
  config: ISshConfig,
  remotePath: string,
  content: string,
): Promise<void> {
  const conn = await getSshConnection(config);

  return new Promise((resolve, reject) => {
    conn.exec(`cat > ${remotePath} << 'ENDOFFILE'\n${content}\nENDOFFILE`, (err, stream) => {
      if (err) {
        reject(err);
        return;
      }

      let stderr = '';
      stream.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      stream.on('close', (code: number) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(stderr || `Command failed with code ${code}`));
        }
      });

      stream.on('error', reject);
    });
  });
}

/**
 * 执行远程命令
 */
export async function sshExec(
  config: ISshConfig,
  command: string,
): Promise<string> {
  const conn = await getSshConnection(config);

  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) {
        reject(err);
        return;
      }

      let stdout = '';
      let stderr = '';

      stream.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      stream.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      stream.on('close', (code: number) => {
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(stderr || `Command failed with code ${code}`));
        }
      });

      stream.on('error', reject);
    });
  });
}

/**
 * 检查远程 cc-ding 客户端是否存在
 */
export async function sshCheckClientExists(
  config: ISshConfig,
  clientId: string,
): Promise<boolean> {
  try {
    const homeDir = await sshExec(config, 'echo $HOME');
    const configPath = `${homeDir.trim()}/.cc-ding/${clientId}/config.json`;
    await sshExec(config, `test -f ${configPath}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * 关闭所有 SSH 连接
 */
export function closeAllSshConnections(): void {
  sshConnections.forEach((conn) => {
    conn.end();
  });
  sshConnections.clear();
}
