import fs from 'fs';
import path from 'path';
import os from 'os';
import type { DingClaude } from './cc-ding-cli';
import { timestamp } from './session';
import {
  uploadMediaToDingTalk,
  sendGroupImageMessage,
  sendGroupFileMessage,
  isImageFile,
  sendDingMessage,
} from './messaging';

// ==================== 接口定义 ====================

export interface ISendSignal {
  type: 'image' | 'file';
  path: string;         // 本地文件绝对路径
  conversationId: string;
  caption?: string;     // 附加说明文字
  timestamp: number;
}

// ==================== CLI 端：写入信号文件 ====================

/**
 * 供 CLI 命令调用（不需要 DingClaude 实例）
 */
export function writeSendSignal(clientId: string, signal: ISendSignal): void {
  const homeDir = os.homedir();
  const queueDir = path.join(homeDir, '.cc-ding', clientId, '.send-queue');
  fs.mkdirSync(queueDir, { recursive: true });
  const fileName = `${Date.now()}_${Math.random().toString(36).substring(2, 8)}.json`;
  fs.writeFileSync(path.join(queueDir, fileName), JSON.stringify(signal), 'utf-8');
}

// ==================== SendQueueProcessor ====================

export class SendQueueProcessor {
  private dc: DingClaude;
  private timer: NodeJS.Timeout | null = null;
  private queueDir: string;

  constructor(dc: DingClaude) {
    this.dc = dc;
    this.queueDir = path.join(dc.getClientDir(), '.send-queue');
    // 创建队列目录
    if (!fs.existsSync(this.queueDir)) {
      fs.mkdirSync(this.queueDir, { recursive: true });
    }
  }

  /**
   * 启动轮询，每 1000ms 检查一次
   */
  start(): void {
    this.timer = setInterval(() => {
      this.processQueue().catch(err => {
        console.error(`[${timestamp()}] SendQueueProcessor 处理异常:`, err);
      });
    }, 1000);
    this.timer.unref?.();
    // 启动时立即处理一次（处理进程未运行时积压的信号文件）
    this.processQueue().catch(err => {
      console.error(`[${timestamp()}] SendQueueProcessor 启动处理异常:`, err);
    });
  }

  /**
   * 停止轮询
   */
  destroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // ==================== 内部方法 ====================

