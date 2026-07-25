import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useStore } from "zustand";
import { ContextMenu } from "@astryxdesign/core/ContextMenu";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import { ChevronRight, Cloud, Cog, Folder, FolderOpen, FolderPlus, GitBranch, Info, Monitor, Package, Plus, Trash2, X, Zap, type LucideIcon } from "lucide-react";
import type { DaemonInfo, Project, Workspace } from "@coflux/protocol";

import { BranchMenu, type BranchTaken } from "@/components/workbench/branch-menu";
import { shortcutModifierPrefix, useIsStandalone } from "@/components/workbench/use-shortcut-modifier";
import type { CofluxClient } from "@coflux/client";
import { SIDEBAR_WIDTH_KEY } from "@/config";
import { cn } from "@/lib/utils";

/** 心跳往返低于此值算「快」（绿），否则「慢」（黄）。局域网直连通常个位数到几十 ms，
 * 跨洲 relay 常在 200ms 以上——阈值取在这两簇之间，而不是取某个整数好看。 */
const RTT_GOOD_MS = 200;

const DEFAULT_SIDEBAR_WIDTH = 260;
const MIN_SIDEBAR_WIDTH = 200;
const MAX_SIDEBAR_WIDTH = 480;

function clampSidebarWidth(width: number) {
  if (!Number.isFinite(width)) return DEFAULT_SIDEBAR_WIDTH;
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width));
}

function readSidebarWidth() {
  try {
    const stored = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    if (stored === null || stored.trim() === "") return DEFAULT_SIDEBAR_WIDTH;
    return clampSidebarWidth(Number(stored));
  } catch {
    return DEFAULT_SIDEBAR_WIDTH;
  }
}

function persistSidebarWidth(width: number) {
  try {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(clampSidebarWidth(width)));
  } catch {
    // localStorage 不可用时仍保留本次会话中的宽度。
  }
}

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
  onRenameDevice: (daemon: DaemonInfo) => void;
  /** 新建工作区菜单当前打开的项目（受控：+ 按钮/右键菜单项/Cmd+Ctrl+N 快捷键共用同一个锚点菜单） */
  createMenuProjectId: string | null;
  onCreateMenuProjectIdChange: (projectId: string | null) => void;
};

