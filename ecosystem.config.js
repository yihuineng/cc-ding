module.exports = {
  apps: [
    {
      name: 'a2a-hub',
      script: '/Users/yhn/.cc-ding/dingdogxnjayoivrvihp/cd661615ed2de82670c1b36d91704678/cc-ding/dist/bin/a2a-hub.js',
      env: {
        // 固定端口 3002，避免重启后端口变更
        A2A_HUB_PORT: '3002',
        // API Key 用于 Hub 认证
        A2A_HUB_API_KEY: '30e29602e1fd51cbf4129c069c807f58',
        // 心跳超时时间（秒）
        A2A_HUB_HEARTBEAT: '60',
      },
    },
  ],
};
