# Plan 047: iOS 回归系统导航，启用 Liquid Glass

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat f8fd22b..HEAD -- apps/ios/Coflux/Views/`

## Status

- Priority: P2
- Effort: S
- Risk: LOW
- Depends on: none（前置 044/046 已 DONE）
- Category: feature
- Execution: self
- Planned at: `f8fd22b`, 2026-07-26

## Requirement

app 部署目标 iOS 26、Xcode 26.6 编译，系统层面 Liquid Glass 可用，但整个
app 视觉是纯扁平——因为 PR #23/#24 对标 Cursor iOS 时把三个页面的系统导航栏
全部藏掉（`.toolbar(.hidden, for: .navigationBar)`）并自绘 header（灰色填充
圆钮 + 34pt 自绘大标题 + 纯色背景）。Liquid Glass 的载体是系统 chrome
（导航栏、toolbar、系统返回钮，滚动内容从玻璃下流过），全被绕开了。

完成后：工作区列表、任务列表、任务详情三个页面使用系统 NavigationStack
导航栏（大标题/inline 标题 + `.toolbar` 放操作钮），滚动时出现原生玻璃
导航栏与折叠大标题，返回钮为系统玻璃圆钮；自绘 header、自绘大标题 Text、
`CircleIconButton` 全部删除。登录页保持现状。

正确/错误解分界：正确解是**删自绘、回归系统组件**让玻璃自然生效；错误解是
保留自绘 header 再给控件贴 `.glassEffect()`（玻璃下无内容流动，效果出不来，
已在探索阶段明确否决）。

## Decisions & tradeoffs

- **玻璃获取方式**: 回归系统导航 chrome（删 `.toolbar(.hidden)` 与自绘
  header，用 `.navigationTitle` + `.toolbar`）。Rejected: 保留 Cursor 式自绘
  布局、给 `CircleIconButton` 贴 `.glassEffect()`/`.buttonStyle(.glass)` ——
  header 不悬浮在滚动内容上，玻璃无内容流动感，效果出不来。
  Based on: 三处隐藏点 `apps/ios/Coflux/Views/WorkspaceListView.swift:55`、
  `TaskListView.swift:51`、`TaskDetailView.swift:42`。
- **改造范围**: 仅三个导航页面。登录页不动——它无导航 chrome，玻璃无舞台，
  Raycast 式表单保持现状（`LoginView.swift` 不在 in-scope）。
  Rejected: 全 app 玻璃化 —— 登录页无滚动内容与系统栏，改了没有收益。
- **导航结构**: 保持现有单 NavigationStack（`WorkspaceListView.swift:11`
  持有 stack，子页 push 共享），不新建 stack、不引入 TabView。
  Rejected: 每页各自 NavigationStack —— push 动画与返回手势会断。
- **标题形态** (decided while planning): 工作区列表 `.navigationTitle("工作区")`
  大标题；任务列表 `.navigationTitle(工作区名)` 大标题；任务详情 inline
  标题（终端页要最大化内容区），副标题（运行状态）用 iOS 26 的
  `.navigationSubtitle`。Rejected: 详情页也用大标题 —— 挤占终端空间。
- **toolbar 操作钮归位** (decided while planning): 工作区列表的头像 Menu
  （登出）放 `.topBarTrailing`（原生大标题范式惯例，原 Cursor 式左上头像
  作废）；任务详情的省略号 Menu（停止并删除）放 `.topBarTrailing`。返回钮
  一律系统默认（不自绘、不 `dismiss()`）。
- **横幅与状态条不动**: `offlineBanner`（WorkspaceListView）与
  `statusStrip`/`banner`（TaskDetailView）保留现有实现与位置语义，本轮只动
  导航 chrome。Rejected: 顺手玻璃化横幅 —— 范围蔓延，且横幅是状态提示不是
  chrome。
- **本地未提交的签名改动绕行**: 工作区当前有用户 Xcode 签名配置
  （`project.pbxproj` 的 `DEVELOPMENT_TEAM = 8Y2J55823C` + 版本戳、
  `Coflux.xcscheme` 版本戳），按 plan 044 约定**不提交也不还原**——执行时
  只 stage/commit `apps/ios/Coflux/Views/` 与 `plans/`，preflight 的
  clean-worktree 要求对这两个文件豁免。
  Based on: `plans/044-ios-app-skeleton-client-login.md:189`。

## Direction

单里程碑：三个页面删自绘导航、接回系统 chrome。执行者对照现有代码自行设计
（如 `List` 需成为导航容器内的主滚动视图以驱动大标题折叠/玻璃化，外层
`VStack` 里的自绘 header/Text 移除后结构自然满足）。

### Milestone 1: 三页面回归系统导航栏

WorkspaceListView/TaskListView/TaskDetailView 无 `.toolbar(.hidden)`、无自绘
header 与大标题、无 `CircleIconButton`（连同定义删除）；标题/操作钮按
Decisions 归位。Validation:
`xcodebuild -project apps/ios/Coflux.xcodeproj -scheme Coflux -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=27.0' build CODE_SIGNING_ALLOWED=NO`
→ BUILD SUCCEEDED，且 `grep -rn 'toolbar(.hidden, for: .navigationBar)\|CircleIconButton' apps/ios/Coflux/Views/` 无输出。

