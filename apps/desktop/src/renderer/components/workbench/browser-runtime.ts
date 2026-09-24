import { createStore, type StoreApi } from "zustand/vanilla";

import type { DesktopBridge, DesktopBrowserEvent, DesktopBrowserMode, DesktopBrowserPrepared } from "@/desktop-bridge";
import { readLibrary, writeLibrary, type BrowserLibrary, type BrowserLibraryStore } from "@/components/workbench/browser-library";
import {
  serializeBrowserTabRecords,
  writeBrowserTabRecords,
  type BrowserTabRecord,
  type BrowserTabStore,
} from "@/components/workbench/browser-tabs";

/**
 * The renderer's side of the built-in browser tabs (plan 20260924-desktop-browser-tab), one per
 * Workbench: what every tab shows (for its strip chip as much as for its view), the global library
 * (bookmarks, history), the prepared partitions, which page guest is which tab, and the routing of
 * main-process events to the tab they concern.
 *
 * It is a plain object built once and handed down, never state: views register themselves with it
 * from effects, and the Workbench subscribes to the few events that change the layout (focus,
 * popups). Nothing in here renders.
 */

export type BrowserTabView = {
  workspaceId: string;
  /** The committed URL; empty for a blank new tab. */
  url: string;
  title: string;
  favicon: string | null;
  loading: boolean;
};

/** Per-tab hooks a mounted view registers. */
export type BrowserTabHandlers = {
  /** A main-process event about this tab's page guest (or its workspace's mode). */
  onEvent: (event: DesktopBrowserEvent) => void;
  /** Keyboard focus into the tab: the page, or the address bar when there is no page to focus. */
  focus: () => void;
  reload: () => void;
};

export type BrowserRuntime = {
  tabs: StoreApi<{ tabs: Readonly<Record<string, BrowserTabView>> }>;
  library: StoreApi<{ library: BrowserLibrary }>;
  createTab: (id: string, workspaceId: string, url: string) => void;
  updateTab: (id: string, patch: Partial<Omit<BrowserTabView, "workspaceId">>) => void;
  removeTab: (id: string) => void;
  updateLibrary: (change: (library: BrowserLibrary) => BrowserLibrary) => void;
  /** Prepares (once per workspace and renderer) the workspace's partition; main decides the mode. */
  prepare: (workspaceId: string, daemonId: string) => Promise<DesktopBrowserPrepared>;
  /** The mode main last reported for a workspace; null before it was prepared. */
  modeOf: (workspaceId: string) => DesktopBrowserMode | null;
  bindGuest: (tabId: string, guestId: number) => void;
  unbindGuest: (tabId: string) => void;
  guestOf: (tabId: string) => number | null;
  register: (tabId: string, handlers: BrowserTabHandlers) => () => void;
  /** Focuses a tab now, or as soon as its view registers (a tab that was just created). */
  focus: (tabId: string) => void;
  reload: (tabId: string) => void;
  /** Workbench-level reactions: a page took focus, a page opened a popup. */
  setWorkbenchHandlers: (handlers: { onGuestFocus: (tabId: string) => void; onPopup: (tabId: string, url: string) => void }) => void;
  onDownload: (listener: (event: Extract<DesktopBrowserEvent, { kind: "download" }>) => void) => () => void;
  /** Subscribes to the main process; returns the unsubscribe. Also flushes pending writes on pagehide. */
  start: () => () => void;
};

const LIBRARY_WRITE_DELAY_MS = 300;

