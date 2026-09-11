# Plan 110: 桌面版侧栏底部账号脚部——登录身份 + 账号菜单 + 更新就绪时齿轮换「更新」

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat c202a0d..HEAD -- proto/coflux/v1/client.proto apps/server/src/hub.ts apps/server/src/store.ts apps/server/src/config.ts apps/server/src/infra/database/schema-migrations.ts packages/protocol/src/index.ts packages/client/src/store.ts apps/desktop/src/shared/desktop-bridge.ts apps/desktop/src/shared/ipc.ts apps/desktop/src/preload/index.ts apps/desktop/src/main/ipc.ts apps/desktop/src/main/index.ts apps/desktop/src/main/updater.ts apps/desktop/src/main/update-state.ts apps/desktop/src/renderer/config.ts apps/desktop/src/renderer/components/workbench/sidebar.tsx apps/desktop/src/renderer/components/workbench/workbench.tsx apps/desktop/src/renderer/components/workbench/desktop-update.ts apps/desktop/src/renderer/components/workbench/branch-menu.tsx tests/src/password.test.mjs`

## Status

- Priority: P2
- Effort: M
- Risk: MED（跨 proto 三端生成产物 + server + client + 桌面四层；行为面小）
- Depends on: none（基于 main `c202a0d`，已含 109；桌面当前版本 0.1.5）
- Category: feature
- Execution: subagent（宿主通用子 agent，`model: opus`；出发检查 2026-09-11 在 dev:explore 记录：全自动推进、不再确认；push / PR / 合 main / 发版仍需用户明确要求）
- Planned at: `c202a0d`, 2026-09-11

## Requirement

桌面版（`apps/desktop`，Electron 44 + React 19 渲染层）的侧栏只有「项目」「设备」两段
（`apps/desktop/src/renderer/components/workbench/sidebar.tsx:225-232` 骨架：顶部拖拽带 → 一个 `flex-1` 滚动区），
没有任何账号信息，也没有登出入口——`@coflux/client` 的 `logout()`（`packages/client/src/store.ts:816`）在桌面渲染层
无人调用；「检查更新…」「服务器地址…」只藏在原生应用菜单里（`apps/desktop/src/main/menu.ts:35-37`）。
electron-updater 已经在后台工作：启动 15s 后与每 4 小时检查、发现即下载、退出时自动安装、下次启动即新版
（`apps/desktop/src/main/updater.ts:14-16, 47-48`），但用户在 app 里看不到「新版本已就绪」，只能等下次退出。
用户要求参考 Cursor 左下角：头像 + 两行文字 + 尾部齿轮；有更新时齿轮换成更新按钮鼓励更新。

一个硬事实决定了本 plan 要动协议：渲染层现在**不知道自己是谁**。`AuthOk` 只回 `account_id / client_token / ice_servers`
（`proto/coflux/v1/client.proto:197-204`），密码登录后 username 只在内存里过一手就丢，用 token 冷启动时更是一无所知；
服务端用户模型也只有 `email`（`apps/server/src/store.ts:114-119`；local 模式是 env 用户名 `apps/server/src/config.ts:110`），
没有昵称、头像、套餐。

完成后：登录进入工作台即看到自己的登录身份与所连服务器；账号级动作（检查更新 / 服务器地址 / 登出）有一个明确的
入口；更新下载完成后侧栏出现强调色「更新」按钮，点一下就重启进新版；不点，退出再开也是新版（既有行为，零改动）。

### 产品结论（探索阶段已确认，勿再问）

```
├──────────────────────────────┤
│ (W)  wsq@example.com    [⚙] │   默认：齿轮
│      api.coflux.dev          │
└──────────────────────────────┘
│ (W)  wsq@example.com  [↑更新]│   更新已下载：齿轮换成强调色「更新」
```

1. **位置与结构**：侧栏底部固定一行，在滚动区之外、不随项目/设备列表滚动；左起首字母头像（无照片；Astryx `Avatar` 按
   `name` 出 initials，email 取 `@` 前部分）→ 第一行登录身份（password 模式 = email；local 模式 = 用户名）→ 第二行
   服务器 host（从渲染层 `SERVER_URL` 取 host，如 `api.coflux.dev`）→ 尾部按钮。身份未知（旧 server 不回字段、离线
   冷启动且缓存里没有）时第一行显示「已登录」占位，头像走 Astryx 默认人形图标，不得空白。
2. **菜单**：整行与齿轮打开**同一个**下拉菜单，三项：「检查更新」（文案随更新状态变，见决策「纯函数映射」）、
   「服务器地址…」（复用主进程既有原生对话框）、分隔线、「登出」（直接回登录页，不二次确认）。
3. **更新按钮**：只有 `DesktopUpdateState.status === "downloaded"` 时尾部齿轮换成强调色「更新」按钮（Tooltip：
   「v0.1.6 已下载，点击重启并更新」之类），点击 = `bridge.installUpdate()`（重启装新版）。`checking / available /
   downloading / not-available / error` 都保持齿轮、脚部静默；细节只在菜单项文案里。更新按钮出现时整行仍能打开菜单。
4. **后台更新行为零改动**：检查时机、autoDownload、autoInstallOnAppQuit 都不碰；脚部挂载**不**触发检查。
5. **非目标**：设置页、头像/资料编辑、套餐/计费、应用内切换服务器、改检查频率、Windows/Linux、原生菜单增删项。
6. **验收（用户可观察）**：登录后脚部显示 email + host；三个菜单项可用；登出回登录页；发布新 `desktop-v*` 后 ≤4h
   （或重启后）齿轮变「更新」，点击后进入新版本；不点、退出再开也是新版；断线横幅显示时脚部仍完整可见。
   UI 走查按惯例由用户在真机人工做，Claude 不跑 Playwright / 不启动 app 走查。

## Decisions & tradeoffs

- **登录身份来自协议，不在本地猜**：`AuthOk` 增一个 `optional string` 字段承载「登录身份显示串」；server 在认证成功、
  发 `authOk` 时填：password 模式 = 该 token 绑定用户的 `users.email`（token 路径经 `userIdForClientToken` 取
  userId 再按 id 读 user；密码路径 `checkCredentials` 已返回 userId），local 模式 = `config.username`；查不到用户
  （`user_id` 为 NULL 的旧 token、用户已删）就**不设字段**，绝不因此拒绝认证。字段是 optional 以便区分「旧 server
  没回」与「空串」。Rejected: 桌面把登录名与 token 一起存 safeStorage——token 冷启动无法确认 token 属于谁、local
  模式没有 email、违背「协议是单一真相源」。Rejected: 新增独立的「用户资料」消息——多一条消息多一个时序，握手里带
  一个字段就够。Based on: `proto/coflux/v1/client.proto:197-204`；`apps/server/src/hub.ts:3280-3344`（clientAuth
  两条路径与 `authOk` 发送）、`:3350-3372`（`checkCredentials` 返回 `userId`）；`apps/server/src/store.ts:435-438`
  （`userIdForClientToken`）、`:377-386`（`getUserByEmail` / `claimUser`，后者 FOR UPDATE 须在事务内，**没有**普通按
  id 读取，需新增）；`apps/server/src/config.ts:110`（`COFLUX_USERNAME` 默认 `admin`）；
  `apps/server/src/infra/database/schema-migrations.ts:176-181`（users 表只有 id/email/password_hash/created_at）。
- **不动控制面协议版本**：optional 字段是非破坏改动，`CONTROL_PROTOCOL_VERSION` 与 server 最低版本都不变，
  `buf breaking` 必须放行。web/mobile（冻结）/iOS 忽略新字段即可。Rejected: 顺手 +1——会让所有在线桌面版被踢到
  「需要更新」页，正是 plan 105 要避免的。Based on: `packages/protocol/src/index.ts:47`；`plans/105-desktop-protocol-admission.md`。
- **三端生成产物一起重生成并提交**：在 `proto/` 目录跑 `buf generate`，TS（`packages/protocol/src/gen`）、Rust
  （`crates/protocol/src/gen`）、Swift（`packages/swift-client/Sources/CofluxProtocol/Generated`）三份产物都进提交；
  CI 校验三处零 diff。Rejected: 手改生成文件——CI 直接红。Based on: `proto/buf.gen.yaml`；`.github/workflows/ci.yml:109-118`。
- **client store 加登录身份字段，并随离线目录缓存落盘**：`CofluxState` 新增一个字符串字段（命名执行者定），
  `authOk` 分支写入（字段缺失按空串），`logout` 与 `authError` 清空；`OfflineCatalog` 也带上它，`hydrateOfflineCatalog`
  时一并恢复，`parseOfflineCatalog` 对缺该字段的旧缓存按空串兼容、**`OFFLINE_CATALOG_VERSION` 保持 1**。Rejected:
  只放内存——离线冷启动（plan 103 的一等场景）脚部会空白。Rejected: 缓存版本 +1——会把每个用户的缓存无故作废一次。
  Based on: `packages/client/src/store.ts:181-215`（`OfflineCatalog` / `parseOfflineCatalog`）、`:304-330`（持久化只在
  `controlAuthenticated` 期间）、`:346-370`（装载）、`:561-575`（authOk）、`:577-590`（authError）、`:816-835`（logout）。
- **脚部是 `<aside>` 内滚动 section 之外的固定尾行**：结构为 拖拽带 → `flex-1` 滚动区 → 脚部；脚部不声明拖拽区。
  Rejected: 放进滚动区末尾——项目多时要滚到底才看得到。Based on: `sidebar.tsx:225-232`。
- **菜单用 Astryx 现成组件，整行与齿轮共用一个菜单实例**：`DropdownMenu`（`branch-menu.tsx:39-48` 已有 compound 用法；
  trigger 是 Button，`children` 可覆盖可见内容）或 `Popover`（`children` 为触发器，须含 button）二选一，执行者定；
  **不手写**浮层定位 / 点击外部关闭逻辑；**不**只靠右键 `ContextMenu` 作为唯一入口。样式走 Astryx token 化 Tailwind
  类（`bg-sidebar`、`text-muted-foreground`、`hover:bg-accent` 等既有用法），不写裸 hex/px。Based on:
  `apps/desktop/.claude/CLAUDE.md`（Astryx 规则）；`sidebar.tsx:3-4, 235-245`（ContextMenu / Tooltip / 按钮样式先例）。
- **更新状态 → 脚部展示的映射是纯函数 + `node --test`**：仿 `resolveOutdatedPrompt`；输入 `DesktopUpdateState`
  （加当前 app 版本），输出 尾部按钮种类（`gear | install`）与「检查更新」菜单项（文案 / 是否禁用 / 动作 `check | install`）。
  语义固定（文案可微调）：`idle` → 「检查更新」可点、check；`checking` → 「正在检查更新…」禁用；`available` →
  「正在下载 vX…」禁用；`downloading` → 「正在下载 vX（n%）…」禁用；`downloaded` → 「重启并更新 vX」可点、install，
  且尾部按钮为 `install`；`not-available` → 「已是最新版本 v当前」可点、check；`error` → 「检查更新失败，重试」可点、
  check（错误原因放 title/副文案）。**只有 `downloaded` 产生 `install` 尾部按钮**。Rejected: 在 JSX 里散落
  `switch`——无法单测，与既有 `desktop-update.ts` 的做法不一致。Based on:
  `apps/desktop/src/renderer/components/workbench/desktop-update.ts:15-45`、`desktop-update.test.ts`；
  `apps/desktop/src/shared/desktop-bridge.ts:10-20`（状态类型）。
- **「服务器地址…」经桥接调主进程既有对话框**：`DesktopBridge` 加一个无参、fire-and-forget 方法，`shared/ipc.ts`
  加通道，preload 用 `ipcRenderer.send` 实现，`main/ipc.ts` 照 `checkForUpdates` 的 trusted-sender 校验模式注册，
  `main/index.ts` 接到已有的 `showServerInfo(serverUrl)`。桥接面仍不暴露 Node / fs / shell / 设置文件路径。Rejected:
  渲染层自己弹一个说明对话框——settings.json 路径与「打开设置文件」动作只有主进程有。Rejected: 顺手把「检查更新」
  也从原生菜单删掉——非目标。Based on: `apps/desktop/src/main/index.ts:69-86`（`showServerInfo`）、`:178`（菜单接线）；
  `apps/desktop/src/main/ipc.ts:47-53`；`apps/desktop/src/preload/index.ts:40-45`；`apps/desktop/src/shared/ipc.ts`；
  `apps/desktop/src/shared/desktop-bridge.ts:1-8`（文件只能有类型）。
- **登出直接调 `client.logout()`，不二次确认**：它已清 token / 离线缓存 / 状态并置 `need-login`，Workbench 随即
  切登录表单。Rejected: 确认对话框——登出可逆（重新登录即可），Cursor 也不确认。Based on: `packages/client/src/store.ts:816-835, 982`。
- **更新状态订阅抽成一个共用 hook**：`DesktopOutdated` 与脚部都需要「挂载时 `getUpdateState()` 拉一次 + `onUpdateState`
  订阅 + 卸载退订」，抽成一个 hook 两处复用；`DesktopOutdated` 挂载时触发检查的行为保留在它自己那里，**脚部不触发检查**。
  Rejected: 复制一份订阅逻辑——两份 disposed 守卫迟早分叉。Rejected: 脚部挂载也 `checkForUpdates()`——与启动 15s
  定时器重复，每次登录/登出都打一次更新源。Based on: `apps/desktop/src/renderer/components/workbench/workbench.tsx:129-165`；
  `apps/desktop/src/main/updater.ts:14-16, 67-68`。
- **断线横幅显示时脚部必须完整可见**（decided while planning）：根容器 `h-screen overflow-hidden` 在横幅出现时加
  `pt-7`，而侧栏 `<aside>` 自己也是 `h-screen`，底部 28px 会被裁掉——今天没人察觉是因为侧栏底部只有 `pb-3` 空白，
  脚部一放上去就会被切。侧栏高度改为跟随父容器（`h-full` / `min-h-0` 一类，执行者定），不得改动横幅本身。Based on:
  `workbench.tsx:589-593`（根容器）、`:721-728`（横幅）；`sidebar.tsx:226`（`h-screen`）。
- **不 bump 桌面版本、不发版**：`apps/desktop/package.json` 的 `version` 与 tag 是用户发版时的事（`docs/RELEASING.md:203`）。
  Based on: `docs/RELEASING.md:199-212`。

## Direction

四个里程碑有依赖链（M2 用 M1 的生成类型；M4 用 M2 的 store 字段与 M3 的桥接方法；M3 与 M1/M2 无关），且 M3+M4 共享
`shared/desktop-bridge.ts`，**按一个工作包执行，不拆**。执行者对着 live code 设计，下列只是结果契约。

### Milestone 1: 协议与 server —— `authOk` 带登录身份

`AuthOk` 有新的 optional 字段；三端生成产物已重生成并提交；server 按决策填字段（password 模式 email / local 模式
`config.username` / 查不到不设），认证失败路径与准入路径零变化；黑盒 `tests/src/password.test.mjs` 新增断言：密码登录与
token 重连两条路径的 `authOk` 都带该用户的 email（小写归一后的值）。
Validation: `cd proto && buf lint && buf breaking --against "../.git#ref=c202a0d,subdir=proto"` → exit 0；
`cd proto && buf generate` 后 `git status --porcelain -- packages/protocol/src/gen crates/protocol/src/gen packages/swift-client/Sources/CofluxProtocol/Generated`（仓库根目录）→ 输出为空（生成产物已提交）；
`node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` → exit 0；`cargo test -p coflux-protocol` → exit 0。

### Milestone 2: client store —— 身份字段进状态与离线缓存

`CofluxState` 有身份字段；authOk 写入、logout / authError 清空；离线缓存写入与装载都带它，旧格式缓存仍可装载；
`packages/client/src/store-offline.test.ts` 覆盖「缓存带身份 → 冷启动装载后可读」与「旧缓存无该字段 → 空串、不作废」。
Validation: `node --import tsx --test packages/client/src/*.test.ts` → exit 0（基线 66 项，只增不减）。

### Milestone 3: 桌面桥接 —— 渲染层可唤起「服务器地址…」对话框

`DesktopBridge` 新方法 → preload → IPC（trusted-sender 校验）→ 主进程既有 `showServerInfo`；`apps/desktop/README.md`
与 `shared/desktop-bridge.ts` 头注释的桥接能力清单同步。
Validation: `pnpm -C apps/desktop typecheck` → exit 0；`pnpm -C apps/desktop test` → exit 0。

### Milestone 4: 侧栏脚部 —— 身份行 + 账号菜单 + 更新按钮

按产品结论实现脚部（新组件文件，执行者定名）、纯函数映射 + 测试、共用更新状态 hook（`DesktopOutdated` 改用之）、
侧栏高度跟随父容器。开发版下 `checkForUpdates` 会立即得到 `error: 开发版不检查更新`，菜单项照映射显示即可，
不在 updater 里加分支。
Validation: `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test && pnpm -C apps/desktop build` → exit 0
（单测基线 71 项，只增不减）。

## Landmines

- **更新状态住在主进程，渲染层挂载必须先拉一次**：`updater.ts` 只在状态变化时广播（`:42-55`），登录页期间就已到达的
  `downloaded` 不会再推；`DesktopOutdated` 用 `getUpdateState()` 补拉（`workbench.tsx:133-139`），脚部同样必须。
- **`downloaded` 是粘性终态**（`apps/desktop/src/main/update-state.ts:19-20`）：周期复查的 `checking / not-available /
  progress` 不会把它退回去，脚部的「更新」按钮因此稳定；别为了「重新检查」去改这条规则。
- **开发版 `checkForUpdates` 直接派发 error「开发版不检查更新」**（`updater.ts:57-60`）：dev 里点菜单项会看到失败文案，
  是预期；`electron-updater` 对未打包应用本来就不发事件。
- **断线横幅裁切**：见决策；`workbench.tsx:591-592` 的 `pt-7` + `sidebar.tsx:226` 的 `h-screen`。
- **server 侧身份查询不能变成新的拒绝路径**：`hub.ts:3280-3344` 里 `reject()` 的每个分支都关连接；身份查询失败（抛错
  / 查空）只能落到「不设字段」。`store.claimUser`（`store.ts:383`）是 `FOR UPDATE` 且必须在 `transaction()` 内，
  不要拿它做普通读取。
- **自动更新链路在真机从未被观察到**：本机 `~/Applications/Coflux.app` 是 7 月的 Safari 网页 app（bundle id
  `com.apple.Safari.WebApp.*`），Electron 版只从未签名 `pnpm pack` 产物跑过，`~/Library/Application Support/Coflux`
  与 `~/Library/Logs/Coflux` 都不存在。执行者与验证者都无法在本地造出 `downloaded` 态——脚部逻辑靠纯函数测试与
  pack 冒烟；真正的端到端验收是用户：先装签名版 desktop-v0.1.5，本 plan 合入并发下一版后观察齿轮变「更新」。
- **更新源有缓存与网络前提**：`raw.githubusercontent.com` 上的 `latest-mac.yml` 有几分钟缓存（`docs/RELEASING.md:183`），
  国内直连不稳；不在本 plan 范围，验收时别把「几分钟没变」当 bug。
- **Origin 字符串 `https://desktop.coflux.dev` 绝不能动**（`apps/desktop/src/main/origin.ts`、README「Origin」段）：
  它是 loopback grant 绑定的一部分。本 plan 不碰握手层。
- **黑盒测试环境**：`pnpm -C tests test` 需要本机 Docker（OrbStack，`orb start`）上的 PG 5432；装了 coflux 的本机上
  `agent-activity` 的 presence/hook 用例必假红且可能卡住整套——跑目标文件（`cd tests && node --import tsx --test
  src/password.test.mjs`）判断本 plan，全量红先看是不是那三条。
- **`buf generate` 要在 `proto/` 目录跑**：`buf.gen.yaml` 的 `out` 全是 `../` 相对路径；Swift 产物目录也在 CI 校验
  清单里，三处都要提交。
- **`shared/desktop-bridge.ts` 只能有类型、preload 是 sandbox CommonJS**（`desktop-bridge.ts:1-8`、
  `preload/index.ts:6-7`）：新桥接方法的实现只能是 `ipcRenderer.send/invoke`。
- **Astryx 组件形态**：`DropdownMenu` 的 trigger 是 Button（`label` 必填，`children` 覆盖可见内容）；`Popover` 的
  `children` 必须含 `<button>` 或 `role="button"`；`Tooltip` 是 `display:contents` 包裹（plan 108 核过）。整行作触发器
  时注意不要嵌套 button（可访问性与 React 警告）。
- **新 worktree 无依赖**：`dev:execute-plan` 预检时在 worktree 根 `pnpm install --frozen-lockfile`；Rust 目标目录
  也是空的，`cargo test -p coflux-protocol` 首次会编译一阵。会话在 worktree 里时 Bash 守卫会拦 `git -C ..`、`$(git …)`
  等复合写法，拆成单条从仓库根跑。

## Scope

In scope:
- `proto/coflux/v1/client.proto`；`packages/protocol/src/gen/**`、`crates/protocol/src/gen/**`、
  `packages/swift-client/Sources/CofluxProtocol/Generated/**`（生成产物）
- `apps/server/src/hub.ts`、`apps/server/src/store.ts`
- `packages/client/src/store.ts`、`packages/client/src/index.ts`（若需导出）、`packages/client/src/store-offline.test.ts`
- `apps/desktop/src/shared/desktop-bridge.ts`、`apps/desktop/src/shared/ipc.ts`、`apps/desktop/src/preload/index.ts`、
  `apps/desktop/src/main/ipc.ts`、`apps/desktop/src/main/index.ts`
- `apps/desktop/src/renderer/components/workbench/sidebar.tsx`、`workbench.tsx`、新增的脚部组件 / 纯函数 / hook 及其
  `*.test.ts`（执行者定名，放同目录）
- `apps/desktop/README.md`
- `tests/src/password.test.mjs`
- `plans/110-desktop-account-footer.md`、`plans/README.md`

Out of scope:
- `apps/desktop/src/main/updater.ts`、`update-state.ts`、`menu.ts`、`origin.ts`、`window.ts` — 更新行为、原生菜单、
  Origin、窗口都不变
- `apps/desktop/package.json` 的 `version`、`electron-builder.yml`、`.github/workflows/desktop-release.yml` — 发版是用户的事
- `packages/protocol/src/index.ts` 的 `CONTROL_PROTOCOL_VERSION`、`apps/server/src/config.ts` — 协议版本与配置不变
- `apps/server/src/auth-pages.ts`、`oauth.ts`、页面登录流 — 只有 WS `authOk` 带身份
- `apps/ios`、`packages/swift-client` 的手写源码、daemon（`crates/`除生成产物） — 忽略新字段即可
- 登录页 `AuthShell`、终端主区、通知/角标 — 无关

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| proto lint + breaking | `cd proto && buf lint && buf breaking --against "../.git#ref=c202a0d,subdir=proto"` | exit 0 |
| 生成产物零 diff | `cd proto && buf generate`，回仓库根 `git status --porcelain -- packages/protocol/src/gen crates/protocol/src/gen packages/swift-client/Sources/CofluxProtocol/Generated` | 输出为空（产物已提交后再跑） |
| server 类型检查 | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| client 单测 | `node --import tsx --test packages/client/src/*.test.ts` | exit 0（基线 66 项，只增） |
| desktop 类型检查 + 单测 + 构建 | `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test && pnpm -C apps/desktop build` | exit 0（单测基线 71 项，只增） |
| Rust 生成产物可编译 | `cargo test -p coflux-protocol` | exit 0 |
| Git diff 格式 | `git diff --check c202a0d HEAD` | exit 0 |
| 黑盒 password 流 (acceptance) | `cd tests && node --import tsx --test src/password.test.mjs`（需 Docker PG 5432） | exit 0，含新增 email 断言 |
| 黑盒全量 (acceptance) | `pnpm -C tests test` | exit 0（presence 三条在本机假红可豁免，见地雷） |
| Swift 生成产物 (acceptance) | `swift test --package-path packages/swift-client --parallel` | exit 0 |
| pack 冒烟 (acceptance) | `pnpm -C apps/desktop pack` | exit 0，`dist/mac-arm64/Coflux.app` 可启动 |
| 真机走查 (acceptance，人工) | 用户启动桌面版：登录后脚部显示 email + host；整行/齿轮打开菜单；三项可用；登出回登录页；断线横幅下脚部完整；装签名版后发下一版观察齿轮变「更新」并点击进新版 | 用户确认 |

仓库无 lint 脚本。

## Done criteria

- [ ] All listed commands pass.
- [ ] `AuthOk` 新 optional 字段：password 模式回 email、local 模式回 `config.username`、查不到不设；认证失败与准入路径零变化；`buf breaking` 放行；三端生成产物已提交且零 diff。
- [ ] client store 有身份字段，authOk 写入、logout/authError 清空，离线缓存带它且旧缓存仍可装载、`OFFLINE_CATALOG_VERSION` 仍为 1。
- [ ] 侧栏底部固定脚部：头像 + 身份（空时「已登录」占位）+ 服务器 host + 尾部按钮；整行与齿轮打开同一菜单；三项动作分别接到 `checkForUpdates` / 新桥接方法 / `client.logout()`。
- [ ] 只有 `downloaded` 时尾部为强调色「更新」按钮且点击调 `installUpdate()`；其余状态为齿轮；映射是带 `node --test` 的纯函数。
- [ ] 脚部挂载不触发 `checkForUpdates`；`updater.ts` / `update-state.ts` / `menu.ts` 零改动。
- [ ] 断线横幅显示时脚部完整可见（侧栏高度跟随父容器）。
- [ ] 新桥接方法经 trusted-sender 校验的 IPC 到达主进程既有 `showServerInfo`；桥接面未新增任何 Node/fs/shell 能力；README 与桥接头注释已同步。
- [ ] Required tests exist and assert meaningful behavior（纯函数映射、store 离线缓存、黑盒 email 断言）。
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds（尤其：`AuthOk` 已有身份字段、`updater.ts` 不再 autoDownload /
  autoInstallOnAppQuit、`showServerInfo` 已不存在、`OfflineCatalog` 版本已不是 1）。
- `buf breaking` 对新字段报错（说明字段加法不对，不得改协议版本硬过）。
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.
- A named assumption is false。

## Maintenance notes

- 以后往脚部菜单加项，动作都应经桥接或 client 走既有能力，桥接面不能因此长出通用能力（Node/fs/shell）。
- 若日后 server 有昵称/头像，扩 `AuthOk` 的相邻字段即可，渲染层只认「身份显示串」；不要把 email 当主键用。
- `downloaded` 粘性 + 脚部按钮的组合意味着：用户长期不重启时按钮一直在，这是设计（鼓励更新）；若嫌烦，改文案不改状态机。
- 自动更新真机验证仍是空白：合入本 plan 并发版后，是第一次能在 app 内观察到更新就绪的机会，请用户记录结果（记忆
  `desktop-auto-update-unverified` 待更新）。
