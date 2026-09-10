# Plan 103: macOS 客户端改为 Electron 版——`apps/desktop` 打包当前 Web，删除 `apps/macos`

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 0e3c7ec..HEAD -- apps/web/src/config.ts apps/web/src/App.tsx apps/web/vite.config.ts apps/web/index.html apps/web/src/components/workbench/use-shortcut-modifier.ts apps/web/src/components/workbench/use-global-shortcuts.ts apps/web/src/components/workbench/sidebar.tsx apps/web/src/components/workbench/terminal-pane.tsx apps/web/src/components/workbench/workspace-terminal.tsx packages/client/src/store.ts packages/client/src/device-router.ts apps/server/src/local-control.ts apps/server/src/hub.ts crates/worker/src/gateway.rs .github/workflows/release.yml docs/RELEASING.md pnpm-workspace.yaml package.json apps/macos`

## Status

- Priority: P1
- Effort: L
- Risk: MED
- Depends on: none
- Category: feature
- Execution: subagent fable
- Planned at: `0e3c7ec`, 2026-09-11

## Requirement

用户 2026-09-11 决定：macOS 客户端不再走原生 Swift 路线（三次立项均未到 parity，第三次的 `apps/macos`
于 2026-09-10 合入 main、plan 100 未完成），改为 **Electron 版**。完成后仓库满足：

1. 新增 `apps/desktop`：Electron 壳把 **当前 `apps/web` 原样打包**进 app，功能零重写。用户在 Mac 上
   启动 app → 登录 → 看到与浏览器一致的工作台（侧栏/终端/变更页/导入向导/对话框全部沿用 Web）。
2. 首发四项桌面集成（用户四项全选，缺一不算完成）：
   - **原生菜单 + 纯 ⌘ 快捷键**：⌘T/⌘W/⌘N/⌘1-9/⌘[ ] 不再被浏览器抢，桌面下等价于 Web 已有的
     PWA standalone 键位方案。
   - **系统通知 + Dock 角标**：某工作区的 agent 进入「等待批准」或「等待回答」时弹 macOS 通知，Dock
     角标显示待处理工作区数；点通知把窗口带到前台并选中该工作区。状态来源就是侧栏现有的
     approval/question 聚合，不新增服务端数据。
   - **签名公证 + 自动更新**：CI 产物用 Developer ID 签名 + 苹果公证，在干净机器过 Gatekeeper；新版本
     发布后 app 内自动更新。
   - **中心离线也能冷启动看本机终端**：UI 随 app 打包（不是远程加载 app.coflux.dev），中心不可达时
     冷启动仍能进入工作台并通过 loopback direct 打开本机 daemon 的终端（与浏览器「已加载页面在中心
     停止后仍可 attach」同一契约，只是把「已加载」推进到冷启动）。
3. `apps/macos` 整目录删除（正向删除 commit，git 历史可找回），plan 100 标 WITHDRAWN，文档不再描述
   原生路线为进行中；`packages/swift-client` 与 `apps/ios` 不受影响。
4. 版本准入不放宽：桌面 build-id 与部署的 web 同 SHA 才被中心接受；被拒时 app 显示「需要更新」并触发
   更新检查，不当作断线。

### 产品结论（探索阶段已确认，勿再问）

- **消费者**：用户本人在 Mac 上的日常工作台，替代浏览器 tab/PWA 与现在的原生 app。对齐目标是当前
  `apps/web`，**不是** `apps/macos`。
- **形态**：Web 工作台原样跑在 Electron 窗口里。授权页 `/authorize/<id>`、OAuth 同意页、proxy-auth、
  端口预览、终端输出里的链接一律交系统默认浏览器；桌面 app 只承载主工作台（`/`）。
- **窗口**：隐藏标题栏 + 红绿灯内嵌到侧栏顶部（IDE 式），原生菜单栏（App/Edit/View/Window/Help 级别
  的常规结构，细节执行者定）。登录/错误/断线状态沿用 Web。
- **非目标**：不捆绑 daemon（仍由 `cofluxd` 安装）、不做 Windows/Linux 首发（代码保持可移植即可）、
  无 Tray/菜单栏常驻、不上 Mac App Store、终端仍是 xterm.js + WebGL（不追 Ghostty）、不升级
  `@xterm/xterm`、不做深链接。
- **验收（用户可观察）**：启动 app → 登录 → 与浏览器一致的工作台；⌘T/⌘W/⌘N/⌘1-9 生效且不关窗口/
  不开新 Tab；agent 等待批准时收到 macOS 通知与 Dock 角标、点击聚焦该工作区；端口预览在默认浏览器
  打开；中心断线后冷启动仍能打开本机 daemon 的终端；发布新版本后 app 自动更新；CI 签名公证产物在
  干净机器过 Gatekeeper。UI 走查按惯例由用户人工验收，不用 Playwright。

正确解与相邻错误解：正确解是 **同一份 `apps/web/src` 打进 Electron，桌面差异靠运行时探测的桥接
注入，server/daemon 校验零放宽**。把 Web 组件复制一份到 `apps/desktop`、生产加载远程 URL、为了让
loopback 跑通而放宽 server 的 Origin 校验、把桌面 build-id 硬编码成 `dev` 绕过准入、只删
`apps/macos` 里一部分——都不是本需求的完成态。

## Decisions & tradeoffs

- **技术栈**：Electron 44.x + electron-vite 5.0.x + electron-builder 26.15.x（锁 26.x）+
  electron-updater 6.8.x。Rejected: Electron Forge（官方 Vite 模板仍标 experimental 且钉 Vite 5，
  对 pnpm workspace 支持是 open issue，自动更新只有 Squirrel.Mac）；vite-plugin-electron（社区
  规模小）；electron-builder 27（改了 `mac.universal` 配置结构，等稳定再迁）。Based on: 2026-09-11
  调研——Electron 44.3.0 为 npm latest（Chromium 152 / Node 24，要求 macOS 13+）；electron-vite
  5.0.0 peer `vite ^5||^6||^7`，与 `apps/web/package.json` 的 `vite ^6.0.7` 兼容；主进程 ESM 自
  Electron 28 起可用。
- **渲染层随 app 打包，经自定义 scheme 提供**：用 `protocol.registerSchemesAsPrivileged`（standard +
  secure + supportFetchAPI）注册一个 app 专用 scheme，`protocol.handle` 从 asar 提供 `apps/web`
  的构建产物；**生产构建不加载任何远程 URL**。Rejected: 远程加载 app.coflux.dev——与「中心离线冷启动」
  直接冲突。Rejected: `file://`——非 standard scheme，IndexedDB/相对路径/安全上下文都不可靠。Based on:
  `packages/client/src/browser-identity.ts:5-12` 的 P-256 身份存 IndexedDB、需要稳定 origin 与安全
  上下文；`apps/web/src/App.tsx:9-22` 按 `location.pathname` 选页面，scheme URL 的 pathname 必须是
  `/` 才落到 MainPage。scheme 名由执行者定，但**不得**占用 `coflux://`（留给将来深链接）。
