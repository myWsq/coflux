import { useState } from "react";
import { useStore } from "zustand";
import { ContextMenu } from "@astryxdesign/core/ContextMenu";
import { ChevronRight, Folder, FolderOpen, FolderPlus, GitBranch, Monitor, Plus, Trash2, X } from "lucide-react";
import type { DaemonInfo, Project, Workspace } from "@coflux/protocol";

import { BranchMenu, type BranchTaken } from "@/components/workbench/branch-menu";
import type { CofluxClient } from "@/client/store";
import { cn } from "@/lib/utils";

type SidebarProps = {
  client: CofluxClient;
  selectedWorkspaceId: string | null;
  onSelectWorkspace: (workspaceId: string) => void;
  onImportProject: () => void;
  onCreateWorkspace: (project: Project, branch: string, createNew: boolean) => void;
  onRemoveProject: (project: Project) => void;
  onRemoveWorkspace: (workspace: Workspace) => void;
  onRenameWorkspace: (workspace: Workspace) => void;
  onAddDevice: () => void;
  onRemoveDevice: (daemon: DaemonInfo) => void;
};

export function Sidebar(props: SidebarProps) {
  const client = props.client;
  const projects = useStore(client.store, (state) => state.projects);
  const workspaces = useStore(client.store, (state) => state.workspaces);
  const daemons = useStore(client.store, (state) => state.daemons);
  // 默认全部展开，只记折叠集合（新项目出现时自然是展开态）
  const [collapsedIds, setCollapsedIds] = useState<ReadonlySet<string>>(new Set());
  /** 新建工作区菜单当前打开的项目（受控：+ 按钮与右键菜单项共用同一个锚点菜单） */
  const [createMenuProjectId, setCreateMenuProjectId] = useState<string | null>(null);

  function toggleProject(projectId: string) {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  }

  /** 在项目主工作区里列本地分支（exec 走该项目所在 daemon） */
  async function listProjectBranches(project: Project) {
    const main = client.store.getState().workspaces.find((workspace) => workspace.projectId === project.id && workspace.isMain);
    if (!main) return { ok: false, branches: [], error: "项目主工作区不存在" };
    const result = await client.execInWorkspace(main.id, "git", ["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
    if (!result.ok || result.exitCode !== 0) {
      return { ok: false, branches: [], error: result.error || result.stderr.trim() || "获取分支列表失败" };
    }
    return { ok: true, branches: result.stdout.split("\n").map((line) => line.trim()).filter(Boolean), error: "" };
  }

  const takenBranchesOf = (projectId: string): Map<string, BranchTaken> =>
    new Map(
      workspaces
        .filter((workspace) => workspace.projectId === projectId)
        .map((workspace) => [
          workspace.branch,
          { hint: "已被检出", reason: `已被工作区「${workspace.name}」检出，同一分支不能检出到两个 worktree` },
        ]),
    );

  const workspacesOf = (projectId: string) =>
    workspaces
      .filter((workspace) => workspace.projectId === projectId)
      .sort((left, right) => (left.isMain === right.isMain ? left.createdAt - right.createdAt : left.isMain ? -1 : 1));

  return (
    <aside className="flex h-screen w-[260px] shrink-0 flex-col border-r border-border bg-sidebar text-base">
      <div className="flex min-h-0 flex-1 flex-col pt-1.5">
        <section className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          <div className="mb-1.5 flex h-7 items-center px-2">
            <span className="text-xs text-muted-foreground">项目</span>
            <button
              className="ml-auto flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              onClick={() => props.onImportProject()}
              title="导入项目"
            >
              <FolderPlus className="size-3.5" />
            </button>
          </div>

          {projects.length === 0 ? (
            <button
              className="mx-1 flex w-[calc(100%-0.5rem)] flex-col items-start rounded-md border border-dashed border-border px-3 py-3.5 text-left transition-colors hover:bg-accent/60"
              onClick={() => props.onImportProject()}
            >
              <span className="text-base font-medium text-foreground">还没有项目</span>
              <span className="mt-1 text-xs leading-4 text-muted-foreground">导入在线设备上的 git 仓库开始使用</span>
            </button>
          ) : null}

          <div className="space-y-0.5">
            {projects.map((project) => {
              const projectWorkspaces = workspacesOf(project.id);
              const daemon = daemons.find((item) => item.daemonId === project.daemonId);
              const expanded = !collapsedIds.has(project.id);

              return (
                <div className="group/project" key={project.id}>
                  <ContextMenu
                    label={`项目「${project.name}」操作`}
                    size="sm"
                    items={[
                      { label: "新建工作区", onClick: () => setCreateMenuProjectId(project.id) },
                      { type: "divider" },
                      { label: "移除项目", onClick: () => props.onRemoveProject(project) },
                    ]}
                  >
                    <div className="group/row flex h-8 items-center rounded-md text-secondary-foreground transition-colors hover:bg-accent/70 hover:text-foreground">
                      <button
                        className="flex min-w-0 flex-1 items-center gap-2 self-stretch px-2 text-left"
                        onClick={() => toggleProject(project.id)}
                        title={project.repoPath}
                      >
                        {/* Cursor 式图标槽：默认按展开态显示 开/合 文件夹，hover 时原位换成箭头 */}
                        {expanded ? (
                          <FolderOpen className="size-3.5 shrink-0 opacity-80 group-hover/row:hidden" />
                        ) : (
                          <Folder className="size-3.5 shrink-0 opacity-80 group-hover/row:hidden" />
                        )}
                        <ChevronRight
                          className={cn("hidden size-3.5 shrink-0 opacity-60 group-hover/row:block", expanded && "rotate-90")}
                        />
                        <span className="truncate text-base">{project.name}</span>
                        {/* 正常（设备在线）零噪音；仅异常时显示灰点提示 */}
                        {!daemon?.online ? (
                          <span
                            className="ml-auto size-1.5 shrink-0 rounded-full bg-muted-foreground/40"
                            title={daemon ? `设备「${daemon.name}」离线` : "设备记录缺失"}
                          />
                        ) : null}
                      </button>
                      <div
                        className={cn(
                          "mr-1 flex items-center gap-0.5 opacity-0 transition-opacity group-hover/row:opacity-100 focus-within:opacity-100",
                          createMenuProjectId === project.id && "opacity-100",
                        )}
                      >
                        <BranchMenu
                          button={{
                            label: "新建工作区",
                            icon: <Plus className="size-3" />,
                            isIconOnly: true,
                            variant: "ghost",
                            size: "sm",
                            tooltip: "新建工作区",
                            style: { color: "var(--muted-foreground)", height: 20, width: 20, minWidth: 20, paddingInline: 0 },
                          }}
                          isOpen={createMenuProjectId === project.id}
                          onOpenChange={(open) => setCreateMenuProjectId(open ? project.id : null)}
                          listBranches={() => listProjectBranches(project)}
                          takenBranches={takenBranchesOf(project.id)}
                          onPick={(branch, createNew) => props.onCreateWorkspace(project, branch, createNew)}
                        />
                      </div>
                    </div>
                  </ContextMenu>

                  {expanded && projectWorkspaces.length > 0 ? (
                    <div className="ml-3 space-y-0.5 border-l border-border pl-1.5">
                      {projectWorkspaces.map((workspace) => (
                        <ContextMenu
                          key={workspace.id}
                          label={`工作区「${workspace.branch}」操作`}
                          size="sm"
                          items={[
                            { label: "重命名", onClick: () => props.onRenameWorkspace(workspace) },
                            ...(!workspace.isMain
                              ? [{ type: "divider" } as const, { label: "删除工作区", onClick: () => props.onRemoveWorkspace(workspace) }]
                              : []),
                          ]}
                        >
                          <div
                            className={cn(
                              "group/workspace relative flex h-7 items-center rounded-md transition-colors",
                              workspace.id === props.selectedWorkspaceId
                                ? "bg-accent text-foreground"
                                : "text-secondary-foreground hover:bg-accent/70 hover:text-foreground",
                            )}
                          >
                            <button
                              className="flex min-w-0 flex-1 items-center gap-2 self-stretch px-2 text-left"
                              onClick={() => props.onSelectWorkspace(workspace.id)}
                              title={`${workspace.path}\n${workspace.branch}`}
                            >
                              <GitBranch className={cn("size-3 shrink-0", workspace.isMain ? "text-warning" : "opacity-70")} />
                              <span className="min-w-0 flex-1 truncate text-base">{workspace.branch}</span>
                              {/* 右端小字：自定义名称（name ≠ branch 时才有）；主工作区未起名时默认叫「主工作区」。
                                  hover 渐变淡出给删除按钮让位 */}
                              {(() => {
                                const label =
                                  workspace.name && workspace.name !== workspace.branch
                                    ? workspace.name
                                    : workspace.isMain
                                      ? "主工作区"
                                      : null;
                                return label ? (
                                  <span
                                    className={cn(
                                      "max-w-24 truncate text-xs text-muted-foreground",
                                      !workspace.isMain &&
                                        "group-hover/workspace:[mask-image:linear-gradient(to_left,transparent_18px,black_44px)]",
                                    )}
                                    title={label}
                                  >
                                    {label}
                                  </span>
                                ) : null;
                              })()}
                            </button>
                            {/* 主工作区不可删除：不渲染删除入口（服务端同样会拒绝，此处是入口层收敛） */}
                            {!workspace.isMain ? (
                              <button
                                className="absolute right-1 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground opacity-0 transition-all hover:bg-muted hover:text-foreground group-hover/workspace:opacity-100 focus-visible:opacity-100"
                                onClick={() => props.onRemoveWorkspace(workspace)}
                                title="删除工作区"
                              >
                                <X className="size-3" />
                              </button>
                            ) : null}
                          </div>
                        </ContextMenu>
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
            <span className="text-xs text-muted-foreground">设备</span>
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
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-base text-muted-foreground hover:bg-accent/70"
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
                className="group/device flex h-7 items-center gap-2 rounded-md px-2 text-base text-secondary-foreground hover:bg-accent/70 hover:text-foreground"
              >
                <span className={cn("size-1.5 rounded-full", daemon.online ? "bg-success animate-pulse-alive" : "bg-muted-foreground/40")} />
                <Monitor className="size-3.5 opacity-70" />
                <span
                  className="min-w-0 flex-1 truncate"
                  title={`${daemon.host}/${daemon.platform}${daemon.workerVersion ? ` · worker ${daemon.workerVersion}` : ""}${daemon.supervisorVersion ? ` · supervisor ${daemon.supervisorVersion}` : ""}`}
                >
                  {daemon.name}
                </span>
                <button
                  className="flex size-5 items-center justify-center rounded text-muted-foreground opacity-0 transition-all hover:bg-muted hover:text-foreground group-hover/device:opacity-100 focus-visible:opacity-100"
                  onClick={() => props.onRemoveDevice(daemon)}
                  title="移除设备"
                >
                  <Trash2 className="size-3" />
                </button>
              </div>
            ))}
          </div>
        </section>
      </div>
    </aside>
  );
}
