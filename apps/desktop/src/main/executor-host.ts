/**
 * executor host（plan 116 M2）：主进程这一侧的门面。
 *
 * 把三件事收在一处，让 `index.ts` 只需要拿到一个对象：
 *   - **host 注册**：device 通道一通就向本机 daemon 报到（hostId + 单调递增的 epoch）。
 *     一个 daemon 只认一个 host，epoch 用来让「旧连接的迟到注册」被判 stale 而不是覆盖新的。
 *   - **配置变更的回流**：用户刚配好 provider/key，要立刻重新注册（把 ready 从 false 翻成 true），
 *     否则 daemon 会继续在提交那一刻拒掉任务，用户以为配了却没用。
 *   - **通道断开**：**不**清作业表。通道断了不等于 app 死了，任务还在跑；重连后靠对账把状态补回去。
 *     这条是刻意的：断线就重派 writer 会造成双写。
 *
 * `hostId` 用 app 的实例 id：同一个 app 进程重启后换新 id，daemon 因此知道换了实例、把旧 run 判 unknown，
 * 而不是误以为还是原来那个 host 在跑。
 */

import { randomUUID } from "node:crypto";
import { utilityProcess } from "electron";

import type { DesktopExecutorInbound, DesktopExecutorOutbound, DesktopExecutorSettings } from "../shared/desktop-bridge";
import { IPC } from "../shared/ipc";
import { EXECUTOR_SYSTEM_PROMPT, type ExecutorConfigStore } from "./executor-config";
import { executorCancelReason, type ExecutorStopTrigger } from "./executor-lifecycle";
import { ExecutorManager, type RunnerHandle } from "./executor-manager";
import type { ExecutorRunnerOutbound } from "./executor-runner-protocol";

/** 能力按**名字**门禁，对齐 daemon-capabilities.ts 的范式；不比较版本号。 */
export const EXECUTOR_CAPABILITIES = ["executor_run"] as const;

export type ExecutorHost = {
  getSettings(): DesktopExecutorSettings;
  setModel(provider: string, modelId: string): void;
  setApiKey(apiKey: string): void;
  /** 渲染层转进来的 device 帧 */
  inbound(message: DesktopExecutorInbound): void;
  /** 空串 = 通道断开 */
  setChannel(daemonId: string): void;
  /**
   * Something that looks like a local-runtime shutdown happened. The trigger decides whether runs
   * are actually cancelled — see `executor-lifecycle`. Safe to call for triggers that keep them.
   */
  stopRuns(trigger: ExecutorStopTrigger): void;
};

export type ExecutorHostOptions = {
  config: ExecutorConfigStore;
  /** out/main/executor-runner.js 的绝对路径 */
  runnerPath: string;
  sendToRenderer: (channel: string, payload: unknown) => void;
  log: (message: string) => void;
  /** 仅测试注入 */
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

  /** 配置变了要做两件事：作业表的准入判据跟着变，并重新注册让 daemon 的提交门禁也跟着变。 */
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
            // 最常见的原因是这条通道不是 loopback（走了 relay）。daemon 是判据，这里只如实记下。
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
      // 断开时**不**动作业表：任务还在跑，重连后靠对账补状态。断线就重派 writer 会造成双写。
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

/** 真实的 runner：Electron 的 utilityProcess。fork 的是文件路径，所以 runner 必须是独立构建产物。 */
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
