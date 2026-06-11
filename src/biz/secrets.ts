/**
 * 密钥解析工具
 * 配置文件中的敏感字段（clientSecret/dingToken/defaultDingToken/apiKey）支持
 * `$ENV:VAR_NAME` 形式引用环境变量，避免明文落盘。
 *
 * 解析发生在「使用点」而非加载时：config 对象内存中始终保留原始引用，
 * 保证 saveClientConfig 写回磁盘时不会泄漏解析后的明文。
 */

const ENV_REF_RE = /^\$ENV:(\w+)$/;

/** 已告警过的缺失环境变量，避免重复刷屏 */
const warnedMissingVars = new Set<string>();

/** 判断配置值是否为环境变量引用 */
export function isEnvRef(value: string | undefined): boolean {
  return !!value && ENV_REF_RE.test(value.trim());
}

/**
 * 解析配置中的敏感值：
 * - `$ENV:NAME` -> process.env.NAME（未设置时告警并返回空字符串）
 * - 其他值原样返回
 */
export function resolveSecret(value: string): string;
export function resolveSecret(value: string | undefined): string | undefined;
export function resolveSecret(value: string | undefined): string | undefined {
  if (!value) return value;
  const match = value.trim().match(ENV_REF_RE);
  if (!match) return value;
  const envName = match[1];
  const resolved = process.env[envName];
  if (resolved === undefined || resolved === '') {
    if (!warnedMissingVars.has(envName)) {
      warnedMissingVars.add(envName);
      console.error(`[secrets] 配置引用的环境变量未设置: ${envName} (引用值: ${value})`);
    }
    return '';
  }
  return resolved;
}
