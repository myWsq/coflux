/**
 * executor 结构化工具的路径守卫（plan 116 M3）。
 *
 * 为什么需要它：bash 的每条命令都套了 `sandbox-exec`，有内核兜底；但 pi 的结构化文件工具
 * （read / edit / write / ls / grep / find）是在 runner 的 utilityProcess **里**直接调 fs 的，
 * 那个进程不在 Seatbelt 里（utilityProcess 由 Electron fork，命令行前面塞不进 sandbox-exec）。
 * 所以这一层必须由我们自己在 JS 里查。
 *
 * 挂载点是 pi 的内联扩展 `pi.on("tool_call")`：`noExtensions` 关掉的是**磁盘扩展发现**
 * （工作区里放一个 `.pi/` 就能执行任意代码，必须关），内联扩展不受影响，是官方留的进程内钩子。
 *
 * 判定逻辑放在这里、与 pi 解耦，是为了能穷举测试——路径逃逸这种事靠读代码是看不出来的。
 *
 * 注意这层与 Seatbelt 的关系是**互补不是冗余**：它挡住结构化工具，Seatbelt 挡住 bash 派生的一切。
 * 两层都要有，缺一层就有一整类越界没人管。
 */

/** 只要带路径入参的工具都要过这一关；表驱动，新工具漏配时 `unknownToolPolicy` 兜底。 */
const PATH_FIELDS: Record<string, readonly string[]> = {
  read: ["path", "filePath", "file"],
  write: ["path", "filePath", "file"],
  edit: ["path", "filePath", "file"],
  ls: ["path", "dir", "directory"],
  grep: ["path", "dir", "directory"],
  find: ["path", "dir", "directory"],
};

/** 写类工具：只读模式下一律拒，连路径都不用看。 */
const MUTATING_TOOLS = new Set(["write", "edit"]);

export type GuardInput = {
  toolName: string;
  /** 工具的入参对象；只读取，不改写 */
  input: unknown;
  /** realpath 解析后的工作区根 */
  workspaceRoot: string;
  /** false = 只读模式 */
  writable: boolean;
};

export type GuardVerdict = { block: true; reason: string } | null;

/**
 * 路径是否落在工作区内。
 *
 * 三件必须做对的事：
 *  1. 用**分段比较**而不是字符串前缀——`/repo-evil` 不能因为以 `/repo` 开头就算在 `/repo` 里。
 *  2. `..` 先归一化再比，否则 `/repo/../etc/passwd` 会蒙混过关。
 *  3. 根自身算在内。
 *
 * 不解析符号链接：这里是纯函数，拿不到文件系统。调用方传进来的 root 已经是 realpath 解析过的，
 * 而目标路径的符号链接逃逸由 Seatbelt 那层兜底（它按内核解析后的真实路径判）。
 */
export function isInsideWorkspace(workspaceRoot: string, candidate: string): boolean {
  if (!candidate.startsWith("/")) return false; // 相对路径无从判断，一律不放行
  const root = normalizeSegments(workspaceRoot);
  const target = normalizeSegments(candidate);
  if (target.length < root.length) return false;
  return root.every((segment, index) => target[index] === segment);
}

function normalizeSegments(path: string): string[] {
  const out: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out;
}

function collectPaths(toolName: string, input: unknown): string[] {
  if (!input || typeof input !== "object") return [];
  const fields = PATH_FIELDS[toolName];
  if (!fields) return [];
  const record = input as Record<string, unknown>;
  const paths: string[] = [];
  for (const field of fields) {
    const value = record[field];
    if (typeof value === "string" && value.length > 0) paths.push(value);
  }
  return paths;
}

/**
 * 判一次工具调用。返回 null = 放行。
 *
 * 相对路径一律拒而不是拼到 root 上再判：pi 的工具各自解释相对路径的方式不保证一致，
 * 我们这边猜错一次就是一个洞。让模型给绝对路径，代价只是多一轮，收益是这层判定没有歧义。
 */
export function guardToolCall({ toolName, input, workspaceRoot, writable }: GuardInput): GuardVerdict {
  if (!writable && MUTATING_TOOLS.has(toolName)) {
    return {
      block: true,
      reason: `这是只读模式的 executor 任务，不能用 ${toolName} 改文件。只做调查与报告，把结论写进最终回复。`,
    };
  }

  for (const path of collectPaths(toolName, input)) {
    if (!path.startsWith("/")) {
      return {
        block: true,
        reason: `${toolName} 的路径必须是绝对路径（收到 ${path}）；工作区根是 ${workspaceRoot}`,
      };
    }
    if (!isInsideWorkspace(workspaceRoot, path)) {
      return {
        block: true,
        reason: `${path} 在工作区外。这个 executor 任务被限制在 ${workspaceRoot} 之内，工作区外的文件读不到也改不了。`,
      };
    }
  }

  return null;
}