- **UI 单一真相 = `apps/web/src`**：`apps/desktop` 的 renderer 构建直接消费 `apps/web` 的源码与
  vite 插件链（react compiler、tailwind、`@` alias、build-id 注入），不复制任何组件/样式/页面。
  Rejected: 在 `apps/desktop` 另起一份 UI 或 fork 组件——AGENTS.md 明确 `apps/web` 是默认迭代对象，
  两份 UI 会重演 mobile 冻结的历史。具体接法（electron-vite renderer `root` 指向 `apps/web` vs 入口
  文件 import `apps/web/src/main.tsx`）是执行者的设计，约束是 `pnpm -C apps/web build` 的浏览器产物
  与行为零变化。Based on: `apps/web/vite.config.ts:38-70`（插件链与 `resolveBuildId`）。
- **桌面差异一律运行时探测桥接对象，不做构建期分叉**：preload 经 `contextBridge` 暴露一个最小桥接
  对象（命名执行者定），Web 代码用「桥接对象存在」判断桌面环境；浏览器里桥接不存在，代码路径与现在
  完全一致。Rejected: `import.meta.env.VITE_DESKTOP` 之类编译期开关——会产生两份 Web 产物、让
  `apps/web` 的浏览器构建与桌面构建分叉。Based on:
  `apps/web/src/components/workbench/use-shortcut-modifier.ts:13`（standalone 已是运行时探测的
  先例）。桥接面只允许：`serverUrl`、`origin`、`notify`、`setBadge`、聚焦回调（主进程→渲染进程
  「选中工作区 X」）、以及执行者认为通知点击/更新提示必需的最小项；**不暴露** Node/fs/shell 通用能力。
