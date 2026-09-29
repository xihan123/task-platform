# 参与贡献

欢迎提交问题和改进。开始前请阅读 [AGENTS.md](AGENTS.md)：项目只有 `USER` 和 `ADMIN` 两种角色，管理员是唯一接取者。请围绕现有任务闭环提交小范围改动。

## 提交改动

1. 先描述要解决的问题；修复缺陷时附上复现步骤。
2. 修改 API 时同步检查 DTO、前端调用和测试；修改数据库时同步检查迁移、sqlc 查询与生成文件。
3. 提交前运行下面的检查，并在合并请求中说明验证结果及尚未运行的项目。

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm --filter @task-platform/web build
pnpm --filter @task-platform/web test:browser
```

浏览器测试首次运行需要安装 Chromium：`pnpm --filter @task-platform/web exec playwright install chromium`。

Go 集成测试会清空名为 `task_platform_go_test` 的测试库。请使用独立数据库和 Redis DB，确认地址后再运行：

```powershell
$env:TEST_DATABASE_URL = 'postgresql://task_platform:task_platform_dev@127.0.0.1:5432/task_platform_go_test'
$env:TEST_REDIS_URL = 'redis://127.0.0.1:6379/14'
go -C apps/api test -race ./...
```

在 Unix Shell 中，将两个环境变量加在 `go -C apps/api test -race ./...` 命令前即可。测试环境和生产环境不得共用数据库。

修改 `apps/api/internal/db/queries.sql` 或数据库迁移后，在 `apps/api` 目录设置 `CGO_ENABLED=0`，运行 `go run github.com/sqlc-dev/sqlc/cmd/sqlc@v1.31.1 generate`，并提交更新后的生成文件。
