# Plan 053: 移动终端输入模型 —— 常驻控制板 + 原生成文输入框 + 气泡折叠

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Stop on any STOP condition. When complete,
> update `plans/README.md`.
>
> Drift check: `git diff --stat e4e9b94..HEAD -- apps/ios/Coflux/`

## Status

- Priority: P1
- Effort: M
- Risk: MED
- Depends on: none（前置 049-052 已 DONE）
- Category: feature
- Execution: self
- Planned at: `e4e9b94`, 2026-07-26

## Requirement

移动终端的瓶颈是输入不是显示：桌面"点终端唤系统键盘直打"的模型在手机上不可用
（软键盘无 Esc/Ctrl/方向、输入法弹收打断阅读、误触）。用户定案的新模型：

- **终端 = 纯显示流**：不再点击聚焦、不再唤起系统键盘（SwiftTerm 键盘/内置
  快捷条整体禁用）。
- **控制层 = 常驻精简控制板**：驻屏幕下部、不随任何输入状态自动隐藏；按键
  发单键序列——数字 1-0（TUI 菜单选择）、Esc、`/`、Tab、Shift+Tab（agent
  常用）、退格、专用 `^C`（中断）、方向四键、回车。无字母（字母走成文层），
  因此不设粘滞 Ctrl——组合键以专用键形式给出。
- **成文层 = 原生输入框**：iOS TextField + 系统输入法（中文可用），整段
  编辑后一次发送；**发送 = 文本+回车**，长按发送 = 仅插入文本不回车。
- **折叠 = 液态玻璃气泡**：手动折叠整个输入区（成文框+控制板）为右下角
  玻璃圆气泡（AssistiveTouch 式），点气泡展开；只听手动，不自动。

完成后：任务台页 = tab 条 + 终端页（纯显示）+ 输入区（成文框在上、控制板
在下，随激活任务路由），输入区可折叠为气泡；键盘焦点腾挪逻辑（plan 049 的
resignFirstResponder）整体删除。

## Decisions & tradeoffs

- **两层输入模型**（用户定案）: 控制层单键 + 成文层整段，贴合 agent CLI
  交互分布（大部分单键：菜单/y/n/Esc/shift+tab；偶尔整段 prompt）。
  Rejected: 点终端唤系统键盘（现状）——移动端不可用；全 QWERTY 自绘键盘
  ——用户选精简板，字母场景走成文层。
- **无字母 ⇒ 无粘滞 Ctrl，给专用 ^C**: 粘滞修饰键没有字母可组合即无意义；
  中断是 agent 场景最高频控制动作，直接一键 `\x03`。其余组合键需求出现时
  加专用键，不加修饰键体系。
- **SwiftTerm 降级为纯显示**: 子类覆写 `inputView` 返回空视图（挡系统键盘
  但保留 firstResponder 能力→长按选择/拷贝不破坏）、`inputAccessoryView`
  返回 nil（去内置快捷条）。保留 delegate send() 路径——外接硬件键盘
  （pressesBegan）仍然直通。plan 049 的 isActive/resignFirstResponder
  逻辑删除（无系统键盘即无错投）。
  Based on: `TerminalHostView.swift:15,30-32`（待删的焦点逻辑）。
- **方向键须尊重 DECCKM**: 应用光标模式（vim/less 等置位）下方向键应发
  `ESC O A..D`，普通模式发 `ESC [ A..D`。SwiftTerm `Terminal` 暴露
  `applicationCursor`；输入板经注册表查激活任务的终端实例取模式，取不到
  回退 CSI 序列。Rejected: 恒发 CSI —— 应用模式下方向键在部分 TUI 失效。
- **键序真相**: Esc=`\x1b`、Tab=`\t`、Shift+Tab=`\x1b[Z`（back-tab，Claude
  Code 循环切换用）、退格=`\x7f`、^C=`\x03`、回车=`\r`、`/`=字面量。
- **输入路由 = 激活任务的 session**: 控制板与成文框共享一份，发往
  activeTask.sessionID（`client.sendInput`，`CofluxClient.swift:480`）；
  激活任务非 RUNNING/无 session 时输入区禁用态（降透明+不可点）。
