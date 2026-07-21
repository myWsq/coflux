# Plan 022: PWA 可安装（manifest + 图标，无 service worker）

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 321ef97..HEAD -- apps/web/index.html apps/web/public apps/web/vite.config.ts`

## Status

- Priority: P2
- Effort: S
- Risk: LOW
- Depends on: none
- Category: feature
- Execution: subagent sonnet
- Planned at: `321ef97`, 2026-07-21

## Requirement

coflux web（`apps/web`，Vite 6 + React 19 SPA，WebSocket 终端客户端）目前无
favicon、无 manifest，浏览器无法把它安装为独立应用。目标：让
app.coflux.dev 在 iOS Safari「添加到主屏幕」、Chrome/Edge 桌面与 Android
上满足可安装条件，安装后以 standalone（无浏览器 UI）窗口运行，并带上像样的
应用图标；顺带修复现在 favicon 请求 404。

正确解 vs 相邻错误解：**不引入 service worker、不加任何 npm 依赖、不加构建
步骤**。仅静态资源（manifest + 图标）+ `index.html` 标签。现代浏览器安装
PWA 已不要求 SW；此应用离线无价值，SW 只带来缓存陈旧风险。

## Decisions & tradeoffs

- **无 service worker**：仅 manifest + 图标实现可安装。Rejected: vite-plugin-pwa /
  离线缓存 / 更新提示 — 应用是纯 WebSocket 终端客户端，离线零价值，SW 只增加
  缓存失效与版本陈旧的运维成本。出发确认已定。
- **静态资源放 `apps/web/public/`**：Vite 自动原样拷贝到 dist 根，无需改
  `apps/web/vite.config.ts`。Rejected: 构建插件生成 — 违背零依赖决策。
  Based on: 目前 `apps/web/` 无 public/ 目录，vite.config.ts 无相关配置。
- **图标本次设计并把生成产物提交入库**：设计一个终端风格 SVG 源图标
  （深色底呼应 `#111214`，简洁 glyph，如终端提示符），一次性渲染出各尺寸
  PNG 直接 commit。Rejected: 加 sharp/构建期生成 — 为 5 张静态图引入依赖不值。
  渲染手段是执行者的 call（如 `pnpm dlx` 一次性 CLI；macOS `sips` 不支持 SVG
  输入，别用）。需要的文件（均在 `apps/web/public/`）：
  `favicon.svg`、`icon-192.png`、`icon-512.png`、`icon-maskable-512.png`、
  `apple-touch-icon.png`（180×180，**不透明**——iOS 会把透明底填黑）。
  maskable 版 glyph 须落在中心 80% 安全区内（周边留足底色）。
- **manifest 字段**：`name`/`short_name` 均为 `coflux`，`display: "standalone"`，
  `start_url: "/"`，`background_color`/`theme_color` 均 `#111214`，icons 含
  192/512（`purpose: "any"`）与 maskable 512（`purpose: "maskable"`）。
  文件名 `manifest.webmanifest`。Based on: `apps/web/index.html` 现有
  `<meta name="theme-color" content="#111214">` 与 `color-scheme: dark`。
- **iOS meta 用 `apple-mobile-web-app-capable` + status-bar-style `black`**：
  `black` 是不透明黑色状态栏，不与页面内容重叠。Rejected:
  `black-translucent` — 状态栏悬浮在内容上，需要给全屏终端 UI 补
  safe-area-inset 适配，超出本计划范围。另加
  `<meta name="apple-mobile-web-app-title" content="coflux">`。
- **`index.html` 同时挂 `<link rel="icon" href="/favicon.svg" type="image/svg+xml">`**：
  修复当前 favicon 404。Rejected: 另做 .ico — SVG favicon 现代浏览器全支持，
  目标用户不含旧浏览器。

## Direction

### Milestone 1: 图标与 manifest 资源就位

`apps/web/public/` 下存在上述 5 个图标文件与 `manifest.webmanifest`，manifest
字段符合决策，JSON 合法，icons 路径与实际文件一一对应；PNG 实际像素尺寸与
声明一致。Validation: `pnpm --filter @coflux/web build` -> exit 0，且
`dist/` 根包含 manifest 与全部图标。

### Milestone 2: index.html 挂载

`apps/web/index.html` head 中新增 manifest link、favicon link、
apple-touch-icon link、三个 iOS meta；既有 meta（viewport/theme-color/
color-scheme/title）保持不变。Validation: `pnpm --filter @coflux/web build`
-> exit 0，`dist/index.html` 含上述标签。

## Scope

In scope:
- `apps/web/public/`（新建）
- `apps/web/index.html`
- `plans/README.md`（状态更新）

Out of scope:
- `apps/web/vite.config.ts` — 无需任何改动（public/ 自动拷贝）
- 任何 service worker / 离线缓存 / 更新提示
- `apps/web/package.json` / lockfile — 不加依赖
- src/ 下任何代码 — 本需求纯静态资源
- 安装引导 UI（如"添加到主屏幕"提示）— 未提出

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Typecheck + build | `pnpm --filter @coflux/web build` | exit 0 |
| 产物检查 | `ls apps/web/dist/manifest.webmanifest apps/web/dist/icon-512.png apps/web/dist/apple-touch-icon.png` | 全部存在 |
| 浏览器验收 (acceptance) | `pnpm --filter @coflux/web preview` + 浏览器访问：manifest 200、无 404、Application 面板可安装 | 通过 |

## Done criteria

- [ ] All listed commands pass.
- [ ] `dist/` 含 manifest + 5 个图标；manifest icons 声明与文件实际尺寸一致。
- [ ] `index.html` 含 manifest/favicon/apple-touch-icon link 与 iOS meta。
- [ ] 无 service worker、无新依赖、vite.config.ts 未动。
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.
- 无法在不加持久依赖的前提下渲染出 PNG（一次性 `pnpm dlx` 也失败）。

## Maintenance notes

- 正式 logo 定稿后：替换 `apps/web/public/favicon.svg` 并重渲染 4 张 PNG 即可，
  manifest/index.html 无需改。
- 若未来要离线能力或安装提示，再评估 vite-plugin-pwa；届时需处理更新提示 UI。
