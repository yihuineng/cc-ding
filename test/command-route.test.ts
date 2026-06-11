import assert from 'assert';
import { route } from '../src/biz/command-route';

describe('command-route', () => {
  it('match 返回 null/undefined/false 时不处理', async () => {
    let called = 0;
    const handler = () => { called++; };
    assert.strictEqual(await route('a', () => null, handler).tryHandle(), false);
    assert.strictEqual(await route('b', () => undefined, handler).tryHandle(), false);
    assert.strictEqual(await route('c', () => false, handler).tryHandle(), false);
    assert.strictEqual(called, 0);
  });

  it('match 返回真值时处理并传递解析结果', async () => {
    let received: unknown;
    const r = route('x', () => ({ id: 7 }), parsed => { received = parsed; });
    assert.strictEqual(await r.tryHandle(), true);
    assert.deepStrictEqual(received, { id: 7 });
  });

  it('空字符串是有效匹配（/resume 恢复最近会话语义）', async () => {
    let received: string | undefined;
    const r = route('resume', () => '', (parsed: string) => { received = parsed; });
    assert.strictEqual(await r.tryHandle(), true);
    assert.strictEqual(received, '');
  });

  it('支持异步 handler', async () => {
    let done = false;
    const r = route('async', () => true, async () => {
      await new Promise(resolve => setTimeout(resolve, 5));
      done = true;
    });
    assert.strictEqual(await r.tryHandle(), true);
    assert.strictEqual(done, true);
  });
});