- **发送语义**（用户定案）: 主操作 = 文本+`\r`；长按 = 仅文本。发送后清空
  输入框、保持焦点（连续对话场景）。
- **气泡折叠**（用户定案）: 折叠钮在成文框行尾；折叠后整个输入区消失，
  右下角 overlay 玻璃圆钮（`glassEffect(.regular.interactive(), in: .circle)`，
  plan 050 同款 API），点击展开。折叠状态不持久化（会话内记忆即可）。
- **终端尺寸自适应**: 输入区展开/折叠改变终端可视高，SwiftTerm sizeChanged
  → resizeSession 既有链路自动处理，不需要额外代码。

## Direction

### Milestone 1: SwiftTerm 纯显示化

子类覆写 inputView/inputAccessoryView；删除 isActive 与 resign 逻辑；
注册表暴露 applicationCursor 查询。Validation: 构建通过，且
`grep -rn 'isActive\|resignFirstResponder' apps/ios/Coflux/Views/` 无输出。

### Milestone 2: 输入区（成文框 + 控制板 + 气泡）

新视图文件（成文框行 + 三行键区 + 折叠气泡），挂在任务台页底部、随激活
任务路由与禁用；键按下轻触感反馈。Validation: 构建通过。

## Landmines

- `project.pbxproj`/`Coflux.xcscheme` 用户签名改动在工作区，不得 commit/还原（同 047-052）。
- SwiftTerm `Terminal.applicationCursor` 属性名若与假设不符（构建报错），
  回退方案：方向键恒发 CSI，并在 plan 收尾注记欠账——不要为此改 SwiftTerm。
- 成文框聚焦时系统键盘会临时盖住控制板——这是预期行为（成文时不需要控制
  板），不要做避让动画。
- 终端页此前 `.ignoresSafeArea(.container, edges: .bottom)`：输入区常驻后
  底边不再贴屏幕，豁免要相应调整，折叠态下终端底边留安全区即可（别为
  折叠/展开做两套豁免）。

## Scope

In scope:
- `apps/ios/Coflux/Views/TerminalHostView.swift`
- `apps/ios/Coflux/Views/WorkspaceDetailView.swift`
- `apps/ios/Coflux/Views/`（新输入区视图文件）

Out of scope:
- `Client/**` — sendInput 既有能力够用，协议不动
- 光标信号联动（输入框状态提示）、agent 钩子推送 — 另立 plan
- iPad/横屏布局 — iPhone 纵向优先

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| 构建 | `xcodebuild -project apps/ios/Coflux.xcodeproj -scheme Coflux -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=27.0' build CODE_SIGNING_ALLOWED=NO` | BUILD SUCCEEDED |
| 焦点逻辑残留 | `grep -rn 'isActive\|resignFirstResponder' apps/ios/Coflux/Views/` | 无输出（exit 1） |
| 真机交互验收 (acceptance) | 菜单数字选择/Esc/^C/方向/shift+tab 逐键验证；成文框中文输入+发送；气泡折叠展开；终端点按不再弹系统键盘 | 用户人工确认 |

## Done criteria

- [ ] 构建与残留检查通过。
- [ ] 终端点按不弹系统键盘、无内置快捷条；硬件键盘直通保留。
- [ ] 控制板全部键位按既定键序发送、随激活任务路由、无 session 时禁用。
- [ ] 发送=文本+回车、长按=仅插入；发送后清空保焦点。
- [ ] 折叠为右下角玻璃气泡、点击展开；终端随之 resize。
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed。
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.

## Maintenance notes

- 后续增强都挂输入区容器上：光标信号驱动成文框提示（见 2026-07-26 实测：
  Claude Code DECTCEM 语义正确，菜单态 hidden/输入态 shown，需 100-200ms
  去抖）、长按键连发、自定义键位配置。
- 若真机发现高频缺键（如 Ctrl+D、方向长按连发），加专用键，不引入修饰键体系。
