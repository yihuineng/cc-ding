/**
 * cc-ding 内部消息链路 E2E 测试
 *
 * 测试从钉钉消息解析 → 命令路由 → 会话管理 的完整链路。
 * 通过替换 messaging 模块的 sendDingMessage 来捕获所有发出的钉钉消息。
 *
 * 测试隔离：使用专用的测试 clientId（dingiexxdy25itrcuwtb），
 * 在 ~/.cc-ding/ 下创建独立目录，不影响生产环境。
 *
 * 运行: npx mocha test/e2e-internal.test.ts
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import { resetAllDedup } from '../src/biz/dedup';

// ============================================================
// 测试隔离：专用 clientId
// ============================================================

/** 测试专用 clientId */
const TEST_CLIENT_ID = 'dingiexxdy25itrcuwtb';
/** 测试用客户端目录 */
const TEST_CLIENT_DIR = path.join(os.homedir(), '.cc-ding', TEST_CLIENT_ID);

// ============================================================
// 消息捕获：替换 messaging 模块中的 sendDingMessage
// ============================================================

interface CapturedMsg {
  opts: {
    conversationId: string;
    content: string;
    sessionWebhook: string;
    atUserId?: string;
    msgType?: string;
  };
}

const capturedMessages: CapturedMsg[] = [];

function installMock(): void {
  const messagingMod = require('../src/biz/messaging');
  const origSend = messagingMod.sendDingMessage;
  messagingMod.sendDingMessage = async (self: any, opts: any) => {
    capturedMessages.push({ opts });
  };
  (globalThis as any).__orig_sendDingMessage = origSend;
  (globalThis as any).__messagingMod = messagingMod;
}

function uninstallMock(): void {
  const messagingMod = (globalThis as any).__messagingMod;
  const origSend = (globalThis as any).__orig_sendDingMessage;
  if (messagingMod && origSend) {
    messagingMod.sendDingMessage = origSend;
  }
  delete (globalThis as any).__orig_sendDingMessage;
  delete (globalThis as any).__messagingMod;
}

function resetCapture(): void {
  capturedMessages.length = 0;
}

function getCapturedTexts(): string[] {
  return capturedMessages.map(m => m.opts?.content ?? '').filter(Boolean);
}

// ============================================================
// Mock DWClientDownStream
// ============================================================

interface MockMsgOpts {
  content: string;
  senderNick?: string;
  senderStaffId?: string;
  conversationId?: string;
  conversationTitle?: string;
  msgtype?: string;
}

function createMockStreamMessage(opts: MockMsgOpts) {
  const {
    content,
    senderNick = '测试用户',
    senderStaffId = '17681955532',
    conversationId = 'test-cid-001',
    conversationTitle = '测试群',
    msgtype = 'text',
  } = opts;

  return {
    specVersion: '1.0',
    type: 'CALLBACK',
    headers: {
      appId: 'test-app',
      connectionId: 'test-conn',
      contentType: 'application/json',
      messageId: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      time: new Date().toISOString(),
      topic: '/v1.0/im/bot/messages/get',
    },
    data: JSON.stringify({
      senderNick,
      senderStaffId,
      conversationId,
      conversationTitle,
      conversationType: '2',
      sessionWebhook: 'https://oapi.dingtalk.com/robot/send?access_token=test',
      msgtype,
      text: { content },
    }),
  };
}

// ============================================================
// 创建测试用 DingClaude 实例（不连接真实钉钉）
// ============================================================

