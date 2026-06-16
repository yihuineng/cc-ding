import { IClaudeSetting } from './types';
import { getHomeDir } from './session';
import { CheckLevel, CheckResult, settingLabel } from './api-key-manager';
import fs from 'fs';
import path from 'path';
import { commandExists } from './platform';

export function printDoctorResults(results: CheckResult[]): void {
  console.log('');
  console.log('========== cc-ding doctor ==========');
  const hasFatal = results.some(r => r.level === 'FATAL');
  for (const r of results) {
    const icon = r.level === 'PASS' ? '✓' : r.level === 'FATAL' ? '✗' : '⚠';
    const tag = r.level === 'PASS' ? '' : `[${r.level}] `;
    console.log(`  ${icon} ${tag}${r.message}`);
  }
  const passCount = results.filter(r => r.level === 'PASS').length;
  const warnCount = results.filter(r => r.level === 'WARN').length;
  const fatalCount = results.filter(r => r.level === 'FATAL').length;
  console.log('------------------------------------');
  console.log(`  合计: ${passCount} 通过, ${warnCount} 警告, ${fatalCount} 致命`);
  if (hasFatal) {
    console.log('  ❌ 存在致命问题，请修复后重新运行');
  } else {
    console.log('  ✅ 所有检查通过');
  }
  console.log('====================================\n');
  if (hasFatal) process.exit(1);
}


