import { useEffect, useRef, useState } from "react";
import { AlertCircle, ChevronDown, ChevronRight, Diff, FileDiff, LoaderCircle } from "lucide-react";

import { Button } from "@astryxdesign/core/Button";
import type { CofluxClient, ExecResult } from "@/client/store";
import { highlightLines, resolveLang, type HighlightToken } from "@/components/workbench/diff-highlight";
import { parseUnifiedDiff, type DiffFile } from "@/components/workbench/parse-diff";
import { cn } from "@/lib/utils";

type ChangesViewProps = {
  workspaceId: string;
  /** 变更 tab 是否处于激活态：仅激活时才拉取/重拉（plan 025 决策，非激活不拉取）。 */
  active: boolean;
  client: CofluxClient;
  defaultBranch: string;
  additions: number;
  deletions: number;
};

/** exec 未致命失败但 exitCode 非 0（`--no-index` 恒如此）时仍视为成功，只有 relay 层失败才是错误。 */
function execFailed(result: ExecResult): boolean {
  return !result.ok;
}

async function resolveBase(client: CofluxClient, workspaceId: string, defaultBranch: string): Promise<string> {
  if (!defaultBranch.trim()) return "HEAD";
  const result = await client.execInWorkspace(workspaceId, "git", ["merge-base", defaultBranch, "HEAD"]);
  const sha = !execFailed(result) && result.exitCode === 0 ? result.stdout.trim() : "";
  return sha || "HEAD";
}

