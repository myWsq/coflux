# Plan 033: 构建版本号贯通 + 失配踢出（终结旧 bundle 僵尸客户端）

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 16aad36..HEAD -- proto/coflux/v1/client.proto packages/protocol packages/client apps/server/src/hub.ts apps/server/src/config.ts apps/web/vite.config.ts apps/web/src/pages/MainPage.tsx apps/mobile/vite.config.ts apps/mobile/src/App.tsx tests/src`

## Status

- Priority: P1
- Effort: M
- Risk: MED
- Depends on: none
- Category: feature
- Execution: subagent sonnet
- Planned at: `16aad36`, 2026-07-23

## Requirement

生产事故（2026-07-23）：部署了终端接管修复后，一个仍开着 app.coflux.dev 旧 bundle 的
Mac Safari 页面继续用修复前的攻击性 attach 逻辑，把每个新建终端在 ~300ms 内抢走
holder（抓包实证），另有两个旧页面以 ~100ms 周期死循环 `taskStart`。根因是**部署新版
无法让存量旧客户端退场**：web 无 Service Worker、无版本检测，旧页面断线重连后带着旧
代码无限期存活。

完成后成立的事实：

1. 生产 server 能识别每条 client 连接的构建版本；版本失配或缺失的客户端在认证阶段即
   被拒之门外，**不可能进入 subscribed 状态**（因此不可能发 `taskStart` 抢占）。
2. 跑新代码的客户端在版本失配时自动 `location.reload()` 一次拿到新 bundle，token 不
   丢、无感恢复；reload 后仍失配则停止重连并显示可读提示，不进入循环。
3. 跑旧代码（无版本号）的客户端被 `authError` 踢回登录页并停止自动重连（现有
   `authError` 语义：`shouldRetry=false`）。
4. 本机开发（dev server / vite dev / 黑盒测试）不受任何影响：server 未配置 build id
   时完全跳过检查。

判别正误的关键：这是**认证阶段的准入控制**，不是连上后的通知机制。一个"连上后广播
版本、客户端自觉 reload"的实现是错的——旧客户端根本不认识新消息，唯一对它生效的杠杆
是它已理解的 `authError`。

## Decisions & tradeoffs

- **版本真相源**（2026-07-23 用户反馈修订）：git short SHA 作为唯一 build id，web/mobile
  经 vite `define` 构建时嵌入（生产构建自动取 `git rev-parse --short HEAD`，vite dev 固
  定为 `"dev"`），并且构建同时把同一值写入 `dist/build-id.txt`。server 的允许版本集合 =
  `COFLUX_BUILD_ID`（显式覆盖，黑盒测试用）∪ `COFLUX_BUILD_ID_FILE`（逗号分隔的产物文件
  路径，生产一次性配置指向 web/mobile 两个 dist）在**每次认证时现读**的内容；集合为空 =
  检查关闭。产物文件自举保证"server 期望的版本"与"caddy 正在服务的版本"由同一文件恒
  等——重建不必重启、重启不必重建，不存在手动对齐。Rejected: 仅环境变量手填 SHA — 每次
  部署人工对齐，易错（用户明确否决）；Rejected: 运行时 exec git — git 状态当运行时依赖，
  且 pull 后未重建时 git SHA 与 dist 实际内容脱节，恰好制造它要防的失配。
  Based on: server 经 systemd 跑 `tsx src/index.ts`（apps/server/package.json `start`）；
  config 已有环境变量惯例（apps/server/src/config.ts:43-50）。
- **检查门控在 server 侧环境变量**：`COFLUX_BUILD_ID` 未设置 → 完全跳过版本检查；设置
  后，client 上报 `"dev"` 也放行（本机 dev 前端连生产调试的口子）。Rejected: 无条件强
  制 — 黑盒测试的模拟客户端不发版本号，强制检查会打爆全部现存测试（tests/src/harness.mjs
  等直接构造 ClientAuth）。
- **协议载体**：`ClientAuth` 增加 `optional string client_version = 5`（proto/coflux/v1/
  client.proto:14-19 现有 1-4 号字段，只增不改号）。经 `buf generate` 重新生成三端产物。
  Rejected: WS URL query 参数 — 绕开协议但把版本语义藏进传输层，且 server 的 upgrade
  处理需要额外穿透。
- **失配（有版本但不等）的踢出路径**：server 发新消息 `clientOutdated`（ServerToClient
  oneof 取下一个空闲字段号）后关闭连接，**不发 `authError`** `(decided while planning)`。
  原方向是 clientOutdated + authError 连发；规划时发现 `authError` 会清本地 token
  （packages/client/src/store.ts:168-176），连发意味着**每次部署所有在线用户都被迫重新
  登录**，违背"无感升级"的目标。新客户端收到 `clientOutdated` 即 reload，token 保留。
- **缺失版本（旧 bundle）的踢出路径**：server 发 `authError`（文案含"客户端版本已过
  期，请刷新页面"）后关闭连接。旧客户端对未知消息 `default: break` 忽略
  （store.ts:322），`authError` 是唯一能让它停止重连（`shouldRetry=false`）并退回登录
  页的既有杠杆。用户已确认接受旧设备刷新后重新登录一次的迁移成本。
  Based on: store.ts:168-176（authError 处理）、store.ts:322（未知消息忽略）。
- **客户端 reload 防循环 + 专用状态页**（2026-07-23 用户反馈修订）：收到 `clientOutdated`
  后，以 sessionStorage 记录"已为版本 X reload 过"；首次 → `location.reload()`；重复触
  发（如 index.html 被缓存导致 reload 后仍是旧 bundle）→ 不再 reload，停止自动重连，
  store 进入独立的 `authState: "outdated"`，web/mobile 各渲染**专门的"版本已更新"页面**
  （说明文案 + 刷新按钮），不复用登录页/authError 展示面，token 全程不清。Rejected:
  复用 loginError/auth-failed 展示 — 版本更新不是认证失败，混用语义误导用户（用户明确
  否决）；Rejected: 无守卫直接 reload — 缓存旧 index.html 时变成 reload 风暴。
  mobile 属冻结范围，此页面是共享层 store 状态变更的最小配套 UI，按冻结约定做最简实现。
- **注入路径走共享层**：`createCofluxClient` options 增加 `buildId`，随所有三种
  ClientAuth 变体上报（packages/client/src/connection.ts:29-35 buildAuthPayload）。
  web/mobile 各自在创建 client 处传入（apps/web/src/pages/MainPage.tsx:12、
  apps/mobile/src/App.tsx:22）。mobile 属冻结范围，仅允许这类共享层适配性小改。
  Based on: AGENTS.md:11（mobile 冻结约定）。
- **顺手修幽灵连接**：`connect()` 换新 socket 前先 close 旧 socket
  （packages/client/src/connection.ts:68-75 现状：直接覆盖 `socket = ws`，旧连接在
  server 侧继续存活为只收不发的幽灵）。本次排查中该缺陷放大了僵尸连接数量，修复成本
  一行级，并入本 plan。

## Direction

协议 → server 准入 → 客户端响应 → 测试，四个里程碑。执行顺序即依赖顺序。

### Milestone 1: 版本号贯通（协议 + 注入）

`ClientAuth` 带上 `client_version`；`buf generate` 重新生成（TS + Rust prost + Swift
三份产物一起提交，`clean: true` 会整目录重写，勿手改 gen 产物）；web/mobile 生产构建
自动嵌入 git short SHA、vite dev 嵌入 `"dev"`；`createCofluxClient` 接收 buildId 并随
认证上报。
Validation: `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` exit 0；
`node_modules/.bin/tsc -b apps/web/tsconfig.json` exit 0；
`node_modules/.bin/tsc -b apps/mobile/tsconfig.json` exit 0；
`cargo build -p coflux-supervisor -p coflux-worker` 零警告。

### Milestone 2: server 准入检查

config 增加 `COFLUX_BUILD_ID`（可选）；hub 的 clientAuth 处理在**认证成功判定之后、
subscribed 之前**比对版本：env 未设或 client 为 `"dev"` → 放行；失配 → 发
`clientOutdated`（新 ServerToClient 消息）后关连接；缺失 → 发 `authError`（文案含
"客户端版本已过期，请刷新页面"）后关连接。发送与 close 的顺序须保证消息可达（先 send
后 close，必要时依赖 ws 库的发送缓冲语义，由 M4 黑盒测试证实可达性）。
Validation: `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` exit 0。

### Milestone 3: 客户端响应

store 处理 `clientOutdated`：sessionStorage 一次性守卫 → reload；守卫命中 → 停止重连
（复用 `shouldRetry` 机制）并经 loginError/authState 展示"版本已更新，请强制刷新"类
提示，token 不清。同里程碑内修 `connect()` 幽灵 socket（换新前 close 旧连接，注意与
`socket !== ws` 守卫的既有语义不冲突）。
Validation: `node_modules/.bin/tsc -b apps/web/tsconfig.json` exit 0。

### Milestone 4: 黑盒测试

在 tests/ 新增用例：spawn 一个设了 `COFLUX_BUILD_ID` 的 server 实例，断言三种行为——
带匹配版本的客户端正常走到 authOk+订阅；带错误版本的客户端收到 `clientOutdated` 且随
后连接被关闭；不带版本的客户端收到 `authError`。现存测试（server 不设该 env）保持全
绿即证明门控生效。
Validation: 由验证者运行 `pnpm -C tests test`（见 Commands，acceptance）。

## Landmines

- 黑盒测试的模拟客户端直接构造 `ClientAuth` 且不带版本号（tests/src/harness.mjs、
  lifecycle/security/supabase.test.mjs）——版本检查若不受 `COFLUX_BUILD_ID` 门控，现存
  测试全部被踢挂。
- `authError` 处理会清 localStorage token 并置 `shouldRetry=false`
  （packages/client/src/store.ts:168-176）——失配路径发它就等于每次部署全员强制重登，
  只有"缺失版本"路径才允许发。
- `buf generate`（proto/buf.gen.yaml）`clean: true`，一次生成同时重写
  packages/protocol/src/gen、crates/protocol/src/gen、proto/gen/swift 三处——三处产物
  变更需一并提交；Rust 侧 regen 后 `cargo build` 必须保持零警告（仓库纪律，
  AGENTS.md 改动纪律节）。
- server 生产以 `tsx src/index.ts` 直跑源码（无构建产物），build id 不能走任何
  bundler 注入手段，只能环境变量。
- 旧客户端对未知 ServerToClient case 的行为是静默忽略（store.ts:322 `default:
  break`）——设计对旧客户端的任何指望都必须落在它已理解的消息上。
- proto 字段只增号不改号：`ClientAuth` 1-4 已被占用（proto/coflux/v1/client.proto:14-19），
  旧客户端不发 5 号字段正是"缺失版本"的检测信号本身。

## Scope

In scope:

- `proto/coflux/v1/client.proto`
- `packages/protocol/src/gen/**`、`crates/protocol/src/gen/**`、`proto/gen/swift/**`（regen 产物）
- `packages/client/src/store.ts`、`packages/client/src/connection.ts`、`packages/client/src/index.ts`（如需导出）
- `apps/server/src/hub.ts`、`apps/server/src/config.ts`
- `apps/web/vite.config.ts`、`apps/web/src/pages/MainPage.tsx`（或 client 创建处的最小接线）、web 认证门控组件与新增"版本已更新"状态页（最小实现）
- `apps/mobile/vite.config.ts`、`apps/mobile/src/App.tsx`（buildId 传参接线 + "版本已更新"状态页最小实现）
- `tests/src/**`（新增版本准入用例）
- `plans/README.md`

Out of scope:

- server 对 `taskStart` 的速率限制 — 独立缺陷，另行立案
- 空工作区首终端启动竞争（apps/web/src/components/workbench/workspace-terminal.tsx:182-190
  非 RUNNING 分支无 activeRef 门控）— 独立缺陷，另行立案
- 生产部署操作本身（systemd env 加 `COFLUX_BUILD_ID`、caddy 对 app/m 的 index.html 加
  `Cache-Control: no-cache`、重启 server）— 服务器侧手工步骤，见 Maintenance notes，
  由验收阶段人工执行
- daemon（crates/{supervisor,worker}）行为 — 版本检查只针对 /client 通道，daemon 有
  自己的升级编排（plan 015）

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| server 类型检查 | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| web 类型检查 | `node_modules/.bin/tsc -b apps/web/tsconfig.json` | exit 0 |
| mobile 类型检查 | `node_modules/.bin/tsc -b apps/mobile/tsconfig.json` | exit 0 |
| Rust 构建（零警告） | `cargo build -p coflux-supervisor -p coflux-worker` | exit 0，无 warning |
| 黑盒测试 (acceptance) | `COFLUX_TEST_PG_URL="postgres://postgres:postgres@127.0.0.1:54322/postgres" pnpm -C tests test` | exit 0 |

黑盒测试需本机 selfhost Supabase 的 54322 直连口（5432 是 supavisor 池化口会报
tenant 错，见 AGENTS.md 本地开发环境的坑）。

## Done criteria

- [ ] All listed commands pass.
- [ ] 设 `COFLUX_BUILD_ID` 的 server：匹配版本正常订阅；失配收 `clientOutdated` 后被断开且 token 不被清；无版本收 `authError` 后停止重连。
- [ ] 不设 `COFLUX_BUILD_ID` 的 server 行为与改动前完全一致（现存黑盒测试零修改全绿）。
- [ ] web/mobile 生产构建产物内嵌 git short SHA；vite dev 下为 `"dev"`。
- [ ] `connect()` 重连不再泄漏旧 socket。
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.
- `buf generate` 产物导致 Rust 侧无法零警告构建且无法在 gen 边界内解决。

## Maintenance notes

- **生产部署清单（本 plan 合入后的首次上线，人工执行）**：
  1. prod-jp 拉代码构建 web/mobile（构建自动产出 `dist/build-id.txt`）；
  2. `/etc/coflux/server.env` 一次性加
     `COFLUX_BUILD_ID_FILE=/opt/coflux/apps/web/dist/build-id.txt,/opt/coflux/apps/mobile/dist/build-id.txt`
     ——此后每次部署无需再碰版本号（server 每次认证现读文件，产物自举）；
  3. Caddyfile 给 app.coflux.dev / m.coflux.dev 的 index.html 响应加 `Cache-Control: no-cache`（防 reload 拿到缓存旧壳造成守卫兜底路径频繁触发）；
  4. 重启 coflux-server；预期：所有旧 bundle 页面在下次重连时被踢到登录页，从此丧失抢占能力。
- 日常部署只需 拉代码 + 构建（server 代码变了才需重启）；版本集合随 build-id.txt 即时生效。
- 版本检查是精确匹配而非最小版本比较：回滚部署同样触发客户端 reload，语义自洽。
