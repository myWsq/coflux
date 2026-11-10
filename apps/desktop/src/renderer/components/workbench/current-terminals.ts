import { isDirWorkspace, isWorkspaceArchived, type SessionAgentState, type SessionMetadataState, type WorkspaceActivity } from "@coflux/client";
import { TaskStatus, type DaemonInfo, type Project, type Task, type Workspace } from "@coflux/protocol";

import { sidebarTree } from "./workspace-order";

/**
 * The sidebar's 「当前」 section (plan 20261110-sidebar-current-terminals): the live agent terminals,
 * derived — never curated. A terminal is a member while its task runs and its agent reports a known
 * state through OSC 7501. Rows are listed in tree order (project workspaces as the tree lists them,
 * then directory workspaces by device), and within a workspace by when the terminal was created:
 * never by status or time, so rows do not swap places as agents change state.
 */

export type CurrentTerminalRow = {
  task: Task;
  workspace: Workspace;
  /** Null for a directory workspace (no repo). */
  project: Project | null;
  daemon: DaemonInfo;
  /** The agent id as the presence entry reports it (`claude`, `codex`, ...). */
  agent: string;
  /** The OSC title, else the task's own title, else 「终端」. */
  title: string;
  /** This terminal's own activity; never `idle`. */
  activity: Exclude<WorkspaceActivity, { status: "idle" }>;
};

export type CurrentTerminalsInput = {
  /** Every project in the store, archived ones included (they decide whether a workspace is archived). */
  projects: readonly Project[];
  workspaces: readonly Workspace[];
  daemons: readonly DaemonInfo[];
  tasks: readonly Task[];
  sessionAgents: Record<string, SessionAgentState>;
  /** Session id → OSC title (the store's `sessionMetadata` titles); a missing or empty one falls back. */
  titles: Readonly<Record<string, string>>;
};

/** A presence entry's activity, or null when its state is not one a member reports. An old worker's `waiting` is shown as done. */
function terminalActivity(entry: SessionAgentState, taskId: string): CurrentTerminalRow["activity"] | null {
  if (entry.state === "approval" || entry.state === "question" || entry.state === "error") {
    return { status: entry.state, agent: entry.agent, message: entry.message || undefined, taskId };
  }
  if (entry.state === "active") return { status: "active", agent: entry.agent };
  if (entry.state === "done" || entry.state === "waiting") return { status: "done", agent: entry.agent };
  return null;
}

function byCreation(left: { createdAt: number; id: string }, right: { createdAt: number; id: string }): number {
  if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

export function currentTerminals(input: CurrentTerminalsInput): CurrentTerminalRow[] {
  // Workspaces in list order, each with its project (null for a directory workspace).
  const ordered: { workspace: Workspace; project: Project | null }[] = [];
  for (const { project, workspaces } of sidebarTree(input.projects, input.workspaces)) {
    for (const workspace of workspaces) {
      if (isDirWorkspace(workspace) || isWorkspaceArchived(workspace, input.projects)) continue;
      ordered.push({ workspace, project });
    }
  }
  for (const daemon of input.daemons) {
    const directories = input.workspaces.filter((workspace) => isDirWorkspace(workspace) && workspace.daemonId === daemon.daemonId).sort(byCreation);
    for (const workspace of directories) ordered.push({ workspace, project: null });
  }

  const rows: CurrentTerminalRow[] = [];
  for (const { workspace, project } of ordered) {
    const daemon = input.daemons.find((item) => item.daemonId === workspace.daemonId);
    if (!daemon?.online) continue;
    const tasks = input.tasks.filter((task) => task.workspaceId === workspace.id && task.status === TaskStatus.RUNNING && task.sessionId).sort(byCreation);
    for (const task of tasks) {
      const entry = input.sessionAgents[task.sessionId!];
      if (entry === undefined) continue;
      const activity = terminalActivity(entry, task.id);
      if (activity === null) continue;
      const title = input.titles[task.sessionId!] || task.title || "终端";
      rows.push({ task, workspace, project, daemon, agent: entry.agent, title, activity });
    }
  }
  return rows;
}

/**
 * The OSC titles of the sessions that may be members: running tasks whose session has a presence
 * entry. For a store selector compared shallowly, so checkpoint churn on other sessions does not
 * re-render the reader.
 */
export function candidateSessionTitles(
  tasks: readonly Task[],
  sessionAgents: Record<string, SessionAgentState>,
  sessionMetadata: Record<string, SessionMetadataState>,
): Record<string, string> {
  const titles: Record<string, string> = {};
  for (const task of tasks) {
    if (task.status !== TaskStatus.RUNNING || !task.sessionId || sessionAgents[task.sessionId] === undefined) continue;
    const title = sessionMetadata[task.sessionId]?.title;
    if (title) titles[task.sessionId] = title;
  }
  return titles;
}

/** A row whose agent waits for the user: `approval`, `question` or `error` (待处理). */
export function needsAttention(row: CurrentTerminalRow): boolean {
  return row.activity.status === "approval" || row.activity.status === "question" || row.activity.status === "error";
}

/**
 * ⌘⇧A 「下一个待处理」: the first 待处理 row after the on-screen terminal in list order, wrapping
 * around; the on-screen terminal itself only when it is the sole one. With no terminal on screen
 * (or one not in the list) the first 待处理 row. Null when no row needs the user.
 */
export function nextAttentionRow(rows: readonly CurrentTerminalRow[], onScreenTaskId: string | null): CurrentTerminalRow | null {
  const start = onScreenTaskId === null ? -1 : rows.findIndex((row) => row.task.id === onScreenTaskId);
  for (let step = 1; step <= rows.length; step += 1) {
    const row = rows[(start + step) % rows.length];
    if (needsAttention(row)) return row;
  }
  return null;
}
