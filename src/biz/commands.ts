import fs from 'fs';
import path from 'path';
import { IConfig } from './types';


// ==================== 命令注册表 ====================

type CommandCategory = '会话' | '任务' | '文件' | '系统' | '管理';

interface ICommandDef {
  name: string;
  aliases?: string[];
  description: string;
  usage: string;
  examples: string[];
  category: CommandCategory;
  ownerOnly?: boolean;
}

const COMMAND_REGISTRY: ICommandDef[] = [
  {
    name: '/help',
    description: '查看所有可用命令',
    usage: '/help',
    examples: [ '/help' ],
    category: '系统',
  },
  {
    name: '/info',
    description: '查看群配置、会话和任务信息',
    usage: '/info [robot|session|task]',
    examples: [ '/info', '/info robot', '/info session', '/info task' ],
    category: '系统',
  },
  {
    name: '/log',
    description: '查看最近会话日志',
    usage: '/log [行数]',
    examples: [ '/log', '/log 20' ],
    category: '会话',
  },
  {
    name: '/new',
    description: '开始新的对话会话(结束当前会话)',
    usage: '/new [初始消息]',
    examples: [ '/new', '/new 帮我分析一下这个项目' ],
    category: '会话',
  },
  {
    name: '/resume',
    description: '继续指定的历史会话(可指定会话ID,不指定则恢复最近一个)',
    usage: '/resume [会话ID]',
    examples: [ '/resume', '/resume abc123' ],
    category: '会话',
  },
  {
    name: '/end',
    description: '结束当前会话',
    usage: '/end',
    examples: [ '/end' ],
    category: '会话',
  },
  {
    name: '/goon',
    description: '强制重启 Claude 进程并发送"继续"恢复执行',
    usage: '/goon',
    examples: [ '/goon' ],
    category: '会话',
  },
  {
    name: '/cc',
    description: '直接透传消息给 Claude（不附加发送人信息）',
    usage: '/cc <消息>',
    examples: [ '/cc 继续', '/cc /compact' ],
    category: '会话',
  },
  {
    name: '/task',
    description: '提交任务到队列',
    usage: '/task <任务描述>',
    examples: [ '/task 帮我重构登录模块' ],
    category: '任务',
  },
  {
    name: '/mq',
    description: '查看和管理当前会话消息队列',
    usage: '/mq | /mq front | /mq rm <序号> | /mq rm <1-3> | /mq -n <数量> | /mq -all',
    examples: [ '/mq', '/mq front', '/mq rm 1', '/mq rm 1-3', '/mq rm 1 3 5', '/mq -n 1', '/mq -all' ],
    category: '任务',
  },
  {
    name: '/cron',
    description: '创建和管理定时任务(Claude自动分析自然语言)',
    usage: '/cron <自然语言描述> | /cron <cron表达式> <任务描述> | /cron list|pause|resume|delete <id>',
    examples: [ '/cron 每天早上9点查看dima任务', '/cron 0 9 * * * 查看dima任务', '/cron list', '/cron pause cron_123', '/cron delete cron_123' ],
    category: '任务',
  },
  {
    name: '/ls',
    description: '查看工作目录结构',
    usage: '/ls [目标目录] [展开层数]',
    examples: [ '/ls', '/ls root 2', '/ls product 1' ],
    category: '文件',
  },
  {
    name: '/claude.md',
    description: '查看当前工作目录的 CLAUDE.md 文件内容',
    usage: '/claude.md',
    examples: [ '/claude.md' ],
    category: '文件',
  },
  {
    name: '/version',
    description: '查看工具版本信息',
    usage: '/version',
    examples: [ '/version' ],
    category: '系统',
  },
  {
    name: '/open',
    description: '在文件管理器、终端或VS Code中打开工作目录',
    usage: '/open [shell|code]',
    examples: [ '/open', '/open shell', '/open code' ],
    category: '管理',
  },
  {
    name: '/clean',
    description: '清除历史会话和缓存(.sessions/.tasks/.images/.playwright-cli)',
    usage: '/clean',
    examples: [ '/clean' ],
    category: '管理',
  },
  {
    name: '/reset-apikeycfg',
    description: '重置API Key配置(将所有Key标记为有效)',
    usage: '/reset-apikeycfg',
    examples: [ '/reset-apikeycfg' ],
    category: '管理',
  },
  {
    name: '/cfg',
    description: '注册当前群到配置，或刷新指定字段(已注册群)',
    usage: '/cfg [--conversationId xxx] [--dingToken xxx] [--linkConversationId yyy] [--whiteUserList 138xxxx,139xxxx] [--conversationTitle 名称] [--atSender true|false] [--receiveReply true|false] [--preBash "命令"] [--permissionMode mode]',
    examples: [ '/cfg', '/cfg --dingToken myToken --whiteUserList 13800138000,13900139000', '/cfg --conversationTitle 工作群', '/cfg --whiteUserList 13800138000', '/cfg --atSender false', '/cfg --receiveReply false', '/cfg --preBash "source .env"', '/cfg --permissionMode auto', '/cfg --conversationId targetConvId --dingToken xxx --conversationTitle 目标群' ],
    category: '管理',
  },
  {
    name: '/bash',
    description: '在工作目录执行 bash 命令（仅 owner/管理员，执行将记录审计日志；如配置了 preBash 全局/群级别，将叠加前置执行）',
    usage: '/bash <命令>',
    examples: [ '/bash ls -la', '/bash pwd', '/bash git status' ],
    category: '文件',
  },
  {
    name: '/auth',
    description: '管理白名单和管理员(add/del/rm/admin,默认list)',
    usage: '/auth [add|del|rm <手机号或userId>] | /auth admin [add|rm <手机号或userId>] | /auth [approve|reject <requestId>]',
    examples: [ '/auth', '/auth add 13800138000', '/auth rm 13800138000', '/auth admin add 13800138000', '/auth admin rm 13800138000', '/auth admin', '/auth approve r1234' ],
    category: '管理',
    ownerOnly: true,
  },
  {
    name: '/recorder',
    description: 'Recorder 模式：记录所有消息到本地（仅 owner/管理员单聊，发送 /recorder exit 退出）',
    usage: '/recorder [on|exit]',
    examples: [ '/recorder on', '/recorder exit' ],
    category: '管理',
  },
  {
    name: '/todo',
    description: '待办管理：添加/完成/删除/列表/提醒/模式切换',
    usage: '/todo <内容> [@人] [ddl 截止时间] | /todo done <序号> | /todo rm <序号|all> | /todo list | /todo remind <0-23> | /todo mode <staffId|dingtalkId>',
    examples: [ '/todo 完成报告 ddl 明天', '/todo 修复bug @张三 ddl 下周五', '/todo done 1', '/todo rm 2', '/todo rm all', '/todo list', '/todo remind 9', '/todo remind -1', '/todo mode dingtalkId' ],
    category: '任务',
  },
  {
    name: '/menu',
    description: '快捷指令菜单：自定义常用指令，回复序号执行',
    usage: '/menu add <指令> | /menu del <序号> | /menu list | /menu trigger <词> | /menu -g add/del/list',
    examples: [ '/menu add /help', '/menu add /cron 每天早上9点查看dima', '/menu del 1', '/menu list', '/menu trigger go', '/menu -g add /info robot', '/menu -g del 1' ],
    category: '系统',
  },
  {
    name: '/!',
    description: '中断当前任务并立即处理新消息（支持 /! /！ ! ！）',
    usage: '/! | /！ | ! | ！',
    examples: [ '/!', '!' ],
    category: '会话',
  },
  {
    name: '/reboot',
    description: '重启 cc-ding 应用（需 pm2 部署）',
    usage: '/reboot [--update [tag]]',
    examples: [ '/reboot', '/reboot --update', '/reboot --update beta' ],
    category: '管理',
  },
  {
    name: '/destroy',
    description: '注销当前群机器人，删除工作目录和配置',
    usage: '/destroy [--conversationId xxx]',
    examples: [ '/destroy', '/destroy --conversationId targetConvId' ],
    category: '管理',
  },
  {
    name: '/freedom',
    description: '自由模式：开启后所有群成员均可使用机器人（跳过白名单限制）',
    usage: '/freedom | /freedom exit',
    examples: [ '/freedom', '/freedom exit' ],
    category: '管理',
  },
  {
    name: '/qa',
    description: '问答模式：开启后 Claude 以只读 plan 模式运行，所有群成员均可使用',
    usage: '/qa | /qa exit | /qa --gitRepos https://github.com/a/b | /qa --docs url1,url2 | /qa --autoPull true|false',
    examples: [ '/qa', '/qa exit', '/qa --gitRepos https://github.com/user/repo.git', '/qa --docs https://example.com/doc --autoPull true' ],
    category: '管理',
  },
];

