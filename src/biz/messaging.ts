import { asyncUtil } from 'utils-ok';
import urllib from 'urllib';
import fs from 'fs';
import path from 'path';
import type { DingClaude } from './cc-ding-cli';
import { ISendMsgOpts, IDingUserDetail } from './types';
import { resolveSecret } from './secrets';

const DING_API_BASE = 'https://api.dingtalk.com';
const DING_OAPI_BASE = 'https://oapi.dingtalk.com';

// ==================== 用户名缓存（@提及还原） ====================

/** 用户名缓存：staffId → nickName（进程内，重启后清空） */
const userNameCache = new Map<string, string>();

/** 缓存用户名（每次收到消息/消息回调时调用） */
export function cacheUserName(staffId: string, nickName: string): void {
  if (staffId && nickName) {
    userNameCache.set(staffId, nickName);
  }
}

/** 获取缓存的用户名 */
export function getCachedUserName(staffId: string): string | undefined {
  return userNameCache.get(staffId);
}

/**
 * 还原消息中的 @提及：将钉钉替换的 @机器人 文本恢复为 @实际用户
 * 优先级：回调原文(atUsers.displayName) > userNameCache 查找 > 保持原样
 */
export function restoreMentions(
  content: string,
  atUsers: Array<{ staffId?: string; dingtalkId?: string; displayName?: string }>,
): string {
  let result = content;
  for (const user of atUsers) {
    const id = user.staffId || user.dingtalkId;
    if (!id) continue;

    // 优先用回调自带的 displayName，其次查缓存
    const cachedName = user.displayName || getCachedUserName(id);
    if (!cachedName) continue;

    // 替换占位符（钉钉通常用零宽空格或 @机器人名 作为占位）
    result = result.replace(/\u200b/g, `${cachedName}(${id})`);
  }
  return result;
}

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

/**
 * 根据工号查询 userId
 * POST /topapi/v2/user/getbyjobnumber
 * @see https://open.dingtalk.com/document/orgapp/query-users-by-job-number
 */
export async function queryUserIdByJobNumber(self: DingClaude, jobNumber: string): Promise<string | null> {
  try {
    const accessToken = await self.dingStreamClient.getAccessToken();
    const url = `${DING_OAPI_BASE}/topapi/v2/user/getbyjobnumber?access_token=${accessToken}`;

    const result = await urllib.request(url, {
      method: 'POST',
      data: { job_number: jobNumber },
      contentType: 'json',
      dataType: 'json',
      timeout: 5000,
    });

    if (result.status !== 200 || !result.data) {
      self.debugLog(`queryUserIdByJobNumber API 返回非200: status=${result.status}, data=${JSON.stringify(result.data)}`);
      return null;
    }

    const body = result.data as Record<string, unknown>;
    if (body.errcode !== 0) {
      console.warn(`queryUserIdByJobNumber 接口返回错误: errcode=${body.errcode}, errmsg=${body.errmsg}`);
      return null;
    }

    const resultObj = body.result as Record<string, unknown> | undefined;
    return (resultObj?.userid as string) || null;
  } catch (err) {
    console.warn('queryUserIdByJobNumber 请求失败:', err);
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
        await asyncUtil.sleep(500);
      }
    }
  }

  // ensureAt: 追加一条 text 消息，确保钉钉 @ 通知生效
  const convCfg = self.config.conversations.find(c => c.conversationId === conversationId);
  if (convCfg?.ensureAt && atUserId) {
    await sendDingMessage(self, {
      conversationId,
      sessionWebhook,
      atUserId,
      content: '',
      msgType: 'text',
    });
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

// ==================== Reaction 表情 API ====================

/**
 * 在指定消息下贴表情 Reaction（收到确认）
 * POST /v1.0/contact/rpc/interaction/emoji/submit
 * @see https://open.dingtalk.com/document/orgapp/submit-emoji-reactions
 */
export async function attachReaction(
  self: DingClaude,
  conversationId: string,
  msgId: string,
  emotionId: string,
): Promise<boolean> {
  try {
    const accessToken = await self.dingStreamClient.getAccessToken();
    const url = `${DING_API_BASE}/v1.0/contact/rpc/interaction/emoji/submit`;

    const result = await urllib.request(url, {
      method: 'POST',
      data: { conversationId, msgId, emotionId },
      contentType: 'json',
      headers: { 'x-acs-dingtalk-access-token': accessToken },
      dataType: 'json',
      timeout: 5000,
    });

    if (result.status === 200) {
      self.debugLog(`attachReaction 成功: msgId=${msgId}, emotionId=${emotionId}`);
      return true;
    }
    self.debugLog(`attachReaction 返回非200: status=${result.status}, data=${JSON.stringify(result.data)}`);
    return false;
  } catch (err) {
    console.warn(`attachReaction 失败 (msgId=${msgId}):`, err);
    return false;
  }
}

/**
 * 撤回指定消息的表情 Reaction（处理完成确认）
 * POST /v1.0/contact/rpc/interaction/emoji/recall
 */
export async function recallReaction(
  self: DingClaude,
  conversationId: string,
  msgId: string,
  emotionId: string,
): Promise<boolean> {
  try {
    const accessToken = await self.dingStreamClient.getAccessToken();
    const url = `${DING_API_BASE}/v1.0/contact/rpc/interaction/emoji/recall`;

    const result = await urllib.request(url, {
      method: 'POST',
      data: { conversationId, msgId, emotionId },
      contentType: 'json',
      headers: { 'x-acs-dingtalk-access-token': accessToken },
      dataType: 'json',
      timeout: 5000,
    });

    if (result.status === 200) {
      self.debugLog(`recallReaction 成功: msgId=${msgId}, emotionId=${emotionId}`);
      return true;
    }
    self.debugLog(`recallReaction 返回非200: status=${result.status}, data=${JSON.stringify(result.data)}`);
    return false;
  } catch (err) {
    console.warn(`recallReaction 失败 (msgId=${msgId}):`, err);
    return false;
  }
}

// ==================== 群消息：图片/文件推送 ====================

/** 图片文件扩展名 */
const IMAGE_EXTENSIONS = new Set([ '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg' ]);

/**
 * 判断文件是否为图片类型（基于扩展名）
 */
export function isImageFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
}

