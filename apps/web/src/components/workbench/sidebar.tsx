import {
  CirclePlus,
  FolderGit2,
  GitBranch,
  LogOut,
  Monitor,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import type { DaemonInfo, Project, Workspace } from "@coflux/protocol";

import { Button } from "@/components/ui/button";
import type { CofluxClient } from "@/hooks/use-coflux-client";
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

export function Sidebar({
  client,
  selectedWorkspaceId,
  onSelectWorkspace,
  onImportProject,
  onCreateWorkspace,
  onRemoveProject,
  onRemoveWorkspace,
  onAddDevice,
  onRemoveDevice,
}: SidebarProps) {
  const workspacesOf = (projectId: string) =>
    client.workspaces
      .filter((workspace) => workspace.projectId === projectId)
      .sort((left, right) => (left.isMain === right.isMain ? left.createdAt - right.createdAt : left.isMain ? -1 : 1));

  return (
    <aside className="flex h-screen w-[272px] shrink-0 flex-col border-r border-border bg-sidebar text-sm">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
        <div className="flex size-7 items-center justify-center rounded-md bg-primary text-xs font-black tracking-tighter text-primary-foreground">co</div>
        <span className="font-semibold tracking-tight text-foreground">coflux</span>
        <span
          className={cn(
            "ml-1 size-1.5 rounded-full",
            client.status === "connected" ? "bg-success" : client.status === "connecting" ? "bg-warning" : "bg-destructive",
          )}
          title={STATUS_TEXT[client.status]}
        />
        <Button className="ml-auto" variant="ghost" size="icon-sm" onClick={client.logout} title="退出登录">
          <LogOut />
        </Button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col">
        <section className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
          <div className="mb-2 flex items-center px-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">项目</span>
            <Button className="ml-auto h-7 px-2 text-[11px]" variant="ghost" size="sm" onClick={onImportProject}>
              <Plus className="size-3.5" />
              导入
            </Button>
          </div>

          {client.projects.length === 0 && (
            <button
              className="flex w-full flex-col items-start rounded-lg border border-dashed border-border px-3 py-4 text-left transition-colors hover:border-ring/40 hover:bg-accent/30"
              onClick={onImportProject}
            >
              <span className="text-xs font-medium text-foreground">还没有项目</span>
              <span className="mt-1 text-[11px] leading-4 text-muted-foreground">导入在线设备上的 git 仓库开始使用</span>
            </button>
          )}

          <div className="space-y-1">
            {client.projects.map((project) => {
              const projectWorkspaces = workspacesOf(project.id);
              const mainWorkspace = projectWorkspaces.find((workspace) => workspace.isMain);
              const childWorkspaces = projectWorkspaces.filter((workspace) => !workspace.isMain);
              const daemon = client.daemons.find((item) => item.daemonId === project.daemonId);
              const mainActive = mainWorkspace?.id === selectedWorkspaceId;

              return (
                <div key={project.id} className="group/project">
                  <div
                    className={cn(
                      "group/row flex h-9 items-center rounded-md transition-colors",
                      mainActive ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/55 hover:text-foreground",
                    )}
                  >
                    <button
                      className="flex min-w-0 flex-1 items-center gap-2 self-stretch px-2 text-left"
                      onClick={() => mainWorkspace && onSelectWorkspace(mainWorkspace.id)}
                      disabled={!mainWorkspace}
                      title={project.repoPath}
                    >
                      <FolderGit2 className={cn("size-4 shrink-0", mainActive ? "text-primary" : "text-muted-foreground")} />
                      <span className="truncate text-xs font-medium">{project.name}</span>
                      {daemon && <span className={cn("ml-auto size-1.5 shrink-0 rounded-full", daemon.online ? "bg-success" : "bg-muted-foreground/45")} title={daemon.name} />}
                    </button>
                    <div className="mr-1 flex items-center opacity-0 transition-opacity group-hover/row:opacity-100 focus-within:opacity-100">
                      <button
                        className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                        onClick={() => onCreateWorkspace(project)}
                        title="新建工作区"
                      >
                        <CirclePlus className="size-3.5" />
                      </button>
                      <button
                        className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                        onClick={() => onRemoveProject(project)}
                        title="移除项目"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </div>
                  </div>

                  {childWorkspaces.length > 0 && (
                    <div className="relative ml-4 border-l border-border/80 pl-2">
                      {childWorkspaces.map((workspace) => {
                        const active = workspace.id === selectedWorkspaceId;
                        return (
                          <div
                            key={workspace.id}
                            className={cn(
                              "group/workspace flex min-h-8 items-center rounded-md transition-colors",
                              active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/55 hover:text-foreground",
                            )}
                          >
                            <button
                              className="flex min-w-0 flex-1 items-center gap-2 self-stretch px-2 py-1 text-left"
                              onClick={() => onSelectWorkspace(workspace.id)}
                              title={`${workspace.path}\n${workspace.branch}`}
                            >
                              <GitBranch className={cn("size-3.5 shrink-0", active && "text-primary")} />
                              <span className="truncate text-[11px]">{workspace.name}</span>
                              <span className="ml-auto max-w-20 truncate font-mono text-[9px] text-muted-foreground/70">{workspace.branch}</span>
                            </button>
                            <button
                              className="mr-1 flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover/workspace:opacity-100 focus-visible:opacity-100"
                              onClick={() => onRemoveWorkspace(workspace)}
                              title="删除工作区"
                            >
                              <X className="size-3.5" />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        <section className="max-h-[42%] shrink-0 overflow-y-auto border-t border-border px-2 py-3">
          <div className="mb-2 flex items-center px-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">设备</span>
            <Button className="ml-auto h-7 px-2 text-[11px]" variant="ghost" size="sm" onClick={onAddDevice}>
              <Plus className="size-3.5" />
              添加
            </Button>
          </div>

          {client.daemons.length === 0 && (
            <button className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs text-muted-foreground hover:bg-accent/50" onClick={onAddDevice}>
              <Monitor className="size-4" />
              添加第一台设备
            </button>
          )}

          <div className="space-y-0.5">
            {client.daemons.map((daemon) => (
              <div key={daemon.daemonId} className="group/device flex h-8 items-center gap-2 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent/50 hover:text-foreground">
                <span className={cn("size-1.5 rounded-full", daemon.online ? "bg-success" : "bg-muted-foreground/45")} />
                <Monitor className="size-3.5" />
                <span className="min-w-0 flex-1 truncate" title={`${daemon.host}/${daemon.platform}`}>{daemon.name}</span>
                <button
                  className="flex size-6 items-center justify-center rounded text-muted-foreground opacity-0 hover:bg-destructive/10 hover:text-destructive group-hover/device:opacity-100 focus-visible:opacity-100"
                  onClick={() => onRemoveDevice(daemon)}
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
