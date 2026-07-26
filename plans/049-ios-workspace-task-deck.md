# Plan 049: iOS 任务台单页 —— 终端横向 tab + 整页滑动切换 + 新建终端

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier. Stop on any STOP condition. When complete, update
> this plan in `plans/README.md`.
>
> Drift check: `git diff --stat cc3de9e..HEAD -- apps/ios/Coflux/`

## Status

- Priority: P2
- Effort: M
- Risk: MED
- Depends on: none（前置 046/047/048 已 DONE）
- Category: feature
- Execution: self
- Planned at: `cc3de9e`, 2026-07-26

## Requirement

现状 iOS 是三级结构：工作区列表 → 任务列表页 → 任务详情页（终端）。用户
判断终端不该藏在二级页之后——对齐 web mobile 的结构（`apps/mobile`
workspace-detail：进工作区即是终端现场，横向 tab 条切换多终端）。

完成后：点工作区直接进入**任务台单页**——顶部横向 tab 条列出该工作区全部
任务（含新建终端钮），终端区整页左右滑动（paged）切换任务；任务列表页与
任务详情页作为独立页面消失。并补齐 `taskCreate`：iOS 可自己新建终端，
不再依赖桌面端先建任务。

正确/错误解分界：正确解是单页多终端保活（tab/滑动切换即时呈现现场，与
mobile 同语义）；错误解是保留 push 层级只换外观、或切换时销毁重建终端
（每次切换 checkpoint 回放闪屏）。

## Decisions & tradeoffs

- **结构 = 工作区 → 任务台单页**: `TaskListView`、`TaskDetailView` 两页
  合并为一个任务台视图，`WorkspaceListView` 的 NavigationLink 直达。
  Rejected: 保留任务列表页 —— 用户明确要求终端不设二级页。
  Based on: mobile 同构 `apps/mobile/src/components/workspace-detail.tsx:23`
  （终端 Tab 条 + 进入即挂载）。
- **切换手势 = 整页 paged 滑动**（用户知情选择）: 终端区整页横滑翻页
  （TabView `.page` 或等价 paged 容器），tab 条点按同步联动。已向用户明示
  与 SwiftTerm 触摸（滚动回看/选择）及系统左缘返回手势的冲突风险，用户
  仍选整页滑动。Rejected: 仅 tab 条横滑 —— 用户否决；三指滑 —— 过隐蔽。
  缓解与验收观察点记入 Landmines。
- **多终端保活**: 所有任务页同时挂载、各自 attach（paged 容器天然保活），
  与 mobile"进入即挂载、返回列表整体卸载"同语义。Rejected: 仅激活页
  attach、切换换绑 —— 每次切换触发 checkpoint 回放，闪屏且丢滚动位置。
  Based on: `TerminalHostView.swift:51`（bind 即 attach 的 per-view 语义
  已自包含，多实例并存即多 session 并行 attach）；
  `CofluxClient.swift:496` registerSessionConsumer 按 sessionID 键控。
- **新建终端纳入本轮**: client 补 `createTask(workspaceID:title:)` 发
  `taskCreate`；标题沿 mobile 惯例「终端 N」。协议与 Swift 码生已就绪
  （`proto/coflux/v1/client.proto:136`，ProtoGen 同步组已含 client.pb.swift）。
  Rejected: 不做新建 —— iOS 将继续依赖桌面端建任务，半残。
- **变更 tab 不做**: mobile 的「变更」diff 视图是独立大件（parse-diff +
  渲染整套），另立 plan。Rejected: 本轮顺带 —— 范围失控。
- **每任务横幅语义保留**: 现 `TaskDetailView` 的 statusStrip（被接管旁观/
  强制接管、未启动/已退出可启动、输入缓冲满）逐任务保留，随激活页显示。
  删除任务操作（stop + taskRemove）保留，作用于当前激活任务。
- **导航标题** (decided while planning): 任务台页 inline 标题 = 工作区名，
  与 047 玻璃范式一致；tab 条自绘（水平滚动 chips + 状态点 + 新建钮），
  这是内容组件不是导航 chrome，不违背 047 决策。
- **taskCreate 无请求-响应关联**: 识别"自己刚建的任务"沿 mobile 做法——
  记录发送前已知 task id 集合，快照增量中新出现的该工作区任务即视为自建，
  自动激活其页。Based on: `apps/mobile/src/components/workspace-detail.tsx:188-194`。

## Direction

### Milestone 1: client 支持 taskCreate

`CofluxClient` 新增 `createTask(workspaceID:title:)`（send taskCreate）。
Validation: 构建命令通过（见 Commands）。

### Milestone 2: 任务台单页替换两级页

