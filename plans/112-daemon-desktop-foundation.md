# Plan 112: 桌面版内置 daemon 的地基——Rust 版 agent 命令 `cofluxd`、supervisor 前置 PATH 与版本落盘、客户端库设备授权兑现

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 34078ff..HEAD -- Cargo.toml crates/cli crates/supervisor/src/sessions.rs crates/supervisor/src/main.rs crates/supervisor/src/fda.rs crates/worker/src/hook.rs packages/cli/cofluxd.mjs packages/client/src proto/coflux/v1/client.proto apps/server/src/hub.ts .github/workflows/ci.yml tests/src/session-env-injection.test.mjs tests/src/agent-control.test.mjs`

## Status

- Priority: P1
- Effort: M
- Risk: MED（新 Rust crate + supervisor 会话环境改动 + 客户端库新方法；无界面、无协议变更）
- Depends on: none（基于 main `34078ff`，已含 110；plan group「桌面版内置 daemon」的地基，113 依赖本 plan）
- Category: feature
- Execution: subagent（宿主通用子 agent，`model: fable`；出发检查 2026-09-11 在 dev:explore 记录：连续自动推进、不再确认；push / PR / 合 main / 发版仍需用户明确要求）
- Planned at: `34078ff`, 2026-09-11

## Requirement

用户要在 macOS 上「装了 Coflux.app 就够了」：不再 `npm i -g cofluxd`、不再手动处理 supervisor。plan 113 让桌面版
成为 daemon 的安装器与管理器；本 plan 先把桌面版之外、但桌面版内置必须依赖的三块地基做好，全部无界面：

1. **agent 命令不依赖 Node**。今天跑在 coflux 终端里的 agent 与 Claude 插件靠 PATH 里的 npm 版 `cofluxd`
   （node 脚本 `packages/cli/cofluxd.mjs`）：`cofluxd terminal/progress/notify/ports/workspace`，以及插件 hooks
   （`integrations/claude-plugin/hooks/hooks.json:20` 等：`command -v cofluxd … && exec cofluxd hook claude || :`——
   没装就静默不工作；`scripts/session-context.sh:10` 调 `cofluxd workspace`）。桌面版不能把 Electron 当 node 借给终端
   （fuse `runAsNode: false`，`apps/desktop/electron-builder.yml`），所以这组 agent 侧命令要有一个 Rust 二进制版本，
   名字仍叫 `cofluxd`，行为与 node 版一致，供 113 内置进 app 并落到 `~/.coflux/bin/`。
2. **supervisor 把 `$COFLUX_HOME/bin` 前置进每个 coflux 终端的 PATH**，agent 与插件 hook 零安装即可用上面那个二进制；
   不改用户自己的 shell 配置。
3. **supervisor 启动时把自身版本落盘**到 `$COFLUX_HOME/supervisor-version`，113 据此判断「app 内置的 supervisor 比在跑的新」
   （今天 `cofluxd status` 只能判活，不知道在跑的是哪个版本，`packages/cli/cofluxd.mjs:549-585`）。
4. **客户端库能兑现设备授权**。app 内一键授权要用桌面的登录态兑现 daemon 打印的一次性 token。服务端这条能力**已经存在**：
   控制面 `ClientMessage.device_authorize`（`proto/coflux/v1/client.proto:46-48, 169`）与回包 `device_authorize_info` /
   `device_authorized`（`client.proto:216-225, 337-338`），hub 分发在 `apps/server/src/hub.ts:2756`，兑现核心
   `redeemPendingAuthorization` 与授权页 `POST /authorize/:token/confirm` 共用（`hub.ts:3539-3546`、`apps/server/src/auth-pages.ts:409`）。
   但 `@coflux/client` 里没有任何调用（web 的 /authorize 页面 plan 107 收进 server 直出后，客户端库这一侧空了）。本 plan 给
   `@coflux/client` 补一个可等待结果的 `authorizeDevice(token)`，113 的渲染层直接用。

完成后：仓库多一个 `crates/cli` 出 `cofluxd` 二进制，在 coflux 终端里与 node 版互换无感；新 supervisor 开出的每个终端
`echo $PATH` 首段是 `$COFLUX_HOME/bin`；`$COFLUX_HOME/supervisor-version` 文件内容等于握手上报的 supervisor 版本；
`@coflux/client` 的 store 能用 token 兑现授权并把成功/失败原因交给调用方。npm 版 `cofluxd` 与 Claude 插件零改动。

### 产品结论（探索阶段已确认，勿再问）

- Rust `cofluxd` **只含 agent 侧命令**：`terminal new|list|read|wait|send`、`progress`、`notify`、`ports`、`workspace`、`hook`。
  管理类子命令（`up` / `down` / `update` / `restart` / `status` / `doctor` / `logs` / `fda` / `uninstall`）**不重写**；打到 Rust 版时
  打印一行「本机 daemon 由 Coflux.app 管理」类提示并以非零退出。
- npm 版 `cofluxd` 继续服务 Linux / 无头机，是 Rust 版的**行为参照**，本 plan 不改它。
- 非目标：Intel / Linux 的分发（Rust 版只需能在 workspace 内 `cargo build`，是否进 daemon release 产物见 Maintenance notes）；
  协议变更；服务端改动；桌面版任何代码（属 113）。

## Decisions & tradeoffs

- **Rust CLI 是独立 crate `crates/cli`，二进制名 `cofluxd`**，加入 workspace members（`Cargo.toml:6`）并进 CI 的显式 crate 列表
  （`.github/workflows/ci.yml:148, 153` 是逐 crate 点名的 `cargo test` / `cargo build`，不加就没有 CI 覆盖）。
  Rejected: 做成 `coflux-worker` 的子命令再软链成 `cofluxd` — argv[0] 分发晦涩，且会把 30MB 的 worker 当 CLI 反复起。
  Rejected: 改名（如 `coflux`）— 插件 hooks.json 与 SKILL.md 全部写死 `cofluxd`，产品结论要求零改动。
  Based on: `Cargo.toml:6`、`integrations/claude-plugin/hooks/hooks.json:20`、`packages/cli/skills/coflux/SKILL.md`。
- **行为对齐 node 版，逐命令**：请求体、端点、退出码、stdout 文案以 `packages/cli/cofluxd.mjs` 为参照
  （`cmdTerminal` 1018 起、`cmdNotify` 1082、`cmdProgress` 1089、`cmdWorkspace` 1106、`cmdPorts` 1145、`cmdHook` 884，共用的
  `agentPost` 在 986 附近：POST `http://127.0.0.1:<COFLUX_LOCAL_GATEWAY_PORT|8788>/agent`；hook 转发 POST `/hook` 在 927 附近）。
  worker 侧只认这两个路径（`crates/worker/src/hook.rs:160-161`）。「一致」的检验标准：现有黑盒里凡是对 node 版 stdout
  做过断言的用例，换成 Rust 版二进制跑同样通过；SKILL.md 里引用的输出短语（如 `已开终端 <taskId>`）逐字保留。
  Rejected: 借机重设计输出格式 — 会连带改 SKILL / 插件 / 黑盒三处。
