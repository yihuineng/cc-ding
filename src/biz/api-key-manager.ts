import fs from 'fs';
import path from 'path';
import type { DingClaude } from './cc-ding-cli';
import { IClaudeSetting } from './types';
import { timestamp, getHomeDir, getGlobalConfig } from './session';
import { dateUtil } from 'utils-ok';
import { resolveSecret, isEnvRef } from './secrets';
import { commandExists, isWindows } from './platform';

// ==================== API Key Cooldown 机制 ====================

/** Key 标识：baseUrl + apiKey 前6位 */
type KeyId = string;

/** Cooldown 状态：{ expiresAt: 冷却到期时间戳 } */
interface CooldownState {
  expiresAt: number;
  reason: string;
}

/** 内存中的 Cooldown 映射：KeyId -> CooldownState */
const keyCooldowns = new Map<KeyId, CooldownState>();

/** 默认冷却时长（秒） */
const DEFAULT_COOLDOWN_SECS = 600;

/**
 * 生成 Key 的唯一标识
 */
function makeKeyId(baseUrl: string, apiKey: string): KeyId {
  const resolved = resolveSecret(apiKey) || '';
  return `${baseUrl}:${resolved.slice(-6)}`;
}

/**
 * 标记 API Key 为暂不可用（cooldown 状态）
 * @param baseUrl API Base URL
 * @param apiKey API Key（支持 $ENV 引用）
 * @param cooldownSecs 冷却时长（秒），默认 600
 * @param reason 标记原因
 */
export function markKeyCooldown(baseUrl: string, apiKey: string, cooldownSecs?: number, reason?: string): void {
  const keyId = makeKeyId(baseUrl, apiKey);
  const expiresAt = Date.now() + (cooldownSecs ?? DEFAULT_COOLDOWN_SECS) * 1000;
  keyCooldowns.set(keyId, { expiresAt, reason: reason || 'retryLogs 命中' });
  const label = findSettingLabel([], apiKey);
  console.log(`[${timestamp()}] API Key ${label} (${baseUrl}) 标记为暂不可用，${cooldownSecs ?? DEFAULT_COOLDOWN_SECS}s 后恢复（原因: ${reason || 'retryLogs 命中'}）`);
}

/**
 * 检查 API Key 是否在 cooldown 状态
 * 如果已过期则自动清除
 */
export function isKeyOnCooldown(baseUrl: string, apiKey: string): boolean {
  const keyId = makeKeyId(baseUrl, apiKey);
  const state = keyCooldowns.get(keyId);
  if (!state) return false;
  if (Date.now() >= state.expiresAt) {
    keyCooldowns.delete(keyId);
    return false;
  }
  return true;
}

/**
 * 从 modelSettings 中选取一个不在 cooldown 状态的可用 Key
 * @param self DingClaude 实例
 * @param excludeApiKey 排除指定 apiKey
 * @returns 可用的 Setting，若全部在 cooldown 则返回 null
 */
export function pickAvailableApiKey(self: DingClaude, excludeApiKey?: string): IClaudeSetting | null {
  const cfg = self.getApiKeyCfg();
  if (!cfg?.modelSettings?.length) return null;

  const resolvedExclude = excludeApiKey ? resolveSecret(excludeApiKey) : undefined;
  const available = cfg.modelSettings.filter(s => {
    if (!s.isValid) return false;
    const resolved = resolveSecret(s.apiKey);
    if (resolvedExclude && resolved === resolvedExclude) return false;
    if (isKeyOnCooldown(s.baseUrl, s.apiKey)) return false;
    return true;
  });

  if (available.length === 0) return null;
  return available[Math.floor(Math.random() * available.length)];
}

/**
 * 获取最早恢复可用的时间戳，若全部不在 cooldown 则返回 0
 */
export function getEarliestCooldownExpiry(): number {
  let earliest = 0;
  for (const state of keyCooldowns.values()) {
    if (state.expiresAt > Date.now()) {
      if (!earliest || state.expiresAt < earliest) {
        earliest = state.expiresAt;
      }
    }
  }
  return earliest;
}

/**
 * 等待直到有 API Key 恢复可用
 * @param maxWaitSecs 最大等待时间（秒），默认 600
 * @returns 是否有可用 Key
 */
