import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import urllib from 'urllib';
import { DingClaude } from './cc-ding-cli';
import { IDownloadedImage, ImageMediaType, IRichTextParagraph } from './types';
import { timestamp } from './session';
import { projUtil } from '../common';

const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB

/** 钉钉开放平台 API 基地址（与 messaging.ts 共用，如需修改请同步） */
const DING_API_BASE = 'https://api.dingtalk.com';

/** OCR 识别结果说明（仅出现一次） */
const OCR_PREAMBLE = '以下图片 OCR 识别结果来自对用户消息中图片的预处理(非用户原始输入)，如识别不准确可直接查看原图路径';

// OCR 二进制路径（项目根目录下的 resource/）
const OCR_BIN_DIR = projUtil().getResourcePath();

/** 缓存 OCR 二进制路径（启动后不变） */
const cachedOcrBinPath: string | null = (() => {
  if (process.platform === 'win32') return null;
  const arch = process.arch;
  if (arch === 'arm64') return path.join(OCR_BIN_DIR, 'ocr-arm64');
  if (arch === 'x64') return path.join(OCR_BIN_DIR, 'ocr-x64');
  // 其他架构不支持本地 OCR
  return null;
})();

/** 缓存 OCR 二进制是否存在的检查结果 */
let ocrBinExists: boolean | null = null;

/**
 * 执行 OCR 识别，返回识别到的文本内容
 */
export async function runOcr(imagePath: string): Promise<string | null> {
  if (!cachedOcrBinPath) {
    console.log(`[${timestamp()}] 当前平台(${process.platform}/${process.arch})不支持本地OCR，使用模型识别`);
    return null;
  }
  // 缓存二进制存在性检查结果（启动后不会变化）
  if (ocrBinExists === null) {
    ocrBinExists = fs.existsSync(cachedOcrBinPath);
    if (!ocrBinExists) {
      console.warn(`[${timestamp()}] OCR 二进制不存在: ${cachedOcrBinPath}`);
    }
  }
  if (!ocrBinExists) return null;

  return new Promise((resolve) => {
    execFile(cachedOcrBinPath!, [ imagePath ], { timeout: 30_000, maxBuffer: 5 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        console.warn(`[${timestamp()}] OCR 执行失败: ${err.message}`);
        if (stderr) console.warn(`[${timestamp()}] OCR stderr: ${stderr.substring(0, 200)}`);
        resolve(null);
        return;
      }

      try {
        const results = JSON.parse(stdout) as Array<{ word: string; confidence: number }>;
        if (!Array.isArray(results) || results.length === 0) {
          console.log(`[${timestamp()}] OCR 无识别结果`);
          resolve(null);
          return;
        }
        const text = results.map(r => r.word).filter(Boolean).join(' ');
        console.log(`[${timestamp()}] OCR 识别结果: ${text.substring(0, 200)}${text.length > 200 ? '...' : ''}`);
        resolve(text || null);
      } catch {
        console.warn(`[${timestamp()}] OCR 输出解析失败: ${stdout.substring(0, 200)}`);
        resolve(null);
      }
    });
  });
}

/** 魔数 → MIME 类型映射 */
const MAGIC_NUMBERS: Array<{ bytes: number[]; mediaType: ImageMediaType; ext: string }> = [
  { bytes: [ 0x89, 0x50, 0x4E, 0x47 ], mediaType: 'image/png', ext: 'png' },
  { bytes: [ 0xFF, 0xD8, 0xFF ], mediaType: 'image/jpeg', ext: 'jpg' },
  { bytes: [ 0x47, 0x49, 0x46 ], mediaType: 'image/gif', ext: 'gif' },
  { bytes: [ 0x52, 0x49, 0x46, 0x46 ], mediaType: 'image/webp', ext: 'webp' }, // RIFF header (WebP container)
];

/**
 * 通过魔数检测图片 MIME 类型
 */
function detectImageMediaType(buffer: Buffer): { mediaType: ImageMediaType; ext: string } {
  for (const { bytes, mediaType, ext } of MAGIC_NUMBERS) {
    if (buffer.length >= bytes.length && bytes.every((b, i) => buffer[i] === b)) {
      return { mediaType, ext };
    }
  }
  // 默认当作 jpeg
  return { mediaType: 'image/jpeg', ext: 'jpg' };
}

/**
 * 调用钉钉 API 获取图片临时下载 URL
 * POST /v1.0/robot/messageFiles/download
 */
