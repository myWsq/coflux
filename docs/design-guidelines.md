# Web UI 设计规范

`apps/web` 的界面约定。改 UI 前过一遍；新增条目保持"一条规则 + 为什么"的密度。

## 悬浮提示：用 `Tooltip` 组件，不用原生 `title`

图标按钮、需要悬浮说明的元素一律用 `@astryxdesign/core/Tooltip`（`display:contents`
包装，布局中性），**禁止**用原生 `title` 属性。

为什么：原生 title 样式不可控（系统气泡、~1s 延迟、不支持暗色主题）、触屏设备完全
不可见，与全局 Cursor 风格 tooltip（2026-07 已统一）割裂。

例外：纯文本溢出场景（truncate 后想看全文）暂允许 title，待逐步迁移。

## 执行中：盲文点阵，不要转圈

工作区「正在执行」用 `PendingDots`（5 格盲文点阵），不要 `LoaderCircle`、不要扫光。
转圈是阻塞感；点阵是「活着、不用你动手」。待批准 / 待回答保持静态警告图标——
那些要你点，做成动画会看起来像还能再等一等。

## 图标：lucide-react，跨端语义对齐

同一语义在 web 与 iOS 用同族图标（web lucide ↔ iOS SF Symbols 就近映射，如
`GitBranch` ↔ `arrow.branch`、`Folder` ↔ `folder`）。新图标先查 `sidebar.tsx`
既有 import 有没有可复用的。
