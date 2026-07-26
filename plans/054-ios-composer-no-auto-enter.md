# Plan 054: iOS 成文层发送去掉自动回车（复议 plan 053 发送语义）

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 4bcfd8d..HEAD -- apps/ios/Coflux/Views/TerminalInputArea.swift apps/ios/Coflux/Views/WorkspaceDetailView.swift`

## Status

- Priority: P1
- Effort: S
- Risk: LOW
- Depends on: none（复议 053 的已上线行为）
- Category: bug
- Execution: self
- Planned at: `4bcfd8d`, 2026-07-27

## Requirement

plan 053 定案的成文层发送语义是「主操作 = 文本+`\r`，长按 = 仅插入」
（`plans/053-ios-terminal-input-model.md:64`）。真机用下来该定案被推翻
（2026-07-27 用户复议）：发送后自动追加的回车会立刻把内容提交给行编辑器/
agent，用户失去了「先落文本、再自己决定何时回车」的控制权。

完成后为真：成文层（TerminalComposeOverlay）的发送操作只把草稿文本原样送入
终端，绝不追加 `\r`；回车一律由控制板右下角大回车键（已存在）补。发送键上的
长按手势及其「仅插入」备用语义随之失去存在意义，一并删除——点击是唯一操作。

正确 vs 相邻错误的分界：把「点击/长按语义互换」（点击=仅文本、长按=文本+回车）
实现出来是**错的**——departure check 已明确否决该选项，自动回车要彻底移除。

## Decisions & tradeoffs

- **发送语义**：点击发送 = 仅文本，无任何形式的自动回车。Rejected: 语义互换
  （长按 = 文本+回车）——用户在 departure check 明确选「彻底去掉自动回车」，
  保留任何自动回车路径都违背「换行时机由我决定」的原始诉求。
  Based on: `apps/ios/Coflux/Views/TerminalInputArea.swift:304-311`（现状：点击
  `onSend(true)`、长按 `onSend(false)`）。
- **参数链清理**：`onSend(_ newline:)` 与 `sendDraft(newline:)` 的布尔参数整链
  删除，而非留参恒传 `false`。Rejected: 保留参数以备将来——YAGNI，单一语义下
  死参数只会误导后来者。
  Based on: `apps/ios/Coflux/Views/WorkspaceDetailView.swift:337-346`（`sendDraft`
  是 `newline` 的唯一消费者，`:343` 的 `payload + "\r"` 是唯一追加点）。
- **多行 bracketed paste 保留**：草稿含 `\n` 时仍包 `\u{1b}[200~ … [201~`。
  这与本次复议正交——它防的是草稿**内部**换行被行编辑器当提交，不是追加回车。
  Based on: `apps/ios/Coflux/Views/WorkspaceDetailView.swift:340-342` 及其注释
  （Claude Code/zsh 开 2004 模式，2026-07-26 实测）。
- **注释同步**：`TerminalInputArea.swift` 顶部（`:6`）与 `TerminalComposeOverlay`
   doc 注释（`:222`）中「发送 = 文本+回车，长按 = 仅插入不回车」的表述必须改为
  新语义，plan 053 原文不动（历史决策记录）。Rejected: 只改代码不改注释——
  注释是下一个读者的第一信息源，留旧语义等于埋雷。

## Direction

单一里程碑，纯删减式改动，不引入任何新状态或新交互。

### Milestone 1: 发送仅落文本

TerminalComposeOverlay 的发送键点击后草稿文本（多行含 bracketed paste 包裹）
原样进入终端，无 `\r` 追加；长按手势与 newline 参数链在代码中不复存在；
相关注释与新语义一致。
Validation: 构建命令 exit 0；`grep -n 'newline' apps/ios/Coflux/Views/*.swift`
无输出。

## Scope

In scope:
- `apps/ios/Coflux/Views/TerminalInputArea.swift`
- `apps/ios/Coflux/Views/WorkspaceDetailView.swift`

Out of scope:
- `apps/ios/Coflux/Views/TerminalHostView.swift` — 硬件键盘直通路径，无自动回车问题
- 控制板大回车键（TerminalInputArea `enterKey`）— 行为不变，仍发 `\r`
- `plans/053-ios-terminal-input-model.md` — 历史决策记录不改写，本 plan 即复议记录
- web/mobile 端输入路径 — 本次仅复议 iOS 成文层

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| 构建 | `xcodebuild -project apps/ios/Coflux.xcodeproj -scheme Coflux -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=27.0' build CODE_SIGNING_ALLOWED=NO` | BUILD SUCCEEDED |
| 参数链残留 | `grep -rn 'newline' apps/ios/Coflux/Views/` | 无输出（exit 1） |
| 真机验收 (acceptance) | 成文层输入单行/多行并发送 → 终端只落文本不执行；按控制板大回车 → 执行 | 用户人工确认 |

## Done criteria

- [ ] 构建与 grep 检查通过。
- [ ] 点击发送后终端仅收到文本（多行仍带 bracketed paste 包裹），无 `\r`。
- [ ] 发送键无长按手势；`onSend`/`sendDraft` 无 newline 参数。
- [ ] 两处注释表述与新语义一致。
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.

## Maintenance notes

- 若将来又想要「一步到位」发送+回车，先回看本 plan 与 053 的两次反转，
  再决定交互形态（大概率是控制板加组合键，而非恢复发送键自动回车）。
- 真机 UI 验收按惯例由用户人工确认，Claude 不做模拟器走查。
