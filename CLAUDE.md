# cc-ding

## 端口约定

| 服务 | 默认端口 | 环境变量 | 说明 |
|------|----------|----------|------|
| Console | 8080 | - | Web 管理界面 |
| A2A Hub | 3002 | `A2A_HUB_PORT` | Agent-to-Agent 协调服务 |

## 开发规范

- 完成代码修改后，执行 `pnpm run build` 验证
- A2A Hub 默认端口为 3002，可通过 `A2A_HUB_PORT` 环境变量修改
