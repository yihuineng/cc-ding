import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  buildWindowsCommandLineForCmd,
  getExecutableCandidates,
  quoteWindowsCommandArg,
  resolveExecutable,
} from '../src/biz/platform';

describe('platform helpers', () => {
  it('Windows 下按 PATHEXT 生成候选命令', () => {
    assert.deepStrictEqual(
      getExecutableCandidates('claude', { platform: 'win32', pathExt: '.EXE;.CMD' }),
      [ 'claude.exe', 'claude.cmd' ],
    );
    assert.deepStrictEqual(
      getExecutableCandidates('claude.cmd', { platform: 'win32', pathExt: '.EXE;.CMD' }),
      [ 'claude.cmd' ],
    );
  });

  it('Windows 下使用分号拆分 PATH 并解析 .cmd', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ding-platform-'));
    try {
      const binA = path.join(tmp, 'a');
      const binB = path.join(tmp, 'b');
      fs.mkdirSync(binA);
      fs.mkdirSync(binB);
      const commandPath = path.join(binB, 'claude.cmd');
      fs.writeFileSync(commandPath, '@echo off\r\n');

      assert.strictEqual(
        resolveExecutable('claude', {
          platform: 'win32',
          envPath: `${binA};${binB}`,
          pathExt: '.EXE;.CMD',
        }),
        commandPath,
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('为 cmd.exe /c 构造安全参数字符串', () => {
    assert.strictEqual(quoteWindowsCommandArg('simple'), 'simple');
    assert.strictEqual(quoteWindowsCommandArg('hello world'), '"hello world"');
    assert.strictEqual(quoteWindowsCommandArg('50% done'), '"50%% done"');

    const line = buildWindowsCommandLineForCmd('C:\\Program Files\\Claude\\claude.cmd', [ '--print', 'hello world' ]);
    assert.strictEqual(line, '"C:\\Program Files\\Claude\\claude.cmd" --print "hello world"');
  });
});
