# Plan 113: 桌面版内置 daemon——随 app 打包 supervisor/worker/cofluxd，登录后接入引导，账号菜单「本机 daemon」状态与升级提示

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 34078ff..HEAD -- apps/desktop .github/workflows/desktop-release.yml .github/workflows/release.yml packages/cli/cofluxd.mjs crates/supervisor/src/main.rs crates/supervisor/src/upgrade.rs crates/supervisor/src/manager.rs crates/supervisor/src/fda.rs crates/worker/src/creds.rs apps/server/src/auto-update.ts packages/client/src/store.ts`

## Status

- Priority: P1
- Effort: L
- Risk: HIGH（CI 打包/签名/公证链路 + 主进程起系统服务 + 新引导流程；macOS 对 launchd 顶层二进制的 AMFI 静默杀是已知坑）
- Depends on: plans/112-daemon-desktop-foundation.md（要它的 Rust `cofluxd` 二进制、supervisor 的 PATH 前置与 `supervisor-version` 文件、`@coflux/client` 的 `authorizeDevice`）
- Category: feature
- Execution: subagent（宿主通用子 agent，`model: fable`；出发检查 2026-09-11 在 dev:explore 记录：连续自动推进、不再确认；push / PR / 合 main / 发版仍需用户明确要求）
- Planned at: `34078ff`, 2026-09-11

## Requirement

今天在 macOS 上把本机接入 coflux 的路径：装 Coflux.app 并登录 → 另开终端 `npm i -g cofluxd`（要先有 Node 20+）→
`cofluxd up`（从 GitHub Release 下载 supervisor/worker 到 `~/.coflux/bin`、写 LaunchAgent、打印授权链接）→ 浏览器打开链接、
再登录一次、确认 → `cofluxd fda` 手动拖二进制授予完全磁盘访问 → 以后 supervisor 升级要手动 `cofluxd update && cofluxd restart`。
桌面版对此的全部参与是「添加设备」对话框里印的那条 npm 命令（`apps/desktop/src/renderer/components/workbench/dialogs.tsx:227`）。
用户的原话：「很麻烦，而且门槛很高」。

完成后，Coflux.app 在 macOS 上就是本机 daemon 的安装器与管理器：app 自带 `coflux-supervisor` / `coflux-worker` / Rust 版 `cofluxd`
三个二进制；登录后若本机没接入，工作台出现接入引导，一键完成落盘、起服务、授权（用 app 的登录态，不开浏览器不开终端）、
完全磁盘访问引导；账号菜单多一行「本机 daemon」状态与动作；新版 supervisor 随 app 更新到来时只提示、从不自动重启。写出的
文件与 LaunchAgent 与 npm 版 `cofluxd` 完全同构，两边可互换：npm 装过的机器被识别为「已接入」并直接接管。

验收（用户人工，前端不由 Claude 走查）：一台没装 Node 的干净 Mac，拖入 dmg → 登录 → 引导两分钟内设备上线；开终端跑 claude，
里面 `cofluxd progress` 能在侧栏出现、插件 hook 生效；已用 npm 接入的机器升级 app 后不重复接入、状态行正确；带新 supervisor 的
app 更新只提示不自动重启。

### 产品结论（探索阶段已确认，勿再问）

1. **触发与入口**：登录成功后检测本机；未接入 → 工作台出接入引导（可「暂不」）；已接入 → 静默。之后从账号菜单「本机 daemon」
   再进。不放回「添加设备」对话框（那是给别的机器看的，保留 npm 命令）。
2. **接入引导流程**：
   ```
   [说明页] 把这台 Mac 接入 coflux
            会在本机常驻一个后台服务（开机自启），你和 agent 才能在这台机器上开终端。
            [接入]  [暂不]
   [进度页] ✓ 安装组件 → ✓ 启动服务 → ● 授权中…（用当前登录账号）      失败：该步红字 + [重试] [暂不]
   [FDA 页] 完全磁盘访问：终端里访问桌面/文稿/下载会被系统弹窗卡住，建议现在授予。
            [打开系统设置]（同时在 Finder 里定位 supervisor 二进制）  [我已勾选，重启服务]  [跳过]
   [完成页] 这台 Mac 已上线。 [开始使用]
   ```
   授权用当前登录态在 app 内完成，不开浏览器；进度页每步失败可重试，取消回到工作台。
3. **运行期界面**：账号菜单（plan 110 的脚部菜单）新增「本机 daemon」一行，状态之一：运行中 / 已停止 / 等待授权 /
   有更新待重启 / 未授予完全磁盘访问 / 未接入；动作：重启、停止、移除接入、打开完全磁盘访问引导、接入（未接入时）。
   状态行里能看到 `~/.coflux/bin` 路径提示（给想在自己终端里用 `cofluxd` 的人），不改用户 shell 配置。
4. **升级**：worker 照旧由中心热推。app 内置 supervisor 比在跑的新 → 状态「有更新待重启」，文案带「会结束本机 N 个终端」，
   用户点「重启」才换二进制并重启；**从不自动重启**。
5. **非目标**：Intel Mac 与 Linux（app 只出 arm64）；status/doctor/logs 等管理命令的 Rust 化（管理全在界面）；
   daemon 服务器地址另做选择（跟随 app 地址）；卸载时清凭证与配置（`--purge` 语义不做）；自动授予 FDA（macOS 不允许）。

## Decisions & tradeoffs

- **落盘布局与 LaunchAgent 与 npm 版 cofluxd 逐字同构**：二进制在 `~/.coflux/bin/{coflux-supervisor,coflux-worker,cofluxd}`；
  plist 在 `~/Library/LaunchAgents/com.coflux.daemon.plist`，内容等价于 `packages/cli/cofluxd.mjs:386-401` 的 `plistXml`
  （Label / ProgramArguments 指向 `~/.coflux/bin/coflux-supervisor` / `COFLUX_HOME` / RunAtLoad / KeepAlive / 日志路径）；
  `~/.coflux/settings.json` 照 `applyConfig`（`cofluxd.mjs:380-384`）写 `serverUrl`（app 的 client 地址把路径 `/client` 换成
  `/daemon`）与 `deviceName`（hostname），mode 0600。`COFLUX_HOME` 环境变量若设了就尊重它（cofluxd 同法 `cofluxd.mjs:34`）。
  Rejected: launchd 直接指向 `Coflux.app/Contents/Resources` 内的二进制 — app 更新会原地替换 .app、用户可能移动/重命名 .app，
  服务随之断掉；且与 npm 版不再互换。
- **落盘后对三件做 ad-hoc 重签 `codesign --force -s - <path>`**（`/usr/bin/codesign` 是 macOS 自带）。
  Based on: `cofluxd.mjs:138-150` 注释——新落盘二进制带 provenance，launchd 顶层 spawn 被 AMFI 以 OS_REASON_CODESIGNING 静默 SIGKILL，
  Developer ID + 公证的产物 2026-07-25 实测仍被杀；ad-hoc 重签是生产在用的解法。Rejected: 相信公证过的 .app 内产物拷出来还算「本机产物」——未验证，失败是静默的。
- **已接入 / 已登记 / 在跑 / FDA 的判定移植 `cofluxd.mjs:549-585`（cmdStatus）**：plist 与两个二进制都存在 = 已接入（不分 npm/app 来源）；
  `~/.coflux/credentials.json` 存在 = 已登记，否则读 `~/.coflux/pending-auth.json` = 等待授权；`launchctl print gui/<uid>/com.coflux.daemon`
  判活（照 `serviceRunningInfo`）；`~/.coflux/fda-status` 文本 granted/denied/unknown（`crates/supervisor/src/fda.rs:13-25`）。
  「本机」这台设备在目录里的身份 = `credentials.json` 的 `daemonId`（`crates/worker/src/creds.rs:13-14`），据此数本机运行中终端。
- **app 内授权的数据流**：主进程监视 `~/.coflux/pending-auth.json`，从其 `url`（形如 `<publicUrl>/authorize/<token>`）解析 token 并作为
  daemon 状态的一部分交给渲染层；渲染层用 112 提供的 `@coflux/client` `authorizeDevice(token)` 兑现。daemon 断线会清掉该文件并在
  重连后换新链接（`crates/worker/src/main.rs:1420` 注释），所以 token 以文件当前内容为准、过期即换。
  Rejected: 主进程自己发控制面消息 — 控制 WS 与登录态都在渲染层的 client store 里。
  Rejected: 打开系统浏览器走 `/authorize/<token>` 页面 — 产品结论要求不开浏览器；且桌面登录不给浏览器 cookie，用户得再登一次。
- **内置二进制来源（用户 2026-09-11 定）**：`.github/workflows/desktop-release.yml` 新增与「构建 + 签名 + 公证」并行的 job，在同一 SHA
  上 `cargo build --release --target aarch64-apple-darwin -p coflux-supervisor -p coflux-worker -p coflux-cli`，产物经 artifact 交给打包 job。
  **`COFLUX_RELEASE_VERSION` 打成可解析的 prerelease SemVer**（形如 `v0.0.0-desktop.<桌面版本，点分>`，须能被
  `crates/supervisor/src/upgrade.rs` 的 `ReleaseVersion::parse` 接受——它接受 `v` 前缀与 prerelease，见 779 行测试），**不能留默认 `dev`**：
  `dev` 解析失败会让内置 worker 版本变成字面 `builtin`（`crates/supervisor/src/main.rs:132-141`）、退出 anti-rollback 裁决。
  已接受的后果（写进 Maintenance notes）：中心 auto-update 一看 workerVersion ≠ latest 就热推正式 worker（`apps/server/src/auto-update.ts:170`），
  内置 worker 只是引导版；supervisor 永远是内置版；内置版本低于一切正式版，所以 npm 方向装过正式 supervisor 的机器不会被提示换成内置版。
  Rejected: 钉一个 daemon release 版本、CI 下载验签 — 用户以「一起 build、并行不费时间」否决。
  Rejected: 用 `github.ref_name`（`desktop-v0.1.7`）直接当版本 — 解析不成 SemVer。
- **内置版本号的读取来源是 sidecar 文件而不是 exec 二进制**：CI（与本机 pack）把版本戳写进与三件同目录的 `VERSION` 文件，一起进
  `extraResources`；主进程比较 sidecar 与 `~/.coflux/supervisor-version`（112 落盘，原文如 `v0.32.0` / `v0.0.0-desktop.0.1.7` / `dev`）。
  比较规则：两者都能按 SemVer 解析且内置严格更新 → 「有更新待重启」；在跑的解析不了（`dev`）或文件缺失（112 之前的老 supervisor）
  → 视为比内置旧、提示；内置解析不了 → 永不提示（本机 dev 构建）。
  Rejected: 主进程跑 `coflux-supervisor --version` — supervisor 没有该参数（`main.rs` 只读 env）。
- **electron-builder 侧**：三件 + `VERSION` 走 `mac.extraResources` 进 `Contents/Resources/<子目录>/`，**不进 asar**
  （`enableEmbeddedAsarIntegrityValidation: true`，`apps/desktop/electron-builder.yml`）；用 `mac.binaries` 显式列出三件，让 Developer ID +
  hardened runtime 签名并纳入公证；「校验签名 / 公证票据 / Gatekeeper」步骤（`desktop-release.yml:152-163`）加对三件的
  `codesign --verify --strict` 与存在性断言。本机 `pnpm -C apps/desktop run pack` 从一个显式输入（环境变量或参数，名字执行者定）
  指向本地 cargo 产物目录；输入缺失或目录不全时**打包失败**，不静默出无 daemon 的包。`apps/desktop/test/config.test.ts` 已对
  `extraResources` 做结构断言（41 行），新增项照它覆盖。
- **主进程边界与模块形态**：渲染层只拿一个 daemon 状态对象、只发窄动词（接入 / 授权 / 重启 / 停止 / 移除 / 打开 FDA 引导 /
  FDA 已勾选重启 / 暂不），桥接面不长出 fs / shell / 任意命令能力（`apps/desktop/README.md` 安全基线；类型真相源
  `apps/desktop/src/shared/desktop-bridge.ts`）。daemon 管理的判定、plist/settings 文本生成、pending-auth 解析、版本比较、状态派生全部写成
  **无 Electron 依赖的纯 TS 模块 + node:test**（照 `apps/desktop/src/main/settings.ts`、`update-state.ts` 先例），只在薄适配层碰
  `launchctl` / `codesign` / `fs.watch` / `shell.openExternal`。IPC 载荷与来源校验沿用 `ipc-trust.ts` / `ipc-sanitize.ts`。
  用户说过桌面后面可能换技术栈，纯模块要能原样带走。
- **升级与替换的原子性**：替换 `~/.coflux/bin` 三件（先落到同目录临时文件、重签、再 rename）与 `launchctl unload/load` 在用户点
  「重启」时一起做；**不**在 app 启动时预先替换文件。Rejected: 先落盘后等下次自然重启 — 制造「文件已新、进程仍旧」的第三态，状态行讲不清。
- **移除接入 = `cofluxd uninstall` 无 `--purge` 语义**（`cofluxd.mjs:846` 起）：unload 并删 plist、删三个二进制，保留 `~/.coflux`
  里凭证/配置/日志。二次确认走仓库现有确认框范式。
- **FDA 引导动作**：打开 `x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles` 并在 Finder 定位
  `~/.coflux/bin/coflux-supervisor`（`cofluxd.mjs:826-845` 的 `cmdFda`：授权对象是 supervisor 二进制本身，TCC 按 launchd 服务的
  responsible process 归属、一次授权覆盖全树；对已运行进程不生效，必须重启）。「我已勾选，重启服务」= 重启；状态以重启后
  `fda-status` 为准。Rejected: app 自己试读受保护目录判断 — 测的是 app 的权限不是服务的（`fda.rs:3-5` 注释）。
- **daemon 状态刷新机制留给执行者**（文件监听或轮询），但要求：pending-auth 变化在 2s 内反映到引导页；`launchctl` 查询不在渲染每帧、
  只在状态动作前后与低频定时触发。

## Direction

M1（CI 与打包）与 M2（主进程模块）**相互独立**、路径不相交，可并行为工作包；M3（渲染层）**依赖 M2** 的桥接类型与状态对象。
一个从 M2 到 M3 的契约：daemon 状态对象的形状与动词名在 M2 定义于 `apps/desktop/src/shared/desktop-bridge.ts`，M3 只消费。

### Milestone 1: 桌面发版流水线内置三件 + 本机 pack 路径

`desktop-release.yml` 多一个并行 job 从同 SHA 构建三件并交付给打包 job；electron-builder 配置把三件 + `VERSION` 放进
`Contents/Resources`、签名、公证、校验；`run pack` 有显式的本地产物目录输入且缺失即失败；`config.test.ts` 覆盖新配置项。
Validation: `pnpm -C apps/desktop test` -> exit 0；`pnpm -C apps/desktop build` -> exit 0。
（真实出包、签名、公证只能在 CI 上验，属 acceptance。）

### Milestone 2: 主进程 daemon 管理模块 + 桥接

纯模块：状态派生（未接入/已停止/运行中/等待授权/有更新待重启/FDA 未授予 及组合）、plist/settings 文本、pending-auth 解析、
版本比较、内置产物定位；适配层：落盘+重签+rename、launchctl 起停、fda 引导动作、文件监视；桥接：状态推送 + 窄动词；
IPC 校验沿用现有工具。纯逻辑全部有 node:test。
Validation: `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test` -> exit 0。

### Milestone 3: 渲染层接入引导 + 账号菜单状态行 + 升级提示

登录成功后按状态对象决定是否弹引导；引导四页与失败/重试/暂不路径；`authorizeDevice(token)` 接进进度页；账号菜单「本机 daemon」
行与动作；「有更新待重启」提示含本机运行中终端数。状态到文案/可见动作的映射是纯函数并有单测（照 plan 110 账号脚部
「展示映射」单测先例）。不由 Claude 做 UI 走查。
Validation: `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test` -> exit 0。

## Landmines

- **Fuses**：`runAsNode: false` → 不能用 `child_process.fork`，后台任务用 `utilityProcess`（`electron-builder.yml` 注释）；
  `onlyLoadAppFromAsar` / asar 完整性开着 → 任何打包后改 asar 的步骤启动即崩，二进制只能走 `extraResources`。
- **`resetAdHocDarwinSignature: true` 只对未签名本机 pack 有意义**（`electron-builder.yml`）；三件在 CI 上要被 Developer ID 签，
  `mac.binaries` 列出的路径是打包后 `.app` 内的相对路径，写法看 electron-builder 26 文档（锁 26，27 改配置结构）。
- **CI 签名两坑**：证书不走 `CSC_LINK` 而是导入临时 keychain + `CSC_NAME` 不带 `Developer ID Application:` 前缀
  （`desktop-release.yml:106-150` 注释）；`release-signing` environment 的 tag 规则须放行 `desktop-v*`（`docs/RELEASING.md`）。
  新增的并行 job 不需要签名 secret，别把它也挂到 `release-signing` environment 上排队等审批。
- 渲染层 build-id 取 git short SHA，checkout 需 `fetch-depth: 0`（`desktop-release.yml:64-67`）；并行 job 同样从 tag 的 SHA checkout。
- `cofluxd restart` 若在 coflux 终端里跑会自杀在 unload/load 之间（服务消失）；app 主进程不是 PTY 子进程不受影响——但本机冒烟时
  别在 coflux 终端里手动 `launchctl unload`。
- 未打包 dev 实例的 userData 是 `Coflux-dev`（`apps/desktop/src/main/index.ts:31-34`），但 `~/.coflux` 与 LaunchAgent 是全机唯一的：
  dev 实例接管的是同一个真实 daemon。本机开发时要么用 `COFLUX_HOME` 指到别处，要么明知会碰真 daemon。
- `pending-auth.json` 与 `credentials.json` 是 0600（`crates/worker/src/creds.rs:1, 19`），同用户可读；别把它们的内容写进
  `electron-log`（`~/Library/Logs/Coflux/main.log`），只记事件。
- 已用 npm 接入的机器（包括用户自己的）在 app 首次带新 supervisor 时：在跑的是 `v0.32.x` 正式版，内置是 `v0.0.0-desktop.*`，
  按比较规则**不**提示（内置更旧）；这是决策后果不是 bug。真正需要 112 的 PATH 前置时，这类机器走 `cofluxd update && cofluxd restart`。
- 引导页出现在登录成功之后，而离线冷启动（`offlineCatalog`，`apps/desktop/README.md`）没有 authOk——那时不弹引导，只在账号菜单里显示状态。
- `EnrollmentDialog`（`dialogs.tsx:208-244`）保留给「别的机器」，只需在文案里点一句「这台 Mac 用账号菜单里的接入」。

## Scope

In scope:
- `apps/desktop/**`（主进程新模块与测试、preload/shared 桥接类型、渲染层引导与账号菜单、`electron-builder.yml`、`package.json` scripts、`test/config.test.ts`、`README.md`）
- `.github/workflows/desktop-release.yml`
- `docs/RELEASING.md`（桌面版内置 daemon 的构建/版本戳说明）
- `README.md` 「用户侧：安装 daemon」补一句 macOS 走 Coflux.app

Out of scope:
- `crates/**`、`packages/client/**` — 112 已交付，本 plan 只消费
- `packages/cli/**`、`integrations/claude-plugin/**` — 零改动
- `.github/workflows/release.yml`、`manifest.json` 结构 — daemon release 不变
- `apps/server/**`、`proto/**` — 无需改动
- 自动更新检查频率、`autoInstallOnAppQuit` 等 electron-updater 行为 — 不碰

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| 桌面 typecheck | `pnpm -C apps/desktop typecheck` | exit 0 |
| 桌面单测 | `pnpm -C apps/desktop test` | exit 0 |
| 桌面构建 | `pnpm -C apps/desktop build` | exit 0 |
| 本机出包 (acceptance) | `cargo build --release --target aarch64-apple-darwin -p coflux-supervisor -p coflux-worker -p coflux-cli` 后按执行者定义的输入指向产物目录跑 `pnpm -C apps/desktop run pack` | `dist/mac-arm64/Coflux.app/Contents/Resources/<子目录>/` 含三件 + `VERSION`，`codesign -dv` 正常 |
| CI 出包 (acceptance) | 打 `desktop-v*` tag 触发 `desktop-release.yml` | 并行 job 绿、校验步骤对三件签名断言通过、公证通过 |
| 真机走查 (acceptance，用户人工) | 干净 Mac 装 dmg → 登录 → 引导 → 上线 → 终端里 `cofluxd progress` | 见 Requirement 的验收 |

## Done criteria

- [ ] All listed commands pass.
- [ ] 登录后本机未接入时出现引导；一键接入不开浏览器不开终端完成落盘、起服务、授权；FDA 页可打开系统设置并定位二进制；「暂不」可退出。
- [ ] 账号菜单「本机 daemon」行六种状态与对应动作齐全；npm 接入过的机器显示为已接入且不重复接入。
- [ ] 内置 supervisor 比在跑的新时只提示（含本机终端数），点「重启」才替换并重启；从无自动重启路径。
- [ ] 写出的 plist / settings.json / 二进制路径与 npm 版逐字同构，`cofluxd status`（npm 版）在 app 接入的机器上输出正常。
- [ ] Required tests exist and assert meaningful behavior（状态派生、版本比较、pending-auth 解析、plist 文本、展示映射、发布配置）。
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds（尤其：112 未交付 `authorizeDevice` / `supervisor-version` / `crates/cli`；electron-builder 大版本变了）。
- The outcome requires out-of-scope files（如发现必须改 supervisor 或服务端）。
- A validation command fails twice after one reasonable fix.
- A named assumption is false（如 launchd 起 ad-hoc 重签后的内置二进制仍被 AMFI 杀——这是本 plan 最大的未验证点，遇到即停并报告，不要换成别的绕法）。

## Maintenance notes

- 内置 worker 只是引导版：接入后中心会立刻把 worker 热推到最新正式版（`auto-update.ts:170`：版本不等于 latest 即推）。看到
  `~/.coflux/worker.active` 指向下载版而不是内置版是正常的。内置 supervisor 永远是在跑的那一个，改 supervisor 必须发新桌面版。
- 版本戳 `v0.0.0-desktop.<x.y.z>` 低于一切正式 `v*`：这是「npm 装的正式版机器不被提示换成内置版」的根源。若将来想让内置版接管
  这类机器，需要先决定版本序列怎么对齐（比如桌面流水线只在同 SHA 带 daemon `v*` tag 时用那个版本），不要只改比较规则。
- 桌面发版从此隐含 Rust 构建：`desktop-release.yml` 并行 job 用 `RUSTFLAGS=-D warnings`，daemon 侧的 warning 会让桌面发版红。
- 把 Rust `cofluxd` 也放进 daemon release 与 npm 版 `cofluxd update`，让 Linux/无头机也 npm-free，是后续 plan。
- 用户人工验收清单：干净 Mac 引导两分钟内上线；已 npm 接入的机器升级 app 后状态行正确；带新 supervisor 的 app 更新只提示。
