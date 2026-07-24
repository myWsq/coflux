# Plan 034: enrollKey 全链路删除——浏览器授权成为唯一登记路径

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 98ae2c2..HEAD -- proto/ crates/protocol/ crates/worker/ apps/server/src/ packages/client/src/ packages/protocol/src/ apps/web/src/ packages/cli/cofluxd.mjs tests/src/`

## Status

- Priority: P2
- Effort: L
- Risk: MED
- Depends on: plans/033-worker-connection-resilience.md（DONE）
- Category: refactor
- Execution: subagent sonnet
- Planned at: `98ae2c2`, 2026-07-23

## Requirement

设备登记现有三条并存路径：classic enrollKey（`DaemonEnroll`）、浏览器授权
（`DaemonEnrollRequest`，plan 003，Tailscale 式）、以及 settings.json 里
`enrollKey: ""` 空串触发后者的兼容语义。浏览器授权已是唯一推荐路径（含
headless 设备——链接可在任何设备打开），enrollKey 只剩历史包袱：CLI 多一个
参数与交互问答、settings.json 因存密钥被迫 600、web 端一个发密钥对话框、
server 一张 `enrollment_keys` 表、协议两个 message、worker 一段三选一分支。
产品无存量自动化用户，现在删成本最低（用户拍板：彻底删除，2026-07-23）。

完成后为真：

1. 登记只有一条路径：无凭证的 daemon 连上 server 发 `DaemonEnrollRequest`，
   用户浏览器授权，server 推 `DaemonEnrolled`。
2. 协议、server、web、共享 client 包、worker、CLI、测试中不再存在
   enrollKey / enrollment key 的代码路径（文档仅保留历史设计记录）。
3. web「添加设备」入口仍在，内容变为安装引导（`npm i -g cofluxd && cofluxd up`
   + 浏览器授权说明），不再生成密钥。
4. 黑盒测试全量绿：harness 不再靠 `COFLUX_ENROLL_KEY` 静默登记，改为走
   真实授权流自动确认。

正确性分界：删除必须是全链路的——只删 CLI 参数而留着 server 表/协议分支是
相邻的错误解（那是 dev-explore 中已被否决的"CLI 退场，协议保留"方案）。

## Decisions & tradeoffs

- **协议删除方式：proto 真相源删 message + oneof 字段，field number 用
  `reserved` 占位，`cd proto && buf generate` 三侧 regen**。涉及
  `proto/coflux/v1/daemon.proto` 的 `DaemonEnroll`（:12-14）与 oneof 字段
  `daemon_enroll = 1`（:95）；`proto/coflux/v1/client.proto` 的
  `ClientCreateEnrollmentKey`（:27,:161）与 `EnrollmentKeyCreated`（:200-202,:283）。
  reserved 防止未来新消息复用旧 field number 与旧版本 daemon 冲突。
  Rejected: 只在应用层忽略、协议保留——违背"彻底删除"的拍板。
  Based on: `proto/buf.gen.yaml`（v2，`clean: true`，TS→`packages/protocol/src/gen`、
  Rust→`crates/protocol/src/gen`、Swift→`proto/gen/swift`）。
- **`DaemonAuthError.need_enroll` 字段保留**。其 `true` 语义（凭证失效→
  daemon 清凭证重新走授权）与 enrollKey 无关，仍是活路径；`false` 分支
  worker 侧 `exit(1)`（`crates/worker/src/main.rs:656-663`"enrollment key
  invalid"）——检查 server 侧所有 `DaemonAuthError` 发送点：若 `false` 仅剩
  enroll 场景则连带清理该发送点，但 worker 的 `false → exit(1)` 作为"不可
  恢复认证错误"的兜底行为保留（改日志文案即可）。
- **worker：登记逻辑三选一变二选一**。`credentials.json` 存在 → `DaemonAuth`；
  否则 → `DaemonEnrollRequest`。`Config.enroll_key`、settings 的
  `enroll_key` 字段（`crates/protocol/src/settings.rs:10`）、`pick` 的空串
  直通语义注释一并删除。Based on: 三选一逻辑在
  `crates/worker/src/main.rs:526-550`。
- **server：`enrollment_keys` 表的建表语句与三个方法全删，seed 一并删**。
  涉及 `apps/server/src/store.ts:117,299-319`、`hub.ts:297`（daemonEnroll
  分支）、`hub.ts:697-699`（clientCreateEnrollmentKey 分支）、
  `config.ts:50`（`COFLUX_ENROLL_KEY` secret）、
  `plugins/store.plugin.ts:35`（启动 upsert seed）。生产库中已存在的
  `enrollment_keys` 表不在代码里迁移删除——见 Maintenance notes。
- **web/共享 client：发密钥 UI 改为安装引导**。`packages/client/src/store.ts`
  的 `enrollCommand` 状态、`enrollmentKeyCreated` case、
  `createEnrollmentKey`/`clearEnrollmentCommand` API（:48,:98,:278-280,:363,:409-414,:446）
  删除；`apps/web` 的 `EnrollmentDialog`（`workbench/dialogs.tsx`）改为静态
  安装引导文案（`npm i -g cofluxd && cofluxd up` + "在浏览器打开 daemon
  打印的链接完成授权"），「添加设备」按钮保留（`workbench.tsx:243,320`）。
  Rejected: 移除入口——新用户仍需要"怎么加设备"的指引。
- **CLI：仅删 enrollKey 相关面**。`--enroll-key` 参数、settings 写入的
  `enrollKey` 字段、onboard 里的密钥问答、`waitForAuthorization` 的
  enrollKey 条件分支。命令面重梳（砍 onboard/reload、加 doctor）**不在
  本 plan**——那是 plan 035，避免一次改动面过大。settings.json 不再含密钥
  后 600 权限可放宽也可保留，执行者取舍（保留更省事，无害）。
- **harness 改造：startStack 走真实授权流自动确认**。daemon 不带
  `COFLUX_ENROLL_KEY` 启动 → 连上后发 enrollRequest → harness 用测试
  client（local 模式凭据）等 `daemonAuthorizePending`/读 pending-auth，从
  授权 URL 提取 token（`authorize.test.mjs:35` 已有 `tokenFromUrl` 手法）
  → 发 `device.authorize` → 等 daemon 上线。该流程做成 harness 内共享
  helper，所有经 `startStack` 的测试自动获益。`authorize.test.mjs` 里
  写 `enrollKey: ""` settings 的兼容性用例（:45,:184）随空串语义一起删改。
  Rejected: 直接往 DB 插 device / 伪造 credentials.json——违反测试黑盒
  哲学（AGENTS.md：只经真实进程 + 线协议驱动）。
  Based on: `tests/src/harness.mjs:245,254-255` 现依赖 `COFLUX_ENROLL_KEY`；
  `LOCAL_ENV`（`authorize.test.mjs:25`）含 server 侧同名变量。
- **(decided while planning) 与 plan 035 的边界**：本 plan 结束时
  `cofluxd up` 零参数 + 浏览器授权即完整可用；035 只动命令面形态与 doctor，
  不再碰协议/server。拆分理由：一次 REVISE 回路里 proto regen + harness
  改造 + UI 改造已是可控上限。

## Direction

先 proto + regen（两侧编译错误即待改清单），再 Rust 侧、server 侧、共享
client + web、CLI，最后 harness 与测试。遵循 AGENTS.md：协议两侧一致、
cargo 零警告、注释中文、mobile 冻结（共享层弄坏其构建时仅做最小修复）。

### Milestone 1: 协议与 Rust 侧删除

proto 删 message + reserved，regen 三侧产物；worker 二选一登记逻辑，
settings 字段删除。Validation: `cargo build -p coflux-supervisor -p coflux-worker`
→ exit 0 零警告；`cargo test -p coflux-protocol` → exit 0。

### Milestone 2: server + 共享 client + web 删除

hub/store/config/plugin 的 enroll 面全删；client store API 删；
EnrollmentDialog 改安装引导。Validation:
`node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` → exit 0；
`node_modules/.bin/tsc -b apps/web/tsconfig.json` → exit 0；
mobile 构建仍绿（`node_modules/.bin/tsc -b apps/mobile/tsconfig.json`，若
存在该入口；坏了做最小修复）。

### Milestone 3: CLI enrollKey 面删除

`--enroll-key`/settings 字段/问答分支删除，零参数 `up` 流程不变。
Validation: `node --check packages/cli/cofluxd.mjs` → exit 0。

### Milestone 4: harness 授权流改造 + 全量测试

startStack 自动授权 helper；受影响测试文件改造。
Validation: `pnpm -C tests test`（acceptance，编排方跑）→ 60+ 全绿。

## Landmines

- `buf.gen.yaml` 带 `clean: true`：regen 会清空产物目录，两侧 gen 目录里
  不要有手工改动预期（当前无，确认即可）。
- `pick()` 的空串直通语义（`crates/worker/src/main.rs` 注释与
  `cofluxd.mjs` 默认写入 `enrollKey: ""`）是 worker 判定走新授权流的信号
  ——删除时两端要同时摘，否则残留 settings.json 里的 `enrollKey: ""` 旧值
  会被当普通字段读。`Settings::load` 对未知字段的容忍度需确认（serde 默认
  忽略未知字段则旧文件天然兼容）。
- `harness.mjs` 的 `startStack` 被全部 ~60 个测试共用，授权 helper 的等待
  逻辑若有竞态会放大成全套件 flake；参考 `authorize.test.mjs` 已验证的
  waitFor 序列，避免自创轮询。
- `tests/src/security.test.mjs` 有跨账号隔离用例，其账号构造可能依赖
  enrollKey 归属账号的机制（`hub.ts:297` `accountForEnrollmentKey`）——
  改造后账号归属来自授权用户的会话，检查用例语义是否仍成立。
- `docs/auth-design.md` 描述了三路径演进历史：更新为现状（单一路径），但
  保留历史设计记录段落，不要整篇重写。
- 生产 daemon 已在跑旧版 worker（v0.9.0）：旧 daemon 持有效 credentials
  走 `DaemonAuth`，不受影响；但**从未登记过的旧版 daemon** 若带 enrollKey
  发 `DaemonEnroll`，新 server 将无法识别（oneof 字段已删，解码为空
  payload 丢弃）——可接受（无此类存量），不做兼容层。

## Scope

In scope:

- `proto/coflux/v1/daemon.proto`、`proto/coflux/v1/client.proto` 及三侧
  regen 产物（`packages/protocol/src/gen`、`crates/protocol/src/gen`、`proto/gen/swift`）
- `crates/protocol/src/settings.rs`、`crates/worker/src/`
- `apps/server/src/`（hub.ts、store.ts、config.ts、plugins/store.plugin.ts）
- `packages/client/src/`
- `apps/web/src/components/workbench/`（workbench.tsx、dialogs.tsx）
- `packages/cli/cofluxd.mjs`（仅 enrollKey 面）
- `tests/src/`（harness.mjs 与受影响测试文件）
- `README.md`、`docs/auth-design.md`（enrollKey 提及处）
- `apps/mobile/`（仅当共享层变更弄坏构建时的最小修复）

Out of scope:

- cofluxd 命令面重梳（onboard/reload/doctor）—— plan 035
- 生产库 `enrollment_keys` 表的 DROP —— 部署时人工操作（见 Maintenance notes）
- `crates/supervisor` —— 与登记无关

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Rust 构建（零警告） | `cargo build -p coflux-supervisor -p coflux-worker` | exit 0，无 warning |
| Rust 协议测试 | `cargo test -p coflux-protocol` | exit 0 |
| server 类型检查 | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| web 类型检查 | `node_modules/.bin/tsc -b apps/web/tsconfig.json` | exit 0 |
| CLI 语法检查 | `node --check packages/cli/cofluxd.mjs` | exit 0 |
| 黑盒测试 (acceptance) | `COFLUX_TEST_PG_URL="postgres://postgres:postgres@127.0.0.1:54322/postgres" pnpm -C tests test` | exit 0 |

## Done criteria

- [ ] All listed commands pass.
- [ ] 仓库内（除 docs 历史记录与 plans/）grep `enroll` 不再命中活代码路径
      （`DaemonEnrollRequest`/`DaemonEnrolled`/授权流保留，属浏览器授权流本身）。
- [ ] web「添加设备」展示安装引导，不再有生成密钥交互。
- [ ] harness 走真实授权流，全量测试无回归。
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.
- harness 授权流改造导致 3 个以上既有测试语义无法保持（说明黑盒授权 helper
  的假设错了，回报而非硬改用例断言）。

## Maintenance notes

- 生产部署本版本后，`enrollment_keys` 表成为孤表：确认无回滚需要后人工
  `DROP TABLE enrollment_keys`（低优先，留着无害）。
- proto 的 reserved field number（daemon.proto oneof 1、client.proto oneof 4 /
  oneof 3）永不复用。
- 命名注意：`DaemonEnrollRequest`/`DaemonEnrolled` 是浏览器授权流的活消息，
  与被删的 classic `DaemonEnroll` 仅一词之差，review 时勿误删。
