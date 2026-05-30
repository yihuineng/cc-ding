import urllib from 'urllib';
import { DingClaude } from './cc-ding-cli';
import { IConfig, IRawCallbackData } from './types';
import { projUtil } from '../common';
import { DING_API_BASE, DING_OAPI_BASE } from './constants';
import { dateUtil, timestamp } from './session';
import { sendClaudeResponseToDing } from './messaging';

const DINGTALK_MARKDOWN_ESCAPE_CHARS = ['*', '_', '~', '`'];

export interface SendMessageOpts {
  conversationId: string;
  sessionWebhook: string;
  content: string;
  msgType?: 'text' | 'markdown';
  atUserId?: string;
  atAll?: boolean;
}

/**
 * 发送消息到钉钉群，支持@指定用户
 */
export async function sendDingMessage(self: DingClaude, opts: SendMessageOpts): Promise<void> {
  const { conversationId, sessionWebhook, content, msgType = 'markdown', atUserId, atAll } = opts;
  let text = content;
  let title = 'notification';
  // markdown 模式下处理 @
  if (msgType === 'markdown') {
    if (atUserId) {
      text = `@${atUserId} ${text}`;
    }
    if (atAll) {
      text = `@所有人 ${text}`;
    }
  }
  // 使用会话对应的 webhook 发送
  const webhook = sessionWebhook;
  try {
    const result = await urllib.request(webhook, {
      method: 'POST',
      data: {
        msgtype: msgType,
        markdown: msgType === 'markdown' ? { title, text } : undefined,
        text: msgType === 'text' ? { content: text } : undefined,
        at: atUserId ? { atUserIds: [atUserId] } : atAll ? { isAtAll: true } : undefined,
      },
      contentType: 'json',
    });
    if (result.status !== 200) {
      console.error(`sendDingMessage 失败: status=${result.status}, content=${content.substring(0, 50)}`);
    }
  } catch (err) {
    console.error('sendDingMessage 请求失败:', err);
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
  'NotebookEdit', 'mcp__plugin_github_github__', 'mcp__google_search__search',
];

/**
 * 从 Claude 响应中过滤掉工具调用标签，只返回实际内容
 */
export function filterToolCalls(response: string): string {
  if (!response) return response;
  // 移除工具调用标签（如 <Write>...</Write>）
  let filtered = response;
  for (const tag of TOOL_TAGS) {
    const regex = new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`, 'g');
    filtered = filtered.replace(regex, '');
  }
  // 清理多余的空行
  filtered = filtered.replace(/\n{3,}/g, '\n\n').trim();
  return filtered;
}

/**
 * 将 Claude 的响应发送到钉钉群
 */
export async function sendClaudeResponseToDing(
  self: DingClaude,
  conversationId: string,
  sessionWebhook: string,
  atUserId: string,
  response: string,
): Promise<void> {
  const filtered = filterToolCalls(response);
  if (!filtered) {
    console.log('Claude 响应过滤后为空，跳过发送');
    return;
  }
  // 拆分过长的消息，避免超过钉钉限制
  const maxLen = 18000;
  if (filtered.length <= maxLen) {
    await sendDingMessage(self, {
      conversationId, sessionWebhook, atUserId,
      content: filtered,
      msgType: 'markdown',
    });
  } else {
    // 拆分消息
    const chunks: string[] = [];
    let remaining = filtered;
    while (remaining.length > 0) {
      let chunk = remaining.substring(0, maxLen);
      // 尽量在换行处截断
      if (remaining.length > maxLen) {
        const lastNewline = chunk.lastIndexOf('\n');
        if (lastNewline > maxLen * 0.7) {
          chunk = chunk.substring(0, lastNewline);
        }
      }
      chunks.push(chunk);
      remaining = remaining.substring(chunk.length);
    }
    for (let i = 0; i < chunks.length; i++) {
      const suffix = `\n\n---\n*(${i + 1}/${chunks.length})*`;
      await sendDingMessage(self, {
        conversationId, sessionWebhook, atUserId,
        content: chunks[i] + suffix,
        msgType: 'markdown',
      });
    }
  }
}

/**
 * 通过钉钉机器人单聊 API 主动发消息给指定用户
 * POST /v1.0/robot/oToMessages/batchSend
 */
export async function sendMessageToUser(self: DingClaude, userId: string, content: string, msgType: 'text' | 'markdown' = 'text'): Promise<boolean> {
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