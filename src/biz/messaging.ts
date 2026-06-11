import { baseUtil } from 'utils-ok';
import urllib from 'urllib';
import type { DingClaude } from './cc-ding-cli';
import { ISendMsgOpts, IDingUserDetail } from './types';
import { resolveSecret } from './secrets';

const DING_API_BASE = 'https://api.dingtalk.com';
const DING_OAPI_BASE = 'https://oapi.dingtalk.com';

/**
 * 通过钉钉服务端 API 获取引用消息的文本内容
 * GET /v1.0/im/api/messages/{messageId}
 */
export async function fetchQuotedMessage(self: DingClaude, messageId: string): Promise<string | null> {
  try {
    const accessToken = await self.dingStreamClient.getAccessToken();
    const url = `${DING_API_BASE}/v1.0/im/api/messages/${encodeURIComponent(messageId)}`;

    const result = await urllib.request(url, {
      method: 'GET',
      headers: { 'x-acs-dingtalk-access-token': accessToken },
      dataType: 'json',
      timeout: 5000,
    });

    if (result.status !== 200 || !result.data) {
      self.debugLog(`fetchQuotedMessage API 返回非200: status=${result.status}, data=${JSON.stringify(result.data)}`);
      return null;
    }

    const body = result.data as Record<string, unknown>;

    // 尝试多种字段路径提取文本
    // 路径1: body.text.content (文本消息)
    if (body.text && typeof body.text === 'object') {
      const text = (body.text as Record<string, unknown>).content;
      if (typeof text === 'string' && text) return text.trim();
    }

    // 路径2: body.content (JSON 编码内容)
    if (typeof body.content === 'string' && body.content) {
      try {
        const parsed = JSON.parse(body.content as string);
        if (typeof parsed === 'string') return parsed.trim();
        if (parsed.text) return String(parsed.text).trim();
        if (parsed.content) return String(parsed.content).trim();
      } catch {
        // content 不是 JSON, 当普通字符串返回
        return (body.content as string).trim();
      }
    }

    // 路径3: body.body.content (嵌套结构)
    if (body.body && typeof body.body === 'object') {
      const innerBody = body.body as Record<string, unknown>;
      if (typeof innerBody.content === 'string' && innerBody.content) {
        return innerBody.content.trim();
      }
    }

    self.debugLog(`fetchQuotedMessage 无法从响应中提取文本: keys=${Object.keys(body).join(',')}`);
    return null;
  } catch (err) {
    console.warn('fetchQuotedMessage 请求失败:', err);
    return null;
  }
}

/**
 * 根据 userid 查询用户详情
 * POST /topapi/v2/user/get
 * @see https://open.dingtalk.com/document/development/query-user-details
 */
export async function queryDingUser(self: DingClaude, userid: string): Promise<IDingUserDetail | null> {
  try {
    const accessToken = await self.dingStreamClient.getAccessToken();
    const url = `${DING_OAPI_BASE}/topapi/v2/user/get?access_token=${accessToken}`;

    const result = await urllib.request(url, {
      method: 'POST',
      data: { userid },
      contentType: 'json',
      dataType: 'json',
      timeout: 5000,
    });

    if (result.status !== 200 || !result.data) {
      self.debugLog(`queryDingUser API 返回非200: status=${result.status}, data=${JSON.stringify(result.data)}`);
      return null;
    }

    const body = result.data as Record<string, unknown>;
    // 钉钉 oapi 标准返回: { errcode: 0, errmsg: "ok", result: {...} }
    if (body.errcode !== 0) {
      console.warn(`queryDingUser 接口返回错误: errcode=${body.errcode}, errmsg=${body.errmsg}`);
      return null;
    }

    return (body.result || null) as IDingUserDetail | null;
  } catch (err) {
    console.warn('queryDingUser 请求失败:', err);
    return null;
  }
}

/**
 * 根据手机号查询 userId
 * POST /topapi/v2/user/getbymobile
 * @see https://open.dingtalk.com/document/development/query-users-by-phone-number
 */
export async function queryUserIdByMobile(self: DingClaude, mobile: string): Promise<string | null> {
  try {
    const accessToken = await self.dingStreamClient.getAccessToken();
    const url = `${DING_OAPI_BASE}/topapi/v2/user/getbymobile?access_token=${accessToken}`;

    const result = await urllib.request(url, {
      method: 'POST',
      data: { mobile },
      contentType: 'json',
      dataType: 'json',
      timeout: 5000,
    });

    if (result.status !== 200 || !result.data) {
      self.debugLog(`queryUserIdByMobile API 返回非200: status=${result.status}, data=${JSON.stringify(result.data)}`);
      return null;
    }

    const body = result.data as Record<string, unknown>;
    if (body.errcode !== 0) {
      console.warn(`queryUserIdByMobile 接口返回错误: errcode=${body.errcode}, errmsg=${body.errmsg}`);
      return null;
    }

    const resultObj = body.result as Record<string, unknown> | undefined;
    return (resultObj?.userid as string) || null;
  } catch (err) {
    console.warn('queryUserIdByMobile 请求失败:', err);
    return null;
  }
}

