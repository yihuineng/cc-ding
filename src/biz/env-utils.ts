/**
 * 环境变量合并工具
 *
 * 优先级（后者覆盖前者同名 key）：
 *   process.env → config.envs → conversation.envs
 */

import type { DingClaude } from './cc-ding-cli';

/**
 * 合并环境变量，返回新的 env 对象
 * @param configEnvs IConfig 维度的 envs
 * @param convEnvs IConversation 维度的 envs
 */
export function mergeEnvs(
  configEnvs?: Record<string, string>,
  convEnvs?: Record<string, string>,
): Record<string, string> {
  return {
    ...process.env,
    ...(configEnvs || {}),
    ...(convEnvs || {}),
  };
}

/**
 * 获取指定会话的合并环境变量（便捷方法）
 */
export function getMergedEnvs(dc: DingClaude, conversationId: string): Record<string, string> {
  const convCfg = dc.getConversationConfig(conversationId);
  return mergeEnvs(dc.config.envs, convCfg?.envs);
}
