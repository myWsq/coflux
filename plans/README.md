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
| 018 | [设备重命名（别名）—— server/web 展示 + daemon 本地 settings.json 同步](018-device-rename.md) | DONE (0379a55) | none |
| 019 | [终端 tab 端口转发展示 —— PlugZap icon + HoverCard 悬浮跳转](019-terminal-tab-port-hovercard.md) | DONE (db1fc87) | none |
| 020 | [从 Git remote 推导 project 名称](020-project-name-from-git-remote.md) | DONE (105bc70) | none |
| 021 | [Sidebar 拖拽调宽与本地记忆](021-resizable-sidebar.md) | DONE (a22bbd8) | none |
| 022 | [PWA 可安装（manifest + 图标，无 service worker）](022-pwa-installable.md) | DONE (85fa24f) | none |
| 023 | [web 终端拖拽小文件上传（drop 落 daemon 临时目录并注入路径）](023-terminal-file-drag-upload.md) | DONE (2a1636d) | none |
| 024 | [工作区 git diff 统计展示（+X −Y）](024-workspace-diff-stats.md) | DONE (ce70a4a) | none |
| 025 | [工作区「变更」tab + diff 查看视图](025-workspace-changes-diff-view.md) | DONE (a3046df) | none |
| 026 | [旁观客户端不再被动抢占终端控制权](026-passive-attach-containment.md) | DONE (b5814d4) | none |
| 027 | [侧边栏工作区行右端 hover 遮罩统一 + diff 数字固定行末](027-sidebar-diff-hover-mask.md) | DONE (a27a12e) | none |
| 028 | [macOS 完全磁盘访问权限（FDA）检测 + 引导流程](028-macos-fda-guide.md) | DONE (ba2b0de) | none |
| 029 | [导入向导浏览步默认隐藏点开头文件夹 + header 开关](029-import-wizard-hide-dotfolders.md) | DONE (4735839) | none |
| 030 | [web 简单移动端适配（手机可正常使用现有全部功能）](030-mobile-responsive-web.md) | WITHDRAWN（方向变更：移动端改为独立精简 app，不做桌面响应式适配） | none |
| 031 | [抽取 packages/client（协议 client + store 双端共享）](031-extract-client-package.md) | DONE (452daa0) | none |
| 032 | [apps/mobile 移动随身端（精简 Agent 指挥中心）](032-mobile-companion-app.md) | DONE (223ae02) | 031 |
| 033 | [构建版本号贯通 + 失配踢出（终结旧 bundle 僵尸客户端）](033-build-version-skew-kick.md) | DONE (87642ee) | none |
| 033 | [worker 连接韧性（半死连接自愈）+ 连接态可观测](033-worker-connection-resilience.md)（与上行撞号，两分支并行开发所致） | DONE (b8261fd) | none |
| 034 | [enrollKey 全链路删除——浏览器授权成为唯一登记路径](034-remove-enroll-key.md) | DONE (fc5db48) | 033 |
| 035 | [cofluxd 命令面重梳 + doctor 连通性自检](035-cofluxd-command-surface.md) | DONE (7f97423) | 034 |
| 036 | [本地优先 session/device 协议契约](036-local-first-session-device-contract.md) | DONE (0bd688f) | none |
| 037 | [supervisor 演进为本机 sessiond](037-supervisor-sessiond-authority.md) | DONE (201186c) | 036 |
| 038 | [worker loopback gateway + 双 transport](038-worker-local-gateway.md) | DONE (76a2aa1) | 036 |
| 039 | [server 收敛为控制面 + relay](039-server-control-plane-relay.md) | DONE (183faf6) | 036 |
| 040 | [web/client 真正本地优先的 DeviceTransport](040-web-local-first-device-transport.md) | DONE | 036, 042 |
| 041 | [本地优先架构集成、迁移与发布验收](041-local-first-integration.md) | TODO（自动化门 + Chrome 实机矩阵已过；Safari/Firefox 按 2026-07-25 决定不做，矩阵门收窄为 Chrome） | 037, 038, 039, 042, 040 |
| 042 | [Device PTY 输入累计 ACK 与连续 exactly-once 契约](042-device-input-ack-contract.md) | DONE (e235158) | 036 |
| 043 | [独立 relay 服务·第一片 —— crates/relay 二进制 + 按需拨号 rendezvous](043-standalone-relay-rendezvous.md) | DONE (74f3ba6) | none（前置 036-042 已 DONE；第二片=多节点就近，另立 plan） |
| 044 | [iOS app 第一片 —— apps/ios 工程骨架 + Swift 客户端层 + 登录跑通](044-ios-app-skeleton-client-login.md) | DONE（模拟器闭环已验收；真机生产验收待用户；第二片=SwiftTerm 终端交互，另立 plan） | none |
| 045 | [无 repo 终端 —— 选设备后在其 HOME 直接开终端](045-no-repo-home-terminal.md) | DONE（自动化门已过；UI 走查待用户人工验收） | none |
| 046 | [iOS 第二片 —— 任务详情页 + SwiftTerm 终端交互（relay-only Device 数据面）](046-ios-task-detail-terminal.md) | DONE（模拟器真拓扑闭环验收已过——启动/attach/回显/停止删除；真机生产验收与接管双端场景待用户） | 044 |
| 047 | [iOS 回归系统导航，启用 Liquid Glass](047-ios-liquid-glass-native-nav.md) | TODO | none |

执行顺序：001 → 002 → 003 → 004 → {005 ∥ 006}（plan group，scope 不相交可并行）→ 007 → 008 → 009 → 010 → 011 → 012 → 013 → 014 → 015 → 016 → 017 → 018 → 019 → 020 → 021 → 022 → 023 → 024 → 025 → 026 → 027 → 028 → 029 → 031 → 032 → {033-skew ∥ 033-conn} → 034 → 035 → 036 → {037 ∥ 038 ∥ 039}（本地优先 daemon/server 成员，已完成）→ 042（输入 ACK 串行契约）→ 040（web/client）→ 041（集成与发布验收）→ 043（独立 relay 第一片）→ 044（iOS 第一片，与 043 无依赖可并行）→ 045（无 repo 终端，无依赖）→ 046（iOS 第二片）→ 047（iOS 液态玻璃，无依赖）。（030 已撤回，未执行）
