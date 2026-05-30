import fs from 'fs';
import path from 'path';
import { dateUtil } from 'utils-ok';
import { DingClaude } from './cc-ding-cli';
import { IRawCallbackData, IRichTextParagraph } from './types';
import { getImageDownloadUrl, downloadImageBuffer } from './image';
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
    const buffer = await downloadImageBuffer(self, downloadCode, robotCode);
    const fileName = `${fileTimestamp()}${ext || '.png'}`;
    const filePath = path.join(recorderDir, 'attachments', fileName);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, buffer);
    return filePath;
  } catch (err) {
    console.error('下载附件失败:', err);
    return null;
  }
}

export async function recordMessage(
  self: DingClaude,
  data: IRawCallbackData,
  conversationId: string,
): Promise<void> {
  const recorderDir = getRecorderDir(self, conversationId);
  const { senderNick, senderStaffId, conversationType, richTextList } = data;
  const msgType = conversationType === '1' ? 'single' : 'group';

  try {
    // 处理富文本段落
    if (richTextList && richTextList.length > 0) {
      for (const para of richTextList) {
        if (para.type === 'text' && para.text) {
          const content = buildFrontmatter('text', senderNick, senderStaffId, Date.now()) + para.text;
          saveRecordFile(recorderDir, msgType, content);
        } else if (para.type === 'image' && para.downloadCode) {
          const filePath = await downloadAttachment(self, para.downloadCode, self.clientId, recorderDir, '.png');
          if (filePath) {
            const content = buildFrontmatter('image', senderNick, senderStaffId, Date.now()) + `![image](${filePath})`;
            saveRecordFile(recorderDir, msgType, content);
          }
        } else if (para.type === 'file' && para.downloadCode) {
          const ext = para.fileName ? path.extname(para.fileName) : '';
          const filePath = await downloadAttachment(self, para.downloadCode, self.clientId, recorderDir, ext);
          if (filePath) {
            const content = buildFrontmatter('file', senderNick, senderStaffId, Date.now()) + `[file](${filePath})`;
            saveRecordFile(recorderDir, msgType, content);
          }
        }
      }
    } else if (data.text?.content) {
      // 兼容旧版 text 字段
      const content = buildFrontmatter('text', senderNick, senderStaffId, Date.now()) + data.text.content;
      saveRecordFile(recorderDir, msgType, content);
    }
  } catch (err) {
    console.error('记录消息失败:', err);
  }
}

/**
 * 将消息记录到 recorder 目录，按会话和日期分目录
 * 每天一个目录，消息按时间戳文件存储
 */
export async function recordMessageByDate(
  self: DingClaude,
  data: IRawCallbackData,
  conversationId: string,
): Promise<void> {
  const baseDir = getRecorderDir(self, conversationId);
  const dateStr = dateUtil.mm().format('YYYY-MM-DD');
  const dayDir = path.join(baseDir, dateStr);
  fs.mkdirSync(dayDir, { recursive: true });

  const { senderNick, senderStaffId, richTextList } = data;
  const msgType = data.conversationType === '1' ? 'single' : 'group';
  const subDir = path.join(dayDir, msgType);
  fs.mkdirSync(subDir, { recursive: true });

  try {
    if (richTextList && richTextList.length > 0) {
      for (const para of richTextList) {
        if (para.type === 'text' && para.text) {
          const content = buildFrontmatter('text', senderNick, senderStaffId, Date.now()) + para.text;
          saveRecordFile(dayDir, msgType, content);
        } else if (para.type === 'image' && para.downloadCode) {
          const filePath = await downloadAttachment(self, para.downloadCode, self.clientId, dayDir, '.png');
          if (filePath) {
            const content = buildFrontmatter('image', senderNick, senderStaffId, Date.now()) + `![image](${filePath})`;
            saveRecordFile(dayDir, msgType, content);
          }
        } else if (para.type === 'file' && para.downloadCode) {
          const ext = para.fileName ? path.extname(para.fileName) : '';
          const filePath = await downloadAttachment(self, para.downloadCode, self.clientId, dayDir, ext);
          if (filePath) {
            const content = buildFrontmatter('file', senderNick, senderStaffId, Date.now()) + `[file](${filePath})`;
            saveRecordFile(dayDir, msgType, content);
          }
        }
      }
    } else if (data.text?.content) {
      const content = buildFrontmatter('text', senderNick, senderStaffId, Date.now()) + data.text.content;
      saveRecordFile(dayDir, msgType, content);
    }
  } catch (err) {
    console.error('记录消息失败:', err);
  }
}

/**
 * 记录 assistant 回复到 recorder 目录
 */
export function recordAssistantReply(
  self: DingClaude,
  conversationId: string,
  reply: string,
): void {
  const recorderDir = getRecorderDir(self, conversationId);
  const msgType = 'assistant';
  const content = buildFrontmatter('assistant_reply', 'Claude', 'assistant', Date.now()) + reply;
  saveRecordFile(recorderDir, msgType, content);
}

/**
 * 将 recorder 目录下的消息合并为单个 Markdown 文件
 */
export function mergeRecorderFiles(recorderDir: string): string {
  const output: string[] = [];
  const msgTypes = ['single', 'group', 'assistant'];

  for (const msgType of msgTypes) {
    const typeDir = path.join(recorderDir, msgType);
    if (!fs.existsSync(typeDir)) continue;

    const files = fs.readdirSync(typeDir).filter(f => f.endsWith('.md')).sort();
    if (files.length === 0) continue;

    output.push(`## ${msgType}\n`);
    for (const file of files) {
      const filePath = path.join(typeDir, file);
      const content = fs.readFileSync(filePath, 'utf-8');
      output.push(content);
      output.push('\n---\n');
    }
  }

  return output.join('\n');
}