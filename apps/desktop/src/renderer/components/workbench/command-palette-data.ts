import { TaskStatus, type DaemonInfo, type Project, type Task, type Workspace } from "@coflux/protocol";
import { isDirWorkspace, workspaceActivity, type SessionAgentState, type WorkspaceActivity } from "@coflux/client";

import type { ActivityDotsStatus } from "@/components/workbench/pending-dots";

/**
 * Data layer of the ⌘P navigation palette (plan 20260921).
 *
 * Everything here is pure: the snapshot is built once when the palette opens and frozen for its
 * lifetime, and ranking is a function of (snapshot, query, filter tab, MRU order). A palette that
 * reordered itself between the keystroke and Enter would send the user to the wrong place, so the
 * component never re-reads the store while it is open — and the ranking can be asserted directly,
 * without rendering anything.
 */

/**
 * The kinds of entry. Projects have no filter tab of their own: they rank among workspaces. Actions
 * (plan 20260924-desktop-browser-tab: 新建浏览器标签页) have none either and only surface on a
 * typed query in 全部 — the empty-query list stays the ⌘P ⏎ bounce between places.
 */
export type PaletteEntryKind = "workspace" | "project" | "terminal" | "device" | "action";

export type PaletteAction = "new-browser-tab";

/** The filter tab row. `all` is the tab the palette opens on. */
export type PaletteFilter = "all" | "workspace" | "terminal" | "device";

/** Activity shown with the sidebar's own dots; `null` is the neutral (idle) state. */
export type PaletteActivity = ActivityDotsStatus | null;

/** What opening an entry does. Projects resolve to their main workspace. */
export type PaletteTarget =
  | { kind: "workspace"; workspaceId: string }
  | { kind: "terminal"; workspaceId: string; taskId: string }
  | { kind: "device"; daemonId: string }
  | { kind: "action"; action: PaletteAction };

export type PaletteEntry = {
  /** Stable identity: the palette item id, and the key this place is remembered under. */
  key: string;
  kind: PaletteEntryKind;
  /** Primary label: branch / project name / terminal title / device name. */
  label: string;
  /** Secondary label drawn next to the primary one. */
  detail: string;
  /** Trailing metadata (the project or device an entry belongs to). */
  context: string;
  /** Extra words folded into matching but never drawn. */
  keywords: string;
  activity: PaletteActivity;
  /** The device hosting this entry is offline. Opening it still works, landing on the offline state. */
  isOffline: boolean;
  target: PaletteTarget;
};

export type PaletteSnapshot = {
  entries: readonly PaletteEntry[];
  /**
   * Everything the user is already looking at, as a set rather than one id: the selected
   * workspace, its active tab, the project whose main workspace it is, and the selected device.
   * Excluding only the selection would leave the active terminal at the top of 「最近」, so Enter
   * would land where the user already is.
   */
  currentKeys: ReadonlySet<string>;
};

export type PaletteItem = {
  id: string;
  label: string;
  auxiliaryData: { group: string; entry: PaletteEntry };
};

export const RECENT_GROUP = "最近";

const GROUP_OF_KIND: Record<PaletteEntryKind, string> = {
  workspace: "工作区",
  project: "工作区",
  terminal: "终端",
  device: "设备",
  action: "操作",
};

/** Fixed group order, so the headings never reshuffle themselves as scores change. */
const GROUP_ORDER: readonly string[] = [RECENT_GROUP, "工作区", "终端", "设备", "操作"];

const DEFAULT_LIMIT = 50;

export function workspaceVisitKey(workspaceId: string): string {
  return `workspace:${workspaceId}`;
}

export function projectVisitKey(projectId: string): string {
  return `project:${projectId}`;
}

export function terminalVisitKey(taskId: string): string {
  return `terminal:${taskId}`;
}

export function deviceVisitKey(daemonId: string): string {
  return `device:${daemonId}`;
}

export const EMPTY_PALETTE_SNAPSHOT: PaletteSnapshot = { entries: [], currentKeys: new Set<string>() };

export type PaletteSnapshotInput = {
  projects: readonly Project[];
  workspaces: readonly Workspace[];
  daemons: readonly DaemonInfo[];
  tasks: readonly Task[];
  sessionAgents: Record<string, SessionAgentState>;
  /** OSC titles: a tab shows the checkpoint title when it has one, so matching must too. */
  sessionCheckpoints: Record<string, { title?: string } | undefined>;
  /** What is on screen at the moment the palette opens. */
  current: {
    workspaceId: string | null;
    /** The active tab of the workspace on screen, when the terminal view is the one showing. */
    taskId: string | null;
    /** Set only while a device detail view is the selection. */
    daemonId: string | null;
  };
  /** Whether 新建浏览器标签页 is on offer: there is a workspace on screen to open it in. */
  canOpenBrowserTab?: boolean;
};

/** Map the shared workspace aggregate onto the dot states; idle becomes no dots at all. */
function activityOf(activity: WorkspaceActivity): PaletteActivity {
  return activity.status === "idle" ? null : activity.status;
}

