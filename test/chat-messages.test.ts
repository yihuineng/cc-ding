import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { appendChatMessage, readChatMessages, closeDatabase } from '../src/biz/chat-messages';
import type { IChatMessage } from '../src/biz/types';

describe('chat-messages (SQLite)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-messages-test-'));
  });

  afterEach(() => {
    closeDatabase(tempDir);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('appendChatMessage 创建新数据库并追加消息', () => {
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
    assert.strictEqual(messages[0].id, 'msg1');
    assert.strictEqual(messages[0].content, 'hello');
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

  it('readChatMessages 空数据库返回空数组', () => {
    const messages = readChatMessages(tempDir);
    assert.deepStrictEqual(messages, []);
  });

  it('replaceLastAssistant 替换最后一条 assistant 消息', () => {
    const msg1: IChatMessage = { id: 'msg1', role: 'user', content: 'question', source: 'web', timestamp: 1000 };
    const msg2: IChatMessage = { id: 'msg2', role: 'assistant', content: 'answer1', source: 'web', timestamp: 2000 };

    appendChatMessage(tempDir, msg1);
    appendChatMessage(tempDir, msg2);

    // 替换最后一条 assistant 消息（时间差 < 10秒）
    const msg3: IChatMessage = { id: 'msg3', role: 'assistant', content: 'answer2', source: 'web', timestamp: 2500 };
    appendChatMessage(tempDir, msg3, { replaceLastAssistant: true });

    const messages = readChatMessages(tempDir);
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

    appendChatMessage(tempDir, msg);

    const messages = readChatMessages(tempDir);
    assert.strictEqual(messages.length, 1);
    assert.deepStrictEqual(messages[0].attachments, msg.attachments);
    assert.deepStrictEqual(messages[0].quote, msg.quote);
  });
});

describe('chat-messages migration (JSON -> SQLite)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-migration-test-'));
  });

  afterEach(() => {
    closeDatabase(tempDir);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('自动迁移 messages.json 到 SQLite', () => {
    const jsonPath = path.join(tempDir, 'messages.json');
    const messages: IChatMessage[] = [
      { id: 'msg1', role: 'user', content: 'hello', source: 'web', timestamp: 1000 },
      { id: 'msg2', role: 'assistant', content: 'world', source: 'web', timestamp: 2000 },
    ];

    // 创建旧的 JSON 文件
    fs.writeFileSync(jsonPath, JSON.stringify({ messages }, null, 2), 'utf-8');

    // 触发迁移
    const readMessages = readChatMessages(tempDir);

    // 验证迁移成功
    assert.strictEqual(readMessages.length, 2);
    assert.strictEqual(readMessages[0].id, 'msg1');
    assert.strictEqual(readMessages[1].id, 'msg2');

    // 验证 JSON 文件已备份
    assert.strictEqual(fs.existsSync(jsonPath), false);
    assert.strictEqual(fs.existsSync(jsonPath + '.bak'), true);

    // 验证 SQLite 数据库已创建
    const dbPath = path.join(tempDir, 'messages.db');
    assert.strictEqual(fs.existsSync(dbPath), true);
  });

  it('迁移失败时保留原 JSON 文件', () => {
    const jsonPath = path.join(tempDir, 'messages.json');

    // 创建损坏的 JSON 文件
    fs.writeFileSync(jsonPath, '{ invalid json }', 'utf-8');

    // 尝试读取（会触发迁移失败）
    const messages = readChatMessages(tempDir);

    // 验证返回空数组
    assert.deepStrictEqual(messages, []);

    // 验证原 JSON 文件未被删除
    assert.strictEqual(fs.existsSync(jsonPath), true);
  });
});