/** 命令分类的显示顺序和图标 */
const CATEGORY_DISPLAY: { category: CommandCategory; icon: string }[] = [
  { category: '会话', icon: '💬' },
  { category: '任务', icon: '📋' },
  { category: '文件', icon: '📂' },
  { category: '系统', icon: '⚙️' },
  { category: '管理', icon: '🔧' },
];

/**
 * 解析 /help 命令，返回 true 表示匹配
 */
export function parseHelpCommand(text: string): boolean {
  return text.trim().toLowerCase() === '/help';
}

/**
 * 解析 /{cmd} --help 命令，返回命令名或 null
 */
export function parseCommandHelp(text: string): string | null {
  const trimmed = text.trim();
  const match = trimmed.match(/^(\/\w+)\s+--help$/i);
  if (!match) return null;
  return match[1].toLowerCase();
}

/**
 * 根据 /{cmd} --help 的命令名查找命令定义
 */
export function getCommandByName(name: string): ICommandDef | undefined {
  const lower = name.toLowerCase();
  return COMMAND_REGISTRY.find(cmd =>
    cmd.name.toLowerCase() === lower ||
    cmd.aliases?.some(a => a.toLowerCase() === lower),
  );
}

/**
 * 格式化帮助信息 - 所有命令列表（按分类分组，owner 命令仅在 isOwner 时显示）
 */
export function formatHelpOverview(version: string, isOwner: boolean): string {
  const visibleCommands = COMMAND_REGISTRY.filter(cmd => isOwner || !cmd.ownerOnly);
  const lines = [
    '### 🤗',
    '----',
    `- **版本:** ${version}`,
    `- **作者:** yihuineng`,
    `- **Github:** https://github.com/yihuineng/cc-ding`,
    '----',
  ];

  for (const { category, icon } of CATEGORY_DISPLAY) {
    const cmds = visibleCommands.filter(cmd => cmd.category === category);
    if (cmds.length === 0) continue;
    lines.push(`${icon} **${category}**`);
    for (const cmd of cmds) {
      lines.push(`- \`${cmd.name}\` ${cmd.description}`);
    }
    lines.push('');
  }

  lines.push('💡 输入 `/{命令} --help` 查看命令详细用法');
  return lines.join('\n');
}

