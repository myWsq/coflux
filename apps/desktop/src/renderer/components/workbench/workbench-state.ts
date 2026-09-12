import type { AuthState, ConnectionStatus } from "@coflux/client";
import { TaskStatus } from "@coflux/protocol";

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

/**
 * 任务列表变化后的 active Tab。关闭 active Tab（或其从快照消失）时回到第一项；
 * 关闭后台 Tab 时保留当前选择；乐观 pending Tab 在转正前也属于有效选择。
 * followTaskId 是被搬进本工作区、要求继续当活动 Tab 的终端（plan 104），优先级最高。
 */
export function resolveActiveTaskId(
  activeTaskId: string | null,
  taskIds: readonly string[],
  pendingTaskId: string | null,
  followTaskId: string | null = null,
): string | null {
  if (followTaskId && taskIds.includes(followTaskId)) return followTaskId;
  if (activeTaskId && (taskIds.includes(activeTaskId) || activeTaskId === pendingTaskId)) return activeTaskId;
  return taskIds[0] ?? null;
}

/**
 * 终端换了工作区（plan 104：agent 进出 git worktree，中心把 tasks.workspace_id 搬走）后的
 * 工作台选中态。只有"被搬走的正是当前展示工作区的活动 Tab"才跟过去——用户正看着的终端不该
 * 凭空消失。其余情况（非活动 Tab 被搬走、task 被删、没有活动 Tab）返回 null 表示选中不动，
 * 由工作区容器内既有的活动 Tab 回退逻辑处理。
 */
export function resolveSelectionAfterTaskMove(input: {
  /** 主区实际展示的工作区（设备选中时是它解析出的目录工作区） */
  activeWorkspaceId: string | null;
  /** 该工作区当前的活动 Tab */
  activeTaskId: string | null;
  tasks: readonly { id: string; workspaceId: string }[];
}): WorkbenchSelection | null {
  const { activeWorkspaceId, activeTaskId, tasks } = input;
  if (!activeWorkspaceId || !activeTaskId) return null;
  const moved = tasks.find((task) => task.id === activeTaskId);
  if (!moved || moved.workspaceId === activeWorkspaceId) return null;
  return { kind: "workspace", id: moved.workspaceId };
}

/** pending 创建失败/超时仅在它仍是 active Tab 时回退，避免抢走用户后来选择的 Tab。 */
export function resolveActiveTaskIdAfterPendingDrop(
  activeTaskId: string | null,
  pendingTaskId: string,
  taskIds: readonly string[],
): string | null {
  return activeTaskId === pendingTaskId ? (taskIds[0] ?? null) : activeTaskId;
}
