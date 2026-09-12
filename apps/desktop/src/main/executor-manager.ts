/**
 * The executor manager: the glue that actually carries out the effects the job table emits.
 *
 * The split into three is deliberate, so the parts easiest to get wrong stay pure:
 *   - `executor-jobs`: concurrency, the write lock, terminal states, reconciliation. A pure state
 *     machine, tested exhaustively.
 *   - `executor-sandbox` / `executor-workspace`: profile text and git facts. Pure functions, tested
 *     exhaustively.
 *   - This file: starting processes, killing process groups, writing the profile to disk, handing
 *     reports up to be sent. All the side effects live here, testable through injected dependencies.
 *
 * The layer above (the IPC wiring) only has to supply two things: a callback that sends a device
 * frame, and a way to read the configuration and credentials.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ExecutorJobTable, type ExecutorAssignment, type ExecutorEffect, type ExecutorOutcome } from "./executor-jobs";
import { buildSandboxProfile } from "./executor-sandbox";
import { collectWorkspaceFacts, type GitRunner } from "./executor-workspace";
import type { ExecutorRunnerOutbound, ExecutorRunnerStart } from "./executor-runner-protocol";

/** Wall-clock cap for a task; past it the run is aborted. The executor is for handing over one
 * well-bounded piece of work, not for running indefinitely. */
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;

/** One running runner child process. */
export type RunnerHandle = {
  postMessage(message: unknown): void;
  kill(): void;
  on(event: "message", listener: (message: ExecutorRunnerOutbound) => void): void;
  on(event: "exit", listener: (code: number) => void): void;
};

export type ExecutorConfigSnapshot = {
  ready: boolean;
  reason: string;
  provider: string;
  modelId: string;
  /** Read only at the moment a runner is spawned; never cached, never logged. */
  apiKey: string;
  systemPrompt: string;
  shell: string;
};

export type ExecutorManagerDeps = {
  /** Spawn a runner child process (the real implementation uses utilityProcess.fork). */
  spawnRunner: () => RunnerHandle;
  /** Read the current configuration and credentials. */
  config: () => ExecutorConfigSnapshot;
  /** Send one frame to the daemon (through the renderer's device channel). */
  sendReport: (report: {
    runId: string;
    state: string;
    note: string;
    summary?: string;
    changedFiles?: string[];
    error?: string;
  }) => void;
  runGit?: GitRunner;
  log?: (message: string) => void;
};

const defaultRunGit: GitRunner = (args, cwd) => {
  try {
    return { stdout: execFileSync("git", [...args], { cwd, encoding: "utf8", timeout: 10_000 }), ok: true };
  } catch {
    return { stdout: "", ok: false };
  }
};

type LiveRun = {
  handle: RunnerHandle;
  scratchDir: string;
  /** A terminal state already arrived; waiting to release the lock. */
  settled: boolean;
};

export class ExecutorManager {
  private readonly table: ExecutorJobTable;
  private readonly live = new Map<string, LiveRun>();
  private readonly runGit: GitRunner;

  constructor(private readonly deps: ExecutorManagerDeps) {
    this.runGit = deps.runGit ?? defaultRunGit;
    const config = deps.config();
    this.table = new ExecutorJobTable(undefined, { ready: config.ready, reason: config.reason });
  }

  /** The configuration changed (the user just set a provider/model): the job table's admission
   * criteria have to follow. */
  refreshReadiness(): void {
    const config = this.deps.config();
    this.table.setReadiness({ ready: config.ready, reason: config.reason });
  }

  activeRunIds(): string[] {
    return this.table.activeRunIds();
  }

  onAssign(assignment: ExecutorAssignment): void {
    this.apply(this.table.assign(assignment));
  }

  onCancel(runId: string): void {
    this.apply(this.table.cancel(runId));
  }

  onAck(runId: string): void {
    this.table.ack(runId);
  }

  onReconcile(daemonRunIds: readonly string[]): void {
    this.apply(this.table.reconcile(daemonRunIds));
  }

  /**
   * The local runtime is going away: every unfinished run reaches a definite terminal state and
   * every tool process group is stopped, so the write lock is released and no CLI polls forever.
   * Idempotent — a second call finds nothing unfinished and nothing live.
   */
  cancelAll(error: string): void {
    this.apply(this.table.cancelAll(error));
    for (const [, run] of this.live) run.handle.kill();
    this.live.clear();
  }

  private log(message: string): void {
    this.deps.log?.(`[executor] ${message}`);
  }

