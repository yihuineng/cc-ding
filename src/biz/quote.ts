import { DingClaude } from './cc-ding-cli';
import { IRawCallbackData, IQuoteInfo, IChatRecordItem, IRichTextParagraph } from './types';
import { fetchQuotedMessage } from './messaging';
import { processPictureMessage, processRichTextMessage, downloadToFilesDir } from './image';

/**
 * 从 repliedMsg 中提取文本类引用内容
 */
function extractTextQuote(content: { text?: string; [key: string]: unknown } | undefined): string {
  if (!content) return '';
  if (typeof content.text === 'string') return content.text.trim();
  if (typeof (content as unknown) === 'string') return (content as unknown as string).trim();
  return '';
}

/**
 * 从 richText 段落中提取纯文本
 */
function extractRichTextQuote(content: { richText?: Array<{ type: string; text?: string }> } | undefined): string {
  if (!content?.richText || !Array.isArray(content.richText)) return '';
  const texts: string[] = [];
  for (const para of content.richText) {
    if (para.type === 'text' && para.text) {
      texts.push(para.text);
    } else if (para.type === 'picture') {
      texts.push('[图片]');
    }
  }
  return texts.join('\n').trim();
}

/**
 * 从聊天记录中提取对话摘要
 */
function extractChatRecordQuote(content: { chatRecords?: IChatRecordItem[] } | undefined): string {
  if (!content?.chatRecords || !Array.isArray(content.chatRecords)) return '';
  const records = content.chatRecords;
  if (records.length === 0) return '';

  const lines: string[] = [ `[聊天记录 - ${records.length}条]` ];
  for (const record of records) {
    const nick = (record.senderNick ?? record.senderName ?? '未知') as string;
    const text = (record.content ?? record.text ?? '') as string;
    const msgtype = (record.msgtype ?? record.msgType ?? 'text') as string;
    if (msgtype !== 'text' && !text) {
      lines.push(`${nick}: [${msgtype}消息]`);
    } else {
      lines.push(`${nick}: ${text}`);
    }
  }
  return lines.join('\n');
}

/**
 * 从卡片消息中提取内容
 */
function extractCardQuote(content: { title?: string; markdown?: string; text?: string; [key: string]: unknown } | undefined): string {
  if (!content) return '';
  const parts: string[] = [];
  if (typeof content.title === 'string') {
    parts.push(`[卡片: ${content.title}]`);
  }
  if (typeof content.markdown === 'string') {
    parts.push(content.markdown);
  } else if (typeof content.text === 'string') {
    parts.push(content.text);
  }
  return parts.join('\n').trim();
}

/**
 * 从钉钉回调原始数据中提取引用消息信息
 * 支持 text/picture/richText/chatRecord/file/video/audio/卡片等消息类型
 */
export function extractQuoteInfo(rawData: IRawCallbackData): IQuoteInfo | null {
  const text = rawData.text;
  if (!text?.repliedMsg) {
    return null;
  }

  const repliedMsg = text.repliedMsg;
  const quoteMessageId = repliedMsg.msgId;
  const quoteSenderNick = repliedMsg.senderNick;
  const quoteMsgType = repliedMsg.msgType || 'text';
  const content = repliedMsg.content;

  let quoteText = '';
  let quoteDownloadCode: string | undefined;
  let quoteFileName: string | undefined;
  let quoteRichText: IRichTextParagraph[] | undefined;

  switch (quoteMsgType) {
    case 'text':
      quoteText = extractTextQuote(content);
      break;

    case 'picture': {
      quoteDownloadCode = (content?.pictureDownloadCode as string) || (content?.downloadCode as string) || undefined;
      quoteText = '[图片消息]';
      break;
    }

    case 'richText': {
      const richTextContent = content as { richText?: IRichTextParagraph[] };
      quoteText = extractRichTextQuote(richTextContent);
      if (!quoteText) quoteText = '[富文本消息]';
      if (richTextContent?.richText) {
        quoteRichText = richTextContent.richText;
      }
      break;
    }

    case 'chatRecord':
      quoteText = extractChatRecordQuote(content as { chatRecords?: IChatRecordItem[] });
      if (!quoteText) quoteText = '[聊天记录]';
      break;

    case 'file':
      quoteFileName = content?.fileName as string | undefined;
      quoteDownloadCode = (content?.downloadCode as string) || undefined;
      quoteText = quoteFileName ? `[文件: ${quoteFileName}]` : '[文件消息]';
      break;

    case 'video':
      quoteText = '[视频消息]';
      quoteDownloadCode = (content?.downloadCode as string) || undefined;
      break;

    case 'audio':
      quoteText = '[语音消息]';
      quoteDownloadCode = (content?.downloadCode as string) || undefined;
      break;

    case 'actionCard':
    case 'interactiveCard':
      quoteText = extractCardQuote(content as { title?: string; markdown?: string; text?: string });
      if (!quoteText) quoteText = `[${quoteMsgType}消息]`;
      break;

    default: {
      // 通用兜底：尝试提取 text 字段
      quoteText = extractTextQuote(content);
      if (!quoteText) quoteText = `[${quoteMsgType}消息]`;
      break;
    }
  }

  if (!quoteText && !quoteMessageId) {
    return null;
  }

  return {
    quoteText,
    quoteMessageId,
    quoteSenderNick,
    quoteMsgType,
    quoteDownloadCode,
    quoteFileName,
    quoteRichText,
  };
}

