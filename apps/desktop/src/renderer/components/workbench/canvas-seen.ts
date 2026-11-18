/**
 * What this desktop has already shown of each workspace's canvases (plan 20261112-agent-canvas).
 *
 * An agent shows a canvas with `coflux canvas show`; the desktop opens it in a background tab and
 * marks it unread. "New to this desktop" is decided here, from two local facts:
 *
 * - per canvas, the `updatedAt` this desktop last acted on — a canvas shown again has a later one;
 * - `since`, when this record was first created — a canvas this desktop has never acted on counts
 *   as new only if it was shown after that, so a desktop that meets an account's existing canvases
 *   for the first time does not open all of them.
 *
 * `updatedAt` is the device's clock and `since` this machine's; they only meet for a canvas never
 * seen before, where a skew of seconds at worst opens one old canvas once or leaves one new canvas
 * to be opened from the ⌘T list. Every later comparison is device time against device time.
 *
 * Per workspace it also keeps the summary revision last processed, so a restart does not refetch
 * lists that have not changed. Local to this machine and scoped by server address like the tab
 * records — never synced to the account.
 *
 * Pure: storage is injected, as for the layouts and the tab records.
 */

export type CanvasSeenWorkspace = {
  /** The canvas summary revision whose list was last processed. */
  revision: number;
  /** Canvas id → the `updatedAt` last acted on. */
  canvases: Readonly<Record<string, number>>;
};

export type CanvasSeen = {
  since: number;
  workspaces: Readonly<Record<string, CanvasSeenWorkspace>>;
};

export type CanvasSeenStore = {
  storage: Pick<Storage, "getItem" | "setItem">;
  key: string;
};

const STORAGE_VERSION = 1;
/** Guards against a corrupted or runaway value; not product limits. */
const MAX_WORKSPACES = 2000;
const MAX_CANVASES_PER_WORKSPACE = 400;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Parses a stored value; anything unusable reads as a record created `now`. */
export function parseCanvasSeen(raw: string | null, now: number): CanvasSeen {
  const fresh: CanvasSeen = { since: now, workspaces: {} };
  if (!raw) return fresh;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fresh;
  }
  if (!isRecord(parsed) || parsed.version !== STORAGE_VERSION || !isCount(parsed.since) || !isRecord(parsed.workspaces)) return fresh;
  const workspaces: Record<string, CanvasSeenWorkspace> = {};
  let count = 0;
  for (const [workspaceId, value] of Object.entries(parsed.workspaces)) {
    if (count >= MAX_WORKSPACES) break;
    if (workspaceId.length === 0 || workspaceId.length > 128 || !isRecord(value) || !isCount(value.revision) || !isRecord(value.canvases)) continue;
    const canvases: Record<string, number> = {};
    for (const [canvasId, updatedAt] of Object.entries(value.canvases).slice(0, MAX_CANVASES_PER_WORKSPACE)) {
      if (canvasId.length > 0 && canvasId.length <= 128 && isCount(updatedAt)) canvases[canvasId] = updatedAt;
    }
    workspaces[workspaceId] = { revision: value.revision, canvases };
    count += 1;
  }
  return { since: parsed.since, workspaces };
}

export function serializeCanvasSeen(seen: CanvasSeen): string {
  return JSON.stringify({ version: STORAGE_VERSION, since: seen.since, workspaces: seen.workspaces });
}

/** Storage that throws or holds junk reads as a record created `now`. */
export function readCanvasSeen(store: CanvasSeenStore, now: number): CanvasSeen {
  try {
    return parseCanvasSeen(store.storage.getItem(store.key), now);
  } catch {
    return { since: now, workspaces: {} };
  }
}

/** Best-effort write; at worst a canvas is opened once more after a restart. */
export function writeCanvasSeen(store: CanvasSeenStore, seen: CanvasSeen): boolean {
  try {
    store.storage.setItem(store.key, serializeCanvasSeen(seen));
    return true;
  } catch {
    return false;
  }
}

/** The revision last processed for a workspace, or null when its list was never processed. */
export function processedRevision(seen: CanvasSeen, workspaceId: string): number | null {
  return seen.workspaces[workspaceId]?.revision ?? null;
}

/**
 * Applies a fetched list: which of its canvases are new to this desktop (to open or reload, and
 * mark unread), and the record once they are acted on. Canvases no longer listed keep their entry
 * — a file that comes back is the same canvas — until the per-workspace cap drops the oldest.
 */
export function applyCanvasList<T extends { id: string; updatedAt: number }>(
  seen: CanvasSeen,
  workspaceId: string,
  revision: number,
  canvases: readonly T[],
): { fresh: T[]; seen: CanvasSeen } {
  const previous = seen.workspaces[workspaceId]?.canvases ?? {};
  const fresh = canvases.filter((canvas) => canvas.updatedAt > (previous[canvas.id] ?? seen.since));
  const merged: Record<string, number> = { ...previous };
  for (const canvas of canvases) merged[canvas.id] = Math.max(canvas.updatedAt, previous[canvas.id] ?? 0);
  let entries = Object.entries(merged);
  if (entries.length > MAX_CANVASES_PER_WORKSPACE) {
    entries = entries.sort((a, b) => b[1] - a[1]).slice(0, MAX_CANVASES_PER_WORKSPACE);
  }
  return {
    fresh,
    seen: { since: seen.since, workspaces: { ...seen.workspaces, [workspaceId]: { revision, canvases: Object.fromEntries(entries) } } },
  };
}
