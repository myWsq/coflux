# Plan 111: 桌面版确认框对齐 Cursor 样式——无标题栏 alertdialog、底栏键位提示、Enter 直接执行

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 34078ff..HEAD -- apps/desktop/src/renderer/components/workbench/dialogs.tsx apps/desktop/src/renderer/components/workbench/workbench.tsx apps/desktop/src/renderer/index.css`

## Status

- Priority: P2
- Effort: S
- Risk: LOW
- Depends on: none
- Category: feature
- Execution: self
- Planned at: `34078ff`, 2026-09-11

## Requirement

桌面版（`apps/desktop` 渲染层）现在的确认框是一个普通 Dialog：带右上角 × 的标题栏、正文一行、底栏无分割线、灰底「取消」+ 红色动作按钮；Esc 能关、点遮罩也关、Enter 没有确认语义。用户希望所有确认框对齐 Cursor 的确认框样式（参考截图「Close this window?」）：

- 无标题栏、无 ×；标题与弱化说明文字在同一内容块里。
- 内容区与底栏之间有分割线。
- 底栏右对齐两个按钮，同高、比现在小一号：「取消」是无底色的纯文字按钮，动作按钮是填充色；每个按钮内部、紧跟文字尾部有弱化的键位提示——取消带 `Esc`，动作带回车符号。
- 交互：Esc 取消、Enter 直接执行动作、点遮罩不关。

**产品结论（探索阶段已确认）**

1. **范围**：`ConfirmActionDialog` 重做；它的四个调用点（移除项目、删除工作区、移除设备、停止并关闭终端，均在 `workbench.tsx`）零改动。三个重命名对话框（工作区 / 设备 / 项目）和「添加设备」对话框是表单弹窗，保留标题栏与 ×，只把底栏按钮换成同一套（小一号尺寸、取消纯文字、同样的键位提示）。
2. **动作按钮颜色**：四个动作都是删除类，保持红色 destructive，不照抄 Cursor 的蓝色主色。蓝色留给以后可能出现的非破坏性确认。
3. **键位提示形态**：无边框的弱化文字，不是键帽方块。
4. **不动的部分**：主进程「服务器地址」原生 `showMessageBox`、iOS 端。
5. **验收（用户可观察）**：打开任一确认框看不到 ×；按 Enter 即执行、按 Esc 即取消、点遮罩无反应；底栏两按钮各带键位提示；四个表单弹窗底栏按钮与确认框同款（尺寸、取消样式、提示），表单的 Enter 提交行为不变。

## Decisions & tradeoffs

- **基座**：确认框仍用 Astryx `Dialog` + `Layout` 自组，并声明 `role="alertdialog"`、`purpose="form"`。Rejected: 切到 Astryx `AlertDialog` —— 它的两个按钮写死为 ghost 取消 + 动作、无 `endContent` 槽位、不可调尺寸，放不进键位提示。Based on: `apps/desktop/node_modules/@astryxdesign/core/src/AlertDialog/AlertDialog.tsx:181-193`（按钮固定、只接 label）；`Dialog.tsx:91`（`purpose='form'` = 禁遮罩点击、允许 Esc）。
- **无标题栏**：去掉 `DialogHeader`，标题用 `Heading level={2}` 放进 `LayoutContent`，说明用 `Text type="body" color="secondary"`（与 Astryx `AlertDialog` 的内容写法一致）。Rejected: 保留 `DialogHeader` 只隐藏 × —— 标题仍在栏里，和截图结构不同。Based on: `AlertDialog.tsx:166-175`；全局样式 `apps/desktop/src/renderer/index.css:247-252` 已把 `[role="alertdialog"] h2` 收到正文字号，保留不改。
- **Enter 执行**：动作按钮加 `data-autofocus`，Dialog 打开时把焦点给它，原生 Enter / Space 即触发；**不写任何 keydown 监听**。这意味着打开即焦点落在红色动作按钮上，是 Cursor 的取向，与 Astryx `AlertDialog` 文档「焦点给取消」相反，有意为之。Rejected: 在 dialog 上挂 keydown 拦 Enter —— 多一套键盘逻辑，且与表单弹窗的原生 submit 路径不一致。Based on: `Dialog.tsx:391-398`（`showModal()` 后 focus 第一个 `[data-autofocus]`）。
- **键位提示**：走 Astryx `Button` 的 `endContent` 槽位，渲染成弱化文字（例如次要文字色、比按钮字号小一档）。Rejected: Astryx `Kbd` —— 它是带底边的键帽块，不是截图形态。Based on: `Button.tsx:350-356`（`endContent` 容器继承按钮文字色，`isIconOnly` 时被忽略）；`Kbd.tsx:37-55`（键帽样式）。
- **按钮规格**：五个弹窗底栏统一 `size="sm"`；取消 `variant="ghost"`；确认框动作 `variant="destructive"`，表单弹窗的保存 / 完成保持 `primary`；底栏 `LayoutFooter` 显式 `hasDivider`（确认框必须有分割线；表单弹窗是否加分割线由执行者按截图观感定，但五个弹窗要一致）。Rejected: 取消用 `secondary` —— 有底色，与截图的纯文字取消不符。Based on: `Button.tsx:133-141`（sm/md/lg 三档）、`Button.tsx:203-205`（ghost 透明底）；`LayoutFooter.tsx:152`（`hasDivider` 默认 false）。
- **表单弹窗的 Enter**：三个重命名对话框的 Enter 提交已由 `<form onSubmit>` + 隐藏 submit 按钮承担，保存按钮**不加** `data-autofocus`（焦点必须留在输入框）；保存按钮上的回车提示只是说明，行为不变。「添加设备」只有一个「完成」按钮，可加 `data-autofocus` 让 Enter 关闭，也可不加，执行者定。Based on: `dialogs.tsx:45-53`（form + hidden submit）；`dialogs.tsx:187-189`（DeviceRename 空名禁用保存的逻辑不动）。
- **调用方契约不变**：`ConfirmAction` 类型（title / description / confirmLabel / onConfirm）和 `ConfirmActionDialog` 的 props 不变，`workbench.tsx` 四处 `setConfirmAction` 零改动。Based on: `workbench.tsx:454-509`。

## Direction

单个渲染层文件的重构，两个里程碑相互独立（改的是同一文件里的不同组件，但可以按顺序在一个包里做完，不值得拆分）。

### Milestone 1: 确认框对齐截图

`ConfirmActionDialog` 成为无标题栏的 alertdialog：`role="alertdialog"`、`purpose="form"`；内容区为标题 + 弱化说明；底栏有分割线，右对齐 sm 尺寸的 ghost「取消」（endContent `Esc`）与 destructive 动作按钮（endContent 回车符号，`data-autofocus`）。四个调用点不动。
Validation: `pnpm -C apps/desktop typecheck` -> exit 0；`pnpm -C apps/desktop test` -> 全绿。

### Milestone 2: 表单弹窗底栏同款

`WorkspaceRenameDialog` / `DeviceRenameDialog` / `ProjectRenameDialog` / `EnrollmentDialog` 的底栏按钮换成与 M1 相同的规格与提示（尺寸、ghost 取消、endContent 提示、分割线策略一致），标题栏与 × 保留，表单提交行为与禁用逻辑不变。若执行者抽出一个小的底栏按钮组组件供五处复用，放在 `dialogs.tsx` 内或同目录新文件均可。
Validation: `pnpm -C apps/desktop typecheck` -> exit 0；`pnpm -C apps/desktop build` -> exit 0。

## Landmines

- `index.css:255-267` 用 `button[aria-label="Close"]` 缩小 DialogHeader 的 ×；确认框去掉 DialogHeader 后这条规则对它不再生效，属预期，不要为此改 CSS。
- `Dialog.tsx:394` 只 focus **第一个** `[data-autofocus]`；确认框里只能标在动作按钮上，取消按钮不得标。
- Astryx `Button` 的 `endContent` 在 `isIconOnly` 下被忽略（`Button.tsx:351`），提示必须放在有 label 的普通按钮上。
- `dialogs.tsx` 没有单测，`pnpm -C apps/desktop test` 是 node --test 无 DOM，跑绿只证明没有编译期回归；视觉与键位行为由用户真机走查，不做 Playwright / UI 自动化验证（项目惯例）。

## Scope

In scope:
- `apps/desktop/src/renderer/components/workbench/dialogs.tsx`
- `apps/desktop/src/renderer/components/workbench/`（若抽底栏按钮组为新文件）
- `apps/desktop/src/renderer/index.css`（仅当提示文字需要一条全局样式时；预期不需要）
- `plans/README.md`、`plans/111-desktop-confirm-dialog.md`

Out of scope:
- `apps/desktop/src/renderer/components/workbench/workbench.tsx` —— 四个调用点零改动
- `apps/desktop/src/main/**`（`showMessageBox` 原生弹窗不动）
- `apps/desktop/src/renderer/components/workbench/import-project-wizard.tsx` —— 是列表选择流程，不是确认框
- `apps/ios/**` —— 原生 SwiftUI 弹窗，不在本 plan
- `@astryxdesign/core` 组件本身 —— 不打补丁、不 fork

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Typecheck | `pnpm -C apps/desktop typecheck` | exit 0 |
| Unit tests | `pnpm -C apps/desktop test` | exit 0 |
| Build | `pnpm -C apps/desktop build` | exit 0 |
| Manual walkthrough (acceptance) | 用户真机走查：四个确认框无 ×、Enter 执行、Esc 取消、遮罩不关、提示可见；四个表单弹窗底栏同款且 Enter 仍提交 | 用户确认 |

## Done criteria

- [ ] All listed commands pass.
- [ ] `ConfirmActionDialog` 无 DialogHeader、`role="alertdialog"`、`purpose="form"`，动作按钮带 `data-autofocus`，两按钮 sm 尺寸、取消 ghost、各带 endContent 键位提示，底栏有分割线。
- [ ] 四个表单弹窗底栏按钮与确认框同规格同提示，标题栏与 × 保留，form 提交与禁用逻辑未变。
- [ ] 无 keydown 监听、未使用 Astryx `Kbd` / `AlertDialog`。
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds（尤其 `Dialog.tsx` 的 `[data-autofocus]` 行为或 `Button` 的 `endContent` 槽位不存在）。
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.
- A named assumption is false.

## Maintenance notes

- 以后新增确认框一律经 `ConfirmAction` 走 `ConfirmActionDialog`；非破坏性确认需要蓝色动作按钮时给 `ConfirmAction` 加可选 variant，而不是再起一个弹窗。
- 焦点落在动作按钮上意味着 Enter 即删除；若将来某个动作代价极高，应在文案里说清而不是改回焦点给取消，否则五个弹窗的键位语言会分叉。
- 键位提示是静态文字，不感知平台；目前只有 macOS 桌面版，若出 Windows 版仍成立（Esc / Enter 两个键跨平台一致）。