## Landmines

- `TaskDetailView.swift:74`：Menu label 里 `CircleIconButton(...).allowsHitTesting(false)`
  是个 hack（按钮套按钮），删 `CircleIconButton` 时这里要整体换成普通
  `Label`/`Image` label，不是只换外观。
- `TaskListView.swift:8`、`TaskDetailView.swift:10` 的 `@Environment(\.dismiss)`
  仅服务自绘返回钮；返回钮回归系统后，`TaskDetailView` 里"停止并删除"确认后的
  `dismiss()`（`TaskDetailView.swift:47`）仍需保留，`TaskListView` 的可整个删掉。
- `TaskDetailView` 终端区 `.ignoresSafeArea(.container, edges: .bottom)`
  （`TaskDetailView.swift:33`）与系统导航栏共存没问题（只豁免底边），但删
  header 后注意别顺手改成全边豁免，否则终端顶行会被玻璃导航栏盖住。
- 工作区当前的 `project.pbxproj`/`Coflux.xcscheme` 未提交改动是用户签名配置，
  **不得 commit、不得 checkout 还原**（还原会弄坏用户真机运行）。

## Scope

In scope:
- `apps/ios/Coflux/Views/WorkspaceListView.swift`
- `apps/ios/Coflux/Views/TaskListView.swift`
- `apps/ios/Coflux/Views/TaskDetailView.swift`

Out of scope:
- `apps/ios/Coflux/Views/LoginView.swift` — 无导航 chrome，玻璃无舞台
- `apps/ios/Coflux/Views/TerminalHostView.swift`、`Client/` — 数据面/协议层与本轮无关
- `apps/ios/Coflux.xcodeproj/**` — 用户本地签名配置所在，不碰
- 横幅/状态条视觉（offlineBanner、statusStrip）— 非 chrome，另轮再议

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| 构建 | `xcodebuild -project apps/ios/Coflux.xcodeproj -scheme Coflux -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=27.0' build CODE_SIGNING_ALLOWED=NO` | BUILD SUCCEEDED |
| 残留检查 | `grep -rn 'toolbar(.hidden, for: .navigationBar)\|CircleIconButton' apps/ios/Coflux/Views/` | 无输出（exit 1） |
| 真机视觉验收 (acceptance) | 用户真机 ⌘R，滚动列表看玻璃导航栏/大标题折叠/系统返回钮 | 用户人工确认 |

## Done criteria

- [ ] 构建与残留检查命令通过。
- [ ] 三页面滚动时出现系统玻璃导航栏与大标题折叠（详情页 inline + subtitle），返回钮为系统默认。
- [ ] 头像 Menu（登出）与省略号 Menu（停止并删除）在 toolbar 中可用，行为不变。
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed（尤其 pbxproj/xcscheme 保持未提交原样）。
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.
- 发现玻璃仍不生效且原因在 Views 之外（如构建设置层兼容开关）——超出本 plan 判断，停下报告。

## Maintenance notes

- 视觉基调自此从"Cursor 扁平自绘"切到"iOS 26 原生玻璃"；后续新页面默认用系统
  chrome，不再自绘 header。f8fd22b 提交的 web 设计规范文档不约束 iOS 端。
- 登录页与横幅若将来要统一质感，另立 plan。
