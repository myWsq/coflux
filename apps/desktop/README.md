# apps/desktop — coflux 桌面客户端（Electron）

coflux 唯一的前端与默认迭代对象（plan 106）：`src/main` 是 Electron 主进程，`src/preload` 是 sandbox preload，
`src/renderer` 是 React 19 + xterm.js 工作台（index.html / public / 组件都在这一份里，`@` 别名指向它）。
桌面能力（服务器地址与「服务器地址…」对话框、Origin、通知、角标、菜单命令、更新提示、会话 token）经 preload 暴露的
`window.cofluxDesktop` 桥接提供，渲染层假定它必定存在（缺失即启动期报错），类型真相源在
`src/shared/desktop-bridge.ts`。新机器授权 / MCP OAuth 同意 / 端口预览门禁三张页面在系统浏览器里由冻结的
线上 web 承担，不在这里。

## 命令

```sh
pnpm -C apps/desktop dev         # electron-vite dev：渲染层 5274（HMR），主进程连 ws://localhost:8787/client
pnpm -C apps/desktop typecheck   # tsc 两份：tsconfig.json（main / preload / shared / 配置 / 测试）+ tsconfig.renderer.json（渲染层）
pnpm -C apps/desktop test        # node --test：主进程纯函数（Origin / 渲染层路径与 CSP / IPC 来源与载荷 / 设置 / 更新状态 / token 存储 / 窗口 bounds / 本机 daemon 的路径、文本、版本比较、状态派生、内置定位）+ 渲染层纯函数（桥接必选 / token 迁移 / 变更视图刷新 / 通知去重 / 工作台状态 / 账号脚部展示映射 / daemon 状态行、动作与引导分页）+ 发布配置
pnpm -C apps/desktop build       # electron-vite build → out/{main,preload,renderer}
COFLUX_DESKTOP_DAEMON_DIR=../../target/debug pnpm -C apps/desktop run pack   # 未签名 .app（dist/mac-arm64/），本机冒烟用；通知/角标在未签名包上不可信
COFLUX_DESKTOP_DAEMON_DIR=../../target/debug pnpm -C apps/desktop dist       # 本机出 dmg/zip（需 Developer ID 证书在钥匙串里，否则只签 ad-hoc）
pnpm -C apps/desktop run stage-daemon --from ../../target/debug             # 只落位内置 daemon 三件到 build/daemon（dev 实例也从这里找）
pnpm -C apps/desktop icon        # 从 build/AppIcon.icon 重新导出 build/icon.png（仅 macOS）
```

**内置 daemon 三件（plan 113）**：`pack` / `dist` 先跑 `scripts/stage-daemon.mjs`，它从一个**显式**给出的产物目录
（环境变量 `COFLUX_DESKTOP_DAEMON_DIR` 或 `--from <dir>`；本机通常是仓库根的 `target/debug`，先 `cargo build -p coflux-supervisor -p coflux-worker -p coflux-cli`）
把 `coflux-supervisor` / `coflux-worker` / `cofluxd` 复制到 `build/daemon/`（gitignored）并写版本戳 `VERSION`；输入缺失或三件不全**直接失败**，
不会静默出一个不带 daemon 的包。`VERSION` 取 `<dir>/VERSION`，缺失退到 `COFLUX_DESKTOP_DAEMON_VERSION`，再缺失落 `dev`
（本机 debug 产物编译期就是 dev，app 对解析不了的内置版本永不提示升级）。CI 在 `desktop-release.yml` 的并行 daemon job 里
写 `v0.0.0-desktop.<桌面版本>`。electron-builder 把 `build/daemon` 整目录放进 `Contents/Resources/daemon/`（不进 asar），
三件经 `mac.binaries` 拿 Developer ID + hardened runtime 签名并进公证。未打包的 dev 实例也从 `build/daemon` 找三件，
没跑过 stage 脚本时状态对象报「本构建不带 daemon」，只能看状态、不能接入。

