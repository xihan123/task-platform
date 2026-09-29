## 改动内容

<!-- 解决了什么问题，为什么这样改。关联的 issue：Fixes # -->

## 验证

<!-- 实际运行了哪些检查，结果如何。未运行的项目请明确说明。 -->

- [ ] `pnpm format:check`
- [ ] `pnpm lint`
- [ ] `pnpm typecheck`
- [ ] `pnpm test`
- [ ] `pnpm --filter @task-platform/web build`

## 检查清单

- [ ] 未新增 [AGENTS.md](AGENTS.md) 第 1.3 节列出的范围外功能
- [ ] 改动 API 时同步更新了 DTO、前端调用和测试
- [ ] 改动数据库时同步更新了迁移、sqlc 查询和生成文件
- [ ] 改动 Socket 事件时同步更新了服务端事件、客户端监听和类型
- [ ] 未提交真实 `.env`、API Key、密码或用户数据
