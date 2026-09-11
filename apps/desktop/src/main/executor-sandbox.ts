/**
 * executor 工具进程的 Seatbelt profile 生成（plan 116 M3）。
 *
 * pi 官方明确不带沙箱（立场是「跑容器，或自己用扩展做确认流」），所以「只能改本工作区」这条得我们自己兑现。
 * 结构化文件工具可以在 JS 里查路径，但 `bash` 是个敞口——它能跑任何东西。这里给 bash 的每条命令套一层
 * `/usr/bin/sandbox-exec`，用内核来兜底。
 *
 * **档位是「防失误」不是「防敌手」**：基线 `(allow default)` 之上做减法，能挡住越界写与整类本机代理执行，
 * 但 Mach/XPC 与 Apple Events 仍然开着。要堵那层得改成默认拒绝再逐项放行系统服务，是另一摊工程。
 * 威胁模型是「被搞糊涂的 agent 走错路」，不是有敌意的攻击者——用户本机跑的 Claude Code 本来就完全没有沙箱。
 * 任何把它说成完整隔离的文案都是错的。
 *
 * ## 三条来自实测的硬约束（macOS 26 / Darwin 27 上逐条验过，别凭直觉改）
 *
 * 1. **路径必须是 realpath 解析后的真实路径**。`/var/...` 写进 profile 规则形同不存在（`/var` 是指向
 *    `/private/var` 的符号链接），而且**不报错**——表现是「允许规则像没写一样」，能让人白查半天。
 *    本模块因此拒绝收下任何看起来没解析过的路径。
 * 2. **不要用 `-D` 参数配 `(param "X")`**，实测不生效；一律把字面量拼进 profile。
 * 3. **`(deny network*)` 一条就同时挡住 loopback TCP 与 unix socket**（实测），所以不需要枚举 supervisor
 *    UDS、Docker socket、SSH agent 这些路径。反过来说也**不能**换成只封 loopback：那样 UDS 还开着。
 *
 * ## 为什么工具进程一律不联网
 *
 * daemon 的回环 `/agent` 端点认调用方靠的是请求体里自报的 pid（`crates/worker/src/hook.rs`），核对的是
 * 「这个 pid 属于某个会话进程树」而不是「这条连接真由它发出」。于是沙箱里的工具进程只要能打回环，就能用
 * `terminal.new` 让**完全不受沙箱约束的 daemon** 替它执行任意命令——沙箱等于白做。模型调用发生在 runner
 * 里而 runner 不进沙箱，所以断掉工具进程的网络不影响 executor 本身工作。
 * 代价是 executor 跑不了 `npm install` 这类要拉依赖的命令，这条限制写在 SKILL 里让发起方 agent 知道。
 */

/** shell 重定向要写 /dev/null，不放行的话 `cmd >/dev/null` 直接失败。 */
const WRITABLE_DEVICES = ["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty", "/dev/dtracehelper"] as const;

export type SandboxInput = {
  /** realpath 解析后的工作区根；只读模式下也用它做 cwd */
  workspaceRoot: string;
  /** true = 可写模式（允许写工作区）；false = 只读（工作区也不可写） */
  writable: boolean;
  /**
   * realpath 解析后、必须挖掉的其他已登记 worktree。
   * 本仓库现实：`git worktree list` 里有嵌套在主工作区 `.claude/worktrees/` 下的 worktree，甚至两层嵌套。
   * 不挖掉的话，在主工作区跑的 executor 会连带获得对别人未合并工作的写权限。
   */
  nestedWorktrees: readonly string[];
  /**
   * realpath 解析后的 git 目录：本 worktree 的 gitdir 与共享的 common dir。
   * v1 **一律只读**——executor 不 commit，改动交回发起方 agent 提交。这样同时躲开 worktree 级 config、
   * `core.hooksPath`、rebase sequencer 的 `exec`、submodule config 这一整串持久化执行入口。
   */
  gitDirs: readonly string[];
  /** 任务私有的 scratch 目录（realpath）。给它而不是放行整个 /tmp：那里有别的任务与共享 socket。 */
  scratchDir: string;
};

/**
 * 路径准入。挡住三类会让 profile 静默失效或被注入的输入：非绝对路径、没解析过的路径、含引号或换行的路径。
 * profile 是 S-expression，一个未转义的引号就能改写规则语义，所以这里**拒绝**而不是转义——
 * 真实的工作区路径不会长这样，长这样就是出事了。
 */
