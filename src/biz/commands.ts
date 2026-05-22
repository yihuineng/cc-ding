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
    name: '/task',
    description: '提交任务到队列',
    usage: '/task <任务描述>',
    examples: [ '/task 帮我重构登录模块' ],
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
    name: '/pwd',
    description: '显示当前工作目录的绝对路径',
    usage: '/pwd',
    examples: [ '/pwd' ],
    category: '文件',
  },
  {
    name: '/ls',
    description: '查看工作目录结构',
    usage: '/ls [目标目录] [展开层数]',
    examples: [ '/ls', '/ls root 2', '/ls product 1' ],
    category: '文件',
  },
  {
    name: '/mkdir',
    description: '在工作目录下创建文件夹（支持相对路径，不能超出工作目录范围）',
    usage: '/mkdir <相对路径>',
    examples: [ '/mkdir src', '/mkdir src/components', '/mkdir ./docs' ],
    category: '文件',
  },
  {
    name: '/touch',
    description: '在工作目录下创建空文件（支持相对路径，不能超出工作目录范围）',
    usage: '/touch <相对路径>',
    examples: [ '/touch README.md', '/touch src/cc-ding-cli.ts', '/touch ./config.json' ],
    category: '文件',
  },
  {
    name: '/rm',
    description: '删除工作目录下的文件或目录（支持相对路径，不能超出工作目录范围）',
    usage: '/rm <相对路径>',
    examples: [ '/rm temp.txt', '/rm src/old.ts', '/rm ./docs/obsolete/' ],
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
    description: '在文件管理器或终端中打开工作目录',
    usage: '/open [shell]',
    examples: [ '/open', '/open shell' ],
    category: '管理',
    ownerOnly: true,
  },
  {
    name: '/clean',
    description: '清除历史会话和缓存(.sessions/.tasks/.images)',
    usage: '/clean',
    examples: [ '/clean' ],
    category: '管理',
    ownerOnly: true,
  },
  {
    name: '/reset-apikeycfg',
    description: '重置API Key配置(将所有Key标记为有效)',
    usage: '/reset-apikeycfg',
    examples: [ '/reset-apikeycfg' ],
    category: '管理',
    ownerOnly: true,
  },
  {
    name: '/reg',
    description: '注册当前群到配置(未注册群可用)',
    usage: '/reg [--dingToken xxx] [--linkConversationId yyy] [--whiteUserList 138xxxx,139xxxx] [--conversationTitle 名称]',
    examples: [ '/reg', '/reg --dingToken myToken --whiteUserList 13800138000,13900139000', '/reg --conversationTitle 工作群' ],
    category: '管理',
    ownerOnly: true,
  },
  {
    name: '/auth',
    description: '管理当前群白名单(add/del,默认list)',
    usage: '/auth [add|del <手机号或userId>]',
    examples: [ '/auth', '/auth add 13800138000', '/auth del 13800138000' ],
    category: '管理',
    ownerOnly: true,
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
  const match = trimmed.match(/^(\/\w+|\S+)\s+--help$/i);
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
): string {
  const lines = [
    `- **群ID:** ${conversationId}`,
  ];
  if (conv.conversationTitle) lines.push(`- **群名称:** ${conv.conversationTitle}`);
  if (conv.linkConversationId) lines.push(`- **关联会话ID:** ${conv.linkConversationId}`);
  if (conv.agent) lines.push(`- **agent:** ${conv.agent}`);
  if (conv.dingToken) lines.push(`- **dingToken:** ${conv.dingToken}...`);
  if (conv.whiteUserList?.length) {
    const display = conv.whiteUserList.map(uid => {
      const phone = phoneLookup?.(uid);
      return phone || uid;
    }).join(', ');
    lines.push(`- **群白名单:** ${display}`);
  }
  if (conv.taskCfg?.skill) lines.push(`- **taskSkill:** ${conv.taskCfg.skill}`);
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
 * 解析 /pwd 命令
 */
export function parsePwdCommand(text: string): boolean {
  return text.trim() === '/pwd';
}

/**
 * 解析 /version 命令
 */
export function parseVersionCommand(text: string): boolean {
  return text.trim() === '/version';
}

/**
 * 解析单参数路径命令的工厂函数
 * 用于 /mkdir、/touch、/rm 等格式为 /{cmd} <路径> 的命令
 */
function parsePathCommand(text: string, command: string): string | null {
  const trimmed = text.trim();
  const match = trimmed.match(new RegExp(`^\\/${command}\\s+(.+)$`));
  if (!match) return null;
  const p = match[1].trim();
  return p || null;
}

/**
 * 解析 /mkdir 命令
 * 返回相对路径，解析失败返回 null
 */
export function parseMkdirCommand(text: string): string | null {
  return parsePathCommand(text, 'mkdir');
}

/**
 * 解析 /touch 命令
 * 返回相对路径，解析失败返回 null
 */
export function parseTouchCommand(text: string): string | null {
  return parsePathCommand(text, 'touch');
}

/**
 * 解析 /rm 命令
 * 返回相对路径，解析失败返回 null
 */
export function parseRmCommand(text: string): string | null {
  return parsePathCommand(text, 'rm');
}

/**
 * 解析 /open 命令
 * - /open      -> 'folder' (在文件管理器中打开)
 * - /open shell -> 'shell' (在终端中打开)
 * - 其他 -> null
 */
export function parseOpenCommand(text: string): 'folder' | 'shell' | null {
  const trimmed = text.trim().toLowerCase();
  if (trimmed === '/open') return 'folder';
  if (trimmed === '/open shell') return 'shell';
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
 * 解析 /reg 命令
 * 格式: /reg [--dingToken xxx] [--linkConversationId yyy] [--whiteUserList 123,456] [--conversationTitle 名称]
 * - /reg                                -> 注册当前群（所有选项均为默认值）
 * - /reg --dingToken xxx               -> 指定 dingToken
 * - 其他                                -> null
 */
export interface IRegOptions {
  dingToken?: string;
  linkConversationId?: string;
  whiteUserList?: string[];
  conversationTitle?: string;
}

export function parseRegCommand(text: string): IRegOptions | null {
  const trimmed = text.trim();
  if (!/^\/reg(?:\s|$)/i.test(trimmed)) return null;

  const rest = trimmed.substring(4).trim();

  // 无参数，直接返回空对象
  if (!rest) return {};

  // --help 请求，返回 null 交由 --help 处理器处理
  if (/^--help$/i.test(rest)) return null;

  const result: IRegOptions = {};
  // 逐个解析 --key value
  const tokens = rest.split(/\s+/);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '--dingToken' && tokens[i + 1]) {
      result.dingToken = tokens[++i];
    } else if (token === '--linkConversationId' && tokens[i + 1]) {
      result.linkConversationId = tokens[++i];
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
    }
  }

  return result;
}

/**
 * 解析 /auth 命令
 * - /auth add <userId>  -> { type: 'add', staffId: string }
 * - /auth del <userId>  -> { type: 'del', staffId: string }
 * - /auth             -> { type: 'list' }
 * - 其他              -> null
 */
export type AuthCommand = { type: 'add'; staffId: string } | { type: 'del'; staffId: string } | { type: 'list' };

export function parseAuthCommand(text: string): AuthCommand | null {
  const trimmed = text.trim();
  const addMatch = trimmed.match(/^\/auth\s+add\s+(\S+)$/i);
  if (addMatch) return { type: 'add', staffId: addMatch[1] };
  const delMatch = trimmed.match(/^\/auth\s+del(?:ete)?\s+(\S+)$/i);
  if (delMatch) return { type: 'del', staffId: delMatch[1] };
  if (/^\/auth(?:\s+list)?$/i.test(trimmed)) return { type: 'list' };
  return null;
}