  private apply(effects: readonly ExecutorEffect[]): void {
    for (const effect of effects) {
      if (effect.kind === "report") {
        this.deps.sendReport({
          runId: effect.runId,
          state: effect.state,
          note: effect.note,
          summary: effect.outcome?.summary,
          changedFiles: effect.outcome?.changedFiles,
          error: effect.outcome?.error,
        });
      } else if (effect.kind === "start") {
        this.start(effect.assignment);
      } else {
        this.stop(effect.runId);
      }
    }
  }

  private start(assignment: ExecutorAssignment): void {
    let scratchDir = "";
    try {
      const config = this.deps.config();
      // Both need realpath: the profile carries kernel-resolved paths, and any mismatch makes the
      // rule silently do nothing.
      const root = realpathSync(assignment.workspaceRoot);
      scratchDir = realpathSync(mkdtempSync(join(tmpdir(), "coflux-executor-")));

      const facts = collectWorkspaceFacts(root, this.runGit);
      const profile = buildSandboxProfile({
        workspaceRoot: root,
        writable: assignment.write,
        nestedWorktrees: facts.otherWorktrees,
        gitDirs: facts.gitDirs,
        scratchDir,
      });
      const profilePath = join(scratchDir, "sandbox.sb");
      writeFileSync(profilePath, profile, { mode: 0o600 });

      const handle = this.deps.spawnRunner();
      this.live.set(assignment.runId, { handle, scratchDir, settled: false });

      handle.on("message", (message) => this.onRunnerMessage(assignment.runId, message));
      handle.on("exit", (code) => this.onRunnerExit(assignment.runId, code));

      const start: ExecutorRunnerStart = {
        type: "start",
        runId: assignment.runId,
        prompt: assignment.prompt,
        write: assignment.write,
        workspaceRoot: root,
        scratchDir,
        sandboxProfilePath: profilePath,
        shell: config.shell,
        systemPrompt: config.systemPrompt,
        model: { provider: config.provider, id: config.modelId },
        apiKey: config.apiKey,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      };
      handle.postMessage(start);
      this.log(`run ${assignment.runId} 已起（${assignment.write ? "可写" : "只读"}，${root}）`);
    } catch (error) {
      // Failing to start must still record a terminal state: otherwise the write lock is never
      // released and the CLI polls forever.
      const text = error instanceof Error ? error.message : String(error);
      this.log(`run ${assignment.runId} 启动失败：${text}`);
      if (scratchDir) this.cleanScratch(scratchDir);
      this.live.delete(assignment.runId);
      this.apply(this.table.finish(assignment.runId, { state: "tool_failed", error: `executor 启动失败：${text}` }));
    }
  }

  private stop(runId: string): void {
    const run = this.live.get(runId);
    if (!run) return;
    // Let the runner wind itself down first (it stops bash by process group); force-kill only if it
    // does not answer.
    run.handle.postMessage({ type: "abort" });
    setTimeout(() => {
      if (this.live.has(runId)) {
        this.log(`run ${runId} 未在宽限期内自行停止，强杀 runner`);
        run.handle.kill();
      }
    }, 8_000);
  }

  private onRunnerMessage(runId: string, message: ExecutorRunnerOutbound): void {
    if (message.type === "running") {
      this.apply(this.table.markRunning(runId));
    } else if (message.type === "progress") {
      this.apply(this.table.markRunning(runId, message.note));
    } else if (message.type === "done") {
      const outcome: ExecutorOutcome = {
        state: message.outcome,
        summary: message.summary,
        changedFiles: message.changedFiles,
        error: message.error,
      };
      const run = this.live.get(runId);
      if (run) run.settled = true;
      this.apply(this.table.finish(runId, outcome));
    }
    // transcript / ready are not consumed in this slice: the transcript stays inside the desktop app
    // and is only needed by the second slice's floating window.
  }

  /**
   * The runner process is gone. Fill in a terminal state **only if one was not recorded already** —
   * otherwise a run that already succeeded would be overwritten as a failure. What gets filled in is
   * `unknown`, not `tool_failed`: when a process vanishes unexpectedly, we do not know how far it got.
   */
  private onRunnerExit(runId: string, code: number): void {
    const run = this.live.get(runId);
    this.live.delete(runId);
    if (run) this.cleanScratch(run.scratchDir);
    if (!run || run.settled) return;
    this.log(`run ${runId} 的 runner 异常退出（code=${code}），判 unknown`);
    this.apply(
      this.table.finish(runId, {
        state: "unknown",
        error: `executor 进程异常退出（code=${code}）；它是否已经改过文件无法判断`,
      }),
    );
  }

  /** Delete only the directory mkdtemp handed back, and only when the string is non-empty. */
  private cleanScratch(scratchDir: string): void {
    if (!scratchDir || !scratchDir.includes("coflux-executor-")) return;
    try {
      rmSync(scratchDir, { recursive: true, force: true });
    } catch {
      // A failed cleanup does not affect the task's result.
    }
  }
}