function assertProfilePath(label: string, path: string): void {
  if (!path || !path.startsWith("/")) {
    throw new Error(`executor 沙箱：${label} 必须是绝对路径，收到 ${JSON.stringify(path)}`);
  }
  if (/["\\\n\r]/.test(path)) {
    throw new Error(`executor 沙箱：${label} 含引号或换行，拒绝写进 profile：${JSON.stringify(path)}`);
  }
  if (path !== "/" && path.endsWith("/")) {
    throw new Error(`executor 沙箱：${label} 不应以斜杠结尾（subpath 前缀语义会变），收到 ${JSON.stringify(path)}`);
  }
  if (path.split("/").includes("..") || path.split("/").includes(".")) {
    throw new Error(`executor 沙箱：${label} 必须是 realpath 解析后的路径，不能含 . 或 ..：${JSON.stringify(path)}`);
  }
  // /var、/tmp、/etc 在 macOS 上都是指向 /private/... 的符号链接；没解析过的路径写进 profile 会静默失效。
  if (/^\/(var|tmp|etc)(\/|$)/.test(path)) {
    throw new Error(
      `executor 沙箱：${label} 看起来未经 realpath 解析（${path}）——macOS 上 /var /tmp /etc 都是指向 /private 的符号链接，` +
        `直接写进 profile 规则会静默失效`,
    );
  }
}

function subpath(rule: string, path: string): string {
  return `(${rule} (subpath "${path}"))`;
}

/**
 * 生成一条命令用的 profile。Seatbelt 里**后面的规则覆盖前面的**，所以顺序是：
 * 先全局拒写 → 再放行该放的 → 最后把要挖掉的重新拒掉。
 */
export function buildSandboxProfile(input: SandboxInput): string {
  assertProfilePath("工作区根", input.workspaceRoot);
  assertProfilePath("scratch 目录", input.scratchDir);
  for (const path of input.nestedWorktrees) assertProfilePath("嵌套 worktree", path);
  for (const path of input.gitDirs) assertProfilePath("git 目录", path);

  const lines: string[] = [
    "(version 1)",
    ";; executor 工具沙箱（coflux plan 116）。档位=防失误，不是防敌手：Mach/XPC 与 Apple Events 未收口。",
    "(allow default)",
    "",
    ";; 网络：一条全拒。同时挡住 loopback TCP 与 unix socket（实测），于是沙箱里的工具进程无法回头",
    ";; 打 daemon 的 /agent 借 terminal.new 让不受约束的 daemon 代执行。模型调用在沙箱外的 runner 里，不受影响。",
    "(deny network*)",
    "",
    ";; 文件写：默认全拒，再逐项放行。",
    "(deny file-write*)",
  ];

  if (input.writable) {
    lines.push("", ";; 可写模式：只放行发起任务的那个工作区。", subpath("allow file-write*", input.workspaceRoot));
  } else {
    lines.push("", ";; 只读模式：工作区本身也不可写，executor 只能看与跑。");
  }

  lines.push(
    "",
    ";; 任务私有 scratch（TMPDIR 指向它）。不放行整个 /tmp——那里有别的任务和共享 socket。",
    subpath("allow file-write*", input.scratchDir),
    "",
    ";; shell 重定向需要的设备节点。",
    `(allow file-write* ${WRITABLE_DEVICES.map((device) => `(literal "${device}")`).join(" ")})`,
  );

  if (input.gitDirs.length > 0) {
    lines.push(
      "",
      ";; git 元数据只读（v1 不 commit）。挖在放行之后才生效——主工作区的 .git 就落在工作区根里面。",
      ";; 顺带堵掉 hooks、worktree 级 config、rebase sequencer 的 exec、submodule config 这串持久化执行入口。",
      ...input.gitDirs.map((path) => subpath("deny file-write*", path)),
    );
  }

  if (input.nestedWorktrees.length > 0) {
    lines.push(
      "",
      ";; 嵌套的其他已登记 worktree：别人的未合并工作，不能因为它恰好躺在本工作区目录下就变可写。",
      ...input.nestedWorktrees.map((path) => subpath("deny file-write*", path)),
    );
  }

  return `${lines.join("\n")}\n`;
}

/** 套 sandbox-exec 的完整 argv。命令原样作为 `-c` 的实参传给 shell，不做字符串拼接。 */
export function sandboxArgv(profilePath: string, shell: string, command: string): string[] {
  return ["/usr/bin/sandbox-exec", "-f", profilePath, shell, "-c", command];
}

/**
 * `git worktree list --porcelain` 的输出 → 除自己以外的 worktree 路径。
 * 只挑 `worktree ` 开头的行；其余（HEAD / branch / bare / detached）忽略。
 */
export function otherWorktreePaths(porcelain: string, selfRoot: string): string[] {
  return porcelain
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length).trim())
    .filter((path) => path.length > 0 && path !== selfRoot);
}
