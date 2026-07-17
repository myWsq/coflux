import { useStore } from "zustand";
import { CirclePlus, FolderGit2, GitBranch, LogOut, Monitor, Plus, Trash2, X } from "lucide-react";
import type { DaemonInfo, Project, Workspace } from "@coflux/protocol";

import { Button } from "@/components/ui/button";
import type { CofluxClient } from "@/client/store";
import { cn } from "@/lib/utils";

type SidebarProps = {
  client: CofluxClient;
  selectedWorkspaceId: string | null;
  onSelectWorkspace: (workspaceId: string) => void;
  onImportProject: () => void;
  onCreateWorkspace: (project: Project) => void;
  onRemoveProject: (project: Project) => void;
  onRemoveWorkspace: (workspace: Workspace) => void;
  onAddDevice: () => void;
  onRemoveDevice: (daemon: DaemonInfo) => void;
};

const STATUS_TEXT = {
  connected: "已连接",
  connecting: "连接中",
  disconnected: "未连接",
} as const;

export function Sidebar(props: SidebarProps) {
  const client = props.client;
  const status = useStore(client.store, (state) => state.status);
  const projects = useStore(client.store, (state) => state.projects);
  const workspaces = useStore(client.store, (state) => state.workspaces);
  const daemons = useStore(client.store, (state) => state.daemons);

  const workspacesOf = (projectId: string) =>
    workspaces
      .filter((workspace) => workspace.projectId === projectId)
      .sort((left, right) => (left.isMain === right.isMain ? left.createdAt - right.createdAt : left.isMain ? -1 : 1));

  return (
    <aside className="flex h-screen w-[260px] shrink-0 flex-col border-r border-border bg-sidebar text-[13px]">
      <header className="flex h-11 shrink-0 items-center gap-2 px-3">
        <span className="text-[13px] font-medium tracking-tight text-foreground">coflux</span>
        <span
          className={cn(
            "size-1.5 rounded-full",
            status === "connected" ? "bg-success animate-pulse-alive" : status === "connecting" ? "bg-warning" : "bg-destructive",
          )}
          title={STATUS_TEXT[status]}
        />
        <Button className="ml-auto text-muted-foreground" variant="ghost" size="icon-sm" onClick={() => client.logout()} title="退出登录">
          <LogOut className="size-3.5" />
        </Button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col">
        <section className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          <div className="mb-1.5 flex h-7 items-center px-2">
            <span className="text-[11px] text-muted-foreground">项目</span>
            <button
              className="ml-auto flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              onClick={() => props.onImportProject()}
              title="导入项目"
            >
              <Plus className="size-3.5" />
            </button>
          </div>

          {projects.length === 0 ? (
            <button
              className="mx-1 flex w-[calc(100%-0.5rem)] flex-col items-start rounded-md border border-dashed border-border px-3 py-3.5 text-left transition-colors hover:bg-accent/60"
              onClick={() => props.onImportProject()}
            >
              <span className="text-[12px] font-medium text-foreground">还没有项目</span>
              <span className="mt-1 text-[11px] leading-4 text-muted-foreground">导入在线设备上的 git 仓库开始使用</span>
            </button>
          ) : null}

          <div className="space-y-0.5">
            {projects.map((project) => {
              const projectWorkspaces = workspacesOf(project.id);
              const mainWorkspace = projectWorkspaces.find((workspace) => workspace.isMain);
              const childWorkspaces = projectWorkspaces.filter((workspace) => !workspace.isMain);
              const daemon = daemons.find((item) => item.daemonId === project.daemonId);
              const mainActive = mainWorkspace?.id === props.selectedWorkspaceId;

              return (
                <div className="group/project" key={project.id}>
                  <div
                    className={cn(
                      "group/row flex h-8 items-center rounded-md transition-colors",
                      mainActive ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/70 hover:text-foreground",
                    )}
                  >
                    <button
                      className="flex min-w-0 flex-1 items-center gap-2 self-stretch px-2 text-left"
                      onClick={() => {
                        if (mainWorkspace) props.onSelectWorkspace(mainWorkspace.id);
                      }}
                      disabled={!mainWorkspace}
                      title={project.repoPath}
                    >
                      <FolderGit2 className="size-3.5 shrink-0 opacity-80" />
                      <span className="truncate text-[12px]">{project.name}</span>
                      {daemon ? (
                        <span className={cn("ml-auto size-1.5 shrink-0 rounded-full", daemon.online ? "bg-success" : "bg-muted-foreground/40")} title={daemon.name} />
                      ) : null}
                    </button>
                    <div className="mr-0.5 flex items-center opacity-0 transition-opacity group-hover/row:opacity-100 focus-within:opacity-100">
                      <button
                        className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                        onClick={() => props.onCreateWorkspace(project)}
                        title="新建工作区"
                      >
                        <CirclePlus className="size-3.5" />
                      </button>
                      <button
                        className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                        onClick={() => props.onRemoveProject(project)}
                        title="移除项目"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </div>
                  </div>

                  {childWorkspaces.length > 0 ? (
                    <div className="ml-3 space-y-0.5 border-l border-border pl-1.5">
                      {childWorkspaces.map((workspace) => (
                        <div
                          key={workspace.id}
                          className={cn(
                            "group/workspace flex h-7 items-center rounded-md transition-colors",
                            workspace.id === props.selectedWorkspaceId
                              ? "bg-accent text-foreground"
                              : "text-muted-foreground hover:bg-accent/70 hover:text-foreground",
                          )}
                        >
                          <button
                            className="flex min-w-0 flex-1 items-center gap-2 self-stretch px-2 text-left"
                            onClick={() => props.onSelectWorkspace(workspace.id)}
                            title={`${workspace.path}\n${workspace.branch}`}
                          >
                            <GitBranch className="size-3 shrink-0 opacity-70" />
                            <span className="truncate text-[12px]">{workspace.name}</span>
                            <span className="ml-auto max-w-20 truncate font-mono text-[10px] text-muted-foreground/70">{workspace.branch}</span>
                          </button>
                          <button
                            className="mr-0.5 flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover/workspace:opacity-100 focus-visible:opacity-100"
                            onClick={() => props.onRemoveWorkspace(workspace)}
                            title="删除工作区"
                          >
                            <X className="size-3.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </section>

        <section className="max-h-[42%] shrink-0 overflow-y-auto border-t border-border px-2 py-2.5">
          <div className="mb-1.5 flex h-7 items-center px-2">
            <span className="text-[11px] text-muted-foreground">设备</span>
            <button
              className="ml-auto flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              onClick={() => props.onAddDevice()}
              title="添加设备"
            >
              <Plus className="size-3.5" />
            </button>
          </div>

          {daemons.length === 0 ? (
            <button
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-muted-foreground hover:bg-accent/70"
              onClick={() => props.onAddDevice()}
            >
              <Monitor className="size-3.5" />
              添加第一台设备
            </button>
          ) : null}

          <div className="space-y-0.5">
            {daemons.map((daemon) => (
              <div
                key={daemon.daemonId}
                className="group/device flex h-7 items-center gap-2 rounded-md px-2 text-[12px] text-muted-foreground hover:bg-accent/70 hover:text-foreground"
              >
                <span className={cn("size-1.5 rounded-full", daemon.online ? "bg-success animate-pulse-alive" : "bg-muted-foreground/40")} />
                <Monitor className="size-3.5 opacity-70" />
                <span className="min-w-0 flex-1 truncate" title={`${daemon.host}/${daemon.platform}`}>
                  {daemon.name}
                </span>
                <button
                  className="flex size-6 items-center justify-center rounded-md text-muted-foreground opacity-0 hover:bg-destructive/10 hover:text-destructive group-hover/device:opacity-100 focus-visible:opacity-100"
                  onClick={() => props.onRemoveDevice(daemon)}
                  title="移除设备"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            ))}
          </div>
        </section>
      </div>
    </aside>
  );
}
