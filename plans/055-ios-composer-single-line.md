# Plan 055: iOS 成文层收窄为单行纯文本（去 bracketed paste，复议 053/054）

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Stop on any STOP condition. When complete,
> update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat b236eb0..HEAD -- apps/ios/Coflux/Views/TerminalInputArea.swift apps/ios/Coflux/Views/WorkspaceDetailView.swift`

## Status

- Priority: P1
- Effort: S
- Risk: LOW
- Depends on: none（在 054 之上继续收窄）
- Category: bug
- Execution: self
- Planned at: `b236eb0`, 2026-07-28

## Requirement

plan 054 去掉自动回车后，真机仍出现「有时自动发出去」：草稿含换行时代码会包
bracketed paste（`\u{1b}[200~…[201~`）发送，该保护依赖接收端开 2004 模式——
接收端未开时包裹转义被忽略，草稿内的原始 `\n` 被当回车执行。表现为时灵时不灵。

用户定案（2026-07-28）：成文层就是**单行普通输入**，不允许包含换行符，发送
时不做任何转义包裹，字面文本原样落终端。多行输入不是成文层的职责。

完成后为真：成文输入框为单行（键盘回车不再往草稿里插 `\n`）；发送路径无
bracketed paste 包裹逻辑；即使草稿经粘贴等途径混入换行符，发出的字节里也
不含 `\n`/`\r`（防御性剥离）。

## Decisions & tradeoffs

- **单行输入框**：TextField 去掉 `axis: .vertical` 与 `lineLimit(1...6)`。
  Rejected: 保留多行编辑、发送时再拍平——输入框展示多行但发出去变一行，
  所见非所得。Based on: `apps/ios/Coflux/Views/TerminalInputArea.swift:291-292`。
- **发送去包裹 + 防御剥离**：`sendDraft` 删掉 bracketed paste 分支；草稿中的
  换行符（含粘贴带入）以空格拍平后发送。Rejected: 信任单行输入框不会有
  换行——粘贴路径无法保证，信任边界上做剥离是必须的。
  Based on: `apps/ios/Coflux/Views/WorkspaceDetailView.swift:340-343`。
- **键盘回车 = 发送**（decided while planning）：单行 TextField 的系统回车键
  行为从「插入换行」变为 submit，接 `.submitLabel(.send)` + `.onSubmit` 走与
  发送键完全相同的路径（仅落文本，不追加 `\r`，054 语义不变）。Rejected:
  回车键只收键盘——单行输入下回车无别的合理语义，白白浪费一个高频操作位。
- **控制板粘贴键不动**：`pasteKey` 的 bracketed paste 包裹保留——剪贴板天然
  可能多行，包裹在开 2004 的接收端是正确行为；其局限（未开 2004 时失效）与
  本 plan 正交，用户未复议该键。Based on:
  `apps/ios/Coflux/Views/TerminalInputArea.swift:124-132`。

## Direction

单一里程碑，纯删减 + 单行化，不引入新状态。

### Milestone 1: 单行成文层

输入框单行、回车即发送；发送字节 = 草稿字面文本（换行已拍平），无任何转义
包裹；相关注释（TerminalInputArea 顶部、pasteKey「与成文层同理」表述、
sendDraft doc）与新语义一致。
Validation: 构建 exit 0；`grep -n '200~' apps/ios/Coflux/Views/WorkspaceDetailView.swift`
无输出；`grep -n 'axis' apps/ios/Coflux/Views/TerminalInputArea.swift` 无输出。

## Scope

In scope:
- `apps/ios/Coflux/Views/TerminalInputArea.swift`
- `apps/ios/Coflux/Views/WorkspaceDetailView.swift`

Out of scope:
- 控制板 pasteKey — 保留 bracketed paste（见 Decisions）
- `apps/ios/Coflux/Views/TerminalHostView.swift` — 硬件键盘直通，不经成文层
- plans/053、054 文档 — 历史记录不改写

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| 构建 | `xcodebuild -project apps/ios/Coflux.xcodeproj -scheme Coflux -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=27.0' build CODE_SIGNING_ALLOWED=NO` | BUILD SUCCEEDED |
| 包裹残留 | `grep -n '200~' apps/ios/Coflux/Views/WorkspaceDetailView.swift` | 无输出（exit 1） |
| 多行残留 | `grep -n 'axis' apps/ios/Coflux/Views/TerminalInputArea.swift` | 无输出（exit 1） |
| 真机验收 (acceptance) | 输入单行发送 → 仅落文本；键盘回车 → 同发送；粘贴多行文本进输入框再发送 → 终端收到单行 | 用户人工确认 |

## Done criteria

- [ ] 构建与两条 grep 检查通过。
- [ ] 输入框单行；键盘回车与发送键同路径，均仅落文本不追加 `\r`。
- [ ] 发出的字节不含 `\n`/`\r`，无 bracketed paste 包裹。
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.

## Maintenance notes

- 「时灵时不灵」根因记录：bracketed paste 只在接收端开 2004 时安全，作为
  发送侧默认策略不可靠。将来若要支持成文层多行，需按接收端状态（如光标
  可见性信号）动态决策，而非无条件包裹。