export async function waitForKeyAvailable(maxWaitSecs = 600): Promise<boolean> {
  return waitForKeyAvailableWithActivityUpdate(maxWaitSecs);
}

/**
 * 等待直到有 API Key 恢复可用，期间定期调用 onTick 保持活动状态
 * @param maxWaitSecs 最大等待时间（秒），默认 600
 * @param onTick 每次轮询时的回调，用于更新 lastActivityTime 防止 Watchdog 超时
 * @returns 是否有可用 Key
 */
export async function waitForKeyAvailableWithActivityUpdate(
  maxWaitSecs = 600,
  onTick?: () => void,
): Promise<boolean> {
  const deadline = Date.now() + maxWaitSecs * 1000;
  while (Date.now() < deadline) {
    const expiry = getEarliestCooldownExpiry();
    if (!expiry) return true; // 有可用 key

    const waitMs = Math.min(expiry - Date.now(), 5000); // 每次最多等 5 秒
    if (waitMs <= 0) continue;
    await new Promise(r => setTimeout(r, waitMs));
    onTick?.(); // 保持活动状态
  }
  return false;
}

/**
 * 迁移 apiKeyCfg：兼容旧版 claudeSettings 字段名，确保 modelSettings 始终为数组
 */
export function migrateApiKeyCfg(cfg: any): void {
  if (!cfg.apiKeyCfg) return;
  if (!Array.isArray(cfg.apiKeyCfg.modelSettings)) {
    if (Array.isArray((cfg.apiKeyCfg as any).claudeSettings)) {
      console.log('[migrateApiKeyCfg] 检测到旧字段名 claudeSettings，自动迁移为 modelSettings');
      cfg.apiKeyCfg.modelSettings = (cfg.apiKeyCfg as any).claudeSettings;
      delete (cfg.apiKeyCfg as any).claudeSettings;
    } else {
      cfg.apiKeyCfg.modelSettings = [];
    }
  }
}

/**
 * 保存 config.json 到磁盘
 */
export function saveClientConfig(self: DingClaude): void {
  const configPath = `${self.getClientDir()}/config.json`;
  try {
    // 配置包含密钥，限制为仅 owner 可读写
    fs.writeFileSync(configPath, JSON.stringify(self.config, null, 2), { encoding: 'utf-8', mode: isWindows() ? undefined : 0o600 });
    if (!isWindows()) fs.chmodSync(configPath, 0o600);
  } catch (err) {
    console.error(`[${timestamp()}] 保存 config.json 失败:`, err);
  }
}

/**
 * 重置 apiKeyCfg：modelSettings[].isValid 全部重置为 true
 * 仅由用户通过命令触发，系统不会自动调用
 */
export function resetApiKeyCfg(self: DingClaude): void {
  const cfg = self.config.apiKeyCfg;
  if (!cfg?.modelSettings?.length) return;
  const now = new Date();
  cfg.resetTime = dateUtil.mm(now.getTime()).format('YYYY-MM-DD HH:mm:ss');
  let resetCount = 0;
  for (const setting of cfg.modelSettings) {
    if (!setting.isValid) {
      setting.isValid = true;
      resetCount++;
    }
  }
  if (resetCount > 0) {
    console.log(`[${timestamp()}] ${resetCount} 个 Model Setting 已重新启用`);
  }
  saveClientConfig(self);
  console.log(`[${timestamp()}] apiKeyCfg 已重置 (所有 Model Setting isValid=true)`);
}

/**
 * 生成 Model Setting 的可读标识，有 memo 时显示 memo，否则显示 apiKey 后6位
 */
export function settingLabel(setting: IClaudeSetting): string {
  return setting.memo ? setting.memo : `...${setting.apiKey.slice(-6)}`;
}

/**
 * 在 modelSettings 中查找指定 apiKey 的可读标识
 */
function findSettingLabel(settings: IClaudeSetting[], apiKey: string): string {
  const found = settings.find(s => resolveSecret(s.apiKey) === resolveSecret(apiKey));
  return found ? settingLabel(found) : `...${apiKey.slice(-6)}`;
}

