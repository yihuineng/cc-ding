/**
 * destroyConversation 单元测试
 *
 * 验证 /destroy 命令在关联群场景下不会误删共享工作目录，
 * 以及用户自定义 workDir 时不被删除。
 *
 * 运行: npx mocha test/session-destroy.test.ts
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { destroyConversation, getConversationDir } from '../src/biz/session';

// ============================================================
// 测试隔离
// ============================================================

const TEST_CLIENT_ID = 'dingtestdestroy001';
const TEST_CLIENT_DIR = path.join(os.homedir(), '.cc-ding', TEST_CLIENT_ID);

// ============================================================
// Mock DingClaude 实例
// ============================================================

interface MockDingClaude {
  clientId: string;
  config: {
    conversations: Array<{
      conversationId: string;
      conversationType?: string;
      conversationTitle?: string;
      linkConversationId?: string;
      workDir?: string;
    }>;
  };
  activeSessions: Map<string, any>;
  getConversationConfig: (conversationId: string) => any;
  cronEngine?: { listJobs: (id: string) => any[]; removeJob: (id: string) => boolean };
  timerEngine?: { listTimers: (id: string) => any[]; removeTimer: (id: string) => boolean };
}

/**
 * 创建一个 mock DingClaude。
 * 每个 conversationId 会在 TEST_CLIENT_DIR 下创建对应的 hash 目录。
 */