/**
 * 上传文件到钉钉，获取 downloadCode/mediaId
 * POST /v1.0/robot/messageFiles/upload
 */
export async function uploadMediaToDingTalk(
  self: DingClaude,
  filePath: string,
): Promise<string | null> {
  try {
    const accessToken = await self.dingStreamClient.getAccessToken();

    const url = `${DING_API_BASE}/v1.0/robot/messageFiles/upload`;
    const result = await urllib.request(url, {
      method: 'POST',
      headers: {
        'x-acs-dingtalk-access-token': accessToken,
      },
      data: { file: fs.createReadStream(filePath) },
      contentType: 'multipart/form-data',
      dataType: 'json',
      timeout: 30000,
    });

    if (result.status !== 200 || !result.data) {
      console.error(`uploadMediaToDingTalk 返回非200: status=${result.status}`);
      return null;
    }

    const body = result.data as Record<string, unknown>;
    // 返回可能包含 downloadCode 或 mediaId
    return (body.downloadCode as string) || (body.mediaId as string) || null;
  } catch (err) {
    console.error(`uploadMediaToDingTalk 失败: ${filePath}`, err);
    return null;
  }
}

/**
 * 通过群消息 API 发送图片
 * POST /v1.0/im/groupMessages/send with sampleImageMsg
 */
export async function sendGroupImageMessage(
  self: DingClaude,
  conversationId: string,
  mediaId: string,
): Promise<boolean> {
  try {
    const accessToken = await self.dingStreamClient.getAccessToken();
    const url = `${DING_API_BASE}/v1.0/im/groupMessages/send`;

    const result = await urllib.request(url, {
      method: 'POST',
      data: {
        robotCode: self.clientId,
        openConversationId: conversationId,
        msgKey: 'sampleImageMsg',
        msgParam: JSON.stringify({ mediaId }),
      },
      contentType: 'json',
      headers: { 'x-acs-dingtalk-access-token': accessToken },
      dataType: 'json',
      timeout: 10000,
    });

    return result.status === 200;
  } catch (err) {
    console.error(`sendGroupImageMessage 失败: ${conversationId}`, err);
    return false;
  }
}

/**
 * 通过群消息 API 发送文件
 * POST /v1.0/im/groupMessages/send with sampleFileMsg
 */
export async function sendGroupFileMessage(
  self: DingClaude,
  conversationId: string,
  mediaId: string,
  fileName: string,
): Promise<boolean> {
  try {
    const accessToken = await self.dingStreamClient.getAccessToken();
    const url = `${DING_API_BASE}/v1.0/im/groupMessages/send`;

    const result = await urllib.request(url, {
      method: 'POST',
      data: {
        robotCode: self.clientId,
        openConversationId: conversationId,
        msgKey: 'sampleFileMsg',
        msgParam: JSON.stringify({ mediaId, fileName }),
      },
      contentType: 'json',
      headers: { 'x-acs-dingtalk-access-token': accessToken },
      dataType: 'json',
      timeout: 10000,
    });

    return result.status === 200;
  } catch (err) {
    console.error(`sendGroupFileMessage 失败: ${conversationId}`, err);
    return false;
  }
}