/**
 * 格式化帮助信息 - 单个命令详情
 */
export function formatCommandHelp(cmd: ICommandDef): string {
  const lines = [
    `### 📖 ${cmd.name}`,
    '',
    `**描述:** ${cmd.description}`,
    '',
    `**用法:** \`${cmd.usage}\``,
  ];
  if (cmd.aliases?.length) {
    lines.push('', `**别名:** ${cmd.aliases.join(', ')}`);
  }
  lines.push('', '**示例:**');
  for (const ex of cmd.examples) {
    lines.push(`- \`${ex}\``);
  }
  return lines.join('\n');
}

export function parseEndCommand(text: string): boolean {
  return text.trim().toLowerCase() === '/end';
}

/**
 * 解析 /info 命令，返回子命令类型，非 /info 命令返回 null
 */
export function parseInfoCommand(text: string): 'all' | 'robot' | 'session' | 'task' | null {
  const trimmed = text.trim().toLowerCase();
  if (trimmed === '/info') return 'all';
  if (trimmed === '/info robot') return 'robot';
  if (trimmed === '/info session') return 'session';
  if (trimmed === '/info task') return 'task';
  return null;
}

/**
 * 格式化群配置信息
 */
export function formatConversationInfo(
  conv: IConfig['conversations'][0],
  conversationId: string,
  phoneLookup?: (userId: string) => string | null,
  workDir?: string,
): string {
  const lines = [
    `- **群ID:** ${conversationId}`,
  ];
  if (conv.conversationTitle) lines.push(`- **群名称:** ${conv.conversationTitle}`);
  if (conv.conversationType) lines.push(`- **会话类型:** ${conv.conversationType === '1' ? '单聊' : conv.conversationType === '2' ? '群聊' : conv.conversationType}`);
  if (workDir) lines.push(`- **工作目录:** \`${workDir}\``);
  if (conv.linkConversationId) lines.push(`- **关联会话ID:** ${conv.linkConversationId}`);
  if (conv.agent) lines.push(`- **agent:** ${conv.agent}`);
  if (conv.dingToken) lines.push(`- **dingToken:** ${conv.dingToken.substring(0, 8)}...`);
  if (conv.whiteUserList?.length) {
    const display = conv.whiteUserList.map(uid => {
      const phone = phoneLookup?.(uid);
      return phone || uid;
    }).join(', ');
    lines.push(`- **群白名单:** ${display}`);
  }
  if (conv.atSender === false) lines.push(`- **atSender:** false`);
  if (conv.receiveReply === false) lines.push(`- **receiveReply:** false (不回复确认消息)`);
  if (conv.freedomMode) lines.push(`- **freedomMode:** 已开启（跳过白名单限制）`);
  if (conv.useLocalOcr === false) lines.push(`- **本地OCR:** 关闭`);
  if (conv.permissionMode) lines.push(`- **permissionMode:** ${conv.permissionMode}`);
  if (conv.taskCfg?.skill) lines.push(`- **taskSkill:** ${conv.taskCfg.skill}`);
  if (conv.preBash) lines.push(`- **preBash:** \`${conv.preBash}\``);
  if (conv.qaMode) lines.push(`- **qaMode:** 已开启（只读问答模式，所有群成员可用）`);
  if (conv.qaCfg?.gitRepos?.length) lines.push(`- **QA gitRepos:** ${conv.qaCfg.gitRepos.join(', ')}`);
  if (conv.qaCfg?.docs?.length) lines.push(`- **QA docs:** ${conv.qaCfg.docs.join(', ')}`);
  if (conv.qaCfg?.autoPull) lines.push(`- **QA autoPull:** 已开启`);
  return lines.join('\n');
}

/**
 * 格式化全局核心配置
 */
export function formatGlobalConfig(cfg: IConfig): string {
  const lines = [
    `- **clientName:** ${cfg.clientName || '-'}`,
    `- **sessionMaxConcurrency:** ${cfg.sessionMaxConcurrency ?? 5}`,
    `- **taskHandlerCount:** ${cfg.taskHandlerCount ?? 1}`,
    `- **taskQueueSize:** ${cfg.taskQueueSize ?? 50}`,
    `- **includeThinking:** ${cfg.includeThinking ?? false}`,
    `- **resultOnly:** ${cfg.resultOnly ?? true}`,
  ];
  if (cfg.defaultDingToken) lines.push(`- **defaultDingToken:** ${cfg.defaultDingToken.substring(0, 8)}...`);
  if (cfg.owner) lines.push(`- **owner:** ${cfg.owner}`);
  if (cfg.whiteUserList?.length) lines.push(`- **全局白名单:** ${cfg.whiteUserList.join(', ')}`);
  if (cfg.apiKeyCfg) {
    const validCount = cfg.apiKeyCfg.claudeSettings.filter(s => s.isValid).length;
    lines.push(`- **apiKeyCfg:** ${validCount}/${cfg.apiKeyCfg.claudeSettings.length} 有效`);
    lines.push(`  - **最近重置:** ${cfg.apiKeyCfg.resetTime || '-'}`);
  }
  return lines.join('\n');
}

