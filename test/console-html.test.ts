import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { generateConsoleHtml } from '../src/biz/console';

describe('console HTML generation', () => {
  const consoleWebDist = path.join(__dirname, '..', 'console-web', 'dist');
  const indexPath = path.join(consoleWebDist, 'index.html');
  const distExists = fs.existsSync(indexPath);

  it('生成的 HTML 包含 DOCTYPE', () => {
    const html = generateConsoleHtml();
    assert.ok(/<!doctype html>/i.test(html), '应包含 DOCTYPE');
  });

  if (distExists) {
    it('从 console-web/dist/index.html 读取 React 构建产物', () => {
      const html = generateConsoleHtml();
      const expected = fs.readFileSync(indexPath, 'utf-8');
      assert.strictEqual(html, expected);
    });

    it('React 构建产物包含 script 标签', () => {
      const html = generateConsoleHtml();
      assert.ok(html.includes('<script'), '应包含 script 标签');
    });
  } else {
    it('dist 不存在时返回 fallback HTML', () => {
      const html = generateConsoleHtml();
      assert.ok(html.includes('Console frontend not built'), '应包含 fallback 提示');
    });
  }
});