- **管理类子命令的处理是「明确拒绝」而不是「未知命令」**：识别出 `up/down/update/restart/status/doctor/logs/fda/uninstall`
  后打印指向 Coflux.app 的提示并 `exit 2`；真正未知的子命令沿用 node 版的用法提示与退出码。
  Rejected: 静默透传给 npm 版 — PATH 前置后 Rust 版永远先命中，透传要自己找 npm 版路径，脆弱。
- **HTTP 客户端不引新 TLS/异步栈**：只打 loopback 明文 HTTP，优先用 `crates/worker` 已有的依赖（`crates/worker/Cargo.toml`
  有 tokio / serde_json；worker 自己的 `/agent` 服务端就是手写 HTTP）或 `std::net::TcpStream` 手写最小 HTTP/1.1；
  二进制体积与编译时间是硬约束（它随 app 一起签名公证、每个终端里都可能被频繁调用）。
  Rejected: reqwest/hyper 全家桶 — 为一个 loopback POST 拖进 TLS 与异步运行时。
- **supervisor 前置 PATH 的位置与语义**：在会话环境组装处（`crates/supervisor/src/sessions.rs:817-827`，拷贝 `std::env`
  之后、注入 `COFLUX_*` 之处）把 `<COFLUX_HOME>/bin` 放到 PATH 首段；PATH 原本为空时就只有这一段；`COFLUX_HOME` 用 supervisor
  自己解析出的 home（`main.rs:95`），不用字面 `~/.coflux`。所有平台都做（Linux 无害，且为将来 npm-free Linux 铺路）。
  Rejected: 追加到 PATH 末尾 — 已装 npm 版的机器会继续命中 node 版，内置无效。
  Rejected: 只在 macOS 做 — 同一段代码分平台走两条路，黑盒要分平台断言。