/**
 * 解析 /log 命令，返回要读取的行数，非 /log 命令返回 null
 */
export function parseLogCommand(text: string): number | null {
  const trimmed = text.trim();
  const match = trimmed.match(/^\/log(?:\s+(\d+))?$/i);
  if (!match) return null;
  const n = parseInt(match[1], 10);
  return isNaN(n) || n <= 0 ? 10 : n;
}

/**
 * 解析 /ls 命令，返回 { target, depth }，非 /ls 命令返回 null
 * 格式: /ls [target] [depth]
 *   /ls              -> { target: '', depth: 1 }
 *   /ls root 1       -> { target: 'root', depth: 1 }
 *   /ls product 2    -> { target: 'product', depth: 2 }
 */
export function parseLsCommand(text: string): { target: string; depth: number } | null {
  const trimmed = text.trim();
  const match = trimmed.match(/^\/ls(?:\s+(.+))?$/i);
  if (!match) return null;
  if (match[1] === undefined) return { target: '', depth: 1 };
  const parts = match[1].trim().split(/\s+/);
  const target = parts[0] || '';
  const depth = parts[1] ? parseInt(parts[1], 10) : 1;
  return { target, depth: isNaN(depth) || depth < 0 ? 1 : Math.min(depth, 5) };
}

/**
 * 在指定目录下查找名称匹配的子目录（广度优先，忽略隐藏目录）
 */
export function findSubdirByName(dirPath: string, name: string, maxSearchDepth: number = 3): string | null {
  const queue: Array<{ dir: string; depth: number }> = [{ dir: dirPath, depth: 0 }];
  while (queue.length > 0) {
    const { dir, depth } = queue.shift()!;
    if (depth > maxSearchDepth) continue;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        if (entry.name === name) return path.join(dir, entry.name);
        queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
      }
    } catch { continue; }
  }
  return null;
}

/**
 * 获取目录结构（忽略隐藏文件/文件夹）
 * - 使用 ". " 缩进区分层级,因为钉钉消息会将多个空格合并为一个
 * - 不用 tree 符号, 因为钉钉消息行高较高, 展示效果不好
 */
export function getDirectoryStructure(dirPath: string, depth: number = 0, maxDepth: number = 1): string {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true })
      .filter(e => !e.name.startsWith('.'));
    if (entries.length === 0) {
      return depth === 0 ? '📂 目录为空' : '';
    }
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    const lines: string[] = [];
    const indent = '. '.repeat(depth);
    for (const entry of entries) {
      const icon = entry.isDirectory() ? '📁 ' : '📄 ';
      const suffix = entry.isDirectory() ? '/' : '';
      lines.push(`${indent}${icon}${entry.name}${suffix}`);
      if (entry.isDirectory() && depth < maxDepth) {
        const subPath = path.join(dirPath, entry.name);
        const subLines = getDirectoryStructure(subPath, depth + 1, maxDepth);
        if (subLines) {
          lines.push(subLines);
        }
      }
    }
    return lines.join('\n');
  } catch {
    return depth === 0 ? '❌ 无法读取目录' : '';
  }
}

/**
 * 解析 /resume 命令，返回会话ID或 null
 * - /resume abc123 -> 'abc123'
 * - /resume -> '' (空字符串，表示恢复最近会话)
 * - 其他 -> null
 */
export function parseContinueSessionCommand(text: string): string | null {
  const trimmed = text.trim().match(/^\/resume(?:\s+(\S+))?$/i);
  if (!trimmed) return null;
  // 有参数返回参数，无参数返回空字符串表示恢复最近会话
  return trimmed[1] !== undefined ? trimmed[1] : '';
}

/**
 * 简单的5位cron表达式格式校验（用于命令解析阶段快速判断）
 */
function looksLikeCronExpression(s: string): boolean {
  const fields = s.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  // 每个字段只含数字 * - / ,
  return fields.every(f => /^[\d*/\-]+$/.test(f));
}

/**
 * 解析 /cron 命令
 * - /cron list | /cron ls           → list
 * - /cron delete|rm <id>            → delete
 * - /cron pause <id>                → pause
 * - /cron resume <id>               → resume
 * - /cron <5位cron> <任务描述>       → create_cron (直接指定cron表达式)
 * - /cron <自然语言>                 → create_nl  (Claude分析)
 */
export type CronCommand =
  | { type: 'create_nl'; input: string }
  | { type: 'create_cron'; cronExpression: string; prompt: string }
  | { type: 'list' }
  | { type: 'delete'; id: string }
  | { type: 'pause'; id: string }
  | { type: 'resume'; id: string };

export function parseCronCommand(text: string): CronCommand | null {
  const trimmed = text.trim();
  if (!trimmed.toLowerCase().startsWith('/cron')) return null;

  const rest = trimmed.substring(5).trim();
  if (!rest) return null;

  // /cron list | /cron ls
  if (/^(list|ls)$/i.test(rest)) return { type: 'list' };

  // /cron delete|rm <id>
  const deleteMatch = rest.match(/^(?:delete|rm)\s+(\S+)$/i);
  if (deleteMatch) return { type: 'delete', id: deleteMatch[1] };

  // /cron pause <id>
  const pauseMatch = rest.match(/^pause\s+(\S+)$/i);
  if (pauseMatch) return { type: 'pause', id: pauseMatch[1] };

  // /cron resume <id>
  const resumeMatch = rest.match(/^resume\s+(\S+)$/i);
  if (resumeMatch) return { type: 'resume', id: resumeMatch[1] };

  // /cron <5位cron表达式> <任务描述>
  const cronDirectMatch = rest.match(/^(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.+)$/);
  if (cronDirectMatch && looksLikeCronExpression(cronDirectMatch[1])) {
    return { type: 'create_cron', cronExpression: cronDirectMatch[1], prompt: cronDirectMatch[2] };
  }

  // /cron <自然语言描述>
  return { type: 'create_nl', input: rest };
}