- **服务器地址来自桥接**：桌面下 `SERVER_URL` 由桥接给出（默认 `wss://api.coflux.dev/client`，可在
  app 侧配置自托管地址；dev 默认 `ws://localhost:8787/client`），浏览器下沿用现有推导。Rejected:
  沿用 `location.host` 推导——自定义 scheme 下没有可用 host。Based on: `apps/web/src/config.ts:1-3`。
- **Origin：主进程改写两条 WebSocket 握手头，server/daemon 校验零放宽**。主进程用
  `session.webRequest.onBeforeSendHeaders` 在中心 `/client` 握手与 loopback `ws://127.0.0.1:*/device`
  握手上写入**同一个稳定的 https Origin**；Web 侧经 `deviceTransport.origin` 把同一值作为自报 origin
  上报。Origin 值要求：`https:`、跨版本不变、与 Web 的 origin（app.coflux.dev）**不同**（让 grant 列表里
  能区分桌面 app），不要求可解析；具体字符串执行者定并写进 Maintenance notes。Rejected: 放宽
  `validOrigin` 接受自定义 scheme——plan 083 原生路线曾把「放宽 server/daemon 校验」列为 STOP 条件，
  本计划沿用。Rejected: 复用 `https://app.coflux.dev` 作 Origin——grant 不可区分。兜底（仅当
  Chromium 不接受改写 WebSocket 握手的 Origin 时）：用固定 loopback HTTP 端口提供渲染层以获得 http
  Origin，同样零放宽；兜底启用须在 plan 里记录证据。Based on:
  `apps/server/src/local-control.ts:415-418`（`validOrigin` 只接受 http/https 且要求 `parsed.origin
  === origin`）；`apps/server/src/hub.ts:206-207`（pair 请求自报 origin 必须与 `/client` 握手实际
  Origin 精确相等）；`crates/worker/src/gateway.rs:168-176`（daemon 按中心下发的 origin 白名单拒绝
  loopback 握手）；`packages/client/src/store.ts:317`（`origin: options.deviceTransport.origin ??
  location.origin` 现成注入口）；Electron webRequest 文档：`onBeforeSendHeaders` 的 `resourceType`
  含 `webSocket`，回调可替换 `requestHeaders`（2026-09-11 经 Context7 核实）。
- **通知/角标由渲染进程按 store 状态变化驱动，主进程只执行**：渲染进程观察工作区活动状态的
  「进入 approval/question」转变，去重后调桥接 `notify`/`setBadge`；主进程不建立自己的中心连接。
  Rejected: 主进程另起 WebSocket 订阅——两份连接、两份状态机、抢 holder。Based on:
  `apps/web/src/components/workbench/sidebar.tsx:23-24`（approval/question 文案与聚合已在渲染层）。
  通知去重规则（同一工作区同一状态只提醒一次，恢复后再进入才再次提醒）与点击聚焦实现是执行者的设计。
