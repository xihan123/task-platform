# Task Platform

一个发布者提交任务、由唯一管理员接取和完成的协作平台。任务先经过 AI 审核，管理员接取后与发布者讨论；管理员提出完成请求，发布者确认后任务结束。

## 功能

- 任务发布、审核、接取与完成确认
- 发布者和管理员之间的任务讨论，消息先保存到 PostgreSQL，再通过 WebSocket 推送
- 站内通知、可选的邮件通知，以及仅任务参与者可下载的附件
- 管理员工作台和 AI 审核资源配置

前端使用 Next.js、React 和 TypeScript，构建后可作为静态站点部署。API 使用 Go、PostgreSQL 和 Redis。

## 快速开始

需要 Node.js 24、pnpm 11+、Go 1.27 和 Docker。

```sh
git clone https://git.xihan.website/xihan123/Task-Platform.git
cd Task-Platform
pnpm install
```

安装会在缺失时从示例生成根目录和 `apps/web` 的 `.env`。在根目录 `.env` 中填写 `ADMIN_EMAIL` 和 `ADMIN_PASSWORD`（12–128
个字符），然后运行：

```sh
docker compose up -d
pnpm db:migrate
pnpm db:seed
pnpm dev
```

打开 `http://127.0.0.1:3000`。API 默认使用 `http://127.0.0.1:4000`。管理员使用刚设置的邮箱和密码登录。

## 配置前提

- 默认未启用邮件。注册和密码重置依赖邮箱验证码；要使用这些功能，先按 [`.env.example`](.env.example) 配置 SMTP、
  `EMAIL_ENABLED=true` 和独立的 `MAIL_ENCRYPTION_KEY`。关闭邮件不会绕过验证。
- 默认启用 AI 审核，但需要先设置 `AI_KEY_ENCRYPTION_KEY`，再由管理员页面或 `pnpm ai:configure` 添加服务地址、模型和密钥。没有可用资源时，任务保持
  `PENDING_REVIEW`，审核记录为 `ERROR`，可由管理员处理。
- 加密密钥均为 32 字节随机值的 Base64 编码；邮件与 AI 使用不同密钥。生成示例：
  `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`。不要提交真实 `.env` 或密钥。

其余变量及默认值见根目录和 `apps/api`、`apps/web` 下的 `.env.example`。

## 部署

Web 是 Next.js 静态导出，产物在 `apps/web/out`；API 是 Go 服务，可独立运行或使用 Docker 镜像。生产环境还需要
PostgreSQL、Redis、HTTPS 反向代理和一个持久化的私有附件目录。

```sh
pnpm install --frozen-lockfile
pnpm --filter @task-platform/web build
docker build --target api -t task-platform-api:go .
```

将 `apps/web/out` 的内容部署到站点根目录，并按 [`deploy/nginx.conf.example`](deploy/nginx.conf.example) 代理 `/api/`，其中包括
`/api/tasks/{id}/events` 的 WebSocket 升级。任务详情使用 `/tasks/detail?id=UUID` 和 `/admin/tasks/detail?id=UUID`。

生产变量从 [`.env.example`](.env.example) 准备，至少检查：

- `DATABASE_URL`、`REDIS_URL`：指向生产实例；PostgreSQL 保存业务数据，Redis 保存会话、队列和临时状态。
- `WEB_ORIGINS`：填写实际 HTTPS 站点地址；只有可信任单层代理时才设置 `TRUST_PROXY_HOPS=1`。
- `ATTACHMENT_STORAGE_DIR`：绝对路径，持久化且不可作为静态文件公开。运行用户需要写权限。
- `AI_KEY_ENCRYPTION_KEY`：32 字节随机值的 Base64 编码。配置审核资源后保持稳定；缺少可用资源时任务不会自动通过。
- 邮件启用时还需 SMTP 参数、`MAIL_FROM`、HTTPS `APP_URL` 和独立的 `MAIL_ENCRYPTION_KEY`。生产环境要求 SMTP 凭据与 TLS。

可用 `docker compose --profile app up --build -d` 启动 API、PostgreSQL 和 Redis。Compose 的 API 使用 `API_DATABASE_URL`
指定容器内数据库地址；密码包含 URL 保留字符时需先编码。静态站点需单独部署。Go 服务启动时会执行数据库迁移，部署前请备份数据库。

`/api/health/live` 检查进程，`/api/health` 检查 PostgreSQL 和 Redis。上线时分别检查两者，再验证登录、任务创建和 WebSocket
连接。

## 安全

请勿在公开 issue、讨论或合并请求中发布漏洞细节、密钥或用户数据。请通过 [维护者主页](https://github.com/xihan123)
提供的私密联系方式报告；若没有可用的私密渠道，可先开一个不含技术细节的 issue 请求联系方法。

报告中请说明受影响版本、复现步骤和实际影响。维护者确认后再协调公开披露。

## 验证

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm --filter @task-platform/web build
```

`pnpm test` 中的 Go 集成测试需要独立测试数据库和
Redis；没有设置测试地址时会跳过。浏览器测试和完整的本地检查步骤见 [贡献指南](CONTRIBUTING.md)。

## 许可证

Copyright (C) 2026 xihan123。项目采用 [GPL-3.0-only](LICENSE) 许可证。
