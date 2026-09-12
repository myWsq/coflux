/**
 * executor runner（plan 116 M3）：utilityProcess 的子进程入口，一个进程跑一次任务。
 *
 * 为什么是独立进程而不是在主进程里跑 pi：pi 会拉起子进程、吃内存、可能崩；主进程崩了整个 app 就没了。
 * 一任务一进程还让「停止」有了干净的终极手段——杀掉整棵树即可。
 *
 * 这里是**沙箱外**的一侧：模型调用在这个进程里发出，所以它能联网。真正跑用户命令的 bash 子进程
 * 被 `sandbox-exec` 包住，那一侧没有网络、也只能写工作区（见 executor-sandbox.ts）。
 *
 * 与 pi 的四处关键对接，每一处都对应 plan 里的一条决策：
 *   1. **封闭 ResourceLoader**：`noExtensions/noSkills/noPromptTemplates/noThemes/noContextFiles` 全关，
 *      再用 `systemPrompt` 给 coflux 自己的。不关的话，工作区里放一个 `.pi/` 目录就能执行任意代码。
 *   2. **内联守卫扩展**：`extensionFactories` 注册一个只做拦截的扩展，`pi.on("tool_call")` 里对结构化
 *      文件工具查路径。磁盘扩展发现已关，这条是进程内的、可信的。
 *   3. **bash 换执行后端**：`createBashToolDefinition(cwd, { operations })`，每条命令套 sandbox-exec，
 *      并按进程组杀——pi 自带的后端用 `detached: true`，杀 pid 杀不掉它派生的那一组。
 *   4. **session 不落盘**：`SessionManager.inMemory()`，不碰用户既有的 `~/.pi` 状态。
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
 * 在跑的 bash 子进程登记表。**按进程组记**，不是按 pid：pi 的 bash 后端用 detached 起 shell，
 * 命令里的 `&`、管道、子 shell 都在同一个组里，只杀 pid 会留下一片还在写文件的孤儿。
 */
const liveGroups = new Set<number>();

function killGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    // 组已经没了；正常路径
  }
}

/** 先礼后兵：TERM 给 2 秒收尾，再 KILL。返回在 KILL 之后。 */
async function stopAllGroups(): Promise<void> {
  for (const pgid of liveGroups) killGroup(pgid, "SIGTERM");
  if (liveGroups.size === 0) return;
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  for (const pgid of liveGroups) killGroup(pgid, "SIGKILL");
  // 再给内核一点时间把写操作落停，之后才允许上层放写锁
  await new Promise((resolve) => setTimeout(resolve, 200));
}

/**
 * 沙箱化的 bash 执行后端。替换掉 pi 自带的那个。
 *
 * 命令**原样**作为 `-c` 的实参传给 shell，绝不拼进外层字符串——拼接就意味着模型生成的文本能改写
 * 我们自己的命令行。
 */
