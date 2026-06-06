#!/usr/bin/env ts-node

import { loadEnv, projUtil } from '../src/common';
import { Command } from 'commander';
import { ensureClientDir, getHomeDir, initClientDir } from '../src/biz/session';
import path from 'path';
import { DingClaude, IConfig } from '../src/biz/cc-ding-cli';
import { acquirePidLock } from '../src/biz/lock';
import { printDoctorResults, runDoctor } from '../src/biz/doctor';
import { sendNotify } from '../src/biz/notify';
import fs from 'fs';

loadEnv();

process.removeAllListeners('warning');
process.setMaxListeners(0);
process.on('uncaughtException', function(err) {
  console.log('Caught exception: ' + err);
  process.exit(1);
});

const program = new Command();

program
  .addHelpText('before', `
    cc-ding for connect ClaudeCode to DingDingRobot
  `)
  .addHelpText('after', `
Examples:
  $ cc-ding init -ci {clientId} -cs {clientSecret} -m {mobile}
  $ cc-ding run -ci {clientId}
`)
  .version(projUtil().getPkgVersion());

program
  .command('init')
  .description('初始化cc-ding配置文件, 生成最简config.json')
  .requiredOption('-ci, --clientId <value>', 'clientId')
  .requiredOption('-cs, --clientSecret <value>', 'clientSecret (钉钉Stream连接密钥)')
  .requiredOption('-m, --mobile <value>', 'mobile (自己的手机号, 自动加入白名单)')
  .option('-cn, --clientName <value>', 'clientName (机器人名称, 可选)')
  .action(async (opts) => {
    // init 命令执行前检查 Node 版本
    const nodeVersion = process.version.slice(1);
    const nodeMajor = parseInt(nodeVersion.split('.')[0], 10);
    if (nodeMajor < 24) {
      console.log('\n❌ Node 版本过低，无法执行 init 命令');
      console.log(`  当前版本：${nodeVersion}`);
      console.log('  要求：Node >= 24');
      console.log('\n💡 请升级 Node 版本后重新运行\n');
      process.exit(1);
    }

    const clientDir = `${getHomeDir()}/.cc-ding/${opts.clientId}`;
    const cfgFile = `${clientDir}/config.json`;

    if (fs.existsSync(cfgFile)) {
      console.log(`配置文件已存在: ${cfgFile}`);
      console.log('如需重新初始化, 请先删除已有配置文件');
      process.exit(1);
    }

    const config: IConfig = {
      clientName: opts.clientName || 'cc助手',
      owner: opts.mobile,
      whiteUserList: [ opts.mobile ],
      clientSecret: opts.clientSecret,
      defaultDingToken: '<兜底钉钉机器人Token-用于无dingToken群的消息接收>',
      conversations: [],
      includeThinking: false,
      resultOnly: true,
      debug: false,
      taskQueueSize: 10,
      taskHandlerCount: 1,
      sessionMaxConcurrency: 20,
      skipSandbox: false,
    };

    initClientDir(opts.clientId, config);

    console.log('配置文件已生成:', cfgFile);
    console.log('');
    console.log('后续步骤:');
    console.log('  1. 编辑 config.json 添加 conversations 配置(群聊需配置dingToken)');
    console.log('  2. 启动机器人: cc-ding run -ci', opts.clientId);
    console.log('  3. 推荐PM2启动:');
    console.log(`     pm2 start --name "cc-ding-${opts.clientId}" npx -- -p cc-ding cc-ding run -ci ${opts.clientId}`);
  });

program
  .command('run')
  .description(`
        - 功能: 钉钉机器人对接本地Claude, 支持会话模式和任务队列模式
        - 会话数据路径: ~/.cc-ding/{clientId}/{MD5}/.sessions/{claudeSessionId}/session.{json|log}
        - 任务数据路径: ~/.cc-ding/{clientId}/{MD5}/.tasks/{时间戳}/task.{json|log}
        - 定时任务数据: ~/.cc-ding/{clientId}/cron.json
        - 启动方式: pm2 start --name "cc-ding-{clientId}" npx -- -p cc-ding run -ci {clientId}
        - 会话模式说明
          - 会话ID: 由 Claude 分配的 claudeSessionId
          - 结束会话: /end
          - 新会话: /new [初始消息] 强制结束当前会话并开启新会话
          - 恢复会话: /resume [会话ID] 恢复指定历史会话, 不指定则恢复最近一个
          - 会话持久化: 活跃会话自动保存到 active.json, 服务重启后自动恢复
          - 群内多用户: 允许群内所有白名单用户参与对话
          - /help: 查看所有可用命令(含版本、作者、文档链接); /{命令} --help 查看命令详细用法
        - 图片消息支持
          - 支持接收钉钉图片消息(picture)和富文本消息(richText, 含内嵌图片)
          - 图片自动下载保存到 <会话目录>/.images/ 下
          - useLocalOcr: 默认开启, 使用本地OCR识别图片文字, 同时传入原图路径供Claude自主查看
          - 配置方式: conversations[].useLocalOcr = false 可关闭OCR(适用于支持图片识别的模型)
        - 任务模式说明
          - 任务ID: 任务接收时间戳
        - API Key 池化管理(可选, 配置apiKeyCfg后启用)
          - 429自动切换: 自动切换到API Key模式
          - Key轮换: API Key遇到429或连续TPM不稳定时自动换Key
          - 跨天重置: 每日自动重置API Key状态
      `)
  .requiredOption('-ci, --clientId <value>', 'clientId')
  .action(async (opts) => {
    ensureClientDir(opts.clientId);
    const clientDir = path.join(getHomeDir(), '.cc-ding', opts.clientId);
    acquirePidLock(clientDir, opts.clientId);
    await new DingClaude(opts.clientId).run();
  });

program
  .command('doctor')
  .description('检查指定client的配置文件schema合法性和有效性')
  .requiredOption('-ci, --clientId <value>', 'clientId')
  .action(async (opts) => {
    const clientDir = path.join(getHomeDir(), '.cc-ding', opts.clientId);
    const results = runDoctor(clientDir);
    printDoctorResults(results);
  });

program
  .command('notify')
  .description('通过钉钉机器人发送消息到指定群')
  .requiredOption('-ci, --clientId <value>', 'clientId')
  .requiredOption('-c, --conversations <value>', '目标会话ID（多个用逗号分隔）')
  .requiredOption('-m, --message <value>', '消息内容')
  .option('-at, --atUserIds <value>', '@ 指定用户（多个用逗号分隔）')
  .option('-md, --markdown', '使用 Markdown 格式发送', false)
  .action(async (opts) => {
    const conversationIds = opts.conversations.split(',').map((s: string) => s.trim()).filter(Boolean);
    const atUserIds = opts.atUserIds ? opts.atUserIds.split(',').map((s: string) => s.trim()).filter(Boolean) : [];

    console.log(`📤 发送消息到 ${conversationIds.length} 个会话...`);
    const result = await sendNotify({
      clientId: opts.clientId,
      message: opts.message,
      conversationIds,
      atUserIds,
      markdown: opts.markdown,
    });

    console.log(`\n✅ 成功: ${result.success}, ❌ 失败: ${result.fail}`);
    process.exit(result.fail > 0 ? 1 : 0);
  });

program.parse(process.argv);
