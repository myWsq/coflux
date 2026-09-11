# Plan 109: 桌面版终端里的 URL ⌘+点击在系统浏览器打开

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat df18ba9..HEAD -- apps/desktop/src/renderer/components/workbench/terminal-pane.tsx apps/desktop/src/renderer/components/workbench/workspace-terminal.tsx apps/desktop/src/main/window.ts apps/desktop/src/preload/index.ts apps/desktop/package.json`

## Status

- Priority: P2
- Effort: S
- Risk: LOW
- Depends on: none（106 之后渲染层已在 `apps/desktop/src/renderer`，本 plan 基于 main `df18ba9`）
- Category: bug
- Execution: subagent（宿主通用子 agent，`model: opus`；出发检查 2026-09-11 记录，全自动推进，不再确认）
- Planned at: `df18ba9`, 2026-09-11

## Requirement

桌面版（`apps/desktop`，Electron 44）终端里输出的 URL 点不开：用户按住 ⌘ 点击没有反应，普通点击同样没有反应，
控制台只有一句 `Opening link blocked as opener could not be cleared`。

根因（探索已核实，勿再排查）：终端用无参 `new WebLinksAddon()` 装载链接插件
（`apps/desktop/src/renderer/components/workbench/terminal-pane.tsx:217`）。`@xterm/addon-web-links` 0.12 的默认激活函数
先调用**不带 URL** 的 `window.open()`、拿到新窗口后再赋 `location.href`
（`node_modules/@xterm/addon-web-links/src/WebLinksAddon.ts:24-36`）。而桌面版主进程对所有 `window.open` 一律
`{ action: "deny" }`、只把 http(s) 的 URL 交系统浏览器（`apps/desktop/src/main/window.ts:63-66`）——主进程收到的是
`about:blank`，丢弃；`window.open()` 返回 null，插件只 warn 一句，什么都不打开。网页版时代能用，是因为浏览器真的会
开新 Tab。同一目录的端口预览按钮用**带 URL** 的 `window.open(preview.url, "_blank", "noreferrer")`
（`workspace-terminal.tsx:486`），走的正是主进程外链放行，一直可用。

### 产品结论（探索阶段已确认，勿再问）

- **手势**：只有修饰键+点击才打开——macOS 按 ⌘（`metaKey`），其它平台按 Ctrl（`ctrlKey`），与 VS Code / iTerm 一致。
  普通点击只聚焦终端、不打开任何东西，避免用户点进 claude 会话时误开浏览器。
- **打开位置**：系统默认浏览器，沿用主进程现有的外链放行；不在 app 内开窗口、不开新 Tab。
- **不在范围**：悬停下划线仍按 xterm 默认（鼠标悬停即下划线，不按修饰键门控）；主进程外链策略、其它 `window.open`
  调用点、xterm 其它行为都不动。
- **验收（用户视角）**：终端输出里的 http(s) 链接，⌘+点击在系统浏览器打开；普通点击无反应；非 http(s) 的 URL 主进程
  照旧不放行。用户在真机桌面版人工走查；按既定约定 Claude 不做 UI 走查，执行者与验证者都不启动 app、不跑浏览器。

## Decisions & tradeoffs

- **修法只在渲染层：给 `WebLinksAddon` 构造函数传自定义激活函数**，激活函数带 URL 调
  `window.open(uri, "_blank", "noopener")`，主进程现有 `setWindowOpenHandler` 拿到真实 URL 后交 `shell.openExternal`。
  Rejected: 新增 preload 桥 / IPC `openExternal`——多一条 IPC 面、多一处信任边界，收益为零，带 URL 的 `window.open`
  已是同目录在用的通路；Rejected: 改主进程让 `about:blank` 放行再由渲染层赋 `location.href`——主进程 deny 后根本没有
  窗口对象可赋值。Based on: `apps/desktop/src/main/window.ts:20-25, 63-66`；`workspace-terminal.tsx:486`；
  `node_modules/@xterm/addon-web-links/typings/addon-web-links.d.ts:23`
  （`constructor(handler?: (event: MouseEvent, uri: string) => void, options?)`）。
- **修饰键门控放在激活函数里，规则是 `metaKey || ctrlKey` 任一为真即打开，不做平台判断**。xterm 的 Linkifier 在
  mousedown/mouseup 落同一链接时无条件调用 `link.activate(event, text)`，不看修饰键，也没有"要求修饰键"的插件选项，
  所以门控只能在激活函数里做。桌面版只打 macOS 包（`apps/desktop/electron-builder.yml:32-48` 仅 `mac` 目标），
  接受 `ctrlKey` 是为跨平台语义留门、代价为零。Rejected: 用 `navigator.platform` 分平台只认 meta 或只认 ctrl——
  多一处平台探测、没有对应收益；Rejected: 普通点击也打开（xterm 默认）——产品结论已否。
  Based on: `node_modules/@xterm/xterm/src/browser/Linkifier.ts:216-232`；`electron-builder.yml:32-48`。
- **不依赖 `window.open` 的返回值**：Electron 下主进程 deny，返回值恒为 null；激活函数不据此分支、不打 warn。
  Based on: `apps/desktop/src/main/window.ts:63-66`。
- **"应否打开"抽成纯函数并配 `node --test` 单测**（decided while planning，探索时留给执行者、此处定下）：新模块放在
  `apps/desktop/src/renderer/components/workbench/` 下，测试文件同目录 `*.test.ts`，被 `apps/desktop/package.json`
  的 `test` 脚本 glob 覆盖。纯函数只接收事件的字段（`metaKey`/`ctrlKey`，是否再看 `button` 由执行者定），不在运行时
  触碰 `MouseEvent`/`window` 等 DOM 全局——渲染层单测在纯 Node 下跑、没有 DOM。`window.open` 调用本身不进单测。
  Rejected: 不写测试——修饰键组合是本 plan 唯一的逻辑，值得一条断言；Rejected: 引入 jsdom 测 `window.open`——新依赖、
  收益为零。Based on: `apps/desktop/package.json` 的 `test` 脚本；`desktop-update.test.ts:1-10`（现有单测写法）。
- **主进程 / preload / shared 桥接类型零改动**。Based on: `apps/desktop/src/preload/index.ts` 无 openExternal 桥；
  探索结论"带 URL 的 `window.open` 已足够"。

## Direction

单一里程碑，无并行拆分。

### Milestone 1: ⌘+点击终端链接在系统浏览器打开，普通点击不打开

- `terminal-pane.tsx` 装载 `WebLinksAddon` 时传入自定义激活函数；该行"默认 window.open 新开 Tab"的注释改口为
  实际行为（修饰键门控 + 带 URL 的 `window.open` 交主进程外链放行）。
- 新纯函数模块 + 单测：至少覆盖「无修饰键 → 不打开」「metaKey → 打开」「ctrlKey → 打开」。
- Validation: `pnpm -C apps/desktop typecheck` -> exit 0；`pnpm -C apps/desktop test` -> 全绿且含新用例；
  `pnpm -C apps/desktop build` -> exit 0。

## Landmines

- `terminal-pane.tsx:217` 的注释"默认 window.open 新开 Tab"描述的是浏览器行为，在 Electron 下是假的；改代码时一并改口，
  否则下一个读者又会以为默认能用。
- 插件默认激活函数（`node_modules/@xterm/addon-web-links/src/WebLinksAddon.ts:24-36`）在 `window.open()` 返回 null 时
  只 `console.warn`，不抛错——症状是"静默无反应"，不要按异常路径去找。
- `window.open(url, ...)` 在桌面版永远返回 null（主进程 deny 后交 `shell.openExternal`），非 http(s) 的 URL 也被主进程
  丢弃（`window.ts:20-25`）——渲染层不用再校验 scheme，也不用处理返回值。
- 渲染层单测是纯 Node `node --test`（`apps/desktop/package.json` 的 `test`），没有 DOM：纯函数模块顶层不能引用
  `window`/`MouseEvent` 运行时值，类型引用可以。
- 本 worktree 从主工作树切出、没有 `node_modules`：`dev:execute-plan` 预检时在仓库根跑 `pnpm install --frozen-lockfile`
  再验证；执行者不要改 lockfile。

## Scope

In scope:
- `apps/desktop/src/renderer/components/workbench/terminal-pane.tsx`
- `apps/desktop/src/renderer/components/workbench/<新纯函数模块>.ts` 与同名 `.test.ts`（命名由执行者定，须在该目录）
- `plans/109-desktop-terminal-links.md`、`plans/README.md`

Out of scope:
- `apps/desktop/src/main/**`、`apps/desktop/src/preload/**`、`apps/desktop/src/shared/**` — 主进程外链策略与桥接不动
- `apps/desktop/src/renderer/components/workbench/workspace-terminal.tsx` — 端口预览的 `window.open` 已可用
- `apps/desktop/package.json`、`pnpm-lock.yaml` — 不加依赖、不升版本
- xterm 悬停下划线的修饰键门控 — 产品结论明确不做

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Install（预检，仓库根） | `pnpm install --frozen-lockfile` | exit 0，lockfile 无 diff |
| Typecheck | `pnpm -C apps/desktop typecheck` | exit 0 |
| Unit tests | `pnpm -C apps/desktop test` | exit 0，含新增用例 |
| Build | `pnpm -C apps/desktop build` | exit 0 |
| 真机走查 (acceptance) | 用户在桌面版终端里 ⌘+点击 / 普通点击一个 http(s) 链接 | ⌘+点击系统浏览器打开；普通点击无反应 |

## Done criteria

- [ ] All listed commands pass.
- [ ] 终端输出里的 http(s) 链接：⌘（或 Ctrl）+点击在系统浏览器打开；普通点击不打开。
- [ ] 新单测断言无修饰键不打开、meta/ctrl 任一打开。
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds（尤其：主进程 `setWindowOpenHandler` 不再把 http(s) 交
  `shell.openExternal`，或 `WebLinksAddon` 构造函数不再接受 handler）。
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.
- A named assumption is false.

## Maintenance notes

- 以后若要"悬停时只有按住 ⌘ 才显示下划线"（VS Code 式），xterm `ILink.decorations` 可动态改、`WebLinksAddon` 的
  `options.hover/leave` 可拿到事件，但要自己监听 keydown/keyup 同步修饰键状态；本 plan 明确不做。
- 主进程 `openExternalIfHttp` 是唯一的 scheme 白名单；渲染层任何新的"打开外链"都应继续走带 URL 的 `window.open`
  而不是新加 IPC。