- **supervisor 版本落盘**：启动时写 `<COFLUX_HOME>/supervisor-version`，内容为 `SUPERVISOR_VERSION` 原文加换行
  （`crates/supervisor/src/main.rs:37-40`，release 构建是 `v0.32.0` 这类 tag、dev 是 `dev`），照 `fda::write_status`
  的方式与调用位置（`main.rs:98`、`fda.rs:22-25`：不 panic、失败静默）。
  Rejected: 让 113 去 exec 二进制 `--version` — supervisor 没有该参数，且「在跑的」与「盘上的」是两回事，文件才表示在跑的。
- **客户端库 API**：`@coflux/client` 的 store 新增 `authorizeDevice(token: string): Promise<{ ok: true } | { ok: false; error: string }>`
  （命名与返回形状是本 plan 与 113 的契约，113 只依赖这一条），内部发 `deviceAuthorize`，以 `deviceAuthorized` 判成功、
  `deviceAuthorizeInfo.ok=false` 的 `error` 判失败；未登录 / 连接未就绪时立即失败而不是挂起。不需要 `deviceAuthorizeInfo`
  的查询能力（app 不展示待授权设备卡片——它就是本机）。
  Rejected: 桌面主进程自己开一条 WS 发消息 — 主进程没有控制面连接与会话态，重复一套认证。
  Rejected: 改服务端加新消息 — 已有消息语义完全吻合（一次性、绑定当前账号、失败原因不泄漏细节）。
  Based on: `proto/coflux/v1/client.proto:46-48, 169, 216-225, 337-338`、`apps/server/src/hub.ts:2756, 3539-3546`。
- **黑盒各加一条、不改既有用例语义**：PATH 前置与 `supervisor-version` 在 `tests/src/session-env-injection.test.mjs` 的
  同类断言旁验证；Rust `cofluxd` 用现有 agent 命令黑盒（`agent-control.test.mjs`、`session-env-injection.test.mjs` 第 ③ 路径）
  以 Rust 二进制再跑一遍或参数化二进制路径（harness 已有 `COFLUX_SUPERVISOR_BIN` / `COFLUX_WORKER_BIN` 环境变量覆盖先例，
  `tests/src/harness.mjs:302-304`，且 `pretest` 会 `cargo build`）。黑盒属 acceptance 级，不作里程碑验证。

## Direction

三个里程碑**相互独立**（路径不相交：M1 = `crates/cli` + `Cargo.toml`/`Cargo.lock`/`ci.yml`；M2 = `crates/supervisor`；
M3 = `packages/client`），可并行为工作包；共享面只有 `Cargo.lock`（M2 不加依赖，M1 独占改动）。黑盒补充分属 M1/M2，
放各自里程碑里、不同测试文件。

### Milestone 1: Rust `cofluxd`（agent 命令）

