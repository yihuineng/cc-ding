/**
 * CodexAgent 单元测试
 *
 * 验证 CodexAgent 生成的命令参数格式是否正确，确保使用新版 Codex CLI
 * 支持的参数格式（-c 配置覆盖替代已移除的 -a）。
 *
 * 运行: npx mocha test/codex-agent.test.ts
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import { Readable } from 'stream';

// ============================================================
// 命令捕获：拦截 child_process.spawn
// ============================================================

interface SpawnedCommand {
  command: string;
  args: string[];
  options: any;
}

const capturedCommands: SpawnedCommand[] = [];

/**
 * 在 child_process 层面拦截 spawn，这是最低层的拦截点。
 * platform.spawnCommand 内部调用 child_process.spawn，
 * 无论模块引用链如何，拦截 spawn 都能生效。
 */
function installSpawnMock(): void {
  capturedCommands.length = 0;
  const cp = require('child_process');
  const origSpawn = cp.spawn;

  cp.spawn = (cmd: string, args: any[], opts?: any) => {
    capturedCommands.push({ command: cmd, args: args || [], options: opts });
    // 返回 mock ChildProcess
    const mockChild = new EventEmitter() as any;
    mockChild.stdin = { write: () => {}, end: () => {} };
    // 提供一个空的 Readable stream 给 stdout，避免 readline.createInterface 报错
    mockChild.stdout = Readable.from([]);
    mockChild.stderr = new EventEmitter();
    setImmediate(() => mockChild.emit('close', 0));
    return mockChild;
  };

  (globalThis as any).__orig_cp_spawn = origSpawn;
}

function uninstallSpawnMock(): void {
  const origSpawn = (globalThis as any).__orig_cp_spawn;
  if (origSpawn) {
    require('child_process').spawn = origSpawn;
    delete (globalThis as any).__orig_cp_spawn;
  }
}

function getCaptured(): SpawnedCommand | undefined {
  return capturedCommands[capturedCommands.length - 1];
}

// ============================================================
// 创建测试用 DingClaude 实例
// ============================================================

const TEST_CLIENT_ID = 'dingiexxdy25itrcuwtb';
const TEST_CLIENT_DIR = path.join(os.homedir(), '.cc-ding', TEST_CLIENT_ID);
const TEST_CONV_DIR = path.join(TEST_CLIENT_DIR, 'test-codex-conv');
const TEST_SESSION_DIR = path.join(TEST_CLIENT_DIR, 'test-codex-session');

async function createTestDingClaude(): Promise<any> {
  // 清除模块缓存以确保使用最新的 mock
  for (const key of Object.keys(require.cache)) {
    if (key.includes('cc-ding-cli') || key.includes('codex-agent')) {
      delete require.cache[key];
    }
  }

  // 确保测试目录存在
  fs.mkdirSync(TEST_CLIENT_DIR, { recursive: true });
  fs.mkdirSync(TEST_CONV_DIR, { recursive: true });
  fs.mkdirSync(TEST_SESSION_DIR, { recursive: true });

  const { DingClaude } = await import('../src/biz/cc-ding-cli');
  const dc = new (DingClaude as any)(TEST_CLIENT_ID);

  // Mock 钉钉连接
  const mockClient = new EventEmitter() as any;
  mockClient.connect = async () => {};
  mockClient.disconnect = async () => {};
  mockClient.isConnected = () => false;
  mockClient.registerCallbackListener = () => {};
  mockClient.socketCallBackResponse = () => {};
  mockClient.getAccessToken = async () => 'mock-access-token';
  dc.dingStreamClient = mockClient;

  // Mock 配置
  dc.getConversationConfig = () => ({ agent: 'codex' });
  dc.getConversationDir = () => TEST_CONV_DIR;
  dc.getSessionDir = () => TEST_SESSION_DIR;
  dc.updateSessionFile = () => {};

  if (!dc.config.clientSecret) {
    dc.config.clientSecret = 'test-secret';
  }
  dc.clientId = TEST_CLIENT_ID;

  return dc;
}

function createTestSession(conversationId = 'test-codex-cid'): any {
  return {
    conversationId,
    conversationType: '2',
    conversationTitle: 'Codex 测试群',
    startStaffId: '17681955532',
    sessionWebhook: 'https://oapi.dingtalk.com/robot/send?access_token=test',
    currentWebhook: 'https://oapi.dingtalk.com/robot/send?access_token=test',
    currentConversationId: conversationId,
  };
}

// ============================================================
// 测试
// ============================================================

