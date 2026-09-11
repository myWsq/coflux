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