/**
 * 解析 /version 命令
 */
export function parseVersionCommand(text: string): boolean {
  return text.trim().toLowerCase() === '/version';
}

/**
 * 解析 /open 命令
 * - /open      -> 'folder' (在文件管理器中打开)
 * - /open shell -> 'shell' (在终端中打开)
 * - 其他 -> null
 */
export function parseOpenCommand(text: string): 'folder' | 'shell' | 'code' | null {
  const trimmed = text.trim().toLowerCase();
  if (trimmed === '/open') return 'folder';
  if (trimmed === '/open shell') return 'shell';
  if (trimmed === '/open code') return 'code';
  return null;
}

/**
 * 解析 /clean 命令
 * - /clean -> 'current' (当前群)
 * - /clean all -> 'all' (所有群)
 * - 其他 -> null
 */
export function parseCleanCommand(text: string): 'current' | 'all' | null {
  const trimmed = text.trim().toLowerCase();
  if (trimmed === '/clean') return 'current';
  if (trimmed === '/clean all') return 'all';
  return null;
}

/**
 * 解析 /reset-apikeycfg 命令
 */
export function parseResetApiKeyCfgCommand(text: string): boolean {
  return text.trim().toLowerCase() === '/reset-apikeycfg';
}

/**
 * 解析 /cfg 命令
 * 格式: /cfg [--dingToken xxx] [--linkConversationId yyy] [--whiteUserList 123,456] [--conversationTitle 名称] [--atSender true|false] [--receiveReply true|false]
 * - /cfg                                -> 注册当前群（所有选项均为默认值）
 * - /cfg --dingToken xxx               -> 指定 dingToken
 * - /cfg --atSender false              -> 关闭回复时 at 发送人
 * - /cfg --receiveReply false          -> 关闭"收到"确认消息
 * - 其他                                -> null
 */
export interface ICfgOptions {
  dingToken?: string;
  linkConversationId?: string;
  whiteUserList?: string[];
  conversationTitle?: string;
  conversationId?: string;
  atSender?: boolean;
  receiveReply?: boolean;
  preBash?: string;
  permissionMode?: string;
}

export function parseCfgCommand(text: string): ICfgOptions | null {
  const trimmed = text.trim();
  if (!/^\/cfg(?:\s|$)/i.test(trimmed)) return null;

  const rest = trimmed.substring(4).trim();

  // 无参数，直接返回空对象
  if (!rest) return {};

  // --help 请求，返回 null 交由 --help 处理器处理
  if (/^--help$/i.test(rest)) return null;

  const result: ICfgOptions = {};
  // 逐个解析 --key value
  const tokens = rest.split(/\s+/);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '--dingToken' && tokens[i + 1]) {
      result.dingToken = tokens[++i];
    } else if (token === '--linkConversationId' && tokens[i + 1]) {
      result.linkConversationId = tokens[++i];
    } else if (token === '--conversationId' && tokens[i + 1]) {
      result.conversationId = tokens[++i];
    } else if (token === '--whiteUserList' && tokens[i + 1]) {
      result.whiteUserList = tokens[++i].split(',').map(s => s.trim()).filter(Boolean);
    } else if (token === '--conversationTitle' && tokens[i + 1]) {
      // conversationTitle 可能包含空格，取到下一个 -- 之前的所有内容
      const titleParts: string[] = [];
      while (i + 1 < tokens.length && !tokens[i + 1].startsWith('--')) {
        titleParts.push(tokens[++i]);
      }
      if (titleParts.length > 0) {
        result.conversationTitle = titleParts.join(' ');
      }
    } else if (token === '--atSender' && tokens[i + 1]) {
      const val = tokens[++i].toLowerCase();
      result.atSender = val === 'true' || val === '1' || val === 'yes';
    } else if (token === '--receiveReply' && tokens[i + 1]) {
      const val = tokens[++i].toLowerCase();
      result.receiveReply = val === 'true' || val === '1' || val === 'yes';
    } else if (token === '--preBash' && tokens[i + 1]) {
      // preBash 可能包含空格，取到下一个 -- 之前的所有内容
      const bashParts: string[] = [];
      while (i + 1 < tokens.length && !tokens[i + 1].startsWith('--')) {
        bashParts.push(tokens[++i]);
      }
      if (bashParts.length > 0) {
        // 去除首尾引号
        result.preBash = bashParts.join(' ').replace(/^["']|["']$/g, '');
      }
    } else if (token === '--permissionMode' && tokens[i + 1]) {
      result.permissionMode = tokens[++i];
    }
  }

  return result;
}

/**
 * 解析 /bash 命令
 * - /bash ls -la -> 'ls -la'
 * - /bash pwd -> 'pwd'
 * - 其他 -> null
 */
export function parseBashCommand(text: string): string | null {
  const trimmed = text.trim();
  const match = trimmed.match(/^\/bash\s+(.+)$/i);
  if (!match) return null;
  const cmd = match[1].trim();
  return cmd || null;
}

