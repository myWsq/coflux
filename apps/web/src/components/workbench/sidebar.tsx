import { For, Show } from "solid-js";
import { CirclePlus, FolderGit2, GitBranch, LogOut, Monitor, Plus, Trash2, X } from "lucide-solid";
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
  const workspacesOf = (projectId: string) =>
    client
      .workspaces()
      .filter((workspace) => workspace.projectId === projectId)
      .sort((left, right) => (left.isMain === right.isMain ? left.createdAt - right.createdAt : left.isMain ? -1 : 1));

  return (
    <aside class="flex h-screen w-[260px] shrink-0 flex-col border-r border-border bg-sidebar text-[13px]">
      <header class="flex h-11 shrink-0 items-center gap-2 px-3">
        <span class="text-[13px] font-medium tracking-tight text-foreground">coflux</span>
        <span
          class={cn(
            "size-1.5 rounded-full",
            client.status() === "connected" ? "bg-success" : client.status() === "connecting" ? "bg-warning" : "bg-destructive",
          )}
          title={STATUS_TEXT[client.status()]}
        />
        <Button class="ml-auto text-muted-foreground" variant="ghost" size="icon-sm" onClick={() => client.logout()} title="退出登录">
          <LogOut class="size-3.5" />
        </Button>
      </header>

      <div class="flex min-h-0 flex-1 flex-col">
        <section class="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          <div class="mb-1.5 flex h-7 items-center px-2">
            <span class="text-[11px] text-muted-foreground">项目</span>
            <button
              class="ml-auto flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              onClick={() => props.onImportProject()}
              title="导入项目"
            >
              <Plus class="size-3.5" />
            </button>
          </div>

          <Show when={client.projects().length === 0}>
            <button
              class="mx-1 flex w-[calc(100%-0.5rem)] flex-col items-start rounded-md border border-dashed border-border px-3 py-3.5 text-left transition-colors hover:bg-accent/60"
              onClick={() => props.onImportProject()}
            >
              <span class="text-[12px] font-medium text-foreground">还没有项目</span>
              <span class="mt-1 text-[11px] leading-4 text-muted-foreground">导入在线设备上的 git 仓库开始使用</span>
            </button>
          </Show>

          <div class="space-y-0.5">
            <For each={client.projects()}>
              {(project) => {
                const projectWorkspaces = () => workspacesOf(project.id);
                const mainWorkspace = () => projectWorkspaces().find((workspace) => workspace.isMain);
                const childWorkspaces = () => projectWorkspaces().filter((workspace) => !workspace.isMain);
                const daemon = () => client.daemons().find((item) => item.daemonId === project.daemonId);
                const mainActive = () => mainWorkspace()?.id === props.selectedWorkspaceId;

                return (
                  <div class="group/project">
                    <div
                      class={cn(
                        "group/row flex h-8 items-center rounded-md transition-colors",
                        mainActive() ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/70 hover:text-foreground",
                      )}
                    >
                      <button
                        class="flex min-w-0 flex-1 items-center gap-2 self-stretch px-2 text-left"
                        onClick={() => {
                          const workspace = mainWorkspace();
                          if (workspace) props.onSelectWorkspace(workspace.id);
                        }}
                        disabled={!mainWorkspace()}
                        title={project.repoPath}
                      >
                        <FolderGit2 class="size-3.5 shrink-0 opacity-80" />
                        <span class="truncate text-[12px]">{project.name}</span>
                        <Show when={daemon()}>
                          {(item) => (
                            <span
                              class={cn("ml-auto size-1.5 shrink-0 rounded-full", item().online ? "bg-success" : "bg-muted-foreground/40")}
                              title={item().name}
                            />
                          )}
                        </Show>
                      </button>
                      <div class="mr-0.5 flex items-center opacity-0 transition-opacity group-hover/row:opacity-100 focus-within:opacity-100">
                        <button
                          class="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                          onClick={() => props.onCreateWorkspace(project)}
                          title="新建工作区"
                        >
                          <CirclePlus class="size-3.5" />
                        </button>
                        <button
                          class="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                          onClick={() => props.onRemoveProject(project)}
                          title="移除项目"
                        >
                          <Trash2 class="size-3.5" />
                        </button>
                      </div>
                    </div>

                    <Show when={childWorkspaces().length > 0}>
                      <div class="ml-3 space-y-0.5 border-l border-border pl-1.5">
                        <For each={childWorkspaces()}>
                          {(workspace) => (
                            <div
                              class={cn(
                                "group/workspace flex h-7 items-center rounded-md transition-colors",
                                workspace.id === props.selectedWorkspaceId
                                  ? "bg-accent text-foreground"
                                  : "text-muted-foreground hover:bg-accent/70 hover:text-foreground",
                              )}
                            >
                              <button
                                class="flex min-w-0 flex-1 items-center gap-2 self-stretch px-2 text-left"
                                onClick={() => props.onSelectWorkspace(workspace.id)}
                                title={`${workspace.path}\n${workspace.branch}`}
                              >
                                <GitBranch class="size-3 shrink-0 opacity-70" />
                                <span class="truncate text-[12px]">{workspace.name}</span>
                                <span class="ml-auto max-w-20 truncate font-mono text-[10px] text-muted-foreground/70">{workspace.branch}</span>
                              </button>
                              <button
                                class="mr-0.5 flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover/workspace:opacity-100 focus-visible:opacity-100"
                                onClick={() => props.onRemoveWorkspace(workspace)}
                                title="删除工作区"
                              >
                                <X class="size-3.5" />
                              </button>
                            </div>
                          )}
                        </For>
                      </div>
                    </Show>
                  </div>
                );
              }}
            </For>
          </div>
        </section>

        <section class="max-h-[42%] shrink-0 overflow-y-auto border-t border-border px-2 py-2.5">
          <div class="mb-1.5 flex h-7 items-center px-2">
            <span class="text-[11px] text-muted-foreground">设备</span>
            <button
              class="ml-auto flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              onClick={() => props.onAddDevice()}
              title="添加设备"
            >
              <Plus class="size-3.5" />
            </button>
          </div>

          <Show when={client.daemons().length === 0}>
            <button
              class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-muted-foreground hover:bg-accent/70"
              onClick={() => props.onAddDevice()}
            >
              <Monitor class="size-3.5" />
              添加第一台设备
            </button>
          </Show>

          <div class="space-y-0.5">
            <For each={client.daemons()}>
              {(daemon) => (
                <div class="group/device flex h-7 items-center gap-2 rounded-md px-2 text-[12px] text-muted-foreground hover:bg-accent/70 hover:text-foreground">
                  <span class={cn("size-1.5 rounded-full", daemon.online ? "bg-success" : "bg-muted-foreground/40")} />
                  <Monitor class="size-3.5 opacity-70" />
                  <span class="min-w-0 flex-1 truncate" title={`${daemon.host}/${daemon.platform}`}>
                    {daemon.name}
                  </span>
                  <button
                    class="flex size-6 items-center justify-center rounded-md text-muted-foreground opacity-0 hover:bg-destructive/10 hover:text-destructive group-hover/device:opacity-100 focus-visible:opacity-100"
                    onClick={() => props.onRemoveDevice(daemon)}
                    title="移除设备"
                  >
                    <Trash2 class="size-3.5" />
                  </button>
                </div>
              )}
            </For>
          </div>
        </section>
      </div>
    </aside>
  );
}
