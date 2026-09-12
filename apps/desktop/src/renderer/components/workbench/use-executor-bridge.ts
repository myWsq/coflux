import { useEffect } from "react";
import type { CofluxClient } from "@coflux/client";

import { desktop } from "@/config";

/**
 * The executor's renderer side: **a messenger and nothing more**.
 *
 * The job table, the write lock, the runner and the credentials all live in the main process. This
 * holds no run state and makes no decisions. It does three things:
 *   1. Takes an **independent, permanent retain** on the local daemon. The workbench otherwise only
 *      does `measureOnly` for non-selected devices, and that lane deliberately skips direct in favour
 *      of relay, while the daemon accepts executor frames only from a loopback channel. The executor
 *      service also must not depend on which workspace the user happens to be looking at.
 *   2. Relays the four frames the daemon pushes into the main process.
 *   3. Sends the two frames the main process produces out over the device channel.
 *
 * The local daemon's identity comes from the desktop side's `daemonState.daemonId` (the app has
 * managed this machine's daemon since plan 113). Without it this does nothing — the executor only
 * serves the machine the desktop app is on.
 */
export function useExecutorBridge(client: CofluxClient, localDaemonId: string | undefined): void {
  useEffect(() => {
    if (!localDaemonId) {
      desktop.setExecutorChannel("");
      return;
    }

    // Not measureOnly: this needs a real direct lane, not the relay used for measurement.
    const release = client.retainDevice(localDaemonId);

    const unsubscribeInbound = client.subscribeExecutor((event) => {
      // Only from this machine's daemon; no other device should push executor frames, and one that
      // does is ignored.
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

    // Announce channel readiness after subscribing: the main process sends its registration frame
    // the moment it hears, and doing it a step earlier would send it where nobody is listening.
    desktop.setExecutorChannel(localDaemonId);

    return () => {
      desktop.setExecutorChannel("");
      unsubscribeInbound();
      unsubscribeOutbound();
      release();
    };
  }, [client, localDaemonId]);
}

/** The main process expresses state as strings (they read and assert better across IPC); on the
 * wire it is a proto enum. */
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
