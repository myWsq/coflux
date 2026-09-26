import type { CSSProperties } from "react";

/**
 * 桌面 app（plan 103）用 `titleBarStyle: "hidden"` 隐藏了系统标题栏（main/window.ts），
 * 窗口从此只认 CSS `-webkit-app-region` 声明出来的拖拽区：`drag` 的矩形可以按住拖动窗口，
 * 双击则由 Chromium 按 macOS「双击窗口标题栏」的系统偏好执行填充 / 缩放 / 最小化——渲染层
 * 不需要、也不应该自己再实现一遍（会双重触发）。
 *
 * 代价是拖拽区吞掉区域内的全部指针事件（Electron #37789）：`drag` 区域里的 DOM 收不到
 * click / dblclick / mouseenter，所以拖拽区内每个可交互元素都必须显式声明 `no-drag`。
 *
 * **光声明 `no-drag` 还不够，它必须在文档顺序上晚于那个 `drag` 元素。** Electron 按文档顺序
 * 合成这些矩形——`drag` 取并集、`no-drag` 取差集——所以先挖的洞会被后面声明的 `drag` 并集填平，
 * z-index 不参与。踩过一次：右上角动作坞浮在终端顶栏给它留的 `pr-20` 上，坞自己声明了 `no-drag`，
 * 但它排在主区之前，顶栏的 `drag` 随后把洞填回去，坞里的按钮点不动、Tooltip 也不出
 * （修复见 workbench.tsx 里动作坞那段注释）。
 *
 * **`app-region` 会被 DOM 后代继承，哪怕后代画在 `drag` 元素的盒子之外。** Astryx 的浮层
 * （DropdownMenu / Tooltip / 任何 useLayer 用户）默认就地渲染成原生 `[popover]` 元素，是触发器
 * 所在处的 DOM 后代：顶部标签条 `<header>` 带 `drag`，从条里打开的菜单就跟着继承 `drag`，
 * 菜单项点不动、按住还会拖走窗口（2.6.0 的 ＋ 菜单踩过）。触发器按钮自己的 `no-drag` 管不到它，
 * 浮层是按钮的兄弟而不是后代。现由 renderer/index.css 里一条未分层的全局规则
 * `[popover] { -webkit-app-region: no-drag; }` 统一兜住，所有浮层无论触发器在哪都不属于拖拽区
 * ——那条规则不能删。它只覆盖 `[popover]`：在 `drag` 元素内部手搓的非 popover 浮层（自己绝对
 * 定位的面板之类）照样会继承 `drag`，仍须自带 `NO_DRAG_REGION_STYLE`。
 *
 * React 的 `CSSProperties` 没有 `WebkitAppRegion` 键，故这里统一 `as CSSProperties` 断言。
 */
export const DESKTOP_TITLEBAR_HEIGHT = 38;

/** 可拖动窗口的区域（区域内的 DOM 收不到指针事件，见上）。 */
export const DRAG_REGION_STYLE = { WebkitAppRegion: "drag" } as CSSProperties;

/** 从拖拽区里挖掉自己这块矩形：拖拽区内的可交互元素一律要带。 */
export const NO_DRAG_REGION_STYLE = { WebkitAppRegion: "no-drag" } as CSSProperties;

/** 与红绿灯等高的一条拖拽带：侧栏顶部给红绿灯让位的空白带、以及无顶栏空态主区的顶部都用它。 */
export const DESKTOP_DRAG_BAND_STYLE = {
  height: DESKTOP_TITLEBAR_HEIGHT,
  WebkitAppRegion: "drag",
} as CSSProperties;
