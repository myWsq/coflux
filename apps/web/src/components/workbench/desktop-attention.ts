import { workspaceActivity, type SessionAgentState } from "@coflux/client";
import type { DaemonInfo, Project, Task, Workspace } from "@coflux/protocol";

/**
 * 桌面通知 / Dock 角标的数据源（plan 103）：从侧栏现成的活动聚合（workspaceActivity）里抽出
 * 「等待人」的两态——approval / question。纯函数，渲染进程按 store 变化驱动，主进程只执行。
 */
export type AttentionKind = "approval" | "question";

export type AttentionEntry = {
  kind: AttentionKind;
  agent: string;
  /** question 态 agent 留的话（cofluxd notify），没有则空 */
  message?: string;
  projectName?: string;
  branch: string;
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
    if (activity.status !== "approval" && activity.status !== "question") continue;
    snapshot[workspace.id] = {
      kind: activity.status,
      agent: activity.agent,
      message: activity.status === "question" ? activity.message : undefined,
      projectName: input.projects.find((project) => project.id === workspace.projectId)?.name,
      branch: workspace.branch,
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

/** 通知文案：标题说明「谁在等什么」，正文定位到项目/分支；提问态附 agent 留言。 */
export function attentionNotificationText(entry: AttentionEntry): { title: string; body: string } {
  const where = entry.projectName ? `${entry.projectName} · ${entry.branch}` : entry.branch;
  if (entry.kind === "approval") {
    return { title: `${entry.agent} 等待批准`, body: where };
  }
  return { title: `${entry.agent} 等待回答`, body: entry.message ? `${where}\n${entry.message}` : where };
}
