/**
 * The executor runner: the utilityProcess child's entry point. One process runs one task.
 *
 * Why a separate process instead of running pi in the main process: pi spawns children, uses memory
 * and can crash, and a crashed main process takes the whole app with it. One process per task also
 * gives "stop" a clean last resort — kill the whole tree.
 *
 * This side is **outside the sandbox**: model calls are made from this process, so it has network
 * access. The bash children that actually run the user's commands are wrapped in `sandbox-exec`, and
 * that side has no network and can only write the workspace (see executor-sandbox.ts).
 *
 * Four key integration points with pi, each matching a recorded decision:
 *   1. **A closed ResourceLoader**: `noExtensions/noSkills/noPromptTemplates/noThemes/noContextFiles`
 *      all off, with coflux's own prompt supplied through `systemPrompt`. Leave them on and a `.pi/`
 *      directory dropped into a workspace can execute arbitrary code.
 *   2. **An inline guard extension**: `extensionFactories` registers an extension that only
 *      intercepts, checking paths for the structured file tools in `pi.on("tool_call")`. On-disk
 *      extension discovery is off, so this one is in-process and trusted.
 *   3. **A replaced bash backend**: `createBashToolDefinition(cwd, { operations })` wraps every
 *      command in sandbox-exec and kills by process group — pi's own backend uses `detached: true`,
 *      and killing the pid does not kill the group it spawned.
 *   4. **No session on disk**: `SessionManager.inMemory()`, leaving the user's existing `~/.pi` state
 *      untouched.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

import { guardToolCall } from "./executor-guard";
import { sandboxArgv } from "./executor-sandbox";
import {
  EXECUTOR_RUNNER_EXIT,
  type ExecutorRunnerInbound,
  type ExecutorRunnerOutbound,
  type ExecutorRunnerStart,
} from "./executor-runner-protocol";

declare const process: NodeJS.Process & { parentPort: { postMessage(value: unknown): void; on(event: "message", listener: (event: { data: unknown }) => void): void } };

function send(message: ExecutorRunnerOutbound): void {
  process.parentPort.postMessage(message);
}

let transcriptSeq = 0;
function transcript(kind: "assistant" | "tool" | "error", text: string): void {
  if (!text) return;
  send({ type: "transcript", seq: ++transcriptSeq, kind, text });
}

/**
 * The register of running bash children. Recorded **by process group**, not by pid: pi's bash backend
 * starts the shell detached, so a command's `&`, pipes and subshells all share one group, and killing
 * only the pid leaves a field of orphans still writing files.
 */
const liveGroups = new Set<number>();

function killGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    // The group is already gone; that is the normal path.
  }
}

/** Polite first: TERM, two seconds to wind down, then KILL. Returns after the KILL. */
async function stopAllGroups(): Promise<void> {
  for (const pgid of liveGroups) killGroup(pgid, "SIGTERM");
  if (liveGroups.size === 0) return;
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  for (const pgid of liveGroups) killGroup(pgid, "SIGKILL");
  // Give the kernel a moment more to settle outstanding writes before the layer above may release
  // the write lock.
  await new Promise((resolve) => setTimeout(resolve, 200));
}

/**
 * The sandboxed bash execution backend, replacing pi's own.
 *
 * The command is passed **verbatim** as the shell's `-c` argument and never concatenated into an
 * outer string — concatenation would let model-generated text rewrite our own command line.
 */