// Claude 工具调用标签名列表（用于过滤钉钉消息输出）
const TOOL_TAGS = [
  'Write', 'Read', 'Edit', 'Bash', 'Grep', 'Glob', 'Agent', 'Skill',
  'WebFetch', 'WebSearch', 'TaskOutput', 'AskUserQuestion',
  'EnterPlanMode', 'ExitPlanMode', 'TaskCreate', 'TaskGet', 'TaskUpdate', 'TaskList',
  'EnterWorktree', 'ExitWorktree', 'CronCreate', 'CronDelete', 'CronList',
  'LSP', 'NotebookEdit',
].join('|');

// 预编译正则表达式
const TOOL_USE_SELF_CLOSE_RE = new RegExp(`<(${TOOL_TAGS})[^>]*\\/>`, 'g');
const TOOL_USE_OPEN_CLOSE_RE = new RegExp(`<(${TOOL_TAGS})[^>]*>[\\s\\S]*?<\\/\\1>`, 'g');
const MULTI_NEWLINE_RE = /\n{3,}/g;

/**
 * 过滤 Claude 工具调用标记
 * 钉钉用户不需要看到这些内部操作信息
 */
export function filterToolUseContent(content: string): string {
  let filtered = content.replace(TOOL_USE_SELF_CLOSE_RE, '');
  filtered = filtered.replace(TOOL_USE_OPEN_CLOSE_RE, '');
  filtered = filtered.replace(MULTI_NEWLINE_RE, '\n\n');
  return filtered.trim();
}

/**
 * 分割长消息
 */
export function splitMessage(content: string, maxLength: number): string[] {
  const chunks: string[] = [];

  while (content.length > maxLength) {
    let splitIndex = content.lastIndexOf('\n', maxLength);
    if (splitIndex === -1 || splitIndex < maxLength * 0.5) {
      splitIndex = content.lastIndexOf('。', maxLength);
    }
    if (splitIndex === -1 || splitIndex < maxLength * 0.5) {
      splitIndex = content.lastIndexOf(' ', maxLength);
    }
    if (splitIndex === -1 || splitIndex < maxLength * 0.5) {
      splitIndex = maxLength;
    } else {
      splitIndex += 1;
    }

    chunks.push(content.substring(0, splitIndex).trim());
    content = content.substring(splitIndex).trim();
  }

  if (content.length > 0) {
    chunks.push(content);
  }

  return chunks;
}

/**
 * 发送钉钉消息
 */
export async function sendDingMessage(self: DingClaude, opts: ISendMsgOpts): Promise<void> {
  const { conversationId, sessionWebhook, atUserId, content, msgType = 'text' } = opts;
  const conversation = self.config.conversations.find(it => it.conversationId === conversationId);

  // 会话级 atSender 为 false 或单聊时，不 at 发送人
  let effectiveAtUserId = atUserId;
  if (conversation?.atSender === false || conversation?.conversationType === '1') {
    effectiveAtUserId = undefined;
  }

  const atUserIds = effectiveAtUserId ? [ effectiveAtUserId ] : [];

  // 优先: 会话级 dingToken > sessionWebhook > 客户端级 defaultDingToken
  const dingToken = resolveSecret(conversation?.dingToken);

  // 钉钉 markdown 消息需要在 content 中显式写 @staffId 才能触发 at 提醒
  let actualContent = content;
  if (effectiveAtUserId && msgType === 'markdown') {
    actualContent = `${content}\n@${effectiveAtUserId}`;
  }

  const body = msgType === 'markdown'
    ? {
      msgtype: 'markdown',
      markdown: { title: actualContent, text: actualContent },
      at: { atUserIds, isAtAll: false },
    }
    : {
      msgtype: 'text',
      text: { content },
      at: { atUserIds, isAtAll: false },
    };

  if (dingToken) {
    const accessToken = await self.dingStreamClient.getAccessToken();
    const url = `https://oapi.dingtalk.com/robot/send?access_token=${dingToken}`;
    try {
      await urllib.request(url, {
        method: 'POST',
        data: body,
        contentType: 'json',
        headers: { 'x-acs-dingtalk-access-token': accessToken },
        dataType: 'json',
      });
    } catch (err) {
      console.error('通过 dingToken 发送钉钉消息失败:', err);
    }
  } else if (sessionWebhook) {
    const accessToken = await self.dingStreamClient.getAccessToken();
    try {
      await urllib.request(sessionWebhook, {
        method: 'POST',
        data: body,
        contentType: 'json',
        headers: { 'x-acs-dingtalk-access-token': accessToken },
        dataType: 'json',
      });
    } catch (err) {
      console.error('通过 sessionWebhook 发送钉钉消息失败:', err);
    }
  } else if (self.config.defaultDingToken) {
    const accessToken = await self.dingStreamClient.getAccessToken();
    const url = `https://oapi.dingtalk.com/robot/send?access_token=${resolveSecret(self.config.defaultDingToken)}`;
    try {
      await urllib.request(url, {
        method: 'POST',
        data: body,
        contentType: 'json',
        headers: { 'x-acs-dingtalk-access-token': accessToken },
        dataType: 'json',
      });
    } catch (err) {
      console.error('通过 defaultDingToken 发送钉钉消息失败:', err);
    }
  } else {
    console.error('未能获取机器人信息发送途径');
  }
}

