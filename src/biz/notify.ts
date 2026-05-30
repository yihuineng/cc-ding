import fs from 'fs';
import path from 'path';
import urllib from 'urllib';
import { IConfig } from './types';
import { getHomeDir } from './session';

export interface NotifyOpts {
  clientId: string;
  message: string;
  conversationIds: string[];
  atUserIds?: string[];
  markdown?: boolean;
}

export async function sendNotify(opts: NotifyOpts): Promise<{ success: number; fail: number }> {
  const { clientId, message, conversationIds, atUserIds = [], markdown = false } = opts;

  const clientDir = path.join(getHomeDir(), '.cc-ding', clientId);
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

  for (const convId of conversationIds) {
    const conv = config.conversations.find(c => c.conversationId === convId);
    const dingToken = conv?.dingToken || config.defaultDingToken;
    if (!dingToken) {
      console.error(`  ✗ 会话 ${convId}: 无 dingToken 可用`);
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
        const title = conv?.conversationTitle || convId;
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
