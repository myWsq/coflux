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
pnpm -C apps/desktop test        # node --test：主进程纯函数（Origin / 渲染层路径与 CSP / IPC 来源与载荷 / 设置 / 更新状态 / token 存储 / 窗口 bounds）+ 渲染层纯函数（桥接必选 / token 迁移 / 变更视图刷新 / 通知去重 / 工作台状态）+ 发布配置
pnpm -C apps/desktop build       # electron-vite build → out/{main,preload,renderer}
pnpm -C apps/desktop pack        # 未签名 .app（dist/mac-arm64/），本机冒烟用；通知/角标在未签名包上不可信
pnpm -C apps/desktop dist        # 本机出 dmg/zip（需 Developer ID 证书在钥匙串里，否则只签 ad-hoc）
pnpm -C apps/desktop icon        # 从 build/AppIcon.icon 重新导出 build/icon.png（仅 macOS）
```

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
- **安全基线**：sandbox/contextIsolation 开、nodeIntegration 关、Fuses 关 RunAsNode 等、响应带 CSP、
  权限默认拒绝、IPC 校验发送方来源与载荷；新窗口/外链一律系统浏览器。桥接面不暴露 Node / fs / shell。
