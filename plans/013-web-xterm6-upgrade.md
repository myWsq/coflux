# Plan 013: web 端 xterm.js 5.5 → 6.0 升级（与 server 侧 headless 6.0 版本对齐）

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat d8b3237..HEAD -- apps/web/package.json apps/web/src/components/workbench/terminal-pane.tsx pnpm-lock.yaml`

## Status

- Priority: P2
- Effort: S
- Risk: LOW
- Depends on: none
- Category: migration
- Execution: subagent sonnet
- Planned at: `d8b3237`, 2026-07-19

## Requirement

apps/web 的终端渲染栈停在 `@xterm/xterm` 5.5，而 server 侧终端镜像（commit
69e132a，apps/server/src/mirror.ts）已经用 `@xterm/headless` 6.0.0 +
`@xterm/addon-serialize` 0.14.0 生成快照。当前生产链路是"6.0 headless 序列化 →
5.5 前端重放"的跨大版本组合，能跑但不是长期状态。

完成后：apps/web 依赖升至 `@xterm/xterm` ^6.0.0、`@xterm/addon-fit` ^0.11.0、
`@xterm/addon-webgl` ^0.19.0，与 server 侧同代；终端功能（输入、输出、attach
快照重放、tab 切换、WebGL 渲染与回退、resize/fit）行为不回退。

正确解 vs 相邻错误解：本次只升级版本号并处理由此产生的必要适配，**不**顺手重构
terminal-pane.tsx、不调整终端主题/字体/选项、不引入新 addon（如 search、
web-links）。改动面预期是两三个 package.json 版本号 + lockfile；若编译或运行
出现 6.0 不兼容再做最小适配。

## Decisions & tradeoffs

- **留在 xterm.js 并升 6.0，而非切换 ghostty-web**：ghostty-web（coder/
  ghostty-web）虽是 xterm.js API 兼容的现代替代，但仍处 0.4.0 POC 阶段（作者
  自认性能未优化、无 WebGL 渲染器、中文 IME 未实测）。其 drop-in 兼容策略使
  "先升 6.0、以后再换"成本极低。Rejected: 直接切 ghostty-web — 拿生产终端换
  POC，收益对本产品场景（agent 指挥中心）价值低。Based on: 2026-07-19 调研 +
  用户确认；memory/terminal-mirror.md 亦记录 ghostty-web 换前必须实测 IME。
- **升级面只含 web 三个包**：`@xterm/xterm` ^6.0.0、`@xterm/addon-fit`
  ^0.11.0、`@xterm/addon-webgl` ^0.19.0。server 侧 `@xterm/headless`
  6.0.0 / `@xterm/addon-serialize` 0.14.0 已是目标版本，不动。Rejected: 同时
  审视 server 侧版本 — 已对齐，无事可做。Based on:
  `apps/server/package.json`（headless ^6.0.0）、`apps/web/package.json`
  （xterm ^5.5.0）。
- **代码面预期零改动，出现不兼容才做最小适配**：探索已逐条核对 6.0 breaking
  changes 与唯一使用点 terminal-pane.tsx 的交集为空——所用全部选项
  （`allowProposedApi/convertEol/cursorBlink/cursorStyle/fontFamily/fontSize/
  lineHeight/scrollback/theme`）与 API（`open/write/writeln/reset/clear/
  focus/loadAddon/dispose/onData/onResize/cols/rows/element`）在 6.0 均健在；
  被移除的 `windowsMode`、`fastScrollModifier`、`overviewRulerWidth`、canvas
  渲染器、alt→ctrl hack 本项目均未使用；`@xterm/xterm/css/xterm.css` 深层引入
  路径在 6.0 仍有效（包无 exports 字段限制）。Rejected: 预防性改写组件 — 无
  依据的改动只会扩大回归面。Based on:
  `apps/web/src/components/workbench/terminal-pane.tsx:62-90`（选项与 API 清
  单）、xterm.js 6.0.0 release notes（#5105/#5462/#5107/#5346/#5104）。
- **6.0 配套 addon 已无 peerDependencies 声明**：fit 0.11.0 与 webgl 0.19.0
  的 package.json 均不含 peerDependencies，5.x 时代 `^5.0.0` peer 约束导致的
  安装冲突在新版本不存在，无需任何 pnpm peer 配置。Based on: unpkg 上
  `@xterm/addon-fit@0.11.0`、`@xterm/addon-webgl@0.19.0` 的 package.json
  （2026-07-19 核实）。

## Direction

单里程碑：改 `apps/web/package.json` 三个版本号，`pnpm install` 刷新
lockfile，构建通过。若 tsc 或 vite build 报出 6.0 类型/接口不兼容，在
terminal-pane.tsx 内做最小适配并在最终报告中列明每处适配及对应的上游变更。

### Milestone 1: 依赖升级且构建通过

`apps/web/package.json` 中 `@xterm/xterm` ^6.0.0、`@xterm/addon-fit`
^0.11.0、`@xterm/addon-webgl` ^0.19.0；`pnpm-lock.yaml` 同步；无多余依赖变
动。Validation: `pnpm --filter @coflux/web build` -> exit 0（含 `tsc -b`
类型检查与 vite 产物构建）。

## Landmines

- **#5096 滚动条/视口重写是 6.0 唯一实质行为变更**：6.0 采用 VS Code 式
  overlay 滚动条，滚动行为与视觉都变了。本项目三处依赖滚动行为，验收时必须
  人工过一遍：(1) attach 时 server 镜像快照重放后的滚动位置（快照包装成普通
  pty_output 下发，见 apps/server/src/hub.ts）；(2) tab 切换用 `display:
  none` 隐藏而非卸载（terminal-pane.tsx:185-190），重新显示后的 fit 与滚动位
  置；(3) `scrollback: 10_000`（terminal-pane.tsx:70）下的滚动手感与滚动条在
  `#0a0a0a` 深色主题上的视觉。这些属 acceptance 层，执行者不做。