- **快捷键：桌面 ≡ standalone**：桌面下 `use-shortcut-modifier` 的判定结果等价于 standalone（纯 ⌘），
  菜单项的 accelerator 与 Web 的物理键位一致，且 ⌘W/⌘T/⌘N 由页面处理而不是关窗/新窗。Rejected:
  另写一套桌面键位。Based on: `use-shortcut-modifier.ts:6-13,30-36`、
  `apps/web/src/components/workbench/use-global-shortcuts.ts:43-58`。
- **外链与新窗口一律系统浏览器**：`setWindowOpenHandler` 拒绝在 app 内开窗，仅 `http(s)` 交
  `shell.openExternal`；`will-navigate` 拦截离开 app scheme 的导航。Based on:
  `apps/web/src/components/workbench/workspace-terminal.tsx:730`（端口预览 `window.open`）、
  `terminal-pane.tsx:217`（WebLinksAddon 默认 `window.open`）。
- **版本准入 lockstep，零 server 改动**：桌面渲染层的 build-id 复用 `resolveBuildId`（git short SHA），
  与部署的 web 同 SHA 即被中心接受；被拒（版本失配）时 app 显示「需要更新」并触发 electron-updater
  检查，不显示为普通断线/重连。过渡期由运维用现成的 `COFLUX_BUILD_ID` env 并集手动放行旧桌面版。
  Rejected: server 维护一份桌面 build-id 列表——引入 server 改动且弱化 plan 033 的准入语义。Rejected:
  桌面固定上报 `dev`——绕过准入。Based on: `apps/server/src/hub.ts:2973-2986,3071-3086`（允许集合 =
  env 显式覆盖 ∪ build-id.txt 文件；`dev` 总放行）；`apps/web/vite.config.ts:12-21`。文档：在
  `docs/RELEASING.md`（或 deployment.md）写明「桌面发版与 prod 部署用同一 SHA，否则桌面版被踢直到更新」。
- **发布：`desktop-v*` tag 触发独立 workflow，arm64 首发，签名公证复用现有 secret**：新建
  `.github/workflows/desktop-release.yml`（macos runner），hardened runtime + entitlements +
  `@electron/notarize`（notarytool）；签名身份与六个 `release-signing` environment secret
  （`MACOS_CERT_P12` / `MACOS_CERT_PASSWORD` / `APPLE_TEAM_ID` / `NOTARY_API_KEY_P8` / `NOTARY_KEY_ID`
  / `NOTARY_ISSUER_ID`）复用，只按位置引用、不复制值；universal 只作为配置开关，不首发。Rejected:
  搭 daemon 的 `v*` tag 与 `release.yml`——daemon SemVer 与桌面版本节奏无关，且 release.yml 是
  cofluxd 链路（plan 087 明确不动它）。Based on: `.github/workflows/release.yml:112-113,144-188`；
  `docs/RELEASING.md` 的 secret 表。
- **updater 源优先 Cloudflare R2**（用户 2026-09-11 补充）：CI 经 S3 兼容 API 把安装包与
  `latest-mac.yml` 推到 R2 bucket，app 内 electron-updater 用 `generic` provider 读 R2 的公网自定义
  域名。bucket / S3 端点 / access key / secret / 公网域名作为**新** secret/变量由用户提供；
  workflow 缺任一项必须**明确失败**，不得静默跳过上传或回退到别的源。GitHub Release 可选放 release
  note 与安装包镜像，**不**作 updater 源。Rejected: electron-updater GitHub provider（仓库虽公开，
  但用户明确要 R2；GitHub 下载在国内不可靠）。上传方式（electron-builder `s3` provider 带 endpoint
  或 CI 单独上传步骤）执行者定。
