/**
 * cc-ding 端到端测试基础用例：mock DWClientDownStream 消息结构验证
 *
 * 完整链路测试见 e2e-internal.test.ts
 * 运行: npx mocha test/e2e-message.test.ts
 */

import assert from 'assert';
import type { DWClientDownStream } from 'utils-ok';

// ============================================================
// Mock 工具
// ============================================================

/** 生成 mock DWClientDownStream 消息 */
function mockDingMsg(
  content: string,
  opts?: {
    senderNick?: string;
    senderStaffId?: string;
    conversationId?: string;
    conversationTitle?: string;
    conversationType?: string;
    sessionWebhook?: string;
    msgtype?: string;
    atUsers?: Array<{ dingtalkId: string; staffId: string; userId: string }>;
  },
): DWClientDownStream {
  const {
    senderNick = '测试用户',
    senderStaffId = '17681955532',
    conversationId = 'test-cid-e2e',
    conversationTitle = 'cc 体验',
    conversationType = '2',
    sessionWebhook = 'https://oapi.dingtalk.com/robot/send?access_token=test',
    msgtype = 'text',
  } = opts || {};

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
      conversationType,
      sessionWebhook,
      msgtype,
      text: { content },
      atUsers: opts?.atUsers,
    }),
  };
}

// ============================================================
// Tests
// ============================================================

describe('E2E: mock 消息结构验证', () => {
  describe('mockDingMsg 工具', () => {
    it('生成合法的 DWClientDownStream 对象', () => {
      const msg = mockDingMsg('hello');
      assert.strictEqual(msg.headers.topic, '/v1.0/im/bot/messages/get');
      assert.strictEqual(msg.type, 'CALLBACK');

      const data = JSON.parse(msg.data);
      assert.strictEqual(data.text.content, 'hello');
      assert.strictEqual(data.senderNick, '测试用户');
      assert.strictEqual(data.senderStaffId, '17681955532');
      assert.strictEqual(data.msgtype, 'text');
    });

    it('支持自定义参数', () => {
      const msg = mockDingMsg('/help', {
        senderNick: '张三',
        senderStaffId: '12345',
        conversationId: 'cid-custom',
      });
      const data = JSON.parse(msg.data);
      assert.strictEqual(data.text.content, '/help');
      assert.strictEqual(data.senderNick, '张三');
      assert.strictEqual(data.senderStaffId, '12345');
      assert.strictEqual(data.conversationId, 'cid-custom');
    });
  });

  describe('消息解析', () => {
    it('text 消息 content 正确提取', () => {
      const msg = mockDingMsg('测试内容');
      const data = JSON.parse(msg.data);
      assert.strictEqual(data.text?.content, '测试内容');
    });

    it('命令前缀保留', () => {
      const msg = mockDingMsg('/new');
      const data = JSON.parse(msg.data);
      assert.strictEqual(data.text?.content.trim(), '/new');
    });
  });
});