export function Sidebar(props: SidebarProps) {
  const client = props.client;
  const projects = useStore(client.store, (state) => state.projects);
  const workspaces = useStore(client.store, (state) => state.workspaces);
  const daemons = useStore(client.store, (state) => state.daemons);
  const tasks = useStore(client.store, (state) => state.tasks);
  const localSessions = useStore(client.store, (state) => state.localSessions);
  const deviceTransports = useStore(client.store, (state) => state.deviceTransports);
  // 默认全部展开，只记折叠集合（新项目出现时自然是展开态）
  const [collapsedIds, setCollapsedIds] = useState<ReadonlySet<string>>(new Set());
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth);
  const [isResizing, setIsResizing] = useState(false);
  const sidebarWidthRef = useRef(sidebarWidth);
  const resizeRef = useRef<{
    pointerId: number;
    startX: number;
    startWidth: number;
    handle: HTMLDivElement;
    previousCursor: string;
    previousUserSelect: string;
  } | null>(null);
  const createMenuProjectId = props.createMenuProjectId;
  const setCreateMenuProjectId = props.onCreateMenuProjectIdChange;
  const modPrefix = shortcutModifierPrefix(useIsStandalone());

  function updateSidebarWidth(width: number) {
    const nextWidth = clampSidebarWidth(width);
    sidebarWidthRef.current = nextWidth;
    setSidebarWidth(nextWidth);
  }

  function restoreResizeEnvironment() {
    const resize = resizeRef.current;
    if (!resize) return;
    resizeRef.current = null;
    document.documentElement.style.cursor = resize.previousCursor;
    document.documentElement.style.userSelect = resize.previousUserSelect;
    if (resize.handle.hasPointerCapture(resize.pointerId)) {
      resize.handle.releasePointerCapture(resize.pointerId);
    }
  }

  function finishResize(pointerId: number) {
    if (resizeRef.current?.pointerId !== pointerId) return;
    restoreResizeEnvironment();
    setIsResizing(false);
    persistSidebarWidth(sidebarWidthRef.current);
  }

  function handleResizeStart(event: ReactPointerEvent<HTMLDivElement>) {
    if (!event.isPrimary || event.button !== 0 || resizeRef.current) return;
    event.preventDefault();
    const handle = event.currentTarget;
    resizeRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: sidebarWidthRef.current,
      handle,
      previousCursor: document.documentElement.style.cursor,
      previousUserSelect: document.documentElement.style.userSelect,
    };
    handle.setPointerCapture(event.pointerId);
    document.documentElement.style.cursor = "col-resize";
    document.documentElement.style.userSelect = "none";
    setIsResizing(true);
  }

  function handleResizeMove(event: ReactPointerEvent<HTMLDivElement>) {
    const resize = resizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    updateSidebarWidth(resize.startWidth + event.clientX - resize.startX);
  }

  function handleResizeEnd(event: ReactPointerEvent<HTMLDivElement>) {
    const resize = resizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    updateSidebarWidth(resize.startWidth + event.clientX - resize.startX);
    finishResize(event.pointerId);
  }

  function resetSidebarWidth() {
    updateSidebarWidth(DEFAULT_SIDEBAR_WIDTH);
    persistSidebarWidth(DEFAULT_SIDEBAR_WIDTH);
  }

  useEffect(
    () => () => {
      restoreResizeEnvironment();
    },
    [],
  );

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
    <aside
      className="relative flex h-screen shrink-0 flex-col border-r border-border bg-sidebar text-base"
      style={{ width: sidebarWidth }}
    >
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
                            tooltip: `新建工作区 ${modPrefix}N`,
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
                              {/* 右端内容：自定义名称（name ≠ branch 时才有；主工作区未起名时默认叫「主工作区」）+ git diff 累计统计（plan 024，X=Y=0 时不渲染）。
                                  diff 固定在最末；两者作为整体 hover 渐变淡出给删除按钮让位 */}
                              {(() => {
                                const label =
                                  workspace.name && workspace.name !== workspace.branch
                                    ? workspace.name
                                    : workspace.isMain
                                      ? "主工作区"
                                      : null;
                                const hasDiff = workspace.additions > 0 || workspace.deletions > 0;
                                if (!label && !hasDiff) return null;
                                return (
                                  <span
                                    className={cn(
                                      "flex shrink-0 items-center gap-2",
                                      !workspace.isMain &&
                                        "group-hover/workspace:[mask-image:linear-gradient(to_left,transparent_18px,black_44px)]",
                                    )}
                                  >
                                    {label ? (
                                      <span className="max-w-24 truncate text-xs text-muted-foreground" title={label}>
                                        {label}
                                      </span>
                                    ) : null}
                                    {hasDiff ? (
                                      <span
                                        className="whitespace-nowrap font-mono text-xs tabular-nums"
                                        title={`+${workspace.additions} −${workspace.deletions}`}
                                      >
                                        <span className="text-success">+{workspace.additions}</span>{" "}
                                        <span className="text-destructive">−{workspace.deletions}</span>
                                      </span>
                                    ) : null}
                                  </span>
                                );
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
            {daemons.map((daemon) => {
              const transport = deviceTransports[daemon.daemonId];
              const orphans = localSessions.filter(
                (session) => session.daemonId === daemon.daemonId && session.status === "running" &&
                  !tasks.some((task) => task.id === session.taskId && task.sessionId === session.sessionId),
              );
              const routeLabel = transport?.mode === "direct"
                ? "本机直连"
                : transport?.mode === "relay"
                  ? "中心 relay"
                  : transport?.mode === "probing"
                    ? "正在探测"
                    : transport?.mode === "offline"
                      ? "Device route 离线"
                      : daemon.online ? "中心在线" : "中心离线";
              // 色标语义（2026-07-26 改）：颜色只表达延迟，不再表达走哪条路——relay 只要够快
              // 就该是绿的。传输方式由**形状**承担，且只占一个位置：direct 时闪电取代圆点，
              // 而不是并排两个图标；离线是空心圈。
              // 规则：状态差异走色相或形状，绝不走透明度（6px 圆点上 alpha 差肉眼等同）。
              const rttMs = transport?.rttMs;
              const connected = transport?.mode === "direct" || transport?.mode === "relay";
              // tone 只管颜色，让圆点（bg-*）与闪电（text-*）共用同一套延迟分档。
              const tone = transport?.mode === "probing"
                ? "primary"
                : transport?.mode === "offline"
                  ? "destructive"
                  : connected
                    ? rttMs === undefined ? "muted" : rttMs < RTT_GOOD_MS ? "success" : "warning"
                    : daemon.online ? "muted" : "hollow";
              const dotClass = tone === "primary"
                ? "bg-primary animate-pulse"
                : tone === "destructive"
                  ? "bg-destructive/70"
                  : tone === "success"
                    ? "bg-success animate-pulse-alive"
                    : tone === "warning"
                      ? "bg-warning"
                      : tone === "muted"
                        ? "bg-muted-foreground/70"
                        : "ring-1 ring-inset ring-muted-foreground/60";
              const zapClass = tone === "success"
                ? "text-success"
                : tone === "warning" ? "text-warning" : "text-muted-foreground";
              const rttText = rttMs === undefined ? "" : ` · ${Math.round(rttMs)}ms`;
              // 挂在整行而非那个 12px 图标上：图标太小，只挂它等于挂了个瞄不准的靶子。
              // 用组件库 Tooltip 而非原生 title：原生要悬停约 1s 才弹，且弹出后内容不再随
              // 心跳更新——延迟读数正是每 15s 会变的东西。
              // 布局照 Cursor：一行标题说结论（走哪条路 + 多快），下面是图标条目列表铺上下文。
              const tooltipRows: { icon: LucideIcon; text: string }[] = [
                { icon: Monitor, text: `${daemon.host} / ${daemon.platform}` },
                ...(daemon.workerVersion ? [{ icon: Package, text: `worker ${daemon.workerVersion}` }] : []),
                ...(daemon.supervisorVersion ? [{ icon: Cog, text: `supervisor ${daemon.supervisorVersion}` }] : []),
                ...(transport?.detail ? [{ icon: Info, text: transport.detail }] : []),
              ];
              const tooltipContent = (
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center gap-1.5 font-medium text-foreground">
                    {transport?.mode === "direct" ? <Zap className="size-3 shrink-0" /> : <Cloud className="size-3 shrink-0" />}
                    {routeLabel}{rttText}
                  </div>
                  <div className="flex flex-col gap-1">
                    {tooltipRows.map((row) => (
                      <span key={row.text} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <row.icon className="size-3 shrink-0 opacity-70" />
                        <span className="truncate">{row.text}</span>
                      </span>
                    ))}
                  </div>
                </div>
              );
              return (
                <ContextMenu
                  key={daemon.daemonId}
                  label={`设备「${daemon.name}」操作`}
                  size="sm"
                  items={[
                    { label: "重命名", onClick: () => props.onRenameDevice(daemon) },
                    { type: "divider" },
                    { label: "移除设备", onClick: () => props.onRemoveDevice(daemon) },
                  ]}
                >
                  <Tooltip content={tooltipContent} placement="end" hasHoverIndication={false}>
                    <div className="group/device flex h-7 items-center gap-2 rounded-md px-2 text-base text-secondary-foreground hover:bg-accent/70 hover:text-foreground">
                      {/* 固定 12px 槽位：闪电与圆点尺寸不同，不统一宽度设备名会参差。 */}
                      <span className="flex size-3 shrink-0 items-center justify-center">
                        {transport?.mode === "direct" ? (
                          <Zap className={cn("size-3", zapClass)} aria-label={`本机直连${rttText}`} />
                        ) : (
                          <span className={cn("size-1.5 rounded-full", dotClass)} />
                        )}
                      </span>
                      <Monitor className="size-3.5 opacity-70" />
                      <span className="min-w-0 flex-1 truncate">
                        {daemon.name}
                      </span>
                      {orphans.length > 0 ? (
                        <span
                          className="shrink-0 rounded bg-warning/10 px-1 text-2xs text-warning"
                          title={`本机存在 ${orphans.length} 个中心 catalog 未登记的存活 session：${orphans.map((item) => item.sessionId).join(", ")}`}
                        >
                          本地 {orphans.length}
                        </span>
                      ) : null}
                      <button
                        className="flex size-5 items-center justify-center rounded text-muted-foreground opacity-0 transition-all hover:bg-muted hover:text-foreground group-hover/device:opacity-100 focus-visible:opacity-100"
                        onClick={() => props.onRemoveDevice(daemon)}
                        title="移除设备"
                      >
                        <Trash2 className="size-3" />
                      </button>
                    </div>
                  </Tooltip>
                </ContextMenu>
              );
            })}
          </div>
        </section>
      </div>
      <div
        className="group/resize absolute inset-y-0 -right-[3px] z-20 w-1.5 cursor-col-resize touch-none"
        onDoubleClick={resetSidebarWidth}
        onLostPointerCapture={(event) => finishResize(event.pointerId)}
        onPointerCancel={(event) => finishResize(event.pointerId)}
        onPointerDown={handleResizeStart}
        onPointerMove={handleResizeMove}
        onPointerUp={handleResizeEnd}
      >
        <div
          className={cn(
            "pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors",
            isResizing ? "bg-primary/70" : "bg-transparent group-hover/resize:bg-primary/50",
          )}
        />
      </div>
    </aside>
  );
}