- **安全基线不放宽**：`sandbox`/`contextIsolation` 保持默认开、`nodeIntegration` 关；Fuses 关
  `RunAsNode`、`EnableNodeOptionsEnvironmentVariable`、`EnableNodeCliInspectArguments`、
  `GrantFileProtocolExtraPrivileges`，开 `EnableCookieEncryption`、
  `EnableEmbeddedAsarIntegrityValidation`、`OnlyLoadAppFromAsar`；渲染层响应带 CSP
  （`script-src 'self'` 级别，允许 WebGL/WebRTC/WebSocket 到中心与 127.0.0.1）；
  `setPermissionRequestHandler` 默认拒绝（通知权限走主进程 Notification，不需要渲染层权限）；
  `ipcMain.handle` 校验 sender。Rejected: 为省事关 sandbox 或给 preload 开 Node 集成。
- **删除 `apps/macos` 用正向删除 commit，先抢救可复用资产**：`apps/macos/Sources/AppIcon.icon`
  （Icon Composer 文档，与 Web/iOS 同一「>-」记号）挪进 `apps/desktop` 作为图标源（导出 icns 的方式
  执行者定）；`apps/macos/scripts/dev-fixture.mjs`（隔离 DB/HOME/设备联调脚本）若桌面验证要用则挪到
  `scripts/`；其余整目录 `git rm -r`。不 rebase、不改历史。plan 100 在 `plans/README.md` 标
  WITHDRAWN（注明 2026-09-11 改道 Electron、代码可从 git 历史找回）；`docs/ROADMAP.md` 第 4 节
  （现仍写「已撤回 2026-08-26」，与第三次立项脱节）改写为 Electron 现状；`docs/architecture.md`、
  `README.md` monorepo 表、`AGENTS.md` 增 `apps/desktop` 条目、去掉 `apps/macos`。Based on:
  `plans/087-withdraw-macos-native-client.md` Decisions（正向删除、plan 文件保留、release.yml 不动）；
  `apps/macos` 当前 476 个文件、87MB（NativeGrammars 82MB）、无 iOS/CI 引用。
- **不升级 `@xterm/xterm`**：终端渲染沿用 `apps/web` 现状（6.0.0 + WebGL addon + IME 补丁）。
  Based on: `apps/web/src/components/workbench/terminal-pane.tsx:226-231`（WebGL 动态导入与
  `onContextLoss` 兜底已在）；同文件 `patchImeCommittedInput` 依赖 6.0.0 内部字段，升级须复验中文 IME。
- **位置与工作区配置**：`apps/desktop` 自动被 `pnpm-workspace.yaml` 的 `apps/*` 纳入；`electron`
  写进 `allowBuilds`；根 `package.json` 加 `dev:desktop`。不引入 node-pty 等原生模块（本项目 PTY
  在 daemon）。Based on: `pnpm-workspace.yaml`（`allowBuilds: esbuild: true` 先例）。

## Direction

四个里程碑，M1 是其余三个的前置（桥接与 `apps/desktop` 目录都在 M1 产生；M4 抢救图标也依赖它）。
M2/M3 都改 `apps/desktop` 的主进程与配置文件，M4 与 M2/M3 无共享文件但 README/docs 收口要引用最终
形态——**按一个工作包执行，不拆包**。

### Milestone 1: Electron 壳跑起当前 Web，direct/P2P/relay 三路零放宽可用

`apps/desktop` 存在并可构建（main/preload/renderer 三份产物）；dev 模式起 electron-vite 并连本机
中心；生产构建从 asar 经自定义 scheme 加载 `apps/web` 产物，pathname `/` 落到 MainPage；桥接对象提供
serverUrl/origin；主进程在两条 WebSocket 握手上写入稳定 https Origin，Web 经 `deviceTransport.origin`
上报同值；`apps/web` 浏览器构建与行为零变化；`AppIcon.icon` 已挪入 `apps/desktop`。
Validation: `node_modules/.bin/tsc -b apps/web/tsconfig.json` → exit 0；`pnpm -C apps/web build`
→ exit 0 且 `apps/web/dist/build-id.txt` 存在；`pnpm test:web` 全过；`ci.yml` 里 client 状态机测试
命令全过；`apps/desktop` 类型检查与 `pnpm -C apps/desktop build` → exit 0；新增单元测试覆盖：
Origin 改写的判定函数（哪些 URL 改、改成什么、非 WebSocket 不改）、Web 的桥接探测与 `SERVER_URL`
解析（有桥接/无桥接两态）。