function createMockDc(opts: {
  conversations: Array<{
    conversationId: string;
    linkConversationId?: string;
    conversationTitle?: string;
    workDir?: string;
  }>;
}): MockDingClaude {
  // 清理并重建测试目录
  if (fs.existsSync(TEST_CLIENT_DIR)) {
    fs.rmSync(TEST_CLIENT_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(TEST_CLIENT_DIR, { recursive: true });

  // 为每个会话创建工作目录（跳过有 workDir 的，用户会自己创建）
  for (const conv of opts.conversations) {
    if (conv.workDir) {
      // 如果指定了 workDir，确保它存在
      if (!fs.existsSync(conv.workDir)) {
        fs.mkdirSync(conv.workDir, { recursive: true });
      }
      fs.writeFileSync(path.join(conv.workDir, '.marker'), conv.conversationId, 'utf-8');
    } else {
      const convId = conv.linkConversationId || conv.conversationId;
      const hash = crypto.createHash('md5').update(convId).digest('hex');
      const convDir = path.join(TEST_CLIENT_DIR, hash);
      if (!fs.existsSync(convDir)) {
        fs.mkdirSync(convDir, { recursive: true });
        fs.writeFileSync(path.join(convDir, '.marker'), conv.conversationId, 'utf-8');
      }
    }
  }

  return {
    clientId: TEST_CLIENT_ID,
    config: { conversations: opts.conversations },
    activeSessions: new Map(),
    getConversationConfig: (cid: string) => opts.conversations.find(c => c.conversationId === cid),
    cronEngine: {
      listJobs: () => [],
      removeJob: () => true,
    },
    timerEngine: {
      listTimers: () => [],
      removeTimer: () => true,
    },
  };
}

/** 获取 hash 后的工作目录路径（默认路径，不含 workDir） */
function getHashedDir(conversationId: string, conversations: Array<{
  conversationId: string;
  linkConversationId?: string;
}>): string {
  const conv = conversations.find(c => c.conversationId === conversationId);
  const hash = crypto.createHash('md5').update(conv?.linkConversationId || conversationId).digest('hex');
  return path.join(TEST_CLIENT_DIR, hash);
}

// ============================================================
// 测试
// ============================================================

describe('destroyConversation', () => {
  after(() => {
    // 清理测试目录
    try {
      if (fs.existsSync(TEST_CLIENT_DIR)) {
        fs.rmSync(TEST_CLIENT_DIR, { recursive: true, force: true });
      }
    } catch { /* ignore */ }
  });

  describe('普通会话（无 linkConversationId、无 workDir）', () => {
    it('应该删除工作目录', async () => {
      const dc = createMockDc({
        conversations: [
          { conversationId: 'conv-normal', conversationTitle: '普通群' },
        ],
      });

      const dir = getHashedDir('conv-normal', dc.config.conversations);
      assert.ok(fs.existsSync(dir), '工作目录应该存在');

      const result = await destroyConversation(dc as any, 'conv-normal');

      assert.ok(result.success, `destroy 应该成功: ${JSON.stringify(result.steps)}`);
      assert.ok(!fs.existsSync(dir), '工作目录应该被删除');
    });
  });

  describe('关联群（有 linkConversationId）', () => {
    it('不应该删除共享工作目录', async () => {
      const sharedConvId = 'conv-shared';
      const linkedConvId = 'conv-linked';

      const dc = createMockDc({
        conversations: [
          { conversationId: sharedConvId, conversationTitle: '主群' },
          { conversationId: linkedConvId, conversationTitle: '关联群', linkConversationId: sharedConvId },
        ],
      });

      const sharedDir = getHashedDir(linkedConvId, dc.config.conversations);
      assert.ok(fs.existsSync(sharedDir), '共享工作目录应该存在');

      const result = await destroyConversation(dc as any, linkedConvId);

      assert.ok(result.success, `destroy 应该成功: ${JSON.stringify(result.steps)}`);
      assert.ok(fs.existsSync(sharedDir), '共享工作目录不应该被删除（关联群仍在使用）');

      const dirStep = result.steps.find(s => s.label === '工作目录');
      assert.ok(dirStep, '应该有工作目录步骤');
      assert.ok(dirStep?.detail?.includes('保留'), '关联群的工作目录应该被保留');
    });

    it('销毁主群（无 linkConversationId）应该删除目录', async () => {
      const sharedConvId = 'conv-shared-2';
      const linkedConvId = 'conv-linked-2';

      const dc = createMockDc({
        conversations: [
          { conversationId: sharedConvId, conversationTitle: '主群2' },
          { conversationId: linkedConvId, conversationTitle: '关联群2', linkConversationId: sharedConvId },
        ],
      });

      const sharedDir = getHashedDir(sharedConvId, dc.config.conversations);
      assert.ok(fs.existsSync(sharedDir), '共享工作目录应该存在');

      const result = await destroyConversation(dc as any, sharedConvId);

      assert.ok(result.success, `destroy 应该成功: ${JSON.stringify(result.steps)}`);
      assert.ok(!fs.existsSync(sharedDir), '主群的工作目录应该被删除');
    });
  });

  describe('用户自定义 workDir', () => {
    it('不应该删除用户指定的工作目录', async () => {
      const customDir = path.join(os.tmpdir(), 'cc-ding-test-workdir-custom');

      const dc = createMockDc({
        conversations: [
          { conversationId: 'conv-workdir', conversationTitle: '自定义目录群', workDir: customDir },
        ],
      });

      assert.ok(fs.existsSync(customDir), '自定义工作目录应该存在');

      const result = await destroyConversation(dc as any, 'conv-workdir');

      assert.ok(result.success, `destroy 应该成功: ${JSON.stringify(result.steps)}`);
      assert.ok(fs.existsSync(customDir), '用户自定义工作目录不应该被删除');

      const dirStep = result.steps.find(s => s.label === '工作目录');
      assert.ok(dirStep, '应该有工作目录步骤');
      assert.ok(dirStep?.detail?.includes('保留') && dirStep?.detail?.includes('用户自定义'), '应该标记为用户自定义保留');
    });

    it('workDir 优先级高于 linkConversationId', async () => {
      const customDir = path.join(os.tmpdir(), 'cc-ding-test-workdir-link');

      const dc = createMockDc({
        conversations: [
          { conversationId: 'conv-shared-x', conversationTitle: '主群X' },
          { conversationId: 'conv-linked-x', conversationTitle: '关联群X', linkConversationId: 'conv-shared-x', workDir: customDir },
        ],
      });

      // getConversationDir 应该返回 workDir，不是 hash 目录
      const dir = getConversationDir(dc as any, 'conv-linked-x');
      assert.strictEqual(dir, customDir, 'getConversationDir 应该返回 workDir');

      const result = await destroyConversation(dc as any, 'conv-linked-x');

      assert.ok(result.success, `destroy 应该成功: ${JSON.stringify(result.steps)}`);
      assert.ok(fs.existsSync(customDir), '自定义 workDir 不应该被删除');

      const dirStep = result.steps.find(s => s.label === '工作目录');
      assert.ok(dirStep?.detail?.includes('用户自定义'), '应该标记为用户自定义保留');
    });
  });
});
