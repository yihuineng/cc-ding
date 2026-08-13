import fs from 'fs';
import path from 'path';
import type { IChatMessage } from './types';

const MESSAGES_FILE = 'messages.json';

interface MessagesFile {
  messages: IChatMessage[];
}

export function appendChatMessage(convDir: string, msg: IChatMessage): void {
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
