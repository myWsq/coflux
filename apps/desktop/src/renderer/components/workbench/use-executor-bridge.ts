import { useEffect } from "react";
import type { CofluxClient } from "@coflux/client";

import { desktop } from "@/config";

/**
 * executor 的渲染层一侧（plan 116 M2）：**只当信使**。
 *
 * 作业表、写锁、runner、凭证全在主进程；这里不持有任何 run 状态，也不做任何判断。
 * 三件事而已：
 *   1. 对本机 daemon 做一次**独立的常驻 retain**。工作台原本只对非选中设备做 `measureOnly`，
 *      那种 lane 刻意跳过 direct 走 relay，而 daemon 只认 loopback 通道上来的 executor 帧；
 *      而且 executor 服务不能依赖「用户此刻在看哪个工作区」。
 *   2. 把 daemon 推来的四条转进主进程。
 *   3. 把主进程要发的两条经 device 通道发出去。
 *
 * 本机 daemon 的身份来自桌面侧的 `daemonState.daemonId`（plan 113 起 app 自己管这台机器的 daemon）。
 * 没有它就什么都不做——executor 只服务桌面 app 所在的这台机器。
 */
export function useExecutorBridge(client: CofluxClient, localDaemonId: string | undefined): void {
  useEffect(() => {
    if (!localDaemonId) {
      desktop.setExecutorChannel("");
      return;
    }

    // 非 measureOnly：要的是真 direct lane，不是测量用的 relay。
    const release = client.retainDevice(localDaemonId);

    const unsubscribeInbound = client.subscribeExecutor((event) => {
      // 只收本机那台的；别的设备不该推 executor 帧过来，真推了也不理。
      if (event.daemonId !== localDaemonId) return;
      if (event.kind === "assign") {
        desktop.sendExecutorInbound({
          kind: "assign",
          runId: event.runId,
          prompt: event.prompt,
          write: event.write,
          workspaceId: event.workspaceId,
          workspaceRoot: event.workspaceRoot,
          submittedAt: event.submittedAt,
        });
      } else if (event.kind === "cancel") {
        desktop.sendExecutorInbound({ kind: "cancel", runId: event.runId });
      } else if (event.kind === "ack") {
        desktop.sendExecutorInbound({ kind: "ack", runId: event.runId });
      } else {
        desktop.sendExecutorInbound({
          kind: "registered",
          ok: event.ok,
          error: event.error,
          reconcileRunIds: event.reconcileRunIds,
        });
      }
    });

    const unsubscribeOutbound = desktop.onExecutorOutbound((message) => {
      if (message.kind === "register") {
        client.sendExecutorHostRegister(localDaemonId, {
          hostId: message.hostId,
          hostEpoch: BigInt(message.hostEpoch),
          capabilities: message.capabilities,
          ready: message.ready,
          notReadyReason: message.notReadyReason,
        });
      } else {
        client.sendExecutorReport(localDaemonId, {
          $typeName: "coflux.v1.DeviceExecutorReport",
          runId: message.runId,
          state: executorStateToWire(message.state),
          note: message.note,
          summary: message.summary,
          changedFiles: message.changedFiles ?? [],
          error: message.error,
          reportedAt: Date.now(),
        });
      }
    });

    // 通道就绪的通知放在订阅之后：主进程收到就会立刻发注册帧，早一步会打在没人接的地方。
    desktop.setExecutorChannel(localDaemonId);

    return () => {
      desktop.setExecutorChannel("");
      unsubscribeInbound();
      unsubscribeOutbound();
      release();
    };
  }, [client, localDaemonId]);
}

/** 主进程用字符串表达状态（跨 IPC 好读好断言），线上是 proto 枚举。 */
function executorStateToWire(state: string): number {
  switch (state) {
    case "accepted":
      return 1;
    case "running":
      return 2;
    case "succeeded":
      return 3;
    case "rejected":
      return 4;
    case "model_error":
      return 5;
    case "tool_failed":
      return 6;
    case "cancelled":
      return 7;
    case "unknown":
      return 8;
    default:
      return 0;
  }
}
