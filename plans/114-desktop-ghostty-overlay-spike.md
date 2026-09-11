# Plan 114: 桌面版终端换 Ghostty 的 spike——原生 NSView 叠层 + relay 字节改道，八道通过/否决门出结论

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 7deedfb..HEAD -- apps/desktop crates/supervisor/src/sessiond.rs packages/client/src/store.ts packages/client/src/device-router.ts apps/desktop/build/entitlements.mac.plist`

## Status

- Priority: P2
- Effort: L
- Risk: HIGH（主进程原生 addon：崩溃带走整个 app；libghostty 嵌入 API 上游未稳定；plan 100 的原生路线曾死于 Ghostty 崩溃根因未定位）
- Depends on: none
- Category: dx（spike / 可行性验证，不是产品功能）
- Execution: subagent（用户 2026-09-11 出发检查选「尝试驱动 codex 实现」：执行器为 Codex——`codex:codex-rescue` agent 或 `mcp__codex__codex`（sandbox `workspace-write`）；主会话编排与审查；Codex 不可用或不能在 worktree 内工作时回落宿主通用子 agent `model: opus` 并在报告里说明。连续自动推进、不再确认；push / PR / 合 main / 发版仍需用户明确要求）
- Planned at: `7deedfb`, 2026-09-11

## Requirement

桌面版（apps/desktop，Electron 44，只做 macOS 26+ arm64）的终端现在是 `@xterm/xterm` 6 + WebGL addon。用户想要真正的
Ghostty：GPU（Metal）渲染、原生 IME、正确的 grapheme 处理，并接受桌面版从此绑死 macOS。Electron 的网页里放不进 NSView，
所以"用 Ghostty"意味着一个 Node 原生 addon 把 Ghostty 的 AppKit 视图叠在 Electron 窗口的网页之上、网页在那块留空洞、
relay 来的终端字节改道喂给原生视图。这条路有多处可能一票否决的点（见"八道门"），在投入正式工程前需要一次有明确结论的 spike。

**本 plan 是 spike，不是产品功能**：
- 产出物是**结论**：八道门每一道 过/不过 + 证据（命令输出、数字、截图路径或人工步骤记录），写进本 plan 末尾的「Spike 结论」
  一节和 `plans/README.md` 状态列。结论要能直接回答"正式 plan 的范围是什么、有没有一票否决"。
- 代码留在分支 `dev/20260911-desktop-ghostty-spike` 作正式 plan 的底子；**不发版、不合 main、不进 release 流水线的默认路径**。
- Ghostty 路径**默认关闭**，由执行者定开关形态（环境变量或 dev 构建标记均可）；开关关闭时 xterm 路径行为与 main 完全一致。

依赖：Swift Package [Lakr233/libghostty-spm](https://github.com/Lakr233/libghostty-spm)（产品 `GhosttyKit` = 预编译静态 libghostty
XCFramework、`GhosttyTerminal` = AppKit `AppTerminalView` / `TerminalController` / host-managed I/O backend
`GHOSTTY_SURFACE_IO_BACKEND_HOST_MANAGED` / `ghostty_surface_write_buffer_replay`）。它周更跟 Ghostty 上游 main，Zig 0.16 编，
macOS 13+；host-managed/replay 是包维护者的补丁而非上游稳定 ABI。

### 八道门（验收契约，每道要证据；"不过"也是合法结论）

| 门 | 判据 | 证据形态 |
|---|---|---|
| G1 快照 grapheme 保真 | 同一输出（ZWJ 家庭 👨‍👩‍👧、旗帜 🇯🇵、肤色 👋🏽、组合音标 é（e+U+0301）、行尾宽字符换行）实时画面 == 断开后重新 attach 的画面 | 逐项对照表 + 两次画面截图/文本 dump；**不过则结论必须写明"正式 plan 必须扩到 daemon 快照兼容"** |
| G2 稳定性 | 持续输出下反复创建/关闭/重建 Tab ≥ 50 轮零原生崩溃；排队回调到达已关闭 Tab 不访问旧指针 | 压力脚本 exit 0 + 主进程无 crash log；**反复崩且定位不了直接判否，不许 JS 重试掩盖** |
| G3 中文 IME | 原生候选/组合/提交正确；组合中切 Tab 不漏字节到远端 | 人工步骤记录（写清操作与预期） |
| G4 快捷键与焦点 | Ghostty 视图有焦点时 ⌘T/⌘W/⌘N/⌘1-9 各只触发一次且字节不进远端；⌘C/⌘V 菜单复制粘贴可用 | 自动化能覆盖的用单测/脚本，其余人工步骤记录 |
| G5 几何 | 全屏进出、跨 DPI 显示器拖动、侧栏拖宽、窗口隐藏恢复、睡眠唤醒后叠层位置与尺寸正确 | 人工步骤记录 + 换算规则说明（CSS px / AppKit point / Metal pixel 分开） |
| G6 重连与 resize | 半截 UTF-8/CSI 边界、alt screen、重连 replacement 真清旧状态、resize 后首块输出按新列数解析、replay 不产生 DA/DSR 回写 | 脚本/单测 exit 0 |
| G7 签名与交付 | Developer ID + hardened runtime 签名（library validation 不关）的包在无开发工具链的干净机器上启动并开出 Ghostty 终端 | `codesign -dvv`/`otool -L` 输出 + 干净机器启动记录；本机无证书时记为"未验证"并写明缺什么 |
| G8 性能对照 xterm | 持续输出下输入延迟、主线程卡顿、在途队列峰值、RSS/Metal 内存、多隐藏 Tab CPU | 两列数字表（xterm vs Ghostty），测量方法可复现 |

## Decisions & tradeoffs

- **首个否决门是重连快照的 grapheme 保真，spike 不改 daemon**：重连快照由 supervisor 的 `vt100` 0.16.2 解析器按格重建 ANSI，
  而 vt100 按单个 `char` 宽度判宽、单格 22 字节存储，多码点 grapheme 在快照生成时就可能已丢。换 Ghostty 只保证实时输出正确，
  重新 attach 后画面可能仍坏。Rejected: 顺手改 supervisor 快照 — 那是另一个 plan 的范围，spike 只出结论。
  Based on: `crates/supervisor/src/sessiond.rs:239`（`parser: vt100::Parser<TitleCapture>`）、`:1313`（`render_row` 按 cell 重建）、
  `crates/supervisor/Cargo.toml:23`（`vt100 = "0.16.2"`）。
- **叠层方向：Ghostty NSView 叠在网页之上**，即先例 electron-libghostty 的 `addSubview:positioned:NSWindowAbove` 做法。
  Rejected: "透明网页在上、Ghostty 在下" — Electron 44.3.0 的 WebContentsView 透明背景可行，但 macOS 侧事件命中按子视图 bounds
  路由给 Chromium，透明像素与 CSS `pointer-events` 都不会穿透到原生兄弟视图，交互要全部手做，不是 spike 能验证的量。
  Rejected: Electron 44 实验性 sharedTexture — 需要 Ghostty 导出纹理 + 帧生命周期 + 原生 IME 宿主，记为叠层体验不可接受时的
  备选路线，本 spike 不做。Based on: `apps/desktop/src/main/window.ts:40`（普通 `BrowserWindow`，未用 BaseWindow/WebContentsView）。
- **DOM 遮挡只做最低限度**：顶部两条横幅改为占布局空间、终端 rect 从横幅下沿开始；changes 视图与模态框出现时隐藏原生视图；
  拖拽上传遮罩不处理（spike 禁用拖拽上传）。Rejected: 把横幅/弹窗重写成原生 — 正式 plan 的事。
  Based on: `apps/desktop/src/renderer/components/workbench/workspace-terminal.tsx:582`、`:593`（两条 absolute 横幅）、`:607`
  （changes 视图切换）、`terminal-pane.tsx:474`（拖拽遮罩）、`terminal-pane.tsx:469`（Tab 用 display:none 保活）。
- **工具链：SwiftPM 编 GhosttyTerminal 为 Swift 宿主动态库（窄 C ABI）+ 薄 ObjC++ Node-API addon**。GhosttyKit.xcframework 是
  **静态** libghostty；GhosttyTerminal 是要编译的 Swift 包，依赖 MSDisplayLink 与资源 bundle——不能只链一个 xcframework 就拿到
  Swift 封装。C ABI 至少覆盖：create(窗口句柄, rect, scale) / destroy / setFrame / setVisible / setFocus / write(bytes, replace?)
  / replay / resize 回调 / 输入回调（字节）/ 尺寸回调（cols, rows）/ OPEN_URL 回调 / 错误回调。addon 只做 Node-API 绑定与主线程
  投递，不含业务。Rejected: napi-rs — 核心是 AppKit/Swift/主线程生命周期，Rust 只多一层 FFI，仓库已有 Rust 不构成理由。
  Rejected: 先做成 `.framework` — spike 一个 dylib 足够。固定：包 revision（`Ghostty.ref` 里的上游 commit 一并记录）、二进制
  checksum、Swift 工具链版本，三者写进 native 目录的 README 或锁文件。目标只 arm64 + macOS 26+。
  Based on: libghostty-spm `Package.swift:18-30`（`GhosttyTerminal` 依赖 `GhosttyKit` + `MSDisplayLink`，`resources: [.copy(...)]`），
  `apps/desktop/electron-builder.yml:56`（`minimumSystemVersion: "26.0"`）、`:53`（`arch: [arm64]`）。
- **签名：`.node` 显式 asarUnpack；dylib 放实体路径；沿 `mac.binaries` 显式列举进 Developer ID + hardened runtime 签名；
  不关 library validation**。Apple 允许加载 Apple 签名或同 Team ID 的库，现有 entitlements 没关它，spike 也不关。是否要带 Swift
  compatibility 库由 `otool -L` 与干净机器启动结果决定。Rejected: 加 `com.apple.security.cs.disable-library-validation` — 降安全
  基线且掩盖真实交付问题。Based on: `apps/desktop/electron-builder.yml:49-52`（`mac.binaries` 列 daemon 三件的先例）、`:13`
  （`asar: true`）、`:21-26`（`enableEmbeddedAsarIntegrityValidation: true`、`onlyLoadAppFromAsar: true`：二进制只能走 unpack /
  extraResources）、`apps/desktop/build/entitlements.mac.plist`（只有 allow-jit / unsigned-executable-memory / dyld-env 三项）。
- **字节路径：网络连接留在渲染进程，在现有 consumer 边界改道 IPC 到主进程**。连接在渲染层建、含 localStorage 身份与
  direct/P2P 的 `RTCPeerConnection`，搬到主进程代价远超 spike。IPC 契约：每个 surface 有 `surfaceId + generation`；消息有序
  （create-ready、resize、replace/replay、delta、destroy、focus/occlude）；surface ready 后才允许上层 attach；replace 与 delta
  走**同一条**串行队列；按短时或字节阈值合并发送；有限在途字节额度 + 解析完成确认；超额时停该 surface 的增量消费并触发完整
  恢复（重新 attach 拿快照），**不丢 delta**；不用 `sendSync`，不每块 `invoke` 串行等待。Rejected: 主进程直接收 WebSocket —
  连带迁移 direct/P2P、身份存储与恢复语义。Rejected: 无界队列 — 该包 `receive` 对已挂 surface 的路径没有字节额度限制。
  Based on: `apps/desktop/src/renderer/pages/MainPage.tsx:12`（连接在渲染层建）、`packages/client/src/device-router.ts:786`
  （浏览器 RTCPeerConnection）、`:1895`（投递 consumer 前已推进 `outputSeq`——addon 队列失败后不能假装已消费）、
  `packages/client/src/store.ts:491`（consumer 区分 replace 与 delta）、
  `apps/desktop/src/renderer/components/workbench/terminal-pane.tsx:444-449`（`registerSessionConsumer` 回调：replace→reset，
  再 write——这是最短替换边界）；libghostty-spm `Sources/GhosttyTerminal/InMemory/InMemoryTerminalSession.swift:316`
  （`receive` 走普通 `ghostty_surface_write_buffer`，replay API 要自己调）、`:167`（未挂 surface 超 1 MiB 丢旧字节）、
  `InMemoryTerminalSurfaceAccess.swift:108`（已挂 surface 直接追加串行队列任务，无额度）。
- **输入与控制权门禁沿用现有语义**：键盘字节、resize、鼠标报告、粘贴、协议自动应答（DA/DSR 等）只在 `active && owned` 时发往远端；
  隐藏 Tab 不向远端发零尺寸；OPEN_URL 由宿主接管、沿用现有 http(s) 校验后交 `shell.openExternal`；原生"粘贴本地文件路径"对远端
  daemon 无意义，spike 直接禁掉。Rejected: 让 Ghostty core 自己开链接 — 该包在宿主不处理时直接调 `/usr/bin/open`，绕过校验。
  Based on: `terminal-pane.tsx:283-291`（onData/onResize 的 `active && controlState === "owned"` 门禁）、`:254-262`（display:none
  时 FitAddon 钳到 2×1 的防护，禁发零尺寸）、`apps/desktop/src/main/window.ts:62-72`（`openExternalIfHttp` 与 `will-navigate`
  拦截）、libghostty-spm `Sources/GhosttyTerminal/Controller/TerminalController+Callbacks.swift:43`（未处理时 `/usr/bin/open`）。
- **快捷键路径必须在 spike 里验证，不能沿用"键落到页面"的假设**：现在 ⌘T/⌘W 等菜单项 `registerAccelerator: false`，真正处理在
  网页 `keydown`；Ghostty 视图成为 first responder 后这条路径不再成立。执行者定分发方式（宿主命令分发经 addon 回调回渲染层，
  或让快捷键在菜单层注册），但结论必须满足 G4。Based on: `apps/desktop/src/main/menu.ts:22`、
  `apps/desktop/src/renderer/components/workbench/use-global-shortcuts.ts:89`。
- **验证分工**：G1/G2/G6/G8 必须有可重复的脚本或测试（输出生成器、压力循环、测量脚本进仓库）；G3/G4 人工部分/G5/G7 干净机器写成
  可照做的人工步骤并把执行者能做的部分（`codesign`/`otool` 输出）先做掉。前端 UI 走查按仓库惯例由用户人工做，不用 Playwright。

## Direction

新增 `apps/desktop/native/ghostty/`（名字执行者可调）承载 Swift 宿主库与 addon 源码、锁定信息与构建脚本；主进程新增 Ghostty
surface 宿主与 IPC 通道；渲染层在开关打开时把终端面板从 xterm 换成"占位 div + rect 同步 + 字节改道"，开关关闭时零改动。
里程碑 M1 与 M2 相互独立（在 addon 的 JS 侧接口上会合：一个 TS 类型文件定义 `create/destroy/setFrame/setVisible/setFocus/write/replay`
与回调事件的形状，M1 实现它、M2 消费它，谁先做谁落这个文件），M3 依赖 M1+M2，M4 依赖 M3。

### Milestone 1: 原生层可构建、可在无 UI 下反复创建销毁

Swift 宿主动态库（SwiftPM，锁定 libghostty-spm revision 与 checksum）暴露窄 C ABI；ObjC++ Node-API addon 绑定它；一个不依赖
Electron 的冒烟可执行文件或脚本（Swift test 或 node 脚本）在隐藏 NSWindow 里创建 surface → write 含多码点 emoji 的输出 → destroy，
循环 ≥ 50 轮不崩。
Validation: 构建命令（执行者补入 Commands 表）exit 0；冒烟脚本 exit 0。

### Milestone 2: 主进程 surface 宿主与 IPC 契约

主进程持有 surface 表（surfaceId + generation），实现有序消息、同一串行队列、合并发送、在途额度与确认、超额触发完整恢复；
渲染层桥（preload）暴露对应 API。队列/generation/额度逻辑写成纯 TS 可单测（沿用 `apps/desktop/src/main/*.test.ts` 的 node:test 形态）。
Validation: `pnpm -C apps/desktop test` exit 0，新增用例覆盖：乱序 generation 丢弃、replace 与 delta 顺序、超额停消费并发恢复请求、
destroy 后到达的回调被忽略。

### Milestone 3: 渲染层改道（开关打开时）

开关打开：终端面板渲染占位 div，ResizeObserver + 布局变化把 rect（CSS px + devicePixelRatio）同步给主进程；`registerSessionConsumer`
回调改为送 IPC；输入/resize/OPEN_URL 回调经门禁后走现有 `sendInput/sendResize/openExternal`；横幅占布局、changes/模态时隐藏原生
视图；Tab 切换同步 visible/focus；拖拽上传与剪贴板贴图在 Ghostty 路径禁用并给出提示。开关关闭：`git diff` 下 xterm 路径行为不变。
Validation: `pnpm -C apps/desktop typecheck` 与 `test` exit 0；开关关闭时现有终端相关测试全绿。

### Milestone 4: 八道门的装置与结论

输出生成器（G1/G6 用例集）、压力脚本（G2）、测量脚本（G8）进仓库；`run pack`/本机签名产物跑 G7 的 `codesign`/`otool`；G3/G4/G5/G7
的人工步骤写成清单。结论写进本文件末尾「Spike 结论」一节：每道门 过/不过/未验证 + 证据 + 对正式 plan 范围的影响。
Validation: 各脚本 exit 0；结论一节存在且八道门齐全。

## Landmines

- `pnpm -C apps/desktop pack` 会被 pnpm 内置 `pack` 截胡出 tgz，必须 `pnpm -C apps/desktop run pack`；本机 pack 要带
  `COFLUX_DESKTOP_DAEMON_DIR`（plan 113 的 `scripts/stage-daemon.mjs` 从显式输入目录取 daemon 三件）。
- `electronFuses.resetAdHocDarwinSignature: true`：未签名本机构建翻 fuse 后 ad-hoc 重签，ad-hoc 主程序 + hardened runtime 下能否加载
  ad-hoc dylib 与 Developer ID 情形不同，G7 结论要分开写。
- Bash 工具是 zsh：`"$VAR:path"` 里 `:a` 等修饰符会吃掉路径，`set -e` 不生效，多步脚本用 `&&` 串联。
- 会话在 worktree 里时 Bash 守卫会拦 `git -C ..`、`$(git …)`、复杂模板等复合写法，拆成单条跑。
- 旧原生客户端的补丁曾专门加过 resize fence：`git show 00ad1e2:apps/macos/Ghostty/apply-remote-io.py` 第 128-142 行——尺寸变化后的
  首块输出必须在 resize 落实后才解析，否则按旧列数换行。新包的 write 入口直接 processOutput，没有等价保障，G6 要专门测。
- 该包 1.4.x tag 整段撤回过、2.0.0 删过 `send(_:)`/`sendText(_:)` API；锁 revision 而不是 `from:` 范围。
- Xcode 27 要装 Metal toolchain 组件才能编该包；缺了报错不直观。
- 主进程 addon 的原生崩溃直接带走整个桌面 app，没有 renderer crash 那种隔离；所有回调必须投递主线程且校验 generation。
- `device-router.ts:1895` 在投递 consumer 之前就推进了 `outputSeq`：addon 侧队列失败不能靠"再要一次这段字节"补救，只能整体重新 attach。
- `apps/desktop/src/main/ipc.ts` 的现有 IPC 是"来源校验 + 窄动词、空载荷"风格（`ipc-trust.ts`）；终端字节通道是第一条高频大载荷通道，
  仍要过来源校验，但不要把每块字节当一次 `invoke`。

## Scope

In scope:
- `apps/desktop/native/**`（新增：Swift 宿主库、addon、锁定信息、构建脚本、冒烟）
- `apps/desktop/src/main/**`、`apps/desktop/src/preload/**`、`apps/desktop/src/shared/**`
- `apps/desktop/src/renderer/components/workbench/terminal-pane.tsx`、`terminal-panes.tsx`、`workspace-terminal.tsx`、
  `use-global-shortcuts.ts`、`desktop-bridge.ts` 及其测试
- `apps/desktop/package.json`、`apps/desktop/electron-builder.yml`、`apps/desktop/electron.vite.config.*`、`apps/desktop/README.md`
- `apps/desktop/scripts/**`（构建/测量/压力脚本）
- `plans/114-desktop-ghostty-overlay-spike.md`、`plans/README.md`

Out of scope:
- `crates/**`、`apps/server/**`、`proto/**` — 零 daemon/server/协议改动，G1 不过只记结论
- `packages/client/**` — consumer 边界在 terminal-pane，store/router 不动
- `.github/workflows/**` — spike 不进 release 流水线；G7 用本机签名验证
- `apps/desktop/build/entitlements.mac.plist` — 不关 library validation
- 主题同步、拖文件上传、剪贴板贴图、changes 视图联动、透明下置 / sharedTexture 路线 — 正式 plan 或备选路线
- 冻结的 web 站 — 与本 plan 无关

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Typecheck | `pnpm -C apps/desktop typecheck` | exit 0 |
| Unit tests | `pnpm -C apps/desktop test` | exit 0 |
| Renderer/main build | `pnpm -C apps/desktop build` | exit 0 |
| Native build | `node apps/desktop/native/ghostty/build.mjs` | exit 0 |
| Native smoke (M1) | `apps/desktop/native/ghostty/build/ghostty-smoke` | exit 0，≥ 50 轮 |
| G1/G6 用例集 | 执行者补入 | exit 0 |
| G2 压力 | 执行者补入 | exit 0，零崩溃 |
| G8 测量 | 执行者补入 | 输出两列数字表 |
| Pack (acceptance) | `COFLUX_DESKTOP_DAEMON_DIR=<dir> pnpm -C apps/desktop run pack` | exit 0，产物可启动 |
| G7 签名检查 (acceptance) | `codesign -dvv --verbose=4 <app>`、`otool -L <addon.node>`、`spctl -a -vv <app>`（有 Developer ID 证书时） | 记录输出到结论 |

## Done criteria

- [ ] All listed commands pass（执行者补入的命令一并列出并通过）。
- [ ] 开关关闭时 xterm 路径行为与 `7deedfb` 一致，现有终端相关测试全绿。
- [ ] 开关打开时能在真实 relay 会话里开出 Ghostty 终端、回显、输入、切 Tab、关 Tab。
- [ ] 八道门在「Spike 结论」一节各有 过/不过/未验证 + 证据；G1 不过时明确写出"正式 plan 必须扩到 daemon 快照"。
- [ ] 锁定信息（包 revision、上游 Ghostty commit、xcframework checksum、Swift 工具链版本）在仓库内可查。
- [ ] Required tests exist and assert meaningful behavior（M2 队列/generation/额度用例）。
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files（尤其是 `crates/**`、`packages/client/**`、entitlements）。
- A validation command fails twice after one reasonable fix.
- 原生崩溃反复出现且一轮定位后无法归因——这是 G2 的"不过"结论，停下来记录而不是继续加重试。
- libghostty-spm 锁定的 revision 无法构建（Zig/Xcode/Metal toolchain 缺失且非一条命令可补）。

## Maintenance notes

- 这是 spike：分支上的代码是正式 plan 的起点而非成品。正式立项时先读「Spike 结论」，按 G1 的结果决定范围是否含 daemon 快照。
- 若叠层体验（DOM 弹层被盖、焦点切换）不可接受，备选路线是 Electron sharedTexture（Ghostty 导出纹理进网页合成），需要另立 plan。
- libghostty 完整嵌入 API 上游未稳定；升级该包 revision 时按锁定信息重跑 M1 冒烟与 G2 压力。
- docs/ROADMAP.md:101 的"评估 ghostty-web"待办与本 plan 是两条路线：ghostty-web 是 WASM + Canvas，本 plan 是原生 Metal。
