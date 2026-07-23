# Plan 028: macOS 完全磁盘访问权限（FDA）检测 + 引导流程

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 6eda26d..HEAD -- packages/cli/cofluxd.mjs crates/supervisor/src/main.rs crates/worker/src/main.rs`

## Status

- Priority: P2
- Effort: S
- Risk: LOW
- Depends on: none
- Category: feature
- Execution: subagent sonnet
- Planned at: `6eda26d`, 2026-07-23

## Requirement

daemon 在 macOS 上以 LaunchAgent 后台运行，PTY 子进程（shell/agent）访问桌面、文稿、下载等 TCC 保护目录时，系统会弹出目录授权窗；用户往往不在电脑前，弹窗没人点，操作挂起或失败。一次性授予 supervisor 二进制「完全磁盘访问权限」（FDA）后，整个进程树永久免弹。

但 macOS **没有任何 API 能程序化弹出 FDA 授权窗**（Apple 刻意设计），产品能做的上限是：检测 + 跳转系统设置 + 引导用户手动添加。本计划把这条引导链做进 daemon 与 cofluxd CLI：

完成后为真：

1. macOS 上 supervisor 启动时探测自身是否具备 FDA，结果落地为 `COFLUX_HOME` 下的状态文件；
2. `cofluxd status` 在 macOS 上多显示一行 FDA 授权状态（已授予/未授予/未知）；
3. 新增 `cofluxd fda` 子命令：打印引导文案、打开系统设置 FDA 面板、在 Finder 中高亮 supervisor 二进制，等待用户完成后重启服务使授权生效；
4. `onboard`/`up` 完成时若检测到未授权（macOS），追加一行提示指向 `cofluxd fda`；
5. Linux 行为完全不变。

正确/错误解的分界：检测必须发生在 **supervisor 进程内**——在 CLI（node）里试读保护路径测出来的是终端 App 的 TCC 权限，属于典型的错误解。

## Decisions & tradeoffs

- **探测主体**: supervisor 进程启动时探测（`#[cfg(target_os = "macos")]`）。Rejected: cofluxd CLI 直接试读保护路径 —— CLI 由终端启动，TCC 归属（responsible process）是 Terminal/iTerm，测的是终端的权限而非 daemon 的，结果必然失真。Based on: LaunchAgent 直接执行 `SUP_BIN`，`packages/cli/cofluxd.mjs:107-124`。
- **探测方法**: 试读纯 FDA 保护路径 `$HOME/Library/Safari`（如 `read_dir`），成功=已授予，`PermissionDenied`=未授予，其他错误（如目录不存在）=未知。Rejected: 探测桌面/文稿/下载 —— 这些是 per-folder TCC 目录，探测本身会触发授权弹窗，恰是本需求要消灭的东西。注意 `$HOME` 是真实用户 home，不是 `COFLUX_HOME`（supervisor 里两者独立，`crates/supervisor/src/main.rs:46`）。
- **状态通道**: supervisor 把探测结果写成 `COFLUX_HOME` 下的状态文件，CLI 读文件展示。Rejected: UDS 查询接口 —— 现有 CLI↔daemon 无查询通道，先例就是文件（`worker.pid`，写端 `crates/worker/src/main.rs:201`，读端 `packages/cli/cofluxd.mjs:280`），为一个布尔状态加 RPC 属过度设计。文件名与格式由执行者定，保持与现有先例同风格即可。
- **`cofluxd fda` 的行为**: 引导文案 + `open "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"` + `open -R <SUP_BIN>`（Finder 高亮，便于拖入设置列表；`~/.coflux` 是隐藏目录，用户手动导航困难）+ 提示用户完成添加后按回车 → 重启服务（复用现有 `restartService()`，`packages/cli/cofluxd.mjs:154-157`）。Rejected: 授权后不重启 —— FDA 对已运行进程不生效，必须重启 supervisor；Rejected: 任何「自动写 TCC.db / tccutil 授权」的尝试 —— 不存在合法途径。非 macOS 平台运行 `cofluxd fda` 直接提示仅 macOS 可用并退出。
- **授权对象的文案**: 引导用户添加的是 supervisor 二进制（`~/.coflux/bin/coflux-supervisor`）。worker/PTY/agent 都是它的子进程，TCC 按 launchd 服务的 responsible process 归属，一次授权覆盖全树（同 sshd 模式）；文案不得让用户去添加 cofluxd、node 或终端 App。Based on: plist `ProgramArguments` 只有 `SUP_BIN`，`packages/cli/cofluxd.mjs:112-114`。
- **未授权提示的触达点**: `status` 常驻显示 + `onboard`/`up` 结束时一行提示。探测结果文件由 supervisor 启动后才产生，CLI 读不到文件时显示「未知」并同样指向 `cofluxd fda`，不阻塞任何流程。Rejected: 上报 server / web 设备页警告 —— 多改协议/server/web 三处，当前无此需要，需要时另立计划。

