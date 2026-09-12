/**
 * The executor host: the main process's facade.
 *
 * It gathers three things in one place so `index.ts` only needs one object:
 *   - **Host registration**: report to the local daemon as soon as the device channel is up (a
 *     hostId plus a monotonically increasing epoch). A daemon recognizes exactly one host, and the
 *     epoch lets a late registration from an old connection be judged stale instead of overwriting
 *     the new one.
 *   - **Configuration changes flowing back**: the moment the user sets a provider/key, re-register
 *     so `ready` flips from false to true. Otherwise the daemon keeps refusing submissions at submit
 *     time and the user's configuration appears to have no effect.
 *   - **Channel loss**: do **not** clear the job table. A dropped channel does not mean the app
 *     died; the tasks are still running and reconciliation restores the state on reconnect. This is
 *     deliberate: re-dispatching a writer on every disconnect would cause double writes.
 *
 * `hostId` is the app instance's id: a restarted app process gets a new one, so the daemon knows the
 * instance changed and judges old runs unknown rather than assuming the same host is still running.
 */

import { randomUUID } from "node:crypto";
import { utilityProcess } from "electron";

import type { DesktopExecutorInbound, DesktopExecutorOutbound, DesktopExecutorSettings } from "../shared/desktop-bridge";
import { IPC } from "../shared/ipc";
import { EXECUTOR_SYSTEM_PROMPT, type ExecutorConfigStore } from "./executor-config";
import { executorCancelReason, type ExecutorStopTrigger } from "./executor-lifecycle";
import { ExecutorManager, type RunnerHandle } from "./executor-manager";
import type { ExecutorRunnerOutbound } from "./executor-runner-protocol";

/** Capabilities are gated **by name**, following daemon-capabilities.ts; no version comparison. */
export const EXECUTOR_CAPABILITIES = ["executor_run"] as const;

export type ExecutorHost = {
  getSettings(): DesktopExecutorSettings;
  setModel(provider: string, modelId: string): void;
  setApiKey(apiKey: string): void;
  /** A device frame relayed in by the renderer. */
  inbound(message: DesktopExecutorInbound): void;
  /** An empty string means the channel dropped. */
  setChannel(daemonId: string): void;
  /**
   * Something that looks like a local-runtime shutdown happened. The trigger decides whether runs
   * are actually cancelled — see `executor-lifecycle`. Safe to call for triggers that keep them.
   */
  stopRuns(trigger: ExecutorStopTrigger): void;
};

export type ExecutorHostOptions = {
  config: ExecutorConfigStore;
  /** Absolute path to out/main/executor-runner.js. */
  runnerPath: string;
  sendToRenderer: (channel: string, payload: unknown) => void;
  log: (message: string) => void;
  /** Injected in tests only. */
  spawnRunner?: () => RunnerHandle;
};

export function createExecutorHost(options: ExecutorHostOptions): ExecutorHost {
  const hostId = randomUUID();
  let epoch = 0;
  let channelDaemonId = "";

  const send = (message: DesktopExecutorOutbound) => options.sendToRenderer(IPC.executorOutbound, message);

  const manager = new ExecutorManager({
    spawnRunner: options.spawnRunner ?? (() => forkRunner(options.runnerPath)),
    config: () => {
      const view = options.config.view();
      const secrets = options.config.secrets();
      return {
        ready: view.ready,
        reason: view.reason,
        provider: secrets.provider,
        modelId: secrets.modelId,
        apiKey: secrets.apiKey,
        systemPrompt: EXECUTOR_SYSTEM_PROMPT,
        shell: process.env.SHELL || "/bin/zsh",
      };
    },
    sendReport: (report) => send({ kind: "report", ...report }),
    log: options.log,
  });

  function register(): void {
    if (!channelDaemonId) return;
    const view = options.config.view();
    epoch += 1;
    send({
      kind: "register",
      hostId,
      hostEpoch: epoch,
      capabilities: [...EXECUTOR_CAPABILITIES],
      ready: view.ready,
      notReadyReason: view.reason,
    });
    options.log(`[executor] 已向本机 daemon 报到（epoch=${epoch}，ready=${view.ready}）`);
  }

  function publishSettings(): void {
    options.sendToRenderer(IPC.executorSettings, options.config.view());
  }

  /** A configuration change means two things: the job table's admission criteria follow, and
   * re-registering makes the daemon's submit gate follow too. */
  function onConfigChanged(): void {
    manager.refreshReadiness();
    publishSettings();
    register();
  }

  return {
    getSettings: () => options.config.view(),
    setModel(provider, modelId) {
      options.config.setModel(provider, modelId);
      onConfigChanged();
    },
    setApiKey(apiKey) {
      if (!options.config.setApiKey(apiKey)) options.log("[executor] API key 未能加密落盘（safeStorage 不可用），保持未配置");
      onConfigChanged();
    },
    inbound(message) {
      switch (message.kind) {
        case "assign":
          manager.onAssign({
            runId: message.runId,
            prompt: message.prompt,
            write: message.write,
            workspaceId: message.workspaceId,
            workspaceRoot: message.workspaceRoot,
            submittedAt: message.submittedAt,
          });
          break;
        case "cancel":
          manager.onCancel(message.runId);
          break;
        case "ack":
          manager.onAck(message.runId);
          break;
        case "registered":
          if (!message.ok) {
            // The usual cause is that this channel is not loopback (it went over relay). The daemon
            // is the authority; this side only records what it was told.
            options.log(`[executor] 本机 daemon 拒绝了 host 注册：${message.error ?? "未给出原因"}`);
            break;
          }
          manager.onReconcile(message.reconcileRunIds);
          break;
      }
    },
    setChannel(daemonId) {
      if (daemonId === channelDaemonId) return;
      channelDaemonId = daemonId;
      if (daemonId) register();
      // On a drop, leave the job table **alone**: the tasks are still running and reconciliation
      // restores the state on reconnect. Re-dispatching a writer on a drop would cause double writes.
      else options.log("[executor] 本机 daemon 的 device 通道断开；在跑的任务继续，等重连对账");
    },
    stopRuns(trigger) {
      const reason = executorCancelReason(trigger);
      if (!reason) return;
      options.log(`[executor] ${reason}：正在把未终结的任务落成 cancelled`);
      manager.cancelAll(reason);
    },
  };
}

/** The real runner: an Electron utilityProcess. It forks a file path, so the runner has to be its
 * own build artifact. */
function forkRunner(runnerPath: string): RunnerHandle {
  const child = utilityProcess.fork(runnerPath, [], { serviceName: "coflux-executor", stdio: "ignore" });
  return {
    postMessage: (message) => child.postMessage(message),
    kill: () => void child.kill(),
    on(event: "message" | "exit", listener: never) {
      if (event === "message") child.on("message", listener as unknown as (m: ExecutorRunnerOutbound) => void);
      else child.on("exit", listener as unknown as (code: number) => void);
    },
  };
}
