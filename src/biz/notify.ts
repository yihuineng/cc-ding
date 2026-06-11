import fs from 'fs';
import path from 'path';
import os from 'os';
import urllib from 'urllib';
import { IConfig } from './types';
import { resolveSecret } from './secrets';

export interface NotifyOpts {
  clientId: string;
  message: string;
  conversationIds: string[];
  atUserIds?: string[];
  /** 单聊目标手机号（多个用逗号分隔，与 conversations 一一对应） */
  mobiles?: string[];
  markdown?: boolean;
}

const DING_API_BASE = 'https://api.dingtalk.com';
const DING_OAPI_BASE = 'https://oapi.dingtalk.com';

/** 获取客户端目录 */
function getClientDir(clientId: string): string {
  return path.join(os.homedir(), '.cc-ding', clientId);
}

/** 获取 phone-map.json 路径 */
function getPhoneMapFile(clientId: string): string {
  return path.join(getClientDir(clientId), 'phone-map.json');
}

/** 加载 phone-map.json 缓存 */
function loadPhoneMap(clientId: string): Record<string, string> {
  const file = getPhoneMapFile(clientId);
  if (!fs.existsSync(file)) return {};
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (typeof data === 'object' && data !== null) return data as Record<string, string>;
  } catch { /* ignore */ }
  return {};
}

/** 保存 phone-map.json 缓存 */
function savePhoneMap(clientId: string, map: Record<string, string>): void {
  const file = getPhoneMapFile(clientId);
  try {
    fs.writeFileSync(file, JSON.stringify(map, null, 2), 'utf-8');
  } catch { /* ignore */ }
}

/**
 * 获取钉钉 access token
 * POST https://api.dingtalk.com/v1.0/oauth2/accessToken
 */
async function getAccessToken(clientId: string, clientSecret: string): Promise<string> {
  const result = await urllib.request(`${DING_API_BASE}/v1.0/oauth2/accessToken`, {
    method: 'POST',
    data: { appKey: clientId, appSecret: clientSecret },
    contentType: 'json',
    dataType: 'json',
    timeout: 10000,
  });

  if (result.status !== 200 || !result.data?.accessToken) {
    throw new Error(`获取 accessToken 失败: ${JSON.stringify(result.data)}`);
  }
  return result.data.accessToken as string;
}

/**
 * 通过手机号查询钉钉 userId
 * POST /topapi/v2/user/getbymobile
 */
async function getUserIdByMobile(accessToken: string, mobile: string): Promise<string | null> {
  const result = await urllib.request(`${DING_OAPI_BASE}/topapi/v2/user/getbymobile?access_token=${accessToken}`, {
    method: 'POST',
    data: { mobile },
    contentType: 'json',
    dataType: 'json',
    timeout: 5000,
  });

  if (result.status !== 200 || !result.data) return null;
  const body = result.data as Record<string, unknown>;
  if (body.errcode !== 0) return null;
  const resultObj = body.result as Record<string, unknown> | undefined;
  return (resultObj?.userid as string) || null;
}

/**
 * 通过钉钉 oToMessages API 发送单聊消息
 * POST /v1.0/robot/oToMessages/batchSend
 */
async function sendToUser(
  accessToken: string,
  robotCode: string,
  userId: string,
  content: string,
  markdown: boolean,
): Promise<boolean> {
  const msgKey = markdown ? 'sampleMarkdown' : 'sampleText';
  const msgParam = markdown
    ? JSON.stringify({ title: 'notification', text: content })
    : JSON.stringify({ content });

  const result = await urllib.request(`${DING_API_BASE}/v1.0/robot/oToMessages/batchSend`, {
    method: 'POST',
    data: { robotCode, userIds: [ userId ], msgKey, msgParam },
    contentType: 'json',
    headers: { 'x-acs-dingtalk-access-token': accessToken },
    dataType: 'json',
  });

  return result.status === 200;
}