export function createBrowserRuntime(options: {
  desktop: DesktopBridge;
  tabStore: BrowserTabStore;
  libraryStore: BrowserLibraryStore;
  initialRecords: Readonly<Record<string, BrowserTabRecord>>;
}): BrowserRuntime {
  const { desktop } = options;
  const initialTabs: Record<string, BrowserTabView> = {};
  for (const [id, record] of Object.entries(options.initialRecords)) {
    initialTabs[id] = { workspaceId: record.workspaceId, url: record.url, title: record.title, favicon: null, loading: false };
  }
  const tabs = createStore<{ tabs: Readonly<Record<string, BrowserTabView>> }>(() => ({ tabs: initialTabs }));
  const library = createStore<{ library: BrowserLibrary }>(() => ({ library: readLibrary(options.libraryStore) }));

  // Records are written synchronously on every change of what they hold (workspace, URL, title):
  // a new tab's record is on disk before the debounced layout write that references it.
  let lastRecords: string | null = serializeRecords(initialTabs);
  function serializeRecords(views: Readonly<Record<string, BrowserTabView>>): string {
    const records: Record<string, BrowserTabRecord> = {};
    for (const [id, view] of Object.entries(views)) records[id] = { workspaceId: view.workspaceId, url: view.url, title: view.title };
    return serializeBrowserTabRecords(records);
  }
  tabs.subscribe((state) => {
    const serialized = serializeRecords(state.tabs);
    if (serialized === lastRecords) return;
    lastRecords = serialized;
    writeBrowserTabRecords(options.tabStore, serialized);
  });

  let libraryTimer: number | undefined;
  function flushLibrary() {
    if (libraryTimer !== undefined) window.clearTimeout(libraryTimer);
    libraryTimer = undefined;
    writeLibrary(options.libraryStore, library.getState().library);
  }
  library.subscribe(() => {
    if (libraryTimer !== undefined) window.clearTimeout(libraryTimer);
    libraryTimer = window.setTimeout(flushLibrary, LIBRARY_WRITE_DELAY_MS);
  });

  const prepared = new Map<string, Promise<DesktopBrowserPrepared>>();
  const modes = new Map<string, DesktopBrowserMode>();
  const guestByTab = new Map<string, number>();
  const tabByGuest = new Map<number, string>();
  const handlers = new Map<string, BrowserTabHandlers>();
  let pendingFocus: string | null = null;
  let workbench: { onGuestFocus: (tabId: string) => void; onPopup: (tabId: string, url: string) => void } | null = null;
  const downloadListeners = new Set<(event: Extract<DesktopBrowserEvent, { kind: "download" }>) => void>();

  function tabOfEvent(event: DesktopBrowserEvent): string | null {
    return "guestId" in event ? (tabByGuest.get(event.guestId) ?? null) : null;
  }

  function dispatch(event: DesktopBrowserEvent) {
    if (event.kind === "download") {
      for (const listener of downloadListeners) listener(event);
      return;
    }
    if (event.kind === "mode") {
      // Views read the live mode through `modeOf`; the prepare result they already hold only gave them the partition.
      modes.set(event.workspaceId, event.mode);
      for (const [tabId, handler] of handlers) {
        if (tabs.getState().tabs[tabId]?.workspaceId === event.workspaceId) handler.onEvent(event);
      }
      return;
    }
    const tabId = tabOfEvent(event);
    if (!tabId) return;
    if (event.kind === "focus") workbench?.onGuestFocus(tabId);
    if (event.kind === "popup") workbench?.onPopup(tabId, event.url);
    handlers.get(tabId)?.onEvent(event);
  }

  return {
    tabs,
    library,
    createTab(id, workspaceId, url) {
      tabs.setState((state) => ({ tabs: { ...state.tabs, [id]: { workspaceId, url, title: "", favicon: null, loading: false } } }));
    },
    updateTab(id, patch) {
      const current = tabs.getState().tabs[id];
      if (!current) return;
      const changed = (Object.keys(patch) as (keyof typeof patch)[]).some((key) => patch[key] !== current[key]);
      if (!changed) return;
      tabs.setState((state) => ({ tabs: { ...state.tabs, [id]: { ...current, ...patch } } }));
    },
    removeTab(id) {
      if (!tabs.getState().tabs[id]) return;
      tabs.setState((state) => {
        const next = { ...state.tabs };
        delete next[id];
        return { tabs: next };
      });
    },
    updateLibrary(change) {
      const current = library.getState().library;
      const next = change(current);
      if (next !== current) library.setState({ library: next });
    },
    prepare(workspaceId, daemonId) {
      const existing = prepared.get(workspaceId);
      if (existing) return existing;
      const promise = desktop.browserPrepare(workspaceId, daemonId).then((result) => {
        if (!modes.has(workspaceId)) modes.set(workspaceId, result.mode);
        return { ...result, mode: modes.get(workspaceId) ?? result.mode };
      });
      // A failed prepare is retried by the next view that asks.
      promise.catch(() => {
        if (prepared.get(workspaceId) === promise) prepared.delete(workspaceId);
      });
      prepared.set(workspaceId, promise);
      return promise;
    },
    modeOf: (workspaceId) => modes.get(workspaceId) ?? null,
    bindGuest(tabId, guestId) {
      const previous = guestByTab.get(tabId);
      if (previous !== undefined) tabByGuest.delete(previous);
      guestByTab.set(tabId, guestId);
      tabByGuest.set(guestId, tabId);
    },
    unbindGuest(tabId) {
      const guestId = guestByTab.get(tabId);
      if (guestId === undefined) return;
      guestByTab.delete(tabId);
      if (tabByGuest.get(guestId) === tabId) tabByGuest.delete(guestId);
    },
    guestOf: (tabId) => guestByTab.get(tabId) ?? null,
    register(tabId, tabHandlers) {
      handlers.set(tabId, tabHandlers);
      if (pendingFocus === tabId) {
        pendingFocus = null;
        tabHandlers.focus();
      }
      return () => {
        if (handlers.get(tabId) === tabHandlers) handlers.delete(tabId);
      };
    },
    focus(tabId) {
      const handler = handlers.get(tabId);
      if (handler) {
        pendingFocus = null;
        handler.focus();
      } else {
        pendingFocus = tabId;
      }
    },
    reload(tabId) {
      handlers.get(tabId)?.reload();
    },
    setWorkbenchHandlers(next) {
      workbench = next;
    },
    onDownload(listener) {
      downloadListeners.add(listener);
      return () => downloadListeners.delete(listener);
    },
    start() {
      const unsubscribe = desktop.onBrowserEvent(dispatch);
      window.addEventListener("pagehide", flushLibrary);
      return () => {
        unsubscribe();
        window.removeEventListener("pagehide", flushLibrary);
        flushLibrary();
      };
    },
  };
}
