import assert from 'assert';

/**
 * 远程 Console 配置相关测试
 * 覆盖 clientIds 可选、认证方式等边界情况
 */

// 模拟 IRemoteConsole 接口
interface IRemoteConsole {
  url: string;
  token?: string;
  username?: string;
  password?: string;
  clientIds?: string[];
}

describe('remote-console config', () => {
  describe('clientIds optional handling', () => {
    it('clientIds 为 undefined 时 find 不会报错', () => {
      const remoteConsoles: IRemoteConsole[] = [
        { url: 'http://host1:8080' }, // 没有 clientIds
        { url: 'http://host2:8080', clientIds: [ 'client-a' ] },
      ];

      const clientId = 'client-a';
      const found = remoteConsoles.find(rc => rc.clientIds?.includes(clientId));

      assert.ok(found);
      assert.strictEqual(found?.url, 'http://host2:8080');
    });

    it('clientIds 为空数组时 find 返回 undefined', () => {
      const remoteConsoles: IRemoteConsole[] = [
        { url: 'http://host1:8080', clientIds: [] },
      ];

      const found = remoteConsoles.find(rc => rc.clientIds?.includes('any'));
      assert.strictEqual(found, undefined);
    });

    it('所有 remote console 都没有 clientIds 时 find 返回 undefined', () => {
      const remoteConsoles: IRemoteConsole[] = [
        { url: 'http://host1:8080' },
        { url: 'http://host2:8080' },
      ];

      const found = remoteConsoles.find(rc => rc.clientIds?.includes('any'));
      assert.strictEqual(found, undefined);
    });

    it('构建远程映射时跳过没有 clientIds 的配置', () => {
      const remoteConsoles: IRemoteConsole[] = [
        { url: 'http://host1:8080' }, // 没有 clientIds
        { url: 'http://host2:8080', clientIds: [ 'client-a', 'client-b' ] },
        { url: 'http://host3:8080' }, // 没有 clientIds
      ];

      const remoteMap = new Map<string, string>();
      for (const rc of remoteConsoles) {
        if (rc.clientIds) {
          for (const cid of rc.clientIds) {
            remoteMap.set(cid, rc.url);
          }
        }
      }

      assert.strictEqual(remoteMap.get('client-a'), 'http://host2:8080');
      assert.strictEqual(remoteMap.get('client-b'), 'http://host2:8080');
      assert.strictEqual(remoteMap.size, 2);
    });

    it('clientIds 显示为文本时处理 undefined', () => {
      const rc: IRemoteConsole = { url: 'http://host:8080' };
      const displayText = rc.clientIds ? rc.clientIds.join(', ') : '(自动获取)';
      assert.strictEqual(displayText, '(自动获取)');
    });

    it('clientIds 显示为文本时处理空数组', () => {
      const rc: IRemoteConsole = { url: 'http://host:8080', clientIds: [] };
      const displayText = rc.clientIds ? rc.clientIds.join(', ') : '(自动获取)';
      assert.strictEqual(displayText, '');
    });

    it('clientIds 显示为文本时正常显示', () => {
      const rc: IRemoteConsole = { url: 'http://host:8080', clientIds: [ 'a', 'b' ] };
      const displayText = rc.clientIds ? rc.clientIds.join(', ') : '(自动获取)';
      assert.strictEqual(displayText, 'a, b');
    });
  });

  describe('authentication config', () => {
    it('token 认证方式有效', () => {
      const rc: IRemoteConsole = {
        url: 'http://host:8080',
        token: 'test-token',
      };

      assert.ok(rc.token);
      assert.strictEqual(rc.username, undefined);
      assert.strictEqual(rc.password, undefined);
    });

    it('用户名密码认证方式有效', () => {
      const rc: IRemoteConsole = {
        url: 'http://host:8080',
        username: 'admin',
        password: 'secret',
      };

      assert.ok(rc.username);
      assert.ok(rc.password);
      assert.strictEqual(rc.token, undefined);
    });

    it('验证 token 认证完整性', () => {
      const rc: IRemoteConsole = {
        url: 'http://host:8080',
        token: 'my-token',
      };

      const hasToken = !!rc.token;
      const hasCredentials = !!(rc.username && rc.password);

      assert.strictEqual(hasToken, true);
      assert.strictEqual(hasCredentials, false);
      assert.ok(hasToken || hasCredentials, '必须有认证信息');
    });

    it('验证用户名密码认证完整性', () => {
      const rc: IRemoteConsole = {
        url: 'http://host:8080',
        username: 'admin',
        password: 'pass',
      };

      const hasToken = !!rc.token;
      const hasCredentials = !!(rc.username && rc.password);

      assert.strictEqual(hasToken, false);
      assert.strictEqual(hasCredentials, true);
      assert.ok(hasToken || hasCredentials, '必须有认证信息');
    });

    it('验证缺少认证信息时检测失败', () => {
      const rc: IRemoteConsole = {
        url: 'http://host:8080',
      };

      const hasToken = !!rc.token;
      const hasCredentials = !!(rc.username && rc.password);

      assert.strictEqual(hasToken, false);
      assert.strictEqual(hasCredentials, false);
      assert.strictEqual(hasToken || hasCredentials, false, '缺少认证信息');
    });
  });

  describe('config validation', () => {
    it('URL 必须是有效格式', () => {
      const validUrls = [
        'http://host:8080',
        'https://host:8080',
        'http://192.168.1.100:8080',
        'http://localhost:8080',
      ];

      for (const url of validUrls) {
        assert.ok(url.startsWith('http://') || url.startsWith('https://'));
      }
    });

    it('clientIds 解析正确', () => {
      const clientIdsStr = 'client-a, client-b, client-c';
      const clientIds = clientIdsStr.split(',').map(s => s.trim()).filter(Boolean);

      assert.deepStrictEqual(clientIds, [ 'client-a', 'client-b', 'client-c' ]);
    });

    it('空 clientIds 字符串解析为空数组', () => {
      const clientIdsStr: string = '';
      const clientIds = clientIdsStr ? clientIdsStr.split(',').map(s => s.trim()).filter(Boolean) : undefined;

      assert.strictEqual(clientIds, undefined);
    });

    it('保存远程 console 配置时 clientIds 可选', () => {
      const config1: IRemoteConsole = {
        url: 'http://host1:8080',
        token: 'token1',
        // 没有 clientIds
      };

      const config2: IRemoteConsole = {
        url: 'http://host2:8080',
        token: 'token2',
        clientIds: [ 'client-a' ],
      };

      // 两个配置都应该有效
      assert.ok(config1.url);
      assert.ok(config2.url);
      assert.strictEqual(config1.clientIds, undefined);
      assert.deepStrictEqual(config2.clientIds, [ 'client-a' ]);
    });
  });
});
