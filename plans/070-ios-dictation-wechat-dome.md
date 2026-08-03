# Plan 070: 对讲蒙层微信式三件套——半圆底座 + 贴弧肩圆按钮

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 9538a03..HEAD -- apps/ios/Coflux/Speech/DictationOverlay.swift apps/ios/Coflux/Views/WorkspaceDetailView.swift`

## Status

- Priority: P2
- Effort: S
- Risk: LOW
- Depends on: none（迭代 068/069，回答 068 遗留的"要不要画弧"）
- Category: feature
- Execution: subagent sonnet
- Planned at: `9538a03`, 2026-08-03

## Requirement

068 定案后对讲蒙层只剩两颗贴屏幕左右边缘、凭空悬浮的 112×52 胶囊——用户观感是
"突然的两个按钮"，没有视觉锚点。068 的 executor 当时留了问题待拍板（见
plans/README.md 068 行：微信弧感来自三颗不等高按钮，中间那颗被砍后未画弧）。
用户 2026-08-03 拍板：照微信"按住说话"操作台补齐三件套——

1. **半圆底座**：屏幕底部全宽、向上凸的大弧形拱顶（微信观感是超宽弧，非严格
   半圆；内放声波/麦克风图标）。纯视觉锚点：进行中手指处于"原地"（未滑入任何
   按钮）时底座整体高亮，提示语（"松开确认"等）悬在拱顶上方。
2. **两颗圆形按钮**：贴底座弧肩左右（不再贴屏幕边缘），左 ✕ 取消 / 右 ↑ 发送。
   图标在圆内，文字标签悬在圆上方（不再塞进按钮里）。进行中为低对比角标圆，
   手指滑入变大高亮；确认态原位原形变实体可点（右主色实底 / 左玻璃 ✕），
   底座保留作视觉锚。
3. **转写气泡**：居中定格照旧，不动。

视觉参考（微信原图，Mobbin）：
- 滑到取消（左圆变大变白高亮、标签在圆上）：
  https://mobbin.com/screens/bca1a25e-8b1b-4565-8cef-3e4fa9077f96
- 手指在底座（底座整体亮起、"松开 发送"悬拱顶上）：
  https://mobbin.com/screens/fd891c97-d90e-46aa-b2f5-d091fdf2ac12

正确解 vs 相邻错解：这是**换皮不换语义**。068 的交互定案（原地松手=进确认态、
finalizing 不出按钮、留驻示错态点任意处关闭）与 069 乐观启动一律不动；任何
把"松手在底座=直接发送"搬进来的实现都是错的——那是被推翻的 067 语义。

## Decisions & tradeoffs

- **底座纯视觉，松手语义不变**：手指在底座区亮起只是把既有的 `.none` 区可视化，
  松手仍进 068 确认态。Rejected: 照搬微信"松开=发送"——2026-08-01 用户已推翻
  （coflux 纯转文字无语音兜底），本次出发确认再次确认不改。
  Based on: DictationOverlay.swift:11-13（`.none` = 松手进确认态）。
- **不新增命中区**：底座高亮条件 = `stage == .listening && zone == .none`，
  复用现有三值 `DictationZone`。Rejected: 给底座建第三个命中区——松手语义在
  底座内外完全相同，判定没有意义，白加几何。
  Based on: DictationOverlay.swift:30-36（hit() 只区分 cancel/send/none）。
- **圆按钮替换胶囊，标签外提**：`DictationZone.size` 从 112×52 胶囊改为圆
  （直径量级参考微信 ~56-64pt，executor 定），图标入圆、文字标签悬圆上方；
  命中区仍可用方框外扩 tolerance（不必做几何圆判定）。位置从贴屏幕左右边缘
  改为贴底座弧肩（水平内移，executor 按弧形定 x）。
  Rejected: 保留胶囊只加底座——"贴着弧肩的圆"正是用户点名的微信形态。
- **确认态原位变实体、底座保留**：两颗圆原位原形变可点实体（右 `Theme.primary`
  实底 ↑ 主操作 / 左玻璃 ✕ 次操作，沿用 068 的主次配色语义），底座不淡出——
  空间连续，松手前后画面不跳。Rejected: 底座淡出（按钮又失去锚点，回到"突然
  两个按钮"）；确认态切回胶囊（两套形态切换突兀）。
  Based on: DictationOverlay.swift:185-197（confirming 分支的主次配色）。
- **占位条隔离约束保持**：命中区下沿距蒙层底边 ≥ 200pt 的规则不变（占位条
  顶边 ~178pt + 22pt 余量），即新几何须满足
  `lift - 命中半高 - tolerance ≥ 200`。圆按钮想贴低就得缩 tolerance 或缩圆，
  不得吃掉这 22pt——手指静止按在占位条上（含最左/最右边缘）必判 `.none`。
  Based on: DictationOverlay.swift:17-24（lift/tolerance 推导注释）。
- **绘制/命中同源常量模式保持**：底座与圆按钮的几何全部进 `DictationZone`
  （或同文件同级常量组），绘制对齐蒙层底边、判定用全局框，改一处两边同变。
  调用点接口不变。
  Based on: DictationOverlay.swift:28-29、WorkspaceDetailView.swift:147
  （`DictationZone.hit($0, in: dictationBounds)`）。
- **相位可见性沿用 068**：listening/confirming 出三件套；finalizing 不出按钮
  （底座作为纯视觉可留可去，executor 定，倾向留——手指刚离开，画面别抽走）；
  resting 留驻示错态三件套全隐（维持点任意处关闭的 064 语义）。
  Based on: DictationOverlay.swift:125-127（`if !resting, stage != .finalizing`）。
- **(decided while planning) 提示语与 footer 上移**：现 footer 贴底
  （padding.bottom 48）会被底座压住；进行中提示语按微信位挪到拱顶上方，
  permissionDenied / modelDownloading / failed 等 footer 内容同样不得与底座
  重叠（上移或隐底座，executor 定）。
  Based on: DictationOverlay.swift:122-123（footer padding.bottom 48）。

## Direction

单文件 UI 改动，全部在 DictationOverlay.swift：`DictationZone` 常量与 hit 几何
换圆并加底座绘制常量；`buttons` 重画为三件套；`pill` 两分支（角标/实体）改圆形
+外提标签；footer/提示语避让底座。`DictationStage`、`DictationSession`、
手势接线、`.allowsHitTesting`、`sensoryFeedback` 均不动。

### Milestone 1: 三件套成形（进行中态）

底座 + 两圆 + 外提标签替换两颗胶囊；手指原地=底座高亮+提示语悬拱顶，滑入圆=
该圆变大高亮；命中几何与绘制同源，占位条隔离约束满足。
Validation: `cd apps/ios && xcodebuild -project Coflux.xcodeproj -scheme Coflux -destination 'generic/platform=iOS Simulator' build` → exit 0。

### Milestone 2: 确认态与其余相位

确认态两圆原位变实体（右主色实底/左玻璃）、底座保留、"点文字可编辑"等提示
不与底座重叠；finalizing 无按钮、resting 全隐点任意处关闭——068 语义逐项无回归。
Validation: 同上 xcodebuild → exit 0。

## Landmines

- **占位条静止手指隔离**：DictationOverlay.swift:17-24 的 22pt 余量推导是
  068 真机验收过的硬约束，新几何逾越会让"按住不动"误判成滑入按钮。
- **hit-testing 整层一条**：DictationOverlay.swift:132
  `.allowsHitTesting(stage == .settled)` 是 066 老坑的解，底座/标签等新视图
  别单独加手势或 hitTesting 修饰，避免相位漏触摸。
- **绘制对齐蒙层自身底边、判定用全局框**：DictationOverlay.swift:28-29 两边
  同源才不漂移；底座若用 `ignoresSafeArea` 贴物理屏底，命中常量的参照系
  （蒙层底边）必须跟着核对。
- **失败但有字并入确认态**：DictationOverlay.swift:91-93、114-120，错误标注
  显示在气泡下方——重排 footer 时别丢这条通路。
- **xcodeproj 不动**：不新增文件（067 教训：加文件要改 xcodeproj，超 scope）。

## Scope

In scope:
- `apps/ios/Coflux/Speech/DictationOverlay.swift`

Out of scope:
- `apps/ios/Coflux/Views/WorkspaceDetailView.swift` —— 接口（传全局框判定）
  不变即无需动；如实现中发现必须微调，STOP 报告而非顺手改。
- `apps/ios/Coflux/Views/TerminalInputArea.swift`（占位条）、
  `DictationSession`/`AudioCapture` 等逻辑层 —— 换皮不换逻辑。
- `Coflux.xcodeproj` —— 不加新文件。

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| 构建 | `cd apps/ios && xcodebuild -project Coflux.xcodeproj -scheme Coflux -destination 'generic/platform=iOS Simulator' build` | exit 0 |
| 真机手感 (acceptance) | 用户真机验收（惯例：UI 走查不由 Claude 做） | 用户拍板 |

## Done criteria

- [ ] xcodebuild 构建通过。
- [ ] 进行中：底座常驻、原地=底座高亮+提示语悬拱顶；滑入左/右圆该圆变大高亮、
      标签悬圆上方；松手原地仍进确认态（零语义变化）。
- [ ] 确认态：两圆原位实体可点（右主色实底 ↑ / 左玻璃 ✕）、底座保留、
      草稿可点进编辑、错误标注通路健在。
- [ ] finalizing 无按钮、resting 全隐可点任意处关闭。
- [ ] 命中区下沿 ≥ 200pt 约束在新几何下成立（常量注释更新推导）。
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- 实现必须改动 WorkspaceDetailView.swift 或其它 out-of-scope 文件。
- xcodebuild 同一错误修复一次后仍失败。

## Maintenance notes

- 底座是 068 遗留问题（"要不要画弧"）的正式答案：弧感靠底座本体，不靠三颗
  不等高按钮。后续再调按钮数量/位置，先看 `DictationZone` 同源常量组。
- 对讲交互语义的决策链：067 松手直发（已推翻）→ 068 确认态（真机验收过）→
  069 乐观启动 → 本 plan 纯视觉换皮。改语义前先读 068 的复议记录。
