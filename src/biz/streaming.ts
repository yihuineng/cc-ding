import urllib from 'urllib';
import crypto from 'crypto';
import type { DingClaude } from './cc-ding-cli';
import { timestamp } from './session';

// ==================== 常量 ====================

/** 两次 API 调用最小间隔（ms） */
const THROTTLE_MS = 500;
/** 内容增量不足此字符数时延迟发送 */
const MIN_DELTA_CHARS = 30;
/**
 * 卡片最终内容上限（字符数）。
 * 钉钉 AI Card markdown 组件支持约 50K 字符，这里取 30000 作为安全上限。
 * 流式中间更新不截断；仅 finalize 时超过此值才截断并回退到普通消息补发。
 */
const MAX_CARD_CHARS = 30000;

const DING_API_BASE = 'https://api.dingtalk.com';

// ==================== 接口 ====================

export interface IStreamingCardOpts {
  self: DingClaude;
  cardTemplateId: string;
  cardTemplateKey?: string; // 默认 "content"
  conversationId: string;
  conversationType?: string;
  senderStaffId: string;
}

/**
 * 钉钉 AI Card 流式输出卡片
 *
 * 生命周期：create() → update() × N → finalize()
 * 任何一步失败 → 标记 failed，调用方回退到普通消息模式
 */
export class StreamingCard {
  private self: DingClaude;
  private outTrackId: string;
  private templateKey: string;
  private state: 'processing' | 'finished' | 'failed' = 'processing';
  private lastSentContent: string = '';
  private lastSentAt: number = 0;
  private pendingContent: string = '';
  private timer: NodeJS.Timeout | null = null;
  private inFlight: boolean = false;
  private _permissionDenied: boolean = false;
  private _missingScopes: string = '';
  private _contentTruncated: boolean = false;

  private constructor(opts: IStreamingCardOpts, outTrackId: string) {
    this.self = opts.self;
    this.outTrackId = outTrackId;
    this.templateKey = opts.cardTemplateKey || 'content';
  }

  /**
   * 创建并投递 AI Card
   * 返回 null 表示创建失败，调用方应使用普通消息模式
   */
  static async create(opts: IStreamingCardOpts): Promise<StreamingCard | null> {
    const outTrackId = `card_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const card = new StreamingCard(opts, outTrackId);

    const accessToken = await opts.self.dingStreamClient.getAccessToken();
    const isGroup = opts.conversationType !== '1';
    const openSpaceId = isGroup
      ? `dtv1.card//IM_GROUP.${opts.conversationId}`
      : `dtv1.card//IM_ROBOT.${opts.senderStaffId}`;

    const robotCode = opts.self.clientId;
    const body: Record<string, unknown> = {
      cardTemplateId: opts.cardTemplateId,
      outTrackId,
      cardData: {
        cardParamMap: {
          config: '{"autoLayout":true,"enableForward":true}',
          [card.templateKey]: '',
        },
      },
      callbackType: 'STREAM',
      openSpaceId,
      userIdType: 1,
      imGroupOpenSpaceModel: { supportForward: true },
      imRobotOpenSpaceModel: { supportForward: true },
    };
    if (isGroup) {
      body.imGroupOpenDeliverModel = { robotCode };
    } else {
      body.imRobotOpenDeliverModel = { spaceType: 'IM_ROBOT', robotCode };
    }

    try {
      const result = await urllib.request(`${DING_API_BASE}/v1.0/card/instances/createAndDeliver`, {
        method: 'POST',
        data: body,
        contentType: 'json',
        headers: { 'x-acs-dingtalk-access-token': accessToken },
        dataType: 'json',
        timeout: 10000,
      });

      if (result.status !== 200) {
        console.warn(`[${timestamp()}] StreamingCard 创建失败: status=${result.status}, body=${JSON.stringify(result.data)}`);
        return null;
      }

      const responseData = result.data as Record<string, unknown>;

      // 权限错误检测
      if (card.checkPermissionError(responseData)) {
        return null;
      }

      card.lastSentAt = Date.now();
      return card;
    } catch (err) {
      console.warn(`[${timestamp()}] StreamingCard 创建异常:`, err);
      return null;
    }
  }

  /**
   * 更新流式内容（节流发送）
   */
  async update(content: string): Promise<void> {
    if (this.state === 'failed' || this._permissionDenied) return;

    this.pendingContent = content;
    this.scheduleFlush(false);
  }

  /**
   * 最终化：发送完整内容并标记结束
   */
  async finalize(content: string): Promise<boolean> {
    if (this._permissionDenied) return false;

    // 即使之前 failed，也尝试发送一次最终内容
    this.pendingContent = content;

    // 取消延迟定时器，立即发送
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    return await this.flush(true);
  }

