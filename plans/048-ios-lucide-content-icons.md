# Plan 048: iOS 内容图标对齐 web（lucide）

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier. Stop on any STOP condition. When complete, update
> this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 5f84f3b..HEAD -- apps/ios/Coflux/`

## Status

- Priority: P3
- Effort: S
- Risk: LOW
- Depends on: none（前置 047 已 DONE）
- Category: feature
- Execution: self
- Planned at: `5f84f3b`, 2026-07-26

## Requirement

iOS 与 web 是同一产品，但 iOS 用 SF Symbols、web 用 lucide，内容图标（git
分支、文件夹、终端）双端图形语言不一致，其中 `arrow.branch` 与 lucide
`GitBranch` 差异肉眼最明显。完成后：iOS 的**内容图标**换成与 web 相同的
lucide 图形（git-branch、folder、square-terminal），系统 chrome 与状态提示
图标（toolbar 省略号/头像、横幅 wifi/eye/hourglass 等）维持 SF Symbols。

正确/错误解分界：正确解只替换内容图标且不引入第三方依赖（SVG 进 asset
catalog 模板渲染）；错误解是全量换 lucide（丢系统动态字重/无障碍，玻璃
toolbar 观感偏离 iOS 原生，已否决）或引 lucide Swift 包（无官方包，社区包
不可控）。

## Decisions & tradeoffs

- **替换范围 = 仅内容图标**: `arrow.branch`→lucide git-branch（工作区行）、
  `folder`→lucide folder（项目分组头）、`square.terminal`→lucide
  square-terminal（任务空态/任务不存在）。其余 SF Symbols（`ellipsis`、
  `person.fill`、`tray`、横幅/登录页图标）不动。Rejected: 全量 lucide ——
  系统 toolbar 钮用 SF Symbols 是平台惯例，收益的九成在这三个内容图标上。
- **获取方式 = SVG 资产，零依赖**: 从 web 已装的 `lucide-react@1.24.0`
  提取路径数据，手工落成三个 SVG 文件进新建 `Assets.xcassets`（imageset，
  `preserves-vector-representation` + `template-rendering-intent: template`），
  着色走 `foregroundStyle`。Rejected: 引 lucide Swift 社区包 —— 为 3 个图标
  加一个不可控依赖；Rejected: SwiftUI Path 手写 —— SVG arc 手转易错。
  Based on: 路径数据 `apps/web/node_modules/lucide-react/dist/esm/icons/
  {git-branch,folder,square-terminal}.mjs`（24×24、stroke 2、圆头圆角）。
- **不动 pbxproj**: `Coflux` 组是 `PBXFileSystemSynchronizedRootGroup`
  （`apps/ios/Coflux.xcodeproj/project.pbxproj:31`），`Coflux/` 下新增
  `Assets.xcassets` 自动进 target，无需编辑工程文件——工程文件当前有用户
  未提交的签名改动（plan 047 已豁免），继续不碰不提交。
- **尺寸语义** (decided while planning): 资产图不吃 `.font()` 缩放，替换处
  改为显式 `.resizable().scaledToFit().frame(...)`，视觉尺寸与原 SF Symbol
  渲染尺寸相当（正文行图标约 18–20pt），行布局（`frame(width: 24)` 对齐位）
  不变。空态 `ContentUnavailableView` 用 `Label(_:image:)` 换掉
  `systemImage:` 形式。

## Direction

单里程碑。lucide SVG 内容自 mjs 路径数据重组（stroke="black"、
stroke-width="2"、stroke-linecap/linejoin="round"、fill="none"、
viewBox="0 0 24 24"），模板渲染吃 alpha 通道，颜色无所谓。

### Milestone 1: 三个内容图标换 lucide

`Assets.xcassets` 含 git-branch/folder/square-terminal 三个模板 imageset；
`WorkspaceListView`（行图标、分组头）、`TaskListView`（空态）、
`TaskDetailView`（任务不存在空态）引用新资产；SF Symbols 仅存于 chrome/状态
图标。Validation:
`xcodebuild -project apps/ios/Coflux.xcodeproj -scheme Coflux -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=27.0' build CODE_SIGNING_ALLOWED=NO`
→ BUILD SUCCEEDED，且
`grep -rn 'arrow.branch\|systemName: "folder"\|square.terminal' apps/ios/Coflux/Views/` 无输出。

## Landmines

- `project.pbxproj`/`Coflux.xcscheme` 工作区有用户签名改动，**不得 commit、
  不得还原**（同 plan 047）。新增资产不需要碰它们；若发现需要碰，即 STOP。
- 模板渲染的着色：workspace 行分支图标有条件色（main 分支橙色，
  `WorkspaceListView.swift` workspaceRow），换资产后 `foregroundStyle`
  逻辑必须保留。

## Scope

In scope:
- `apps/ios/Coflux/Assets.xcassets/**`（新建）
- `apps/ios/Coflux/Views/WorkspaceListView.swift`
- `apps/ios/Coflux/Views/TaskListView.swift`
- `apps/ios/Coflux/Views/TaskDetailView.swift`

Out of scope:
- `apps/ios/Coflux.xcodeproj/**` — 用户签名改动所在，同步组机制下也无需碰
- `LoginView.swift`、横幅/toolbar 的 SF Symbols — chrome/状态图标维持系统惯例
- web 端一切文件 — 只读取 node_modules 路径数据

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| 构建 | `xcodebuild -project apps/ios/Coflux.xcodeproj -scheme Coflux -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=27.0' build CODE_SIGNING_ALLOWED=NO` | BUILD SUCCEEDED |
| 残留检查 | `grep -rn 'arrow.branch\|systemName: "folder"\|square.terminal' apps/ios/Coflux/Views/` | 无输出（exit 1） |
| 真机视觉验收 (acceptance) | 用户真机 ⌘R，对照 web 侧栏看分支/文件夹/终端图标 | 用户人工确认 |

## Done criteria

- [ ] 构建与残留检查命令通过。
- [ ] 三个内容图标为 lucide 图形且随 `foregroundStyle` 着色（main 分支橙色逻辑保留）。
- [ ] chrome/状态图标仍是 SF Symbols。
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed（尤其 pbxproj/xcscheme 保持未提交原样）。
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds（尤其同步组机制失效、需要编辑 pbxproj 时）。
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.

## Maintenance notes

- lucide 版本对齐以 web 的 `lucide-react` 为准（当前 1.24.0）；web 升级换了
  图形时，iOS 的 SVG 需手工同步——图标少，暂不值得自动化。
- 后续新增内容图标沿用此模式（SVG imageset 模板渲染）；chrome 图标继续 SF Symbols。
