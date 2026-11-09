import { isDirWorkspace, isWorkspaceArchived, workspaceActivity, type SessionAgentState, type WorkspaceActivity } from "@coflux/client";
import type { DaemonInfo, Project, Task, Workspace } from "@coflux/protocol";

import { sidebarTree } from "./workspace-order";
import { RECENT_VISIT_WINDOW_MS, type WorkspaceVisits } from "./workspace-visits";

/**
 * The sidebar's 「当前」 section (plan 20261109-sidebar-current-section): what the user is working
 * on, derived — never curated. A workspace is a member when an agent in it reports anything but
 * idle, or when it was on screen within the last 24 hours (at most `RECENT_SLOTS` of those).
 * Rows are listed in tree order and never sorted by activity or recency: they do not swap places
 * as agents change state, only membership changes.
 */

/** How many workspaces may be members by recency alone. */
export const RECENT_SLOTS = 5;

export type CurrentWorkspaceRow = {
  workspace: Workspace;
  project: Project;
  activity: WorkspaceActivity;
};

export type CurrentWorkspacesInput = {
  /** Every project in the store, archived ones included (they decide whether a workspace is archived). */
  projects: readonly Project[];
  workspaces: readonly Workspace[];
  daemons: readonly Pick<DaemonInfo, "daemonId" | "online">[];
  tasks: readonly Task[];
  sessionAgents: Record<string, SessionAgentState>;
  visits: WorkspaceVisits;
  /** The selected workspace counts as on screen now, whatever its stored time. */
  selectedWorkspaceId: string | null;
  now: number;
};

export function currentWorkspaces(input: CurrentWorkspacesInput): CurrentWorkspaceRow[] {
  const candidates: CurrentWorkspaceRow[] = [];
  for (const { project, workspaces } of sidebarTree(input.projects, input.workspaces)) {
    const daemon = input.daemons.find((item) => item.daemonId === project.daemonId);
    for (const workspace of workspaces) {
      if (isDirWorkspace(workspace) || isWorkspaceArchived(workspace, input.projects)) continue;
      candidates.push({ workspace, project, activity: workspaceActivity(workspace.id, daemon?.online ?? false, input.tasks, input.sessionAgents) });
    }
  }

  const members = new Set<string>();
  const recent: { id: string; at: number; selected: boolean }[] = [];
  for (const { workspace, activity } of candidates) {
    if (activity.status !== "idle") {
      members.add(workspace.id);
      continue;
    }
    const selected = workspace.id === input.selectedWorkspaceId;
    const at = selected ? input.now : input.visits[workspace.id];
    if (at !== undefined && input.now - at <= RECENT_VISIT_WINDOW_MS) recent.push({ id: workspace.id, at, selected });
  }
  // The selected workspace ranks first, ahead of a visit stamped after `now` (the caller's clock
  // may lag a just-recorded leave): it is always a member. Ties keep tree order (stable sort).
  recent.sort((left, right) => (left.selected !== right.selected ? (left.selected ? -1 : 1) : right.at - left.at));
  for (const entry of recent.slice(0, RECENT_SLOTS)) members.add(entry.id);

  return candidates.filter((row) => members.has(row.workspace.id));
}

/** A row whose agent waits for the user: `approval`, `question` or `error` (待处理). */
export function needsAttention(row: CurrentWorkspaceRow): boolean {
  return row.activity.status === "approval" || row.activity.status === "question" || row.activity.status === "error";
}

/**
 * ⌘⇧A 「下一个待处理」: the first 待处理 row after the selected workspace in list order, wrapping
 * around; the selected workspace itself only when it is the sole one. With nothing selected (or
 * the selection not in the list) the first 待处理 row. Null when no row needs the user.
 */
export function nextAttentionRow(rows: readonly CurrentWorkspaceRow[], selectedWorkspaceId: string | null): CurrentWorkspaceRow | null {
  const start = rows.findIndex((row) => row.workspace.id === selectedWorkspaceId);
  for (let step = 1; step <= rows.length; step += 1) {
    const row = rows[(start + step) % rows.length];
    if (needsAttention(row)) return row;
  }
  return null;
}
