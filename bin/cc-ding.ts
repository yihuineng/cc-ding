#!/usr/bin/env ts-node

import { loadEnv, projUtil } from '../src/common';
import { Command } from 'commander';
import { ensureClientDir, getHomeDir, initClientDir } from '../src/biz/session';
import path from 'path';
import { DingClaude, IConfig } from '../src/biz/cc-ding-cli';
import { acquirePidLock } from '../src/biz/lock';
import { printDoctorResults, runDoctor } from '../src/biz/doctor';
import { sendNotify } from '../src/biz/notify';
import { writeSendSignal, type ISendSignal } from '../src/biz/send-queue';
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
  $ cc-ding init -ci {clientId} -cs {clientSecret} -u {user} -dt {defaultDingToken}
  $ cc-ding run -ci {clientId}
`)
  .version(projUtil().getPkgVersion());

program
  .command('init')
  .description('初始化cc-ding配置文件, 生成最简config.json')
  .requiredOption('-ci, --clientId <value>', 'clientId')
  .requiredOption('-cs, --clientSecret <value>', 'clientSecret (钉钉Stream连接密钥)')
  .requiredOption('-u, --user <value>', 'user (自己的手机号或工号, 自动设为owner并加入白名单)')
  .requiredOption('-dt, --defaultDingToken <value>', 'defaultDingToken (兜底钉钉机器人Token)')
  .option('-cn, --clientName <value>', 'clientName (机器人名称, 可选)')
  .action(async (opts) => {
    // init 命令执行前检查 Node 版本
    const nodeVersion = process.version.slice(1);
    const nodeMajor = parseInt(nodeVersion.split('.')[0], 10);
    if (nodeMajor < 22) {
      console.log('\n❌ Node 版本过低，无法执行 init 命令');
      console.log(`  当前版本：${nodeVersion}`);
      console.log('  要求：Node >= 22');
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
      owner: opts.user,
      whiteUserList: [ opts.user ],
      clientSecret: opts.clientSecret,
      defaultDingToken: opts.defaultDingToken,
      conversations: [],
      includeThinking: false,
      resultOnly: true,
      debug: false,
      taskQueueSize: 10,
      taskHandlerCount: 1,
      sessionMaxConcurrency: 20,
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
  .description('通过钉钉机器人发送消息到指定群或单聊')
  .requiredOption('-ci, --clientId <value>', 'clientId')
  .requiredOption('-c, --conversations <value>', '目标会话ID（多个用逗号分隔）')
  .requiredOption('-m, --message <value>', '消息内容')
  .option('-at, --atUserIds <value>', '@ 指定用户（多个用逗号分隔）')
  .option('-mo, --mobile <value>', '单聊目标手机号（多个用逗号分隔，与 conversations 一一对应）')
  .option('-md, --markdown', '使用 Markdown 格式发送', false)
  .action(async (opts) => {
    const conversationIds = opts.conversations.split(',').map((s: string) => s.trim()).filter(Boolean);
    const atUserIds = opts.atUserIds ? opts.atUserIds.split(',').map((s: string) => s.trim()).filter(Boolean) : [];

    // 解析 --mobile 映射（与 conversations 一一对应）
    const mobiles: string[] = opts.mobile
      ? opts.mobile.split(',').map((s: string) => s.trim()).filter(Boolean)
      : [];

    console.log(`📤 发送消息到 ${conversationIds.length} 个会话...`);
    const result = await sendNotify({
      clientId: opts.clientId,
      message: opts.message,
      conversationIds,
      atUserIds,
      mobiles,
      markdown: opts.markdown,
    });

    console.log(`\n✅ 成功: ${result.success}, ❌ 失败: ${result.fail}`);
    process.exit(result.fail > 0 ? 1 : 0);
  });

program
  .command('push')
  .description('主动向钉钉群推送图片或文件（通过文件信号队列异步投递）')
  .requiredOption('-ci, --clientId <value>', 'clientId')
  .requiredOption('-c, --conversationId <value>', '目标会话ID')
  .option('-i, --image <path>', '图片文件路径（与 --file 二选一必填）')
  .option('-f, --file <path>', '文件路径（与 --image 二选一必填）')
  .option('--caption <value>', '附加说明文字')
  .action((opts) => {
    const { clientId, conversationId, image, file, caption } = opts;

    // --image 和 --file 二选一必填
    if (!image && !file) {
      console.error('❌ 请指定 --image 或 --file 参数');
      process.exit(1);
    }
    if (image && file) {
      console.error(' --image 和 --file 不能同时指定');
      process.exit(1);
    }

    const filePath = image || file!;
    const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);

    // 检查文件是否存在
    if (!fs.existsSync(absolutePath)) {
      console.error(`❌ 文件不存在: ${absolutePath}`);
      process.exit(1);
    }

    const type: 'image' | 'file' = image ? 'image' : 'file';
    const signal: ISendSignal = {
      type,
      path: absolutePath,
      conversationId,
      caption,
      timestamp: Date.now(),
    };

    writeSendSignal(clientId, signal);
    console.log(`✅ 推送信号已写入，等待主进程处理`);
    console.log(`   类型: ${type}`);
    console.log(`   会话: ${conversationId}`);
    console.log(`   文件: ${absolutePath}`);
    if (caption) console.log(`   说明: ${caption}`);
  });

program
  .command('a2a-server')
  .description('启动全局 A2A Hub 服务（WebSocket + Agent 注册表 + 任务路由）')
  .requiredOption('-k, --apiKey <value>', 'Hub API Key（用于认证）')
  .option('-p, --port <value>', 'HTTP 端口', '3000')
  .option('-t, --timeout <value>', '心跳超时秒数', '60')
  .action(async (opts) => {
    const { A2AHub } = await import('../src/biz/a2a/hub');
    const port = parseInt(opts.port, 10);
    const timeout = parseInt(opts.timeout, 10);

    const hub = new A2AHub({
      port,
      apiKey: opts.apiKey,
      heartbeatTimeout: timeout,
    });

    hub.start();

    console.log(`[A2A-Hub] API Key: ${opts.apiKey}`);
    console.log(`[A2A-Hub] 心跳超时: ${timeout}s`);
    console.log(`[A2A-Hub] 端点:`);
    console.log(`  GET  /                    - Dashboard 控制台`);
    console.log(`  GET  /health              - 健康检查`);
    console.log(`  GET  /hub/agents          - 列出所有 Agent`);
    console.log(`  GET  /hub/clients         - 列出已连接 Client`);
    console.log(`  POST /a2a/{id}/tasks/send - 任务路由`);

    // 优雅退出
    process.on('SIGINT', async () => {
      console.log('\n[A2A-Hub] 正在关闭...');
      await hub.stop();
      console.log('[A2A-Hub] 已关闭');
      process.exit(0);
    });
    process.on('SIGTERM', async () => {
      await hub.stop();
      process.exit(0);
    });
  });

program
  .command('console')
  .description(`
        - 功能: 启动 Console Web 管理界面
        - 默认端口: 8080（可通过 ~/.cc-ding/config.json 的 console.port 修改）
        - 默认地址: 0.0.0.0（可通过 ~/.cc-ding/config.json 的 console.host 修改）
        - 默认账号: admin / admin（首次登录强制修改密码）
        - 管理多个 Client 配置、API Key、文件等
      `)
  .option('-p, --port <value>', 'HTTP 端口')
  .option('--host <value>', 'HTTP 监听地址')
  .option('--no-browser', '禁止自动打开浏览器')
  .option('--open', '仅打印 URL 并退出（不启动服务）')
  .action(async (opts) => {
    const { startConsoleServer, getConsoleUrl, getConsolePort, getConsoleHost } = await import('../src/biz/console');

    if (opts.open) {
      const port = opts.port ? parseInt(opts.port, 10) : getConsolePort();
      const host = opts.host || getConsoleHost();
      console.log(getConsoleUrl(port, host));
      return;
    }

    const options: { port?: number; host?: string; autoOpen?: boolean; noBrowser?: boolean } = {};
    if (opts.port) options.port = parseInt(opts.port, 10);
    if (opts.host) options.host = opts.host;
    if (opts.browser === false) options.noBrowser = true;
    options.autoOpen = true;

    const server = await startConsoleServer(options);
    console.log(`[Console] 按 Ctrl+C 停止服务`);

    // 优雅退出
    process.on('SIGINT', async () => {
      await server.stop();
      process.exit(0);
    });
    process.on('SIGTERM', async () => {
      await server.stop();
      process.exit(0);
    });
  });

program.parse(process.argv);
