import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { appendChatMessage, readChatMessages } from '../src/biz/chat-messages';
import type { IChatMessage } from '../src/biz/types';

describe('chat-messages', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-messages-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('appendChatMessage 创建新文件并追加消息', () => {
    const msg1: IChatMessage = {
      id: 'msg1',
      role: 'user',
      content: 'hello',
      source: 'web',
      timestamp: 1000,
    };
    appendChatMessage(tempDir, msg1);

    const messages = readChatMessages(tempDir);
    assert.strictEqual(messages.length, 1);
    assert.deepStrictEqual(messages[0], msg1);
  });

  it('appendChatMessage 追加多条消息', () => {
    const msg1: IChatMessage = { id: 'msg1', role: 'user', content: 'a', source: 'web', timestamp: 1000 };
    const msg2: IChatMessage = { id: 'msg2', role: 'assistant', content: 'b', source: 'web', timestamp: 2000 };

    appendChatMessage(tempDir, msg1);
    appendChatMessage(tempDir, msg2);

    const messages = readChatMessages(tempDir);
    assert.strictEqual(messages.length, 2);
    assert.strictEqual(messages[0].id, 'msg1');
    assert.strictEqual(messages[1].id, 'msg2');
  });

  it('readChatMessages 支持 since 过滤', () => {
    const msg1: IChatMessage = { id: 'msg1', role: 'user', content: 'a', source: 'web', timestamp: 1000 };
    const msg2: IChatMessage = { id: 'msg2', role: 'assistant', content: 'b', source: 'web', timestamp: 2000 };
    const msg3: IChatMessage = { id: 'msg3', role: 'user', content: 'c', source: 'web', timestamp: 3000 };

    appendChatMessage(tempDir, msg1);
    appendChatMessage(tempDir, msg2);
    appendChatMessage(tempDir, msg3);

    const messages = readChatMessages(tempDir, { since: 1500 });
    assert.strictEqual(messages.length, 2);
    assert.strictEqual(messages[0].id, 'msg2');
    assert.strictEqual(messages[1].id, 'msg3');
  });

  it('readChatMessages 支持 limit 限制', () => {
    for (let i = 0; i < 10; i++) {
      appendChatMessage(tempDir, { id: `msg${i}`, role: 'user', content: `msg ${i}`, source: 'web', timestamp: i * 1000 });
    }

    const messages = readChatMessages(tempDir, { limit: 3 });
    assert.strictEqual(messages.length, 3);
    assert.strictEqual(messages[0].id, 'msg0');
    assert.strictEqual(messages[2].id, 'msg2');
  });

  it('readChatMessages 文件不存在时返回空数组', () => {
    const messages = readChatMessages(tempDir);
    assert.deepStrictEqual(messages, []);
  });
});
