import assert from 'assert';
import {
  parseHelpCommand, parseCommandHelp, getCommandByName,
  parseEndCommand, parseInfoCommand, parseLogCommand, parseLsCommand,
  parseContinueSessionCommand, parseCronCommand, parseVersionCommand,
  parseOpenCommand, parseCleanCommand, parseResetApiKeyCfgCommand,
  parseCfgCommand, parseBashCommand, parseMqCommand, parseAuthCommand,
  parseGoonCommand, parseCcCommand,
  parseClaudeMdCommand, parseInterruptCommand, parseTodoCommand,
  parseMenuCommand, parseRebootCommand, parseRecorderCommandEnhanced,
} from '../src/biz/commands';

describe('commands parsers', () => {
  describe('parseHelpCommand', () => {
    it('匹配 /help（含大小写和空白）', () => {
      assert.strictEqual(parseHelpCommand('/help'), true);
      assert.strictEqual(parseHelpCommand('  /HELP  '), true);
    });
    it('不匹配其他文本', () => {
      assert.strictEqual(parseHelpCommand('/helpme'), false);
      assert.strictEqual(parseHelpCommand('help'), false);
    });
  });

  describe('parseCommandHelp / getCommandByName', () => {
    it('解析 /{cmd} --help', () => {
      assert.strictEqual(parseCommandHelp('/cron --help'), '/cron');
      assert.strictEqual(parseCommandHelp('/TODO --help'), '/todo');
    });
    it('非 --help 返回 null', () => {
      assert.strictEqual(parseCommandHelp('/cron list'), null);
      assert.strictEqual(parseCommandHelp('--help'), null);
    });
    it('getCommandByName 支持别名', () => {
      assert.strictEqual(getCommandByName('/recorder')?.name, '/recorder');
      assert.strictEqual(getCommandByName('/r')?.name, '/recorder');
      assert.strictEqual(getCommandByName('/nope'), undefined);
    });
  });

  describe('parseEndCommand', () => {
    it('仅匹配 /end', () => {
      assert.strictEqual(parseEndCommand(' /end '), true);
      assert.strictEqual(parseEndCommand('/ending'), false);
    });
  });

  describe('parseInfoCommand', () => {
    it('解析子命令', () => {
      assert.strictEqual(parseInfoCommand('/info'), 'all');
      assert.strictEqual(parseInfoCommand('/info robot'), 'robot');
      assert.strictEqual(parseInfoCommand('/info session'), 'session');
      assert.strictEqual(parseInfoCommand('/info task'), 'task');
      assert.strictEqual(parseInfoCommand('/info xxx'), null);
    });
  });

  describe('parseLogCommand', () => {
    it('默认 10 行，可指定行数', () => {
      assert.strictEqual(parseLogCommand('/log'), 10);
      assert.strictEqual(parseLogCommand('/log 25'), 25);
    });
    it('非法行数回退到 10', () => {
      assert.strictEqual(parseLogCommand('/log 0'), 10);
    });
    it('非 /log 返回 null', () => {
      assert.strictEqual(parseLogCommand('/logs 5'), null);
      assert.strictEqual(parseLogCommand('/log abc'), null);
    });
  });

  describe('parseLsCommand', () => {
    it('无参数返回默认', () => {
      assert.deepStrictEqual(parseLsCommand('/ls'), { target: '', depth: 1 });
    });
    it('解析 target 和 depth', () => {
      assert.deepStrictEqual(parseLsCommand('/ls product 2'), { target: 'product', depth: 2 });
    });
    it('depth 上限 5，非法回退 1', () => {
      assert.deepStrictEqual(parseLsCommand('/ls a 9'), { target: 'a', depth: 5 });
      assert.deepStrictEqual(parseLsCommand('/ls a x'), { target: 'a', depth: 1 });
    });
    it('非 /ls 返回 null', () => {
      assert.strictEqual(parseLsCommand('/lsx'), null);
    });
  });

  describe('parseContinueSessionCommand', () => {
    it('带 ID 返回 ID，不带返回空字符串', () => {
      assert.strictEqual(parseContinueSessionCommand('/resume abc123'), 'abc123');
      assert.strictEqual(parseContinueSessionCommand('/resume'), '');
    });
    it('非 /resume 返回 null', () => {
      assert.strictEqual(parseContinueSessionCommand('/resumeX'), null);
    });
  });

  describe('parseCronCommand', () => {
    it('list / delete / pause / resume', () => {
      assert.deepStrictEqual(parseCronCommand('/cron list'), { type: 'list' });
      assert.deepStrictEqual(parseCronCommand('/cron ls'), { type: 'list' });
      assert.deepStrictEqual(parseCronCommand('/cron rm c1'), { type: 'delete', id: 'c1' });
      assert.deepStrictEqual(parseCronCommand('/cron delete c1'), { type: 'delete', id: 'c1' });
      assert.deepStrictEqual(parseCronCommand('/cron pause c1'), { type: 'pause', id: 'c1' });
      assert.deepStrictEqual(parseCronCommand('/cron resume c1'), { type: 'resume', id: 'c1' });
    });
    it('5 位 cron 表达式直接创建', () => {
      assert.deepStrictEqual(
        parseCronCommand('/cron 0 9 * * * 查看任务'),
        { type: 'create_cron', cronExpression: '0 9 * * *', prompt: '查看任务' },
      );
    });
    it('自然语言走 create_nl', () => {
      assert.deepStrictEqual(
        parseCronCommand('/cron 每天早上9点提醒我'),
        { type: 'create_nl', input: '每天早上9点提醒我' },
      );
    });
    it('空参数返回 null', () => {
      assert.strictEqual(parseCronCommand('/cron'), null);
    });
  });

  describe('简单命令', () => {
    it('parseVersionCommand', () => {
      assert.strictEqual(parseVersionCommand(' /version '), true);
      assert.strictEqual(parseVersionCommand('/Version'), false);
    });
    it('parseOpenCommand', () => {
      assert.strictEqual(parseOpenCommand('/open'), 'folder');
      assert.strictEqual(parseOpenCommand('/open shell'), 'shell');
      assert.strictEqual(parseOpenCommand('/open code'), 'code');
      assert.strictEqual(parseOpenCommand('/open xx'), null);
    });
    it('parseCleanCommand', () => {
      assert.strictEqual(parseCleanCommand('/clean'), 'current');
      assert.strictEqual(parseCleanCommand('/clean all'), 'all');
      assert.strictEqual(parseCleanCommand('/cleanall'), null);
    });
    it('parseResetApiKeyCfgCommand', () => {
      assert.strictEqual(parseResetApiKeyCfgCommand('/reset-apikeycfg'), true);
      assert.strictEqual(parseResetApiKeyCfgCommand('/reset'), false);
    });
    it('parseGoonCommand', () => {
      assert.strictEqual(parseGoonCommand('/goon'), true);
      assert.strictEqual(parseGoonCommand('/goon x'), false);
    });
    it('parseClaudeMdCommand', () => {
      assert.strictEqual(parseClaudeMdCommand('/claude.md'), true);
      assert.strictEqual(parseClaudeMdCommand('/claudemd'), false);
    });
    it('parseInterruptCommand', () => {
      assert.strictEqual(parseInterruptCommand('/!'), true);
      assert.strictEqual(parseInterruptCommand('/! now'), false);
    });
  });

  describe('parseCfgCommand', () => {
    it('无参数返回空对象', () => {
      assert.deepStrictEqual(parseCfgCommand('/cfg'), {});
    });
    it('--help 交由 help 处理器（返回 null）', () => {
      assert.strictEqual(parseCfgCommand('/cfg --help'), null);
    });
    it('解析各字段', () => {
      const r = parseCfgCommand('/cfg --dingToken tk --whiteUserList 13800138000,13900139000 --atSender false --permissionMode acceptEdits');
      assert.deepStrictEqual(r, {
        dingToken: 'tk',
        whiteUserList: [ '13800138000', '13900139000' ],
        atSender: false,
        permissionMode: 'acceptEdits',
      });
    });
    it('conversationTitle 支持空格', () => {
      const r = parseCfgCommand('/cfg --conversationTitle 我的 工作群 --dingToken tk');
      assert.strictEqual(r?.conversationTitle, '我的 工作群');
      assert.strictEqual(r?.dingToken, 'tk');
    });
    it('preBash 去除引号', () => {
      const r = parseCfgCommand('/cfg --preBash "source .env"');
      assert.strictEqual(r?.preBash, 'source .env');
    });
    it('非 /cfg 返回 null', () => {
      assert.strictEqual(parseCfgCommand('/cfgx'), null);
    });
  });

  describe('parseBashCommand', () => {
    it('提取命令', () => {
      assert.strictEqual(parseBashCommand('/bash ls -la'), 'ls -la');
    });
    it('无命令返回 null', () => {
      assert.strictEqual(parseBashCommand('/bash'), null);
      assert.strictEqual(parseBashCommand('/bash   '), null);
    });
  });

  describe('parseMqCommand', () => {
    it('list / front', () => {
      assert.deepStrictEqual(parseMqCommand('/mq'), { type: 'list' });
      assert.deepStrictEqual(parseMqCommand('/mq front'), { type: 'front' });
      assert.strictEqual(parseMqCommand('/mq -all'), null);
    });
    it('rm 默认清空/单个/范围/多个', () => {
      assert.deepStrictEqual(parseMqCommand('/mq rm'), { type: 'rm', all: true });
      assert.deepStrictEqual(parseMqCommand('/mq rm 2'), { type: 'rm', indices: [ 2 ] });
      assert.deepStrictEqual(parseMqCommand('/mq rm 1-3'), { type: 'rm', indices: [ 1, 2, 3 ] });
      assert.deepStrictEqual(parseMqCommand('/mq rm 1 3 5'), { type: 'rm', indices: [ 1, 3, 5 ] });
    });
    it('-n 取消前 N 条', () => {
      assert.deepStrictEqual(parseMqCommand('/mq -n 3'), { type: 'cancel', count: 3 });
    });
    it('非法输入返回 null', () => {
      assert.strictEqual(parseMqCommand('/mq xx'), null);
      assert.strictEqual(parseMqCommand('/mqx'), null);
    });
  });

  describe('parseAuthCommand', () => {
    it('add / del / list', () => {
      assert.deepStrictEqual(parseAuthCommand('/auth add u1'), { type: 'add', staffId: 'u1' });
      assert.deepStrictEqual(parseAuthCommand('/auth rm u1'), { type: 'del', staffId: 'u1' });
      assert.deepStrictEqual(parseAuthCommand('/auth delete u1'), { type: 'del', staffId: 'u1' });
      assert.deepStrictEqual(parseAuthCommand('/auth'), { type: 'list' });
      assert.deepStrictEqual(parseAuthCommand('/auth list'), { type: 'list' });
    });
    it('admin 子命令', () => {
      assert.deepStrictEqual(parseAuthCommand('/auth admin add u1'), { type: 'adminAdd', staffId: 'u1' });
      assert.deepStrictEqual(parseAuthCommand('/auth admin rm u1'), { type: 'adminRm', staffId: 'u1' });
      assert.deepStrictEqual(parseAuthCommand('/auth admin'), { type: 'adminList' });
    });
    it('approve / reject', () => {
      assert.deepStrictEqual(parseAuthCommand('/auth approve r1'), { type: 'approve', requestId: 'r1' });
      assert.deepStrictEqual(parseAuthCommand('/auth reject r1'), { type: 'reject', requestId: 'r1' });
    });
  });

  describe('parseRecorderCommandEnhanced', () => {
    it('基础 on/exit', () => {
      assert.strictEqual(parseRecorderCommandEnhanced('/recorder on'), 'on');
      assert.strictEqual(parseRecorderCommandEnhanced('/recorder exit'), 'exit');
      assert.strictEqual(parseRecorderCommandEnhanced('/recorder'), null);
    });
    it('支持 /r 和 /exit /e 别名', () => {
      assert.strictEqual(parseRecorderCommandEnhanced('/r on'), 'on');
      assert.strictEqual(parseRecorderCommandEnhanced('/r e'), 'exit');
      assert.strictEqual(parseRecorderCommandEnhanced('/exit'), 'exit');
      assert.strictEqual(parseRecorderCommandEnhanced('/e'), 'exit');
    });
  });

  describe('parseCcCommand', () => {
    it('透传内容并自动补 / 前缀', () => {
      assert.strictEqual(parseCcCommand('/cc 继续'), '/继续');
      assert.strictEqual(parseCcCommand('/cc /compact'), '/compact');
      assert.strictEqual(parseCcCommand('/cc'), null);
    });
  });

  describe('parseTodoCommand', () => {
    it('list（含无参数）', () => {
      assert.deepStrictEqual(parseTodoCommand('/todo'), { type: 'list' });
      assert.deepStrictEqual(parseTodoCommand('/todo list'), { type: 'list' });
    });
    it('done / rm / rm all', () => {
      assert.deepStrictEqual(parseTodoCommand('/todo done 2'), { type: 'done', index: 2 });
      assert.deepStrictEqual(parseTodoCommand('/todo rm 3'), { type: 'remove', index: 3 });
      assert.deepStrictEqual(parseTodoCommand('/todo rm all'), { type: 'remove', index: 'all' });
    });
    it('remind 范围校验', () => {
      assert.deepStrictEqual(parseTodoCommand('/todo remind 9'), { type: 'remind', hour: 9 });
      assert.deepStrictEqual(parseTodoCommand('/todo remind -1'), { type: 'remind', hour: null });
      assert.strictEqual(parseTodoCommand('/todo remind 24'), null);
    });
    it('mode 切换', () => {
      assert.deepStrictEqual(parseTodoCommand('/todo mode dingtalkId'), { type: 'mode', mode: 'dingtalkId' });
    });
    it('add 带 @人 和 ddl', () => {
      const r = parseTodoCommand('/todo 修复bug @张三 ddl 明天');
      assert.strictEqual(r?.type, 'add');
      if (r?.type === 'add') {
        assert.strictEqual(r.content, '修复bug');
        assert.strictEqual(r.assigneeId, '张三');
        assert.strictEqual(r.deadline, '明天');
      }
    });
  });

  describe('parseMenuCommand', () => {
    it('show / list / trigger', () => {
      assert.deepStrictEqual(parseMenuCommand('/menu'), { type: 'show' });
      assert.deepStrictEqual(parseMenuCommand('/menu list'), { type: 'list', isGlobal: false });
      assert.deepStrictEqual(parseMenuCommand('/menu trigger go'), { type: 'trigger', word: 'go' });
    });
    it('add / del 区分全局', () => {
      assert.deepStrictEqual(parseMenuCommand('/menu add /help'), { type: 'add', command: '/help', isGlobal: false });
      assert.deepStrictEqual(parseMenuCommand('/menu -g add /info robot'), { type: 'add', command: '/info robot', isGlobal: true });
      assert.deepStrictEqual(parseMenuCommand('/menu -g del 1'), { type: 'del', index: 1, isGlobal: true });
    });
  });

  describe('parseRebootCommand', () => {
    it('reboot 与 --update', () => {
      assert.deepStrictEqual(parseRebootCommand('/reboot'), { update: false });
      assert.deepStrictEqual(parseRebootCommand('/reboot --update'), { update: true, tag: undefined });
      assert.deepStrictEqual(parseRebootCommand('/reboot --update beta'), { update: true, tag: 'beta' });
      assert.strictEqual(parseRebootCommand('/reboot now'), null);
    });
  });
});