/**
 * Per-terminal activity comes straight from the agent presence entry. `state` is a free-form
 * string on the wire, so anything unknown is neutral, and an old worker's "waiting" reads as
 * "turn complete" — the same collapse `workspaceActivity` performs.
 */
function agentActivityOf(state: string | undefined, daemonOnline: boolean): PaletteActivity {
  if (!daemonOnline) return null;
  if (state === "approval") return "approval";
  if (state === "question") return "question";
  if (state === "active") return "active";
  if (state === "done" || state === "waiting") return "done";
  return null;
}

/**
 * Build the frozen entry set.
 *
 * Non-RUNNING tasks are dropped here rather than at render time: an exited tab is not a place the
 * user can go, and keeping it searchable only offers dead ends. Directory workspaces (the carrier
 * of a device detail view) are not listed as workspaces either — the device entry is that place —
 * but their running terminals are, because those are real terminals the user may be looking for.
 */
export function buildPaletteSnapshot(input: PaletteSnapshotInput): PaletteSnapshot {
  const daemonById = new Map<string, DaemonInfo>(input.daemons.map((daemon) => [daemon.daemonId, daemon]));
  const projectById = new Map<string, Project>(input.projects.map((project) => [project.id, project]));
  const workspaceById = new Map<string, Workspace>(input.workspaces.map((workspace) => [workspace.id, workspace]));
  const entries: PaletteEntry[] = [];

  for (const project of input.projects) {
    const main = input.workspaces.find((workspace) => workspace.projectId === project.id && workspace.isMain);
    if (!main) continue;
    const daemon = daemonById.get(project.daemonId);
    const online = daemon?.online ?? false;
    entries.push({
      key: projectVisitKey(project.id),
      kind: "project",
      label: project.name,
      detail: "项目",
      context: daemon?.name ?? "",
      keywords: `${main.branch} ${project.repoPath}`,
      activity: activityOf(workspaceActivity(main.id, online, input.tasks, input.sessionAgents)),
      isOffline: !online,
      target: { kind: "workspace", workspaceId: main.id },
    });
  }

  for (const workspace of input.workspaces) {
    if (isDirWorkspace(workspace)) continue;
    const project = projectById.get(workspace.projectId);
    const daemon = daemonById.get(workspace.daemonId);
    const online = daemon?.online ?? false;
    // Same naming rule as the sidebar: a custom name when there is one, otherwise 「主工作区」
    // for the repository itself and nothing at all for a plain worktree.
    const name = workspace.name && workspace.name !== workspace.branch ? workspace.name : workspace.isMain ? "主工作区" : "";
    entries.push({
      key: workspaceVisitKey(workspace.id),
      kind: "workspace",
      label: workspace.branch,
      detail: name,
      context: project?.name ?? "",
      keywords: `${workspace.name} ${workspace.path} ${daemon?.name ?? ""}`,
      activity: activityOf(workspaceActivity(workspace.id, online, input.tasks, input.sessionAgents)),
      isOffline: !online,
      target: { kind: "workspace", workspaceId: workspace.id },
    });
  }

  for (const task of input.tasks) {
    if (task.status !== TaskStatus.RUNNING) continue;
    const workspace = workspaceById.get(task.workspaceId);
    if (!workspace) continue;
    const daemon = daemonById.get(task.daemonId);
    const online = daemon?.online ?? false;
    const agent = task.sessionId ? input.sessionAgents[task.sessionId] : undefined;
    // The tab's own title rule: the OSC checkpoint title when there is one, else the task title.
    const checkpointTitle = task.sessionId ? input.sessionCheckpoints[task.sessionId]?.title : undefined;
    const isDir = isDirWorkspace(workspace);
    const project = isDir ? undefined : projectById.get(workspace.projectId);
    entries.push({
      key: terminalVisitKey(task.id),
      kind: "terminal",
      label: checkpointTitle || task.title || "终端",
      detail: isDir ? (daemon?.name ?? "") : workspace.branch,
      context: isDir ? "设备" : (project?.name ?? ""),
      keywords: `${task.title} ${agent?.agent ?? ""} ${workspace.name}`,
      activity: agentActivityOf(agent?.state, online),
      isOffline: !online,
      target: { kind: "terminal", workspaceId: workspace.id, taskId: task.id },
    });
  }

  for (const daemon of input.daemons) {
    entries.push({
      key: deviceVisitKey(daemon.daemonId),
      kind: "device",
      label: daemon.name,
      detail: daemon.online ? "设备 · 在线" : "设备 · 离线",
      context: daemon.host,
      keywords: daemon.platform,
      activity: null,
      isOffline: !daemon.online,
      target: { kind: "device", daemonId: daemon.daemonId },
    });
  }

  if (input.canOpenBrowserTab) {
    entries.push({
      key: "action:new-browser-tab",
      kind: "action",
      label: "新建浏览器标签页",
      detail: "",
      context: "操作",
      keywords: "browser web page tab new 浏览器 网页 标签页 新建",
      activity: null,
      isOffline: false,
      target: { kind: "action", action: "new-browser-tab" },
    });
  }

  const currentKeys = new Set<string>();
  const currentWorkspace = input.current.workspaceId ? workspaceById.get(input.current.workspaceId) : undefined;
  if (input.current.workspaceId) currentKeys.add(workspaceVisitKey(input.current.workspaceId));
  if (currentWorkspace?.isMain && currentWorkspace.projectId) currentKeys.add(projectVisitKey(currentWorkspace.projectId));
  if (input.current.taskId) currentKeys.add(terminalVisitKey(input.current.taskId));
  if (input.current.daemonId) currentKeys.add(deviceVisitKey(input.current.daemonId));

  return { entries, currentKeys };
}