/**
 * 发送 Claude 回复到钉钉（支持分段）
 */
export async function sendClaudeResponseToDing(
  self: DingClaude,
  conversationId: string,
  sessionWebhook: string,
  atUserId: string,
  content: string,
): Promise<void> {
  const MAX_MSG_LENGTH = 18000;

  const filteredContent = filterToolUseContent(content);
  if (!filteredContent) {
    self.debugLog('过滤后内容为空，跳过发送');
    return;
  }

  if (filteredContent.length <= MAX_MSG_LENGTH) {
    await sendDingMessage(self, {
      conversationId,
      sessionWebhook,
      atUserId,
      content: filteredContent,
      msgType: 'markdown',
    });
  } else {
    const chunks = splitMessage(filteredContent, MAX_MSG_LENGTH);
    for (let i = 0; i < chunks.length; i++) {
      const chunkHeader = chunks.length > 1 ? `**[${i + 1}/${chunks.length}]**\n` : '';
      await sendDingMessage(self, {
        conversationId,
        sessionWebhook,
        atUserId: i === chunks.length - 1 ? atUserId : '',
        content: chunkHeader + chunks[i],
        msgType: 'markdown',
      });
      if (i < chunks.length - 1) {
        await baseUtil.sleep(500);
      }
    }
  }
}

/**
 * 通过钉钉机器人单聊 API 主动发消息给指定用户
 * POST /v1.0/robot/oToMessages/batchSend
 */
export async function sendMessageToUser(self: DingClaude, userId: string, content: string, msgType: 'text' | 'markdown' = 'text'): Promise<boolean> {
  if (!self.config.enableMsgToUser) {
    console.log(`[sendMessageToUser] enableMsgToUser 未开启，跳过发送 (userId=${userId})`);
    return false;
  }
  try {
    const accessToken = await self.dingStreamClient.getAccessToken();
    const msgKey = msgType === 'markdown' ? 'sampleMarkdown' : 'sampleText';
    const msgParam = msgType === 'markdown'
      ? JSON.stringify({ title: 'notification', text: content })
      : JSON.stringify({ content });

    const result = await urllib.request(`${DING_API_BASE}/v1.0/robot/oToMessages/batchSend`, {
      method: 'POST',
      data: { robotCode: self.clientId, userIds: [ userId ], msgKey, msgParam },
      contentType: 'json',
      headers: { 'x-acs-dingtalk-access-token': accessToken },
      dataType: 'json',
    });

    if (result.status === 200) return true;
    console.error(`sendMessageToUser API 返回非200: status=${result.status}, userId=${userId}`);
    return false;
  } catch (err) {
    console.error(`sendMessageToUser 失败 (userId=${userId}):`, err);
    return false;
  }
}

/**
 * 通过钉钉机器人单聊 API 主动发消息给 owner
 */
export async function sendOwnerMessage(self: DingClaude, content: string, msgType: 'text' | 'markdown' = 'text'): Promise<boolean> {
  const { ownerConversationId, owner } = self.config;
  if (!ownerConversationId || !owner) return false;
  // owner 是手机号，需要先解析成 Ding userId
  const userId = await queryUserIdByMobile(self, owner);
  if (!userId) {
    console.error(`sendOwnerMessage: 无法将手机号 ${owner} 解析为 Ding userId`);
    return false;
  }
  return sendMessageToUser(self, userId, content, msgType);
}
