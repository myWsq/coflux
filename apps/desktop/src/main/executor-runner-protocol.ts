/**
 * 主进程 ↔ executor runner（utilityProcess 子进程）之间的消息契约（plan 116 M3）。
 *
 * 单独一个文件是为了两边共用同一份类型，且这份文件**不 import pi**——主进程侧不该因为
 * 引用消息类型就把整个 pi 拖进自己的模块图。
 *
 * 凭证只在 `start` 消息里出现一次，不落盘、不进工具进程的 env、不进转录、不进日志。
 */

export type ExecutorRunnerStart = {
  type: "start";
  runId: string;
  prompt: string;
  /** true = 可写模式 */
  write: boolean;
  /** realpath 解析后的工作区根 */
  workspaceRoot: string;
  /** 本次任务私有的 scratch 目录（realpath）；TMPDIR 指向它 */
  scratchDir: string;
  /** 生成好的 Seatbelt profile 落盘路径，bash 后端按它套 sandbox-exec */
  sandboxProfilePath: string;
  /** 登录 shell 路径 */
  shell: string;
  /** coflux 写死的 system prompt */
  systemPrompt: string;
  model: { provider: string; id: string };
  /** provider 凭证。**只在这条消息里出现**，runner 不得转发给任何子进程或写进任何输出。 */
  apiKey: string;
  /** 单次任务的总时长上限（毫秒） */
  timeoutMs: number;
};

export type ExecutorRunnerInbound = ExecutorRunnerStart | { type: "abort" };

/** runner → 主进程。`progress` 是给用户看的一句话；转录不经 daemon，留在桌面内部。 */
export type ExecutorRunnerOutbound =
  | { type: "ready" }
  | { type: "running" }
  | { type: "progress"; note: string }
  /** 一条转录片段，供第二片的悬浮小窗消费；本片只落日志 */
  | { type: "transcript"; seq: number; kind: "assistant" | "tool" | "error"; text: string }
  | {
      type: "done";
      outcome: "succeeded" | "model_error" | "tool_failed" | "cancelled";
      summary: string;
      changedFiles: string[];
      error?: string;
    };

/** runner 的退出码语义；主进程据此在子进程异常消失时也能给出一个明确终态。 */
export const EXECUTOR_RUNNER_EXIT = {
  ok: 0,
  /** 起不来（pi 加载失败、模型配置不可用…） */
  startupFailed: 10,
  /** 收到 abort 后自行收尾退出 */
  aborted: 11,
} as const;