export async function sendNotify(opts: NotifyOpts): Promise<{ success: number; fail: number }> {
  const { clientId, message, conversationIds, atUserIds = [], mobiles = [], markdown = false } = opts;

  const clientDir = getClientDir(clientId);
  const cfgFile = path.join(clientDir, 'config.json');
  if (!fs.existsSync(cfgFile)) {
    console.error(`❌ 配置文件不存在: ${cfgFile}`);
    return { success: 0, fail: conversationIds.length };
  }

  let config: IConfig;
  try {
    config = JSON.parse(fs.readFileSync(cfgFile, 'utf-8'));
  } catch (err) {
    console.error(`❌ 配置文件解析失败: ${err instanceof Error ? err.message : err}`);
    return { success: 0, fail: conversationIds.length };
  }

  let success = 0;
  let fail = 0;

  // 缓存 accessToken 和 phone-map（单聊用，首次使用时获取）
  let cachedToken: string | null = null;
  const mobileCache = loadPhoneMap(clientId);

  for (const convId of conversationIds) {
    const conv = config.conversations.find(c => c.conversationId === convId);
    const title = conv?.conversationTitle || convId;

    // 单聊：使用 oToMessages/batchSend API
    if (conv?.conversationType === '1') {
      // 优先级：CLI 传入的 mobile > config 中的 mobile
      const mobile = mobiles[conversationIds.indexOf(convId)] || conv.mobile;
      if (!mobile) {
        console.error(`  ✗ ${title}: 单聊缺少手机号（请配置 conversations[].mobile 或传 --mobile）`);
        fail++;
        continue;
      }

      try {
        if (!cachedToken) {
          cachedToken = await getAccessToken(clientId, resolveSecret(config.clientSecret));
        }

        // 解析 userId（缓存优先）
        let userId = mobileCache[mobile];
        if (!userId) {
          userId = await getUserIdByMobile(cachedToken, mobile);
          if (userId) {
            mobileCache[mobile] = userId;
            savePhoneMap(clientId, mobileCache);
          }
        }
        if (!userId) {
          console.error(`  ✗ ${title}: 无法解析手机号 ${mobile} 为 userId`);
          fail++;
          continue;
        }

        const ok = await sendToUser(cachedToken, clientId, userId, message, markdown);
        if (ok) {
          console.log(`  ✓ ${title}`);
          success++;
        } else {
          console.error(`  ✗ ${title}: API 返回失败`);
          fail++;
        }
      } catch (err) {
        console.error(`  ✗ ${title}: ${err instanceof Error ? err.message : err}`);
        fail++;
      }
      continue;
    }

    // 群聊：使用 webhook API
    const dingToken = resolveSecret(conv?.dingToken || config.defaultDingToken);
    if (!dingToken) {
      console.error(`  ✗ ${title}: 无 dingToken 可用`);
      fail++;
      continue;
    }
    try {
      const displayMsg = atUserIds.length > 0
        ? `${message} ${atUserIds.map(id => `@${id}`).join(' ')}`
        : message;

      const body = markdown
        ? {
          msgtype: 'markdown',
          markdown: { title: displayMsg, text: displayMsg },
          at: { atUserIds, isAtAll: false },
        }
        : {
          msgtype: 'text',
          text: { content: displayMsg },
          at: { atUserIds, isAtAll: false },
        };

      const url = `https://oapi.dingtalk.com/robot/send?access_token=${dingToken}`;
      const result = await urllib.request(url, {
        method: 'POST',
        data: body,
        contentType: 'json',
        dataType: 'json',
      });

      if (result.status === 200) {
        console.log(`  ✓ ${title}`);
        success++;
      } else {
        console.error(`  ✗ ${convId}: HTTP ${result.status}`);
        fail++;
      }
    } catch (err) {
      console.error(`  ✗ ${convId}: ${err instanceof Error ? err.message : err}`);
      fail++;
    }
  }

  return { success, fail };
}
