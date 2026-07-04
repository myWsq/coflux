# Plan 003: Tailscale 式设备授权登记流（默认免 enroll-key）

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Validate each milestone before continuing.
> Stop on any STOP condition. When complete, update this plan in
> `plans/README.md`.
>
> Drift check: `git diff --stat 61d2129..HEAD -- apps/server/src apps/web/src crates/worker/src crates/protocol packages/cli tests/src`

## Status

- Priority: P1
- Effort: L
- Risk: MED
- Depends on: plans/001-multi-account-supabase-auth.md（账号/登录态）
- Category: feature
- Execution: subagent sonnet（实现）；验证/审查由主会话亲自做
- Planned at: `61d2129`, 2026-07-04

## Requirement

新机器接入 coflux 目前必须先去 web 控制台生成 enrollmentKey，再
`cofluxd up --enroll-key <KEY>`。目标改为 Tailscale 式默认流程：

1. `cofluxd up`（零参数）→ daemon 以未登记状态连上 server；
2. server 生成一次性授权请求，daemon/CLI 打印授权链接；
3. 用户在浏览器打开链接、用已有 web 登录态确认"授权此设备"；
4. server 把设备绑进**发起授权的账号**、通过 daemon 已开的 WS 下发
   deviceToken，daemon 无需重启完成登记；
5. CLI 侧全程给出清晰反馈（等待授权 → 登记成功）。

同时（用户明确要求）：`cofluxd up` 的交互流程**不再询问服务器地址**。

正确性判据（区分正解与貌似正确的错解）：
- 授权完成后 daemon 与 enrollmentKey 流登记的设备**无任何状态差异**
  （同一 devices 表、同一 deviceToken 机制、重连/resync 行为一致）。
- 授权码只能兑现一次、TTL 内有效、daemon 断线即作废；对
  `device.authorize` 的暴力尝试有限速。
- 旧流程 `--enroll-key` 完全不变，现有黑盒测试（lifecycle/security/
  supabase 中涉及 enroll 的用例）不改语义地继续通过。

## Decisions & tradeoffs

- **授权通路复用 daemon 已开的 WS，不引入第二条 HTTP 轮询通路**：
  daemon 匿名连接后发新消息 `daemon.enrollRequest{name,host,platform}`，
  server 回 `daemon.authorizePending{url,expiresAt}`，授权完成后复用现有
  `daemon.enrolled{daemonId,deviceToken}`（hub.ts:249 已有）。
  Rejected: OAuth device-code 直连 Supabase —— 设备簿的权威是 coflux
  server 而非身份层，第二通路徒增熵。
  Based on: `apps/server/src/hub.ts:229-249`（未认证门控 + enrolled 下发）。
- **pending 授权存 hub 内存，不落 Postgres**：授权本质是连接期状态——
  daemon WS 断了 deviceToken 就没有活连接可推，码理应随连接作废；重连
  由 worker 重发 enrollRequest 拿新码。单实例部署（OPEN_QUESTIONS B7
  已定）无共享状态需求。Rejected: pending 表落库 —— 只会累积垃圾行，
  且与"断线即失效"语义矛盾。
  Based on: `docs/OPEN_QUESTIONS.md` B7（单实例）；`apps/server/src/hub.ts`
  的 conn 对象即连接期状态载体。
- **授权 URL 的秘密是长随机 token（≥128 bit，`genToken` 风格），不做
  人读短码**：链接是点击/扫码交付的，无人工抄码场景，短码只会缩小爆破
  空间。URL 形如 `<webUrl>/authorize/<token>`。Rejected: 6-8 位短码 +
  输入框 —— Tailscale 也是纯链接。
  Based on: `apps/server/src/hub.ts:429`（genToken 已有）。
- **授权语义 = 谁登录谁认领**：`device.authorize{token}` 把设备绑到发起
  确认的 client 当前 accountId。token 不预绑账号；持有链接者用自己的
  账号授权即归自己（与 Tailscale 一致）。安全边界靠 token 不可猜 +
  一次性 + TTL + 限速，而非账号预绑。
  Based on: `apps/server/src/hub.ts:430`（client.accountId 语义）。
