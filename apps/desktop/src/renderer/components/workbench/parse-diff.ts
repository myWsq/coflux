export type DiffLineType = "add" | "del" | "context";

export type DiffLine = {
  type: DiffLineType;
  content: string;
  oldLine?: number;
  newLine?: number;
};

export type DiffHunk = {
  header: string;
  lines: DiffLine[];
};

export type DiffFile = {
  path: string;
  status: "added" | "deleted" | "modified" | "renamed";
  /** status === "renamed" 时的原路径。 */
  renamedFrom?: string;
  binary: boolean;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
};

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** "--- a/foo" / "+++ b/foo" / "--- /dev/null" → "foo" / "" */
function stripPathPrefix(line: string): string {
  const rest = line.slice(4);
  if (rest === "/dev/null") return "";
  return rest.replace(/^[ab]\//, "");
}

/**
 * 解析 `git diff` 的 unified diff 文本（可含多文件，`diff --git` 分隔）。
 * 与 untracked 文件的单文件 `git diff --no-index` 输出共用（格式一致，见 plan 025 landmine）。
 * ponytail: 不处理路径含 " b/" 字面量等极端转义边界，读取型视图，非严格 diff 引擎。
 */
export function parseUnifiedDiff(text: string): DiffFile[] {
  if (!text.trim()) return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop(); // 尾随换行产生的空段

  const files: DiffFile[] = [];
  const HEADER_RE = /^diff --git a\/(.+) b\/(.+)$/;
  let i = 0;
  while (i < lines.length) {
    const headerMatch = HEADER_RE.exec(lines[i] ?? "");
    if (!headerMatch) {
      i++;
      continue;
    }
    i++; // 跳过 "diff --git a/x b/y" 本身

    // binary diff 没有 "--- "/"+++ " 行，路径只能来自 header（rename 时 a/ b/ 不同名，取 b 侧）。
    let oldPath = headerMatch[2]!;
    let newPath = headerMatch[2]!;
    let status: DiffFile["status"] = "modified";
    let renamedFrom: string | undefined;
    let binary = false;
    const hunks: DiffHunk[] = [];

    while (i < lines.length && !lines[i]!.startsWith("diff --git ")) {
      const line = lines[i]!;
      if (line.startsWith("new file mode")) {
        status = "added";
        i++;
      } else if (line.startsWith("deleted file mode")) {
        status = "deleted";
        i++;
      } else if (line.startsWith("rename from ")) {
        status = "renamed";
        renamedFrom = line.slice("rename from ".length);
        i++;
      } else if (line.startsWith("rename to ")) {
        newPath = line.slice("rename to ".length);
        i++;
      } else if (line.startsWith("Binary files ") && line.endsWith(" differ")) {
        binary = true;
        i++;
      } else if (line.startsWith("--- ")) {
        oldPath = stripPathPrefix(line);
        i++;
      } else if (line.startsWith("+++ ")) {
        newPath = stripPathPrefix(line);
        i++;
      } else if (line.startsWith("@@ ")) {
        const header = line;
        const match = HUNK_HEADER_RE.exec(header);
        let oldLine = match ? Number(match[1]) : undefined;
        let newLine = match ? Number(match[2]) : undefined;
        i++;
        const hunkLines: DiffLine[] = [];
        while (i < lines.length && !lines[i]!.startsWith("@@ ") && !lines[i]!.startsWith("diff --git ")) {
          const l = lines[i]!;
          if (l.startsWith("\\")) {
            i++; // "\ No newline at end of file"
            continue;
          }
          if (l.startsWith("+")) {
            hunkLines.push({ type: "add", content: l.slice(1), newLine });
            if (newLine !== undefined) newLine++;
          } else if (l.startsWith("-")) {
            hunkLines.push({ type: "del", content: l.slice(1), oldLine });
            if (oldLine !== undefined) oldLine++;
          } else {
            hunkLines.push({ type: "context", content: l.slice(1), oldLine, newLine });
            if (oldLine !== undefined) oldLine++;
            if (newLine !== undefined) newLine++;
          }
          i++;
        }
        hunks.push({ header, lines: hunkLines });
      } else {
        i++;
      }
    }

    const path = newPath || oldPath;
    if (!path) continue;
    const additions = hunks.reduce((n, h) => n + h.lines.filter((l) => l.type === "add").length, 0);
    const deletions = hunks.reduce((n, h) => n + h.lines.filter((l) => l.type === "del").length, 0);
    files.push({ path, status, renamedFrom, binary, additions, deletions, hunks });
  }
  return files;
}
