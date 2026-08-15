import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getHomeDir } from './session';

export interface IUploadedFile {
  fileId: string;
  originalName: string;
  mimeType: string;
  size: number;
  filePath: string;
  url: string;
}

export function getFileUploadDir(clientId: string): string {
  const homeDir = getHomeDir();
  const dir = path.join(homeDir, '.cc-ding', clientId, '.files');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function generateFileId(): string {
  return `${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
}

export function saveUploadedFile(
  clientId: string,
  buffer: Buffer,
  originalName: string,
  mimeType: string,
): IUploadedFile {
  const fileId = generateFileId();
  const ext = path.extname(originalName);
  const fileName = `${fileId}${ext}`;
  const uploadDir = getFileUploadDir(clientId);
  const filePath = path.join(uploadDir, fileName);

  fs.writeFileSync(filePath, buffer);

  const stats = fs.statSync(filePath);

  return {
    fileId,
    originalName,
    mimeType,
    size: stats.size,
    filePath,
    url: `/api/clients/${clientId}/files/${fileId}/download`,
  };
}

export function getFilePath(clientId: string, fileId: string): string | null {
  const uploadDir = getFileUploadDir(clientId);
  if (!fs.existsSync(uploadDir)) return null;

  const files = fs.readdirSync(uploadDir);
  const file = files.find(f => f.startsWith(fileId));
  return file ? path.join(uploadDir, file) : null;
}

export function validateFileSize(size: number, maxSizeMB: number = 50): boolean {
  return size <= maxSizeMB * 1024 * 1024;
}

export function isImageMimeType(mimeType: string): boolean {
  return mimeType.startsWith('image/');
}
