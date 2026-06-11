import assert from 'assert';
import { parseDeadline, getDefaultDeadline } from '../src/biz/todo';

function fmt(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

describe('todo deadline parsing', () => {
  it('ISO 日期标准化', () => {
    assert.strictEqual(parseDeadline('2026-6-1'), '2026-06-01');
    assert.strictEqual(parseDeadline('2026/06/10'), '2026-06-10');
  });

  it('明天 / 后天', () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    assert.strictEqual(parseDeadline('明天'), fmt(tomorrow));
    const dayAfter = new Date();
    dayAfter.setDate(dayAfter.getDate() + 2);
    assert.strictEqual(parseDeadline('后天'), fmt(dayAfter));
  });

  it('MM/DD 已过日期顺延到下一年', () => {
    const past = new Date();
    past.setDate(past.getDate() - 30);
    const m = past.getMonth() + 1;
    const d = past.getDate();
    const expected = new Date(past.getFullYear() + 1, m - 1, d);
    assert.strictEqual(parseDeadline(`${m}/${d}`), fmt(expected));
  });

  it('默认截止时间为 7 天后', () => {
    const expected = new Date();
    expected.setDate(expected.getDate() + 7);
    assert.strictEqual(getDefaultDeadline(), fmt(expected));
  });
});