  get failed(): boolean {
    return this.state === 'failed';
  }

  get permissionDenied(): boolean {
    return this._permissionDenied;
  }

  get missingScopes(): string {
    return this._missingScopes;
  }

  /** finalize 时是否因超长而截断了内容 */
  get contentTruncated(): boolean {
    return this._contentTruncated;
  }

  // ==================== 内部方法 ====================

  private scheduleFlush(isFinalize: boolean): void {
    if (this.inFlight) return; // 已有请求在飞行中

    const now = Date.now();
    const elapsed = now - this.lastSentAt;

    // 节流：距上次发送不足 THROTTLE_MS，延迟发送
    if (elapsed < THROTTLE_MS) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flush(isFinalize).catch(() => { /* 忽略 */ });
      }, THROTTLE_MS - elapsed);
      return;
    }

    // 增量不足 MIN_DELTA_CHARS，延迟发送（最终化除外）
    const delta = this.pendingContent.length - this.lastSentContent.length;
    if (!isFinalize && delta < MIN_DELTA_CHARS && delta > 0) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flush(isFinalize).catch(() => { /* 忽略 */ });
      }, THROTTLE_MS);
      return;
    }

    this.flush(isFinalize).catch(() => { /* 忽略 */ });
  }

  private async flush(isFinalize: boolean): Promise<boolean> {
    if (this.inFlight) return false;
    this.inFlight = true;

    const content = this.pendingContent;
    this.pendingContent = '';

    // 截断策略：
    // - 流式中间更新：不截断，发送完整内容（钉钉渲染层能处理，isFull=true 每次全量替换）
    // - finalize 时：超过 MAX_CARD_CHARS 才截断，并标记 contentTruncated 让调用方回退到普通消息补发
    let sendContent = content;
    if (isFinalize && content.length > MAX_CARD_CHARS) {
      sendContent = content.substring(0, MAX_CARD_CHARS)
        + '\n\n---\n> ⚠️ 内容较长，卡片仅展示前 ' + MAX_CARD_CHARS + ' 字符，完整内容将以普通消息补发';
      this._contentTruncated = true;
    }

    const accessToken = await this.getAccessToken();
    if (!accessToken) {
      this.inFlight = false;
      this.state = 'failed';
      return false;
    }

    const body = {
      outTrackId: this.outTrackId,
      key: this.templateKey,
      content: sendContent,
      isFull: true,
      isFinalize,
      isError: false,
      guid: crypto.randomUUID(),
    };

    try {
      const result = await urllib.request(`${DING_API_BASE}/v1.0/card/streaming`, {
        method: 'PUT',
        data: body,
        contentType: 'json',
        headers: { 'x-acs-dingtalk-access-token': accessToken },
        dataType: 'json',
        timeout: 10000,
      });

      this.lastSentContent = content;
      this.lastSentAt = Date.now();

      if (result.status !== 200) {
        // 检查权限错误
        const responseData = result.data as Record<string, unknown>;
        if (this.checkPermissionError(responseData)) {
          this.state = 'failed';
          this.inFlight = false;
          return false;
        }
        this.state = 'failed';
        this.inFlight = false;
        return false;
      }

      // 检查响应体中的权限错误
      const responseData = result.data as Record<string, unknown>;
      if (this.checkPermissionError(responseData)) {
        this.state = 'failed';
        this.inFlight = false;
        return false;
      }

      if (isFinalize) {
        this.state = 'finished';
      }

      this.inFlight = false;
      return true;
    } catch (err) {
      console.warn(`[${timestamp()}] StreamingCard 更新异常:`, err);
      this.state = 'failed';
      this.inFlight = false;
      return false;
    }
  }

  /**
   * 检查 API 响应是否为权限错误
   * Forbidden.AccessDenied.AccessTokenPermissionDenied
   */
  private checkPermissionError(responseData: Record<string, unknown>): boolean {
    const errorMsg = (responseData.errorCode as string) || (responseData.errmsg as string) || '';
    if (errorMsg.includes('AccessTokenPermissionDenied') || errorMsg.includes('AccessDenied')) {
      this._permissionDenied = true;
      // 解析缺失的权限
      const detail = responseData.accessDeniedDetail as Record<string, unknown> | undefined;
      if (detail) {
        this._missingScopes = JSON.stringify(detail);
      }
      console.warn(`[${timestamp()}] StreamingCard 权限不足: ${errorMsg}`);
      return true;
    }
    return false;
  }

  private async getAccessToken(): Promise<string | null> {
    try {
      return await this.self.dingStreamClient.getAccessToken();
    } catch {
      return null;
    }
  }
}
