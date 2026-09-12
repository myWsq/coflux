/**
 * 桌面桥接（plan 103 / 106）：preload 经 contextBridge 把实现挂到 `window.cofluxDesktop`。渲染层只在
 * Coflux 桌面 app 里运行，桥接是必选项——缺失说明 preload 没挂上（打包/启动方式错了），启动期直接
 * 报错，不做任何「浏览器时……」的降级路径。类型真相源在 ../shared/desktop-bridge.ts，这里只做取用。
 */
import type { DesktopBridge } from "../shared/desktop-bridge";

export type {
  DesktopBridge,
  DesktopCommand,
  DesktopDaemonBusy,
  DesktopDaemonFda,
  DesktopDaemonState,
  DesktopDaemonStatus,
  DesktopExecutorInbound,
  DesktopExecutorOutbound,
  DesktopExecutorSettings,
  DesktopNotification,
  DesktopUpdateState,
  DesktopUpdateStatus,
} from "../shared/desktop-bridge";

declare global {
  interface Window {
    cofluxDesktop?: DesktopBridge;
  }
}

export const MISSING_BRIDGE_MESSAGE = "window.cofluxDesktop 缺失：渲染层只能在 Coflux 桌面 app 的 preload 之后运行";

/** 桥接的唯一取用入口：没有 window（Node 单测）或 window 上没有 cofluxDesktop 一律抛错。 */
export function requireDesktopBridge(): DesktopBridge {
  const bridge = typeof window === "undefined" ? undefined : window.cofluxDesktop;
  if (!bridge) throw new Error(MISSING_BRIDGE_MESSAGE);
  return bridge;
}