/**
 * 连续失败时切换 Key：从启用的 Setting 中随机选一个（排除当前 Key）
 * isValid 仅允许用户手动变更，系统不会自动标记为无效
 * 返回新的 Setting，若无可用则返回 null
 */
export function rotateApiKey(self: DingClaude, usedKey: string): IClaudeSetting | null {
  const cfg = self.getApiKeyCfg();
  if (!cfg?.modelSettings?.length) return null;

  const resolvedUsedKey = resolveSecret(usedKey);
  const candidates = cfg.modelSettings.filter(s => s.isValid && resolveSecret(s.apiKey) !== resolvedUsedKey);
  if (candidates.length === 0) return null;

  // 按顺序选取第一个可用 Key（排前的优先）
  const newSetting = candidates[0];
  const usedKeyLabel = findSettingLabel(cfg.modelSettings, usedKey);
  console.log(`[${timestamp()}] 连续失败切换 Key: ${usedKeyLabel} → ${settingLabel(newSetting)}（剩余候选: ${candidates.length}）`);
  return newSetting;
}

/**
 * 按顺序从 modelSettings 中取第一个有效的 Setting（排前的优先使用）
 * @param excludeApiKey 排除指定 apiKey（用于切换时排除当前 Key）
 */
export function pickValidApiKey(self: DingClaude, excludeApiKey?: string): IClaudeSetting | null {
  const cfg = self.getApiKeyCfg();
  if (!cfg?.modelSettings?.length) return null;
  const resolvedExclude = excludeApiKey ? resolveSecret(excludeApiKey) : undefined;
  const validSettings = cfg.modelSettings.filter(s => s.isValid && (!resolvedExclude || resolveSecret(s.apiKey) !== resolvedExclude));
  if (validSettings.length === 0) return null;
  // 返回第一个有效 Key（排前的优先）
  return validSettings[0];
}

/**
 * 确保工作目录下的 settings-ding.json 中配置了 Claude 连接参数
 * 使用独立文件避免污染用户自己的 settings.json
 * 写入 ANTHROPIC_AUTH_TOKEN、ANTHROPIC_BASE_URL、ANTHROPIC_MODEL、CLAUDE_SMALL_FAST_MODEL
 * 返回 settings 文件绝对路径
 */
export function ensureSettingsWithApiKey(workDir: string, setting: IClaudeSetting): string {
  const claudeDir = path.join(workDir, '.claude');
  const settingsPath = path.join(claudeDir, 'settings-ding.json');

  let settings: Record<string, any> = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    } catch {
      settings = {};
    }
  } else {
    // settings-ding.json 不存在，从模板创建
    const tplPath = path.join(getHomeDir(), '.cc-ding', 'settings-tpl.json');
    if (fs.existsSync(tplPath)) {
      try {
        settings = JSON.parse(fs.readFileSync(tplPath, 'utf-8'));
        console.log(`[${timestamp()}] 从模板创建 settings-ding.json: ${tplPath}`);
      } catch {
        settings = {};
      }
    }
  }

  if (!settings.env) {
    settings.env = {};
  }

  let changed = false;
  const resolvedApiKey = resolveSecret(setting.apiKey);
  if (settings.env.ANTHROPIC_AUTH_TOKEN !== resolvedApiKey) {
    settings.env.ANTHROPIC_AUTH_TOKEN = resolvedApiKey;
    changed = true;
  }
  if (setting.baseUrl && settings.env.ANTHROPIC_BASE_URL !== setting.baseUrl) {
    settings.env.ANTHROPIC_BASE_URL = setting.baseUrl;
    changed = true;
  }
  if (setting.model && settings.env.ANTHROPIC_MODEL !== setting.model) {
    settings.env.ANTHROPIC_MODEL = setting.model;
    changed = true;
  }
  const effectiveSmallModel = setting.smallModel || setting.model;
  if (effectiveSmallModel && settings.env.CLAUDE_SMALL_FAST_MODEL !== effectiveSmallModel) {
    settings.env.CLAUDE_SMALL_FAST_MODEL = effectiveSmallModel;
    changed = true;
  }

  if (changed) {
    fs.mkdirSync(claudeDir, { recursive: true });
    // settings-ding.json 含明文 API Key，限制为仅 owner 可读写
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), { encoding: 'utf-8', mode: isWindows() ? undefined : 0o600 });
    if (!isWindows()) fs.chmodSync(settingsPath, 0o600);
    console.log(`[${timestamp()}] 已写入 Claude 配置到 ${settingsPath} (${settingLabel(setting)}, model: ${setting.model}, smallModel: ${effectiveSmallModel})`);
  }

  return settingsPath;
}

