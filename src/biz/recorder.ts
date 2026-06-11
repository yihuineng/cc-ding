import fs from 'fs';
import path from 'path';
import { dateUtil } from 'utils-ok';
import type { DingClaude } from './cc-ding-cli';
import { IRawCallbackData, IRichTextParagraph } from './types';
import { getImageDownloadUrl, downloadImageBuffer, detectExtFromBuffer, extractDownloadCode } from './image';
import { getConversationDir, timestamp } from './session';

export function getRecorderDir(self: DingClaude, conversationId: string): string {
  if (self.config.recorderCfg?.dist) {
    return self.config.recorderCfg.dist;
  }
  return path.join(getConversationDir(self, conversationId), '.recorder');
}

function fileTimestamp(ts: number = Date.now()): string {
  return dateUtil.mm(ts).format('YYYY-MM-DD_HH-mm-ss-SSS');
}

function buildFrontmatter(msgType: string, senderNick: string, senderStaffId: string, time: number): string {
  return [
    '---',
    `msgType: ${msgType}`,
    `sender: ${senderNick} (${senderStaffId})`,
    `time: ${dateUtil.mm(time).format('YYYY-MM-DD HH:mm:ss')}`,
    '---',
    '',
  ].join('\n');
}

function saveRecordFile(recorderDir: string, msgType: string, content: string): string {
  const dir = path.join(recorderDir, msgType);
  fs.mkdirSync(dir, { recursive: true });
  const fileName = `${fileTimestamp()}.md`;
  const filePath = path.join(dir, fileName);
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

async function downloadAttachment(
  self: DingClaude,
  downloadCode: string,
  robotCode: string,
  recorderDir: string,
  ext: string = '',
): Promise<string | null> {
  try {
    const downloadUrl = await getImageDownloadUrl(self, downloadCode, robotCode);
    if (!downloadUrl) return null;

    const buffer = await downloadImageBuffer(downloadUrl);
    if (!buffer) return null;

    const attachDir = path.join(recorderDir, 'attachments');
    fs.mkdirSync(attachDir, { recursive: true });

    const suffix = ext ? `.${ext}` : detectExtFromBuffer(buffer);
    const fileName = `${fileTimestamp()}-${downloadCode.slice(-8)}${suffix}`;
    const filePath = path.join(attachDir, fileName);
    fs.writeFileSync(filePath, buffer);
    console.log(`[${timestamp()}] [recorder] 附件已保存: ${filePath} (${buffer.length} bytes)`);
    return filePath;
  } catch (err) {
    console.warn(`[${timestamp()}] [recorder] 附件下载失败:`, err);
    return null;
  }
}

function recordText(
  rawData: IRawCallbackData, recorderDir: string,
  senderNick: string, senderStaffId: string,
): string {
  const now = Date.now();
  const text = rawData.text?.content?.trim() ?? '';
  const content = buildFrontmatter('text', senderNick, senderStaffId, now) + text;
  return saveRecordFile(recorderDir, 'text', content);
}

async function recordPicture(
  self: DingClaude, rawData: IRawCallbackData, recorderDir: string,
  senderNick: string, senderStaffId: string,
): Promise<string> {
  const now = Date.now();
  const downloadCode = rawData.pictureDownloadCode || extractDownloadCode(rawData);
  const parts: string[] = [ buildFrontmatter('picture', senderNick, senderStaffId, now) ];

  if (downloadCode) {
    const attachPath = await downloadAttachment(self, downloadCode, rawData.robotCode, recorderDir);
    if (attachPath) {
      parts.push(`![image](${attachPath})`);
    } else {
      parts.push(`[图片下载失败] downloadCode: ${downloadCode}`);
    }
  } else {
    parts.push('[图片消息 - 无法获取下载码]');
    parts.push('', '```json', JSON.stringify(rawData, null, 2), '```');
  }

  return saveRecordFile(recorderDir, 'picture', parts.join('\n'));
}

async function recordFileMessage(
  self: DingClaude, rawData: IRawCallbackData, recorderDir: string,
  senderNick: string, senderStaffId: string, msgType: string,
): Promise<string> {
  const now = Date.now();
  const downloadCode = extractDownloadCode(rawData);
  const parts: string[] = [ buildFrontmatter(msgType, senderNick, senderStaffId, now) ];

  if (downloadCode) {
    const attachPath = await downloadAttachment(self, downloadCode, rawData.robotCode, recorderDir);
    if (attachPath) {
      parts.push(`[${msgType}] ${attachPath}`);
    } else {
      parts.push(`[${msgType}下载失败] downloadCode: ${downloadCode}`);
    }
  } else {
    parts.push(`[${msgType}消息 - 无法获取下载码，已保存原始数据]`);
    parts.push('', '```json', JSON.stringify(rawData, null, 2), '```');
  }

  return saveRecordFile(recorderDir, msgType, parts.join('\n'));
}

function recordChatRecord(
  rawData: IRawCallbackData, recorderDir: string,
  senderNick: string, senderStaffId: string,
): string {
  const now = Date.now();
  const parts: string[] = [ buildFrontmatter('chatRecord', senderNick, senderStaffId, now) ];

  const data = rawData as unknown as Record<string, unknown>;
  let records: Array<Record<string, unknown>> | null = null;

  if (data.chatRecords && Array.isArray(data.chatRecords)) {
    records = data.chatRecords as Array<Record<string, unknown>>;
  } else if (data.extensions && typeof data.extensions === 'object') {
    const ext = data.extensions as Record<string, unknown>;
    if (ext.chatRecords && Array.isArray(ext.chatRecords)) {
      records = ext.chatRecords as Array<Record<string, unknown>>;
    }
  }

  if (records && records.length > 0) {
    parts.push(`共 ${records.length} 条消息:\n`);
    for (const record of records) {
      const nick = (record.senderNick ?? record.senderName ?? '未知') as string;
      const content = (record.content ?? record.text ?? '') as string;
      const msgtype = (record.msgtype ?? record.msgType ?? 'text') as string;
      parts.push(`**${nick}** (${msgtype}):`);
      parts.push(content);
      parts.push('');
    }
  } else {
    parts.push('[聊天记录 - 已保存原始数据]');
    parts.push('', '```json', JSON.stringify(rawData, null, 2), '```');
  }

  return saveRecordFile(recorderDir, 'chatRecord', parts.join('\n'));
}

async function recordRichText(
  self: DingClaude, rawData: IRawCallbackData, recorderDir: string,
  senderNick: string, senderStaffId: string,
): Promise<string> {
  const now = Date.now();
  const parts: string[] = [ buildFrontmatter('richText', senderNick, senderStaffId, now) ];
  const paragraphs = rawData.content?.richText;

  if (paragraphs && Array.isArray(paragraphs)) {
    const typedParas = paragraphs as IRichTextParagraph[];

    const downloadResults = await Promise.all(
      typedParas.map(async (para) => {
        if (para.type !== 'picture') return null;
        const code = para.downloadCode || para.pictureDownloadCode;
        if (!code) return null;
        return downloadAttachment(self, code, rawData.robotCode, recorderDir);
      }),
    );

    for (let i = 0; i < typedParas.length; i++) {
      const para = typedParas[i];
      if (para.type === 'text' && para.text) {
        parts.push(para.text);
      } else if (para.type === 'picture') {
        const code = para.downloadCode || para.pictureDownloadCode;
        if (code) {
          const attachPath = downloadResults[i];
          if (attachPath) {
            parts.push(`![image](${attachPath})`);
          } else {
            parts.push('[内嵌图片下载失败]');
          }
        }
      } else if (para.type === 'mention' && para.userId) {
        parts.push(`@${para.userId}`);
      }
    }
  } else {
    parts.push('[富文本消息 - 已保存原始数据]');
    parts.push('', '```json', JSON.stringify(rawData, null, 2), '```');
  }

  return saveRecordFile(recorderDir, 'richText', parts.join('\n'));
}

function recordCard(
  rawData: IRawCallbackData, recorderDir: string,
  senderNick: string, senderStaffId: string, msgType: string,
): string {
  const now = Date.now();
  const parts: string[] = [ buildFrontmatter(msgType, senderNick, senderStaffId, now) ];
  const data = rawData as unknown as Record<string, unknown>;

  const cardData = (data.actionCard ?? data.interactiveCard ?? data.content ?? data) as Record<string, unknown>;

  if (typeof cardData.text === 'string') {
    parts.push(cardData.text);
  } else if (typeof cardData.title === 'string') {
    parts.push(`**${cardData.title}**`);
    if (typeof cardData.markdown === 'string') {
      parts.push(cardData.markdown);
    }
  }

  parts.push('', '---', '原始数据:', '```json', JSON.stringify(rawData, null, 2), '```');
  return saveRecordFile(recorderDir, msgType, parts.join('\n'));
}

function recordUnknown(
  rawData: IRawCallbackData, recorderDir: string,
  senderNick: string, senderStaffId: string, msgType: string,
): string {
  const now = Date.now();
  const parts: string[] = [ buildFrontmatter(msgType, senderNick, senderStaffId, now) ];
  parts.push(`[未知消息类型: ${msgType}]`);
  parts.push('', '```json', JSON.stringify(rawData, null, 2), '```');
  return saveRecordFile(recorderDir, 'unknown', parts.join('\n'));
}

export async function recordMessage(
  self: DingClaude,
  rawData: IRawCallbackData,
  conversationId: string,
): Promise<string> {
  const recorderDir = getRecorderDir(self, conversationId);
  const msgType = rawData.msgtype || 'unknown';
  const senderNick = rawData.senderNick ?? '未知';
  const senderStaffId = rawData.senderStaffId ?? '';

  console.log(`[${timestamp()}] [recorder] 记录消息: type=${msgType}, sender=${senderNick}(${senderStaffId})`);

  switch (msgType) {
    case 'text':
      return recordText(rawData, recorderDir, senderNick, senderStaffId);
    case 'picture':
      return recordPicture(self, rawData, recorderDir, senderNick, senderStaffId);
    case 'file':
    case 'video':
    case 'audio':
      return recordFileMessage(self, rawData, recorderDir, senderNick, senderStaffId, msgType);
    case 'chatRecord':
      return recordChatRecord(rawData, recorderDir, senderNick, senderStaffId);
    case 'richText':
      return recordRichText(self, rawData, recorderDir, senderNick, senderStaffId);
    case 'actionCard':
    case 'interactiveCard':
      return recordCard(rawData, recorderDir, senderNick, senderStaffId, msgType);
    default:
      return recordUnknown(rawData, recorderDir, senderNick, senderStaffId, msgType);
  }
}
