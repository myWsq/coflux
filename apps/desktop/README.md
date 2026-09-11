# apps/desktop — coflux 桌面客户端（Electron）

Electron 壳把 **当前 `apps/web` 原样打包**进 app（plan 103）：渲染层 root 直接指向 `apps/web`，
插件链取自 `apps/web/vite.config.ts` 的 `createWebViteConfig`，不复制任何组件/样式/页面。
桌面差异（服务器地址、Origin、通知、角标、菜单命令、更新提示）全部经 preload 暴露的
`window.cofluxDesktop` 桥接在运行时探测，类型真相源在 `apps/web/src/desktop-bridge.ts`。

## 命令

```sh
pnpm -C apps/desktop dev         # electron-vite dev：渲染层 5274（HMR），主进程连 ws://localhost:8787/client
pnpm -C apps/desktop typecheck   # tsc（main / preload / 配置 / 测试）
pnpm -C apps/desktop test        # node --test：Origin 判定、渲染层路径/CSP、IPC 来源、设置解析、更新状态、发布配置
pnpm -C apps/desktop build       # electron-vite build → out/{main,preload,renderer}
pnpm -C apps/desktop pack        # 未签名 .app（dist/mac-arm64/），本机冒烟用；通知/角标在未签名包上不可信
pnpm -C apps/desktop dist        # 本机出 dmg/zip（需 Developer ID 证书在钥匙串里，否则只签 ad-hoc）
pnpm -C apps/desktop icon        # 从 build/AppIcon.icon 重新导出 build/icon.png（仅 macOS）
```

正式发版走 `desktop-v*` tag 触发的 `.github/workflows/desktop-release.yml`（签名 + 公证 + 推 R2），见
[docs/RELEASING.md](../../docs/RELEASING.md)。

## 运行时约定

- **渲染层来源**：打包版经自定义 standard scheme `coflux-app://app/` 从 asar 提供（`src/main/app-protocol.ts`），
  不加载任何远程 URL。
- **中心离线冷启动**：Web 侧给 client 传 `offlineCatalog`（`localStorage`，key 按服务器地址分），每次中心目录
  变化都落一份；冷启动有 token 但首连拿不到 authOk（连不上 / authOk 前断开 / 5s 超时）就装载缓存进工作台，
  重连横幅照常显示，RUNNING 终端经缓存的 loopback grant attach（session read/control 是 offline grant scope，
  不需要中心签发的 lease）。中心连上后真实快照覆盖缓存；登出 / 认证失败 / 换账号清缓存。
- **Origin**：主进程在渲染层发起的每条 WebSocket 握手上把 Origin 改写为 `https://desktop.coflux.dev`
  （`src/main/origin.ts`），Web 侧经 `deviceTransport.origin` 上报同值；server/daemon 校验零放宽。
  这个字符串是 loopback grant 绑定的一部分，改它等于让所有桌面 grant 失效。
- **服务器地址**：`--server=wss://…/client` > 环境变量 `COFLUX_SERVER_URL` > `~/Library/Application Support/coflux/settings.json`（未打包的 dev 实例用 `coflux-dev` 目录，与安装版互不可见）
  的 `serverUrl` > 默认（打包版 `wss://api.coflux.dev/client`，dev `ws://localhost:8787/client`）。
- **版本准入**：渲染层 build-id 与浏览器构建同一套（git short SHA），中心只接受与部署的 web 同 SHA 的桌面版；
  被拒时显示「需要更新」并触发 electron-updater 检查，不当作断线。
- **安全基线**：sandbox/contextIsolation 开、nodeIntegration 关、Fuses 关 RunAsNode 等、响应带 CSP、
  权限默认拒绝、IPC 校验发送方来源；新窗口/外链一律系统浏览器。
