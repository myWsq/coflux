# Plan 015: daemon worker 自动热更新编排层

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 909575e..HEAD -- proto/ crates/ apps/server/src apps/web/src tests/src docs/RELEASING.md docs/hot-upgrade-design.md .github/workflows/release.yml`

## Status

- Priority: P1
- Effort: M
- Risk: MED
- Depends on: none
- Category: feature
- Execution: subagent sonnet
- Planned at: `909575e`, 2026-07-20

## Requirement

热升级的**执行**链路已完备并有黑盒覆盖（下载 → sha256 → ed25519 验签 → probation 切换 → 失败回滚，PTY 会话存活），但**触发**只有手动一条路（`clientUpgradeDaemon`，且 web 无入口，实际只能靠测试/脚本发消息）。daemon 散落在用户各台机器上，发版后没有任何机制让它们跟上——这正是 `docs/RELEASING.md:55` 记录的既定后续项。

完成后成立的事实：

1. 发布一个 stable release（tag 不含 `-`）后，所有在线 daemon 的 worker 在一个轮询周期内被 server 自动推到该版本，无任何人工操作；期间运行中的 PTY 会话不死（既有热升级保证）。
2. server/web 能看到每台在线 daemon 的 worker 版本与 supervisor 版本（supervisor 落后可见，但**不**自动升级）。
3. 升级失败回滚后不会形成"重连上报旧版本 → server 再推 → 再失败"的无限循环（有退避）。
4. prerelease（tag 含 `-`）不被自动推送——手动 `clientUpgradeDaemon` 链路保持原样，作为灰度手段。

正确/错误解的分界：一个"daemon 自己轮询 GitHub"的实现是错的（方向已定为 server 推）；一个用 semver 大小比较决定推送的实现是错的（决策为不等即推）；一个给 supervisor 做自动重启升级的实现是超范围的。

## Decisions & tradeoffs

- **决策架构：server 推**。daemon 握手时上报版本，server 比对并下发。Rejected: daemon 各自轮询 GitHub —— 失去集中控制/灰度，每机打 GitHub API，且与现有手动下发链路形成两套触发源。Based on: 下发通道已存在 `apps/server/src/hub.ts:684`；`docs/RELEASING.md:55` 既定方向。
- **期望版本来源：server 轮询 GitHub `/releases/latest`**。该端点天然排除 prerelease 与 draft，无需自行过滤 tag。轮询到新 tag 后拉取该 release 的 `manifest.json` 资产（含每 target 的 `url/sha256/signature`，由 `scripts/release-sign.mjs:22-47` 生成），server 原样转发字段，不做验签——安全闸门在 supervisor 端验签（`crates/supervisor/src/upgrade.rs:46`）。Rejected: CI 发版时调 server admin API —— 需新增端点 + CI 持生产凭据；server 配置手写版本 —— 只是半自动。
- **GitHub API base 与仓库名走 env 配置，未配置则整个自动更新特性禁用**。这同时是生产开关和测试注入点（黑盒测试起本地 http server 模拟 releases API + manifest + 产物）。遵循 `apps/server/src/config.ts` 的纯 env 模式（无配置文件）。Based on: `config.ts:5-40`；server 目前无外发 fetch 先例，此为第一处。
- **比对规则：不等即推（严格 `!==`），且上报版本为空字符串时不推**。不做 semver 比较——这样初装的 `"builtin"` worker 会被推到最新，未来 server 固定/回退版本也天然可用；空版本说明对端是不上报版本的旧 daemon，状态未知，留给手动链路。Rejected: semver 大小比较 —— 阻断回退，且 `"builtin"` 无法参与比较。Based on: 内置 worker 版本硬编码 `"builtin"`（`crates/supervisor/src/main.rs:50`）。
- **触发时机：daemon 握手完成（`registerDaemonConn`）时比对一次 + 每次轮询发现结果后对全部在线 daemon sweep 一次**。Based on: 在线 daemon 集合在内存 `hub.ts:123` `daemons` Map；周期任务先例 `apps/server/src/index.ts:89-92` 的 heartbeat `setInterval`。
- **失败退避：server 内存中按 (daemonId, version) 记录推送，限次 + 冷却**（具体次数/时长是 executor 的 call，量级建议 ≤3 次、冷却 ≥1 小时）。server 重启清零可接受——重启后最多再推有限几次。Rejected: 持久化退避状态到 Postgres —— 为罕见故障场景引入表结构，不值。Based on: 回滚后 supervisor 重启旧 worker、worker 重连重新握手（`crates/supervisor/src/manager.rs:111-131`），若无退避则必然循环。
- **版本上报的载体：proto3 向后兼容的新增字段**。`DaemonEnroll`/`DaemonAuth`/`DaemonEnrollRequest`（`proto/coflux/v1/daemon.proto:12-28`）新增 `worker_version`、`supervisor_version`、`arch`；`DaemonInfo`（`proto/coflux/v1/common.proto:10-16`）新增 worker/supervisor 版本字段使 web 可见。旧 daemon 不带字段 → 空串 → 不自动推（见比对规则）。Rejected: 新独立消息类型 —— 握手消息加字段更小且天然覆盖每次重连。
- **worker 得知版本的方式：supervisor spawn worker 时经 env 传入**（当前 running 版本 + supervisor 自身版本）。worker 每次升级/重启都会重新 spawn 并重新握手，env 恰好每次都是新值。Rejected: 经 IPC 消息传 —— 多一轮消息时序，无收益。Based on: spawn 处已有 env 先例 `SUPERVISOR_SOCK_ENV`（`crates/supervisor/src/manager.rs:76`）；worker 目前完全不知版本（grep 无 version/CARGO_PKG）。
- **supervisor 版本：编译期注入 release tag**。`option_env!` 读构建时 env（如 `COFLUX_RELEASE_VERSION`），本地构建落 `"dev"`；`.github/workflows/release.yml` 编译步骤传 `github.ref_name`。Rejected: 用 `CARGO_PKG_VERSION` —— `Cargo.toml:11` 是占位 `0.0.0`，真实版本 = git tag，不在 Cargo 里维护。
- **arch → manifest target 映射在 server 侧做**：daemon 上报原始 `std::env::consts::ARCH`，server 用 platform+arch 映射到 rust target triple 选 manifest 条目，映射关系与 `packages/cli/cofluxd.mjs:32-37` `rustTarget()` 保持一致；映射不到的组合跳过并记日志。
- **supervisor 不自动升级，仅版本可见**。它持有 PTY，重启杀会话；变更罕见，自动化风险收益不成比例。升级仍走人工 `cofluxd update`（`docs/RELEASING.md:57-63`）。
- **不做 opt-out 开关、不做 channel 配置、不做版本入库**（devices 表不加列，版本只存在线连接的内存态；离线 daemon 看不到版本，可接受）。单用户产品，YAGNI。
- **(decided while planning) web 侧仅最小可见**：设备列表现有 tooltip（`apps/web/src/components/workbench/sidebar.tsx:264`，现为 `host/platform`）追加两个版本号即可，不做落后高亮/升级按钮。

## Direction

数据流：release 发布 → server 轮询 GitHub 拿 `{version, manifest}` → 对每台在线 daemon：取握手上报的 `(workerVersion, platform, arch)` → 不等且非空且映射得到 target → 检查退避 → 复用 `workerUpgrade` 下发 → supervisor 走既有下载/验签/probation/回滚。上报流：supervisor spawn worker 带版本 env → worker 握手消息携带 → hub 存入在线连接元数据 → `DaemonInfo` 下发 web。

协议改动须遵守 `AGENTS.md` 纪律：Rust 侧 `crates/protocol` 与 TS 侧 `packages/protocol` 线格式一致，proto 改后 `cd proto && buf generate`（remote 插件需联网）。

### Milestone 1: 版本贯通——daemon 上报、server 持有、web 可见

supervisor 有编译期版本常量（本地 `"dev"`）；spawn worker 传版本 env；三个握手消息与 `DaemonInfo` 带版本/arch 字段；hub 在握手时存入在线元数据并随 `stateSnapshot`/`daemonUpdated` 下发；sidebar tooltip 显示两个版本。release.yml 注入真实 tag。
Validation: `cargo build -p coflux-supervisor -p coflux-worker`（零警告）、`cargo test -p coflux-protocol`、`node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit`、`node_modules/.bin/tsc -b apps/web/tsconfig.json` 全部 exit 0。

### Milestone 2: server 自动编排——轮询、比对、下发、退避

新的 server 侧编排单元（建议独立模块，挂进 `index.ts` 生命周期）：按 env 配置的间隔轮询 releases API；缓存最新 `{version, manifest entries}`；握手完成与轮询刷新两个时机触发比对；不等即推 + 空版本跳过 + target 映射 + (daemonId, version) 限次冷却退避；env 未配置时整个单元不启动。下发复用 `hub.ts` 现有 `workerUpgrade` 发送路径（提取或调用皆可，但不得绕过/复制 supervisor 侧语义）。
Validation: `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` exit 0；若为比对/退避/映射逻辑写了单测则一并跑过。

### Milestone 3: 黑盒验收 + 文档收尾

新增黑盒测试（`tests/src/`，选未占用端口，遵循 harness 的临时 HOME/DB 隔离约束）：本地 `node:http` server 同时扮演 GitHub releases API（`/releases/latest` 返回含 manifest 资产链接的 JSON）与产物下载端；server 以 env 指向 mock；daemon 以 `COFLUX_WORKER_PUBKEY` 注入测试公钥（模式照抄 `tests/src/signed-upgrade.test.mjs`）。断言：daemon 上线后无任何手动触发，worker 自动升级到 mock 声明的版本（既有测试已示范如何观察升级完成）；以及坏产物场景下推送次数有限（退避生效，断言方式 executor 定）。更新 `docs/RELEASING.md`（":55" 的后续项已完成，改写"升级是怎么落地的"）与 `docs/hot-upgrade-design.md` 状态注记。
Validation: 新测试文件单独可跑（见 Commands 的 acceptance 行）；文档改动无 broken 引用。

## Landmines

- **worker 完全不知自身版本**：版本纯是 supervisor 侧概念（`active`/`running_version`，`crates/supervisor/src/manager.rs:23-26`，落盘 `worker.active` `manager.rs:64-66`）。上报值必须来自 supervisor spawn 时传入，别试图在 worker 里编译期注入 worker 版本——热升级下载的二进制版本以 manifest/tag 为准，supervisor 才知道跑的是哪个。
- **`option_env!` 的缓存坑**：cargo 不会因 env 变化自动重编译，需 `build.rs` 声明 `cargo:rerun-if-env-changed=<env名>`（CI 全新构建不受影响，本地增量构建会）。
- **版本字符串是攻击面**：supervisor 侧已有 `validate_version()` 防路径穿越（`crates/supervisor/src/upgrade.rs:29`）。server 从 GitHub tag 取的版本会流入下发消息进而流入 daemon 文件路径，保持这条校验链完整，不要在 server 侧引入未清洗的版本值绕过它。
- **AGENTS.md 的 sqlite 描述已过时**：server 实际是 Postgres（`apps/server/src/store.ts:147-159` 内联 DDL，无 migration 目录）。以代码为准。
- **黑盒测试本机跑必须 `COFLUX_TEST_PG_URL` 指向 `54322` 直连口**——`5432` 是 supavisor 会报 tenant 错。
- **`/releases/latest` 与 `resolveLatestTag()` 语义不同**：`packages/cli/cofluxd.mjs:55-66` 的 CLI 更新取的是含 prerelease 的最新 tag，而本特性刻意用 `/releases/latest`（不含 prerelease）。两者并存是有意的，别"顺手统一"。
- **`clientUpgradeDaemon` 在 web 无调用点**（仅测试构造，`tests/src/signed-upgrade.test.mjs:101,126,148`）——手动链路的 UI 入口不在本计划范围，别顺手加。

## Scope

In scope:

- `proto/coflux/v1/daemon.proto`、`proto/coflux/v1/common.proto` 及 `buf generate` 产物（`crates/protocol/src/gen`、`packages/protocol/src/gen`）
- `crates/supervisor/`（版本常量、spawn env）、`crates/worker/`（握手携带版本/arch）
- `apps/server/src/`（hub 元数据、编排模块、config env、index 生命周期）
- `apps/web/src/`（仅设备列表版本显示）
- `.github/workflows/release.yml`（编译期版本 env 注入）
- `tests/src/`（新黑盒测试）
- `docs/RELEASING.md`、`docs/hot-upgrade-design.md`、`plans/README.md`

Out of scope:

- `packages/cli/cofluxd.mjs` —— CLI 手动更新链路不动
- supervisor 自动升级 / 空闲重启机制 —— 明确排除
- web 手动升级按钮、落后高亮 —— 仅 tooltip 可见
- devices 表 schema 变更 —— 版本不入库
- opt-out / channel 配置 —— YAGNI
- `crates/supervisor/src/upgrade.rs` 的下载/验签/回滚语义 —— 只被复用，不改动

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Rust 构建（零警告） | `cargo build -p coflux-supervisor -p coflux-worker` | exit 0 |
| Rust 单测 | `cargo test -p coflux-protocol` | exit 0 |
| server 类型检查 | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| web 类型检查 | `node_modules/.bin/tsc -b apps/web/tsconfig.json` | exit 0 |
| proto 重生成 | `cd proto && buf generate` | exit 0，产物已提交 |
| 黑盒全量 (acceptance) | `COFLUX_TEST_PG_URL=postgres://postgres:postgres@127.0.0.1:54322/postgres pnpm -C tests test` | exit 0 |

## Done criteria

- [ ] All listed commands pass.
- [ ] 黑盒测试证明：daemon 上线后无手动触发，worker 自动升级到 mock release 声明的版本。
- [ ] 黑盒测试证明：升级失败场景下推送有限次（退避生效）。
- [ ] env 未配置 releases 来源时，server 行为与现状完全一致（特性整体关闭）。
- [ ] prerelease 不会被自动推送（`/releases/latest` 语义即保证，测试或代码注释言明）。
- [ ] web 设备 tooltip 可见 worker/supervisor 版本；旧 daemon（空版本）不被推送。
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.
- `buf generate` 无法运行（remote 插件不可达）——协议改动无法安全落地时停下报告。

## Maintenance notes

- 退避状态在 server 内存，重启即清零——若未来观察到重启风暴放大推送，再考虑持久化。
- arch→target 映射与 `cofluxd.mjs` `rustTarget()` 手工保持一致；新增平台时两处都要加。
- 发版含 supervisor 改动时仍需人工 `cofluxd update`，`RELEASING.md` 的提醒保留；web 上 supervisor 版本可见即为落后监测手段。
