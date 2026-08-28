/**
 * prepared operation report 的持久化收敛。
 *
 * 模块只负责在一个数据库事务内验证 operation/目标版本并产出显式 effect；它不直接广播、
 * 不维护在线 session，也不接触 WebSocket。Hub 在设备删除 guard 下消费 effect，继续拥有运行时
 * authority 与对外可见副作用。
 */
import {
  create,
  ProjectSchema,
  TaskStatus,
  WorkspaceSchema,
  type AccountId,
  type DaemonId,
  type DeviceEnvelope,
  type DeviceOperationReport,
  type Project,
  type ProjectId,
  type SessionId,
  type Task,
  type TaskId,
  type Workspace,
  type WorkspaceId,
} from "@coflux/protocol";
import type { PreparedOperationRecord, Store } from "./store.js";

export interface OperationEffect {
  accountId: AccountId;
  daemonId: DaemonId;
  project?: Project;
  workspace?: Workspace;
  task?: Task;
  sessionId?: SessionId;
  removedTaskIds?: TaskId[];
  cancelledPreparedOperationIds?: string[];
  removedWorkspaceId?: WorkspaceId;
  deletingProjectId?: ProjectId;
  error?: string;
}

export type OperationConvergenceOutcome =
  | { case: "ignored" }
  | { case: "failed"; operation: PreparedOperationRecord; message: string }
  | { case: "applied"; effect: OperationEffect };

interface ReportingDaemon {
  daemonId: DaemonId;
  accountId: AccountId;
}

class OperationConvergenceError extends Error {}