export function ChangesView({ workspaceId, active, client, defaultBranch, additions, deletions }: ChangesViewProps) {
  const [files, setFiles] = useState<DiffFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // 折叠态按路径保留：跨重拉不重置（本组件常驻挂载，随工作区切换隐藏而非卸载）。
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [highlighted, setHighlighted] = useState<Record<string, HighlightToken[][]>>({});

  const fetchedForRef = useRef<string | null>(null);
  const generationRef = useRef(0);

  async function load() {
    const generation = ++generationRef.current;
    setLoading(true);
    setError(null);
    try {
      const base = await resolveBase(client, workspaceId, defaultBranch);
      if (generation !== generationRef.current) return;

      const [trackedDiff, untrackedList] = await Promise.all([
        client.execInWorkspace(workspaceId, "git", ["-c", "core.quotepath=false", "diff", base]),
        client.execInWorkspace(workspaceId, "git", ["-c", "core.quotepath=false", "ls-files", "--others", "--exclude-standard"]),
      ]);
      if (generation !== generationRef.current) return;
      if (execFailed(trackedDiff) || trackedDiff.exitCode !== 0) {
        throw new Error(trackedDiff.error || trackedDiff.stderr.trim() || "获取变更失败");
      }
      if (execFailed(untrackedList) || untrackedList.exitCode !== 0) {
        throw new Error(untrackedList.error || untrackedList.stderr.trim() || "获取未跟踪文件列表失败");
      }

      const untrackedPaths = untrackedList.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);

      // ponytail: 分批（每批 8 并发）而非一次性 Promise.all，避免大量未跟踪文件同时打几十上百个 relay。
      const BATCH_SIZE = 8;
      const untrackedDiffs: ExecResult[] = [];
      for (let start = 0; start < untrackedPaths.length; start += BATCH_SIZE) {
        const batch = untrackedPaths.slice(start, start + BATCH_SIZE);
        const results = await Promise.all(
          batch.map((path) =>
            client.execInWorkspace(workspaceId, "git", ["-c", "core.quotepath=false", "diff", "--no-index", "--", "/dev/null", path]),
          ),
        );
        if (generation !== generationRef.current) return;
        untrackedDiffs.push(...results);
      }

      const trackedFiles = parseUnifiedDiff(trackedDiff.stdout);
      // `--no-index` 有差异时 exit code 恒为 1（正常成功，非错误，见 plan 025 landmine）；
      // 只有 relay 层失败（ok:false）才跳过该文件。
      const untrackedFiles = untrackedDiffs
        .filter((result) => !execFailed(result))
        .flatMap((result) => parseUnifiedDiff(result.stdout));

      setFiles([...trackedFiles, ...untrackedFiles]);
      fetchedForRef.current = `${additions}:${deletions}`;
    } catch (err) {
      if (generation !== generationRef.current) return;
      setError(err instanceof Error ? err.message : "获取变更失败");
    } finally {
      if (generation === generationRef.current) setLoading(false);
    }
  }

  useEffect(() => {
    if (!active) return;
    const signature = `${additions}:${deletions}`;
    if (fetchedForRef.current === signature) return;
    if (additions === 0 && deletions === 0) {
      fetchedForRef.current = signature;
      setFiles([]);
      setError(null);
      return;
    }
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, additions, deletions]);

  // 逐文件异步高亮：整份 hunks 拼接成一份 code 一次性 tokenize，保留跨行语法上下文。
  useEffect(() => {
    if (!files) return;
    const generation = generationRef.current;
    setHighlighted({});
    for (const file of files) {
      if (file.binary) continue;
      const allLines = file.hunks.flatMap((h) => h.lines);
      const code = allLines.map((l) => l.content).join("\n");
      const lang = resolveLang(file.path);
      void highlightLines(code, lang).then((tokens) => {
        if (generation !== generationRef.current) return;
        setHighlighted((prev) => ({ ...prev, [file.path]: tokens }));
      });
    }
  }, [files]);

  function toggleCollapse(path: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
        <AlertCircle className="size-6 text-destructive" />
        <p className="max-w-sm text-sm text-muted-foreground">{error}</p>
        <Button label="重试" variant="secondary" size="sm" isLoading={loading} onClick={() => void load()} />
      </div>
    );
  }

  if (files === null) {
    return (
      <div className="flex h-full items-center justify-center">
        <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (files.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
        <Diff className="size-6 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">这个工作区还没有变更</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="sticky top-0 z-10 flex shrink-0 items-center gap-3 border-b border-border bg-background px-4 py-2 text-xs text-muted-foreground">
        <span>{files.length} 个文件</span>
        <span className="font-mono tabular-nums">
          <span className="text-success">+{additions}</span> <span className="text-destructive">−{deletions}</span>
        </span>
        {loading ? <LoaderCircle className="size-3 animate-spin" /> : null}
      </div>
      <div className="flex flex-col gap-3 p-4">
        {files.map((file) => {
          const isCollapsed = collapsed.has(file.path);
          const tokens = highlighted[file.path];
          let lineIndex = 0;
          return (
            <div key={file.path} className="overflow-hidden rounded-md border border-border bg-card">
              <button
                className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent/40"
                onClick={() => toggleCollapse(file.path)}
              >
                {isCollapsed ? (
                  <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                )}
                <FileDiff className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate font-mono text-xs">
                  {file.path}
                  {file.status === "renamed" && file.renamedFrom ? (
                    <span className="ml-1.5 text-muted-foreground">← {file.renamedFrom}</span>
                  ) : null}
                </span>
                {file.binary ? (
                  <span className="shrink-0 text-2xs text-muted-foreground">二进制文件</span>
                ) : (
                  <span className="shrink-0 whitespace-nowrap font-mono text-2xs tabular-nums">
                    <span className="text-success">+{file.additions}</span>{" "}
                    <span className="text-destructive">−{file.deletions}</span>
                  </span>
                )}
              </button>
              {!isCollapsed && !file.binary && file.status === "renamed" && file.hunks.length === 0 ? (
                <div className="border-t border-border px-3 py-2 text-2xs text-muted-foreground">
                  重命名自 {file.renamedFrom}
                </div>
              ) : null}
              {!isCollapsed && !file.binary && file.hunks.length > 0 ? (
                <div className="overflow-x-auto border-t border-border font-mono text-xs leading-5">
                  {file.hunks.map((hunk, hunkIndex) => (
                    <div key={hunkIndex}>
                      <div className="bg-muted/40 px-3 py-1 text-2xs text-muted-foreground">{hunk.header}</div>
                      {hunk.lines.map((line, lineInHunkIndex) => {
                        const tokenLine = tokens?.[lineIndex];
                        lineIndex++;
                        return (
                          <div
                            key={lineInHunkIndex}
                            className={cn(
                              "flex px-3",
                              line.type === "add" && "bg-success/10",
                              line.type === "del" && "bg-destructive/10",
                            )}
                          >
                            <span
                              className={cn(
                                "mr-2 w-3 shrink-0 select-none",
                                line.type === "add" && "text-success",
                                line.type === "del" && "text-destructive",
                              )}
                            >
                              {line.type === "add" ? "+" : line.type === "del" ? "-" : " "}
                            </span>
                            <span className="whitespace-pre">
                              {tokenLine
                                ? tokenLine.map((token, tokenIndex) => (
                                    <span key={tokenIndex} style={token.color ? { color: token.color } : undefined}>
                                      {token.content}
                                    </span>
                                  ))
                                : line.content || " "}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
