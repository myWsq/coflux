# Plans

| # | Plan | Status | Depends on |
|---|------|--------|------------|
| 001 | [多账号 SaaS 化 —— Supabase Auth 身份层 + 换票登录](001-multi-account-supabase-auth.md) | DONE (fb40f19) | none |
| 002 | [存储层迁移 —— node:sqlite → Supabase Postgres](002-postgres-storage.md) | DONE (dc18068) | 001 |
| 003 | [Tailscale 式设备授权登记流（默认免 enroll-key）](003-device-authorization-enroll.md) | DONE (fde8b80) | 001 |
| 004 | [端口转发协议契约（帧 + 控制面 + UDS）](004-port-forward-protocol.md) | DONE (5e5ae97) | none |
| 005 | [daemon 侧：PTY 进程树端口探测 + TCP 隧道桥](005-port-forward-daemon.md) | DONE (55201ba) | 004 |
| 006 | [server/web 侧：Host 路由反代 + 登录门禁 + UI](006-port-forward-server-web.md) | DONE (e026f8f) | 004 |
| 007 | [端口转发集成验收：黑盒 e2e + 文档](007-port-forward-integration.md) | DONE (be109eb) | 005, 006 |
| 008 | [Web 端交互重塑 —— 工作区多终端 Tab（Cursor 式任务台）](008-web-workspace-tabs-revamp.md) | DONE (0e593e8) | none |

执行顺序：001 → 002 → 003 → 004 → {005 ∥ 006}（plan group，scope 不相交可并行）→ 007 → 008。