**内置 coflux 插件（plan 115）**：同一个 stage 脚本还把**仓库内**的 `integrations/claude-plugin` 整目录逐字节拷到
`build/daemon/claude-plugin/`（不做任何改写，`.mcp.json` 的中心地址照旧写死；来源缺失或缺 `.claude-plugin/plugin.json`
**直接失败**，与三件同一口径，CI 不需要新输入），随同一条 `extraResources` 进 `Contents/Resources/daemon/claude-plugin/`。
插件是 node / sh 脚本，**不进** `mac.binaries`、不做 ad-hoc 重签、不落 `~/.coflux`。app 更新原地替换包内这份，不做版本目录。

依赖分类：electron-builder 只打 `out/**` 与 `dependencies`。渲染层用的库（react / xterm / astryx / shiki / zustand /
`@coflux/client` 等）由 Vite 打进 `out/renderer`，因此放 devDependencies；主进程运行时按 `externalizeDepsPlugin`
外置、需要在 asar 的 node_modules 里的（`electron-updater`、`electron-log`）才放 dependencies。

正式发版走 `desktop-v*` tag 触发的 `.github/workflows/desktop-release.yml`（签名 + 公证 + GitHub Release + 更新清单推 `desktop-updates` 分支），见
[docs/RELEASING.md](../../docs/RELEASING.md)。

## 运行时约定

- **渲染层来源**：打包版经自定义 standard scheme `coflux-app://app/` 从 asar 提供（`src/main/app-protocol.ts`），
  不加载任何远程 URL。base 钉在 `/`（`electron.vite.config.ts` 的 `absoluteBase`），别顺手删。
- **会话 token**（plan 106）：主进程用 Electron `safeStorage` 加密后写 `userData/session-token.bin`，渲染层启动时经桥接
  取回一次、之后只在内存持有，登录 / 登出 / 认证失败时转发回主进程；`localStorage` 里不再有 `coflux_token`
  （首次启动把旧值迁入后删除）。加密不可用、文件损坏、解密失败一律按未登录处理，不崩、不回退明文落盘、不弹框。
  ad-hoc 签名的 dev 包与 Developer ID 签名的安装版共用钥匙串项，切换时可能落到这条兜底上。
- **窗口大小/位置**（plan 106）：关窗/退出时把常规态 bounds 写 `userData/window-state.json`，启动时若仍落在某个
  显示器上就恢复，否则默认 1280×820 居中。不混进用户手编的 `settings.json`。
- **主进程日志**（plan 106）：`electron-log`，文件在 `~/Library/Logs/Coflux/main.log`（轮转用默认值），
  `electron-updater` 的日志也写这里；渲染层控制台不采集。
- **中心离线冷启动**：渲染层给 client 传 `offlineCatalog`（`localStorage`，key 按服务器地址分），每次中心目录
  变化都落一份；冷启动有 token 但首连拿不到 authOk（连不上 / authOk 前断开 / 5s 超时）就装载缓存进工作台，
  重连横幅照常显示，RUNNING 终端经缓存的 loopback grant attach（session read/control 是 offline grant scope，
  不需要中心签发的 lease）。中心连上后真实快照覆盖缓存；登出 / 认证失败 / 换账号清缓存。
- **Origin**：主进程在渲染层发起的每条 WebSocket 握手上把 Origin 改写为 `https://desktop.coflux.dev`
  （`src/main/origin.ts`），渲染层经 `deviceTransport.origin` 上报同值；server/daemon 校验零放宽。
  这个字符串是 loopback grant 绑定的一部分，改它等于让所有桌面 grant 失效。
- **服务器地址**：`--server=wss://…/client` > 环境变量 `COFLUX_SERVER_URL` > `~/Library/Application Support/Coflux/settings.json`（未打包的 dev 实例用 `Coflux-dev` 目录，与安装版互不可见）
  的 `serverUrl` > 默认（打包版 `wss://api.coflux.dev/client`，dev `ws://localhost:8787/client`）。
  应用菜单与侧栏底部账号菜单的「服务器地址…」是同一个主进程原生对话框（plan 110 起渲染层经桥接唤起，
  桥接面没有因此长出 fs / shell 能力）。