### Milestone 2: 桌面集成——菜单、纯 ⌘ 快捷键、通知、角标、外链

原生菜单与 accelerator 就位；桌面下快捷键判定等价 standalone；工作区进入 approval/question 时通知 +
角标、恢复后清零、点击通知聚焦工作区；`window.open`/链接一律系统浏览器；`will-navigate` 拦截。
Validation: 类型检查与 M1 全部命令仍过；新增单元测试覆盖通知去重/角标计数的纯函数（从两次工作区
活动快照算出「新进入等待的工作区」与角标数）。

### Milestone 3: 版本准入处理、打包、签名公证、R2 更新源、发布 workflow

版本被拒 → 「需要更新」提示 + 触发更新检查；electron-builder 配置（mac arm64、hardened runtime、
entitlements、notarize、Fuses、publish 到 R2 generic）；`.github/workflows/desktop-release.yml`
（`desktop-v*` tag 触发，签名/公证/上传，缺 secret 明确失败）；`docs/RELEASING.md` 增桌面发版章节
（含 lockstep 规则与 R2 secret 清单，只写名字与位置）。
Validation: 类型检查过；新增单元测试覆盖「认证被拒错误 → 更新提示状态」的映射；workflow 与
builder 配置能被解析（执行者选一种 exit-code 可查的方式，如 YAML/JSON 解析脚本）。

### Milestone 4: 删除 `apps/macos`，文档与 plans 索引收口

`apps/macos` 不在 `git ls-files` 中；`docs/ROADMAP.md`、`docs/architecture.md`、`README.md`、
`AGENTS.md` 反映 Electron 现状且无指向已删文件的链接；`plans/README.md` 100 标 WITHDRAWN、103 状态
更新。Validation: `git ls-files apps/macos | wc -l` → 0；`grep -rn 'apps/macos' README.md AGENTS.md
docs/*.md` 只剩历史性描述（标明已删除）而无活链接；`git diff --check` → exit 0。

## Landmines

- **Origin 是硬门槛**：`apps/server/src/local-control.ts:415-418` 拒绝非 http/https origin；
  `hub.ts:206-207` 要求自报 origin 与握手 Origin 精确相等；daemon `gateway.rs:168-176` 白名单是
  中心按 grant 下发的（`local-control.ts:354-355`）。自定义 scheme 下不改头，direct 永远配不上，
  但 relay 仍通——**别把「relay 能用」误判为 direct 成功**，按 `docs/architecture.md:363-369` 的方法
  用 `lsof` 看 Electron 进程与 `coflux-worker` 的 `127.0.0.1:8788` ESTABLISHED。
- **通知在未签名构建上直接失败**（Electron 42 起 macOS 用 UNNotification）：本机若无 Developer ID
  身份，通知/角标只能用 CI 签名产物验收；不要因此在代码里加「未签名就用 HTML5 Notification」的分叉。
- **Fuses 副作用**：关 `RunAsNode` 后 `child_process.fork` 失效（后台任务用 `utilityProcess`）；开
  ASAR integrity 后任何打包后处理改 asar 都会启动即崩——签名/公证步骤顺序要在 workflow 里对。
- **pnpm 11 拦截依赖 build 脚本**：`electron` 要进 `pnpm-workspace.yaml` 的 `allowBuilds`，否则
  安装后二进制缺失且报错不直观。
- **`apps/web/index.html` 的资源与路由假设**：`<link rel="manifest" crossorigin="use-credentials">`、
  `/favicon.svg` 等绝对路径、`App.tsx` 按 `location.pathname` 选页——自定义 scheme 必须是 standard
  scheme 且带 host（形如 `scheme://app/`），vite `base` 保持 `/`，动态导入的 WebGL chunk 才能解析。
