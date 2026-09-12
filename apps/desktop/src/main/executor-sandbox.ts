/**
 * Seatbelt profile generation for the executor's tool processes.
 *
 * pi explicitly ships without a sandbox (its stated position is "run a container, or build your own
 * confirmation flow as an extension"), so "it can only change this workspace" is ours to deliver.
 * Structured file tools can check paths in JS, but `bash` is wide open — it can run anything. Every
 * bash command is therefore wrapped in `/usr/bin/sandbox-exec` and the kernel is the backstop.
 *
 * **The tier is "against mistakes", not "against adversaries"**: subtraction on top of an
 * `(allow default)` baseline stops out-of-bounds writes and a whole class of local proxy execution,
 * but Mach/XPC and Apple Events stay open. Closing those means switching to deny-by-default and
 * allowing system services back one by one, which is its own project. The threat model is "a
 * confused agent takes a wrong turn", not a hostile attacker — Claude Code on the user's own
 * machine runs with no sandbox at all. Any copy calling this full isolation is wrong.
 *
 * ## Three hard constraints, each measured (verified on macOS 26 / Darwin 27; do not change on a hunch)
 *
 * 1. **Paths must be realpath-resolved.** Writing `/var/...` into the profile makes the rule behave
 *    as if it were absent (`/var` is a symlink to `/private/var`), and it **raises no error** — an
 *    allow rule that silently does nothing, which can cost half a day. This module therefore refuses
 *    any path that looks unresolved.
 * 2. **Do not use `-D` parameters with `(param "X")`**; measured not to work. Always interpolate the
 *    literal into the profile.
 * 3. **A single `(deny network*)` blocks loopback TCP and unix sockets alike** (measured), so there
 *    is no need to enumerate the supervisor UDS, the Docker socket, or the SSH agent. The converse
 *    also holds: it **cannot** be narrowed to loopback only, which would leave UDS open.
 *
 * ## Why tool processes never get the network
 *
 * The daemon's loopback `/agent` endpoint identifies its caller by a pid the request body reports
 * about itself (`crates/worker/src/hook.rs`), and checks "this pid belongs to some session's process
 * tree" rather than "this connection really came from it". So any tool process inside the sandbox
 * that can reach loopback can use `terminal.new` to have the **entirely unsandboxed daemon** run
 * arbitrary commands for it — the sandbox would be pointless. Model calls happen in the runner,
 * which is not sandboxed, so cutting the tool processes' network does not affect the executor's own
 * work. The cost is that it cannot run dependency-fetching commands like `npm install`; that limit
 * is documented in the SKILL so the initiating agent knows about it.
 */

/** Shell redirection writes to /dev/null; without an allowance `cmd >/dev/null` fails outright. */
const WRITABLE_DEVICES = ["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty", "/dev/dtracehelper"] as const;

export type SandboxInput = {
  /** The workspace root, realpath-resolved; also the cwd in read-only mode. */
  workspaceRoot: string;
  /** true = writable mode (the workspace may be written); false = read-only (not even the workspace). */
  writable: boolean;
  /**
   * Other registered worktrees that must be carved out, realpath-resolved.
   * Reality in this repository: `git worktree list` shows worktrees nested under the main
   * workspace's `.claude/worktrees/`, sometimes two levels deep. Without the carve-out, an executor
   * running in the main workspace would also gain write access to someone else's unmerged work.
   */
  nestedWorktrees: readonly string[];
  /**
   * The git directories, realpath-resolved: this worktree's gitdir and the shared common dir.
   * v1 keeps them **read-only throughout** — the executor does not commit; the initiating agent
   * commits the changes. That also sidesteps the whole chain of persisted execution entry points:
   * worktree-level config, `core.hooksPath`, the rebase sequencer's `exec`, submodule config.
   */
  gitDirs: readonly string[];
  /** The task's private scratch directory (realpath). Given instead of allowing all of /tmp, which
   * holds other tasks and shared sockets. */
  scratchDir: string;
};