/**
 * 异步增强引用信息
 * - picture 类型：下载图片到 .files/picture/ 并处理 OCR
 * - file/video/audio 类型：下载到 .files/{type}/
 * - 占位符文本 + 有 messageId 时：通过 API 获取原始文本
 */
export async function enrichQuoteInfo(
  self: DingClaude,
  quoteInfo: IQuoteInfo,
  rawData: IRawCallbackData,
  conversationDir: string,
  useLocalOcr: boolean,
): Promise<void> {
  const msgType = quoteInfo.quoteMsgType;
  const downloadCode = quoteInfo.quoteDownloadCode;

  // 图片消息：下载到 .files/picture/ 并处理 OCR
  if (msgType === 'picture' && downloadCode) {
    const result = await processPictureMessage(
      self, downloadCode, rawData.robotCode, conversationDir, useLocalOcr,
    );
    if (result) {
      quoteInfo.quoteText = result;
      return;
    }
  }

  // 富文本消息：下载内嵌图片并处理 OCR
  if (msgType === 'richText' && quoteInfo.quoteRichText) {
    const result = await processRichTextMessage(
      self, quoteInfo.quoteRichText, rawData.robotCode, conversationDir, useLocalOcr,
    );
    if (result && result !== '[富文本消息内容为空]') {
      quoteInfo.quoteText = result;
      return;
    }
  }

  // 文件/视频/音频消息：下载到 .files/{type}/
  if ((msgType === 'file' || msgType === 'video' || msgType === 'audio') && downloadCode) {
    const filePath = await downloadToFilesDir(
      self, downloadCode, rawData.robotCode, conversationDir,
      msgType, quoteInfo.quoteFileName,
    );
    if (filePath) {
      const label = quoteInfo.quoteFileName
        ? `[${msgType}: ${quoteInfo.quoteFileName}]`
        : `[${msgType}]`;
      quoteInfo.quoteText = `${label} ${filePath}`;
      return;
    }
  }

  // 占位符文本（以 [ 开头的占位标记）+ 有 messageId 时，尝试通过 API 兜底获取
  if (quoteInfo.quoteText.startsWith('[') && quoteInfo.quoteMessageId) {
    const fetched = await fetchQuotedMessage(self, quoteInfo.quoteMessageId);
    if (fetched) {
      quoteInfo.quoteText = fetched;
    }
  }
}

/**
 * 通用 downloadCode 提取：从 rawData 多种字段中提取下载码
 */
