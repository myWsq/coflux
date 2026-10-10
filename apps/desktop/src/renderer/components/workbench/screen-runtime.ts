import { createStore, type StoreApi } from "zustand/vanilla";

import type { DesktopBridge } from "@/desktop-bridge";
import type { ScreenResolution } from "@/components/workbench/screen-resolution";
import { ScreenSession } from "@/components/workbench/screen-session";
import { serializeScreenTabRecords, writeScreenTabRecords, type ScreenTabRecord, type ScreenTabStore } from "@/components/workbench/screen-tabs";

/**
 * The renderer's side of the remote screen tabs (plan 20260929-remote-desktop), one per Workbench:
 * every tab's record (workspace, device, remote session id — persisted synchronously, before the
 * layout that references it) and the live `ScreenSession` of every mounted tab. Sessions are
 * created when a tab's view mounts and disposed when it unmounts; only closing the tab ends the
 * remote session (`ScreenSession.close`), everything else leaves the remote display in place.
 */
export type ScreenRuntime = {
  tabs: StoreApi<{ tabs: Readonly<Record<string, ScreenTabRecord>> }>;
  createTab: (id: string, record: ScreenTabRecord) => void;
  removeTab: (id: string) => void;
  /** The tab's live session, created on first use for a mounted view, starting at `context.resolution`. */
  sessionFor: (tabId: string, context: { deviceOnline: () => boolean; transportMode: () => string; resolution: ScreenResolution }) => ScreenSession | null;
  /** The tab's session if its view is mounted. */
  sessionOf: (tabId: string) => ScreenSession | null;
  /** The view unmounted (workspace unmounted, reload): let go locally without ending the remote session. */
  release: (tabId: string) => void;
  /** Keyboard focus into the tab's picture, now or as soon as its view registers. */
  focus: (tabId: string) => void;
  register: (tabId: string, handlers: { focus: () => void }) => () => void;
};

export function createScreenRuntime(options: {
  desktop: DesktopBridge;
  tabStore: ScreenTabStore;
  initialRecords: Readonly<Record<string, ScreenTabRecord>>;
}): ScreenRuntime {
  const tabs = createStore<{ tabs: Readonly<Record<string, ScreenTabRecord>> }>(() => ({ tabs: options.initialRecords }));
  let lastRecords: string | null = serializeScreenTabRecords(options.initialRecords);
  tabs.subscribe((state) => {
    const serialized = serializeScreenTabRecords(state.tabs);
    if (serialized === lastRecords) return;
    lastRecords = serialized;
    writeScreenTabRecords(options.tabStore, serialized);
  });

  const sessions = new Map<string, ScreenSession>();
  const handlers = new Map<string, { focus: () => void }>();
  const pendingFocus = new Set<string>();
  // Tabs the user just opened: their first open takes the session over; restored tabs never do.
  const fresh = new Set<string>();

  return {
    tabs,
    createTab(id, record) {
      fresh.add(id);
      tabs.setState((state) => ({ tabs: { ...state.tabs, [id]: record } }));
    },
    removeTab(id) {
      fresh.delete(id);
      const session = sessions.get(id);
      sessions.delete(id);
      session?.close();
      tabs.setState((state) => {
        if (!(id in state.tabs)) return state;
        const next = { ...state.tabs };
        delete next[id];
        return { tabs: next };
      });
    },
    sessionFor(tabId, context) {
      const existing = sessions.get(tabId);
      if (existing) return existing;
      const record = tabs.getState().tabs[tabId];
      if (!record) return null;
      const session = new ScreenSession({
        sessionId: record.sessionId,
        daemonId: record.daemonId,
        desktop: options.desktop,
        deviceOnline: context.deviceOnline,
        transportMode: context.transportMode,
        takeOverOnOpen: fresh.delete(tabId),
        resolution: context.resolution,
      });
      sessions.set(tabId, session);
      return session;
    },
    sessionOf(tabId) {
      return sessions.get(tabId) ?? null;
    },
    release(tabId) {
      const session = sessions.get(tabId);
      sessions.delete(tabId);
      session?.dispose();
    },
    focus(tabId) {
      const target = handlers.get(tabId);
      if (target) target.focus();
      else pendingFocus.add(tabId);
    },
    register(tabId, target) {
      handlers.set(tabId, target);
      if (pendingFocus.delete(tabId)) target.focus();
      return () => {
        if (handlers.get(tabId) === target) handlers.delete(tabId);
      };
    },
  };
}