/**
 * Path admission. Blocks the three kinds of input that would silently void the profile or inject
 * into it: non-absolute paths, unresolved paths, and paths containing quotes or newlines. The
 * profile is an S-expression, where one unescaped quote can rewrite a rule's meaning, so this
 * **refuses** rather than escapes — a real workspace path never looks like that, and one that does
 * means something is already wrong.
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
  // On macOS /var, /tmp and /etc are all symlinks into /private/...; an unresolved path written into
  // the profile silently does nothing.
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
 * Build the profile for one command. In Seatbelt **later rules override earlier ones**, so the order
 * is: deny all writes globally -> allow what should be allowed -> deny the carve-outs again.
 */
export function buildSandboxProfile(input: SandboxInput): string {
  assertProfilePath("工作区根", input.workspaceRoot);
  assertProfilePath("scratch 目录", input.scratchDir);
  for (const path of input.nestedWorktrees) assertProfilePath("嵌套 worktree", path);
  for (const path of input.gitDirs) assertProfilePath("git 目录", path);

  const lines: string[] = [
    "(version 1)",
    ";; coflux executor tool sandbox. Tier = against mistakes, not adversaries: Mach/XPC and Apple Events are not closed off.",
    "(allow default)",
    "",
    ";; Network: one blanket denial. It blocks loopback TCP and unix sockets alike (measured), so a tool",
    ";; process cannot call back into the daemon's /agent and have the unconstrained daemon run commands",
    ";; for it via terminal.new. Model calls happen in the runner, outside the sandbox, and are unaffected.",
    "(deny network*)",
    "",
    ";; File writes: deny everything by default, then allow back item by item.",
    "(deny file-write*)",
  ];

  if (input.writable) {
    lines.push("", ";; Writable mode: allow only the workspace that started the task.", subpath("allow file-write*", input.workspaceRoot));
  } else {
    lines.push("", ";; Read-only mode: even the workspace is not writable; the executor may only look and run.");
  }

  lines.push(
    "",
    ";; The task's private scratch (TMPDIR points at it). Not all of /tmp, which holds other tasks and shared sockets.",
    subpath("allow file-write*", input.scratchDir),
    "",
    ";; The device nodes shell redirection needs.",
    `(allow file-write* ${WRITABLE_DEVICES.map((device) => `(literal "${device}")`).join(" ")})`,
  );

  if (input.gitDirs.length > 0) {
    lines.push(
      "",
      ";; Git metadata is read-only (v1 does not commit). The carve-out only works after the allow,",
      ";; because the main workspace's .git sits inside the workspace root. It also closes the chain of",
      ";; persisted execution entry points: hooks, worktree-level config, the rebase sequencer's exec,",
      ";; and submodule config.",
      ...input.gitDirs.map((path) => subpath("deny file-write*", path)),
    );
  }

  if (input.nestedWorktrees.length > 0) {
    lines.push(
      "",
      ";; Other registered worktrees nested inside: someone else's unmerged work must not become",
      ";; writable just because it happens to live under this workspace's directory.",
      ...input.nestedWorktrees.map((path) => subpath("deny file-write*", path)),
    );
  }

  return `${lines.join("\n")}\n`;
}

/** The full argv for wrapping in sandbox-exec. The command is passed verbatim as the shell's `-c`
 * argument; nothing is concatenated into a string. */
export function sandboxArgv(profilePath: string, shell: string, command: string): string[] {
  return ["/usr/bin/sandbox-exec", "-f", profilePath, shell, "-c", command];
}

/**
 * `git worktree list --porcelain` output -> every worktree path except our own.
 * Only lines starting with `worktree ` are taken; the rest (HEAD / branch / bare / detached) are ignored.
 */
export function otherWorktreePaths(porcelain: string, selfRoot: string): string[] {
  return porcelain
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length).trim())
    .filter((path) => path.length > 0 && path !== selfRoot);
}
