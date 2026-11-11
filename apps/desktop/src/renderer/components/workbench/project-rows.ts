import type { WorkspaceActivity } from "@coflux/client";

/**
 * Sidebar project rows (plan 20261109-sidebar-current-section): which projects the user expanded,
 * persisted, and what a collapsed row summarises of its workspaces.
 *
 * Projects are collapsed unless their id is in the expanded set, so the first launch after this
 * change shows every project collapsed and a newly imported project appears collapsed. Storage
 * and key are arguments, never imports, for the reason `command-palette-recent.ts` gives. The
 * stored value is a JSON array of project ids.
 */

export type ExpandedProjectsStore = {
  storage: Pick<Storage, "getItem" | "setItem">;
  key: string;
};

const NONE: ReadonlySet<string> = new Set();

/** Every failure mode — no value, unparsable JSON, not an array, throwing storage — reads as "none expanded". */
export function readExpandedProjects(store: ExpandedProjectsStore): ReadonlySet<string> {
  try {
    const raw = store.storage.getItem(store.key);
    if (!raw) return NONE;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return NONE;
    return new Set(parsed.filter((value): value is string => typeof value === "string" && value.length > 0));
  } catch {
    return NONE;
  }
}

/**
 * Flips one project and writes the result, best-effort. Ids not in `knownProjectIds` (removed
 * projects) are dropped on the way, so the record never outgrows the project list. Returns the
 * new set for the caller's state.
 */
export function toggleExpandedProject(
  store: ExpandedProjectsStore,
  expanded: ReadonlySet<string>,
  projectId: string,
  knownProjectIds: ReadonlySet<string>,
): ReadonlySet<string> {
  const next = new Set([...expanded].filter((id) => knownProjectIds.has(id)));
  if (expanded.has(projectId)) next.delete(projectId);
  else next.add(projectId);
  try {
    store.storage.setItem(store.key, JSON.stringify([...next]));
  } catch {
    // Remembering which projects are open is a convenience; failing to is not worth an error.
  }
  return next;
}

/**
 * Makes sure one project is expanded, writing like the toggle. Already expanded means the exact
 * same set comes back and nothing is written — the caller (the sidebar's reveal-on-selection
 * effect, plan 20261111-sidebar-follow-selection) runs on every jump, and most jumps land in an
 * already-open project.
 */
export function ensureProjectExpanded(
  store: ExpandedProjectsStore,
  expanded: ReadonlySet<string>,
  projectId: string,
  knownProjectIds: ReadonlySet<string>,
): ReadonlySet<string> {
  if (expanded.has(projectId)) return expanded;
  return toggleExpandedProject(store, expanded, projectId, knownProjectIds);
}

type ActiveActivity = Exclude<WorkspaceActivity, { status: "idle" }>;

/** A collapsed row's trailing dots show the highest of these across its workspaces. */
const PRIORITY: readonly ActiveActivity["status"][] = ["approval", "question", "error", "active", "done"];

export type ProjectActivitySummary = {
  /** The highest-priority activity among the workspaces, or null when they are all idle. */
  top: ActiveActivity | null;
  /** Workspaces waiting for the user: `approval`, `question` or `error`. */
  attentionCount: number;
};

export function summarizeProjectActivity(activities: readonly WorkspaceActivity[]): ProjectActivitySummary {
  let top: ActiveActivity | null = null;
  let attentionCount = 0;
  for (const activity of activities) {
    if (activity.status === "idle") continue;
    if (activity.status === "approval" || activity.status === "question" || activity.status === "error") attentionCount += 1;
    if (top === null || PRIORITY.indexOf(activity.status) < PRIORITY.indexOf(top.status)) top = activity;
  }
  return { top, attentionCount };
}
