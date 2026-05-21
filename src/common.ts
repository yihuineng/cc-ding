import { ProjUtil, fileUtil } from 'utils-ok';
import path from 'path';
import assert from 'assert';
import fs from 'fs';

export function loadEnv() {
  if (fs.existsSync(`${process.env.HOME}/.cc-ding/.env`)) {
    require('dotenv')
      .config({ path: `${process.env.HOME}/.cc-ding/.env` });
  }
  require('dotenv').config();
}

/**
 * 仅本工程内部使用
 */
export const projUtil = (() => {
  let ins: ProjUtil;
  return () => {
    if (!ins) {
      ins = new ProjUtil(path.resolve(__dirname, '../'));
    }
    return ins;
  };
})();

export const helper = {
  /**
   * 从缓存文件读取cookies
   * @param cookieFile
   */
  getCookiesByFile(cookieFile: string): any[] {
    assert(fs.existsSync(cookieFile), `cookie缓存文件不存在: ${cookieFile}`);
    const cookieInfo: {
      cookies: any[];
      date: string;
    } = fileUtil.getJSON(cookieFile);
    return cookieInfo.cookies;
  },
};

export const utils = {
  /**
   * 给文件添加后缀
   * @param filePath
   * @param suffix
   */
  addSuffixToFile(filePath: string, suffix: string) {
    const dir = path.dirname(filePath);              // 目录
    const ext = path.extname(filePath);              // 原始扩展名
    const base = path.basename(filePath, ext);       // 纯文件名（无 ext）
    const newName = `${base}${suffix}${ext}`;        // 新文件名
    const newPath = path.join(dir, newName);
    fs.renameSync(filePath, newPath);
  },
};

