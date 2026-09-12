/**
 * The executor job table. The desktop main process is the **only** source of truth for it and for
 * the write lock.
 *
 * Why here and not in the daemon: worker memory is lost on hot upgrade (already stated in the
 * command-log index comment in `crates/worker/src/main.rs`), and `docs/architecture.md` states that
 * ordinary mutations offer no cross-worker deduplication. The daemon keeps only the state and
 * terminal outcomes the CLI polls; it neither schedules nor re-dispatches.
 *
 * This module is a pure state machine: no utilityProcess, no IPC, no view of the outside world
 * beyond the clock. Actually starting processes and killing process groups happens in
 * executor-manager, which executes the `ExecutorEffect`s this module emits. That keeps concurrency
 * and terminal states — the parts easiest to get wrong — exhaustively testable.
 *
 * Three invariants:
 *   1. **Write mode is mutually exclusive per workspace.** A second write request is refused on the
 *      spot with a readable reason and is never queued — the agent is blocked on a synchronous
 *      result, and queueing would only make it time out.
 *   2. **Read-only runs may go in parallel, up to a total cap.** The cap protects local resources;
 *      it carries no semantics.
 *   3. **A terminal state is held and re-sent until the daemon acks it.** After a reconnect,
 *      reconcile re-reports each one; anything the daemon is not told about becomes unknown, and
 *      unknown is **never re-run automatically** — an expired lease does not prove the old writer
 *      stopped.
 */

/** One-to-one with proto's ExecutorRunState. Strings here: across IPC they read and assert better
 * than a numeric enum. */
export type ExecutorRunState =
  | "accepted"
  | "running"
  | "succeeded"
  | "rejected"
  | "model_error"
  | "tool_failed"
  | "cancelled"
  | "unknown";

const TERMINAL_STATES: ReadonlySet<ExecutorRunState> = new Set<ExecutorRunState>([
  "succeeded",
  "rejected",
  "model_error",
  "tool_failed",
  "cancelled",
  "unknown",
]);

export function isTerminal(state: ExecutorRunState): boolean {
  return TERMINAL_STATES.has(state);
}

/** The assignment the daemon pushed. Both workspace fields were resolved and pinned at submit time;
 * this table stores them verbatim and never re-resolves them. */
export type ExecutorAssignment = {
  runId: string;
  prompt: string;
  write: boolean;
  workspaceId: string;
  workspaceRoot: string;
  submittedAt: number;
};

export type ExecutorOutcome = {
  state: Extract<ExecutorRunState, "succeeded" | "model_error" | "tool_failed" | "cancelled" | "unknown">;
  /** The executor's final reply; may be empty on refusal or failure. */
  summary?: string;
  /** Workspace-relative paths. */
  changedFiles?: string[];
  error?: string;
};

export type ExecutorJob = {
  assignment: ExecutorAssignment;
  state: ExecutorRunState;
  /** One in-flight sentence, or the reason for a refusal. */
  note: string;
  outcome: ExecutorOutcome | null;
  /** The terminal state was sent but the daemon has not acked it — re-send after a reconnect. */
  reportPending: boolean;
  /** A stop was already requested (the user pressed stop, or the daemon sent a cancel); this makes
   * cancel idempotent. */
  stopRequested: boolean;
};

/**
 * What the job table asks its caller to do. The state machine starts no processes and sends no
 * frames itself. `Report` covers both intermediate and terminal states; the receiver just sends it.
 */
export type ExecutorEffect =
  | { kind: "start"; assignment: ExecutorAssignment }
  | { kind: "stop"; runId: string }
  | { kind: "report"; runId: string; state: ExecutorRunState; note: string; outcome: ExecutorOutcome | null };

export type ExecutorLimits = {
  /** Cap on runs in flight at once (writers and readers counted together). */
  maxConcurrent: number;
};

export const DEFAULT_EXECUTOR_LIMITS: ExecutorLimits = { maxConcurrent: 3 };

/** Whether the host can take work at all. With no provider/model configured the daemon already
 * refuses at submit time; this is the second gate. */
export type HostReadiness = { ready: boolean; reason: string };

export class ExecutorJobTable {
  private readonly jobs = new Map<string, ExecutorJob>();

  constructor(
    private readonly limits: ExecutorLimits = DEFAULT_EXECUTOR_LIMITS,
    private readiness: HostReadiness = { ready: false, reason: "尚未配置 provider 与模型" },
  ) {}

  setReadiness(readiness: HostReadiness): void {
    this.readiness = readiness;
  }

  get(runId: string): ExecutorJob | undefined {
    return this.jobs.get(runId);
  }

  all(): ExecutorJob[] {
    return [...this.jobs.values()];
  }

  /** The run ids still in flight (accepted / running), for reconnect reconciliation to re-report. */
  activeRunIds(): string[] {
    return this.all()
      .filter((job) => !isTerminal(job.state))
      .map((job) => job.assignment.runId);
  }

  private activeCount(): number {
    return this.all().filter((job) => !isTerminal(job.state)).length;
  }

  private writerOf(workspaceId: string): ExecutorJob | undefined {
    return this.all().find(
      (job) => job.assignment.write && job.assignment.workspaceId === workspaceId && !isTerminal(job.state),
    );
  }

