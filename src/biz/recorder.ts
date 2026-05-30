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