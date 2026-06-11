import assert from 'assert';
import { resolveSecret, isEnvRef } from '../src/biz/secrets';

describe('secrets', () => {
  describe('isEnvRef', () => {
    it('识别 $ENV: 引用', () => {
      assert.strictEqual(isEnvRef('$ENV:MY_SECRET'), true);
      assert.strictEqual(isEnvRef(' $ENV:MY_SECRET '), true);
    });
    it('普通值与空值不是引用', () => {
      assert.strictEqual(isEnvRef('plain-token'), false);
      assert.strictEqual(isEnvRef(''), false);
      assert.strictEqual(isEnvRef(undefined), false);
      assert.strictEqual(isEnvRef('$ENV:'), false);
    });
  });

  describe('resolveSecret', () => {
    it('解析已设置的环境变量', () => {
      process.env.CC_DING_TEST_SECRET = 'resolved-value';
      try {
        assert.strictEqual(resolveSecret('$ENV:CC_DING_TEST_SECRET'), 'resolved-value');
      } finally {
        delete process.env.CC_DING_TEST_SECRET;
      }
    });
    it('未设置的环境变量返回空字符串', () => {
      delete process.env.CC_DING_TEST_MISSING;
      assert.strictEqual(resolveSecret('$ENV:CC_DING_TEST_MISSING'), '');
    });
    it('普通值原样返回', () => {
      assert.strictEqual(resolveSecret('plain-token'), 'plain-token');
    });
    it('空值透传', () => {
      assert.strictEqual(resolveSecret(undefined), undefined);
      assert.strictEqual(resolveSecret(''), '');
    });
  });
});