/**
 * 判断错误输出是否为认证/授权错误（401）
 * 401 为不可重试错误，通常表示 API Key 无效或服务未授权
 */
export function isAuthenticationError(output: string): boolean {
  // 匹配 "authentication_error" 类型
  if (/authentication_error/i.test(output)) return true;
  // 匹配 "401" + "服务未授权" / "unauthorized" / "invalid.*key" / "invalid.*token" 等组合
  if (/401.*(?:未授权|unauthorized|invalid\s*(?:key|token|api)|auth)/i.test(output)) return true;
  if (/(?:未授权|unauthorized|invalid\s*(?:key|token|api)|auth).*401/i.test(output)) return true;
  return false;
}

/**
 * 从工作目录下的 settings-ding.json 读取 env.ANTHROPIC_AUTH_TOKEN
 * 返回 API Key 或 null
 */
export function readApiKeyFromSettings(workDir: string): string | null {
  const settingsPath = path.join(workDir, '.claude', 'settings-ding.json');
  if (!fs.existsSync(settingsPath)) {
    return null;
  }
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    return settings.env?.ANTHROPIC_AUTH_TOKEN || null;
  } catch {
    return null;
  }
}

/**
 * 检查 settings-ding.json 中的 env.FORCE_ENABLE 是否启用
 * 非空且非 false 时返回 settings-ding.json 路径，否则返回 null
 */
export function getForceEnabledSettingsPath(workDir: string): string | null {
  const settingsPath = path.join(workDir, '.claude', 'settings-ding.json');
  if (!fs.existsSync(settingsPath)) return null;
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    const forceEnable = settings.env?.FORCE_ENABLE;
    if (forceEnable !== undefined && forceEnable !== false && forceEnable !== '') {
      console.log(`[${timestamp()}] 检测到 settings-ding.json FORCE_ENABLE=${forceEnable}，强制使用该配置`);
      return settingsPath;
    }
    return null;
  } catch {
    return null;
  }
}

// ==================== 启动自检 ====================

/** 自检结果级别 */
export type CheckLevel = 'FATAL' | 'WARN' | 'PASS';

export interface CheckResult {
  level: CheckLevel;
  message: string;
}

/**
 * 启动自检：检查 config.json schema、settings-tpl.json、apiKeyCfg、工作目录等
 * FATAL → 进程退出；WARN → 警告但继续；PASS → 通过
 */
