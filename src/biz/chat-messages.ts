import fs from 'fs';
import path from 'path';
import type { IChatMessage } from './types';

const MESSAGES_FILE = 'messages.json';

interface MessagesFile {
  messages: IChatMessage[];
}

/**
 * 追加消息到 messages.json
 * @param opts.replaceLastAssistant 如果为 true，替换最后一条 assistant 消息（用于 web 会话避免重试导致重复）
 */
export function appendChatMessage(convDir: string, msg: IChatMessage, opts?: { replaceLastAssistant?: boolean }): void {
  const filePath = path.join(convDir, MESSAGES_FILE);

  let data: MessagesFile = { messages: [] };
  if (fs.existsSync(filePath)) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      data = JSON.parse(content) as MessagesFile;
    } catch (err) {
      console.error('[chat-messages] 读取 messages.json 失败，将覆盖:', err);
    }
  }

  // Web 会话：如果最后一条是 assistant 消息且时间相近（10秒内），替换它（避免重试/多次响应导致重复）
  if (opts?.replaceLastAssistant && msg.role === 'assistant') {
    const lastMsg = data.messages[data.messages.length - 1];
    if (lastMsg && lastMsg.role === 'assistant' && lastMsg.source === 'web' &&
        Math.abs(msg.timestamp - lastMsg.timestamp) < 10000) {
      data.messages[data.messages.length - 1] = msg;
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
      return;
    }
  }

  data.messages.push(msg);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

export function readChatMessages(
  convDir: string,
  opts?: { since?: number; limit?: number },
): IChatMessage[] {
  const filePath = path.join(convDir, MESSAGES_FILE);

  if (!fs.existsSync(filePath)) {
    return [];
  }

  let data: MessagesFile = { messages: [] };
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    data = JSON.parse(content) as MessagesFile;
  } catch (err) {
    console.error('[chat-messages] 读取 messages.json 失败:', err);
    return [];
  }

  let messages = data.messages;

  if (opts?.since !== undefined) {
    messages = messages.filter(m => m.timestamp > opts.since!);
  }

  if (opts?.limit !== undefined) {
    messages = messages.slice(0, opts.limit);
  }

  return messages;
}
