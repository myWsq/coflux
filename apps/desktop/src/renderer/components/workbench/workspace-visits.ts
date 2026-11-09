/**
 * When each workspace was last on screen (plan 20261109-sidebar-current-section): the recency half
 * of the sidebar's 「当前」 section. A workspace's time is the moment the selection moved off it;
 * the selected workspace itself counts as "now" and is not read from here.
 *
 * Storage and key are arguments, never imports, for the reason `command-palette-recent.ts` gives:
 * `@/config` needs the desktop bridge at evaluation time and Node has no `localStorage`. The stored
 * value is a JSON object of workspace id → epoch milliseconds.
 */

export type WorkspaceVisitStore = {
  storage: Pick<Storage, "getItem" | "setItem">;
  key: string;
};

/** Workspace id → when it was last on screen (epoch ms). */
export type WorkspaceVisits = Readonly<Record<string, number>>;

/** How long a workspace counts as recently on screen; older visits are dropped on write. */
export const RECENT_VISIT_WINDOW_MS = 24 * 60 * 60 * 1000;

const EMPTY: WorkspaceVisits = Object.freeze({});

/**
 * Every failure mode — no value, unparsable JSON, something other than an object, throwing
 * storage — reads as "no visits"; entries whose time is not a finite number are skipped.
 */
export function readWorkspaceVisits(store: WorkspaceVisitStore): WorkspaceVisits {
  try {
    const raw = store.storage.getItem(store.key);
    if (!raw) return EMPTY;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return EMPTY;
    const visits: Record<string, number> = {};
    for (const [workspaceId, at] of Object.entries(parsed)) {
      if (workspaceId && typeof at === "number" && Number.isFinite(at)) visits[workspaceId] = at;
    }
    return visits;
  } catch {
    return EMPTY;
  }
}

/**
 * Stamps `workspaceId` with `at` and drops visits older than the window, so the record stays as
 * small as the set of workspaces that can still qualify. Returns the new record for the caller's
 * state; the write itself is best-effort and never throws.
 */
export function recordWorkspaceVisit(store: WorkspaceVisitStore, workspaceId: string, at: number): WorkspaceVisits {
  const current = readWorkspaceVisits(store);
  if (!workspaceId) return current;
  const next: Record<string, number> = {};
  for (const [id, time] of Object.entries(current)) {
    if (at - time <= RECENT_VISIT_WINDOW_MS) next[id] = time;
  }
  next[workspaceId] = at;
  try {
    store.storage.setItem(store.key, JSON.stringify(next));
  } catch {
    // A convenience list; failing to remember is not worth an error.
  }
  return next;
}