/**
 * 解析 /mq 命令
 * - /mq           -> { type: 'list' }
 * - /mq front      -> { type: 'front' } (插队到队列头部)
 * - /mq rm         -> { type: 'rm', all: true } (清空全部)
 * - /mq rm <n>     -> { type: 'rm', indices: [n] } (按序号删除)
 * - /mq rm <1-3>   -> { type: 'rm', indices: [1,2,3] } (范围删除)
 * - /mq rm 1 3 5   -> { type: 'rm', indices: [1,3,5] } (多序号删除)
 * - 其他 -> null
 */
export type MqCommand =
  | { type: 'list' }
  | { type: 'front' }
  | { type: 'rm'; all?: boolean; indices?: number[] };

export function parseMqCommand(text: string): MqCommand | null {
  const trimmed = text.trim();
  if (!/^\/mq(?:\s|$)/i.test(trimmed) && trimmed.toLowerCase() !== '/mq') return null;

  const rest = trimmed.substring(3).trim();
  if (!rest) return { type: 'list' };

  // /mq front
  if (/^front$/i.test(rest)) return { type: 'front' };

  // /mq rm (无参数=清空全部; 有参数=按序号/范围删除)
  if (/^rm$/i.test(rest)) return { type: 'rm', all: true };
  const rmMatch = rest.match(/^rm\s+(.+)$/i);
  if (rmMatch) {
    const rmArg = rmMatch[1].trim();

    const indices: number[] = [];
    // 先检查是否有范围格式 (如 1-3)
    const rangeMatch = rmArg.match(/^(\d+)\s*-\s*(\d+)$/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1], 10);
      const end = parseInt(rangeMatch[2], 10);
      if (start > 0 && end >= start) {
        for (let i = start; i <= end; i++) indices.push(i);
        return { type: 'rm', indices };
      }
    }
    // 多个独立序号 (如 1 3 5)
    const parts = rmArg.split(/\s+/);
    for (const p of parts) {
      const n = parseInt(p, 10);
      if (n > 0) indices.push(n);
    }
    if (indices.length > 0) return { type: 'rm', indices };
  }

  return null;
}

/**
 * 解析 /auth 命令
 * - /auth add <userId>  -> { type: 'add', staffId: string }
 * - /auth del <userId>  -> { type: 'del', staffId: string }
 * - /auth             -> { type: 'list' }
 * - 其他              -> null
 */
export type AuthCommand =
  | { type: 'add'; staffId: string }
  | { type: 'del'; staffId: string }
  | { type: 'list' }
  | { type: 'approve'; requestId: string }
  | { type: 'reject'; requestId: string }
  | { type: 'adminAdd'; staffId: string }
  | { type: 'adminRm'; staffId: string }
  | { type: 'adminList' };

export function parseAuthCommand(text: string): AuthCommand | null {
  const trimmed = text.trim();
  // /auth admin add <userId>
  const adminAddMatch = trimmed.match(/^\/auth\s+admin\s+add\s+(\S+)$/i);
  if (adminAddMatch) return { type: 'adminAdd', staffId: adminAddMatch[1] };
  // /auth admin rm <userId>
  const adminRmMatch = trimmed.match(/^\/auth\s+admin\s+(?:rm|del)\s+(\S+)$/i);
  if (adminRmMatch) return { type: 'adminRm', staffId: adminRmMatch[1] };
  // /auth admin (list)
  if (/^\/auth\s+admin(?:\s+list)?$/i.test(trimmed)) return { type: 'adminList' };

  const addMatch = trimmed.match(/^\/auth\s+add\s+(\S+)$/i);
  if (addMatch) return { type: 'add', staffId: addMatch[1] };
  // /auth del/delete/rm <userId>
  const delMatch = trimmed.match(/^\/auth\s+(?:del(?:ete)?|rm)\s+(\S+)$/i);
  if (delMatch) return { type: 'del', staffId: delMatch[1] };
  const approveMatch = trimmed.match(/^\/auth\s+approve\s+(\S+)$/i);
  if (approveMatch) return { type: 'approve', requestId: approveMatch[1] };
  const rejectMatch = trimmed.match(/^\/auth\s+reject\s+(\S+)$/i);
  if (rejectMatch) return { type: 'reject', requestId: rejectMatch[1] };
  if (/^\/auth(?:\s+list)?$/i.test(trimmed)) return { type: 'list' };
  return null;
}

export function parseGoonCommand(text: string): boolean {
  return /^\/goon$/i.test(text.trim());
}

export function parseCcCommand(text: string): string | null {
  const trimmed = text.trim();
  const match = trimmed.match(/^\/cc\s+(.+)$/i);
  if (!match) return null;
  const cmd = match[1].trim();
  // 自动补全 / 前缀（例如 /cc compact → /compact）
  return cmd.startsWith('/') ? cmd : `/${cmd}`;
}

export function parseClaudeMdCommand(text: string): boolean {
  return /^\/claude\.md$/i.test(text.trim());
}

/**
 * 解析 /! 中断命令，支持以下形式：
 * - /!       /！       精确匹配
 * - !        ！         精确匹配
 * - ! 内容   ！内容     开头匹配，中断后内容作为消息发送
 * 注意：!! 和 ！！ 不匹配（排除连续感叹号）
 */