function parseMetadata(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function metadataString(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function basename(path: string): string {
  const parts = path.replace(/[/\\]+$/, "").split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

const converge = async (
  store: Store,
  daemon: ReportingDaemon,
  report: DeviceOperationReport,
  payload: DeviceEnvelope["payload"],
): Promise<OperationConvergenceOutcome> => {
  let effect: OperationEffect | undefined;
  try {
    await store.transaction(async (tx) => {
      // removeDevice 也以 device 父行为事务的第一把锁。report 先锁父行再锁
      // operation/project，既防删除事务读完子项后插回孤儿，也避免锁顺序反转。
      const device = await tx.claimActiveDevice(daemon.daemonId, daemon.accountId);
      if (!device) return;
      const operation = await tx.claimPreparedOperationReport(report.operationId, daemon.daemonId);
      if (
        !operation ||
        operation.accountId !== daemon.accountId ||
        operation.daemonId !== daemon.daemonId
      ) return;
      const metadata = parseMetadata(operation.metadata);
      if (!metadata) throw new OperationConvergenceError("prepared operation metadata 损坏");

      effect = { accountId: operation.accountId, daemonId: operation.daemonId };
      if (!report.ok) {
        effect.error = report.error ?? "设备操作失败";
      } else if (operation.kind === "project.import" && payload.case === "projectValidated") {
        const value = payload.value;
        const projectId = metadataString(metadata, "projectId");
        const workspaceId = metadataString(metadata, "workspaceId");
        if (!projectId || !workspaceId || !value.repoPath || !value.branch) {
          throw new OperationConvergenceError("project.import report 缺少收敛字段");
        }
        const suggestedName = value.suggestedName?.trim();
        const explicitName = metadataString(metadata, "explicitName");
        const ts = Date.now();
        const project = create(ProjectSchema, {
          id: projectId,
          accountId: operation.accountId,
          daemonId: operation.daemonId,
          name: explicitName ?? (suggestedName || basename(value.repoPath)),
          repoPath: value.repoPath,
          // 优先 worker 探测的仓库真实默认分支；探测不到才回退导入时所在分支。
          defaultBranch: value.defaultBranch?.trim() || value.branch,
          createdAt: ts,
        });
        const workspace = create(WorkspaceSchema, {
          id: workspaceId,
          accountId: operation.accountId,
          daemonId: operation.daemonId,
          projectId,
          name: value.branch,
          path: value.repoPath,
          branch: value.branch,
          isMain: true,
          createdAt: ts,
        });
        await tx.createProject(project);
        await tx.createWorkspace(workspace);
        effect.project = project;
        effect.workspace = workspace;
      } else if (operation.kind === "worktree.add" && payload.case === "worktreeAdded") {
        const value = payload.value;
        const projectId = metadataString(metadata, "projectId");
        const workspaceId = metadataString(metadata, "workspaceId");
        const name = metadataString(metadata, "name");
        if (!projectId || !workspaceId || !name || !value.path || !value.branch) {
          throw new OperationConvergenceError("worktree.add report 缺少收敛字段");
        }
        const project = await tx.claimActiveProject(projectId);
        if (
          !project ||
          project.accountId !== operation.accountId ||
          project.daemonId !== operation.daemonId
        ) throw new OperationConvergenceError("worktree.add target project 已失效或正在删除");
        const workspace = create(WorkspaceSchema, {
          id: workspaceId,
          accountId: operation.accountId,
          daemonId: operation.daemonId,
          projectId,
          name,
          path: value.path,
          branch: value.branch,
          isMain: false,
          createdAt: Date.now(),
        });
        await tx.createWorkspace(workspace);
        effect.workspace = workspace;
      } else if (operation.kind === "worktree.remove" && payload.case === "operationAck") {
        const workspaceId = metadataString(metadata, "workspaceId");
        const projectId = metadataString(metadata, "projectId");
        if (!workspaceId || !projectId) {
          throw new OperationConvergenceError("worktree.remove report 缺少收敛字段");
        }
        const workspace = await tx.getWorkspace(workspaceId);
        if (
          workspace &&
          (workspace.accountId !== operation.accountId ||
            workspace.daemonId !== operation.daemonId ||
            workspace.projectId !== projectId ||
            workspace.isMain ||
            workspace.createdAt !== operation.targetVersion)
        ) throw new OperationConvergenceError("worktree.remove target version/CAS 已变化");
        if (workspace) {
          const removedTaskIds = await tx.removeTasksByWorkspace(workspace.id);
          const cancelledPreparedOperationIds: string[] = [];
          const now = Date.now();
          for (const taskId of removedTaskIds) {
            cancelledPreparedOperationIds.push(...await tx.expirePreparedOperationsByTarget(
              operation.accountId,
              operation.daemonId,
              "session.create",
              taskId,
              now,
            ));
          }
          for (const taskId of removedTaskIds) await tx.removeSessionCheckpointsByTask(taskId);
          await tx.removeWorkspace(workspace.id);
          effect.removedTaskIds = removedTaskIds;
          effect.cancelledPreparedOperationIds = cancelledPreparedOperationIds;
          effect.removedWorkspaceId = workspace.id;
        }
        // standalone workspace 删除时 finalizer 会因 project.deleting=false 安全空转；若同一 op
        // 后来被 projectRemove 复用，则仍能完成项目级收口。
        effect.deletingProjectId = projectId;
      } else if (operation.kind === "session.create" && payload.case === "operationAck") {
        const value = payload.value;
        const taskId = metadataString(metadata, "taskId");
        const sessionId = metadataString(metadata, "sessionId");
        if (
          !taskId ||
          !sessionId ||
          value.sessionId !== sessionId ||
          (report.taskId !== undefined && report.taskId !== taskId) ||
          (report.sessionId !== undefined && report.sessionId !== sessionId)
        ) throw new OperationConvergenceError("session.create report 绑定不匹配");
        const task = await tx.getTask(taskId);
        if (!task || task.accountId !== operation.accountId || task.daemonId !== operation.daemonId) {
          throw new OperationConvergenceError("session.create target task 已失效");
        }
        let updated = task;
        if (task.status !== TaskStatus.RUNNING || task.sessionId !== sessionId) {
          if (task.status === TaskStatus.RUNNING || task.sessionId || task.updatedAt !== operation.targetVersion) {
            throw new OperationConvergenceError("session.create target version/CAS 已变化");
          }
          const changed = await tx.updateTask(task.id, {
            status: TaskStatus.RUNNING,
            sessionId,
            exitCode: undefined,
          });
          if (!changed) throw new OperationConvergenceError("session.create target task 已删除");
          updated = changed;
        }
        effect.task = updated;
        effect.sessionId = sessionId;
      } else {
        throw new OperationConvergenceError(`prepared operation result 类型不匹配: ${operation.kind}`);
      }

      const finished = await tx.finishPreparedOperation(operation.operationId, report);
      if (!finished) throw new Error("prepared operation report 提交冲突");
    });
  } catch (error) {
    if (!(error instanceof OperationConvergenceError)) throw error;
    const failed = await store.failPreparedOperationConvergence(
      report.operationId,
      daemon.daemonId,
      error.message,
    );
    return failed
      ? { case: "failed", operation: failed, message: error.message }
      : { case: "ignored" };
  }

  return effect ? { case: "applied", effect } : { case: "ignored" };
};

export const PreparedOperationConvergenceService = { converge };
