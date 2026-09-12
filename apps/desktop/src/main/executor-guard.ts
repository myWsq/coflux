/**
 * The path guard for the executor's structured tools.
 *
 * Why it exists: every bash command is wrapped in `sandbox-exec` with the kernel as a backstop, but
 * pi's structured file tools (read / edit / write / ls / grep / find) call fs directly **inside** the
 * runner's utilityProcess, and that process is not in Seatbelt (Electron forks a utilityProcess;
 * there is no command line to prefix with sandbox-exec). So this layer has to be checked by us, in JS.
 *
 * It hangs off pi's inline extension hook, `pi.on("tool_call")`. What `noExtensions` disables is
 * **on-disk extension discovery** (dropping a `.pi/` directory into a workspace would execute
 * arbitrary code, so it must be off); inline extensions are unaffected and are the sanctioned
 * in-process hook.
 *
 * The decision logic lives here, decoupled from pi, so it can be tested exhaustively — path escapes
 * are not the kind of thing anyone spots by reading code.
 *
 * This layer and Seatbelt are **complementary, not redundant**: this one covers the structured tools,
 * Seatbelt covers everything bash spawns. Both are needed; drop either and a whole class of
 * out-of-bounds access goes unwatched.
 */

/** Every tool taking a path argument passes through here. Table-driven; a new tool missing from the
 * table simply contributes no path fields. */
const PATH_FIELDS: Record<string, readonly string[]> = {
  read: ["path", "filePath", "file"],
  write: ["path", "filePath", "file"],
  edit: ["path", "filePath", "file"],
  ls: ["path", "dir", "directory"],
  grep: ["path", "dir", "directory"],
  find: ["path", "dir", "directory"],
};

/** Mutating tools: always refused in read-only mode, without even looking at the path. */
const MUTATING_TOOLS = new Set(["write", "edit"]);

export type GuardInput = {
  toolName: string;
  /** The tool's argument object; read only, never rewritten. */
  input: unknown;
  /** The workspace root, realpath-resolved. */
  workspaceRoot: string;
  /** false = read-only mode. */
  writable: boolean;
};

export type GuardVerdict = { block: true; reason: string } | null;

/**
 * Whether a path falls inside the workspace.
 *
 * Three things this has to get right:
 *  1. Compare **segment by segment**, not by string prefix — `/repo-evil` must not count as inside
 *     `/repo` merely because it starts with it.
 *  2. Normalize `..` before comparing, or `/repo/../etc/passwd` slips through.
 *  3. The root itself counts as inside.
 *
 * Symlinks are not resolved: this is a pure function with no filesystem access. The caller passes a
 * root that is already realpath-resolved, and symlink escapes in the target path are caught by the
 * Seatbelt layer, which judges the kernel-resolved real path.
 */
export function isInsideWorkspace(workspaceRoot: string, candidate: string): boolean {
  if (!candidate.startsWith("/")) return false; // A relative path cannot be judged here, so never allow it.
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
 * Judge one tool call. Returning null means "allowed".
 *
 * Relative paths are refused outright rather than joined onto the root first: pi's tools are not
 * guaranteed to interpret relative paths the same way, and guessing wrong once is a hole. Making the
 * model supply absolute paths costs one extra round trip and makes this check unambiguous.
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
