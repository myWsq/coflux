/**
 * executor 管理器（plan 116 M2/M3 的胶水）：把作业表吐出的 effect 真正执行掉。
 *
 * 分工刻意划成三段，方便把最容易写错的部分留在纯函数里：
 *   - `executor-jobs`：并发、写锁、终态、对账。纯状态机，穷举测试。
 *   - `executor-sandbox` / `executor-workspace`：profile 文本与 git 事实。纯函数，穷举测试。
 *   - 本文件：起进程、杀进程组、落盘 profile、把回报交给上层发出去。副作用都在这里，注入依赖后可测。
 *
 * 上层（IPC 接线）只需要给两样东西：一个把 device 帧发出去的回调，一个读配置与凭证的入口。
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ExecutorJobTable, type ExecutorAssignment, type ExecutorEffect, type ExecutorOutcome } from "./executor-jobs";
import { buildSandboxProfile } from "./executor-sandbox";
import { collectWorkspaceFacts, type GitRunner } from "./executor-workspace";
import type { ExecutorRunnerOutbound, ExecutorRunnerStart } from "./executor-runner-protocol";

/** 任务总时长上限：超过就 abort。executor 是「甩一段边界清楚的活」，不是长驻。 */
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;

/** 一个在跑的 runner 子进程。 */
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
  /** 只在起 runner 那一刻取用，不缓存、不落日志 */
  apiKey: string;
  systemPrompt: string;
  shell: string;
};

export type ExecutorManagerDeps = {
  /** 起一个 runner 子进程（真实实现用 utilityProcess.fork） */
  spawnRunner: () => RunnerHandle;
  /** 读当前配置与凭证 */
  config: () => ExecutorConfigSnapshot;
  /** 把一帧发给 daemon（经渲染层的 device 通道） */
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
  /** 已经收到终态，等着放锁 */
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

  /** 配置变了（用户刚配好 provider/model）：作业表的准入判据要跟着变。 */
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

  /** app 要退出了：所有未终结的 run 落明确终态，不留给 CLI 侧永久轮询。 */
  shutdown(): void {
    this.apply(this.table.shutdown());
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
      // 两个都要 realpath：profile 里写的是内核解析后的路径，不一致规则就静默失效。
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
      // 起不来也必须落终态：否则写锁不放，而且 CLI 会一直轮询。
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
    // 先让 runner 自己收尾（它会按进程组停掉 bash），拿不到回应再硬杀。
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
    // transcript / ready 本片不消费：转录留在桌面内部，第二片的悬浮小窗才用得上。
  }

  /**
   * runner 进程没了。**只有在还没落终态时**才补一个——否则会把已经成功的 run 覆盖成失败。
   * 补的是 `unknown` 而不是 `tool_failed`：进程异常消失时，它写到哪了我们并不知道。
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

  /** 只删 mkdtemp 给出的那个目录，且必须非空串。 */
  private cleanScratch(scratchDir: string): void {
    if (!scratchDir || !scratchDir.includes("coflux-executor-")) return;
    try {
      rmSync(scratchDir, { recursive: true, force: true });
    } catch {
      // 清理失败不影响任务结果
    }
  }
}
