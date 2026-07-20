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
| 009 | [协议真相源 Protobuf 化 + wire 迁移 protobuf binary](009-protobuf-idl-wire-migration.md) | DONE (0acba35) | none |
| 010 | [Web 客户端 SolidJS 全量重写（能力等价 + Cursor 风 UI + 性能地板）](010-web-rewrite-solidjs.md) | DONE (8f05046) | none |
| 011 | [Web 客户端迁移 React 19 + Compiler（生态回归，能力与性能地板等价）](011-web-react19-compiler-migration.md) | DONE (7a1e583) | none |
| 012 | [导入项目两步向导（设备 → 远程文件树选文件夹）](012-import-project-wizard.md) | DONE | none |
| 013 | [web 端 xterm.js 5.5 → 6.0 升级（与 server 侧 headless 6.0 对齐）](013-web-xterm6-upgrade.md) | DONE (00918d8) | none |
| 014 | [web 终端剪贴板贴图 —— 上传远程 worktree 并注入路径给 agent](014-terminal-image-paste.md) | DONE (dc32dc0) | none |
| 015 | [web 端全局快捷键（Cmd+Ctrl 前缀）+ 帮助面板](015-web-hotkeys.md) | DONE (7f63985) | none |
| 016 | [终端 cell 度量漂移后自动 refit，消除溢出滚动条](016-terminal-refit-on-metric-drift.md) | DONE (9e1cac9) | none |
| 017 | [daemon worker 自动热更新编排层](017-auto-update-orchestration.md) | DONE (2729930) | none |
| 018 | [设备重命名（别名）—— server/web 展示 + daemon 本地 settings.json 同步](018-device-rename.md) | TODO | none |

执行顺序：001 → 002 → 003 → 004 → {005 ∥ 006}（plan group，scope 不相交可并行）→ 007 → 008 → 009 → 010 → 011 → 012 → 013 → 014 → 015 → 016 → 017 → 018。
