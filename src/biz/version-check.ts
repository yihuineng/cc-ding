import urllib from 'urllib';
import { projUtil } from '../common';

/** 当前运行版本号（从 package.json 读取） */
export const CURRENT_VERSION = projUtil().getPkgVersion();

/** 包名 */
const PKG_NAME = 'cc-ding';

/** npm 包 registry URL */
const REGISTRY_URL = `https://registry.npmjs.org/${PKG_NAME}`;

/** 请求超时（毫秒） */
const FETCH_TIMEOUT = 10_000;

// ==================== 接口 ====================

export interface IVersionCheckResult {
  /** 当前安装的版本号 */
  currentVersion: string;
  /** 最新 stable 版本号，null 表示查询失败或无 stable */
  latestVersion: string | null;
  /** 最新 beta 版本号，null 表示无 beta 或查询失败 */
  betaVersion: string | null;
  /** latest 发布时间，null 表示查询失败或无 stable */
  latestTime: string | null;
  /** beta 发布时间 */
  betaTime: string | null;
  /** 是否有新版本 stable */
  hasNewStable: boolean;
  /** 是否有新版本 beta */
  hasNewBeta: boolean;
  /** 错误信息 */
  error: string | null;
}

// ==================== 缓存 ====================

/** 缓存的版本检查结果 */
export const cachedResult: IVersionCheckResult = {
  currentVersion: CURRENT_VERSION,
  latestVersion: null,
  betaVersion: null,
  latestTime: null,
  betaTime: null,
  hasNewStable: false,
  hasNewBeta: false,
  error: null,
};

/** 是否正在查询中 */
let fetching = false;

// ==================== fetchDistTags ====================

interface NpmPackageMeta {
  'dist-tags': Record<string, string>;
  time: Record<string, string>;
}

/**
 * 从 npm registry 查询 cc-ding 的 dist-tags 和 time 信息
 */
export async function fetchDistTags(): Promise<{ distTags: Record<string, string>; time: Record<string, string> } | null> {
  try {
    const result = await urllib.request(REGISTRY_URL, {
      method: 'GET',
      headers: { Accept: 'application/vnd.npm.install-v1+json' },
      dataType: 'json',
      timeout: FETCH_TIMEOUT,
    });

    if (result.status !== 200) return null;

    const data = result.data as NpmPackageMeta;
    if (!data || !data['dist-tags']) return null;

    return {
      distTags: data['dist-tags'],
      time: data.time || {},
    };
  } catch {
    return null;
  }
}

// ==================== semverCompare ====================

/**
 * 比较两个 semver 版本号
 * @returns -1 (a < b), 0 (a === b), 1 (a > b)
 *
 * 规则：
 * - major.minor.patch 按数字逐段比较
 * - prerelease 版本低于同版本 stable（1.2.0-beta < 1.2.0）
 * - 纯数字 prerelease 比较数值大小
 * - 字符串 prerelease 比较字典序
 */
export function semverCompare(a: string, b: string): number {
  const parse = (v: string): { parts: number[]; pre: Array<string | number> | null } => {
    const [ main, pre ] = v.split('-');
    const parts = main.split('.').map(Number);
    const preParts = pre ? pre.split('.').map((s) => (/^\d+$/.test(s) ? Number(s) : s)) : null;
    return { parts, pre: preParts };
  };

  const A = parse(a);
  const B = parse(b);

  // 比较 major.minor.patch
  for (let i = 0; i < 3; i++) {
    const diff = (A.parts[i] || 0) - (B.parts[i] || 0);
    if (diff > 0) return 1;
    if (diff < 0) return -1;
  }

  // 主版本相同，比较 prerelease
  // 无 prerelease 的 stable 版本高于有 prerelease 的版本
  if (A.pre === null && B.pre === null) return 0;
  if (A.pre === null) return 1; // a 是 stable, b 是 prerelease → a > b
  if (B.pre === null) return -1; // b 是 stable, a 是 prerelease → a < b

  // 逐段比较 prerelease 标识符
  for (let i = 0; i < Math.max(A.pre.length, B.pre.length); i++) {
    const aSeg = A.pre[i];
    const bSeg = B.pre[i];

    if (aSeg === undefined) return -1; // a 的 prerelease 段少 → a < b
    if (bSeg === undefined) return 1;

    const aIsNum = typeof aSeg === 'number';
    const bIsNum = typeof bSeg === 'number';

    if (aIsNum && bIsNum) {
      if (aSeg > bSeg) return 1;
      if (aSeg < bSeg) return -1;
    } else if (aIsNum) {
      // 数字标识符优先级低于字符串 (semver spec: numeric < string)
      return -1;
    } else if (bIsNum) {
      return 1;
    } else {
      // 都是字符串，字典序比较
      const cmp = String(aSeg).localeCompare(String(bSeg));
      if (cmp !== 0) return cmp > 0 ? 1 : -1;
    }
  }

  return 0;
}

