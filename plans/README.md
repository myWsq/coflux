# Plans

| # | Plan | Status | Depends on |
|---|------|--------|------------|
| 001 | [多账号 SaaS 化 —— Supabase Auth 身份层 + 换票登录](001-multi-account-supabase-auth.md) | DONE (fb40f19) | none |
| 002 | [存储层迁移 —— node:sqlite → Supabase Postgres](002-postgres-storage.md) | DONE (dc18068) | 001 |
| 003 | [Tailscale 式设备授权登记流（默认免 enroll-key）](003-device-authorization-enroll.md) | DONE (2bed822) | 001 |

执行顺序：001 → 002 → 003。