- **WebGL addon 是动态 import 的独立 chunk**（terminal-pane.tsx:96-109），
  升级后需确认 vite 仍将其拆为独立 chunk 且懒加载路径 `@xterm/addon-webgl`
  可解析；该处注释写死"约 247KB"，0.19 体积若有明显变化可顺带更新注释数字，
  但不是必须。
- **黑盒测试需要本地 Postgres 直连口**：`pnpm -C tests test` 要求
  `COFLUX_TEST_PG_URL` 指向 54322（supavisor 的 5432 会报 tenant 错），且
  pretest 会编译 Rust。属 acceptance 层，由验证方运行。

## Scope

In scope:
- `apps/web/package.json`
- `pnpm-lock.yaml`
- `apps/web/src/components/workbench/terminal-pane.tsx`（仅当出现 6.0 不兼容需最小适配时）

Out of scope:
- `apps/server/**` — headless 侧已在 6.0，无需改动
- 新增任何 xterm addon（search/web-links/serialize 等）— 本次只做版本对齐
- terminal-pane.tsx 的重构、主题/选项调整 — 无升级必要性的改动一律不做
- Kitty 键盘协议 / Shift+Enter 支持 — 属 6.1 特性，另立需求

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Typecheck + build | `pnpm --filter @coflux/web build` | exit 0 |
| 黑盒 e2e (acceptance) | `COFLUX_TEST_PG_URL=<54322 直连口> pnpm -C tests test` | exit 0 |
| 终端行为人工验收 (acceptance) | `pnpm dev` 后按 Landmines 第一条的三点核对 | 行为不回退 |

## Done criteria

- [ ] `pnpm --filter @coflux/web build` exit 0。
- [ ] 三个依赖版本号如 Decisions 所列，lockfile 中 xterm 5.5.0 相关条目消失。
- [ ] 除 Scope 内文件外无任何变动；terminal-pane.tsx 若有改动，每处都对应一条上游 breaking change 并在报告中列明。
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.
- 适配量超出"最小适配"量级（如需改动 terminal-pane.tsx 之外的源码，或单文件改动超过 ~30 行）——说明 6.0 兼容性评估有误，停下报告而非硬改。

## Maintenance notes

- 6.0 起滚动条为 VS Code overlay 式；后续若有终端滚动相关 bug 报告，先怀疑 #5096 行为差异而非本项目逻辑。
- ghostty-web 留在观察列表（memory/terminal-mirror.md）：等其切到 Ghostty RenderState API 且发布稳定版后重估，换之前必须实测中文 IME。API 与 xterm.js drop-in 兼容，届时迁移成本约等于改 import。
- 6.1 将带来 Kitty 键盘协议（web 终端内 Shift+Enter 等），需要时单独立项。
