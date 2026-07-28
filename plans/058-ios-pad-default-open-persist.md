# Plan 058: iOS 控制板默认展开 + 每工作区持久化 + 浮键列序修正（复议 053/057）

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Stop on any STOP condition. When complete,
> update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 0ae44ce..HEAD -- apps/ios/Coflux/Views/WorkspaceDetailView.swift`

## Status

- Priority: P2
- Effort: S
- Risk: LOW
- Depends on: none
- Category: feature
- Execution: self
- Planned at: `0ae44ce`, 2026-07-28

## Requirement

现状：进入任务台控制板默认折叠成气泡（`inputCollapsed = true`，2026-07-26
定案「阅读优先」）。用户真机复议（2026-07-28）：默认展开更好用；且展开/
收起状态应**按工作区**本地持久化——退出工作区再进入，恢复上次离开时的
状态；从无记录的工作区（纯新）默认展开。

完成后为真：首次进入任一工作区控制板展开；用户收起后退出再进，该工作区
保持收起；另一个没动过的工作区仍默认展开。持久化只在本机（UserDefaults
级别），不跨设备同步。

附带复议 057 浮键列序（同日真机反馈）：滚到底键是瞬态键，放列中间浮现/
消失会把新建键顶来顶去。改为列顶：滚到底（浮现，列向上生长）→ 新建 →
键盘（守底），两个常驻键位置恒定不被撑动。

## Decisions & tradeoffs

- **默认值 = 展开**：复议并推翻 2026-07-26「默认折叠」定案。Based on:
  `apps/ios/Coflux/Views/WorkspaceDetailView.swift:16`（`@State private var
  inputCollapsed = true` 及注释）。
- **持久化粒度 = 工作区**：UserDefaults，key 含 `workspace.id`。Rejected:
  按任务粒度——任务生灭频繁、状态碎片化，用户口径也是「项目」；Rejected:
  全局单值——用户明确要按项目记忆。
- **UserDefaults.bool 缺省即语义**（decided while planning）：`bool(forKey:)`
  无记录返回 false，恰好 = 展开（collapsed=false），无需 object/nil 三态
  判断。Rejected: 存「expanded」正字段——缺省 false 会变成默认折叠，还得
  绕一层取反。
- **瞬态键置列顶**：滚到底键排最上，浮键列 bottom 对齐时向上生长，常驻键
  （新建/键盘）零位移。Rejected: 保持 057 的居中位——浮现即顶动新建键，
  用户明确不接受。Based on: `WorkspaceDetailView.swift` 浮键列 VStack
  （057 序：新建→滚到底→键盘）。
- **初值在 init 播种**（decided while planning）：自定义 init 里
  `State(initialValue:)` 读回，不用 onAppear 赋值——onAppear 在首帧后翻转
  会引发可见跳变 + 一次多余 resize（终端行列随面板高度变，SIGWINCH 无谓
  抖动）。Based on: `WorkspaceDetailView.swift:31`（terminalLift 由
  inputCollapsed 派生，直接驱动终端 offset 与面板渲染）。

## Direction

### Milestone 1: 默认展开 + 按工作区记忆

进入工作区时 inputCollapsed 从 UserDefaults（key 含 workspace.id）播种，
变更时写回；`:16` 旧注释同步为新定案。
Validation: 构建 exit 0。

## Scope

In scope:
- `apps/ios/Coflux/Views/WorkspaceDetailView.swift`

Out of scope:
- 跨设备同步（iCloud KVS）— 自用单机，YAGNI
- 成文层草稿持久化 — 未提出，不顺手加

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| 构建 | `xcodebuild -project apps/ios/Coflux.xcodeproj -scheme Coflux -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=27.0' build CODE_SIGNING_ALLOWED=NO` | BUILD SUCCEEDED |
| 真机验收 (acceptance) | 新工作区进入即展开；收起→退出→再进保持收起；另一工作区不受影响；杀 app 重启后记忆仍在 | 用户人工确认 |

## Done criteria

- [ ] 构建通过。
- [ ] 默认展开；状态按工作区持久化并在重进/重启后恢复。
- [ ] 浮键列序：滚到底（顶，浮现）→ 新建 → 键盘；浮现不位移常驻键。
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.

## Maintenance notes

- key 前缀 `terminalPadCollapsed.`；工作区删除后残留的 UserDefaults 条目
  体积可忽略，不做清理（YAGNI）。