`cargo build -p coflux-cli` 出 `target/debug/cofluxd`；在 coflux 终端里（有 `COFLUX_SESSION_ID` 等六变量与 loopback gateway）
它与 node 版对同一组子命令给出同样的请求、同样的 stdout 短语与退出码；管理类子命令被明确拒绝；`--help`/无参数有用法。
参数解析、请求体组装、输出格式化这类纯逻辑有单测。CI 的 cargo test/build 列表包含新 crate。
Validation: `cargo test -p coflux-cli` -> exit 0；`cargo build -p coflux-cli` -> exit 0 且产出 `cofluxd`。

### Milestone 2: supervisor 前置 PATH + 版本落盘

新 supervisor 开出的会话里 `PATH` 首段是 `<COFLUX_HOME>/bin`，其余段与原 PATH 顺序不变；`<COFLUX_HOME>/supervisor-version`
在启动后存在且内容等于握手上报的 supervisor 版本。PATH 组装抽成纯函数并有单测（空 PATH、已含该段、多段）。
Validation: `cargo test -p coflux-supervisor` -> exit 0。

### Milestone 3: `@coflux/client` 的 `authorizeDevice`

store 暴露 `authorizeDevice(token)`，成功/失败/未连接三种结果可等待；有单测覆盖三种结果（照 `packages/client/src/*.test.ts` 现有
写法，用假 transport 喂 `deviceAuthorized` / `deviceAuthorizeInfo`）。
Validation: `node --import tsx --test packages/client/src/*.test.ts` -> exit 0。

## Landmines

- `command.env("PATH", …)` 必须在拷贝 `std::env::vars()` 之后（`sessions.rs:817-819`），否则被覆盖回原值；`COFLUX_*` 六变量的注入
  注释写明「变量名是 agent 面向的契约，只能加不能改」（`sessions.rs:822-824`），PATH 改动不得影响它们。
- `SUPERVISOR_VERSION` 同时决定内置 worker 的 `builtin.version`：能按 SemVer 解析就用它，否则是字面 `"builtin"`
  （`crates/supervisor/src/main.rs:132-141`）。落盘文件写的是原文，别写解析后的形式，113 要拿它与自己内置的版本戳做 SemVer 比较。
- node 版 `agentPost` 对「本终端早于 daemon 升级、缺归属信息」「不在 coflux 会话内」等错误有专门文案（`cofluxd.mjs:986` 附近），
  worker 用调用方 pid 反查进程树认会话（`crates/worker/src/hook.rs`）。Rust 版进程也是终端 shell 的子进程，反查同样成立；
  但**不要**在 Rust 版里 fork 出中间进程再发请求（会断进程树链路）。
- `hook` 子命令是 stdin 里的 Claude Code hook JSON 原样转发到 `/hook`，并把响应 JSON 打到 stdout（`cmdHook` 884 起，含
  `COFLUX_HOOK_DEBUG`）；hooks.json 里每个事件都 `exec cofluxd hook claude`，任何非零退出或 stderr 噪音都会被 Claude Code
  当 hook 失败展示——失败路径要与 node 版同样安静（无 daemon 时 `|| :` 吞掉的是 `command -v` 的失败，不是 hook 的）。
- `COFLUX_LOCAL_GATEWAY_PORT` 非法值时 node 版报「无法定位固定监听端口」（`cofluxd.mjs:106-110`），`0` 是 dev/test 随机端口——
  Rust 版同样处理，黑盒 harness 可能用非默认端口。
- 黑盒 `session-env-injection.test.mjs` 第 ③ 路径是在 coflux 终端里执行 `node <cofluxd.mjs>`（文件顶注释与第 30 行 `COFLUXD`
  常量）；给 Rust 版加用例时同一个终端里执行 `target/debug/cofluxd`，别开新 stack（端口独占，`PORT = 8870`）。
- CI 的 rustflags 是 `-D warnings`（`.github/workflows/release.yml:130`），新 crate 不能带 warning。

## Scope