export function runDoctor(clientDir: string): CheckResult[] {
  const results: CheckResult[] = [];

  // ---- 0. Node 版本检查 (优先检查) ----
  const nodeVersion = process.version.slice(1);
  const nodeMajor = parseInt(nodeVersion.split('.')[0], 10);
  if (nodeMajor < 22) {
    results.push(check('FATAL', `Node 版本过低：${nodeVersion}，要求 Node >= 22`));
    // 继续检查其他项目，让用户看到完整的检查报告
  } else {
    results.push(check('PASS', `Node 版本：${nodeVersion}`));
  }

  // ---- 0. 客户端目录检查 ----
  if (!fs.existsSync(clientDir)) {
    results.push(check('FATAL', `客户端目录不存在: ${clientDir}`));
    return results;
  }
  results.push(check('PASS', `客户端目录存在: ${clientDir}`));

  // ---- 0.1 PID 锁检查 ----
  const pidFile = path.join(clientDir, '.pid.lock');
  if (fs.existsSync(pidFile)) {
    try {
      const existingPid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
      if (!isNaN(existingPid)) {
        try {
          process.kill(existingPid, 0);
          results.push(check('PASS', `进程运行中 (PID: ${existingPid})`));
        } catch {
          results.push(check('WARN', `锁文件存在但进程 ${existingPid} 已退出（过期锁文件）`));
        }
      }
    } catch {
      results.push(check('WARN', `PID 锁文件读取异常: ${pidFile}`));
    }
  } else {
    results.push(check('PASS', '无运行中的进程'));
  }

  // ---- 1. config.json 检查 ----
  const cfgFile = path.join(clientDir, 'config.json');
  if (!fs.existsSync(cfgFile)) {
    results.push(check('FATAL', 'config.json 不存在'));
    return results;
  }

  let config: any;
  try {
    config = JSON.parse(fs.readFileSync(cfgFile, 'utf-8'));
  } catch (err) {
    results.push(check('FATAL', `config.json 解析失败: ${err instanceof Error ? err.message : err}`));
    return results;
  }
  results.push(check('PASS', 'config.json 解析成功'));

  // 1.1 必填字段
  const requiredFields: { key: string; label: string; isArr?: boolean }[] = [
    { key: 'clientSecret', label: 'clientSecret' },
    { key: 'defaultDingToken', label: 'defaultDingToken' },
    { key: 'whiteUserList', label: 'whiteUserList', isArr: true },
    { key: 'owner', label: 'owner' },
  ];
  for (const { key, label, isArr } of requiredFields) {
    const val = config[key];
    if (val === undefined || val === null || val === '') {
      results.push(check('FATAL', `缺少必填字段: ${label}`));
    } else if (isArr && !Array.isArray(val)) {
      results.push(check('FATAL', `${label} 应为数组`));
    } else if (key !== 'conversations' && isArr && val.length === 0) {
      results.push(check('WARN', `${label} 为空数组`));
    } else if (!isArr && typeof val === 'string' && val.startsWith('<')) {
      results.push(check('FATAL', `${label} 仍为占位符: ${val}`));
    } else {
      results.push(check('PASS', `${label} ✓`));
    }
  }

  // 1.2 owner 字段（必填）
  if (config.owner) {
    results.push(check('PASS', `owner: ${config.owner}`));
  } else {
    results.push(check('FATAL', 'owner 未配置，管理命令（/clean, /open, /reset-apikeycfg, /reg, /auth）不可用'));
  }

  // 1.3 占位符检查
  const placeholderFields = [ 'clientSecret', 'defaultDingToken' ];
  for (const key of placeholderFields) {
    const val = config[key];
    if (typeof val === 'string' && /^<.*>$/.test(val.trim())) {
      results.push(check('FATAL', `${key} 仍为占位符: ${val}`));
    }
  }

  // ---- 2. conversations 检查 ----
  const convIds = new Set<string>();
  if (!Array.isArray(config.conversations)) {
    results.push(check('FATAL', 'conversations 应为数组'));
  } else if (config.conversations.length === 0) {
    results.push(check('PASS', 'conversations 为空数组，可通过 /reg 命令动态注册'));
  } else {
    for (let i = 0; i < config.conversations.length; i++) {
      const conv = config.conversations[i];
      const prefix = `conversations[${i}]`;

      if (!conv.conversationId) {
        results.push(check('FATAL', `${prefix} 缺少 conversationId`));
      } else if (typeof conv.conversationId === 'string' && /^<.*>$/.test(conv.conversationId.trim())) {
        results.push(check('FATAL', `${prefix} conversationId 仍为占位符: ${conv.conversationId}`));
      } else if (convIds.has(conv.conversationId)) {
        results.push(check('WARN', `${prefix} conversationId 重复: ${conv.conversationId}`));
      } else {
        convIds.add(conv.conversationId);
      }

      if (conv.linkConversationId && !config.conversations.some((c: any) => c.conversationId === conv.linkConversationId)) {
        results.push(check('WARN', `${prefix} linkConversationId "${conv.linkConversationId}" 未在 conversations 中找到`));
      }

      if (conv.dingToken && typeof conv.dingToken === 'string' && /^<.*>$/.test(conv.dingToken.trim())) {
        results.push(check('WARN', `${prefix} dingToken 仍为占位符`));
      }
    }
    results.push(check('PASS', `conversations 共 ${config.conversations.length} 个群配置`));
  }

  // ---- 3. apiKeyCfg 检查 ----
  if (config.apiKeyCfg) {
    const cfg = config.apiKeyCfg;
    if (cfg.resetTime) {
      results.push(check('PASS', `apiKeyCfg.resetTime: ${cfg.resetTime}`));
    }
    if (!Array.isArray(cfg.claudeSettings)) {
      results.push(check('WARN', 'apiKeyCfg.claudeSettings 不是数组'));
    } else if (cfg.claudeSettings.length === 0) {
      results.push(check('WARN', 'apiKeyCfg.claudeSettings 为空，无备用 Key'));
    } else {
      const seenKeys = new Set<string>();
      for (let i = 0; i < cfg.claudeSettings.length; i++) {
        const s: IClaudeSetting = cfg.claudeSettings[i];
        const p = `apiKeyCfg.claudeSettings[${i}]`;
        if (!s.apiKey) {
          results.push(check('FATAL', `${p} 缺少 apiKey`));
        } else if (seenKeys.has(s.apiKey)) {
          results.push(check('WARN', `${p} apiKey 重复: ${settingLabel(s)}`));
        } else {
          seenKeys.add(s.apiKey);
        }
        if (!s.baseUrl) results.push(check('WARN', `${p} 缺少 baseUrl`));
        if (!s.model) results.push(check('WARN', `${p} 缺少 model`));
        if (typeof s.isValid !== 'boolean') results.push(check('WARN', `${p} isValid 类型异常: ${typeof s.isValid}`));
      }
      const validCount = cfg.claudeSettings.filter((s: IClaudeSetting) => s.isValid).length;
      results.push(check('PASS', `apiKeyCfg.claudeSettings 共 ${cfg.claudeSettings.length} 项，有效 ${validCount}`));
    }
  } else {
    results.push(check('WARN', 'apiKeyCfg 未配置，无法使用 API Key 池化轮换'));
  }

  // ---- 4. cron.json 检查 ----
  const cronFile = path.join(clientDir, 'cron.json');
  if (fs.existsSync(cronFile)) {
    try {
      const cronData = JSON.parse(fs.readFileSync(cronFile, 'utf-8'));
      const jobs = Array.isArray(cronData) ? cronData : cronData.jobs;
      if (Array.isArray(jobs)) {
        const enabledCount = jobs.filter((j: any) => j.enabled !== false).length;
        results.push(check('PASS', `cron.json 共 ${jobs.length} 个定时任务 (${enabledCount} 启用)`));
        for (let i = 0; i < jobs.length; i++) {
          const j = jobs[i];
          if (!j.id) results.push(check('WARN', `cron.json[${i}] 缺少 id`));
          if (!j.cronExpression) results.push(check('WARN', `cron.json[${i}] 缺少 cronExpression`));
          if (!j.prompt) results.push(check('WARN', `cron.json[${i}] 缺少 prompt`));
          if (!j.conversationId) results.push(check('WARN', `cron.json[${i}] 缺少 conversationId`));
          else if (!convIds.has(j.conversationId)) {
            results.push(check('WARN', `cron.json[${i}] conversationId "${j.conversationId}" 未在 config.json conversations 中找到`));
          }
        }
      } else {
        results.push(check('WARN', 'cron.json 格式异常，无法解析为任务数组'));
      }
    } catch (err) {
      results.push(check('WARN', `cron.json 解析失败: ${err instanceof Error ? err.message : err}`));
    }
  } else {
    results.push(check('PASS', 'cron.json 不存在 (无定时任务)'));
  }

  // ---- 5. settings-tpl.json 检查 ----
  const tplPath = path.join(getHomeDir(), '.cc-ding', 'settings-tpl.json');
  if (fs.existsSync(tplPath)) {
    try {
      const tpl = JSON.parse(fs.readFileSync(tplPath, 'utf-8'));
      if (typeof tpl !== 'object' || tpl === null) {
        results.push(check('WARN', 'settings-tpl.json 根元素不是对象'));
      } else if (!tpl.env || typeof tpl.env !== 'object') {
        results.push(check('WARN', 'settings-tpl.json 缺少 env 字段'));
      } else {
        const envKeys = Object.keys(tpl.env);
        results.push(check('PASS', `settings-tpl.json 有效，env 包含: ${envKeys.join(', ') || '(空)'}`));
      }
    } catch (err) {
      results.push(check('WARN', `settings-tpl.json 解析失败: ${err instanceof Error ? err.message : err}`));
    }
  } else {
    results.push(check('WARN', 'settings-tpl.json 不存在，创建 settings-ding.json 时将使用空模板'));
  }

  // ---- 6. 命令可用性检查 ----
  if (commandExists('claude')) {
    results.push(check('PASS', 'claude 命令可用'));
  } else {
    results.push(check('FATAL', 'claude 命令不可用，请确认 Claude Code CLI 已安装'));
  }

  // ---- 7. 客户端目录可写检查 ----
  try {
    const testFile = path.join(clientDir, '.doctor-check');
    fs.writeFileSync(testFile, 'ok', 'utf-8');
    fs.unlinkSync(testFile);
    results.push(check('PASS', '客户端目录可写'));
  } catch (err) {
    results.push(check('FATAL', `客户端目录不可写: ${err instanceof Error ? err.message : err}`));
  }

  return results;
}

function check(level: CheckLevel, message: string): CheckResult {
  return { level, message };
}
