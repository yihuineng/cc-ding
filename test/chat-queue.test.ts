import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { writeChatSignal, ChatQueueProcessor } from '../src/biz/chat-queue';
import type { IChatSignal } from '../src/biz/types';

describe('chat-queue', () => {
  let tempDir: string;
  let queueDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-queue-test-'));
    queueDir = path.join(tempDir, '.chat-queue');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('writeChatSignal 创建信号文件', () => {
    const signal: IChatSignal = {
      conversationId: 'conv1',
      message: 'hello',
      senderStaffId: 'web:admin',
      senderNick: 'admin',
      timestamp: Date.now(),
    };

    writeChatSignal(tempDir, signal);

    const files = fs.readdirSync(queueDir).filter(f => f.endsWith('.json'));
    assert.strictEqual(files.length, 1);

    const content = JSON.parse(fs.readFileSync(path.join(queueDir, files[0]), 'utf-8'));
    assert.strictEqual(content.conversationId, 'conv1');
    assert.strictEqual(content.message, 'hello');
  });

  it('ChatQueueProcessor 消费信号文件', async () => {
    fs.mkdirSync(queueDir, { recursive: true });

    const signal: IChatSignal = {
      conversationId: 'conv1',
      message: 'test',
      senderStaffId: 'web:admin',
      senderNick: 'admin',
      timestamp: Date.now(),
    };
    fs.writeFileSync(
      path.join(queueDir, `${Date.now()}_test.json`),
      JSON.stringify(signal),
      'utf-8',
    );

    let processed = 0;
    const mockDc = {
      getClientDir: () => tempDir,
      config: { conversations: [{ conversationId: 'conv1' }] },
      handleWebMessage: async () => { processed++; },
    };

    const processor = new ChatQueueProcessor(mockDc as any);
    await (processor as any).processQueue();

    assert.strictEqual(processed, 1);
    const remaining = fs.readdirSync(queueDir).filter(f => f.endsWith('.json'));
    assert.strictEqual(remaining.length, 0);
  });
});
