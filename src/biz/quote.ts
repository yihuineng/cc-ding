import { IRawCallbackData, IQuoteInfo } from './types';

/**
 * 从钉钉回调原始数据中提取引用消息信息
 *
 * 钉钉引用消息的实际结构:
 * text.isReply = true
 * text.repliedMsg = { msgId, senderId, content: { text }, ... }
 */
export function extractQuoteInfo(rawData: IRawCallbackData): IQuoteInfo | null {
  const text = rawData.text;
  if (!text?.repliedMsg) {
    return null;
  }

  const repliedMsg = text.repliedMsg;
  let quoteText = '';
  const quoteMessageId = repliedMsg.msgId;
  const quoteSenderNick = repliedMsg.senderNick;

  // 从 repliedMsg.content.text 提取引用文本
  if (repliedMsg.content) {
    if (typeof repliedMsg.content.text === 'string') {
      quoteText = repliedMsg.content.text.trim();
    } else if (typeof (repliedMsg.content as unknown) === 'string') {
      quoteText = (repliedMsg.content as unknown as string).trim();
    }
  }

  if (!quoteText && !quoteMessageId) {
    return null;
  }

  return {
    quoteText,
    quoteMessageId,
    quoteSenderNick,
  };
}

/**
 * 将引用信息格式化注入到用户 prompt 中
 */
export function formatPromptWithQuote(userMessage: string, quoteInfo: IQuoteInfo): string {
  if (!quoteInfo.quoteText) {
    return userMessage;
  }

  const senderLabel = quoteInfo.quoteSenderNick ? ` (来自: ${quoteInfo.quoteSenderNick})` : '';
  return `── 引用消息${senderLabel} ──\n${quoteInfo.quoteText}\n── 引用结束 ──\n\n${userMessage}`;
}
