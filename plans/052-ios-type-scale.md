# Plan 052: iOS 字体规范 —— 语义角色字阶（锚定 Dynamic Type）

> This plan is an outcome contract, not a step-by-step script. Stop on any
> STOP condition. When complete, update `plans/README.md`.
>
> Drift check: `git diff --stat ce1e2cd..HEAD -- apps/ios/Coflux/Views/`

## Status

- Priority: P3
- Effort: S
- Risk: LOW
- Depends on: none（前置 051 已 DONE）
- Category: refactor
- Execution: self
- Planned at: `ce1e2cd`, 2026-07-26

## Requirement

iOS 字体现状：13 处 Apple 文本样式 + 2 处硬编码，其中行标题
`.system(size: 19)`（PR #24 遗留）游离在系统字阶外、不随 Dynamic Type 缩放；
且用法都是裸样式，无语义角色——同一角色（如"说明文字"）靠约定俗成用
footnote，规范不显式。

完成后：Theme 内有一套**语义角色字阶**（brand/rowTitle/sectionLabel/
control/label/meta/subtitle），除品牌字标外全部锚定 Apple 文本样式（随
Dynamic Type 缩放）；Views 内所有 `.font(...)` 只引用角色 token，硬编码
19pt 消失（归入 `.title3` 档）。

## Decisions & tradeoffs

- **字阶真相源 = Apple 文本样式，不搬 web px 字阶**: web base 13px 是桌面
  IDE 密度，搬到手机丢可读性且废掉 Dynamic Type 无障碍缩放。原则同 047/048：
  色彩/图形对齐 web（品牌），尺寸/交互跟平台。用户已确认此方向。
- **角色命名制**: token 是语义角色（rowTitle/label/meta…）而非尺寸名
  （text-sm/text-lg），weight/monospaced 等强调修饰留在调用点叠加——角色
  管"是什么"，修饰管"怎么强调"，与 web 字重独立于字阶的做法同构。
- **唯一固定尺寸豁免 = 登录页品牌字标**（40pt 粗体等宽）：字标是图形不是
  正文，不参与缩放。
- **`.system(size: 19)` → `.title3`(20pt)**: 最近的系统档位，行标题略增
  1pt，随 Dynamic Type 缩放。Based on: `WorkspaceListView.swift:107`。

## Direction

### Milestone 1: Theme 字阶 + 全量归位

Theme.swift 增语义字阶（含注释说明规范与豁免）；Views 全部 `.font(...)`
改引角色 token。Validation: 构建命令通过，且
`grep -rn '\.font(' apps/ios/Coflux/Views/ | grep -v 'Theme.Fonts' | grep -v Theme.swift`
无输出。

## Landmines

- `project.pbxproj`/`Coflux.xcscheme` 用户签名改动在工作区，不得 commit/还原（同 047-051）。

## Scope

In scope:
- `apps/ios/Coflux/Views/**`

Out of scope:
- 终端字体（051 已对齐 web，SF Mono 12 固定是终端语义，不入 UI 字阶）
- 导航栏标题字体（系统 chrome）

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| 构建 | `xcodebuild -project apps/ios/Coflux.xcodeproj -scheme Coflux -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=27.0' build CODE_SIGNING_ALLOWED=NO` | BUILD SUCCEEDED |
| 归位检查 | `grep -rn '\.font(' apps/ios/Coflux/Views/ \| grep -v 'Theme.Fonts' \| grep -v Theme.swift` | 无输出 |
| 真机验收 (acceptance) | 系统设置调大字号，列表/横幅/登录页随缩放；行标题不再突兀 | 用户人工确认 |

## Done criteria

- [ ] 构建与归位检查通过。
- [ ] 硬编码 19pt 消失；品牌字标是唯一固定尺寸。
- [ ] `plans/README.md` status is updated.

## STOP conditions

- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.

## Maintenance notes

- 新增文字一律先选角色；没有合适角色时加角色而不是写裸 `.font`。