export async function getImageDownloadUrl(
  self: DingClaude,
  downloadCode: string,
  robotCode: string,
): Promise<string | null> {
  try {
    const accessToken = await self.dingStreamClient.getAccessToken();
    const url = `${DING_API_BASE}/v1.0/robot/messageFiles/download`;

    const result = await urllib.request(url, {
      method: 'POST',
      headers: {
        'x-acs-dingtalk-access-token': accessToken,
        'Content-Type': 'application/json',
      },
      data: { downloadCode, robotCode },
      dataType: 'json',
      timeout: 10000,
    });

    if (result.status !== 200 || !result.data) {
      self.debugLog(`getImageDownloadUrl API 返回非200: status=${result.status}, data=${JSON.stringify(result.data)}`);
      return null;
    }

    const body = result.data as Record<string, unknown>;
    const downloadUrl = body?.downloadUrl as string | undefined;
    if (!downloadUrl) {
      self.debugLog(`getImageDownloadUrl 响应无 downloadUrl: ${JSON.stringify(body)}`);
      return null;
    }
    return downloadUrl;
  } catch (err) {
    console.warn(`[${timestamp()}] getImageDownloadUrl 请求失败:`, err);
    return null;
  }
}

/**
 * 下载图片 Buffer
 */
export async function downloadImageBuffer(downloadUrl: string): Promise<Buffer | null> {
  try {
    const result = await urllib.request(downloadUrl, {
      method: 'GET',
      dataType: 'buffer',
      timeout: 30000,
    });

    if (result.status !== 200) {
      console.warn(`[${timestamp()}] downloadImageBuffer 下载失败: status=${result.status}`);
      return null;
    }

    const buffer = result.data as Buffer;
    if (!buffer || buffer.length === 0) {
      console.warn(`[${timestamp()}] downloadImageBuffer 下载结果为空`);
      return null;
    }

    if (buffer.length > MAX_IMAGE_SIZE) {
      console.warn(`[${timestamp()}] 图片大小 ${buffer.length} 超过限制 ${MAX_IMAGE_SIZE}`);
      return null;
    }

    return buffer;
  } catch (err) {
    console.warn(`[${timestamp()}] downloadImageBuffer 下载失败:`, err);
    return null;
  }
}

/**
 * 完整管线：获取 URL → 下载 → 检测类型 → 保存到本地
 * 返回 IDownloadedImage 或 null（失败时）
 */
async function downloadAndProcessImage(
  self: DingClaude,
  downloadCode: string,
  robotCode: string,
  saveDir: string,
): Promise<IDownloadedImage | null> {
  // 1. 获取临时下载 URL
  const downloadUrl = await getImageDownloadUrl(self, downloadCode, robotCode);
  if (!downloadUrl) return null;

  // 2. 下载图片
  const buffer = await downloadImageBuffer(downloadUrl);
  if (!buffer) return null;

  // 3. 检测类型
  const { mediaType, ext } = detectImageMediaType(buffer);

  // 4. 保存到本地
  const imagesDir = path.join(saveDir, '.images');
  const codeSuffix = downloadCode.slice(-8);
  const fileName = `${Date.now()}-${codeSuffix}.${ext}`;
  const filePath = path.join(imagesDir, fileName);

  try {
    fs.mkdirSync(imagesDir, { recursive: true });
    fs.writeFileSync(filePath, buffer);
  } catch (err) {
    console.warn(`[${timestamp()}] 图片保存失败: ${filePath}`, err);
    return null;
  }

  console.log(`[${timestamp()}] 图片已保存: ${filePath} (${mediaType}, ${buffer.length} bytes)`);

  return {
    mediaType,
    filePath,
    sizeBytes: buffer.length,
  };
}

/**
 * 根据图片信息构建 prompt 中的图片描述
 * useLocalOcr=true 时同时返回原图路径和 OCR 结果，Claude 可自行判断是否直接看图
 */
async function buildImagePrompt(image: IDownloadedImage, useLocalOcr: boolean, imageIndex?: number): Promise<string> {
  const label = imageIndex != null ? `[图片 ${imageIndex}]` : '[图片]';
  if (useLocalOcr) {
    const ocrText = await runOcr(image.filePath);
    if (ocrText) {
      const ocrLabel = imageIndex != null ? `[图片 ${imageIndex} OCR]` : '[图片 OCR]';
      return `${label} ${image.filePath}\n${ocrLabel}\n---\n${ocrText}\n---`;
    }
    console.warn(`[${timestamp()}] OCR 失败，仅传原图路径: ${image.filePath}`);
  }
  return `${label} ${image.filePath}`;
}

