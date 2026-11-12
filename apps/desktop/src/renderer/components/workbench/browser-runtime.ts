import { createStore, type StoreApi } from "zustand/vanilla";

import { browserScopeKey } from "../../../shared/browser-partitions";
import type { DesktopBrowserScope } from "../../../shared/desktop-bridge";
import type { DesktopBridge, DesktopBrowserEvent, DesktopBrowserMode, DesktopBrowserPrepared } from "@/desktop-bridge";
import { readLibrary, writeLibrary, type BrowserLibrary, type BrowserLibraryStore } from "@/components/workbench/browser-library";
import {
  serializeBrowserTabRecords,
  writeBrowserTabRecords,
  type BrowserTabCanvas,
  type BrowserTabRecord,
  type BrowserTabStore,
} from "@/components/workbench/browser-tabs";

/**
 * The renderer's side of the built-in browser tabs (plan 20260924-desktop-browser-tab), one per
 * Workbench: what every tab shows (for its strip chip as much as for its view), the global library
 * (history), the prepared partitions, which page guest is which tab, and the routing of
 * main-process events to the tab they concern.
 *
 * Partitions and modes belong to a browser scope — the tab's project, or its device on the device
 * view (plan 20260929-browser-scope-partitions) — while a tab still belongs to its workspace. The
 * scope is never stored with the tab: a view hands it over when it registers.
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
  /** Set on a canvas tab (plan 20261112-agent-canvas); see `BrowserTabRecord.canvas`. */
  canvas?: BrowserTabCanvas;
};

/** Per-tab hooks a mounted view registers. */
export type BrowserTabHandlers = {
  /** A main-process event about this tab's page guest (or its scope's mode). */
  onEvent: (event: DesktopBrowserEvent) => void;
  /** Keyboard focus into the tab: the page, or the address bar when there is no page to focus. */
  focus: () => void;
  reload: () => void;
  /** Load a URL in this tab's page, as the address bar would. */
  navigate: (url: string) => void;
};

export type BrowserRuntime = {
  tabs: StoreApi<{ tabs: Readonly<Record<string, BrowserTabView>> }>;
  library: StoreApi<{ library: BrowserLibrary }>;
  createTab: (id: string, workspaceId: string, url: string, canvas?: BrowserTabCanvas) => void;
  updateTab: (id: string, patch: Partial<Omit<BrowserTabView, "workspaceId">>) => void;
  removeTab: (id: string) => void;
  updateLibrary: (change: (library: BrowserLibrary) => BrowserLibrary) => void;
  /** Prepares (once per scope and renderer) the scope's partition; main decides the mode. */
  prepare: (scope: DesktopBrowserScope, daemonId: string) => Promise<DesktopBrowserPrepared>;
  /** The mode main last reported for a scope; null before it was prepared. */
  modeOf: (scope: DesktopBrowserScope) => DesktopBrowserMode | null;
  bindGuest: (tabId: string, guestId: number) => void;
  unbindGuest: (tabId: string) => void;
  guestOf: (tabId: string) => number | null;
  /** A mounted view's hooks, with its scope: a scope's mode events reach the tabs of every workspace in it. */
  register: (tabId: string, scope: DesktopBrowserScope, handlers: BrowserTabHandlers) => () => void;
  /** Focuses a tab now, or as soon as its view registers (a tab that was just created). */
  focus: (tabId: string) => void;
  reload: (tabId: string) => void;
  /**
   * Loads `url` in the tab (plan 20261112-agent-canvas: a canvas shown again goes back to its own
   * address, fresh). A tab whose view is not mounted just takes the URL and loads it when it mounts.
   */
  navigate: (tabId: string, url: string) => void;
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
    initialTabs[id] = { workspaceId: record.workspaceId, url: record.url, title: record.title, favicon: null, loading: false, canvas: record.canvas };
  }
  const tabs = createStore<{ tabs: Readonly<Record<string, BrowserTabView>> }>(() => ({ tabs: initialTabs }));
  const library = createStore<{ library: BrowserLibrary }>(() => ({ library: readLibrary(options.libraryStore) }));

  // Records are written synchronously on every change of what they hold (workspace, URL, title):
  // a new tab's record is on disk before the debounced layout write that references it.
  let lastRecords: string | null = serializeRecords(initialTabs);
  function serializeRecords(views: Readonly<Record<string, BrowserTabView>>): string {
    const records: Record<string, BrowserTabRecord> = {};
    for (const [id, view] of Object.entries(views)) records[id] = { workspaceId: view.workspaceId, url: view.url, title: view.title, canvas: view.canvas };
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

  // Keyed by `browserScopeKey`.
  const prepared = new Map<string, Promise<DesktopBrowserPrepared>>();
  const modes = new Map<string, DesktopBrowserMode>();
  const guestByTab = new Map<string, number>();
  const tabByGuest = new Map<number, string>();
  const handlers = new Map<string, BrowserTabHandlers>();
  /** Per registered tab, its scope's key; lives and dies with the tab's handlers. */
  const scopeKeyByTab = new Map<string, string>();
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
      const key = browserScopeKey(event.scope);
      modes.set(key, event.mode);
      for (const [tabId, handler] of handlers) {
        if (scopeKeyByTab.get(tabId) === key) handler.onEvent(event);
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
    createTab(id, workspaceId, url, canvas) {
      tabs.setState((state) => ({ tabs: { ...state.tabs, [id]: { workspaceId, url, title: "", favicon: null, loading: false, canvas } } }));
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
    prepare(scope, daemonId) {
      const key = browserScopeKey(scope);
      const existing = prepared.get(key);
      if (existing) return existing;
      const promise = desktop.browserPrepare(scope, daemonId).then((result) => {
        if (!modes.has(key)) modes.set(key, result.mode);
        return { ...result, mode: modes.get(key) ?? result.mode };
      });
      // A failed prepare is retried by the next view that asks.
      promise.catch(() => {
        if (prepared.get(key) === promise) prepared.delete(key);
      });
      prepared.set(key, promise);
      return promise;
    },
    modeOf: (scope) => modes.get(browserScopeKey(scope)) ?? null,
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
    register(tabId, scope, tabHandlers) {
      handlers.set(tabId, tabHandlers);
      scopeKeyByTab.set(tabId, browserScopeKey(scope));
      if (pendingFocus === tabId) {
        pendingFocus = null;
        tabHandlers.focus();
      }
      return () => {
        if (handlers.get(tabId) !== tabHandlers) return;
        handlers.delete(tabId);
        scopeKeyByTab.delete(tabId);
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
    navigate(tabId, url) {
      const handler = handlers.get(tabId);
      if (handler) handler.navigate(url);
      else this.updateTab(tabId, { url });
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