  private async processQueue(): Promise<void> {
    if (!fs.existsSync(this.queueDir)) return;

    const files = fs.readdirSync(this.queueDir).filter(f => f.endsWith('.json'));
    if (files.length === 0) return;

    // 按文件名排序（时间戳在前，自然按时间顺序处理）
    files.sort();

    for (const fileName of files) {
      const filePath = path.join(this.queueDir, fileName);

      // 读取信号文件
      let signal: ISendSignal;
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        signal = JSON.parse(content) as ISendSignal;
      } catch (err) {
        console.warn(`[${timestamp()}] 信号文件解析失败，跳过: ${filePath}`, err);
        fs.unlinkSync(filePath);
        continue;
      }

      // 检查会话是否注册
      const convCfg = this.dc.config.conversations.find(c => c.conversationId === signal.conversationId);
      if (!convCfg) {
        console.warn(`[${timestamp()}] 会话 ${signal.conversationId} 未注册，跳过信号: ${fileName}`);
        fs.unlinkSync(filePath);
        continue;
      }

      // 处理信号
      const success = await this.handleSignal(signal, convCfg);

      // 无论成功失败都删除信号文件（避免重复处理）
      try {
        fs.unlinkSync(filePath);
      } catch {
        // 忽略删除失败
      }

      if (!success) {
        console.warn(`[${timestamp()}] 信号处理失败: ${fileName}`);
      }
    }
  }

  private async handleSignal(
    signal: ISendSignal,
    convCfg: import('./types').IConversation,
  ): Promise<boolean> {
    const { conversationId, caption } = signal;
    const sessionWebhook = convCfg.dingToken || '';
    const isSingleChat = convCfg.conversationType === '1';

    if (signal.type === 'image') {
      return await this.handleImage(signal, conversationId, sessionWebhook, caption, isSingleChat);
    }
    return await this.handleFile(signal, conversationId, sessionWebhook, caption, isSingleChat);
  }

  // ==================== 图片推送流程 ====================

  private async handleImage(
    signal: ISendSignal,
    conversationId: string,
    sessionWebhook: string,
    caption: string | undefined,
    isSingleChat: boolean,
  ): Promise<boolean> {
    const filePath = signal.path;

    // 检查文件是否存在
    if (!fs.existsSync(filePath)) {
      console.warn(`[${timestamp()}] 图片文件不存在: ${filePath}`);
      return false;
    }

    // 1. 上传图片获取 mediaId
    const mediaId = await uploadMediaToDingTalk(this.dc, filePath);
    if (!mediaId) {
      console.warn(`[${timestamp()}] 图片上传失败: ${filePath}`);
      // 降级：用 markdown 发送文件路径
      await sendDingMessage(this.dc, {
        conversationId,
        sessionWebhook,
        content: `📎 图片上传失败，文件路径: \`${filePath}\`${caption ? `\n说明: ${caption}` : ''}`,
        msgType: 'markdown',
      });
      return false;
    }

    // 2. 发送图片
    if (isSingleChat) {
      // 单聊：用 markdown 消息 ![](mediaId) 发送
      const content = caption
        ? `![${caption}](${mediaId})\n${caption}`
        : `![](${mediaId})`;
      await sendDingMessage(this.dc, {
        conversationId,
        sessionWebhook,
        content,
        msgType: 'markdown',
      });
    } else {
      // 群聊：先用 sendGroupImageMessage 发送独立图片
      const ok = await sendGroupImageMessage(this.dc, conversationId, mediaId);
      if (!ok) {
        // 失败降级到 markdown 方式
        console.warn(`[${timestamp()}] sendGroupImageMessage 失败，降级到 markdown`);
        const content = caption
          ? `![${caption}](${mediaId})\n${caption}`
          : `![](${mediaId})`;
        await sendDingMessage(this.dc, {
          conversationId,
          sessionWebhook,
          content,
          msgType: 'markdown',
        });
      } else if (caption) {
        // 发送成功后，如果 caption 不为空，再发一条 markdown 消息
        await sendDingMessage(this.dc, {
          conversationId,
          sessionWebhook,
          content: caption,
          msgType: 'markdown',
        });
      }
    }

    return true;
  }

  // ==================== 文件推送流程 ====================

  private async handleFile(
    signal: ISendSignal,
    conversationId: string,
    sessionWebhook: string,
    caption: string | undefined,
    isSingleChat: boolean,
  ): Promise<boolean> {
    const filePath = signal.path;

    // 检查文件是否存在
    if (!fs.existsSync(filePath)) {
      console.warn(`[${timestamp()}] 文件不存在: ${filePath}`);
      return false;
    }

    // 1. 如果是图片类型，走图片推送流程
    if (isImageFile(filePath)) {
      return await this.handleImage(signal, conversationId, sessionWebhook, caption, isSingleChat);
    }

    // 2. 上传文件获取 mediaId
    const mediaId = await uploadMediaToDingTalk(this.dc, filePath);
    const fileName = path.basename(filePath);
    const fileSize = fs.statSync(filePath).size;

    if (!mediaId) {
      console.warn(`[${timestamp()}] 文件上传失败: ${filePath}`);
      // 降级：用 markdown 消息提示文件路径
      const sizeStr = fileSize > 1024 * 1024
        ? `${(fileSize / (1024 * 1024)).toFixed(1)}MB`
        : `${(fileSize / 1024).toFixed(1)}KB`;
      await sendDingMessage(this.dc, {
        conversationId,
        sessionWebhook,
        content: `📎 文件上传失败\n文件名: ${fileName}\n大小: ${sizeStr}\n路径: \`${filePath}\`${caption ? `\n说明: ${caption}` : ''}`,
        msgType: 'markdown',
      });
      return false;
    }

    // 3. 发送文件
    if (isSingleChat) {
      // 单聊：用 markdown 消息展示文件名、大小、路径
      const sizeStr = fileSize > 1024 * 1024
        ? `${(fileSize / (1024 * 1024)).toFixed(1)}MB`
        : `${(fileSize / 1024).toFixed(1)}KB`;
      const content = `📎 **${fileName}** (${sizeStr})${caption ? `\n${caption}` : ''}\n\`${filePath}\``;
      await sendDingMessage(this.dc, {
        conversationId,
        sessionWebhook,
        content,
        msgType: 'markdown',
      });
    } else {
      // 群聊：发送独立文件
      const ok = await sendGroupFileMessage(this.dc, conversationId, mediaId, fileName);
      if (!ok) {
        // 失败降级到 markdown
        console.warn(`[${timestamp()}] sendGroupFileMessage 失败，降级到 markdown`);
        const sizeStr = fileSize > 1024 * 1024
          ? `${(fileSize / (1024 * 1024)).toFixed(1)}MB`
          : `${(fileSize / 1024).toFixed(1)}KB`;
        await sendDingMessage(this.dc, {
          conversationId,
          sessionWebhook,
          content: `📎 **${fileName}** (${sizeStr})${caption ? `\n${caption}` : ''}`,
          msgType: 'markdown',
        });
      } else if (caption) {
        // 发送成功后，如果 caption 不为空，再发一条
        await sendDingMessage(this.dc, {
          conversationId,
          sessionWebhook,
          content: caption,
          msgType: 'markdown',
        });
      }
    }

    return true;
  }
}