export function startupCheck(self: DingClaude): void {
  const results: CheckResult[] = [];
  const config = self.config;
  const clientDir = self.getClientDir();

  // ---- 1. config.json 必填字段检查 ----
  const requiredFields: { key: string; label: string }[] = [
    { key: 'clientSecret', label: 'clientSecret (钉钉 Stream Client 密钥)' },
    { key: 'whiteUserList', label: 'whiteUserList (白名单用户)' },
    { key: 'owner', label: 'owner (机器人 owner)' },
  ];
  for (const { key, label } of requiredFields) {
    const val = (config as any)[key];
    if (val === undefined || val === null || val === '' || (Array.isArray(val) && val.length === 0)) {
      results.push({ level: 'FATAL', message: `config.json 缺少必填字段: ${label}` });
    } else {
      results.push({ level: 'PASS', message: `config.json ${label} ✓` });
    }
  }

  // ---- 2. conversations 结构检查 ----
  if (!Array.isArray(config.conversations)) {
    results.push({ level: 'FATAL', message: 'conversations 应为数组或已配置' });
  } else if (config.conversations.length === 0) {
    results.push({ level: 'PASS', message: 'conversations 为空数组，可通过 /reg 命令动态注册' });
  } else {
    const convIds = new Set<string>();
    for (let i = 0; i < config.conversations.length; i++) {
      const conv = config.conversations[i];
      const prefix = `conversations[${i}]`;
      if (!conv.conversationId) {
        results.push({ level: 'FATAL', message: `${prefix} 缺少 conversationId` });
      } else if (convIds.has(conv.conversationId)) {
        results.push({ level: 'WARN', message: `${prefix} conversationId 重复: ${conv.conversationId}` });
      } else {
        convIds.add(conv.conversationId);
      }
      // linkConversationId 引用检查
      if (conv.linkConversationId && !config.conversations.some(c => c.conversationId === conv.linkConversationId)) {
        results.push({ level: 'WARN', message: `${prefix} linkConversationId "${conv.linkConversationId}" 未在 conversations 中找到` });
      }
    }
    results.push({ level: 'PASS', message: `conversations 共 ${config.conversations.length} 个群配置` });
  }

  // ---- 2.5 安全检查 ----
  // bypassPermissions 显式配置告警
  for (const conv of config.conversations || []) {
    if (conv.permissionMode === 'bypassPermissions') {
      const label = conv.conversationTitle || conv.conversationId;
      results.push({ level: 'WARN', message: `会话 "${label}" 配置了 bypassPermissions，Claude 将跳过所有权限确认，请确认该群成员可信` });
    }
  }
  // config.json 文件权限检查（包含密钥，应为 0600）
  // Windows 无 POSIX 权限概念，跳过
  if (!isWindows()) {
    const cfgFilePath = path.join(clientDir, 'config.json');
    try {
      const mode = fs.statSync(cfgFilePath).mode & 0o777;
      if (mode & 0o077) {
        fs.chmodSync(cfgFilePath, 0o600);
        results.push({ level: 'WARN', message: `config.json 权限过宽 (${mode.toString(8)})，已自动收紧为 600` });
      }
    } catch { /* ignore */ }
  }
  // $ENV: 引用可解析性检查（apiKeyCfg 支持全局 + client 维度，client 优先）
  const effectiveApiKeyCfg = config.apiKeyCfg?.modelSettings?.length
    ? config.apiKeyCfg
    : (getGlobalConfig() as any)?.apiKeyCfg;
  const envRefChecks: { value?: string; label: string }[] = [
    { value: config.clientSecret, label: 'clientSecret' },
    { value: config.defaultDingToken, label: 'defaultDingToken' },
    ...(config.conversations || []).map((c, i) => ({ value: c.dingToken, label: `conversations[${i}].dingToken` })),
    ...(effectiveApiKeyCfg?.modelSettings || []).map((s: IClaudeSetting, i: number) => ({ value: s.apiKey, label: `apiKeyCfg.modelSettings[${i}].apiKey` })),
  ];
  for (const { value, label } of envRefChecks) {
    if (isEnvRef(value) && !resolveSecret(value)) {
      results.push({ level: 'FATAL', message: `${label} 引用的环境变量未设置: ${value}` });
    }
  }

  // ---- 3. apiKeyCfg 检查 ----
  if (effectiveApiKeyCfg) {
    const cfg = effectiveApiKeyCfg;
    // resetTime
    if (cfg.resetTime) {
      results.push({ level: 'PASS', message: `apiKeyCfg 上次重置时间: ${cfg.resetTime}` });
    }
    // modelSettings
    if (!Array.isArray(cfg.modelSettings)) {
      results.push({ level: 'WARN', message: 'apiKeyCfg.modelSettings 不是数组，API Key 轮换功能不可用' });
    } else if (cfg.modelSettings.length === 0) {
      results.push({ level: 'WARN', message: 'apiKeyCfg.modelSettings 为空，无可用 Key' });
    } else {
      const seenKeys = new Set<string>();
      for (let i = 0; i < cfg.modelSettings.length; i++) {
        const s = cfg.modelSettings[i];
        const p = `apiKeyCfg.modelSettings[${i}]`;
        if (!s.apiKey) {
          results.push({ level: 'FATAL', message: `${p} 缺少 apiKey` });
        } else if (seenKeys.has(s.apiKey)) {
          results.push({ level: 'WARN', message: `${p} apiKey 重复: ${settingLabel(s)}` });
        } else {
          seenKeys.add(s.apiKey);
        }
        if (!s.baseUrl) {
          results.push({ level: 'WARN', message: `${p} 缺少 baseUrl` });
        }
        if (!s.model) {
          results.push({ level: 'WARN', message: `${p} 缺少 model` });
        }
        if (typeof s.isValid !== 'boolean') {
          results.push({ level: 'WARN', message: `${p} isValid 类型异常: ${typeof s.isValid}` });
        }
      }
      const validCount = cfg.modelSettings.filter(s => s.isValid).length;
      results.push({ level: 'PASS', message: `apiKeyCfg.modelSettings 共 ${cfg.modelSettings.length} 项，有效 ${validCount}` });
    }
  }

  // ---- 4. settings-tpl.json 检查 ----
  const tplPath = path.join(getHomeDir(), '.cc-ding', 'settings-tpl.json');
  if (fs.existsSync(tplPath)) {
    try {
      const tpl = JSON.parse(fs.readFileSync(tplPath, 'utf-8'));
      if (typeof tpl !== 'object' || tpl === null) {
        results.push({ level: 'WARN', message: `settings-tpl.json 根元素不是对象` });
      } else {
        // 检查模板是否包含 env 字段
        if (!tpl.env || typeof tpl.env !== 'object') {
          results.push({ level: 'WARN', message: 'settings-tpl.json 缺少 env 字段，创建 settings-ding.json 时将不包含预配置环境变量' });
        } else {
          const envKeys = Object.keys(tpl.env);
          results.push({ level: 'PASS', message: `settings-tpl.json 有效，env 包含: ${envKeys.join(', ') || '(空)'}` });
        }
      }
    } catch (err) {
      results.push({ level: 'WARN', message: `settings-tpl.json 解析失败: ${err instanceof Error ? err.message : err}` });
    }
  } else {
    results.push({ level: 'WARN', message: `settings-tpl.json 不存在: ${tplPath}，创建 settings-ding.json 时将使用空模板` });
  }

  // ---- 5. claude 命令可用性 ----
  if (commandExists('claude')) {
    results.push({ level: 'PASS', message: 'claude 命令可用' });
  } else {
    results.push({ level: 'FATAL', message: 'claude 命令不可用，请确认 Claude Code CLI 已安装' });
  }

  // ---- 6. 工作目录可写检查 ----
  try {
    const testFile = path.join(clientDir, '.healthcheck');
    fs.writeFileSync(testFile, 'ok', 'utf-8');
    fs.unlinkSync(testFile);
    results.push({ level: 'PASS', message: `工作目录可写: ${clientDir}` });
  } catch (err) {
    results.push({ level: 'FATAL', message: `工作目录不可写: ${clientDir} — ${err instanceof Error ? err.message : err}` });
  }

  // ---- 7. 会话/任务目录初始化（含群工作目录） ----
  if (Array.isArray(config.conversations)) {
    for (const conv of config.conversations) {
      const convDir = self.getConversationDir(conv.conversationId);
      try {
        fs.mkdirSync(convDir, { recursive: true });
        results.push({ level: 'PASS', message: `群工作目录已就绪: ${conv.conversationTitle || conv.conversationId}` });
      } catch (err) {
        results.push({ level: 'WARN', message: `群工作目录创建失败: ${convDir} — ${err instanceof Error ? err.message : err}` });
      }
    }
  }

  // ---- 输出结果 ----
  console.log(`\n[${timestamp()}] ========== 启动自检 ==========`);
  const hasFatal = results.some(r => r.level === 'FATAL');
  for (const r of results) {
    const icon = r.level === 'PASS' ? '✓' : r.level === 'FATAL' ? '✗' : '⚠';
    const colored = r.level === 'PASS' ? r.message : r.level === 'FATAL' ? `[FATAL] ${r.message}` : `[WARN] ${r.message}`;
    console.log(`  ${icon} ${colored}`);
  }
  const passCount = results.filter(r => r.level === 'PASS').length;
  const warnCount = results.filter(r => r.level === 'WARN').length;
  const fatalCount = results.filter(r => r.level === 'FATAL').length;
  console.log(`[${timestamp()}] 自检完成: ${passCount} 通过, ${warnCount} 警告, ${fatalCount} 致命`);
  console.log(`[${timestamp()}] ==============================\n`);

  if (hasFatal) {
    console.error(`[${timestamp()}] 启动自检发现致命错误，进程退出`);
    process.exit(1);
  }
}
