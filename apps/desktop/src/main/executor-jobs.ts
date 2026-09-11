/**
 * executor 作业表（plan 116 M2）：桌面主进程是作业表与写锁的**唯一真相**。
 *
 * 为什么在这里而不在 daemon：worker 的内存态热升级即丢（`crates/worker/src/main.rs` 的命令日志索引
 * 注释已明说），`docs/architecture.md` 也明确普通 mutation 不提供跨 worker 去重。daemon 那边只留一份
 * 供 CLI 轮询的状态与终态，不做调度、不重派。
 *
 * 本模块是纯函数状态机：不碰 utilityProcess、不碰 IPC、不看时钟以外的任何外部世界。真正起进程、杀进程组
 * 的活在 executor-manager 里，由它把本模块吐出的 `ExecutorEffect` 执行掉。这样并发与终态这套最容易写错的
 * 逻辑可以被穷举测试。
 *
 * 三条不变量：
 *   1. **写模式每工作区互斥**。第二个写请求当场拒绝并给出可读原因，绝不排队——agent 在等一个同步结果，
 *      排队只会让它超时。
 *   2. **只读可并发，但有总数上限**。上限是保护本机资源，不是语义。
 *   3. **终态一直留在手里重发，直到 daemon ack**。掉线重连后靠 reconcile 逐条重报；daemon 侧没被重报的
 *      会被判 unknown，而 unknown **绝不自动重跑**——租约失效不证明旧 writer 已经停了。
 */

/** 与 proto 的 ExecutorRunState 一一对应；这里用字符串，跨 IPC 比数字枚举好读也好断言。 */
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

/** daemon 推来的工单。workspace 两项在提交那一刻就已解析固定，本表原样保存、不再重解析。 */
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
  /** executor 的最终回复；拒绝与失败时可为空 */
  summary?: string;
  /** 工作区相对路径 */
  changedFiles?: string[];
  error?: string;
};

export type ExecutorJob = {
  assignment: ExecutorAssignment;
  state: ExecutorRunState;
  /** 进行中的一句话，或拒绝原因 */
  note: string;
  outcome: ExecutorOutcome | null;
  /** 终态已发出但尚未收到 daemon 的 ack——掉线重连后要重发 */
  reportPending: boolean;
  /** 已请求停止（用户点了停止，或 daemon 发来取消）；用于让 cancel 幂等 */
  stopRequested: boolean;
};

/**
 * 作业表要调用方替它做的事。状态机自己不起进程、不发帧。
 * `Report` 覆盖中间态与终态两种，接收方照发即可。
 */
export type ExecutorEffect =
  | { kind: "start"; assignment: ExecutorAssignment }
  | { kind: "stop"; runId: string }
  | { kind: "report"; runId: string; state: ExecutorRunState; note: string; outcome: ExecutorOutcome | null };

export type ExecutorLimits = {
  /** 同时在跑的 run 总数上限（写 + 只读一起算） */
  maxConcurrent: number;
};

export const DEFAULT_EXECUTOR_LIMITS: ExecutorLimits = { maxConcurrent: 3 };

/** host 是否已经可以接单；未配置 provider/model 时 daemon 在提交那刻就拒了，这里是第二道门。 */
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

  /** 仍在跑（accepted / running）的 run id，供重连对账逐条重报。 */
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
   * 收下一张工单。**幂等**：同一 runId 再来一次只回当前状态对应的 effect，不会起第二个进程——
   * daemon 侧提交超时重推时靠的就是这条。
   */
  assign(assignment: ExecutorAssignment): ExecutorEffect[] {
    const existing = this.jobs.get(assignment.runId);
    if (existing) {
      // 重复投递：把当前状态再报一次就够，终态也照报（daemon 可能没收到 ack）。
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

  /** 当场拒绝的原因；null = 可以接。文案是给发起方 agent 看的，要说清它下一步能做什么。 */
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

  /** runner 真的开跑了。 */
  markRunning(runId: string, note = ""): ExecutorEffect[] {
    const job = this.jobs.get(runId);
    if (!job || isTerminal(job.state)) return [];
    if (job.state === "running" && job.note === note) return [];
    job.state = "running";
    job.note = note;
    return [{ kind: "report", runId, state: "running", note, outcome: null }];
  }

  /**
   * 落终态。调用方必须**在确认工具子进程真的停了之后**才调它——写锁是靠「这条 run 还没终结」
   * 挡住下一个写请求的，提前终结等于提前放锁，会放进第二个写手。
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

  /** 取消是**幂等**的：已终结的 run 上取消是空操作，重复取消不会发第二次 stop。 */
  cancel(runId: string): ExecutorEffect[] {
    const job = this.jobs.get(runId);
    if (!job || isTerminal(job.state) || job.stopRequested) return [];
    job.stopRequested = true;
    job.note = "正在停止";
    return [{ kind: "stop", runId }];
  }

  /** daemon 确认收到终态，可以丢掉本地副本了。 */
  ack(runId: string): void {
    const job = this.jobs.get(runId);
    if (!job) return;
    job.reportPending = false;
    if (isTerminal(job.state)) this.jobs.delete(runId);
  }

  /**
   * 重连对账：daemon 把它手里未终结的 run 清单给过来，我们逐条重报。
   * 认识且还在跑的照实报；**不认识的一律 unknown**——这个 host 实例无从知道那条 run 当时写到哪了，
   * 由 daemon 记成 unknown 交给人判断，绝不自动重跑。
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
    // 本地还留着、但 daemon 没问起的终态，也趁这次连接重发一遍。
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
   * app 要退出了：把所有未终结的 run 落成 cancelled 并请求停止。
   * 「app 关了任务就中断」是已接受的产品约束，但**必须给出明确终态**，不能让 CLI 侧永久轮询。
   */
  shutdown(): ExecutorEffect[] {
    const effects: ExecutorEffect[] = [];
    for (const job of this.all()) {
      if (isTerminal(job.state)) continue;
      effects.push({ kind: "stop", runId: job.assignment.runId });
      effects.push(
        ...this.finish(job.assignment.runId, {
          state: "cancelled",
          error: "桌面 app 退出，任务被中断",
        }),
      );
    }
    return effects;
  }
}