export function parseInterruptCommand(text: string): string | false {
  const trimmed = text.trim();
  // 精确匹配：单独的 ! 或 /!
  if (trimmed === '/!' || trimmed === '/！' || trimmed === '!' || trimmed === '！') {
    return '';
  }
  // 排除连续感叹号：!! 或 ！！
  if (trimmed.startsWith('!!') || trimmed.startsWith('！！')) {
    return false;
  }
  // 开头匹配：! 或 ！ 后跟内容（已排除 !!）
  if (trimmed.startsWith('!') || trimmed.startsWith('！')) {
    return trimmed;
  }
  // /! 或 /！ 后跟内容
  if (trimmed.startsWith('/!') || trimmed.startsWith('/！')) {
    return trimmed;
  }
  return false;
}

/**
 * 解析 /destroy 命令
 * - /destroy                           -> 注销当前群
 * - /destroy --conversationId xxx       -> 注销指定群（owner 专用）
 */
export interface IDestroyOptions {
  conversationId?: string;
}

export function parseDestroyCommand(text: string): IDestroyOptions | null {
  const trimmed = text.trim();
  if (!/^\/destroy(\b|$)/.test(trimmed)) return null;

  const rest = trimmed.substring(8).trim();
  if (!rest) return {};

  if (/^--help$/i.test(rest)) return null;

  const result: IDestroyOptions = {};
  const tokens = rest.split(/\s+/);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '--conversationId' && tokens[i + 1]) {
      result.conversationId = tokens[++i];
    }
  }
  return result;
}

/**
 * 解析 /freedom 命令
 * - /freedom             -> 进入自由模式（60s 内回复"确认"或"confirm"即可开启）
 * - /freedom exit        -> 退出自由模式
 */
export type FreedomAction = 'enter' | 'exit';

export interface IFreedomOptions {
  action: FreedomAction;
}

export function parseFreedomCommand(text: string): IFreedomOptions | null {
  const trimmed = text.trim();
  if (!/^\/freedom(\b|$)/i.test(trimmed)) return null;

  const rest = trimmed.substring(8).trim().toLowerCase();
  if (!rest) return { action: 'enter' };
  if (rest === 'exit') return { action: 'exit' };
  return null;
}

/**
 * 解析 /qa 命令
 * - /qa                                    -> 进入问答模式
 * - /qa exit                               -> 退出问答模式
 * - /qa --gitRepos https://github.com/a/b  -> 配置 git 仓库链接
 * - /qa --docs url1,url2                   -> 配置参考文档
 * - /qa --autoPull true|false              -> 配置自动拉取
 * - /qa --gitRepos url1,url2 --autoPull y  -> 组合配置
 */
export type QaAction = 'enter' | 'exit' | 'config';

export interface IQaOptions {
  action: QaAction;
  gitRepos?: string[];
  docs?: string[];
  autoPull?: boolean;
}

export function parseQaCommand(text: string): IQaOptions | null {
  const trimmed = text.trim();
  if (!/^\/qa(\b|$)/i.test(trimmed)) return null;

  const rest = trimmed.substring(3).trim();
  if (!rest) return { action: 'enter' };

  const lowerRest = rest.toLowerCase();
  if (lowerRest === 'exit') return { action: 'exit' };

  // 解析参数：--gitRepos / --docs / --autoPull
  const tokens = rest.split(/\s+/);
  const result: IQaOptions = { action: 'config' };
  let hasConfig = false;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '--gitRepos' && tokens[i + 1]) {
      result.gitRepos = tokens[++i].split(',').map(s => s.trim()).filter(Boolean);
      hasConfig = true;
    } else if (token === '--docs' && tokens[i + 1]) {
      result.docs = tokens[++i].split(',').map(s => s.trim()).filter(Boolean);
      hasConfig = true;
    } else if (token === '--autoPull' && tokens[i + 1]) {
      const val = tokens[++i].toLowerCase();
      result.autoPull = val === 'true' || val === '1' || val === 'yes';
      hasConfig = true;
    } else {
      // 非预期参数，不匹配
      return null;
    }
  }

  return hasConfig ? result : null;
}

/**
 * 解析 /todo 命令
 * - /todo <内容> [@人] [ddl 截止]  -> add
 * - /todo done <序号>              -> done
 * - /todo rm <序号|all>            -> remove
 * - /todo list                     -> list
 * - /todo remind <0-23|-1>         -> remind
 * - /todo mode <staffId|dingtalkId> -> mode
 */
export type TodoCommand =
  | { type: 'add'; content: string; assigneeId?: string; assigneeNick?: string; deadline?: string }
  | { type: 'done'; index: number }
  | { type: 'remove'; index: number | 'all' }
  | { type: 'list' }
  | { type: 'remind'; hour: number | null } // null = 关闭提醒
  | { type: 'mode'; mode: 'staffId' | 'dingtalkId' };

