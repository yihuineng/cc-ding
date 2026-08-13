import fs from 'fs';
import path from 'path';
import type { DingClaude } from './cc-ding-cli';
import type { IChatSignal } from './types';

export function writeChatSignal(clientDir: string, signal: IChatSignal): void {
  const queueDir = path.join(clientDir, '.chat-queue');
  fs.mkdirSync(queueDir, { recursive: true });
  const fileName = `${Date.now()}_${Math.random().toString(36).substring(2, 8)}.json`;
  fs.writeFileSync(path.join(queueDir, fileName), JSON.stringify(signal), 'utf-8');
}

export class ChatQueueProcessor {
  private dc: DingClaude;
  private timer: NodeJS.Timeout | null = null;
  private queueDir: string;

  constructor(dc: DingClaude) {
    this.dc = dc;
    this.queueDir = path.join(dc.getClientDir(), '.chat-queue');
    if (!fs.existsSync(this.queueDir)) {
      fs.mkdirSync(this.queueDir, { recursive: true });
    }
  }

  start(): void {
    this.timer = setInterval(() => {
      this.processQueue().catch(err => {
        console.error('[ChatQueueProcessor] 处理异常:', err);
      });
    }, 1000);
    this.timer.unref?.();
    this.processQueue().catch(err => {
      console.error('[ChatQueueProcessor] 启动处理异常:', err);
    });
  }

  destroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async processQueue(): Promise<void> {
    if (!fs.existsSync(this.queueDir)) return;

    const files = fs.readdirSync(this.queueDir).filter(f => f.endsWith('.json'));
    if (files.length === 0) return;

    files.sort();

    for (const fileName of files) {
      const filePath = path.join(this.queueDir, fileName);

      let signal: IChatSignal;
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        signal = JSON.parse(content) as IChatSignal;
      } catch (err) {
        console.warn('[ChatQueueProcessor] 信号文件解析失败:', filePath, err);
        fs.unlinkSync(filePath);
        continue;
      }

      const convCfg = this.dc.config.conversations.find(c => c.conversationId === signal.conversationId);
      if (!convCfg) {
        console.warn('[ChatQueueProcessor] 会话未注册:', signal.conversationId);
        fs.unlinkSync(filePath);
        continue;
      }

      try {
        await (this.dc as any).handleWebMessage(signal, convCfg);
      } catch (err) {
        console.error('[ChatQueueProcessor] 处理信号失败:', fileName, err);
      }

      try {
        fs.unlinkSync(filePath);
      } catch {
        // ignore
      }
    }
  }
}
