/**
 * The message contract between the main process and the executor runner (a utilityProcess child).
 *
 * It is its own file so both sides share one set of types, and so that this file **imports no pi**:
 * the main process should not drag all of pi into its module graph just to name a message type.
 *
 * The credential appears exactly once, in the `start` message. It is never persisted, never placed
 * in a tool process's environment, never transcribed, and never logged.
 */

export type ExecutorRunnerStart = {
  type: "start";
  runId: string;
  prompt: string;
  /** true = writable mode. */
  write: boolean;
  /** The workspace root, realpath-resolved. */
  workspaceRoot: string;
  /** This task's private scratch directory (realpath); TMPDIR points at it. */
  scratchDir: string;
  /** Where the generated Seatbelt profile was written; the bash backend passes it to sandbox-exec. */
  sandboxProfilePath: string;
  /** Path to the login shell. */
  shell: string;
  /** The system prompt, fixed by coflux. */
  systemPrompt: string;
  model: { provider: string; id: string };
  /** The provider credential. It appears **only here**; the runner must never forward it to a child
   * process or write it into any output. */
  apiKey: string;
  /** Wall-clock cap for one task, in milliseconds. */
  timeoutMs: number;
};

export type ExecutorRunnerInbound = ExecutorRunnerStart | { type: "abort" };

/** Runner -> main process. `progress` is one sentence for the user; the transcript stays inside the
 * desktop app and never passes through the daemon. */
export type ExecutorRunnerOutbound =
  | { type: "ready" }
  | { type: "running" }
  | { type: "progress"; note: string }
  /** One transcript fragment, for the second slice's floating window to consume; this slice only logs it. */
  | { type: "transcript"; seq: number; kind: "assistant" | "tool" | "error"; text: string }
  | {
      type: "done";
      outcome: "succeeded" | "model_error" | "tool_failed" | "cancelled";
      summary: string;
      changedFiles: string[];
      error?: string;
    };

/** The runner's exit-code meanings, so the main process can still name a definite terminal state
 * when the child vanishes unexpectedly. */
export const EXECUTOR_RUNNER_EXIT = {
  ok: 0,
  /** Could not start (pi failed to load, the model configuration is unusable, ...). */
  startupFailed: 10,
  /** Wound itself down after receiving an abort. */
  aborted: 11,
} as const;