新任务台视图（如 `WorkspaceDetailView.swift`）：横向 tab 条（任务 chips +
状态点 + 新建钮）+ paged 终端区（每任务一页 = statusStrip + TerminalHostView，
全部保活）+ 空态（无任务时给新建入口）；`WorkspaceListView` 直链任务台；
`TaskListView.swift`、`TaskDetailView.swift` 删除。键盘焦点随激活页走。
Validation: 构建命令通过；
`ls apps/ios/Coflux/Views/TaskListView.swift apps/ios/Coflux/Views/TaskDetailView.swift`
→ 均不存在。

## Landmines

- **paged 容器与系统返回手势/SwiftTerm 触摸的冲突**（用户知情接受）：
  第 0 页左缘右滑，UIScrollView pan 与 interactivePopGestureRecognizer 竞争，
  返回可能变难——导航栏系统返回钮必须始终可用作兜底。SwiftTerm 的纵向滚动/
  长按选择与横向翻页 pan 方向正交，通常可共存，但 TUI 鼠标上报模式（Claude
  Code 这类）可能吃掉拖动——真机验收重点观察，不在本 plan 内解决到完美。
- **SwiftTerm 键盘焦点**：TerminalView 是 UIKit firstResponder；翻页后若不
  主动转移焦点，输入仍打到旧终端。切换激活页时需处理 becomeFirstResponder
  （或至少 resign 旧页），这是正确性问题不是体验细节。
- **TerminalHostView 的 dismantle/release**（`TerminalHostView.swift:28,66`）：
  任务被删除（本端或它端）时对应页要正确释放 consumer；paged 容器里页面
  移除路径必须走到 dismantle，否则 consumer 泄漏。
- **多 session 并行 attach 是新用法**：046 只验证过单页单 attach。
  `registerSessionConsumer` 按 sessionID 键控（`CofluxClient.swift:496`）
  理论支持并行，但 DeviceRouter 侧如有单 attach 假设会在此暴露——遇到即
  STOP 报告，不要在本 plan 里改 DeviceRouter。
- **`project.pbxproj`/`Coflux.xcscheme` 用户签名改动仍在工作区**：不得
  commit、不得还原（同 047/048）。新增/删除 Swift 文件经同步组自动生效，
  无需碰工程文件。
- **taskUpdated 乱序**：自建任务的识别窗口内可能先收到其它客户端建的任务，
  mobile 用"已知 id 集合差集"而非"下一个新任务"，照此语义。

## Scope

In scope:
- `apps/ios/Coflux/Client/CofluxClient.swift`（+createTask）
- `apps/ios/Coflux/Views/`（新任务台视图；TaskListView/TaskDetailView 删除；
  WorkspaceListView 改链接；TerminalHostView 允许为焦点管理做小改）

Out of scope:
- `apps/ios/Coflux/Client/DeviceRouter.swift` — 数据面不动；并行 attach 若在此碰壁即 STOP
- `apps/ios/Coflux.xcodeproj/**` — 用户签名改动所在
- 变更（diff）tab、快捷键条增强 — 另立 plan
- `apps/mobile/**`、`apps/web/**` — 只读参照

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| 构建 | `xcodebuild -project apps/ios/Coflux.xcodeproj -scheme Coflux -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=27.0' build CODE_SIGNING_ALLOWED=NO` | BUILD SUCCEEDED |
| 旧页删除检查 | `ls apps/ios/Coflux/Views/TaskListView.swift apps/ios/Coflux/Views/TaskDetailView.swift 2>&1` | No such file（两个都不存在） |
| 真机验收 (acceptance) | 真机 ⌘R：进工作区即终端现场；tab 点按/整页滑动切换即时无回放闪屏；新建终端自动激活；删除任务页收敛；被接管横幅/强制接管仍工作；左缘返回可用性观察 | 用户人工确认 |

## Done criteria

- [ ] 构建与旧页删除检查通过。
- [ ] 工作区列表点入直达任务台；无任务列表/任务详情二级页残留。
- [ ] 多任务同时保活：滑动/点 tab 切换无 checkpoint 回放闪屏；键盘输入始终落在当前激活终端。
- [ ] iOS 端可新建终端并自动激活新页；删除当前任务后页面与 tab 收敛不崩。
- [ ] statusStrip 三种横幅语义逐任务保留。
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed（尤其 pbxproj/xcscheme/DeviceRouter）。
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- 并行 attach 在 DeviceRouter/协议侧碰壁（需要改 out-of-scope 文件才能继续）。
- A validation command fails twice after one reasonable fix.

## Maintenance notes

- 手势冲突是知情取舍：若真机发现左缘返回或终端拖动不可用，回退方向是把
  翻页手势收窄到 tab 条（探索时的推荐方案），结构不变、只摘手势。
- 「变更」tab、iPad 多列布局等后续增强都挂在任务台这个容器上，别再造新层级。