- **CLI 与 daemon 通过 `~/.coflux` 文件交接，CLI 保持零协议**：worker
  收到 authorizePending 后写 `pending-auth.json`（url/expiresAt），登记
  成功照旧写凭证文件并删除 pending 文件；`cofluxd up` 起服务后轮询这
  两个文件：出现 pending → 打印授权链接并等待；凭证出现 → 打印成功。
  Rejected: CLI 直连 server（要重复实现协议+认证）；tail 日志解析（脆弱）。
  Based on: `crates/worker/src/creds.rs`（凭证文件已有此模式）；
  `packages/cli/cofluxd.mjs` 零依赖现状。
- **`cofluxd up` 不再交互询问服务器地址**（用户拍板 2026-07-04）：优先
  级 `--server` > settings.json 保存值 > `DEFAULT_SERVER`；**保存值继续
  生效**，但与默认值不同时打印醒目提示（防 staging 残留静默错连再现）。
  Rejected: 强制默认覆盖保存值 —— 用户选择保留自托管体验。
  Based on: `packages/cli/cofluxd.mjs:173,186`（现有优先级与交互问答）。
- **授权页不引入路由库**：web 现为无路由单页，用 `location.pathname`
  解析 `/authorize/<token>` 分支渲染，复用现有登录表单与 WS 客户端。
  Rejected: react-router —— 一个页面不值一个依赖。
  Based on: `apps/web/src/App.tsx`（443 行单组件、无 Route）。
- **授权 URL 由 server 生成下发，daemon 只透传**：server config 新增
  `webUrl`（env `COFLUX_WEB_URL`，样式同 `daemonUrl`），selfhost 天然
  正确。Rejected: CLI/daemon 拼 URL —— 它们不知道 web 部署在哪。
  Based on: `apps/server/src/config.ts:56-57`（daemonUrl 先例）。
- **wire 兼容**：旧 daemon 不发 `daemon.enrollRequest`，行为不变；新
  daemon 对旧 server 无兼容义务（server 是我们控制的中心服务，先于
  daemon 二进制发布部署）。`hub.ts:229` 的未认证门控白名单需加入
  `daemon.enrollRequest`。协议类型加在 `crates/protocol` 与 TS 侧对应
  定义，遵循现有 serde 风格。
  Based on: `apps/server/src/hub.ts:229`。
- **enrollmentKey 流保留原样**（无头/脚本场景），`--enroll-key` 时完全
  走现有代码路径，不与新流程混流。
  Based on: `crates/worker/src/main.rs:310`、`apps/server/src/hub.ts:232-249`。

## Direction

### Milestone 1: server 支持设备授权流

未认证 daemon 可发 `daemon.enrollRequest` 获得 pending 授权（内存态，
TTL 10 分钟，随连接销毁）；已登录 client 发 `device.authorize{token}`
后设备落库、daemon 收到 `daemon.enrolled`。token 一次性；无效/过期/
已用返回明确错误；`device.authorize` 失败有限速（如每连接指数退避或
计数熔断）。web 未动之前可用黑盒 harness 的裸 WS 客户端验证。
Validation: 新增黑盒用例（见 M4）中 server 侧路径先以最小脚本自测通过；
`pnpm -C tests test` 存量全绿。

### Milestone 2: worker 未登记状态机 + 文件交接

无凭证且未配置 enroll key 时，worker 连接后进入等待授权态：发
enrollRequest、把 url/expiresAt 写 `~/.coflux/pending-auth.json`、保持
连接等待 enrolled（不退出，见 Landmines）；enrolled 后删 pending 文件、
凭证照旧持久化、直接进入已认证运行态。断线重连重发 enrollRequest。
配置了 enroll key 时行为与现在完全一致。
Validation: `cargo build -p coflux-worker` 过；M4 黑盒用例覆盖。

### Milestone 3: CLI 默认流程

`cofluxd up` 零参数可用：不再询问服务器地址（保存值生效 + 非默认时
醒目提示）；不再要求 enroll key；起服务后轮询 `~/.coflux`，打印授权
链接与登记成功提示（含超时提示重试）。`--enroll-key` / `--server`
仍可用且语义不变。`cofluxd status` 能区分"等待授权"状态。
Validation: `node -c packages/cli/cofluxd.mjs`；人工走一遍本地
`--bin-dir` 流程（主会话验证时执行）。

### Milestone 4: web 授权页 + 黑盒测试

`/authorize/<token>` 页：未登录先登录；显示设备 name/host/platform；
确认后展示成功/失败。黑盒新增用例（web 层逻辑由裸 WS 客户端模拟，
与现有测试风格一致）：
1. 授权成功端到端：匿名 daemon → 拿链接 token → client 授权 → daemon
   enrolled、能跑任务；