async function createTestDingClaude(): Promise<any> {
  // 只清除 cc-ding-cli 缓存，不清除 claude-agent（确保 prototype mock 有效）
  Object.keys(require.cache).forEach(key => {
    if (key.includes('cc-ding-cli')) {
      delete require.cache[key];
    }
  });

  const { DingClaude } = await import('../src/biz/cc-ding-cli');
  const dc = new (DingClaude as any)(TEST_CLIENT_ID);

  // Mock dingStreamClient
  const mockClient = new EventEmitter() as any;
  mockClient.connect = async () => { /* no-op */ };
  mockClient.disconnect = async () => { /* no-op */ };
  mockClient.isConnected = () => false;
  mockClient.registerCallbackListener = () => { /* no-op */ };
  mockClient.socketCallBackResponse = () => { /* no-op */ };
  mockClient.getAccessToken = async () => 'mock-access-token';
  dc.dingStreamClient = mockClient;

  return dc;
}

// ============================================================
// 测试
// ============================================================

describe('E2E: 内部消息链路测试', () => {
  let configBackup: string | null = null;

  beforeEach(() => {
    // 重置去重器状态，避免跨测试污染
    resetAllDedup();
  });

  before(() => {
    // 创建测试目录
    fs.mkdirSync(TEST_CLIENT_DIR, { recursive: true });

    // 如果已有测试 config，备份它
    const configPath = path.join(TEST_CLIENT_DIR, 'config.json');
    if (fs.existsSync(configPath)) {
      configBackup = fs.readFileSync(configPath, 'utf-8');
    }

    // 写入测试配置（专用 clientId，完全隔离）
    // clientSecret 从环境变量或 .env 文件读取，禁止硬编码到代码中
    let testClientSecret = process.env.TEST_CLIENT_SECRET;
    if (!testClientSecret) {
      // 尝试从 .env 文件读取
      const envFile = path.join(__dirname, '..', '.env');
      if (fs.existsSync(envFile)) {
        const envContent = fs.readFileSync(envFile, 'utf-8');
        const match = envContent.match(/^TEST_CLIENT_SECRET\s*=\s*(.+)$/m);
        if (match) testClientSecret = match[1].trim();
      }
    }
    if (!testClientSecret) {
      throw new Error('环境变量 TEST_CLIENT_SECRET 或 .env 文件未设置，无法运行 E2E 测试');
    }
    const testConfig = {
      clientName: 'cc-e2e-test',
      model: 'claude-sonnet-4-6-20250514',
      whiteUserList: [ '17681955532' ],
      owner: '17681955532',
      clientSecret: testClientSecret,
      defaultDingToken: 'test-token',
      conversations: [
        {
          conversationId: 'test-cid-001',
          conversationType: '2',
          conversationTitle: 'E2E 测试群',
          dingToken: 'test-ding-token',
          agent: 'claude',
          receiveReply: true,
          receiveReplyMode: 'text',
        },
      ],
    };
    fs.writeFileSync(configPath, JSON.stringify(testConfig, null, 2), 'utf-8');

    // 安装消息 mock
    installMock();
  });

  after(() => {
    uninstallMock();

    // 恢复备份或清理测试目录
    const configPath = path.join(TEST_CLIENT_DIR, 'config.json');
    if (configBackup) {
      fs.writeFileSync(configPath, configBackup, 'utf-8');
    } else {
      // 清理测试目录
      try {
        fs.rmSync(TEST_CLIENT_DIR, { recursive: true, force: true });
      } catch { /* ignore */ }
    }
  });

  afterEach(() => {
    resetCapture();
  });

  describe('纯命令路由测试（不触发 Agent）', () => {
    let dc: any;

    beforeEach(async () => {
      dc = await createTestDingClaude();
      resetCapture();
    });

    it('/help — 返回帮助列表', async () => {
      const msg = createMockStreamMessage({ content: '/help', conversationId: 'test-cid-001' });
      await dc.botMsgGetCallback(msg);

      const texts = getCapturedTexts();
      assert(texts.length >= 1, `应该至少发出 1 条消息，实际 ${texts.length} 条`);
      const hasHelp = texts.some(t => t.includes('帮助') || t.includes('命令'));
      assert(hasHelp, `应该返回帮助信息，实际: ${texts.join(' | ').substring(0, 200)}`);
    });

    it('/version — 返回版本号', async () => {
      const msg = createMockStreamMessage({ content: '/version', conversationId: 'test-cid-001' });
      await dc.botMsgGetCallback(msg);

      const texts = getCapturedTexts();
      const hasVersion = texts.some(t => t.includes('cc-ding') || t.includes('version'));
      assert(hasVersion, `应该返回版本信息，实际: ${texts.join(' | ').substring(0, 200)}`);
    });

    it('/info — 返回配置信息', async () => {
      const msg = createMockStreamMessage({ content: '/info', conversationId: 'test-cid-001' });
      await dc.botMsgGetCallback(msg);

      const texts = getCapturedTexts();
      const hasInfo = texts.some(t => t.includes('配置') || t.includes('config'));
      assert(hasInfo, `应该返回配置信息，实际: ${texts.join(' | ').substring(0, 200)}`);
    });

    it('/model — 显示当前模型', async () => {
      const msg = createMockStreamMessage({ content: '/model', conversationId: 'test-cid-001' });
      await dc.botMsgGetCallback(msg);

      const texts = getCapturedTexts();
      // /model 需要 owner/admin 权限
      // isOwner 通过 resolvedPhones 比较 userId，测试环境 resolvedPhones 为空
      // 所以会返回权限提示，这是预期行为
      assert(texts.length >= 1, '应该返回消息');
      const hasModelOrAuth = texts.some(t =>
        t.includes('可用模型') || t.includes('model') ||
        t.includes('owner') || t.includes('管理员'),
      );
      assert(hasModelOrAuth, `应该返回模型信息或权限提示，实际: ${texts.join(' | ').substring(0, 200)}`);
    });

    it('/menu — 显示菜单', async () => {
      const msg = createMockStreamMessage({ content: '/menu', conversationId: 'test-cid-001' });
      await dc.botMsgGetCallback(msg);

      const texts = getCapturedTexts();
      assert(texts.length >= 1, '应该返回菜单相关信息');
    });
  });

  describe('会话管理测试', () => {
    let dc: any;

    beforeEach(async () => {
      dc = await createTestDingClaude();
      resetCapture();
    });

    it('/new — 新建会话', async () => {
      const { ClaudeAgent } = await import('../src/biz/claude-agent');
      const origExecuteQuery = ClaudeAgent.prototype.executeQuery;
      ClaudeAgent.prototype.executeQuery = async function() { /* no-op */ };

      try {
        const msg = createMockStreamMessage({ content: '/new', conversationId: 'test-cid-001' });
        await dc.botMsgGetCallback(msg);

        const texts = getCapturedTexts();
        // /new 返回引导消息，等待用户发送第一条问题
        assert(texts.length >= 1, `应该至少发出 1 条消息，实际 ${texts.length} 条`);
        const hasNewMsg = texts.some(t =>
          t.includes('开始') || t.includes('问题') || t.includes('收到') || t.includes('处理'),
        );
        assert(hasNewMsg, `应该有会话引导消息，实际: ${texts.join(' | ').substring(0, 200)}`);
      } finally {
        ClaudeAgent.prototype.executeQuery = origExecuteQuery;
      }
    });

    it('普通文本消息 — 创建新会话并发送确认', async () => {
      const { ClaudeAgent } = await import('../src/biz/claude-agent');
      const origExecuteQuery = ClaudeAgent.prototype.executeQuery;
      ClaudeAgent.prototype.executeQuery = async function() { /* no-op */ };

      try {
        const msg = createMockStreamMessage({
          content: '你好，这是一个测试',
          conversationId: 'test-cid-001',
        });
        await dc.botMsgGetCallback(msg);

        const texts = getCapturedTexts();
        const hasConfirm = texts.some(t => t.includes('收到') && t.includes('处理'));
        assert(hasConfirm, `应该收到确认消息，实际: ${texts.join(' | ').substring(0, 200)}`);
      } finally {
        ClaudeAgent.prototype.executeQuery = origExecuteQuery;
      }
    });

    it('消息排队 — 处理中时新消息入队', async () => {
      let resolveQuery: () => void;
      const queryPromise = new Promise<void>(resolve => { resolveQuery = resolve; });

      const { ClaudeAgent } = await import('../src/biz/claude-agent');
      const origExecuteQuery = ClaudeAgent.prototype.executeQuery;
      ClaudeAgent.prototype.executeQuery = async function() {
        await queryPromise;
      };

      try {
        const msg1 = createMockStreamMessage({
          content: '第一条消息',
          conversationId: 'test-cid-001',
        });
        const p1 = dc.botMsgGetCallback(msg1);

        // 等待确认消息发出（用事件循环微任务代替固定延时）
        await new Promise(resolve => setImmediate(resolve));

        const texts1 = getCapturedTexts();
        assert(texts1.length >= 1, `应该收到确认消息，实际 ${texts1.length} 条`);

        // 此时 isProcessing 为 true，新消息应该入队
        const msg2 = createMockStreamMessage({
          content: '第二条消息',
          conversationId: 'test-cid-001',
        });
        await dc.botMsgGetCallback(msg2);

        const texts2 = getCapturedTexts();
        const hasQueue = texts2.some(t => t.includes('队列') || t.includes('排队'));
        assert(hasQueue, '应该返回消息已入队的提示');

        resolveQuery!();
        await p1;
      } finally {
        ClaudeAgent.prototype.executeQuery = origExecuteQuery;
      }
    });

    it('/end — 结束会话', async () => {
      const { ClaudeAgent } = await import('../src/biz/claude-agent');
      const origExecuteQuery = ClaudeAgent.prototype.executeQuery;
      ClaudeAgent.prototype.executeQuery = async function() { /* no-op */ };

      try {
        // 先创建会话
        await dc.botMsgGetCallback(createMockStreamMessage({
          content: '创建会话',
          conversationId: 'test-cid-001',
        }));

        // 等确认消息发出
        await new Promise(resolve => setImmediate(resolve));
        assert(dc.activeSessions.has('test-cid-001'), '应该已有活跃会话');

        resetCapture();

        // 结束会话
        await dc.botMsgGetCallback(createMockStreamMessage({
          content: '/end',
          conversationId: 'test-cid-001',
        }));

        const texts = getCapturedTexts();
        const hasEnd = texts.some(t => t.includes('结束') || t.includes('会话'));
        assert(hasEnd, `应该返回会话结束消息，实际: ${texts.join(' | ').substring(0, 200)}`);
      } finally {
        ClaudeAgent.prototype.executeQuery = origExecuteQuery;
      }
    });
  });

  describe('权限校验', () => {
    let dc: any;

    beforeEach(async () => {
      dc = await createTestDingClaude();
      resetCapture();
    });

    it('白名单外用户 — 触发权限申请', async () => {
      const msg = createMockStreamMessage({
        content: '/help',
        senderStaffId: '999999',
        senderNick: '外部用户',
        conversationId: 'test-cid-001',
      });
      await dc.botMsgGetCallback(msg);

      const texts = getCapturedTexts();
      const hasDeny = texts.some(t =>
        t.includes('权限') || t.includes('申请') ||
        t.includes('暂无') || t.includes('联系'),
      );
      assert(hasDeny, '白名单外用户应该收到权限提示');
    });

    it('白名单内用户 — 正常处理', async () => {
      const msg = createMockStreamMessage({
        content: '/help',
        senderStaffId: '17681955532',
        senderNick: '测试用户',
        conversationId: 'test-cid-001',
      });
      await dc.botMsgGetCallback(msg);

      const texts = getCapturedTexts();
      const hasHelp = texts.some(t => t.includes('帮助') || t.includes('命令'));
      assert(hasHelp, '白名单用户应该能正常使用命令');
    });
  });
});
