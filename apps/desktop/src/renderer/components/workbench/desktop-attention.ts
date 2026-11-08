import { workspaceActivity, type SessionAgentState } from "@coflux/client";
import type { DaemonInfo, Project, Task, Workspace } from "@coflux/protocol";

/**
 * 桌面通知 / Dock 角标的数据源（plan 103）：从侧栏现成的活动聚合（workspaceActivity）里抽出
 * 「等待人」的两态——approval / question。纯函数，渲染进程按 store 变化驱动，主进程只执行。
 * A program stopped on an error (`error`, from OSC 7501) also needs the user, so it counts too.
 */
export type AttentionKind = "approval" | "question" | "error";

export type AttentionEntry = {
  kind: AttentionKind;
  agent: string;
  /** What the agent said about what it needs (a `coflux notify` message or an OSC 7501 msg); empty when it said nothing. */
  message?: string;
  projectName?: string;
  branch: string;
  /** The waiting terminal: the same task whose agent is named above, so a click lands where the title points. */
  taskId?: string;
};

/** workspaceId → 等待态；不在其中的工作区 = 不需要人 */
export type AttentionSnapshot = Record<string, AttentionEntry>;

export function attentionSnapshot(input: {
  workspaces: readonly Workspace[];
  daemons: readonly Pick<DaemonInfo, "daemonId" | "online">[];
  tasks: readonly Task[];
  sessionAgents: Record<string, SessionAgentState>;
  projects: readonly Pick<Project, "id" | "name">[];
}): AttentionSnapshot {
  const snapshot: AttentionSnapshot = {};
  for (const workspace of input.workspaces) {
    const daemon = input.daemons.find((item) => item.daemonId === workspace.daemonId);
    const activity = workspaceActivity(workspace.id, daemon?.online ?? false, input.tasks, input.sessionAgents);
    if (activity.status !== "approval" && activity.status !== "question" && activity.status !== "error") continue;
    snapshot[workspace.id] = {
      kind: activity.status,
      agent: activity.agent,
      message: activity.message,
      projectName: input.projects.find((project) => project.id === workspace.projectId)?.name,
      branch: workspace.branch,
      taskId: activity.taskId,
    };
  }
  return snapshot;
}

export type AttentionDiff = {
  /** 本次快照里「新进入等待」的工作区：之前不在等待，或等待种类变了（approval ↔ question） */
  entered: { workspaceId: string; entry: AttentionEntry }[];
  /** Dock 角标 = 仍在等待的工作区数 */
  badgeCount: number;
};

/**
 * 去重规则：同一工作区同一等待态只提醒一次；恢复（离开等待）后再进入才再次提醒；
 * 等待种类变化（批准 → 提问）视为新事件。角标按当前快照计数，恢复即减、全部恢复清零。
 */
export function diffAttention(previous: AttentionSnapshot, next: AttentionSnapshot): AttentionDiff {
  const entered: AttentionDiff["entered"] = [];
  for (const [workspaceId, entry] of Object.entries(next)) {
    if (previous[workspaceId]?.kind !== entry.kind) entered.push({ workspaceId, entry });
  }
  return { entered, badgeCount: Object.keys(next).length };
}

/** Notification text: the title says who is waiting on what, the body names the project and
 * branch, followed by the agent's message when it left one. */
export function attentionNotificationText(entry: AttentionEntry): { title: string; body: string } {
  const where = entry.projectName ? `${entry.projectName} · ${entry.branch}` : entry.branch;
  const title =
    entry.kind === "approval"
      ? `${entry.agent} 等待批准`
      : entry.kind === "error"
        ? `${entry.agent} 出错停止`
        : `${entry.agent} 等待回答`;
  return { title, body: entry.message ? `${where}\n${entry.message}` : where };
}