- **版本准入**（plan 105）：登录时上报 `clientKind=desktop` 与 `CONTROL_PROTOCOL_VERSION`，中心只在协议版本低于其最低支持版本时拒绝；build-id 只作标识。部署 prod 不会踢旧桌面版，electron-updater 在后台升级；被拒显示「需要更新」并触发更新检查，不当作断线。
- **快捷键**：纯 ⌘ 前缀（⌘T/⌘W/⌘N/⌘1-9/⌘[ ]/⌘/），原生菜单项只展示键位不注册 accelerator，键落到页面处理。
- **本机 daemon**（plan 113）：app 就是这台 Mac 的 daemon 安装器与管理器。落盘布局与 LaunchAgent 与 npm 版
  `cofluxd` 逐字同构（`~/.coflux/bin/{coflux-supervisor,coflux-worker,cofluxd}`、`~/Library/LaunchAgents/com.coflux.daemon.plist`、
  `~/.coflux/settings.json` 的 serverUrl = app 地址把 `/client` 换成 `/daemon`；尊重 `COFLUX_HOME`），npm 装过的机器被识别为
  「已接入」直接接管。落盘后对三件 ad-hoc 重签（新落盘二进制带 provenance，launchd 顶层 spawn 被 AMFI 静默杀）。
  登录成功（中心已连上）后本机未接入就弹接入引导（可「暂不」，之后从账号菜单「本机 daemon」再进）：安装组件 → 启动服务 →
  用当前登录态 `client.authorizeDevice(token)` 兑现 `~/.coflux/pending-auth.json` 里的链接（不开浏览器）→ 完全磁盘访问引导。
  内置 supervisor 比在跑的新只提示「有更新待重启」（文案带本机运行中终端数），用户点「重启」才换二进制并 unload/load，从不自动重启；
  比较用 `Resources/daemon/VERSION` 与 `~/.coflux/supervisor-version`，在跑的是 dev 或缺文件视为旧，内置解析不了永不提示。
  判定 / 文本 / 版本比较 / 状态派生都是无 Electron 依赖的纯模块（`src/main/daemon-*.ts`），只有 `daemon-manager.ts` 碰
  launchctl / codesign / fs.watch；桥接面只多一个状态对象和六个无参窄动词。主进程日志只记事件，不写凭证文件内容。
  未打包的 dev 实例接管的是同一个真实 daemon（`~/.coflux` 全机唯一）。
- **coflux 终端里的 claude 自动带插件**（plan 115）：LaunchAgent plist 的 `EnvironmentVariables` 除 `COFLUX_HOME` 外多一个
  `COFLUX_CLAUDE_PLUGIN_DIR`，值是本 app 包内 `Contents/Resources/daemon/claude-plugin` 的绝对路径（含空格照写，`&`/`<` 做 XML 转义）；
  supervisor 把它拷进会话环境，会话的 shell 集成据此给 `claude` 加 `--plugin-dir`。契约只有这个变量名，daemon 不解析、不校验、不落盘；
  变量缺失、为空或目录不存在时 `claude` 的行为与今天完全一致（这也是逃生口）。没有任何设置页与开关。
  plist 何时写：接入流程之外，**app 启动时**若渲染结果与磁盘上的不同（npm 接入的机器、旧版 app 写的没有这个键、app 换了位置）
  **只重写文件**，不调 launchctl、不重启 daemon——reload 会结束本机所有终端；新值在下一次 supervisor 启动（面板点「重启」、
  「重启并更新」、开机）时生效。plist 不存在（未接入）时不凭空创建。除这一个键外 plist 与 npm 版 `cofluxd` 逐字同构，两边仍可互换。
- **安全基线**：sandbox/contextIsolation 开、nodeIntegration 关、Fuses 关 RunAsNode 等、响应带 CSP、
  权限默认拒绝、IPC 校验发送方来源与载荷；新窗口/外链一律系统浏览器。桥接面不暴露 Node / fs / shell。