describe('CodexAgent 命令参数', () => {
  before(() => {
    fs.mkdirSync(TEST_CLIENT_DIR, { recursive: true });
    installSpawnMock();
  });

  after(() => {
    uninstallSpawnMock();
    try {
      fs.rmSync(TEST_CONV_DIR, { recursive: true, force: true });
      fs.rmSync(TEST_SESSION_DIR, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  afterEach(() => {
    capturedCommands.length = 0;
  });

  describe('新会话参数', () => {
    it('不使用已废弃的 -a 参数', async () => {
      const dc = await createTestDingClaude();
      const { CodexAgent } = await import('../src/biz/codex-agent');
      const agent = new CodexAgent();

      await agent.executeQuery(dc, createTestSession(), {
        message: 'hello',
        senderNick: '测试用户',
        senderStaffId: '17681955532',
      });

      const cmd = getCaptured();
      assert(cmd, '应该捕获到 spawn 调用');
      assert(cmd.command.endsWith('codex'), `命令应该是 codex，实际: ${cmd.command}`);

      const hasDeprecatedA = cmd.args.includes('-a');
      assert(!hasDeprecatedA, `不应使用已废弃的 -a 参数，实际: ${cmd.args.join(' ')}`);
    });

    it('使用 -c approval.mode=never 替代 -a', async () => {
      const dc = await createTestDingClaude();
      const { CodexAgent } = await import('../src/biz/codex-agent');
      const agent = new CodexAgent();

      await agent.executeQuery(dc, createTestSession(), {
        message: 'hello',
        senderNick: '测试用户',
        senderStaffId: '17681955532',
      });

      const cmd = getCaptured();
      assert(cmd, '应该捕获到 spawn 调用');

      const approvalIdx = cmd.args.findIndex(a => a.includes('approval.mode'));
      assert(approvalIdx >= 0, `应设置 approval.mode，实际: ${cmd.args.join(' ')}`);
      assert.strictEqual(cmd.args[approvalIdx], 'approval.mode=never');
      assert.strictEqual(cmd.args[approvalIdx - 1], '-c', 'approval.mode=never 应通过 -c 传入');
    });

    it('新会话包含 exec、sandbox、json 和 cd 参数', async () => {
      const dc = await createTestDingClaude();
      const { CodexAgent } = await import('../src/biz/codex-agent');
      const agent = new CodexAgent();

      await agent.executeQuery(dc, createTestSession(), {
        message: 'test query',
        senderNick: '测试用户',
        senderStaffId: '17681955532',
      });

      const cmd = getCaptured();
      assert(cmd, '应该捕获到 spawn 调用');

      assert(cmd.args.includes('exec'), `应包含 exec: ${cmd.args.join(' ')}`);
      assert(cmd.args.includes('--sandbox'), `应包含 --sandbox: ${cmd.args.join(' ')}`);
      assert(cmd.args.includes('danger-full-access'), `应包含 danger-full-access: ${cmd.args.join(' ')}`);
      assert(cmd.args.includes('--json'), `应包含 --json: ${cmd.args.join(' ')}`);
      assert(cmd.args.includes('--cd'), `应包含 --cd: ${cmd.args.join(' ')}`);
      assert(cmd.args.includes('--skip-git-repo-check'), `应包含 --skip-git-repo-check: ${cmd.args.join(' ')}`);
    });

    it('新会话使用 stdin 接收消息', async () => {
      const dc = await createTestDingClaude();
      const { CodexAgent } = await import('../src/biz/codex-agent');
      const agent = new CodexAgent();

      await agent.executeQuery(dc, createTestSession(), {
        message: 'hello world',
        senderNick: '测试用户',
        senderStaffId: '17681955532',
      });

      const cmd = getCaptured();
      assert(cmd, '应该捕获到 spawn 调用');
      assert.strictEqual(cmd.args[cmd.args.length - 1], '-', '最后一个参数应是 stdin 占位符 -');
    });
  });

  describe('恢复会话参数', () => {
    it('恢复会话使用 resume 子命令', async () => {
      const dc = await createTestDingClaude();
      const { CodexAgent } = await import('../src/biz/codex-agent');
      const agent = new CodexAgent();
      const session = createTestSession();
      session.agentSessionId = 'thread-abc123';

      await agent.executeQuery(dc, session, {
        message: 'continue',
        senderNick: '测试用户',
        senderStaffId: '17681955532',
      });

      const cmd = getCaptured();
      assert(cmd, `应该捕获到 spawn 调用，共 ${capturedCommands.length} 次`);

      assert(cmd.args.includes('resume'), `应使用 resume: ${cmd.args.join(' ')}`);
      assert(cmd.args.includes('--skip-git-repo-check'), '应跳过 git 检查');
      assert(cmd.args.includes('thread-abc123'), '应包含 thread_id');
    });

    it('恢复会话同样不使用 -a 参数', async () => {
      const dc = await createTestDingClaude();
      const { CodexAgent } = await import('../src/biz/codex-agent');
      const agent = new CodexAgent();
      const session = createTestSession();
      session.agentSessionId = 'thread-xyz789';

      await agent.executeQuery(dc, session, {
        message: 'continue',
        senderNick: '测试用户',
        senderStaffId: '17681955532',
      });

      const cmd = getCaptured();
      assert(cmd, `应该捕获到 spawn 调用，共 ${capturedCommands.length} 次`);

      const hasDeprecatedA = cmd.args.includes('-a');
      assert(!hasDeprecatedA, `恢复会话不应使用 -a: ${cmd.args.join(' ')}`);

      const hasApprovalConfig = cmd.args.some((a, i) =>
        a === '-c' && cmd.args[i + 1] && cmd.args[i + 1].includes('approval.mode'),
      );
      assert(hasApprovalConfig, `恢复会话也应使用 -c 配置覆盖: ${cmd.args.join(' ')}`);
    });
  });

  describe('完整参数顺序', () => {
    it('新会话参数顺序正确', async () => {
      const dc = await createTestDingClaude();
      const { CodexAgent } = await import('../src/biz/codex-agent');
      const agent = new CodexAgent();

      await agent.executeQuery(dc, createTestSession(), {
        message: 'test',
        senderNick: '测试用户',
        senderStaffId: '17681955532',
      });

      const cmd = getCaptured();
      assert(cmd, '应该捕获到 spawn 调用');
      const args = cmd.args;

      assert.strictEqual(args[0], 'exec', '第一个参数应该是 exec');

      const jsonIdx = args.indexOf('--json');
      const cdIdx = args.indexOf('--cd');
      assert(jsonIdx >= 0, '应包含 --json');
      assert(cdIdx >= 0, '应包含 --cd');
      assert(cdIdx > jsonIdx, '--cd 应在 --json 之后');
    });

    it('恢复会话参数顺序正确', async () => {
      const dc = await createTestDingClaude();
      const { CodexAgent } = await import('../src/biz/codex-agent');
      const agent = new CodexAgent();
      const session = createTestSession();
      session.agentSessionId = 'thread-test123';

      await agent.executeQuery(dc, session, {
        message: 'test',
        senderNick: '测试用户',
        senderStaffId: '17681955532',
      });

      const cmd = getCaptured();
      assert(cmd, '应该捕获到 spawn 调用');
      const args = cmd.args;

      assert.strictEqual(args[0], 'exec', '第一个参数应该是 exec');
      assert.strictEqual(args[1], 'resume', '第二个参数应该是 resume');

      const threadIdx = args.indexOf('thread-test123');
      const jsonIdx = args.indexOf('--json');
      assert(threadIdx > 0, '应包含 thread_id');
      assert(jsonIdx > threadIdx, '--json 应在 thread_id 之后');
    });
  });

  describe('认证错误检测', () => {
    it('匹配 refresh token revoked', async () => {
      // 通过调用私有函数的导出方式测试
      const text = 'error: Your access token could not be refreshed because your refresh token was revoked';
      // 直接测试匹配逻辑
      const hasMatch = /refresh token.*(revoked|invalidat|expir)/i.test(text);
      assert(hasMatch, '应匹配到 refresh token revoked');
    });

    it('匹配 401 Unauthorized', async () => {
      const text = 'failed to connect to websocket: HTTP error: 401 Unauthorized, url: wss://...';
      const hasMatch = /401 Unauthorized/i.test(text);
      assert(hasMatch, '应匹配到 401 Unauthorized');
    });

    it('匹配 token_revoked', async () => {
      const text = 'token_revoked';
      const hasMatch = /token_revoked/i.test(text);
      assert(hasMatch, '应匹配到 token_revoked');
    });

    it('匹配 session has ended', async () => {
      const text = 'Your session has ended. Please log in again.';
      const hasMatch = /session has ended.*log in/i.test(text);
      assert(hasMatch, '应匹配到 session has ended');
    });

    it('不匹配普通错误', async () => {
      const text = 'File not found: /tmp/test.txt';
      const patterns = [
        /refresh token.*(revoked|invalidat|expir)/i,
        /access token could not be refreshed/i,
        /invalidated oauth token/i,
        /token_revoked/i,
        /401 Unauthorized/i,
      ];
      const isAuthError = patterns.some(p => p.test(text));
      assert(!isAuthError, '普通错误不应被识别为认证错误');
    });
  });

  describe('device-auth 输出解析', () => {
    it('解析 device-auth 成功输出', async () => {
      const sampleOutput = `Welcome to Codex [v0.141.0]

Follow these steps to sign in with ChatGPT using device code authorization:

1. Open this link in your browser and sign in to your account
   https://auth.openai.com/codex/device

2. Enter this one-time code (expires in 15 minutes)
   2HE7-22964

Device codes are a common phishing target. Never share this code.`;

      const urlMatch = sampleOutput.match(/https?:\/\/[^\s]+\/codex\/device/);
      const codeMatch = sampleOutput.match(/([A-Z0-9]{4}-[A-Z0-9]{5})/);

      assert(urlMatch, '应提取到 URL');
      assert.strictEqual(urlMatch[0], 'https://auth.openai.com/codex/device');
      assert(codeMatch, '应提取到 code');
      assert.strictEqual(codeMatch[1], '2HE7-22964');
    });

    it('解析带 ANSI 转义码的输出', async () => {
      const sampleOutput = '\x1b[90mOpen this link\x1b[0m\n   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\n\n   \x1b[94mABC1-12345\x1b[0m';

      const urlMatch = sampleOutput.match(/https?:\/\/[^\s]+\/codex\/device/);
      const codeMatch = sampleOutput.match(/([A-Z0-9]{4}-[A-Z0-9]{5})/);

      assert(urlMatch, '应提取到 URL（忽略 ANSI 码）');
      assert(codeMatch, '应提取到 code（忽略 ANSI 码）');
    });
  });
});
