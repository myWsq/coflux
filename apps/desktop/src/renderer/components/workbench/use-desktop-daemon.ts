import { useEffect, useState } from "react";

import type { DesktopBridge, DesktopDaemonState } from "@/desktop-bridge";

/**
 * 本机 daemon 状态订阅（plan 113）：主进程只在变化时广播，挂载时 getDaemonState() 补拉一次
 * （顺带让主进程做一次含 launchctl 的全量刷新）。返回 null 表示还没拿到第一份状态。
 * 与 use-desktop-update.ts 同一做法。
 */
export function useDesktopDaemonState(bridge: DesktopBridge): DesktopDaemonState | null {
  const [state, setState] = useState<DesktopDaemonState | null>(null);
  useEffect(() => {
    let disposed = false;
    const unsubscribe = bridge.onDaemonState((next) => {
      if (!disposed) setState(next);
    });
    void bridge.getDaemonState().then((next) => {
      if (!disposed) setState(next);
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [bridge]);
  return state;
}