function sandboxedBashOperations(start: ExecutorRunnerStart) {
  return {
    exec: (
      command: string,
      cwd: string,
      options: { onData: (data: Buffer) => void; signal?: AbortSignal; timeout?: number; env?: NodeJS.ProcessEnv },
    ): Promise<{ exitCode: number | null }> => {
      const [file, ...args] = sandboxArgv(start.sandboxProfilePath, start.shell, command);
      // cwd is always forced back to the workspace root: pi may pass something else based on its own
      // session state, but this task's boundary was pinned at submit time.
      const child: ChildProcess = spawn(file, args, {
        cwd: start.workspaceRoot,
        detached: true, // Its own process group, so the whole group can be killed.
        env: {
          ...options.env,
          // The scratch dir, not the system /tmp: that holds other tasks and shared sockets, and the
          // profile does not allow it anyway.
          TMPDIR: start.scratchDir,
          // The credential is never handed down to a tool process.
          ANTHROPIC_API_KEY: undefined,
          OPENAI_API_KEY: undefined,
          GEMINI_API_KEY: undefined,
          COFLUX_EXECUTOR_RUN_ID: start.runId,
        } as NodeJS.ProcessEnv,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const pgid = child.pid;
      if (typeof pgid === "number") liveGroups.add(pgid);

      child.stdout?.on("data", (chunk: Buffer) => options.onData(chunk));
      child.stderr?.on("data", (chunk: Buffer) => options.onData(chunk));

      const onAbort = () => {
        if (typeof pgid === "number") killGroup(pgid, "SIGTERM");
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });

      const timer =
        options.timeout && options.timeout > 0
          ? setTimeout(() => {
              if (typeof pgid === "number") killGroup(pgid, "SIGKILL");
            }, options.timeout)
          : undefined;

      return new Promise((resolve) => {
        child.on("close", (code) => {
          if (timer) clearTimeout(timer);
          options.signal?.removeEventListener("abort", onAbort);
          if (typeof pgid === "number") liveGroups.delete(pgid);
          resolve({ exitCode: code });
        });
        child.on("error", () => {
          if (timer) clearTimeout(timer);
          if (typeof pgid === "number") liveGroups.delete(pgid);
          resolve({ exitCode: null });
        });
      });
    },
  };
}

/** The files this task changed; the guard extension records them as it lets write/edit through. */
const changedFiles = new Set<string>();

function relativeToWorkspace(root: string, absolute: string): string {
  return absolute.startsWith(`${root}/`) ? absolute.slice(root.length + 1) : absolute;
}

async function run(start: ExecutorRunnerStart): Promise<void> {
  // pi is loaded here and not earlier: a load failure has to be reportable as startupFailed instead
  // of killing the whole process silently.
  const pi = await import("@earendil-works/pi-coding-agent");

  // This task's private pi configuration directory, inside the scratch dir, deleted with it.
  const agentDir = `${start.scratchDir}/pi-agent`;
  mkdirSync(agentDir, { recursive: true });

  /**
   * ModelRuntime must be pointed **explicitly** at this task's isolated directory.
   *
   * Its default `authPath` is `getAgentDir()/auth.json`, and without `PI_CODING_AGENT_DIR`,
   * `getAgentDir()` is the user's real `~/.pi/agent`. Passing agentDir to the ResourceLoader and the
   * session is not enough — the runtime resolves its paths separately. Skipping the isolation has two
   * consequences, both violating "do not read the user's existing ~/.pi state":
   *   - if the user has signed into the same provider in their own pi (OAuth / subscription), the
   *     executor may **use those credentials** instead of the key configured in the desktop app,
   *     invisibly and without consent;
   *   - custom providers from the user's `models.json` would be loaded too, making the executor's set
   *     of models unpredictable.
   * The cost: OpenAI-compatible endpoints with a custom base URL are unavailable in v1, and the model
   * set is limited to what pi ships with.
   */
  const runtime = await pi.ModelRuntime.create({
    allowModelNetwork: false,
    authPath: `${agentDir}/auth.json`,
    modelsPath: `${agentDir}/models.json`,
    modelsStorePath: `${agentDir}/models-store.json`,
  });
  // Must be awaited: it is asynchronous and runs through an internal credential operation queue.
  // Without the await the first request can go out before the key is in place.
  await runtime.setRuntimeApiKey(start.model.provider, start.apiKey);

  const model = runtime.getModel(start.model.provider, start.model.id);
  if (!model) {
    throw new Error(`桌面配置里的模型不可用：${start.model.provider}/${start.model.id}`);
  }

  const guardExtension = {
    name: "coflux-workspace-guard",
    hidden: true,
    factory: (api: {
      on(event: "tool_call", handler: (event: { toolName: string; input: unknown }) => { block?: boolean; reason?: string } | undefined): void;
    }) => {
      api.on("tool_call", (event) => {
        const verdict = guardToolCall({
          toolName: event.toolName,
          input: event.input,
          workspaceRoot: start.workspaceRoot,
          writable: start.write,
        });
        if (verdict) {
          transcript("error", `已拦下 ${event.toolName}：${verdict.reason}`);
          return { block: true, reason: verdict.reason };
        }
        if (event.toolName === "write" || event.toolName === "edit") {
          const path = (event.input as { path?: string } | null)?.path;
          if (typeof path === "string") changedFiles.add(relativeToWorkspace(start.workspaceRoot, path));
        }
        return undefined;
      });
    },
  };

  const bashTool = pi.createBashToolDefinition(start.workspaceRoot, {
    operations: sandboxedBashOperations(start),
    shellPath: start.shell,
    // PI_* variables push session metadata into the tools' environment; the executor does not need
    // them, and that is one information outlet fewer.
    exposeSessionEnvironment: false,
  });

  // A closed ResourceLoader must be **constructed explicitly and passed as `resourceLoader`**.
  // `createAgentSession` has no `resourceLoaderOptions` parameter (that belongs to
  // createAgentSessionServices); passing one is silently ignored — leaving on-disk extension
  // discovery on, so a `.pi/` directory in the workspace can execute arbitrary code.
  // No type assertion here on purpose, so the compiler watches this for us.
  const resourceLoader = new pi.DefaultResourceLoader({
    cwd: start.workspaceRoot,
    // Points at this task's scratch dir rather than the user's ~/.pi: their existing state is
    // neither read nor written.
    agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: start.systemPrompt,
    extensionFactories: [guardExtension],
  });
  await resourceLoader.reload();

  const { session } = await pi.createAgentSession({
    cwd: start.workspaceRoot,
    agentDir,
    modelRuntime: runtime,
    model,
    sessionManager: pi.SessionManager.inMemory(start.workspaceRoot),
    // Only the read-oriented built-in tools; bash is ours (same name, arriving through customTools).
    tools: start.write ? ["read", "edit", "write", "grep", "find", "ls"] : ["read", "grep", "find", "ls"],
    // This one assertion works around a variance problem in pi's own types: createBashToolDefinition
    // returns a ToolDefinition<TObject<...>> with a concrete schema, while customTools takes
    // ToolDefinition<TSchema>, and the two are not covariant. Let this single known point through and
    // **do not** hoist the assertion onto the whole options object — that would swallow genuinely
    // structural errors such as resourceLoader (this file once shipped a closed loader that silently
    // had no effect for exactly that reason).
    customTools: [bashTool as unknown as Parameters<typeof pi.createAgentSession>[0] extends { customTools?: (infer T)[] } ? T : never],
    resourceLoader,
  });

  send({ type: "running" });

  let lastAssistantText = "";
  /**
   * **`prompt()` returning is not success.** pi reports model-side failures on the final
   * AssistantMessage's `stopReason` (`"error"` / `"aborted"`, with an `errorMessage`) rather than by
   * throwing — a smoke test with an invalid key still had `prompt()` return normally, and an earlier
   * version reported succeeded on that basis. The terminal state must be read from here.
   */
  let lastStopReason = "";
  let lastErrorMessage = "";

  session.subscribe((event: { type: string; [key: string]: unknown }) => {
    if (event.type === "message_update") {
      const inner = event.assistantMessageEvent as { type?: string; delta?: string } | undefined;
      if (inner?.type === "text_delta" && inner.delta) lastAssistantText += inner.delta;
    } else if (event.type === "tool_execution_start") {
      const name = (event as { toolName?: string }).toolName ?? "tool";
      send({ type: "progress", note: `正在执行 ${name}` });
      transcript("tool", `→ ${name}`);
    } else if (event.type === "message_end" || event.type === "turn_end") {
      const message = (event.message ?? {}) as { stopReason?: string; errorMessage?: string };
      if (message.stopReason) lastStopReason = message.stopReason;
      if (message.errorMessage) lastErrorMessage = message.errorMessage;
      if (lastAssistantText) transcript("assistant", lastAssistantText);
    }
  });

  const timeout = setTimeout(() => void session.abort(), start.timeoutMs);
  try {
    await session.prompt(start.prompt);
  } finally {
    clearTimeout(timeout);
  }

  // Stop cleanly before recording the terminal state: the write lock holds the next writer off by
  // virtue of this run not being finished, so finishing early releases the lock early.
  await stopAllGroups();

  if (lastStopReason === "error") {
    transcript("error", lastErrorMessage || "模型调用失败");
    send({
      type: "done",
      outcome: "model_error",
      summary: lastAssistantText.trim(),
      changedFiles: [...changedFiles],
      error: lastErrorMessage || "模型调用失败，且未给出原因",
    });
    return;
  }
  if (lastStopReason === "aborted") {
    send({
      type: "done",
      outcome: "cancelled",
      summary: lastAssistantText.trim(),
      changedFiles: [...changedFiles],
      error: lastErrorMessage || "任务被中断",
    });
    return;
  }
  // Returning without a single event (the model produced no message at all) is not success either —
  // it usually means the session never really started.
  if (!lastStopReason) {
    send({
      type: "done",
      outcome: "model_error",
      summary: "",
      changedFiles: [...changedFiles],
      error: "executor 没有产出任何模型回复；检查桌面里配的 provider 与模型是否可用",
    });
    return;
  }
  send({
    type: "done",
    outcome: "succeeded",
    summary: lastAssistantText.trim(),
    changedFiles: [...changedFiles],
  });
}

let aborting = false;

process.parentPort.on("message", (event) => {
  const message = event.data as ExecutorRunnerInbound;
  if (message?.type === "abort") {
    aborting = true;
    void stopAllGroups().then(() => {
      send({ type: "done", outcome: "cancelled", summary: "", changedFiles: [...changedFiles], error: "已被停止" });
      process.exit(EXECUTOR_RUNNER_EXIT.aborted);
    });
    return;
  }
  if (message?.type !== "start") return;

  // The scratch dir must be realpath-resolved: the profile carries resolved paths, and any mismatch
  // means the sandbox never allows it.
  if (!message.scratchDir) message.scratchDir = mkdtempSync(`${tmpdir()}/coflux-executor-`);

  run(message)
    .catch(async (error: unknown) => {
      if (aborting) return;
      await stopAllGroups();
      const text = error instanceof Error ? error.message : String(error);
      transcript("error", text);
      send({
        type: "done",
        outcome: text.includes("模型") || text.includes("model") ? "model_error" : "tool_failed",
        summary: "",
        changedFiles: [...changedFiles],
        error: text,
      });
    })
    .finally(() => {
      if (!aborting) process.exit(EXECUTOR_RUNNER_EXIT.ok);
    });
});

send({ type: "ready" });
