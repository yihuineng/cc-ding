import assert from 'assert';
import { isRetryableApiError, parseClaudeStreamLine } from '../src/biz/claude-process';
import { isQuotaExhaustedError } from '../src/biz/api-key-manager';

describe('claude-process error classifiers', () => {
  describe('isRetryableApiError', () => {
    it('429 临时限流可重试', () => {
      assert.strictEqual(isRetryableApiError('API Error: 429 too many requests'), true);
    });
    it('422 TPM 限流可重试', () => {
      assert.strictEqual(isRetryableApiError('API Error: 422 {"error":{"message":"请求额度超限(TPM)"}}'), true);
      assert.strictEqual(isRetryableApiError('422 tokens per minute exceeded'), true);
    });
    it('通用限流关键词可重试', () => {
      assert.strictEqual(isRetryableApiError('Error: rate limit exceeded'), true);
      assert.strictEqual(isRetryableApiError('server overloaded, retry later'), true);
    });
    it('普通错误不可重试', () => {
      assert.strictEqual(isRetryableApiError('SyntaxError: unexpected token'), false);
      assert.strictEqual(isRetryableApiError(''), false);
    });
  });

  describe('parseClaudeStreamLine', () => {
    it('解析 system init 行获取 sessionId', () => {
      const line = JSON.stringify({ type: 'system', subtype: 'init', session_id: 's-123' });
      assert.deepStrictEqual(parseClaudeStreamLine(line), { type: 'system', sessionId: 's-123' });
    });
    it('解析 assistant 文本块', () => {
      const line = JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'hello' }] },
      });
      assert.deepStrictEqual(parseClaudeStreamLine(line), { type: 'assistant', content: 'hello' });
    });
    it('thinking 块默认不包含，includeThinking=true 时包含', () => {
      const line = JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'thinking', thinking: 'mmm' }] },
      });
      assert.deepStrictEqual(parseClaudeStreamLine(line), { type: 'assistant' });
      const withThinking = parseClaudeStreamLine(line, true);
      assert.strictEqual(withThinking?.type, 'assistant');
      assert.ok(withThinking?.content?.includes('mmm'));
    });
    it('result 行返回结果内容', () => {
      const line = JSON.stringify({ type: 'result', result: 'done' });
      assert.deepStrictEqual(parseClaudeStreamLine(line), { type: 'result', content: 'done' });
    });
    it('空行返回 null，非 JSON 行按 text 透传', () => {
      assert.strictEqual(parseClaudeStreamLine(''), null);
      assert.strictEqual(parseClaudeStreamLine('   '), null);
      assert.deepStrictEqual(parseClaudeStreamLine('not json'), { type: 'text', content: 'not json' });
    });
  });

  describe('isQuotaExhaustedError', () => {
    it('与 429 临时限流互斥的判定可用', () => {
      // 具体文案依赖实现，仅验证函数对普通文本不误判
      assert.strictEqual(isQuotaExhaustedError('hello world'), false);
    });
  });
});
