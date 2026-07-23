import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { ChevronRight, FolderGit2, GitBranch, LoaderCircle } from "lucide-react";
import { TaskStatus } from "@coflux/protocol";

import { EmptyState } from "@astryxdesign/core/EmptyState";
import { List, ListItem } from "@astryxdesign/core/List";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import type { CofluxClient } from "@coflux/client";
import { cn } from "@/lib/utils";

type WorkspaceListProps = {
  client: CofluxClient;
  onSelectWorkspace: (workspaceId: string) => void;
};

/** 首页：按项目分组的工作区列表（IA 决策，plan 032）。导入/新建/管理均留在桌面端，
 * 这里只读——任务状态、diff 统计、设备在线是驱动 agent 前"先看现场"要的最小信息面。 */
export function WorkspaceList({ client, onSelectWorkspace }: WorkspaceListProps) {
  const projects = useStore(client.store, useShallow((state) => state.projects));
  const workspaces = useStore(client.store, useShallow((state) => state.workspaces));
  const daemons = useStore(client.store, useShallow((state) => state.daemons));
  const tasks = useStore(client.store, useShallow((state) => state.tasks));
  const status = useStore(client.store, (state) => state.status);

  const sortedProjects = [...projects].sort((a, b) => a.createdAt - b.createdAt);

  function workspacesOf(projectId: string) {
    return workspaces
      .filter((workspace) => workspace.projectId === projectId)
      .sort((a, b) => (a.isMain === b.isMain ? a.createdAt - b.createdAt : a.isMain ? -1 : 1));
  }

  function runningCount(workspaceId: string) {
    return tasks.filter((task) => task.workspaceId === workspaceId && task.status === TaskStatus.RUNNING).length;
  }

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
        <span className="text-base font-semibold">coflux</span>
        {status !== "connected" ? (
          <span className="ml-auto flex items-center gap-1.5 text-xs text-warning">
            <LoaderCircle className="size-3 animate-spin" />
            重连中…
          </span>
        ) : null}
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {sortedProjects.length === 0 ? (
          <EmptyState
            icon={<FolderGit2 className="size-6" />}
            title="还没有项目"
            description="在桌面端 coflux 导入设备上的 git 仓库后，这里会出现对应的工作区。"
          />
        ) : (
          <div className="flex flex-col gap-4">
            {sortedProjects.map((project) => {
              const daemon = daemons.find((item) => item.daemonId === project.daemonId);
              const projectWorkspaces = workspacesOf(project.id);
              return (
                <List
                  key={project.id}
                  hasDividers
                  density="spacious"
                  header={
                    <div className="flex items-center gap-1.5 px-1 text-sm font-medium text-secondary-foreground">
                      <FolderGit2 className="size-3.5 opacity-70" />
                      <span className="truncate">{project.name}</span>
                      {!daemon?.online ? (
                        <span
                          className="size-1.5 shrink-0 rounded-full bg-muted-foreground/40"
                          title={daemon ? `设备「${daemon.name}」离线` : "设备记录缺失"}
                        />
                      ) : null}
                    </div>
                  }
                >
                  {projectWorkspaces.map((workspace) => {
                    const running = runningCount(workspace.id);
                    const hasDiff = workspace.additions > 0 || workspace.deletions > 0;
                    const description = workspace.isMain
                      ? "主工作区"
                      : workspace.name && workspace.name !== workspace.branch
                        ? workspace.name
                        : undefined;
                    return (
                      <ListItem
                        key={workspace.id}
                        label={workspace.branch}
                        description={description}
                        startContent={
                          <GitBranch className={cn("size-3.5", workspace.isMain ? "text-warning" : "text-muted-foreground")} />
                        }
                        endContent={
                          <div className="flex items-center gap-2.5">
                            {hasDiff ? (
                              <span className="whitespace-nowrap font-mono text-xs tabular-nums">
                                <span className="text-success">+{workspace.additions}</span>{" "}
                                <span className="text-destructive">−{workspace.deletions}</span>
                              </span>
                            ) : null}
                            {running > 0 ? <StatusDot variant="success" label={`${running} 个终端运行中`} isPulsing /> : null}
                            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                          </div>
                        }
                        onClick={() => onSelectWorkspace(workspace.id)}
                      />
                    );
                  })}
                </List>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}