- **build-id 与 dev**：`resolveBuildId` 在 `vite dev` 固定 `dev`（中心总放行），生产构建取 git SHA——
  CI 打包必须在有 git 历史的 checkout 里跑（`fetch-depth` 别设 1 之外还丢了 HEAD）。
- **lockstep 有意为之**：桌面版落后 prod 部署时被踢，是设计不是 bug；不要为此在 Web 端把版本拒绝
  当成可重试的断线循环重连。
- **`apps/macos` 体量**：476 文件、87MB（NativeGrammars 82MB 生成的 parser.c）、10 个 commit；
  正向 `git rm -r`，不 rebase；`.github/workflows/ci.yml` 与 iOS 工程均无引用（2026-09-11 已核）。
- **不要碰 loopback grant/lease 语义**：主进程只改 Origin 头；pair/grant/lease/P2P（WebRTC 在渲染
  进程）全部原样。
- **并行分支**：`dev/20260911-agent-cwd-workspace` 已占 plan 102（同日另一会话），合并时
  `plans/README.md` 会冲突，按行合并即可；不要改动 102 的行。
- **`docs/ROADMAP.md:78-85` 第 4 节文字仍是「已撤回 2026-08-26」**，与第三次立项脱节，改写时以本计划
  为准，不要「恢复」成原生进行中。

## Scope

In scope:
- `apps/desktop/**`（新）
- `apps/web/src/**`（桥接探测、`config.ts` 服务器地址、`deviceTransport.origin`、通知/角标驱动、
  快捷键 standalone 等价；浏览器行为零变化）、`apps/web/vite.config.ts`（仅当复用插件链需要导出）
- `packages/client/src/**`（仅当需要暴露 origin/桥接相关类型的最小改动）
- `package.json`、`pnpm-workspace.yaml`、`pnpm-lock.yaml`
- `.github/workflows/desktop-release.yml`（新）；`.github/workflows/ci.yml` 仅加 `apps/desktop`
  的类型检查/构建门
- `docs/RELEASING.md`、`docs/deployment.md`、`docs/ROADMAP.md`、`docs/architecture.md`、`README.md`、
  `AGENTS.md`
- `plans/README.md`、`plans/103-desktop-electron-client.md`
- `apps/macos/**`（删除；`AppIcon.icon` 与 `scripts/dev-fixture.mjs` 迁出）、`scripts/`（承接迁出脚本）

Out of scope:
- `apps/server/**`、`crates/**`、`proto/**` — 零放宽原则，Origin/准入靠客户端侧满足
- `apps/ios/**`、`packages/swift-client/**` — iOS 唯一消费者，不动
- `apps/mobile/**` — 冻结端，只跑构建门
- `.github/workflows/release.yml`、`npm-publish.yml` — daemon/CLI 链路
- Windows/Linux 打包、Tray、深链接、捆绑 daemon、`@xterm/xterm` 升级 — 非目标

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| 依赖安装 | `pnpm install`（lockfile 变更后；未变更用 `--frozen-lockfile`） | exit 0 |
| web 类型检查 | `node_modules/.bin/tsc -b apps/web/tsconfig.json` | exit 0 |
| web 生产构建 | `pnpm -C apps/web build` | exit 0，`apps/web/dist/build-id.txt` 存在 |
| web 单元测试 | `pnpm test:web` | 全过 |
| client 状态机测试 | `.github/workflows/ci.yml:156` 那条命令（DeviceRouter transport/holder/ACK） | 全过 |
| desktop 类型检查 + 构建 | `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop build`（脚本名执行者定，写进 plan 与 README） | exit 0 |
| desktop 单元测试 | `pnpm -C apps/desktop test`（Origin 判定、通知去重、版本拒绝映射） | 全过 |
| mobile 构建门 | `pnpm -C apps/mobile build` | exit 0（共享层未弄坏冻结端） |
| 格式 | `git diff --check` | exit 0 |
| 未签名包可启动 (acceptance) | `pnpm -C apps/desktop exec electron-builder --mac --dir` 后启动 `.app` | 到登录页，无 CSP/scheme 报错 |
| 三路联调 (acceptance) | 隔离 fixture 起中心 + daemon，桌面 app 登录、开终端 | direct 由 `lsof` 证明；P2P/relay 各一次；daemon 日志/中心观测到的 Origin 与自报一致 |
| 离线冷启动 (acceptance) | 中心停掉后冷启动 app | 能进工作台并 attach 本机 daemon 终端 |
| 签名公证 (acceptance) | 推 `desktop-v*` tag 跑 workflow（需用户提供 R2 secret 并自行下令） | 产物公证通过、R2 上有 `latest-mac.yml`、干净机器过 Gatekeeper |
| iOS 共享核心不受影响 (acceptance) | `swift test --package-path packages/swift-client` | exit 0 |