/**
 * 处理 picture 消息，下载图片并返回拼接到 prompt 中的内容
 * useLocalOcr 时使用 OCR 识别文本，否则返回图片文件路径
 * 返回 prompt 字符串，失败返回 null
 */
export async function processPictureMessage(
  self: DingClaude,
  downloadCode: string,
  robotCode: string,
  conversationDir: string,
  useLocalOcr: boolean = true,
  userText?: string,
): Promise<string | null> {
  const image = await downloadAndProcessImage(self, downloadCode, robotCode, conversationDir);
  if (!image) return null;

  const imagePrompt = await buildImagePrompt(image, useLocalOcr);

  const parts: string[] = [];
  if (useLocalOcr) {
    parts.push(OCR_PREAMBLE);
  }
  if (userText) parts.push(userText);
  parts.push(imagePrompt);
  return parts.join('\n');
}

/**
 * 处理 richText 消息，提取文本段落并下载内嵌图片
 * useLocalOcr 时使用 OCR 识别文本，否则返回图片文件路径
 * 返回 prompt 字符串，失败时返回降级文本
 */
export async function processRichTextMessage(
  self: DingClaude,
  paragraphs: IRichTextParagraph[],
  robotCode: string,
  conversationDir: string,
  useLocalOcr: boolean = true,
): Promise<string> {
  // 预计算图片总数（用于决定是否编号）
  const totalImages = paragraphs.filter(p => p.type === 'picture' && (p.downloadCode || p.pictureDownloadCode)).length;

  // 并行下载所有图片
  const imagePromises = paragraphs.map(async (para, index): Promise<{ index: number; result: IDownloadedImage | null }> => {
    if (para.type === 'picture') {
      const code = para.downloadCode || para.pictureDownloadCode;
      if (code) {
        const image = await downloadAndProcessImage(self, code, robotCode, conversationDir);
        return { index, result: image };
      }
    }
    return { index, result: null };
  });
  const imageResults = await Promise.all(imagePromises);
  const imageMap = new Map<number, IDownloadedImage | null>();
  for (const { index, result } of imageResults) {
    imageMap.set(index, result);
  }

  // 如果启用了 OCR，并行执行所有图片的 OCR 识别
  type OcrResult = { index: number; ocrText: string | null };
  const ocrMap = new Map<number, string | null>();
  if (useLocalOcr && totalImages > 0) {
    const ocrPromises: Promise<OcrResult>[] = [];
    for (const [ idx, image ] of imageMap) {
      if (image) {
        ocrPromises.push(runOcr(image.filePath).then(ocrText => ({ index: idx, ocrText })));
      }
    }
    const ocrResults = await Promise.all(ocrPromises);
    for (const { index, ocrText } of ocrResults) {
      ocrMap.set(index, ocrText);
    }
  }

  // 构建文本 + 图片 prompt
  const parts: string[] = [];
  let imageCount = 0;

  for (let i = 0; i < paragraphs.length; i++) {
    const para = paragraphs[i];
    if (para.type === 'text' && para.text) {
      // 过滤纯 @提及段落（如 @机器人名），对 Claude 无意义
      if (/^@\S+$/.test(para.text.trim())) continue;
      parts.push(para.text);
    } else if (para.type === 'mention' && para.userId) {
      parts.push(`@${para.userId}`);
    } else if (para.type === 'picture') {
      const image = imageMap.get(i);
      if (image) {
        imageCount++;
        const idx = totalImages > 1 ? imageCount : undefined;
        // 使用预计算的 OCR 结果构建 prompt（无需再次 await）
        const ocrText = useLocalOcr ? ocrMap.get(i) : null;
        const label = idx != null ? `[图片 ${idx}]` : '[图片]';
        if (ocrText) {
          const ocrLabel = idx != null ? `[图片 ${idx} OCR]` : '[图片 OCR]';
          parts.push(`${label} ${image.filePath}\n${ocrLabel}\n---\n${ocrText}\n---`);
        } else {
          parts.push(`${label} ${image.filePath}`);
        }
      } else {
        const code = para.downloadCode || para.pictureDownloadCode;
        if (code) {
          parts.push('[��片下载失败]');
        }
      }
    }
  }

  const result = parts.join('\n') || '[富文本消息内容为空]';

  // OCR 开启且有图片时，在开头加一次说明
  if (useLocalOcr && imageCount > 0) {
    return `${OCR_PREAMBLE}\n${result}`;
  }
  return result;
}
