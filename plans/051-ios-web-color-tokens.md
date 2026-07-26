# Plan 051: iOS 配色对齐 web —— 移植暖调近黑 token 体系

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Stop on any STOP condition. When complete,
> update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat f1377dc..HEAD -- apps/ios/Coflux/`

## Status

- Priority: P2
- Effort: S
- Risk: LOW
- Depends on: none（前置 050 及暗色锁定 f1377dc 已完成）
- Category: feature
- Execution: self
- Planned at: `f1377dc`, 2026-07-26

## Requirement

iOS 锁暗色后 `systemBackground` 解析为纯黑 #000、文字纯白、状态色用系统
green/orange/red，与 web 的设计语言（Cursor 式暖调近黑、低对比分层、无彩
强调，`apps/web/src/index.css:15-54`）色温割裂，用户反馈"太黑"。

完成后：iOS 全部界面色取自 web 的 token 真相源——三层地面 terminal #0a0a0a
< background #0f0f0f < surface #151514，前景 #e6e6e3 / 次级 #75756d，状态色
success #4fae6e / warning #c9a227 / destructive #e05c6a——双端同一设计语言。

## Decisions & tradeoffs

- **token 真相源 = web `index.css` :root**: 移植为 Swift 常量（如
  `Theme.swift` 静态 Color），十六进制逐字对齐，不做"iOS 风格化"调整。
  Rejected: 继续用 iOS 语义色 —— 锁暗色后它们就是纯黑/纯白，正是被投诉的
  问题。Based on: `apps/web/src/index.css:31-53`。
- **三层地面语义移植**: 终端纸面 #0a0a0a（SwiftTerm backgroundColor +
  nativeBackgroundColor）、应用底 #0f0f0f（页面/列表行背景）、面板层
  #151514/#1f1f1e/#2a2a28 按 web 语义（card/secondary/input）用于填充类
  控件（登录输入框用 input token）。
- **文字层级映射**: 主文字 = foreground #e6e6e3（RootView 顶层
  `foregroundStyle` 级联默认）；secondaryLabel 位 → muted-foreground
  #75756d；tertiaryLabel 位（web 无对应）→ #75756d 降透明度。导航栏标题
  仍走系统 label（白），与 #e6e6e3 差异肉眼不可辨，不做 UIAppearance hack。
- **状态色映射**: green→success #4fae6e、orange（运行中被接管/main 分支/
  警示横幅）→warning #c9a227、red→destructive #e05c6a。web 侧 main 分支
  就用 warning 色（web 侧栏同语义），iOS 对齐。
- **玻璃与系统 chrome 不动**: glassEffect 材质、导航栏、confirmationDialog
  的系统 tint 保持原生——那是 047/050 的决策面，配色对齐只管内容色。
- **同步机制 = 手工**: web 换色时 iOS Theme.swift 手工同步（同 048 图标
  策略）；token 少、变更罕见，不值得自动化管道。

## Direction

### Milestone 1: Theme.swift + 全视图替换

新建 Theme 常量文件；Views 下所有 `Color(.system*)`/`.green`/`.orange`/
`.red`/`Color.primary` 类用法换 Theme token；SwiftTerm 背景换 #0a0a0a。
Validation: 构建命令通过，且
`grep -rn 'systemBackground\|secondarySystemBackground\|secondarySystemFill\|tertiaryLabel\|secondaryLabel' apps/ios/Coflux/Views/` 无输出。

## Landmines

- `project.pbxproj`/`Coflux.xcscheme` 用户签名改动仍在工作区，不得 commit、
  不得还原（同 047-050）。
- SwiftTerm 需同时设 `backgroundColor` 与 `nativeBackgroundColor`，只设前者
  终端 cell 底色仍是组件默认黑。
- LoginView 主按钮是"前景色当背景"的反色按钮（primary #ececea 底 +
  primaryForeground #0f0f0f 字），别按普通 tint 按钮改。

## Scope

In scope:
- `apps/ios/Coflux/Views/**`（含新建 Theme.swift；放 Views 或 Client 平级均可）

Out of scope:
- `apps/web/**` — 只读真相源
- `apps/ios/Coflux.xcodeproj/**` — 签名改动所在
- 导航栏/玻璃/系统弹窗的原生材质与 tint

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| 构建 | `xcodebuild -project apps/ios/Coflux.xcodeproj -scheme Coflux -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=27.0' build CODE_SIGNING_ALLOWED=NO` | BUILD SUCCEEDED |
| 残留检查 | `grep -rn 'systemBackground\|secondarySystemBackground\|secondarySystemFill\|tertiaryLabel\|secondaryLabel' apps/ios/Coflux/Views/` | 无输出（exit 1） |
| 真机视觉验收 (acceptance) | 真机与 web 并排对照：底色色温、文字灰阶、状态色 | 用户人工确认 |

## Done criteria

- [ ] 构建与残留检查通过。
- [ ] 三层地面/文字层级/状态色与 web token 十六进制一致。
- [ ] 玻璃药丸、导航栏等系统材质无回退。
- [ ] No out-of-scope files changed。
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.

## Maintenance notes

- Theme.swift 头注释注明真相源路径与"web 换色手工同步"约定。
- 若未来 token 数量膨胀或双端频繁换肤，再考虑从 index.css 生成（当前不值）。