export function extractDownloadCode(rawData: IRawCallbackData): string | null {
  // 优先 downloadCode（API 标准）
  if (rawData.downloadCode) return rawData.downloadCode;
  // 独立图片消息的 pictureDownloadCode
  if (rawData.pictureDownloadCode) return rawData.pictureDownloadCode;
  // 文件消息的 fileDownloadCode
  if (rawData.fileDownloadCode) return rawData.fileDownloadCode;
  // 扩展字段
  const data = rawData as unknown as Record<string, unknown>;
  if (data.extensions && typeof data.extensions === 'object') {
    const ext = data.extensions as Record<string, unknown>;
    if (ext.downloadCode) return ext.downloadCode as string;
  }
  // content 字段中的下载码
  const contentKeys = [ 'image_content', 'file_content', 'video_content', 'audio_content' ];
  for (const key of contentKeys) {
    const c = data[key];
    if (c && typeof c === 'object') {
      const content = c as Record<string, unknown>;
      if (content.download_code) return content.download_code as string;
      if (content.downloadCode) return content.downloadCode as string;
    }
  }
  return null;
}

/**
 * 从 rawData 中提取文件名
 */
export function extractFileName(rawData: IRawCallbackData): string | null {
  if (rawData.fileName) return rawData.fileName;
  const data = rawData as unknown as Record<string, unknown>;
  // 从 content 字段中提取
  for (const key of [ 'content', 'file_content', 'image_content' ]) {
    const c = data[key];
    if (c && typeof c === 'object') {
      const content = c as Record<string, unknown>;
      if (content.fileName && typeof content.fileName === 'string') return content.fileName;
      if (content.file_name && typeof content.file_name === 'string') return content.file_name;
      if (content.name && typeof content.name === 'string') return content.name;
    }
  }
  // rawData 本身的 fileName
  if (typeof data.fileName === 'string') return data.fileName;
  return null;
}

/**
 * 通过魔数检测文件扩展名
 */
export function detectExtFromBuffer(buffer: Buffer): string {
  // PDF
  if (buffer.length >= 5 &&
    buffer[0] === 0x25 && buffer[1] === 0x50 &&
    buffer[2] === 0x44 && buffer[3] === 0x46 && buffer[4] === 0x2D) {
    return 'pdf';
  }
  // DOCX / PPTX / XLSX (ZIP-based)
  if (buffer.length >= 4 &&
    buffer[0] === 0x50 && buffer[1] === 0x4B &&
    buffer[2] === 0x03 && buffer[3] === 0x04) {
    return 'docx'; // 默认 docx，无法精确区分
  }
  // XLS (OLE2)
  if (buffer.length >= 8 &&
    buffer[0] === 0xD0 && buffer[1] === 0xCF &&
    buffer[2] === 0x11 && buffer[3] === 0xE0) {
    return 'xls';
  }
  // 降级为通用二进制
  return 'bin';
}

/**
 * 处理文件消息
 * 返回 prompt 字符串，失败返回 null
 */
export async function processFileMessage(
  self: DingClaude,
  rawData: IRawCallbackData,
  conversationDir: string,
): Promise<string | null> {
  const downloadCode = extractDownloadCode(rawData);
  if (!downloadCode) return null;

  const fileNameHint = extractFileName(rawData);
  const filePath = await downloadToFilesDir(
    self, downloadCode, rawData.robotCode, conversationDir,
    'file', fileNameHint || undefined,
  );
  if (!filePath) return null;

  const label = fileNameHint ? `文件: ${fileNameHint}` : '文件消息';
  return `${label}\n路径: ${filePath}`;
}

/**
 * 将引用信息格式化注入到用户 prompt 中
 */
export function formatPromptWithQuote(userMessage: string, quoteInfo: IQuoteInfo): string {
  if (!quoteInfo.quoteText) {
    return userMessage;
  }

  const labels: string[] = [];
  if (quoteInfo.quoteSenderNick) labels.push(`来自: ${quoteInfo.quoteSenderNick}`);
  if (quoteInfo.quoteMsgType && quoteInfo.quoteMsgType !== 'text') {
    const typeLabels: Record<string, string> = {
      picture: '图片', richText: '富文本', chatRecord: '聊天记录',
      file: '文件', video: '视频', audio: '语音',
      actionCard: '卡片', interactiveCard: '卡片',
    };
    labels.push(`类型: ${typeLabels[quoteInfo.quoteMsgType] || quoteInfo.quoteMsgType}`);
  }
  const labelStr = labels.length > 0 ? ` (${labels.join(', ')})` : '';
  return `── 引用消息${labelStr} ──\n${quoteInfo.quoteText}\n── 引用结束 ──\n\n${userMessage}`;
}
