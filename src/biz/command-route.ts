/**
 * 命令路由注册表基础设施
 * 将「解析 + 处理」封装为路由条目，消息分发按注册顺序依次尝试匹配。
 * 新增命令只需在 cc-ding-cli 的路由表中追加一个 route() 条目。
 */

export interface ICommandRoute {
  /** 命令名（仅用于日志和调试） */
  name: string;
  /** 尝试匹配并处理，返回 true 表示已处理（停止后续路由） */
  tryHandle(): Promise<boolean>;
}

/**
 * 创建一个命令路由
 * @param name 命令名
 * @param match 解析函数：返回 null/undefined/false 表示不匹配，其他值作为解析结果传给 handle
 * @param handle 处理函数，接收 match 的解析结果
 */
export function route<T>(
  name: string,
  match: () => T | null | false | undefined,
  handle: (parsed: T) => Promise<void> | void,
): ICommandRoute {
  return {
    name,
    async tryHandle(): Promise<boolean> {
      const parsed = match();
      if (parsed === null || parsed === undefined || parsed === false) return false;
      await handle(parsed as T);
      return true;
    },
  };
}
