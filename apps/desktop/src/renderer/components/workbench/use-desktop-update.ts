import { useEffect, useState } from "react";

import type { DesktopBridge, DesktopUpdateState } from "@/desktop-bridge";

/**
 * electron-updater 状态订阅（plan 110）：「需要更新」页与侧栏账号脚部共用这一份。
 *
 * 更新状态住在主进程，且只在**变化时**广播（见 main/updater.ts）——登录页期间就已到达的
 * `downloaded` 不会再推一次，所以挂载时必须 getUpdateState() 补拉一次。
 *
 * 本 hook 只读状态，**不触发检查**：检查时机由主进程的启动 15s + 每 4h 定时器负责，脚部每次
 * 挂载（登录/登出）都打一次更新源纯属重复。需要挂载即检查的调用方（版本准入被拒页）自己加。
 */
export function useDesktopUpdateState(bridge: DesktopBridge): DesktopUpdateState {
  const [update, setUpdate] = useState<DesktopUpdateState>({ status: "idle" });
  useEffect(() => {
    let disposed = false;
    const unsubscribe = bridge.onUpdateState((state) => {
      if (!disposed) setUpdate(state);
    });
    void bridge.getUpdateState().then((state) => {
      if (!disposed) setUpdate(state);
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [bridge]);
  return update;
}