  /**
   * Take an assignment. **Idempotent**: the same runId arriving again only re-emits the effect for
   * the current state and never starts a second process — this is what the daemon relies on when a
   * submission times out and is re-pushed.
   */
  assign(assignment: ExecutorAssignment): ExecutorEffect[] {
    const existing = this.jobs.get(assignment.runId);
    if (existing) {
      // A duplicate delivery: re-reporting the current state is enough, terminal states included
      // (the daemon may never have received the ack).
      return [{ kind: "report", runId: existing.assignment.runId, state: existing.state, note: existing.note, outcome: existing.outcome }];
    }

    const rejection = this.rejectionFor(assignment);
    if (rejection) {
      const job: ExecutorJob = {
        assignment,
        state: "rejected",
        note: rejection,
        outcome: null,
        reportPending: true,
        stopRequested: false,
      };
      this.jobs.set(assignment.runId, job);
      return [{ kind: "report", runId: assignment.runId, state: "rejected", note: rejection, outcome: null }];
    }

    const job: ExecutorJob = {
      assignment,
      state: "accepted",
      note: "",
      outcome: null,
      reportPending: false,
      stopRequested: false,
    };
    this.jobs.set(assignment.runId, job);
    return [
      { kind: "report", runId: assignment.runId, state: "accepted", note: "", outcome: null },
      { kind: "start", assignment },
    ];
  }

  /** The reason for refusing on the spot; null means it can be taken. The wording is read by the
   * calling agent, so it has to say what that agent can do next. */
  private rejectionFor(assignment: ExecutorAssignment): string | null {
    if (!this.readiness.ready) {
      return this.readiness.reason || "桌面 app 尚未配置 executor 的 provider 与模型";
    }
    if (assignment.write) {
      const writer = this.writerOf(assignment.workspaceId);
      if (writer) {
        return `该工作区已有一个写模式 executor 任务在跑（${writer.assignment.runId}）；写模式同一工作区只能有一个，等它结束再发`;
      }
    }
    if (this.activeCount() >= this.limits.maxConcurrent) {
      return `本机同时在跑的 executor 任务已达上限 ${this.limits.maxConcurrent}，等一个结束再发`;
    }
    return null;
  }

  /** The runner really started. */
  markRunning(runId: string, note = ""): ExecutorEffect[] {
    const job = this.jobs.get(runId);
    if (!job || isTerminal(job.state)) return [];
    if (job.state === "running" && job.note === note) return [];
    job.state = "running";
    job.note = note;
    return [{ kind: "report", runId, state: "running", note, outcome: null }];
  }

  /**
   * Record a terminal state. The caller must call this **only after confirming the tool's child
   * processes really stopped** — the write lock holds the next write request off by virtue of this
   * run not being finished, so finishing early releases the lock early and lets a second writer in.
   */
  finish(runId: string, outcome: ExecutorOutcome): ExecutorEffect[] {
    const job = this.jobs.get(runId);
    if (!job || isTerminal(job.state)) return [];
    job.state = outcome.state;
    job.outcome = outcome;
    job.note = outcome.error ?? job.note;
    job.reportPending = true;
    return [{ kind: "report", runId, state: outcome.state, note: job.note, outcome }];
  }

  /** Cancel is **idempotent**: cancelling a finished run does nothing, and repeated cancels never
   * emit a second stop. */
  cancel(runId: string): ExecutorEffect[] {
    const job = this.jobs.get(runId);
    if (!job || isTerminal(job.state) || job.stopRequested) return [];
    job.stopRequested = true;
    job.note = "正在停止";
    return [{ kind: "stop", runId }];
  }

  /** The daemon confirmed it received the terminal state; the local copy can go. */
  ack(runId: string): void {
    const job = this.jobs.get(runId);
    if (!job) return;
    job.reportPending = false;
    if (isTerminal(job.state)) this.jobs.delete(runId);
  }

  /**
   * Reconnect reconciliation: the daemon hands over its list of unfinished runs and we re-report
   * each one. Runs we recognize and that are still going are reported as they are; **anything we do
   * not recognize is unknown** — this host instance has no way to know how far that run got, so the
   * daemon records unknown and leaves the judgement to a person. Never re-run automatically.
   */
  reconcile(daemonRunIds: readonly string[]): ExecutorEffect[] {
    const effects: ExecutorEffect[] = [];
    for (const runId of daemonRunIds) {
      const job = this.jobs.get(runId);
      if (job) {
        effects.push({ kind: "report", runId, state: job.state, note: job.note, outcome: job.outcome });
      } else {
        effects.push({
          kind: "report",
          runId,
          state: "unknown",
          note: "桌面 app 不认识这条任务（app 重启或实例更换）；它是否写过文件无法判断",
          outcome: { state: "unknown", error: "host 不认识该 run" },
        });
      }
    }
    // Terminal states we still hold that the daemon did not ask about go out again on this
    // connection too.
    for (const job of this.all()) {
      if (job.reportPending && !daemonRunIds.includes(job.assignment.runId)) {
        effects.push({
          kind: "report",
          runId: job.assignment.runId,
          state: job.state,
          note: job.note,
          outcome: job.outcome,
        });
      }
    }
    return effects;
  }

  /**
   * The local runtime is going away: every unfinished run becomes `cancelled` and is asked to stop.
   *
   * "The runtime stopped, so the job stopped" is an accepted product constraint, but a **definite
   * terminal state is not optional** — without one the CLI on the other end polls forever. The
   * caller passes the sentence saying which user action ended the run (see `executor-lifecycle`).
   */
  cancelAll(error: string): ExecutorEffect[] {
    const effects: ExecutorEffect[] = [];
    for (const job of this.all()) {
      if (isTerminal(job.state)) continue;
      effects.push({ kind: "stop", runId: job.assignment.runId });
      effects.push(...this.finish(job.assignment.runId, { state: "cancelled", error }));
    }
    return effects;
  }
}
