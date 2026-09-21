/**
 * The executor host: the main process's facade.
 *
 * It gathers four things in one place so `index.ts` only needs one object:
 *   - **Host registration**: report to the local daemon as soon as the device channel is up (a
 *     hostId plus a monotonically increasing epoch). A daemon recognizes exactly one host, and the
 *     epoch lets a late registration from an old connection be judged stale instead of overwriting
 *     the new one.
 *   - **Configuration changes flowing back**: the moment the account's configuration changes — the
 *     user saving it here, or the daemon delivering a change made on another machine — re-register
 *     so `ready` flips. Otherwise the daemon keeps refusing submissions at submit time and the
 *     user's configuration appears to have no effect.
 *   - **The settings page's three operations**: browse the model catalogue, save (validate locally,
 *     then write to the centre, then wait for the daemon to deliver it back), and test the
 *     connection with one real request.
 *   - **Channel loss**: do **not** clear the job table. A dropped channel does not mean the app
 *     died; the tasks are still running and reconciliation restores the state on reconnect. This is
 *     deliberate: re-dispatching a writer on every disconnect would cause double writes.
 *
 * `hostId` is the app instance's id: a restarted app process gets a new one, so the daemon knows the
 * instance changed and judges old runs unknown rather than assuming the same host is still running.
 *
 * **Credentials never travel towards the renderer.** The register/report frames below do go through
 * it — it is the only thing holding a device channel — but the configuration does not: it is read
 * from the daemon's local file here and written from here straight to the centre.
 */

import { randomUUID } from "node:crypto";
import { utilityProcess } from "electron";

import { EXECUTOR_HOST_CAPABILITY } from "@coflux/protocol";

import type {
  DesktopExecutorCatalog,
  DesktopExecutorInbound,
  DesktopExecutorOutbound,
  DesktopExecutorSaveInput,
  DesktopExecutorSaveResult,
  DesktopExecutorSettings,
  DesktopExecutorTestResult,
} from "../shared/desktop-bridge";
import { IPC } from "../shared/ipc";
import { projectCredentialProviders, validateCredentialShape, validateExecutorSelection } from "./executor-catalog";
import { createExecutorChannelLedger } from "./executor-channel";
import { EXECUTOR_SYSTEM_PROMPT, type ExecutorConfigStore } from "./executor-config";
import { executorCancelReason, type ExecutorStopTrigger } from "./executor-lifecycle";
import { ExecutorManager, type RunnerHandle } from "./executor-manager";
import type { ExecutorRunnerOutbound } from "./executor-runner-protocol";
import type { ExecutorRuntime } from "./executor-runtime";
import type { ExecutorCachedSettings } from "./executor-settings-cache";
import type { ExecutorSettingsWriter } from "./executor-settings-writer";

/** Capabilities are gated **by name**, following daemon-capabilities.ts; no version comparison. The
 * name comes from the protocol package because the daemon refuses any registration that does not
 * carry this exact string. */
export const EXECUTOR_CAPABILITIES = [EXECUTOR_HOST_CAPABILITY] as const;

/**
 * How long to wait for the daemon to hand the saved configuration back. The centre pushes it the
 * moment it lands, so anything beyond a couple of seconds means the push never happened — almost
 * always an old worker that does not know the message. Saying so beats spinning.
 */
const SETTINGS_DELIVERY_TIMEOUT_MS = 8_000;

export type ExecutorHost = {
  getSettings(): DesktopExecutorSettings;
  getCatalog(): Promise<DesktopExecutorCatalog>;
  save(input: DesktopExecutorSaveInput): Promise<DesktopExecutorSaveResult>;
  testConnection(): Promise<DesktopExecutorTestResult>;
  /**
   * The daemon delivered a configuration that differs from the one in hand — usually because it was
   * changed on another machine. The submit gate lives on the daemon side and follows only a fresh
   * registration, so this is not merely a UI refresh.
   */
  configChanged(): void;
  /** A device frame relayed in by the renderer. */
  inbound(message: DesktopExecutorInbound): void;
  /**
   * The renderer's view of this machine's device channel. An empty daemonId means there is none.
   * `generation` identifies **this** connection: the same daemon reconnecting produces a new one,
   * and that has to trigger a fresh registration — the daemon forgot the host when the channel
   * dropped, so keeping quiet because the daemon id is unchanged leaves the agent being told
   * "Coflux.app is not running" while it plainly is.
   */
  setChannel(daemonId: string, generation: number): void;
  /**
   * Something that looks like a local-runtime shutdown happened. The trigger decides whether runs
   * are actually cancelled — see `executor-lifecycle`. Safe to call for triggers that keep them.
   */
  stopRuns(trigger: ExecutorStopTrigger): void;
  dispose(): void;
};