function matchesFilter(entry: PaletteEntry, filter: PaletteFilter): boolean {
  if (filter === "all") return true;
  if (filter === "workspace") return entry.kind === "workspace" || entry.kind === "project";
  return entry.kind === filter;
}

/** Something that wants the user outranks something that is merely busy, which outranks idle. */
function activityScore(entry: PaletteEntry): number {
  const byStatus =
    entry.activity === "approval" ? 9 : entry.activity === "question" ? 8 : entry.activity === "active" ? 6 : entry.activity === "done" ? 3 : 0;
  return byStatus - (entry.isOffline ? 4 : 0);
}

function groupRank(group: string): number {
  const index = GROUP_ORDER.indexOf(group);
  return index === -1 ? GROUP_ORDER.length : index;
}

function toItem(entry: PaletteEntry, group: string): PaletteItem {
  return { id: entry.key, label: entry.label, auxiliaryData: { group, entry } };
}

export type PaletteSearchInput = {
  snapshot: PaletteSnapshot;
  query: string;
  filter: PaletteFilter;
  /** Most recently visited first, as keys. Entries that no longer exist are simply skipped. */
  recent: readonly string[];
  limit?: number;
};

/**
 * Turn the frozen snapshot into the grouped list the palette renders.
 *
 * With an empty query the result is 「最近」: the most-recently-visited places, with the whole
 * current-location set removed, so the first row — and the one the palette highlights — is the
 * place the user was *before* this one. ⌘P then Enter therefore bounces between two places, which
 * is the single most valuable thing the palette does. On a narrowed tab the rest of that kind
 * follows under its own heading, so switching tabs on an empty query still shows something.
 *
 * With a query every term has to match somewhere, so a second word narrows rather than widens.
 * Matches are grouped by kind in a fixed heading order; scores only decide the order inside a
 * group, never which group comes first.
 */
export function searchPaletteEntries(input: PaletteSearchInput): PaletteItem[] {
  const limit = input.limit ?? DEFAULT_LIMIT;
  const terms = input.query.toLowerCase().split(/\s+/).filter((term) => term.length > 0);
  const candidates = input.snapshot.entries.filter((entry) => matchesFilter(entry, input.filter));

  if (terms.length === 0) {
    // The current location is only excluded here: on a typed query, hiding what the user just
    // searched for by name would read as a bug.
    // Actions are not places: they never appear on the empty-query list.
    const reachable = candidates.filter((entry) => !input.snapshot.currentKeys.has(entry.key) && entry.kind !== "action");
    const byKey = new Map<string, PaletteEntry>(reachable.map((entry) => [entry.key, entry]));
    const recent: PaletteEntry[] = [];
    for (const key of input.recent) {
      const entry = byKey.get(key);
      if (entry) recent.push(entry);
    }
    const items = recent.map((entry) => toItem(entry, RECENT_GROUP));
    if (input.filter !== "all") {
      const seen = new Set(recent.map((entry) => entry.key));
      const rest = reachable
        .filter((entry) => !seen.has(entry.key))
        .sort((left, right) => activityScore(right) - activityScore(left) || left.label.localeCompare(right.label));
      items.push(...rest.map((entry) => toItem(entry, GROUP_OF_KIND[entry.kind])));
    }
    return items.slice(0, limit);
  }

  const scored: { entry: PaletteEntry; score: number; index: number }[] = [];
  candidates.forEach((entry, index) => {
    const label = entry.label.toLowerCase();
    const detail = entry.detail.toLowerCase();
    const context = entry.context.toLowerCase();
    const keywords = entry.keywords.toLowerCase();
    let score = activityScore(entry);
    for (const term of terms) {
      if (label.startsWith(term)) score += 60;
      else if (label.includes(term)) score += 40;
      else if (detail.includes(term)) score += 20;
      else if (context.includes(term)) score += 12;
      else if (keywords.includes(term)) score += 6;
      else return;
    }
    scored.push({ entry, score, index });
  });

  scored.sort((left, right) => right.score - left.score || left.index - right.index);
  const items = scored.slice(0, limit).map((match) => toItem(match.entry, GROUP_OF_KIND[match.entry.kind]));
  // Array.prototype.sort is stable, so this only reorders across groups: the score order inside
  // each group survives.
  items.sort((left, right) => groupRank(left.auxiliaryData.group) - groupRank(right.auxiliaryData.group));
  return items;
}
