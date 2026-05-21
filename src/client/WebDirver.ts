import { WebDriver } from 'utils-ok';
import { getCookieFile } from 'web2mcp';
import { helper } from '../common';

/**
 * 无头浏览器, 实现web fetch方式调用api
 */
export const getWebDriver = (() => {
  let driver: WebDriver;
  return async () => {
    if (!driver) {
      const { WEBAPI_DEBUG } = process.env;
      driver = new WebDriver({
        headless: !WEBAPI_DEBUG, // 调试时打开
      });
      await driver.init();
      // 尝试加载本地cookie
      const cookieFile = await getCookieFile();
      const cookies = helper.getCookiesByFile(cookieFile);
      if (cookies) {
        await driver.context.clearCookies();
        await driver.context.addCookies(cookies);
      }
    }
    return driver;
  };
})();

export const webDriverUtil = {
  /**
   * 从当前页面扫描可下载资源
   */
  async getAttachmentNames(): Promise<string[]> {
    const driver = await getWebDriver();
    const ATTACHMENT_EXTS = [ 'csv', 'xlsx', 'xls', 'doc', 'docx', 'pdf', 'zip', 'rar', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'txt', 'md', 'json', 'xml', 'yaml', 'yml', 'ppt', 'pptx' ];
    const extPattern = ATTACHMENT_EXTS.join('|');

    const items = await driver.page.evaluate((pattern: string) => {
      const seen = new Set<string>();
      const results: string[] = [];

      // 文件名校验
      const isValid = (name: string) => name.length < 100 && !name.includes('/') && !name.includes('\\') && !name.includes('：');

      // 遍历文本节点查找文件名
      const walker = document.createTreeWalker(document.querySelector('article') || document.body, NodeFilter.SHOW_TEXT);
      let node: any;
      while ((node = walker.nextNode())) {
        const text = node.textContent?.trim() || '';
        const match = text.match(new RegExp(`^(.+\\.(${pattern}))$`, 'i'));
        if (match && isValid(match[1]) && !seen.has(match[1])) {
          seen.add(match[1]);
          results.push(match[1]);
        }
      }
      return results;
    }, extPattern);
    if (!items.length) {
      console.error('页面中未发现可下载资源...');
    }
    return items;
  },
};