function sandboxedBashOperations(start: ExecutorRunnerStart) {
  return {
    exec: (
      command: string,
      cwd: string,
      options: { onData: (data: Buffer) => void; signal?: AbortSignal; timeout?: number; env?: NodeJS.ProcessEnv },
    ): Promise<{ exitCode: number | null }> => {
      const [file, ...args] = sandboxArgv(start.sandboxProfilePath, start.shell, command);
      // cwd 一律锁回工作区根：pi 可能按它自己的会话状态传别的进来，而本任务的边界在提交时就固定了。
      const child: ChildProcess = spawn(file, args, {
        cwd: start.workspaceRoot,
        detached: true, // 自成进程组，才能整组杀
        env: {
          ...options.env,
          // scratch 而不是系统 /tmp：那里有别的任务和共享 socket，profile 也没放行它
          TMPDIR: start.scratchDir,
          // 凭证绝不下发到工具进程
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

/** 收集本次任务改过的文件；由守卫扩展在放行 write/edit 时顺带记账。 */
const changedFiles = new Set<string>();

function relativeToWorkspace(root: string, absolute: string): string {
  return absolute.startsWith(`${root}/`) ? absolute.slice(root.length + 1) : absolute;
}

async function run(start: ExecutorRunnerStart): Promise<void> {
  // pi 在这里才加载：加载失败要能报 startupFailed，而不是让整个进程静默死掉。
  const pi = await import("@earendil-works/pi-coding-agent");

  // 本次任务私有的 pi 配置目录，落在 scratch 里，任务结束随 scratch 一起删。
  const agentDir = `${start.scratchDir}/pi-agent`;
  mkdirSync(agentDir, { recursive: true });

  /**
   * ModelRuntime 必须**显式指向本次任务的隔离目录**。
   *
   * 它的默认 `authPath` 是 `getAgentDir()/auth.json`，而 `getAgentDir()` 在没有 `PI_CODING_AGENT_DIR`
   * 时就是用户真实的 `~/.pi/agent`。只给 ResourceLoader 与 session 传 agentDir 是不够的——runtime 是
   * 另一条路径解析。不隔离会有两个后果，都违反「不读用户既有 ~/.pi 状态」：
   *   - 用户若在自己的 pi 里登过同一个 provider（OAuth / 订阅），executor 可能**用那份凭证**而不是
   *     桌面里配的 key，用户既看不见也没同意；
   *   - 用户 `models.json` 里的自定义 provider 会被一并加载，executor 的模型面因此不可预期。
   * 代价：自定义 base URL 的 OpenAI 兼容端点在 v1 用不了，模型面只有 pi 内置那批。
   */
  const runtime = await pi.ModelRuntime.create({
    allowModelNetwork: false,
    authPath: `${agentDir}/auth.json`,
    modelsPath: `${agentDir}/models.json`,
    modelsStorePath: `${agentDir}/models-store.json`,
  });
  // 必须 await：它是异步的，且内部走凭证操作队列。不等就可能在 key 落位前发出第一次请求。
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
    // PI_* 环境变量会把会话元信息塞进工具 env；executor 不需要，少一个信息出口。
    exposeSessionEnvironment: false,
  });

  // 封闭 ResourceLoader 必须**显式构造后传 `resourceLoader`**。
  // `createAgentSession` 没有 `resourceLoaderOptions` 这个入参（那是 createAgentSessionServices 上的），
  // 传了会被静默忽略——于是磁盘扩展发现照常打开，工作区里一个 `.pi/` 就能执行任意代码。
  // 这里刻意不加类型断言，让编译器替我们盯住这件事。
  const resourceLoader = new pi.DefaultResourceLoader({
    cwd: start.workspaceRoot,
    // 指向本次任务的 scratch，而不是用户的 ~/.pi：不读也不写用户既有状态
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
    // 只给读类内置工具；bash 用我们自己那把（同名，走 customTools 进来）
    tools: start.write ? ["read", "edit", "write", "grep", "find", "ls"] : ["read", "grep", "find", "ls"],
    // 这一处断言是 pi 自身的类型型变问题：createBashToolDefinition 返回带具体 schema 的
    // ToolDefinition<TObject<…>>，而 customTools 收的是 ToolDefinition<TSchema>，两者不协变。
    // 只放过这一个已知点，**不要**把断言上提到整个选项对象——那样会连 resourceLoader 这类
    // 真正的结构性错误一起吞掉（本文件先前就因此漏过一次封闭 loader 未生效）。
    customTools: [bashTool as unknown as Parameters<typeof pi.createAgentSession>[0] extends { customTools?: (infer T)[] } ? T : never],
    resourceLoader,
  });

  send({ type: "running" });

  let lastAssistantText = "";
  /**
   * **`prompt()` 返回不等于成功。** pi 把模型侧的失败报在最终 AssistantMessage 的 `stopReason` 上
   * （`"error"` / `"aborted"`，附 `errorMessage`），而不是抛异常——冒烟时用一把无效 key 跑，
   * `prompt()` 照样正常返回，早先那版据此报了 succeeded。终态必须从这里读。
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

  // 先停干净再落终态：写锁是靠「这条 run 还没终结」挡住下一个写手的，提前终结等于提前放锁。
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
  // 一次事件都没收到就返回（模型没产出任何消息）同样不算成功——多半是会话根本没跑起来。
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

  // scratch 必须是 realpath 解析后的：profile 里写的是解析后的路径，两边不一致沙箱就放不开它。
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
