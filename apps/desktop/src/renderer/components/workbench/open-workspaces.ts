import { parseStoredSelection, type WorkbenchSelection } from "./workbench-state";

export type OpenWorkspaces = {
  workspaceIds: string[];
  selection: WorkbenchSelection | null;
};

export const emptyOpenWorkspaces = (): OpenWorkspaces => ({ workspaceIds: [], selection: null });

export function openWorkspace(state: OpenWorkspaces, id: string): OpenWorkspaces {
  return {
    workspaceIds: state.workspaceIds.includes(id) ? state.workspaceIds : [...state.workspaceIds, id],
    selection: { kind: "workspace", id },
  };
}

/** Closing navigation never implies stopping or deleting the underlying work. */
export function closeWorkspaces(
  state: OpenWorkspaces,
  ids: ReadonlySet<string>,
  activeWorkspaceId: string | null = null,
): OpenWorkspaces {
  const workspaceIds = state.workspaceIds.filter((id) => !ids.has(id));
  if (workspaceIds.length === state.workspaceIds.length) return state;
  // Device details can display a canonical directory workspace. Closing that visible entry
  // follows workspace navigation; closing unrelated entries keeps the device page selected.
  const selected = state.selection?.kind === "device" && activeWorkspaceId
    ? { kind: "workspace" as const, id: activeWorkspaceId } : state.selection;
  if (selected?.kind !== "workspace" || !ids.has(selected.id)) return { ...state, workspaceIds };
  const index = state.workspaceIds.indexOf(selected.id);
  const neighbor = state.workspaceIds.slice(index + 1).find((id) => !ids.has(id))
    ?? state.workspaceIds.slice(0, index).reverse().find((id) => !ids.has(id));
  return { workspaceIds, selection: neighbor ? { kind: "workspace", id: neighbor } : null };
}

export function parseOpenWorkspaces(raw: string | null): OpenWorkspaces | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1
      || !("workspaceIds" in value) || !Array.isArray(value.workspaceIds)
      || !("selection" in value)) return null;
    const workspaceIds = [...new Set(value.workspaceIds.filter((id): id is string =>
      typeof id === "string" && id.length > 0 && !id.startsWith("pending-ws-")))];
    const selection = value.selection;
    if (selection === null) return { workspaceIds, selection: null };
    if (typeof selection !== "object" || !("kind" in selection) || !("id" in selection)
      || typeof selection.id !== "string" || !selection.id) return null;
    if (selection.kind === "device") return { workspaceIds, selection: { kind: "device", id: selection.id } };
    if (selection.kind !== "workspace" || !workspaceIds.includes(selection.id)) return { workspaceIds, selection: null };
    return { workspaceIds, selection: { kind: "workspace", id: selection.id } };
  } catch {
    return null;
  }
}

export function serializeOpenWorkspaces(state: OpenWorkspaces): string {
  // Optimistic creation is transient; a placeholder must never become a saved selection.
  const selection = state.selection?.kind === "workspace" && !state.workspaceIds.includes(state.selection.id)
    ? null : state.selection;
  return JSON.stringify({ version: 1, workspaceIds: state.workspaceIds, selection });
}

export function migrateOpenWorkspaces(
  legacy: string | null,
  workspaceIds: ReadonlySet<string>,
  daemonIds: ReadonlySet<string>,
): OpenWorkspaces {
  const selection = parseStoredSelection(legacy);
  if (selection?.kind === "workspace" && workspaceIds.has(selection.id)) return openWorkspace(emptyOpenWorkspaces(), selection.id);
  if (selection?.kind === "device" && daemonIds.has(selection.id)) return { workspaceIds: [], selection };
  return emptyOpenWorkspaces();
}

/** Catalog entities carry the account primary key; loginName is display-only. */
export function navigationAccountId(entities: readonly { accountId: string }[]): string | null {
  const ids = new Set(entities.map((entity) => entity.accountId).filter(Boolean));
  return ids.size === 1 ? [...ids][0]! : null;
}

export function navigationStorageKey(prefix: string, server: string, accountId: string): string {
  return `${prefix}:${encodeURIComponent(server)}:${encodeURIComponent(accountId)}`;
}

export function reconcileOpenWorkspaces(
  state: OpenWorkspaces,
  workspaceIds: ReadonlySet<string>,
  daemonIds: ReadonlySet<string>,
  authoritative: boolean,
): OpenWorkspaces {
  if (!authoritative) return state;
  const next = closeWorkspaces(state, new Set(state.workspaceIds.filter((id) => !workspaceIds.has(id))));
  if (next.selection?.kind === "device" && !daemonIds.has(next.selection.id)) return { ...next, selection: null };
  return next;
}