export type ExecutorHostOptions = {
  config: ExecutorConfigStore;
  runtime: ExecutorRuntime;
  writer: ExecutorSettingsWriter;
  /** Absolute path to out/main/executor-runner.js. */
  runnerPath: string;
  sendToRenderer: (channel: string, payload: unknown) => void;
  log: (message: string) => void;
  /** Injected in tests only. */
  spawnRunner?: () => RunnerHandle;
};

export function createExecutorHost(options: ExecutorHostOptions): ExecutorHost {
  const hostId = randomUUID();
  // When to register, and under which epoch. Pure and separately tested — see executor-channel.ts.
  const channel = createExecutorChannelLedger();

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
        customProviders: secrets.customProviders,
        systemPrompt: EXECUTOR_SYSTEM_PROMPT,
        shell: process.env.SHELL || "/bin/zsh",
      };
    },
    sendReport: (report) => send({ kind: "report", ...report }),
    log: options.log,
  });

  function register(): void {
    const view = options.config.view();
    send({
      kind: "register",
      hostId,
      hostEpoch: channel.epoch(),
      capabilities: [...EXECUTOR_CAPABILITIES],
      ready: view.ready,
      notReadyReason: view.reason,
    });
    options.log(`[executor] 已向本机 daemon 报到（epoch=${channel.epoch()}，ready=${view.ready}）`);
  }

  function publishSettings(): void {
    options.sendToRenderer(IPC.executorSettings, options.config.view());
  }

  /** A configuration change means two things: the job table's admission criteria follow, and
   * re-registering makes the daemon's submit gate follow too. */
  function onConfigChanged(): void {
    manager.refreshReadiness();
    publishSettings();
    if (channel.refresh() === "register") register();
    // Keep the main process's own runtime in step, so the settings page and a fresh submission
    // agree about which endpoints exist. Fire and forget: a failure is reported when it is asked.
    void options.runtime.apply(options.config.cached());
  }

  /** What the save would produce, before it is written anywhere — the thing to validate against. */
  function prospective(input: DesktopExecutorSaveInput, cached: ExecutorCachedSettings): ExecutorCachedSettings {
    const credentials = { ...cached.credentials };
    for (const [providerId, key] of Object.entries(collectCredentialChanges(input))) {
      if (key.trim()) credentials[providerId] = key.trim();
      else delete credentials[providerId];
    }
    return {
      ...cached,
      present: true,
      provider: input.provider,
      modelId: input.modelId,
      customProviders: input.customProviders.map((provider) => ({
        id: provider.id,
        name: provider.name,
        baseUrl: provider.baseUrl,
        api: provider.api,
        models: provider.models,
        authHeader: provider.authHeader,
        keyless: provider.keyless,
      })),
      credentials,
    };
  }

  return {
    getSettings: () => options.config.view(),
    configChanged: onConfigChanged,

    async getCatalog() {
      const catalog = await options.runtime.catalog(options.config.cached());
      // The whole catalogue goes over in one go and the renderer searches it locally: it is a few
      // hundred kilobytes read once when the settings page opens, and a per-keystroke IPC round trip
      // for a search that is pure string matching would be the worse trade.
      return {
        ready: catalog.ready,
        error: catalog.error,
        providers: catalog.providers,
        models: catalog.models,
      };
    },

    async save(input) {
      const cached = options.config.cached();
      const changes = collectCredentialChanges(input);
      for (const [providerId, key] of Object.entries(changes)) {
        if (!key.trim()) continue;
        const shape = validateCredentialShape(key);
        if (!shape.ok) return { ok: false, error: `${providerId}: ${shape.error}` };
      }

      const next = prospective(input, cached);
      // Register the endpoints first: a brand-new custom endpoint cannot be validated against a
      // runtime that has never heard of it.
      const applyError = await options.runtime.apply(next);
      if (applyError) return { ok: false, error: `模型运行时不可用：${applyError}` };
      const catalog = await options.runtime.catalog(next);
      if (!catalog.ready) return { ok: false, error: `模型运行时不可用：${catalog.error}` };
      const verdict = validateExecutorSelection(catalog, {
        provider: input.provider,
        modelId: input.modelId,
        credentialProviders: projectCredentialProviders(cached, changes),
        customProviders: next.customProviders,
      });
      if (!verdict.ok) return { ok: false, error: verdict.error };

      const written = await options.writer.save({
        provider: input.provider,
        modelId: input.modelId,
        // Rebuilt field by field: an endpoint's own key rides in `credentials`, keyed by provider
        // id. The centre's schema is strict, so leaving an `apiKey` on the definition would be
        // rejected outright — and it would also store the same secret twice.
        customProviders: input.customProviders.map((provider) => ({
          id: provider.id,
          name: provider.name,
          baseUrl: provider.baseUrl,
          api: provider.api,
          models: provider.models.map((model) => ({ id: model.id, name: model.name })),
          authHeader: provider.authHeader,
          keyless: provider.keyless,
        })),
        credentials: changes,
      });
      if (!written.ok) return { ok: false, error: written.error };

      // The configuration is only really in force once the daemon has written it locally: that file
      // is what a submission reads. Not arriving is a fact worth naming rather than a spinner.
      const delivered = await options.config.waitForRevision(written.revision, SETTINGS_DELIVERY_TIMEOUT_MS);
      onConfigChanged();
      if (!delivered) {
        return {
          ok: true,
          validated: "已保存到账号，凭据形式正确",
          warning:
            written.pushed === 0 && written.online > 0
              ? "本机 daemon 版本过旧，收不到新的配置下发：在这台机器上运行 cofluxd update && cofluxd restart 后重试"
              : "配置已存到账号，但本机 daemon 还没把它取回来：确认 daemon 在跑，稍后会自动同步",
        };
      }
      return {
        ok: true,
        // A save that stored no selection validated the endpoints and the credential shape and
        // nothing else. Claiming the provider and model were checked would be a lie on exactly the
        // path this sentence is seen most: adding the first endpoint, before anything is chosen.
        validated:
          input.provider && input.modelId
            ? "已校验：provider、模型与凭据形式都正确"
            : "已保存到账号：端点与凭据形式都正确",
        // The centre's own warning (an unreadable old ciphertext) outranks "no key yet": it is the
        // less obvious of the two.
        warning: written.warning || verdict.warning,
      };
    },

    async testConnection() {
      const cached = options.config.cached();
      if (!cached.provider || !cached.modelId) return { ok: false, error: "先选好 provider 与模型并保存，再测试连接" };
      const result = await options.runtime.test(cached);
      return result.ok ? { ok: true, tokens: result.tokens, ms: result.ms } : { ok: false, error: result.error };
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

    setChannel(daemonId, generation) {
      const effect = channel.announce(daemonId, generation);
      if (effect === "register") register();
      // On a drop, leave the job table **alone**: the tasks are still running and reconciliation
      // restores the state on reconnect. Re-dispatching a writer on a drop would cause double writes.
      else if (effect === "dropped") options.log("[executor] 本机 daemon 的 device 通道断开；在跑的任务继续，等重连对账");
    },

    stopRuns(trigger) {
      const reason = executorCancelReason(trigger);
      if (!reason) return;
      options.log(`[executor] ${reason}：正在把未终结的任务落成 cancelled`);
      manager.cancelAll(reason);
    },

    dispose() {
      options.config.dispose();
      options.runtime.dispose();
    },
  };
}

/** The credential edits one save carries: the selected provider's key plus each endpoint's own. */
function collectCredentialChanges(input: DesktopExecutorSaveInput): Record<string, string> {
  const changes: Record<string, string> = {};
  if (input.apiKey !== undefined && input.provider) changes[input.provider] = input.apiKey;
  for (const provider of input.customProviders) {
    if (provider.apiKey !== undefined) changes[provider.id] = provider.apiKey;
  }
  return changes;
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