## Direction

两处改动，无共享边界，单计划串行完成即可。

### Milestone 1: supervisor 启动探测 FDA 并落地状态文件

macOS 上 supervisor 启动时（`crates/supervisor/src/main.rs` 的 `main` 早期、`Settings::load` 之后即可）探测 FDA 并写状态文件到 `COFLUX_HOME`；探测失败或非 macOS 不写/写「未知」均可，但不得影响启动流程（探测与写入全程不 panic、不阻塞）。Validation: `cargo build -p coflux-supervisor` -> exit 0；`cargo test -p coflux-protocol` -> exit 0（回归）。

### Milestone 2: cofluxd CLI —— status 展示 + fda 子命令 + onboard/up 提示

`packages/cli/cofluxd.mjs`：`cmdStatus` 读状态文件加一行（仅 `IS_MAC`）；新增 `cmdFda` 并注册进 handlers 表（`packages/cli/cofluxd.mjs:338`）与 HELP 文案（`packages/cli/cofluxd.mjs:302` 起）；`onboard`/`up` 尾部按状态文件追加提示。CLI 是零依赖单文件 node 脚本，保持现有风格（`run()` 起子进程、中文文案、无新依赖）。Validation: `node --check packages/cli/cofluxd.mjs` -> exit 0。

## Landmines

- CLI 与 supervisor 对 home 的解析必须一致：CLI 用 `COFLUX_HOME || ~/.coflux`（`packages/cli/cofluxd.mjs:16`），supervisor 相同（`crates/supervisor/src/main.rs:46`）；状态文件两端路径拼法要对齐，否则 status 永远「未知」。
- 探测路径必须用真实 `$HOME`（`std::env::var("HOME")`），不能用 `COFLUX_HOME`——dev 模式下 `COFLUX_HOME` 指向 `$PWD/.coflux-dev`（`package.json:10`），其下没有 `Library/Safari`。
- `launchctl unload` + `load` 是现有重启方式（`packages/cli/cofluxd.mjs:155`）；`cofluxd fda` 复用 `restartService()`，不要另造 launchctl 调用。
- 探测结果是启动时快照：用户授权后未重启前，状态文件仍显示未授予——这是预期行为（FDA 本就要求重启生效），文案里说清楚即可。

## Scope

In scope:

- `packages/cli/cofluxd.mjs`
- `crates/supervisor/src/main.rs`（如需拆小函数可在同 crate 内新增模块）
- `plans/README.md`（状态更新）

Out of scope:

- `crates/worker/`、`apps/server/`、`apps/web/`、`packages/protocol/`、`proto/` —— 不上报 server，不改协议
- Linux/systemd 路径的任何行为变化
- 文档（README 等）—— 子命令自带 HELP 即可

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Rust 构建 | `cargo build -p coflux-supervisor -p coflux-worker` | exit 0 |
| Rust 单测（回归） | `cargo test -p coflux-protocol` | exit 0 |
| CLI 语法检查 | `node --check packages/cli/cofluxd.mjs` | exit 0 |
| 黑盒集成（acceptance） | `pnpm -C tests test` | exit 0 |

## Done criteria

- [ ] All listed commands pass.
- [ ] macOS 构建下 supervisor 启动会产生 FDA 状态文件；`cofluxd status` 在 macOS 显示 FDA 行；`cofluxd fda` 打开设置面板并高亮二进制，完成后重启服务；`onboard`/`up` 未授权时有一行提示。
- [ ] 非 macOS 平台：supervisor 与 CLI 行为与现状完全一致（`cofluxd fda` 仅提示不支持）。
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.
- A named assumption is false.

## Maintenance notes

- Apple 若未来变更 `~/Library/Safari` 的 TCC 归类或路径，探测会退化为「未知」——属安全退化，只影响提示不影响功能；届时换一个纯 FDA 保护路径即可。
- 系统设置深链 `x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles` 是 Apple 未文档化但多年稳定的 URL；失效时退化为只打开系统设置主界面，文案仍指路。
- 二进制已 Developer ID 签名（v0.6.1 起），TCC 按签名身份记录授权，升级换二进制不丢授权；若未来改签名身份（换证书/Team），用户需重新授权。
