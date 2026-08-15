import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { appendChatMessage, readChatMessages, closeDatabase } from '../src/biz/chat-messages';
import type { IChatMessage } from '../src/biz/types';

describe('chat-messages (SQLite)', () => {
  const testClientId = 'test-client-' + Date.now();

  afterEach(() => {
    closeDatabase(testClientId);
    // 清理测试数据库
    const dbDir = path.join(os.homedir(), '.cc-ding', testClientId);
    if (fs.existsSync(dbDir)) {
      fs.rmSync(dbDir, { recursive: true, force: true });
    }
  });

  it('appendChatMessage 创建新数据库并追加消息', () => {
    const msg1: IChatMessage = {
      id: 'msg1',
      role: 'user',
      content: 'hello',
      source: 'web',
      timestamp: 1000,
    };
    appendChatMessage(testClientId, 'test-conv', msg1);

    const messages = readChatMessages(testClientId, 'test-conv');
    assert.strictEqual(messages.length, 1);
    assert.strictEqual(messages[0].id, 'msg1');
    assert.strictEqual(messages[0].content, 'hello');
  });

  it('appendChatMessage 追加多条消息', () => {
    const msg1: IChatMessage = { id: 'msg1', role: 'user', content: 'a', source: 'web', timestamp: 1000 };
    const msg2: IChatMessage = { id: 'msg2', role: 'assistant', content: 'b', source: 'web', timestamp: 2000 };

    appendChatMessage(testClientId, 'test-conv', msg1);
    appendChatMessage(testClientId, 'test-conv', msg2);

    const messages = readChatMessages(testClientId, 'test-conv');
    assert.strictEqual(messages.length, 2);
    assert.strictEqual(messages[0].id, 'msg1');
    assert.strictEqual(messages[1].id, 'msg2');
  });

  it('readChatMessages 支持 since 过滤', () => {
    const msg1: IChatMessage = { id: 'msg1', role: 'user', content: 'a', source: 'web', timestamp: 1000 };
    const msg2: IChatMessage = { id: 'msg2', role: 'assistant', content: 'b', source: 'web', timestamp: 2000 };
    const msg3: IChatMessage = { id: 'msg3', role: 'user', content: 'c', source: 'web', timestamp: 3000 };

    appendChatMessage(testClientId, 'test-conv', msg1);
    appendChatMessage(testClientId, 'test-conv', msg2);
    appendChatMessage(testClientId, 'test-conv', msg3);

    const messages = readChatMessages(testClientId, 'test-conv', { since: 1500 });
    assert.strictEqual(messages.length, 2);
    assert.strictEqual(messages[0].id, 'msg2');
    assert.strictEqual(messages[1].id, 'msg3');
  });

  it('readChatMessages 支持 limit 限制', () => {
    for (let i = 0; i < 10; i++) {
      appendChatMessage(testClientId, 'test-conv', { id: `msg${i}`, role: 'user', content: `msg ${i}`, source: 'web', timestamp: i * 1000 });
    }

    const messages = readChatMessages(testClientId, 'test-conv', { limit: 3 });
    assert.strictEqual(messages.length, 3);
    assert.strictEqual(messages[0].id, 'msg0');
    assert.strictEqual(messages[2].id, 'msg2');
  });

  it('readChatMessages 空数据库返回空数组', () => {
    const messages = readChatMessages(testClientId, 'test-conv');
    assert.deepStrictEqual(messages, []);
  });

  it('replaceLastAssistant 替换最后一条 assistant 消息', () => {
    const msg1: IChatMessage = { id: 'msg1', role: 'user', content: 'question', source: 'web', timestamp: 1000 };
    const msg2: IChatMessage = { id: 'msg2', role: 'assistant', content: 'answer1', source: 'web', timestamp: 2000 };

    appendChatMessage(testClientId, 'test-conv', msg1);
    appendChatMessage(testClientId, 'test-conv', msg2);

    // 替换最后一条 assistant 消息（时间差 < 10秒）
    const msg3: IChatMessage = { id: 'msg3', role: 'assistant', content: 'answer2', source: 'web', timestamp: 2500 };
    appendChatMessage(testClientId, 'test-conv', msg3, { replaceLastAssistant: true });

    const messages = readChatMessages(testClientId, 'test-conv');
    assert.strictEqual(messages.length, 2);
    assert.strictEqual(messages[1].content, 'answer2');
    assert.strictEqual(messages[1].id, 'msg2'); // ID 保持不变
  });

  it('支持 attachments 和 quote 字段', () => {
    const msg: IChatMessage = {
      id: 'msg1',
      role: 'user',
      content: 'test',
      source: 'web',
      timestamp: 1000,
      attachments: [{ type: 'image', fileId: 'file1', fileName: 'test.png', mimeType: 'image/png', size: 1024, url: 'http://example.com/img.png' }],
      quote: { messageId: 'quoted-msg', content: 'quoted content' },
    };

    appendChatMessage(testClientId, 'test-conv', msg);

    const messages = readChatMessages(testClientId, 'test-conv');
    assert.strictEqual(messages.length, 1);
    assert.deepStrictEqual(messages[0].attachments, msg.attachments);
    assert.deepStrictEqual(messages[0].quote, msg.quote);
  });
});
