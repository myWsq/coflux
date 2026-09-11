# Plan 106: 放弃 web 端第一片——`apps/web` 并入 `apps/desktop`、web/mobile 源码出仓、桥接必选、四个桌面化小项

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat ce7026b..HEAD -- apps/web apps/desktop apps/mobile packages/client package.json pnpm-workspace.yaml .github/workflows/ci.yml .github/workflows/desktop-release.yml docs AGENTS.md README.md`

## Status

- Priority: P1
- Effort: L
- Risk: MED
- Depends on: 103、105（均已 DONE 在 main）
- Category: refactor
- Execution: subagent（宿主通用子 agent，`model: fable`；出发检查 2026-09-11 记录，全自动推进，不再确认）
- Planned at: `ce7026b`, 2026-09-11

## Requirement

用户 2026-09-11 决策：**从此只迭代 Electron 桌面版，web 端放弃迭代但不下线**。背景：三次 macOS 原生立项都没到
parity（plans 082/083/100 撤回），plan 103 当天把 `apps/web` 原样打进 Electron 后桌面版已与 web 等价，再维护两份
前端没有意义。整个改革切三片，本 plan 是第一片；第二片「三张卫星页面收进 server」与第三片「桌面原生化升级」各自
另立 plan，**不在本 plan 内做**。

### 产品结论（探索阶段已确认，勿再问）

- **消费者**：用户本人在 Mac 上日常用桌面 app。新机器登记（`cofluxd up` 打印的 `/authorize/<token>` 链接）、MCP
  宿主 OAuth 同意页（`/oauth/consent`）、端口预览门禁（`/proxy-auth`）三条流仍在**系统浏览器**里完成，由冻结的
  web bundle 承担。
- **形态**：`apps/desktop` 是唯一前端与默认迭代对象。`app.coflux.dev` 与 `m.coflux.dev` 继续服务分割前最后一次
  构建，不再更新、不做下载页、不改 `/` 的行为。`apps/web`、`apps/mobile` 源码整目录出仓（可从 git 历史找回，
  分割基线 `ce7026b`）。
- **技术栈不换**：React 19 + React Compiler、Vite / electron-vite、Tailwind 4 + Astryx、xterm.js 6 + WebGL、
  zustand 全部保留。本 plan 是搬家，不是换件。
- **范围**：结构合并（零行为变化）+ 四个低风险桌面化小项：会话 token 进 `safeStorage`、窗口大小/位置记忆、主进程
  日志落文件、删「打开网页版」菜单项。除这四项外，桌面 app 的可观察行为与现在一致。
- **验收（用户可观察）**：装上新版后工作台与现在一模一样；重启后窗口回到上次的大小与位置；登录一次后 `localStorage`
  里没有 `coflux_token`；`~/Library/Logs/Coflux/` 下有主进程日志；帮助菜单没有网页版入口；`cofluxd up` 授权链接、
  MCP 授权、端口预览照常在浏览器完成。UI 走查按惯例由用户人工做，不用 Playwright。

正确解与相邻错误解：正确解是 **`apps/web` 的渲染层以 `git mv` 搬进 `apps/desktop/src/renderer`，桥接对象从
「可选、运行时探测」变成「必选」，所有只为浏览器存在的代码路径删除，server 零改动，冻结的线上 web 不受影响**。
把 `apps/web` 留着只改引用、在 desktop 里复制一份而不是移动、保留 `isDesktop()` 之类的双态判断、为了让 token
存储简单而放宽桥接面暴露 Node 能力、顺手改 server 的准入或 `COFLUX_WEB_URL` 语义、把 `app.coflux.dev` 改成下载页——
都不是本需求的完成态。

## Decisions & tradeoffs

- **渲染层落位 = `apps/desktop/src/renderer`，用 `git mv` 保留历史**：`apps/web/{src,index.html,public}` 整体移入，
  `createWebViteConfig` 的插件链（react compiler / tailwind / `@` alias / build-id define）并入
  `apps/desktop/electron.vite.config.ts`，`apps/web` 目录随之消失。Rejected: 复制后再删——丢历史、两份并存期
  容易漂。Rejected: 保留 `apps/web` 作 renderer 源、只改文档——用户明确要「不再需要独立维护 web 子项目」。
  Based on: `apps/desktop/electron.vite.config.ts:9-33`（renderer root 指向 `../web`、`absoluteBase` 把 base 钉回
  `/`——搬家后仍需要）；`apps/web/vite.config.ts:38-61`（`createWebViteConfig`）、`:12-21`（`resolveBuildId`）。
  build-id 的 `__COFLUX_BUILD_ID__` define 保留作标识（plan 105：桌面不按 build-id 准入）；`dist/build-id.txt`
  的写入器只在 `desktop-release.yml:105` 的 notice 用到，留或删由执行者定，约束是 workflow 不再引用 `apps/web`。
- **tsconfig 拆分是执行者的设计**：主进程/preload（node、`electron-vite/node` types）与渲染层（DOM、`react-jsx`、
  `vite/client` types、`@/*` paths）需求不同，一份还是两份、是否用 project references 由执行者定。约束：
  `pnpm -C apps/desktop typecheck` 覆盖三者，`pnpm -C apps/desktop test` 覆盖渲染层既有单测（原 `apps/web/src/*.test.ts`
  与 `components/workbench/*.test.ts`，现由根 `test:web` 跑）与主进程单测，CI 与 `desktop-release.yml` 只调这两条。
  Based on: `apps/web/tsconfig.json`、`apps/desktop/tsconfig.json`、根 `package.json` 的 `test:web`、
  `apps/desktop/package.json` 的 `test` 脚本。
- **桥接从可选变必选，类型真相源搬到 `apps/desktop/src/shared`**：渲染层假定 `window.cofluxDesktop` 存在（缺失即
  启动期明确报错，不做静默降级），`getDesktopBridge()` / `isDesktop()` 的 null 分支与一切「浏览器时……」代码删除：
  `beforeunload` 确认、PWA/apple 元数据与 `manifest.webmanifest` 及其图标、Cmd+Ctrl 前缀键位与 standalone 探测、
  `location` 推导 `/client` 地址、build-id 失配 reload 守卫、`reloadOnOutdated`、按环境切换的 `clientKind` /
  `offlineCatalog`。Rejected: 保留双态代码「以防万一」——两份路径正是被放弃的维护负担。桥接面仍最小：不暴露
  Node / fs / shell 通用能力；本 plan 只允许新增 token 存储相关方法。Based on: `apps/web/src/desktop-bridge.ts:59-80`；
  `apps/web/src/config.ts:4-8`；`apps/web/src/pages/MainPage.tsx:12-40`；`apps/web/src/App.tsx:18-22`（三张卫星页
  路由随 web 出仓，桌面只承载 `/`）；`use-shortcut-modifier.ts:6-21`；`use-global-shortcuts.ts:101`；
  `sidebar.tsx:234`；`workbench.tsx:153`；`apps/web/index.html:9-15`；`packages/client/src/store.ts:288-291`。
- **`packages/client` 保留为独立包**：它是无 React 的协议 client + store + DeviceRouter，CI 单测（`packages/client/src/*.test.ts`）
  不依赖 Electron。Rejected: 折进 `apps/desktop`——失去无 Electron 的测试边界，且 iOS 之外它已是唯一 TS client 真相源。
  `ClientKind` 保留 `"web"` 字面量：server 契约（plan 105）未变，冻结 web 仍在上报它。Based on:
  `packages/client/src/index.ts`、`packages/client/package.json`（只依赖 protocol + zustand）。
- **token 持久化改为注入的存储接口**：`createCofluxClient` 不再直接读写 `localStorage` 存 token，改经调用方注入的
  get/set/remove 接口（同步还是异步、命名，执行者定）；登录成功写入、登出/authError 清除的时机与现在一致。
  offline catalog 仍走 `localStorage`（不是秘密），IndexedDB 里的 P-256 设备身份不动。Rejected: 在 client 里探测
  `window.cofluxDesktop`——client 是通用包，不该知道桌面。Based on: `packages/client/src/store.ts:153-154`（`tokenStorageKey`）、
  `:255`（创建时同步读）、`:567,577,828`（写/清）；`packages/client/src/browser-identity.ts`（IndexedDB 身份）。
- **token 进 `safeStorage`**：主进程用 Electron `safeStorage` 加密后落 userData 下的文件，preload 桥接读写；渲染层
  不再把 token 落到任何明文存储。首次启动迁移：`localStorage` 里若还有旧 token（key `coflux_token`）且 safeStorage
  为空，迁入后从 `localStorage` 删除。`safeStorage.isEncryptionAvailable()` 为假、解密失败或文件损坏一律按「未登录」
  处理：不崩、不回退明文落盘、不弹自定义对话框。Rejected: keytar / 第三方钥匙串库——多一个原生模块，`safeStorage`
  是内置的。Rejected: 主进程另起一份中心连接来登录——plan 103 已否决主进程持有连接。文件名、格式、读取时机执行者定，
  约束是 `createCofluxClient` 创建时 token 已就绪（例如渲染层启动时先经桥接异步取回再挂 `MainPage`）。
  Based on: `apps/desktop/src/main/index.ts:27-31`（dev 与安装版 userData 已分离）、`apps/desktop/src/preload/index.ts`
  与 `src/shared/ipc.ts`（既有 IPC 通道与来源校验模式）。
- **窗口大小/位置记忆**：bounds 存 userData 下独立文件（**不**混进用户手编的 `settings.json`），关窗/退出时保存，
  启动恢复；恢复前校验 bounds 与当前某个显示器相交，不相交则回默认尺寸居中。首次启动行为不变（1280×820、居中）。
  Rejected: electron-window-state 之类依赖——几十行主进程代码的事。Based on: `apps/desktop/src/main/window.ts:31-40`
  （固定尺寸）、`apps/desktop/src/main/settings.ts`（settings.json 是用户配置文件）。
- **主进程日志落文件**：引入 `electron-log`（npm latest 5.x，执行者以 `pnpm add` 解析出的版本为准），主进程与
  `electron-updater` 的日志走它，文件路径用其 macOS 默认（`~/Library/Logs/<app.name>/main.log`），轮转用默认值；
  渲染层控制台不采集。Rejected: 自己写文件 logger——轮转/路径/多进程都要重造。Based on:
  `apps/desktop/src/main/updater.ts`（updater 现无 logger）。
- **删「打开网页版」菜单项**：`menu.ts` 里指向 `https://app.coflux.dev` 的帮助项删除，`WEB_URL` 常量随之删除；
  帮助菜单其余项不动。Based on: `apps/desktop/src/main/menu.ts:12,97`。
- **server 零改动**：`COFLUX_WEB_URL`、三张卫星页面的 302、按 `client_kind` 的准入规则全部不动；`apps/server`
  不在 scope 内。执行中若发现必须改 server（含 proto）即 STOP。Based on: `apps/server/src/config.ts:115-116`、
  `apps/server/src/hub.ts:2005`、`apps/server/src/oauth.ts:153`、`apps/server/src/proxy.ts:632`。
- **`apps/mobile` 整目录出仓**：与 web 同为浏览器端，留着就得让共享层持续兼容它（CI 每次构建）；iOS 原生 app 已覆盖
  移动场景；线上 `m.coflux.dev` 照旧不动。Based on: `.github/workflows/ci.yml:176-177`（mobile 构建步骤）、
  `apps/mobile/package.json`（依赖 `@coflux/client`）。
- **冻结与部署只改文档，生产操作由用户做**：`docs/deployment.md` 的常规部署命令去掉 `pnpm --filter @coflux/web build`
  与 mobile 重建那句；新增「web 冻结」小节写明：线上 web/mobile 是分割前构建（生产当前跑的 SHA 由用户填），源码在
  `ce7026b`；冻结 dist 必须从仓库检出目录挪到仓库外固定目录（例如 `/opt/coflux-web-frozen/{app,m}`），Caddy root 与
  server.env 的 `COFLUX_BUILD_ID_FILE` 指过去；**这一步必须在下一次从分割后提交部署 prod 之前完成**。是否给
  `ce7026b` 打 tag 由用户定，plan 不打。Rejected: 本 plan 顺手改生产——动生产要用户确认。Based on:
  `docs/deployment.md:111-117`（部署命令）、`:41-42`（app/m 两个站）、`apps/server/src/config.ts:221-226`
  （`COFLUX_BUILD_ID_FILE` 每次认证现读文件）。
- **CI / 发版 workflow / 根脚本收口**：`ci.yml` 删 web 构建、`test:web`、mobile 构建三步，desktop 步骤覆盖渲染层；
  `desktop-release.yml` 去掉 `tsc -b apps/web`，build-id notice 改读新位置或删除；根 `package.json` 删
  `dev:web` / `dev:mobile` / `test:web`，`dev` 改为 server + desktop 并行（或执行者认为更合理的组合，写进 AGENTS.md）；
  `pnpm-lock.yaml` 随 workspace 成员变化与新依赖更新，CI 的 `--frozen-lockfile` 必须过。Based on:
  `.github/workflows/ci.yml:140-149,176-177`、`.github/workflows/desktop-release.yml:94-105`、根 `package.json`。
- **文档全面改口**：AGENTS.md（`apps/web` 条目删、`apps/desktop` 改为默认迭代对象、常用命令、「本地开发环境的坑」里
  「经生产 p.coflux.dev 端口转发访问本机 dev web」与 manifest crossorigin 两条删除）、README.md monorepo 表与快速开始、
  `docs/ROADMAP.md` §1（改为桌面客户端产品化）与 §4、`docs/OPEN_QUESTIONS.md:16,45`、`docs/design-guidelines.md`
  （标题与首段改为桌面 UI 规范，规则本身不变）、`docs/architecture.md` §1 的「web client」措辞与 §12 仓库结构、
  `docs/RELEASING.md:161,191`、`apps/desktop/README.md`（渲染层不再是「原样打包 apps/web」）、`plans/README.md`。
  措辞原则：写现状，不写「原来是 web」的编年史；历史留给 plans。
- **不动**：xterm / WebGL 与 IME 补丁、冷启动遮罩（plan 078，仍盖住 React 挂载到首快照的间隙）、Origin
  `https://desktop.coflux.dev`、协议版本准入、iOS 与 `packages/swift-client`、`electron-builder.yml`、
  `packages/protocol`、`crates/*`、`tests/*`。

## Direction

一个工作包、三个里程碑，**M2 与 M3 都依赖 M1**（渲染层与 client 接口先落位），M2 与 M3 之间无依赖但共享
`package.json` / `pnpm-lock.yaml` / 文档，不拆并发。每个里程碑各自一到数个 commit，commit message 中文、结尾带
`Co-Authored-By`。

### Milestone 1: 搬家完成，桌面 app 零行为变化

`apps/web` 目录不复存在，渲染层在 `apps/desktop/src/renderer`，桥接必选，浏览器专属路径全部删除；`packages/client`
的 token 存储改为注入接口（本里程碑可先用 `localStorage` 实现接口，M2 再换 safeStorage），`reloadOnOutdated` 与
outdated reload 守卫删除；根 `package.json` 与 lockfile 不再引用 `@coflux/web`。
Validation: `pnpm install --frozen-lockfile` -> exit 0；`pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test && pnpm -C apps/desktop build` -> exit 0；
`node --import tsx --test packages/client/src/*.test.ts` -> exit 0；`git grep -n "apps/web\|@coflux/web\|isDesktop\|getDesktopBridge" -- ':!plans' ':!docs'` -> 无输出。

### Milestone 2: 四个桌面化小项

token 经 `safeStorage` 落盘并完成一次性迁移；窗口 bounds 记忆与显示器校验；`electron-log` 接管主进程与 updater 日志；
帮助菜单无「打开网页版」。新增单测覆盖能纯函数化的部分（至少：bounds 校验/回退、token 存储的失败态归一为未登录、
localStorage 迁移的判定）。
Validation: `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test && pnpm -C apps/desktop build` -> exit 0；
`git grep -n "app.coflux.dev" apps/desktop/src` -> 无输出。

### Milestone 3: mobile 出仓、CI/发版 workflow、文档与索引收口

`apps/mobile` 目录不复存在；`ci.yml` / `desktop-release.yml` / 根脚本按决策改完；文档全面改口；`plans/README.md`
106 行状态更新。
Validation: `pnpm install --frozen-lockfile` -> exit 0；`node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` -> exit 0（server 未动的证明）；
`node scripts/sync-claude-plugin.mjs --check` -> exit 0；`git grep -n "apps/web\|apps/mobile\|@coflux/web\|@coflux/mobile\|dev:web\|test:web" -- ':!plans'` -> 无输出；
`grep -n "apps/web\|apps/mobile" .github/workflows/*.yml` -> 无输出。

## Landmines

- **`absoluteBase` 仍然需要**：electron-vite 的 renderer 预设在生产构建把 base 强制成 `./`，本项目经 `coflux-app://app/`
  从根提供渲染层，base 必须是 `/`（`apps/desktop/electron.vite.config.ts:11-25`）。搬家后 root 变成默认的
  `src/renderer`，这个 post 插件别顺手删。
- **`safeStorage` 的钥匙串项按代码签名做 ACL**：ad-hoc 签名的 dev 包（`pnpm pack` / `electron-vite dev`）与 Developer ID
  签名的安装版共用「Coflux Safe Storage」钥匙串项，切换时 macOS 可能弹授权框或解密失败。决策里的「失败即未登录」
  兜底就是为此；dev 与安装版 userData 已分离（`apps/desktop/src/main/index.ts:27-31`），加密文件不会互相覆盖。
- **`resolveServerUrl` 的浏览器回退有单测**（`apps/web/src/desktop-bridge.test.ts`）：桥接必选后这些用例要改成
  「只认桥接」，不是删掉整份测试。
- **`desktop-release.yml:105` 读 `apps/desktop/out/renderer/build-id.txt`**：若删掉 `writeBuildIdFile`，这行 notice 一起改，
  否则发版 workflow 在 build 步骤报 `cat` 失败。
- **`index.html` 冷启动遮罩引用 `/favicon.svg`**（`apps/web/index.html:20-30`）：`public/` 里删 PWA 图标与 manifest 时
  留下 `favicon.svg`。
- **`pnpm-workspace.yaml` 用 `apps/*` 通配**：删目录即退出 workspace，lockfile 的 importers 段会变，必须重新
  `pnpm install`（不带 `--frozen-lockfile`）并提交 lockfile，否则 CI 的 `pnpm install --frozen-lockfile` 直接红。
- **生产 `git checkout <tag>` 不会清掉被忽略的 `apps/web/dist`**：分割后的提交部署到 prod 时，冻结站会因为
  「忽略文件没被清理」继续活着，`COFLUX_BUILD_ID_FILE` 也还指着旧路径——这就是为什么文档要求先挪目录。文档里把这条
  写清楚，别写成「自动兼容」。
- **黑盒测试与 web 无关但仍是提交门**（AGENTS.md「提交前必须绿」）：`pnpm -C tests test` 需要本机 Postgres
  （OrbStack，`pnpm dev:pg`）与 `cargo build` 的 daemon 二进制；`agent-activity` 的 presence 三条在装了 coflux 的本机
  必假红（靠进程树认 claude 进程），`auto-update` / `local-first` / `signed-upgrade` 偶发红单跑一次即定性 flaky——
  这些与本 plan 无关，不要为它们调阈值。
- **Bash 守卫**：仓库的 Claude 插件 guard 会拦命令文本里出现 `git worktree add/remove/move` 字样的整条命令（含
  heredoc 与 commit 正文）。改文档（AGENTS.md 有这类字样）用 Edit/Write 工具，不用 heredoc；本会话跑的是 zsh，
  `set -e` 不生效，多步脚本用 `&&` 串联。
- **`apps/desktop/package.json` 的 devDependencies 里有 `@coflux/web: workspace:*`**：搬家后这条必须删，
  `@coflux/client` / `@coflux/protocol` 及原 `apps/web/package.json` 的运行时依赖（astryx、xterm、shiki、lucide、
  tailwind-merge、clsx、zustand、react）要迁到 desktop 的 dependencies / devDependencies（electron-builder 只打
  `out/**`，分类按「构建期 vs 运行期」执行者定，约束是 `pnpm -C apps/desktop build` 与 `pack` 都过）。
- **`docs/design-guidelines.md` 是 AGENTS.md 指名的 UI 规范入口**（「改 web UI 先看」）：改名后 AGENTS.md 的指引
  一起改，别留断链。

## Scope

In scope:
- `apps/web/**`（整目录移走/删除）、`apps/mobile/**`（整目录删除）
- `apps/desktop/**`（渲染层落位、主进程四小项、配置、测试、README）
- `packages/client/src/**`（token 存储接口、删浏览器专属路径、`index.ts` 导出面）
- 根 `package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`（仅当注释需改）
- `.github/workflows/ci.yml`、`.github/workflows/desktop-release.yml`
- `AGENTS.md`、`README.md`、`docs/{ROADMAP,OPEN_QUESTIONS,design-guidelines,architecture,RELEASING,deployment}.md`
- `plans/README.md`、`plans/106-desktop-only-merge.md`

Out of scope:
- `apps/server/**`、`proto/**`、`packages/protocol/**` — server 零改动是决策；需要改即 STOP
- `crates/**`、`packages/cli/**`、`integrations/**` — 与前端无关
- `apps/ios/**`、`packages/swift-client/**` — 不受影响
- `tests/**` — 黑盒不碰 web
- 三张卫星页面的归属（`/authorize`、`/oauth/consent`、`/proxy-auth`）— 第二片
- `coflux://` 深链接、本机 daemon 走 UDS、终端渲染器替换、server 侧准入精简、`app.coflux.dev` 下载页、Windows/Linux — 第三片
- 生产上的目录搬迁、Caddy、server.env、打 tag、推送、合并 — 用户操作

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| 依赖一致 | `pnpm install --frozen-lockfile` | exit 0 |
| 桌面类型检查 + 单测 + 构建 | `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test && pnpm -C apps/desktop build` | exit 0 |
| client 单测 | `node --import tsx --test packages/client/src/*.test.ts` | exit 0 |
| server 未动 | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| 插件目录一致 | `node scripts/sync-claude-plugin.mjs --check` | exit 0 |
| 残留引用 | `git grep -n "apps/web\|apps/mobile\|@coflux/web\|@coflux/mobile\|dev:web\|test:web\|isDesktop\|getDesktopBridge" -- ':!plans'` | 无输出 |
| workflow 残留 | `grep -n "apps/web\|apps/mobile" .github/workflows/*.yml` | 无输出 |
| 未签名包冒烟 (acceptance) | `pnpm -C apps/desktop pack` | exit 0，`dist/mac-arm64/Coflux.app` 可启动 |
| 黑盒全量 (acceptance) | `pnpm -C tests test` | 除已知本机假红/flaky 外全绿 |
| UI 走查 (acceptance) | 用户启动 pack 出的 app | 见 Requirement 的验收清单 |

## Done criteria

- [ ] 上表非 acceptance 命令全部 exit 0，acceptance 命令由验证方跑。
- [ ] `apps/web`、`apps/mobile` 目录不存在；渲染层历史经 `git log --follow apps/desktop/src/renderer/components/workbench/workbench.tsx` 可追溯到 `apps/web`。
- [ ] 渲染层没有 `isDesktop` / `getDesktopBridge` / `beforeunload` / manifest / Cmd+Ctrl 键位 / `location` 推导地址 / outdated reload 的代码。
- [ ] `packages/client` 不再引用 `localStorage` 存取 token；`reloadOnOutdated` 选项不存在。
- [ ] 登录后 token 只以 `safeStorage` 加密形式存在于 userData；旧 `localStorage` token 首次启动被迁移并清除；加密不可用/解密失败时 app 进登录态而非崩溃。
- [ ] 窗口 bounds 跨重启恢复，且离屏 bounds 会回默认。
- [ ] 主进程与 updater 日志写入 electron-log 默认文件。
- [ ] 帮助菜单无「打开网页版」，`apps/desktop/src` 无 `app.coflux.dev` 字面量。
- [ ] `ci.yml` / `desktop-release.yml` / 根脚本 / 文档不再引用 web、mobile；`docs/deployment.md` 有「web 冻结」小节与挪目录要求。
- [ ] 新增单测存在且断言真实行为（bounds 校验、token 失败态、迁移判定）。
- [ ] 实现遵守 Decisions & tradeoffs 每一条。
- [ ] 没有 scope 外文件改动。
- [ ] `plans/README.md` 106 行状态已更新。

## STOP conditions

- Decisions & tradeoffs 引用的事实不再成立（尤其 `electron.vite.config.ts` 的 renderer 接法、`store.ts` 的 token 读写点、server 的 `webUrl` 用法）。
- 完成需求需要改 `apps/server`、`proto`、`packages/protocol`、`tests` 中任一。
- `pnpm install` 无法解析 `electron-log`，或 lockfile 更新后 `--frozen-lockfile` 仍红且原因不在本 plan 改动内。
- 桥接必选后发现渲染层有非桌面才能跑通的路径（例如某流程只在浏览器 `location.host` 下成立）而本 plan 没给出处理方式。
- 某条验证命令在一次合理修复后仍连续失败两次。

## Maintenance notes

- 「迭代前端」从此指 `apps/desktop`；`packages/client` 的 `ClientKind` 里的 `"web"` 是为冻结的线上 web 保留的 server 契约，
  server 侧准入规则（plan 105）没有随本 plan 变。
- 三张卫星页面（`/authorize/<token>`、`/oauth/consent`、`/proxy-auth`）在第二片落地前只活在冻结 bundle 里：改 server
  的 `clientAuth` / `daemonAuthorize*` / OAuth consent / proxy issue 相关消息前，先确认冻结 web 还能走通，或先做第二片。
- `safeStorage` 的失败态被归一为「未登录」：用户若反馈「每次启动都要登录」，先查钥匙串授权（Console 里 `Coflux Safe
  Storage`）与 `~/Library/Logs/Coflux/main.log`。
- 分割基线 `ce7026b` 含最后一份 `apps/web` / `apps/mobile` 源码；线上冻结 bundle 的 SHA 记在 `docs/deployment.md`。
