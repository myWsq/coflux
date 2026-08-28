import type { AuthState, ConnectionStatus } from "@coflux/client";
import { TaskStatus, type DaemonInfo, type Project, type Workspace } from "@coflux/protocol";

/** 主工作台当前应展示的顶层页面。把认证分支集中成纯决策，避免新增状态误落到登录失败页。 */
export type WorkbenchSurface = "authenticating" | "outdated" | "login" | "workspace";

export function resolveWorkbenchSurface(authState: AuthState): WorkbenchSurface {
  if (authState === "authenticating") return "authenticating";
  if (authState === "outdated") return "outdated";
  if (authState === "authed") return "workspace";
  return "login";
}

/** 中心连接非 connected 时继续展示最后快照，并为顶部重连横幅留位。 */
export function shouldShowReconnectBanner(status: ConnectionStatus): boolean {
  return status !== "connected";
}

/** 保活的后台工作区不得拉取 diff；只有当前工作区内的「变更」视图才算激活。 */
export function shouldActivateChangesView(
  workspaceActive: boolean,
  view: "terminal" | "changes",
): boolean {
  return workspaceActive && view === "changes";
}

/** 浏览器离开工作台前必须触发原生确认；浏览器不允许自定义提示文案。 */
export function requestWorkbenchExitConfirmation(
  event: Pick<BeforeUnloadEvent, "preventDefault" | "returnValue">,
): void {
  event.preventDefault();
  event.returnValue = "";
}

/** 仍在运行的终端先确认；已退出的历史 Tab 可直接关闭。 */
export function taskCloseNeedsConfirmation(status: TaskStatus): boolean {
  return status === TaskStatus.RUNNING;
}

export type WorkbenchSelection = { kind: "workspace" | "device"; id: string };

const DEVICE_SELECTION_PREFIX = "device:";

export function parseStoredSelection(raw: string | null): WorkbenchSelection | null {
  if (!raw) return null;
  if (raw.startsWith(DEVICE_SELECTION_PREFIX)) {
    return { kind: "device", id: raw.slice(DEVICE_SELECTION_PREFIX.length) };
  }
  return { kind: "workspace", id: raw };
}

export function serializeSelection(selection: WorkbenchSelection | null): string | null {
  if (!selection) return null;
  return selection.kind === "device" ? `${DEVICE_SELECTION_PREFIX}${selection.id}` : selection.id;
}

type SelectionProject = Pick<Project, "id" | "createdAt">;
type SelectionWorkspace = Pick<Workspace, "id" | "projectId" | "isMain">;
type SelectionDaemon = Pick<DaemonInfo, "daemonId">;

export type SelectionResolution = {
  selection: WorkbenchSelection | null;
  /** false 表示继续沿用传入对象，组件无需 setState。 */
  changed: boolean;
  /** 乐观工作区是假 id，不能把它重复写成稳定选择。 */
  shouldPersist: boolean;
};

/**
 * 快照到达后校准工作台选择：离线设备仍有效，乐观工作区暂时有效；失效项优先回退到
 * 最早项目的 main workspace，再回退到任一工作区。
 */
export function resolveWorkbenchSelection(input: {
  selection: WorkbenchSelection | null;
  pendingWorkspaceIds: ReadonlySet<string>;
  projects: readonly SelectionProject[];
  workspaces: readonly SelectionWorkspace[];
  daemons: readonly SelectionDaemon[];
}): SelectionResolution {
  const { selection, pendingWorkspaceIds, projects, workspaces, daemons } = input;
  const pending = selection?.kind === "workspace" && pendingWorkspaceIds.has(selection.id);
  const valid =
    pending ||
    (selection?.kind === "device"
      ? daemons.some((daemon) => daemon.daemonId === selection.id)
      : selection?.kind === "workspace" && workspaces.some((workspace) => workspace.id === selection.id));

  if (selection && valid) {
    return { selection, changed: false, shouldPersist: !pending };
  }

  const firstProject = [...projects].sort((left, right) => left.createdAt - right.createdAt)[0];
  const fallback =
    (firstProject && workspaces.find((workspace) => workspace.projectId === firstProject.id && workspace.isMain)) ??
    workspaces[0];
  const next: WorkbenchSelection | null = fallback ? { kind: "workspace", id: fallback.id } : null;
  const changed = selection?.kind !== next?.kind || selection?.id !== next?.id;
  return { selection: next, changed, shouldPersist: true };
}

/**
 * 任务列表变化后的 active Tab。关闭 active Tab（或其从快照消失）时回到第一项；
 * 关闭后台 Tab 时保留当前选择；乐观 pending Tab 在转正前也属于有效选择。
 */
export function resolveActiveTaskId(
  activeTaskId: string | null,
  taskIds: readonly string[],
  pendingTaskId: string | null,
): string | null {
  if (activeTaskId && (taskIds.includes(activeTaskId) || activeTaskId === pendingTaskId)) return activeTaskId;
  return taskIds[0] ?? null;
}

/** pending 创建失败/超时仅在它仍是 active Tab 时回退，避免抢走用户后来选择的 Tab。 */
export function resolveActiveTaskIdAfterPendingDrop(
  activeTaskId: string | null,
  pendingTaskId: string,
  taskIds: readonly string[],
): string | null {
  return activeTaskId === pendingTaskId ? (taskIds[0] ?? null) : activeTaskId;
}