export function parseTodoCommand(text: string, atUsers?: Array<{ staffId?: string; dingtalkId?: string }>): TodoCommand | null {
  const trimmed = text.trim();
  if (!/^\/todo(?:\s|$)/i.test(trimmed) && trimmed.toLowerCase() !== '/todo') return null;

  const rest = trimmed.substring(5).trim();

  // /todo list
  if (/^list$/i.test(rest)) return { type: 'list' };

  // /todo list (无参数也等同于 list)
  if (!rest) return { type: 'list' };

  // /todo mode <staffId|dingtalkId>
  const modeMatch = rest.match(/^mode\s+(staffId|dingtalkId)$/i);
  if (modeMatch) return { type: 'mode', mode: modeMatch[1] as 'staffId' | 'dingtalkId' };

  // /todo done <序号>
  const doneMatch = rest.match(/^done\s+(\d+)$/i);
  if (doneMatch) return { type: 'done', index: parseInt(doneMatch[1], 10) };

  // /todo rm all
  if (/^rm\s+all$/i.test(rest)) return { type: 'remove', index: 'all' };

  // /todo rm <序号>
  const rmMatch = rest.match(/^rm\s+(\d+)$/i);
  if (rmMatch) return { type: 'remove', index: parseInt(rmMatch[1], 10) };

  // /todo remind -1 (关闭)
  if (/^remind\s+-1$/i.test(rest)) return { type: 'remind', hour: null };

  // /todo remind <0-23>
  const remindMatch = rest.match(/^remind\s+(\d+)$/i);
  if (remindMatch) {
    const h = parseInt(remindMatch[1], 10);
    if (h >= 0 && h <= 23) return { type: 'remind', hour: h };
    return null;
  }

  // /todo <内容> [@人] [ddl 截止时间]
  let content = rest;
  let assigneeId: string | undefined;
  let assigneeNick: string | undefined;
  let deadline: string | undefined;

  // 提取 @人：优先从 atUsers 中解析（自动匹配），回退到文本提取
  const atMatch = content.match(/@(\S+)/);
  if (atMatch) {
    const atText = atMatch[1];
    content = content.replace(/@\S+/, '').trim();
    // atUsers 参数预留：未来可实现自动将 @昵称 匹配为 staffId/dingtalkId
    void atUsers;
    assigneeId = atText;
    assigneeNick = atText;
  }

  // 提取 ddl
  const ddlMatch = content.match(/\bddl\s+(.+)$/i);
  if (ddlMatch) {
    deadline = ddlMatch[1].trim();
    content = content.replace(/\bddl\s+.+$/i, '').trim();
  }

  if (!content) return null;

  return { type: 'add', content, assigneeId, assigneeNick, deadline };
}

/**
 * 解析 /menu 命令
 * - /menu add <指令>            -> add (个人)
 * - /menu del <序号>            -> del (个人)
 * - /menu list                  -> list (个人)
 * - /menu trigger <词>          -> trigger
 * - /menu -g add <指令>         -> addGlobal
 * - /menu -g del <序号>         -> delGlobal
 * - /menu -g list               -> listGlobal
 * - /menu                       -> show (显示菜单)
 */
export type MenuCommand =
  | { type: 'add'; command: string; isGlobal: boolean }
  | { type: 'del'; index: number; isGlobal: boolean }
  | { type: 'list'; isGlobal: boolean }
  | { type: 'trigger'; word: string }
  | { type: 'show' };

export function parseMenuCommand(text: string): MenuCommand | null {
  const trimmed = text.trim();
  if (!/^\/menu(?:\s|$)/i.test(trimmed) && trimmed.toLowerCase() !== '/menu') return null;

  const rest = trimmed.substring(5).trim();
  const isGlobal = rest.startsWith('-g ');
  const cmd = isGlobal ? rest.substring(3).trim() : rest;

  // /menu (无参数) -> show
  if (!rest) return { type: 'show' };

  // /menu -g (无后续参数) -> listGlobal
  if (isGlobal && !cmd) return { type: 'list', isGlobal: true };

  // /menu trigger <词>
  const triggerMatch = cmd.match(/^trigger\s+(\S+)$/i);
  if (triggerMatch && !isGlobal) return { type: 'trigger', word: triggerMatch[1] };

  // /menu add <指令>
  const addMatch = cmd.match(/^add\s+(.+)$/i);
  if (addMatch) return { type: 'add', command: addMatch[1].trim(), isGlobal };

  // /menu del <序号>
  const delMatch = cmd.match(/^del(?:ete)?\s+(\d+)$/i);
  if (delMatch) return { type: 'del', index: parseInt(delMatch[1], 10), isGlobal };

  // /menu list
  if (/^list$/i.test(cmd)) return { type: 'list', isGlobal };

  // /menu (仅 -g 无后续) 或 其他无匹配时 → show
  if (!isGlobal) return { type: 'show' };

  return null;
}

/**
 * 解析 /reboot 命令
 * - /reboot              -> { update: false }
 * - /reboot --update     -> { update: true, tag: undefined }
 * - /reboot --update tag -> { update: true, tag: 'tag' }
 */
export interface IRebootCommand {
  update: boolean;
  tag?: string;
}

export function parseRebootCommand(text: string): IRebootCommand | null {
  const trimmed = text.trim();
  if (!/^\/reboot(?:\s|$)/i.test(trimmed)) return null;

  const rest = trimmed.substring(7).trim();
  if (!rest) return { update: false };

  const updateMatch = rest.match(/^--update(?:\s+(\S+))?$/i);
  if (updateMatch) {
    return { update: true, tag: updateMatch[1] };
  }

  return null;
}

/**
 * 解析 /recorder 命令
 */
export function parseRecorderCommandEnhanced(text: string): 'on' | 'exit' | null {
  const trimmed = text.trim();
  if (/^\/recorder\s+on$/i.test(trimmed)) return 'on';
  if (/^\/recorder\s+exit$/i.test(trimmed)) return 'exit';
  return null;
}
