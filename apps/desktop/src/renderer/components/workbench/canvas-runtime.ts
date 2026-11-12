import { createStore, type StoreApi } from "zustand/vanilla";
import type { CanvasEntry, CofluxClient } from "@coflux/client";

import { applyCanvasList, processedRevision, readCanvasSeen, writeCanvasSeen, type CanvasSeen, type CanvasSeenStore } from "@/components/workbench/canvas-seen";

/**
 * The renderer's side of canvases (plan 20261112-agent-canvas), one per Workbench: each workspace's
 * canvas list as last fetched from its device, and which canvases this desktop has not looked at.
 *
 * The center relays only a revision per workspace. When one moves past what this desktop last
 * processed, the list is fetched over the Device channel; a canvas that is new to this desktop
 * (see canvas-seen.ts) is marked unread and handed to the Workbench, which opens it in a background
 * tab or reloads the tab it already has. Workspaces are processed whether or not they are on
 * screen — an agent in a background workspace shows a canvas the same way.
 *
 * A list that failed to load is not fetched again for the same revision by itself; `ensure` (the
 * workspace came on screen, its ＋ menu opened) asks again.
 *
 * A plain object built once and handed down, like the browser runtime. Nothing in here renders.
 */

export type WorkspaceCanvases =
  | { status: "ok"; canvases: readonly CanvasEntry[] }
  /** `unsupported`: the device runs an older coflux. `unavailable`: its canvas listener is not running. */
  | { status: "unsupported" | "unavailable" | "unreachable" | "refused"; canvases: readonly CanvasEntry[]; error: string };

export type CanvasRuntimeState = {
  workspaces: Readonly<Record<string, WorkspaceCanvases>>;
  /** Canvas ids shown or shown again since the user last had their tab on screen. */
  unread: Readonly<Record<string, true>>;
};

export type CanvasRuntime = {
  state: StoreApi<CanvasRuntimeState>;
  /** Loads the workspace's list if it was never loaded here or its last load failed. */
  ensure: (workspaceId: string) => void;
  markRead: (canvasId: string) => void;
  /** Called for each canvas that is new to this desktop, after it was marked unread. */
  setHandler: (handler: ((workspaceId: string, canvas: CanvasEntry) => void) | null) => void;
  start: () => () => void;
};

export function createCanvasRuntime(options: { client: CofluxClient; seenStore: CanvasSeenStore; now?: () => number }): CanvasRuntime {
  const { client } = options;
  const now = options.now ?? Date.now;
  const state = createStore<CanvasRuntimeState>(() => ({ workspaces: {}, unread: {} }));
  let seen: CanvasSeen = readCanvasSeen(options.seenStore, now());
  // A record created just now has to be on disk before anything is compared against its `since`.
  writeCanvasSeen(options.seenStore, seen);
  let handler: ((workspaceId: string, canvas: CanvasEntry) => void) | null = null;
  const inFlight = new Set<string>();
  /** Per workspace, the summary revision a fetch was last attempted for (successful or not). */
  const attempted = new Map<string, number>();
  /** Per workspace, the summary object last looked at: the center re-sends a device's summaries when it reconnects. */
  const lastSummary = new Map<string, unknown>();

  function summaryRevision(workspaceId: string): number | null {
    return client.store.getState().canvasSummaries[workspaceId]?.revision ?? null;
  }

  async function load(workspaceId: string) {
    if (inFlight.has(workspaceId)) return;
    const revision = summaryRevision(workspaceId);
    if (revision === null) return;
    inFlight.add(workspaceId);
    attempted.set(workspaceId, revision);
    let result: Awaited<ReturnType<CofluxClient["listCanvases"]>>;
    try {
      result = await client.listCanvases(workspaceId);
    } finally {
      inFlight.delete(workspaceId);
    }
    if (result.ok) {
      const applied = applyCanvasList(seen, workspaceId, result.revision, result.canvases);
      seen = applied.seen;
      writeCanvasSeen(options.seenStore, seen);
      state.setState((current) => {
        const unread = { ...current.unread };
        for (const canvas of applied.fresh) unread[canvas.id] = true;
        return { workspaces: { ...current.workspaces, [workspaceId]: { status: "ok", canvases: result.canvases } }, unread };
      });
      for (const canvas of applied.fresh) handler?.(workspaceId, canvas);
    } else {
      state.setState((current) => ({
        workspaces: {
          ...current.workspaces,
          // Keep what was listed before: the ＋ menu and open tabs still make sense while a device is away.
          [workspaceId]: { status: result.reason, canvases: current.workspaces[workspaceId]?.canvases ?? [], error: result.error },
        },
      }));
    }
    // A newer revision arrived while this one was in flight.
    const latest = summaryRevision(workspaceId);
    if (latest !== null && latest !== attempted.get(workspaceId)) void load(workspaceId);
  }

  function sync() {
    for (const [workspaceId, summary] of Object.entries(client.store.getState().canvasSummaries)) {
      const resent = lastSummary.get(workspaceId) !== summary;
      lastSummary.set(workspaceId, summary);
      if (attempted.get(workspaceId) === summary.revision) {
        // A list that failed for this revision is asked for again when its device reports again
        // (it came back), not on a timer: a canvas shown while it was away must not stay unopened.
        const entry = state.getState().workspaces[workspaceId];
        if (resent && entry && entry.status !== "ok") void load(workspaceId);
        continue;
      }
      // Unchanged since this desktop last processed it (before a restart): nothing new to open.
      // The list itself is loaded on demand by `ensure`.
      if (!attempted.has(workspaceId) && processedRevision(seen, workspaceId) === summary.revision) {
        attempted.set(workspaceId, summary.revision);
        continue;
      }
      void load(workspaceId);
    }
  }

  return {
    state,
    ensure(workspaceId) {
      const entry = state.getState().workspaces[workspaceId];
      if (entry?.status === "ok") return;
      void load(workspaceId);
    },
    markRead(canvasId) {
      if (!state.getState().unread[canvasId]) return;
      state.setState((current) => {
        const unread = { ...current.unread };
        delete unread[canvasId];
        return { unread };
      });
    },
    setHandler(next) {
      handler = next;
    },
    start() {
      let last = client.store.getState().canvasSummaries;
      sync();
      return client.store.subscribe((current) => {
        if (current.canvasSummaries === last) return;
        last = current.canvasSummaries;
        sync();
      });
    },
  };
}
