import type { DesktopUpdateState } from "../shared/desktop-bridge";

/**
 * 自动更新的状态机（plan 103）：electron-updater 事件 → 渲染层可展示的状态。纯函数，主进程
 * updater.ts 驱动它并把结果广播给渲染层；渲染层的 outdated 状态页按它渲染「需要更新」提示。
 */
export type UpdaterEvent =
  | { type: "checking" }
  | { type: "available"; version: string }
  | { type: "progress"; percent: number }
  | { type: "downloaded"; version: string }
  | { type: "not-available" }
  | { type: "error"; message: string };

export const INITIAL_UPDATE_STATE: DesktopUpdateState = { status: "idle" };

export function reduceUpdateState(state: DesktopUpdateState, event: UpdaterEvent): DesktopUpdateState {
  // 已下载完成是终态（只等重启安装）：周期性复查的 checking / not-available / progress 不得把它退回去；
  // 只有出错或发现另一个版本才改变。
  if (state.status === "downloaded" && (event.type === "checking" || event.type === "not-available" || event.type === "progress")) return state;
  switch (event.type) {
    case "checking":
      return { status: "checking" };
    case "available":
      return { status: "available", version: event.version };
    case "progress":
      return { status: "downloading", version: state.version, percent: Math.max(0, Math.min(100, Math.round(event.percent))) };
    case "downloaded":
      return { status: "downloaded", version: event.version };
    case "not-available":
      return { status: "not-available" };
    case "error":
      return { status: "error", message: event.message };
  }
}