## Done criteria

- [ ] 上表非 acceptance 命令全部通过；acceptance 项由验证方在代码审查后跑，签名/发布类由用户另行下令。
- [ ] 桌面 app 从打包产物冷启动到登录页，登录后工作台与浏览器一致；direct/P2P/relay 三路可用且
      server/daemon 未改动。
- [ ] ⌘T/⌘W/⌘N/⌘1-9 在桌面下按 Web 语义生效；通知/角标/点击聚焦按 Requirement 描述工作（签名产物）。
- [ ] 版本失配显示「需要更新」并触发更新检查；R2 generic 更新源与 `desktop-v*` workflow 就位。
- [ ] `apps/macos` 已删除、图标已迁出；plan 100 标 WITHDRAWN；docs 无悬空链接。
- [ ] 所需测试存在且断言真实行为（Origin 判定、桥接探测/地址解析、通知去重、版本拒绝映射）。
- [ ] 实现遵守 Decisions & tradeoffs 每一条；偏离必须在 plan 里记录。
- [ ] 无范围外文件改动。
- [ ] `plans/README.md` 状态已更新（103 与 100）。

## STOP conditions

- Decisions 引用的事实不再成立（尤其 `validOrigin`、`hub.ts` 准入、`store.ts:317` 注入口、
  `use-shortcut-modifier` 的 standalone 判定）。
- Origin 改写在 server/daemon 侧观测不到期望值，且固定 loopback HTTP 端口的兜底也不可行——不得
  改 `apps/server`/`crates` 放宽。
- 任何里程碑需要改 `apps/server`、`crates`、`proto` 才能完成。
- electron-vite 5 与项目的 Vite 6 / TypeScript 7 组合无法在 `apps/desktop` 内隔离解决兼容问题。
- 验证命令经一次合理修复后仍连续失败两次。
- 需要触及 `apps/ios`、`packages/swift-client` 或 `apps/mobile` 功能。

## Maintenance notes

- Electron 每 8 周一个大版本、只支持最近三个；升级要看 breaking-changes（44 已把 `clipboard` 从
  渲染进程移除）。electron-builder 27 会改 `mac.universal` 配置结构，升级时迁配置。
- 桌面 Origin 字符串一旦发布就是 grant 绑定的一部分，改它等于让所有桌面 grant 失效——执行者把最终值
  写在这里：`https://desktop.coflux.dev`（`apps/desktop/src/main/origin.ts` 的 `DESKTOP_ORIGIN`；主进程
  对渲染层发起的每条 WebSocket 握手都改写，含 relay，非 WebSocket 请求不动）。
- lockstep 规则：部署 prod 前先打 `desktop-v*` tag（同一 SHA），或接受桌面版在 CI 出包前被踢；
  过渡期用 `COFLUX_BUILD_ID` env 并集放行。
- 升级 `@xterm/xterm` 须复验中文 IME 标点（`terminal-pane.tsx` 的 `patchImeCommittedInput`）。
- 通知/Keychain 类行为只在签名产物上可信；本机 ad-hoc 构建的失败不算回归。