In scope:
- `crates/cli/**`（新）
- `Cargo.toml`、`Cargo.lock`
- `crates/supervisor/src/sessions.rs`、`crates/supervisor/src/main.rs`（以及为此新增的 supervisor 模块/单测）
- `packages/client/src/**`（store 新方法 + 单测）
- `.github/workflows/ci.yml`（把新 crate 加进 cargo test/build 列表）
- `tests/src/session-env-injection.test.mjs`、`tests/src/agent-control.test.mjs`（新增断言/参数化二进制路径）、`tests/src/harness.mjs`（若需 `COFLUX_CLI_BIN` 之类覆盖）
- `packages/cli/README.md`、`README.md` 的一两句说明（可选）

Out of scope:
- `packages/cli/cofluxd.mjs`、`packages/cli/skills/**`、`integrations/claude-plugin/**` — 产品结论：零改动
- `proto/**`、`apps/server/**` — 已有消息够用
- `apps/desktop/**`、`.github/workflows/desktop-release.yml`、`.github/workflows/release.yml` — 属 113 / 后续
- `crates/worker/**` — 服务端点不变

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Rust 单测（含新 crate） | `cargo test -p coflux-protocol -p coflux-supervisor -p coflux-worker -p coflux-relay -p coflux-cli` | exit 0 |
| Rust 构建 | `cargo build -p coflux-supervisor -p coflux-worker -p coflux-relay -p coflux-cli` | exit 0，`target/debug/cofluxd` 存在 |
| client 单测 | `node --import tsx --test packages/client/src/*.test.ts` | exit 0 |
| 桌面 typecheck（client 是它的依赖） | `pnpm -C apps/desktop typecheck` | exit 0 |
| 全量黑盒 (acceptance) | `pnpm -C tests test` | exit 0（需 OrbStack/Docker 与 5432 PG；agent-activity 的 presence 三条在装了 coflux 的本机必假红，判无关） |

## Done criteria

- [ ] All listed commands pass.
- [ ] `target/debug/cofluxd` 在 coflux 终端里跑 `terminal new/list/read/wait/send`、`progress`、`notify`、`ports`、`workspace`、`hook` 与 node 版同请求、同输出短语、同退出码；`status`/`up` 等被明确拒绝且非零退出。
- [ ] 新 supervisor 开出的会话 `PATH` 首段为 `<COFLUX_HOME>/bin`；`<COFLUX_HOME>/supervisor-version` 存在且等于上报版本。
- [ ] `@coflux/client` 的 `authorizeDevice(token)` 三种结果可等待且有单测。
- [ ] Required tests exist and assert meaningful behavior（PATH 纯函数单测、CLI 参数/输出单测、client 三态单测、黑盒各一条）。
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds（尤其：`client.proto` 的 `device_authorize` 消息被删或 hub 不再分发它；worker `/agent` 与 `/hook` 路径变了）。
- The outcome requires out-of-scope files（如发现必须改 worker 端点或插件）。
- A validation command fails twice after one reasonable fix.
- A named assumption is false（如 Rust 进程从终端 shell 起、pid 反查进程树认不出会话）。

## Maintenance notes

- Rust `cofluxd` 与 node 版并存期：两者都叫 `cofluxd`，在 coflux 终端里靠 PATH 前置命中 Rust 版，在用户自己的终端里命中 npm 版。
  新增 agent 侧子命令时两边同步，node 版仍是文案真相源（SKILL.md 随 npm 包分发）。
- 是否把 `cofluxd` 加进 daemon release（`release.yml` 矩阵与 `manifest.json`）本 plan 不做：113 由桌面流水线自己构建；
  npm 版 `cofluxd update` 顺带装 Rust 版、让 Linux 也 npm-free，是后续 plan。
- `supervisor-version` 是 113 的读取契约（纯文本、原文、一行）；改格式先看 `apps/desktop` 的读取端。
- supervisor 改动要 `cofluxd update && cofluxd restart`（结束本机会话）才生效；已接入的机器升级前旧终端里没有 PATH 前置，
  这时 `command -v cofluxd` 仍命中 npm 版，属预期。