// ==================== checkForUpdates ====================

/**
 * 异步检查更新，结果写入 cachedResult，不阻塞调用方
 * 启动时调用一次即可
 */
export async function checkForUpdates(): Promise<void> {
  if (fetching) return;
  fetching = true;

  try {
    const meta = await fetchDistTags();
    if (!meta) {
      cachedResult.error = '无法连接到 npm registry';
      return;
    }

    const { distTags, time } = meta;
    const current = cachedResult.currentVersion;

    // latest 通道
    if (distTags.latest) {
      cachedResult.latestVersion = distTags.latest;
      cachedResult.latestTime = time[distTags.latest] || null;
      cachedResult.hasNewStable = semverCompare(distTags.latest, current) > 0;
    }

    // beta 通道
    if (distTags.beta) {
      cachedResult.betaVersion = distTags.beta;
      cachedResult.betaTime = time[distTags.beta] || null;
      cachedResult.hasNewBeta = semverCompare(distTags.beta, current) > 0;
    }
  } catch (err) {
    cachedResult.error = err instanceof Error ? err.message : String(err);
  } finally {
    fetching = false;
  }
}

// ==================== getUpdateCommand ====================

/**
 * 返回更新命令字符串
 * @param tag 可选，默认使用 latest，传入 beta 则更新到 beta
 */
export function getUpdateCommand(tag?: string): string {
  if (tag) {
    return `npm i ${PKG_NAME}@${tag} -g`;
  }
  return `npm i ${PKG_NAME} -g`;
}

// ==================== 格式化辅助 ====================

/**
 * 格式化版本检查结果为 markdown，用于 /version 命令展示
 */
export function formatVersionInfo(): string {
  const lines: string[] = [
    `### 📦 cc-ding 版本信息`,
    '',
    `- **cc-ding:** ${cachedResult.currentVersion}`,
  ];

  if (cachedResult.latestVersion) {
    const updateFlag = cachedResult.hasNewStable ? ' 🆕' : '';
    const timeStr = cachedResult.latestTime ? ` (${cachedResult.latestTime.split('T')[0]})` : '';
    lines.push(`- **latest:** ${cachedResult.latestVersion}${timeStr}${updateFlag}`);
  }

  if (cachedResult.betaVersion) {
    const updateFlag = cachedResult.hasNewBeta ? ' ' : '';
    const timeStr = cachedResult.betaTime ? ` (${cachedResult.betaTime.split('T')[0]})` : '';
    lines.push(`- **beta:** ${cachedResult.betaVersion}${timeStr}${updateFlag}`);
  }

  if (cachedResult.error) {
    lines.push(`- **检查状态:** ⚠️ ${cachedResult.error}`);
  } else if (cachedResult.latestVersion === null && cachedResult.betaVersion === null) {
    lines.push(`- **检查状态:** ⏳ 查询中...`);
  } else {
    if (cachedResult.hasNewStable) {
      lines.push('');
      lines.push(`📢 **有新版本可用！** 运行 \`/reboot --update\` 升级`);
    } else if (cachedResult.hasNewBeta && !cachedResult.hasNewStable) {
      lines.push('');
      lines.push(`📢 **有 beta 版本可用！** 运行 \`/reboot --update beta\` 升级`);
    } else {
      lines.push('- **状态:** ✅ 已是最新版本');
    }
  }

  return lines.join('\n');
}