2. token 过期被拒（TTL 可 env 注入缩短）；
3. token 只能用一次（二次授权失败）；
4. daemon 断线后旧 token 作废；
5. 存量 enrollmentKey 流回归不变。
Validation: `pnpm -C tests test` 全绿（本机需
`COFLUX_TEST_PG_URL=postgres://postgres:postgres@127.0.0.1:54322/postgres`）。

## Landmines

- `apps/server/src/hub.ts:229`：未认证消息门控是白名单式（enroll/auth
  之外直接 return）——新消息不进白名单会被静默丢弃，症状是"daemon 无
  响应"而非报错。
- `crates/worker/src/main.rs:365-371`：authError 且 need_enroll 时
  worker 直接 exit；等待授权态绝不能复用这条路径，否则 supervisor 会
  按崩溃循环处理（manager.rs 有崩溃预算/回滚逻辑，见 plan 002 后的
  安全加固）。
- `packages/cli/cofluxd.mjs:173`：`v.server || s.serverUrl || DEFAULT_SERVER`
  的优先级要保留；交互问答删除的是 186 行附近的 question，不是优先级。
- web `App.tsx` 是无路由单文件组件；授权页分支要在 WS 连接建立逻辑
  之前判定，避免授权页也去起终端相关的连接副作用。
- 黑盒 harness 起 server 需 Postgres；本机 5432 是 supavisor（会报
  tenant 错误），必须用 54322 直连口（CI 里 service 映射 5432 无此问题）。
- `tests/src/lifecycle.test.mjs`、`security.test.mjs`、`supabase.test.mjs`
  含 enroll 相关既有用例，改协议时先读它们的断言再动手。
- 协议是 Rust（crates/protocol，serde tag 风格）与 TS 双定义，两边都要
  加且字段命名要一致（对照现有消息的 camelCase 惯例）。

## Scope

In scope:
- `apps/server/src/`（hub/config/store/transport 相关改动）
- `crates/protocol/`、`crates/worker/src/`
- `packages/cli/cofluxd.mjs`（版本 bump 到 0.2.0，发布走 npm-publish.yml）
- `apps/web/src/`
- `tests/src/`（新增用例 + 受影响用例修订）
- `docs/auth-design.md`（登记一节补授权流）、`plans/README.md`

Out of scope:
- `crates/supervisor/`——授权流全在 worker/server/CLI/web 层，supervisor
  不感知登记。
- enrollmentKey 的生成/管理 UI 改动——旧流程原样保留。
- 二维码渲染——链接优先，二维码是后续锦上添花。
- 生产部署与发版动作本身（实施完由主会话按 RELEASING.md 走）。

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Typecheck | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit && node_modules/.bin/tsc -b apps/web/tsconfig.json` | exit 0 |
| Rust 测试 | `cargo test -p coflux-protocol` | exit 0 |
| Rust 构建 | `cargo build -p coflux-supervisor -p coflux-worker` | exit 0 |
| 黑盒全量 | `COFLUX_TEST_PG_URL=postgres://postgres:postgres@127.0.0.1:54322/postgres pnpm -C tests test` | exit 0，新增用例在列 |
| CLI 语法 | `node -c packages/cli/cofluxd.mjs` | exit 0 |

## Done criteria

- [ ] All listed commands pass.
- [ ] 零参数 `cofluxd up` 走通授权链接登记（本地 `--bin-dir` 人工验证）。
- [ ] 授权码一次性 / TTL / 断线作废 / 限速均有黑盒断言。
- [ ] `--enroll-key` 流与存量测试语义不变。
- [ ] `cofluxd up` 不再询问服务器地址；保存值生效且非默认时有醒目提示。
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files（尤其发现 supervisor 必须感知
  登记态时——停下来重议）。
- A validation command fails twice after one reasonable fix.
- 发现现有黑盒用例必须改断言语义才能通过（说明破坏了旧流程）。

## Maintenance notes

- pending 授权是纯内存态：server 重启丢 pending 属预期（daemon 重连自动
  重新走流程），排障时别当 bug 修。
- 将来若走多实例（B7 重开），pending 授权要外置（Redis/Postgres），届时
  重新评估"断线作废"语义。
- cofluxd 0.2.0 起零参数即完整流程；README/包描述同步更新。
