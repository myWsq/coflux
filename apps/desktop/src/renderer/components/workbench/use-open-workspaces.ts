import { useEffect, useRef, useState } from "react";
import type { CofluxClient, CofluxState } from "@coflux/client";
import { OPEN_WORKSPACES_KEY, SERVER_URL, WORKSPACE_KEY } from "@/config";
import {
  closeWorkspaces, emptyOpenWorkspaces, migrateOpenWorkspaces, navigationAccountId,
  navigationStorageKey, openWorkspace, parseOpenWorkspaces, reconcileOpenWorkspaces,
  serializeOpenWorkspaces, type OpenWorkspaces,
} from "./open-workspaces";

function accountIdOf(state: CofluxState): string | null {
  return navigationAccountId([...state.workspaces, ...state.projects, ...state.tasks]);
}

function readNavigation(key: string, state: CofluxState, unscoped?: OpenWorkspaces): OpenWorkspaces {
  let stored: string | null = null;
  let legacy: string | null = null;
  try {
    stored = localStorage.getItem(key);
    legacy = localStorage.getItem(WORKSPACE_KEY);
  } catch {
    // First-use device navigation still works when persistence is unavailable.
  }
  const saved = parseOpenWorkspaces(stored);
  if (saved) return saved;
  // An account with only devices has no account-bearing catalog entity yet. Its first
  // terminal supplies the account ID; retain the device the user was already viewing.
  if (unscoped?.selection?.kind === "device"
    && state.daemons.some((daemon) => daemon.daemonId === unscoped.selection?.id)) return { ...unscoped };
  return migrateOpenWorkspaces(legacy,
    new Set(state.workspaces.map((workspace) => workspace.id)), new Set(state.daemons.map((daemon) => daemon.daemonId)));
}

export function useOpenWorkspaces(client: CofluxClient) {
  const [navigation, setNavigation] = useState<OpenWorkspaces>(emptyOpenWorkspaces);
  const current = useRef(navigation);
  const scope = useRef<string | null>(null);

  function update(next: OpenWorkspaces, persist = true) {
    if (next === current.current) return;
    current.current = next;
    setNavigation(next);
    if (!persist || !scope.current) return;
    try {
      localStorage.setItem(scope.current, serializeOpenWorkspaces(next));
    } catch {
      // Navigation remains usable for this app session when storage is unavailable.
    }
  }

  useEffect(() => {
    let waitingForSnapshot = client.store.getState().authState !== "authed";
    let authoritative = false;
    function synchronize(state: CofluxState, previous?: CofluxState) {
      if (state.authState === "need-login" || state.authState === "auth-failed") {
        waitingForSnapshot = true;
        authoritative = false;
        scope.current = null;
        update(emptyOpenWorkspaces(), false);
        return;
      }
      if (state.authState !== "authed") return;
      const newSnapshot = previous !== undefined && state.snapshotRevision !== previous.snapshotRevision;
      if (waitingForSnapshot && !newSnapshot) return;
      waitingForSnapshot = false;
      // Offline hydration also increments snapshotRevision, while entering authed in the same
      // update. Only a later snapshot on an already authenticated connection can prune IDs.
      if (newSnapshot) authoritative = state.status === "connected" && previous.authState === "authed";
      if (state.status !== "connected") authoritative = false;
      const accountId = accountIdOf(state);
      if (accountId) {
        const key = navigationStorageKey(OPEN_WORKSPACES_KEY, SERVER_URL, accountId);
        if (scope.current !== key) {
          const unscoped = scope.current === null ? current.current : undefined;
          scope.current = key;
          update(readNavigation(key, state, unscoped));
        }
      }
      if (!scope.current) return;
      // A mounted cached catalog cannot establish full authority, but an observed online
      // removal is still explicit evidence for the IDs that existed in the preceding state.
      if (!authoritative && previous?.authState === "authed" && previous.status === "connected"
        && state.status === "connected" && !newSnapshot) {
        const liveIds = new Set(state.workspaces.map((workspace) => workspace.id));
        const removedIds = new Set(previous.workspaces.filter((workspace) => !liveIds.has(workspace.id)).map((workspace) => workspace.id));
        update(closeWorkspaces(current.current, removedIds));
        if (current.current.selection?.kind === "device"
          && previous.daemons.some((daemon) => daemon.daemonId === current.current.selection?.id)
          && !state.daemons.some((daemon) => daemon.daemonId === current.current.selection?.id)) {
          update({ ...current.current, selection: null });
        }
      }
      update(reconcileOpenWorkspaces(current.current,
        new Set([...state.workspaces.map((workspace) => workspace.id), ...state.tasks.map((task) => task.workspaceId)]),
        new Set(state.daemons.map((daemon) => daemon.daemonId)), authoritative));
    }
    synchronize(client.store.getState());
    return client.store.subscribe((state, previous) => synchronize(state, previous));
  }, [client]);

  function selectWorkspace(id: string) {
    const state = client.store.getState();
    if (state.workspaces.some((workspace) => workspace.id === id) || state.tasks.some((task) => task.workspaceId === id)) {
      update(openWorkspace(current.current, id));
    } else if (id.startsWith("pending-ws-")) {
      update({ ...current.current, selection: { kind: "workspace", id } }, false);
    }
  }

  function dropPending(id: string) {
    if (current.current.selection?.kind !== "workspace" || current.current.selection.id !== id) return;
    const fallback = current.current.workspaceIds.at(-1);
    update({ ...current.current, selection: fallback ? { kind: "workspace", id: fallback } : null });
  }

  return {
    navigation,
    selectWorkspace,
    rememberWorkspace: (id: string) => {
      if (current.current.workspaceIds.includes(id)) return;
      if (!client.store.getState().workspaces.some((workspace) => workspace.id === id)) return;
      update({ ...openWorkspace(current.current, id), selection: current.current.selection });
    },
    selectDevice: (id: string) => {
      const workspace = client.store.getState().workspaces
        .filter((item) => !item.projectId && item.daemonId === id)
        .sort((left, right) => left.createdAt - right.createdAt)[0];
      const next = workspace ? openWorkspace(current.current, workspace.id) : current.current;
      update({ ...next, selection: { kind: "device", id } });
    },
    closeWorkspaces: (ids: readonly string[], activeWorkspaceId: string | null) =>
      update(closeWorkspaces(current.current, new Set(ids), activeWorkspaceId)),
    dropPending,
  };
}
