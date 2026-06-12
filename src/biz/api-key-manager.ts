import fs from 'fs';
import path from 'path';
import type { DingClaude } from './cc-ding-cli';
import { IClaudeSetting } from './types';
import { timestamp, getHomeDir } from './session';
import { dateUtil } from 'utils-ok';
import { resolveSecret, isEnvRef } from './secrets';
import { commandExists, isWindows } from './platform';

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
 * 重置 apiKeyCfg：claudeSettings[].isValid 全部重置为 true
 * 用于启动时和每天 0 点定时重置
 */
export function resetApiKeyCfg(self: DingClaude): void {
  const cfg = self.config.apiKeyCfg;
  if (!cfg) return;

  const now = new Date();
  cfg.resetTime = dateUtil.mm(now.getTime()).format('YYYY-MM-DD HH:mm:ss');
  let resetCount = 0;
  for (const setting of cfg.claudeSettings) {
    if (!setting.isValid) {
      setting.isValid = true;
      resetCount++;
    }
  }
  if (resetCount > 0) {
    console.log(`[${timestamp()}] ${resetCount} 个已失效 Claude Setting 重新标记为有效`);
  }
  saveClientConfig(self);
  console.log(`[${timestamp()}] apiKeyCfg 已重置 (所有 Claude Setting isValid=true)`);
}

/**
 * 调度每天 0 点重置 apiKeyCfg
 * 每次触发后重新对齐下一个 0 点，避免 setInterval 漂移累积
 */
export function scheduleApiKeyCfgDailyReset(self: DingClaude): void {
  const scheduleNext = () => {
    const now = new Date();
    const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
    const msUntilMidnight = nextMidnight.getTime() - now.getTime();

    setTimeout(() => {
      console.log(`[${timestamp()}] 定时重置 apiKeyCfg (每天0点)`);
      resetApiKeyCfg(self);
      scheduleNext(); // 重新校准到下一个 0 点
    }, msUntilMidnight);

    console.log(`[${timestamp()}] apiKeyCfg 每日重置已调度，下次重置: ${nextMidnight.toISOString()}`);
  };
  scheduleNext();
}

/**
 * 生成 Claude Setting 的可读标识，有 memo 时显示 memo，否则显示 apiKey 后6位
 */
export function settingLabel(setting: IClaudeSetting): string {
  return setting.memo ? setting.memo : `...${setting.apiKey.slice(-6)}`;
}

/**
 * 在 claudeSettings 中查找指定 apiKey 的可读标识
 */
function findSettingLabel(settings: IClaudeSetting[], apiKey: string): string {
  const found = settings.find(s => resolveSecret(s.apiKey) === resolveSecret(apiKey));
  return found ? settingLabel(found) : `...${apiKey.slice(-6)}`;
}

/**
 * 将指定的 Claude Setting 标记为无效，并挑选新的有效 Setting
 * 返回新的有效 Setting，若无可用则返回 null
 */
export function rotateApiKey(self: DingClaude, usedKey: string): IClaudeSetting | null {
  const cfg = self.config.apiKeyCfg;
  if (!cfg) return null;
  // 标记匹配的 setting 为无效
  for (const setting of cfg.claudeSettings) {
    if (resolveSecret(setting.apiKey) === resolveSecret(usedKey) && setting.isValid) {
      setting.isValid = false;
      break;
    }
  }
  const validCount = cfg.claudeSettings.filter(s => s.isValid).length;
  const usedKeyLabel = findSettingLabel(cfg.claudeSettings, usedKey);
  console.log(`[${timestamp()}] Claude Setting 已失效: ${usedKeyLabel}, 剩余有效: ${validCount}`);
  saveClientConfig(self);

  return pickValidApiKey(self);
}

/**
 * 随机从 claudeSettings 中取一个有效的 Setting
 */
export function pickValidApiKey(self: DingClaude): IClaudeSetting | null {
  const cfg = self.config.apiKeyCfg;
  if (!cfg) return null;
  const validSettings = cfg.claudeSettings.filter(s => s.isValid);
  if (validSettings.length === 0) return null;
  return validSettings[Math.floor(Math.random() * validSettings.length)];
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
 * 判断错误输出是否为配额耗尽错误（429 不可重试）
 * 仅匹配明确表示配额/额度已用尽的 429，如 "Request rejected" 或 "超过模型使用上限"
 * 其他 429（如临时限流）由 isRetryableApiError 处理为可重试
 */
export function isQuotaExhaustedError(output: string): boolean {
  // "Request rejected" + 429 - 明确表示配额被拒绝
  if (/Request\s+rejected.*429/i.test(output)) return true;
  if (/429.*Request\s+rejected/i.test(output)) return true;
  // "超过模型使用上限" 或类似配额耗尽描述 + 429
  if (/429.*(?:超过.*上限|使用上限|配额|quota|capacity)/i.test(output)) return true;
  if (/(?:超过.*上限|使用上限|配额|quota|capacity).*429/i.test(output)) return true;
  return false;
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
  // $ENV: 引用可解析性检查
  const envRefChecks: { value?: string; label: string }[] = [
    { value: config.clientSecret, label: 'clientSecret' },
    { value: config.defaultDingToken, label: 'defaultDingToken' },
    ...(config.conversations || []).map((c, i) => ({ value: c.dingToken, label: `conversations[${i}].dingToken` })),
    ...(config.apiKeyCfg?.claudeSettings || []).map((s, i) => ({ value: s.apiKey, label: `apiKeyCfg.claudeSettings[${i}].apiKey` })),
  ];
  for (const { value, label } of envRefChecks) {
    if (isEnvRef(value) && !resolveSecret(value)) {
      results.push({ level: 'FATAL', message: `${label} 引用的环境变量未设置: ${value}` });
    }
  }

  // ---- 3. apiKeyCfg 检查 ----
  if (config.apiKeyCfg) {
    const cfg = config.apiKeyCfg;
    // resetTime
    if (cfg.resetTime) {
      results.push({ level: 'PASS', message: `apiKeyCfg 上次重置时间: ${cfg.resetTime}` });
    }
    // claudeSettings
    if (!Array.isArray(cfg.claudeSettings)) {
      results.push({ level: 'WARN', message: 'apiKeyCfg.claudeSettings 不是数组，API Key 轮换功能不可用' });
    } else if (cfg.claudeSettings.length === 0) {
      results.push({ level: 'WARN', message: 'apiKeyCfg.claudeSettings 为空，无可用 Key' });
    } else {
      const seenKeys = new Set<string>();
      for (let i = 0; i < cfg.claudeSettings.length; i++) {
        const s = cfg.claudeSettings[i];
        const p = `apiKeyCfg.claudeSettings[${i}]`;
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
      const validCount = cfg.claudeSettings.filter(s => s.isValid).length;
      results.push({ level: 'PASS', message: `apiKeyCfg.claudeSettings 共 ${cfg.claudeSettings.length} 项，有效 ${validCount}` });
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
