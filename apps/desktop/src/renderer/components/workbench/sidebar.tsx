import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { ContextMenu } from "@astryxdesign/core/ContextMenu";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import { ChevronRight, Cloud, FileDiff, Folder, FolderOpen, FolderPlus, GitBranch, LoaderCircle, MessageSquare, Monitor, Plus, Radio, Trash2, X, Zap } from "lucide-react";
import { SCREEN_CAPABILITY, type DaemonInfo, type Project, type Workspace } from "@coflux/protocol";

import { AgentGlyph } from "@/components/workbench/agent-glyph";
import { AccountFooter, type SettingsTooltipControl } from "@/components/workbench/account-footer";
import { BranchMenu, type BranchTaken } from "@/components/workbench/branch-menu";
import { candidateSessionTitles, currentTerminals, type CurrentTerminalRow } from "@/components/workbench/current-terminals";
import { DESKTOP_DRAG_BAND_STYLE } from "@/components/workbench/drag-region";
import { DeviceOsMark, deviceOsName } from "@/components/workbench/device-os";
import { copyEntityHandle } from "@/components/workbench/entity-handle";
import { executorTaskIds as executorTaskIdsOf } from "@/components/workbench/executor-run";
import { ActivityDots } from "@/components/workbench/pending-dots";
import { ensureProjectExpanded, readExpandedProjects, summarizeProjectActivity, toggleExpandedProject, type ExpandedProjectsStore } from "@/components/workbench/project-rows";
import { screenResolutionLabel } from "@/components/workbench/screen-resolution";
import type { ScreenRuntime } from "@/components/workbench/screen-runtime";
import { useScreenSessionState } from "@/components/workbench/screen-view";
import { SHORTCUT_MODIFIER_PREFIX } from "@/components/workbench/shortcut-modifier";
import { SidebarToggleButton } from "@/components/workbench/sidebar-collapse";
import { SidebarResizeHandle } from "@/components/workbench/sidebar-resize-handle";
import { SidebarSectionDivider } from "@/components/workbench/sidebar-section-divider";
import { useSidebarSectionSizes } from "@/components/workbench/use-sidebar-section-sizes";
import type { SidebarWidthControl } from "@/components/workbench/use-sidebar-width";
import { projectWorkspacesInOrder, visibleProjects } from "@/components/workbench/workspace-order";
import { workspaceActivity, workspaceProgress, type CofluxClient, type WorkspaceActivity } from "@coflux/client";
import { PROJECTS_EXPANDED_KEY } from "@/config";
import { cn } from "@/lib/utils";

/** 心跳往返低于此值算「快」（绿），否则「慢」（黄）。局域网直连通常个位数到几十 ms，
 * 跨洲 relay 常在 200ms 以上——阈值取在这两簇之间，而不是取某个整数好看。 */
const RTT_GOOD_MS = 200;

const IDLE: WorkspaceActivity = { status: "idle" };

/** 把侧栏里带 data-reveal-key 的行滚进视野（nearest：已可见不动）；行还没渲染出来返回 false。 */
function scrollRevealTarget(root: HTMLElement | null, key: string): boolean {
  const row = root?.querySelector(`[data-reveal-key="${CSS.escape(key)}"]`);
  if (!row) return false;
  row.scrollIntoView({ block: "nearest" });
  return true;
}

/** The expanded projects (plan 20261109-sidebar-current-section), injected into the pure store module. */
const EXPANDED_PROJECTS_STORE: ExpandedProjectsStore = { storage: localStorage, key: PROJECTS_EXPANDED_KEY };

function activityLabel(activity: WorkspaceActivity): string {
  if (activity.status === "idle") return "";
  const name = activity.agent ? `${activity.agent} ` : "";
  if (activity.status === "active") return `${name}正在执行`;
  if (activity.status === "approval") return `${name}等待批准`;
  if (activity.status === "question") return `${name}等待回答`;
  if (activity.status === "error") return `${name}出错停止`;
  return `${name}本轮完成`;
}

function ActivityIcon({ activity, labeled }: { activity: WorkspaceActivity; labeled?: boolean }) {
  if (activity.status === "idle") return null;
  return <ActivityDots status={activity.status} label={labeled ? activityLabel(activity) : undefined} />;
}

/**
 * One workspace row in the project tree: the custom name and the diff trail the branch, with the
 * hover × delete button for non-main workspaces.
 */
function WorkspaceRow({
  workspace,
  project,
  daemon,
  activity,
  executorBusy,
  progress,
  selected,
  onSelect,
  onRename,
  onRemove,
}: {
  workspace: Workspace;
  project: Project;
  daemon: DaemonInfo | undefined;
  activity: WorkspaceActivity;
  executorBusy: boolean;
  progress: string | undefined;
  selected: boolean;
  onSelect: () => void;
  onRename: () => void;
  onRemove: () => void;
}) {
  const label =
    workspace.name && workspace.name !== workspace.branch
      ? workspace.name
      : workspace.isMain
        ? "主工作区"
        : null;
  const hasDiff = workspace.additions > 0 || workspace.deletions > 0;
  // worker 侧 diff_stat 的基准是 merge-base(defaultBranch, HEAD) 比到工作树：当前分支
  // 就是默认分支（或默认分支缺失）时 base 即 HEAD 自身，数字实为本地未提交改动（含
  // untracked），说成「相对 X 的变更」是同义反复且会被读成分支间历史 diff。
  const diffAgainstSelf = !project.defaultBranch || workspace.branch === project.defaultBranch;
  const activityText = activityLabel(activity);
  // 工作区详情 tooltip（需求勘误：原 plan 048-task-tab-tooltip 做到了任务 Tab 上，
  // 真正诉求是侧栏工作区行——版式照抄设备 tooltip：加粗标题行 + 图标条目列表）
  const workspaceTooltip = (
    <div className="flex flex-col gap-1">
      <div className="font-medium">
        {workspace.branch}
        {label ? ` · ${label}` : ""}
      </div>
      <div className="flex flex-col gap-0.5">
        {activity.status !== "idle" ? (
          <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <ActivityIcon activity={activity} />
            <span className="truncate">{activityText}</span>
          </span>
        ) : null}
        {executorBusy ? (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <ActivityDots status="active" />
            <span className="truncate">executor 正在执行子任务</span>
          </span>
        ) : null}
        {/* What the agent said about what it needs (a `coflux notify` message,
            plan 074, or an OSC 7501 msg): the icon only says it is waiting or
            stopped. Not truncated: the message is the content; the worker
            already clamped it. */}
        {(activity.status === "approval" || activity.status === "question" || activity.status === "error") &&
        activity.message ? (
          <span className="flex items-start gap-1.5 text-sm text-foreground">
            <MessageSquare className="mt-0.5 size-3 shrink-0 opacity-70" />
            <span className="whitespace-pre-wrap break-words">{activity.message}</span>
          </span>
        ) : null}
        {/* 进度短评（plan 088）：agent 主动播报「干到哪了」，不 truncate 同 notify 理由。 */}
        {progress ? (
          <span className="flex items-start gap-1.5 text-sm text-muted-foreground">
            <LoaderCircle className="mt-0.5 size-3 shrink-0 opacity-70" />
            <span className="whitespace-pre-wrap break-words">{progress}</span>
          </span>
        ) : null}
        <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Folder className="size-3 shrink-0 opacity-70" />
          <span className="truncate">{workspace.path}</span>
        </span>
        <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <DeviceOsMark platform={daemon?.platform} className="size-3 shrink-0 opacity-70" />
          <span className="truncate">{daemon ? `${daemon.name}（${daemon.online ? "在线" : "离线"}）` : "设备记录缺失"}</span>
        </span>
        {hasDiff ? (
          <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <FileDiff className="size-3 shrink-0 opacity-70" />
            <span className="truncate">{diffAgainstSelf ? "未提交改动" : `相对 ${project.defaultBranch} 的变更`} +{workspace.additions} −{workspace.deletions}</span>
          </span>
        ) : null}
      </div>
    </div>
  );
  return (
    <ContextMenu
      label={`工作区「${workspace.branch}」操作`}
      size="sm"
      items={[
        { label: "重命名", onClick: onRename },
        { label: "复制标识", onClick: () => copyEntityHandle("workspace", workspace.id) },
        ...(!workspace.isMain
          ? [{ type: "divider" } as const, { label: "删除工作区", onClick: onRemove }]
          : []),
      ]}
    >
      <Tooltip content={workspaceTooltip} placement="end" hasHoverIndication={false}>
        <div
          data-reveal-key={`workspace:${workspace.id}`}
          className={cn(
            "group/workspace relative flex h-7 items-center rounded-md transition-colors",
            selected
              ? "bg-accent text-foreground"
              : "text-secondary-foreground hover:bg-accent/70 hover:text-foreground",
          )}
        >
          <button
            className="flex min-w-0 flex-1 items-center gap-2 self-stretch px-2 text-left"
            onClick={onSelect}
          >
            {/* 图标槽原位替换（与设备行「direct 时闪电取代圆点」同一手法）：
                有活动状态时呈现点阵，中性态保留 GitBranch。 */}
            {activity.status !== "idle" ? (
              <ActivityIcon activity={activity} labeled />
            ) : executorBusy ? (
              <ActivityDots status="active" label="executor 正在执行子任务" />
            ) : (
              <GitBranch className={cn("size-3 shrink-0", workspace.isMain ? "text-warning" : "opacity-70")} />
            )}
            <span className="min-w-0 flex-1 truncate text-base">{workspace.branch}</span>
            {/* 右端内容：自定义名称（name ≠ branch 时才有；主工作区未起名时默认叫「主工作区」）+ git diff 累计统计（plan 024，X=Y=0 时不渲染）。
                diff 固定在最末；两者作为整体 hover 渐变淡出给删除按钮让位 */}
            {(() => {
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
                    <span className="max-w-24 truncate text-sm text-muted-foreground">
                      {label}
                    </span>
                  ) : null}
                  {hasDiff ? (
                    <span className="whitespace-nowrap font-mono text-xs tabular-nums">
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
              onClick={onRemove}
              title="删除工作区"
            >
              <X className="size-3" />
            </button>
          ) : null}
        </div>
      </Tooltip>
    </ContextMenu>
  );
}

/**
 * One live agent terminal in the 「当前」 section (plan 20261110-sidebar-current-terminals): the
 * agent's status glyph (the same as its tab's), the terminal's title and where it lives (project ·
 * branch, or the device for a directory workspace). Clicking lands on the terminal; there is no context menu
 * and no × — the terminal is managed from its tab.
 */
function TerminalRow({
  row,
  progress,
  selected,
  seen,
  onSelect,
}: {
  row: CurrentTerminalRow;
  progress: string | undefined;
  selected: boolean;
  /** The finished turn has been on screen since it finished: Clawd stops throwing confetti. */
  seen: boolean;
  onSelect: () => void;
}) {
  const { workspace, project, daemon, agent, title, activity } = row;
  const location = project ? `${project.name} · ${workspace.branch}` : daemon.name;
  const tooltip = (
    <div className="flex flex-col gap-1">
      <div className="break-words font-medium">{title}</div>
      <div className="flex flex-col gap-0.5">
        <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <ActivityIcon activity={activity} />
          <span className="truncate">{activityLabel(activity)}</span>
        </span>
        {/* The agent's own words about what it needs; not truncated, as in the workspace tooltip. */}
        {(activity.status === "approval" || activity.status === "question" || activity.status === "error") &&
        activity.message ? (
          <span className="flex items-start gap-1.5 text-sm text-foreground">
            <MessageSquare className="mt-0.5 size-3 shrink-0 opacity-70" />
            <span className="whitespace-pre-wrap break-words">{activity.message}</span>
          </span>
        ) : null}
        {progress ? (
          <span className="flex items-start gap-1.5 text-sm text-muted-foreground">
            <LoaderCircle className="mt-0.5 size-3 shrink-0 opacity-70" />
            <span className="whitespace-pre-wrap break-words">{progress}</span>
          </span>
        ) : null}
        <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
          {project ? (
            <GitBranch className="size-3 shrink-0 opacity-70" />
          ) : (
            <DeviceOsMark platform={daemon.platform} className="size-3 shrink-0 opacity-70" />
          )}
          <span className="truncate">{location}</span>
        </span>
        <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Folder className="size-3 shrink-0 opacity-70" />
          <span className="truncate">{workspace.path}</span>
        </span>
      </div>
    </div>
  );
  return (
    <Tooltip content={tooltip} placement="end" hasHoverIndication={false}>
      <button
        type="button"
        aria-pressed={selected}
        className={cn(
          "flex h-7 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left transition-colors",
          selected
            ? "bg-accent text-foreground"
            : "text-secondary-foreground hover:bg-accent/70 hover:text-foreground",
        )}
        onClick={onSelect}
      >
        {/* The tab's glyph carries the status (Clawd's poses, the tinted logos): no trailing dots. */}
        <AgentGlyph agent={agent} state={activity.status} seen={seen} className={selected ? "opacity-90" : "opacity-70"} />
        <span className="sr-only">{activityLabel(activity)}</span>
        <span className="min-w-0 flex-1 truncate text-base">{title}</span>
        <span className="max-w-28 shrink-0 truncate text-sm text-muted-foreground">{location}</span>
      </button>
    </Tooltip>
  );
}

/**
 * An open screen's sub-row under its device (plan 20261011-standalone-device-screen): the monitor
 * glyph, 「屏幕」 and the resolution — the connected remote size when known, else the fixed preset
 * chosen, else nothing. Clicking selects the screen; the × shown on hover disconnects it.
 */
function ScreenRow({
  runtime,
  daemonId,
  selected,
  onSelect,
  onDisconnect,
}: {
  runtime: ScreenRuntime;
  daemonId: string;
  selected: boolean;
  onSelect: () => void;
  onDisconnect: () => void;
}) {
  const state = useScreenSessionState(runtime, daemonId);
  const display = state?.display;
  const resolution = display ? `${display.widthPoints}×${display.heightPoints}` : state?.resolution ? screenResolutionLabel(state.resolution) : null;
  return (
    <div className="ml-3 border-l border-border pl-1.5">
      <div
        className={cn(
          "group/screen relative flex h-7 items-center rounded-md transition-colors",
          selected ? "bg-accent text-foreground" : "text-secondary-foreground hover:bg-accent/70 hover:text-foreground",
        )}
      >
        <button className="flex min-w-0 flex-1 items-center gap-2 self-stretch px-2 text-left" aria-pressed={selected} onClick={onSelect}>
          <Monitor className="size-3.5 shrink-0 opacity-70" />
          <span className="shrink-0 text-base">屏幕</span>
          {resolution ? (
            <span className="min-w-0 truncate text-sm text-muted-foreground group-hover/screen:[mask-image:linear-gradient(to_left,transparent_18px,black_44px)]">
              · {resolution}
            </span>
          ) : null}
        </button>
        <Tooltip content="断开屏幕" placement="end">
          <button
            type="button"
            aria-label="断开屏幕"
            className="absolute right-1 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground opacity-0 transition-all hover:bg-muted hover:text-foreground group-hover/screen:opacity-100 focus-visible:opacity-100"
            onClick={onDisconnect}
          >
            <X className="size-3" />
          </button>
        </Tooltip>
      </div>
    </div>
  );
}

/** 乐观工作区条目（plan 078）：创建请求发出后、服务端广播到达前的占位行。
 * id 是本地生成的假 id（pending-ws-N），永不进入 store，也不产生任何网络请求。 */
export type PendingWorkspace = {
  id: string;
  projectId: string;
  branch: string;
  daemonId: string;
};

type SidebarProps = {
  client: CofluxClient;
  selectedWorkspaceId: string | null;
  /** 「定位到选中」触发器（plan 20261111-sidebar-follow-selection）：每次 selectWorkspace /
   * selectDevice 自增。侧栏据此展开选中工作区所在项目并把行滚进视野——不能只依赖选中 id
   * 变化，跳回已选中的工作区（其项目刚被手动折叠）也要重新展开。 */
  revealNonce: number;
  onSelectWorkspace: (workspaceId: string) => void;
  /** The terminal on screen (the focused group's active task tab), for the 「当前」 section's highlight. */
  onScreenTaskId: string | null;
  /** A 「当前」 row's click: land on that terminal wherever it lives (the workbench's landOnTask). */
  onLandOnTask: (taskId: string) => void;
  /** 当前选中的设备（设备详情视图，plan 048）；与 selectedWorkspaceId 互斥 */
  selectedDeviceId: string | null;
  onSelectDevice: (daemonId: string) => void;
  onImportProject: () => void;
  onCreateWorkspace: (project: Project, branch: string, createNew: boolean) => void;
  /** The project menu's 移除项目, offered only against a centre that cannot archive. */
  onRemoveProject: (project: Project) => void;
  /** The project menu's 归档项目 (plan 20261030-project-archive), against a centre that archives. */
  onArchiveProject: (project: Project) => void;
  onRenameProject: (project: Project) => void;
  onRemoveWorkspace: (workspace: Workspace) => void;
  onRenameWorkspace: (workspace: Workspace) => void;
  onAddDevice: () => void;
  onRemoveDevice: (daemon: DaemonInfo) => void;
  onRenameDevice: (daemon: DaemonInfo) => void;
  /** This Mac's daemon id (plan 20260929-remote-desktop): its own row never offers 打开屏幕. */
  localDaemonId: string | null;
  /** 打开屏幕 on a device row: only for devices advertising the screen helper (`screen_v1`). */
  onOpenScreen: (daemon: DaemonInfo) => void;
  /** Open screens (plan 20261011-standalone-device-screen): each is a sub-row under its device. */
  screens: ScreenRuntime;
  /** The device whose screen is the selection; exclusive with the other two selections. */
  selectedScreenDeviceId: string | null;
  onSelectScreen: (daemonId: string) => void;
  /** The sub-row's ×: ends the remote session and closes the screen. */
  onDisconnectScreen: (daemonId: string) => void;
  /** 新建工作区菜单当前打开的项目（受控：+ 按钮/右键菜单项/Cmd+Ctrl+N 快捷键共用同一个锚点菜单） */
  createMenuProjectId: string | null;
  onCreateMenuProjectIdChange: (projectId: string | null) => void;
  /** 乐观创建中的工作区（plan 078）：渲染在对应项目的工作区列表末尾 */
  pendingWorkspaces: PendingWorkspace[];
  /** 账号脚部尾部的设置按钮：开关独立设置页（工作台可见时它总是关着的） */
  onToggleSettings: () => void;
  /** 齿轮 tooltip 的压制开关，与设置页那个脚部共用 */
  settingsTooltip: SettingsTooltipControl;
  /** 侧栏宽度：与设置页左栏共用同一份，见 use-sidebar-width.ts */
  widthControl: SidebarWidthControl;
  /** The band's collapse button (plan 20260930-collapsible-sidebar): hides the whole sidebar; ⌘B does the same. */
  onCollapse: () => void;
};

export function Sidebar(props: SidebarProps) {
  const client = props.client;
  // Archived projects (plan 20261030-project-archive) are not listed; their workspaces are only
  // ever listed under their project, so filtering projects hides them too.
  const allProjects = useStore(client.store, (state) => state.projects);
  const projects = visibleProjects(allProjects);
  const workspaces = useStore(client.store, (state) => state.workspaces);
  const projectArchiveSupported = useStore(client.store, (state) => state.projectArchiveSupported);
  const daemons = useStore(client.store, (state) => state.daemons);
  const tasks = useStore(client.store, (state) => state.tasks);
  const localSessions = useStore(client.store, (state) => state.localSessions);
  const deviceTransports = useStore(client.store, (state) => state.deviceTransports);
  const screenRecords = useStore(props.screens.records, (state) => state.records);
  const sessionAgents = useStore(client.store, (state) => state.sessionAgents);
  // A 「当前」 row stops throwing confetti by the tab's rule: once the finished turn is seen anywhere
  // on the account, or here (plan 20261111-agent-seen-sync).
  const seenSessions = useStore(client.store, (state) => state.seenSessions);
  // Executor runs (plan 20260929-executor-pip): a workspace whose terminal has one delegated a
  // sub-task; the row shows activity for it when the agents themselves are idle.
  const executorRuns = useStore(client.store, (state) => state.executorRuns);
  const executorTaskIds = executorTaskIdsOf(executorRuns);
  // 首快照未到之前 projects 是空数组：数据没到 ≠ 数据为空（plan 078 第③跳），
  // 「还没有项目」引导空态要等快照确认真空才渲染。
  const snapshotRevision = useStore(client.store, (state) => state.snapshotRevision);
  // Projects are collapsed by default and only the expanded set is remembered (plan
  // 20261109-sidebar-current-section), so a newly imported project appears collapsed.
  const [expandedIds, setExpandedIds] = useState(() => readExpandedProjects(EXPANDED_PROJECTS_STORE));
  // The 「当前」 rows' OSC titles: only the sessions that may be members, compared shallowly, so a
  // checkpoint on any other session does not re-render the sidebar.
  const sessionTitles = useStore(
    client.store,
    useShallow((state) => candidateSessionTitles(state.tasks, state.sessionAgents, state.sessionMetadata)),
  );
  const createMenuProjectId = props.createMenuProjectId;
  const setCreateMenuProjectId = props.onCreateMenuProjectIdChange;
  const modPrefix = SHORTCUT_MODIFIER_PREFIX;
  // 三区高度（VS Code SplitView 口径）：显式权重 + 可拖分隔条，见 use-sidebar-section-sizes.ts。
  const sectionSizes = useSidebarSectionSizes();

  function toggleProject(projectId: string) {
    const known = new Set(client.store.getState().projects.map((project) => project.id));
    setExpandedIds(toggleExpandedProject(EXPANDED_PROJECTS_STORE, expandedIds, projectId, known));
  }

  // 「定位到选中」（plan 20261111-sidebar-follow-selection）：跳转或启动恢复把选中落到侧栏上
  // ——展开所在项目并把行滚进视野。触发键是 (revealNonce, selectedProjectId)：nonce 覆盖
  // 「跳回已选中的工作区」，projectId 覆盖启动时选中先于快照到达（数据出现才解析得出）；
  // 刻意不响应 expandedIds，手动折叠选中项目要能留住，直到下一次跳转。
  const asideRef = useRef<HTMLElement | null>(null);
  const pendingRevealRef = useRef<string | null>(null);
  const selectedWorkspace = props.selectedWorkspaceId
    ? workspaces.find((workspace) => workspace.id === props.selectedWorkspaceId)
    : undefined;
  // 目录工作区没有可见的项目行：解析不到就只记 pending，永远滚不到也无妨。
  const selectedProjectId =
    selectedWorkspace && projects.some((project) => project.id === selectedWorkspace.projectId)
      ? selectedWorkspace.projectId
      : null;

  // 展开走渲染期「随 props 调整状态」而非 effect（react/set-state-in-effect 门禁）；ensure 的
  // 「已展开原样返回」保证多数跳转（落在已展开项目）不触发额外一轮渲染。
  const [revealed, setRevealed] = useState<{ nonce: number; projectId: string | null }>({ nonce: -1, projectId: null });
  if (revealed.nonce !== props.revealNonce || revealed.projectId !== selectedProjectId) {
    setRevealed({ nonce: props.revealNonce, projectId: selectedProjectId });
    if (selectedProjectId) {
      const known = new Set(allProjects.map((project) => project.id));
      setExpandedIds(ensureProjectExpanded(EXPANDED_PROJECTS_STORE, expandedIds, selectedProjectId, known));
    }
  }

  useEffect(() => {
    if (!props.selectedWorkspaceId) return;
    const key = `workspace:${props.selectedWorkspaceId}`;
    pendingRevealRef.current = scrollRevealTarget(asideRef.current, key) ? null : key;
  }, [props.revealNonce, props.selectedWorkspaceId, selectedProjectId]);

  useEffect(() => {
    if (!props.selectedDeviceId) return;
    const key = `device:${props.selectedDeviceId}`;
    pendingRevealRef.current = scrollRevealTarget(asideRef.current, key) ? null : key;
  }, [props.revealNonce, props.selectedDeviceId]);

  // 补滚：每次渲染后重试未命中的目标（刚展开的行、快照迟到的行），命中即清。
  useEffect(() => {
    const key = pendingRevealRef.current;
    if (key && scrollRevealTarget(asideRef.current, key)) pendingRevealRef.current = null;
  });

  // A live executor run on one of this workspace's terminals: shown in the icon slot when nothing
  // else is, and always as a tooltip line.
  const executorBusyOf = (workspaceId: string, daemon: DaemonInfo | undefined) =>
    (daemon?.online ?? false) && tasks.some((task) => task.workspaceId === workspaceId && executorTaskIds.has(task.id));

  // 「当前」 (plan 20261110-sidebar-current-terminals): nothing before the first snapshot — data not
  // arrived yet is not "nothing current".
  const currentRows =
    snapshotRevision > 0
      ? currentTerminals({ projects: allProjects, workspaces, daemons, tasks, sessionAgents, titles: sessionTitles })
      : [];

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

  const workspacesOf = (projectId: string) => projectWorkspacesInOrder(workspaces, projectId);

  return (
    // 高度跟随父容器而不是 h-screen：断线横幅出现时根容器加 pt-7，写死一屏高会把底部 28px
    // （正好是账号脚部那一行）裁掉。横幅本身不动。
    <aside
      ref={asideRef}
      className="relative flex h-full min-h-0 shrink-0 flex-col border-r border-border bg-sidebar text-base"
      style={{ width: props.widthControl.width }}
    >
      {/* 红绿灯（x=14,y=14）内嵌在这条空白带里，它同时是侧栏的窗口拖拽带（见 drag-region.ts）。
          The collapse button sits at its right end (plan 20260930-collapsible-sidebar); as the band's
          descendant it comes after it in document order, so its no-drag hole holds. */}
      <div className="flex shrink-0 items-center justify-end pr-2" style={DESKTOP_DRAG_BAND_STYLE}>
        <SidebarToggleButton collapsed={false} onToggle={props.onCollapse} />
      </div>
      <div className="flex min-h-0 flex-1 flex-col pt-1.5">
        {/* 「当前」 (plan 20261110-sidebar-current-terminals): the live agent terminals in tree
            order, never re-sorted; their workspaces stay in the tree below as well.
            三区是显式高度的窗格（VS Code SplitView 口径）：flex-grow 权重 + basis-0，分隔条
            只在相邻两区间挪空间，内容不足留白、超出各自内滚；表头 sticky 不随内容滚走。 */}
        {currentRows.length > 0 ? (
          <>
            <section
              ref={sectionSizes.sectionRef("current")}
              style={{ flexGrow: sectionSizes.weights.current }}
              className="scrollbar-on-hover min-h-16 basis-0 overflow-y-auto px-2 pb-1.5"
            >
              <div className="sticky top-0 z-10 mb-1.5 flex h-7 items-center bg-sidebar px-2">
                <span className="text-sm text-muted-foreground">当前</span>
              </div>
              <div className="space-y-0.5">
                {currentRows.map((row) => (
                  <TerminalRow
                    key={row.task.id}
                    row={row}
                    progress={sessionAgents[row.task.sessionId ?? ""]?.progress || undefined}
                    selected={row.task.id === props.onScreenTaskId}
                    seen={client.isTurnSeen(sessionAgents[row.task.sessionId ?? ""], seenSessions, row.task.sessionId ?? "")}
                    onSelect={() => props.onLandOnTask(row.task.id)}
                  />
                ))}
              </div>
            </section>
            <SidebarSectionDivider control={sectionSizes.divider("current", "projects")} />
          </>
        ) : null}

        <section
          ref={sectionSizes.sectionRef("projects")}
          style={{ flexGrow: sectionSizes.weights.projects }}
          className="scrollbar-on-hover min-h-16 basis-0 overflow-y-auto px-2 pb-1.5"
        >
          {/* 表头 sticky 不随内容滚走；分隔条下的呼吸空间（pt-2）长在 sticky 块内，滚动时不漏内容。 */}
          <div className="sticky top-0 z-10 mb-1.5 flex h-9 items-center bg-sidebar px-2 pt-2">
            <span className="text-sm text-muted-foreground">项目</span>
            <Tooltip content="导入项目">
              <button
                className="ml-auto flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                onClick={() => props.onImportProject()}
              >
                <FolderPlus className="size-3.5" />
              </button>
            </Tooltip>
          </div>

          {projects.length === 0 && snapshotRevision > 0 ? (
            <button
              className="mx-1 flex w-[calc(100%-0.5rem)] flex-col items-start rounded-md border border-dashed border-border px-3 py-3.5 text-left transition-colors hover:bg-accent/60"
              onClick={() => props.onImportProject()}
            >
              <span className="text-base font-medium text-foreground">还没有项目</span>
              <span className="mt-1 text-sm leading-4 text-muted-foreground">导入在线设备上的 git 仓库开始使用</span>
            </button>
          ) : null}

          <div className="space-y-0.5">
            {projects.map((project) => {
              const projectWorkspaces = workspacesOf(project.id);
              const projectPending = props.pendingWorkspaces.filter((item) => item.projectId === project.id);
              const daemon = daemons.find((item) => item.daemonId === project.daemonId);
              const expanded = expandedIds.has(project.id);
              // 活动四态：执行中 / 待批准 / 待回答 / 本轮完成（同一套 SVG 点阵）。
              // 状态来自 agent hook 上报（经 daemon 合并），聚合优先级收敛在
              // workspaceActivity（packages/client），UI 只做呈现。
              const activities = new Map(
                projectWorkspaces.map((workspace) => [workspace.id, workspaceActivity(workspace.id, daemon?.online ?? false, tasks, sessionAgents)]),
              );
              // A collapsed row stands in for its rows: the highest activity among them, summarised.
              const summary = expanded ? null : summarizeProjectActivity([...activities.values()]);
              const summaryText = summary?.top
                ? summary.attentionCount > 0
                  ? `${summary.attentionCount} 个工作区待处理`
                  : activityLabel(summary.top)
                : null;
              const projectTooltip = (
                <div className="flex flex-col gap-0.5">
                  {summary?.top && summaryText ? (
                    <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
                      <ActivityIcon activity={summary.top} />
                      <span className="truncate">{summaryText}</span>
                    </span>
                  ) : null}
                  <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
                    <Folder className="size-3 shrink-0 opacity-70" />
                    <span className="truncate">{project.repoPath}</span>
                  </span>
                </div>
              );

              return (
                <div className="group/project" key={project.id}>
                  <ContextMenu
                    label={`项目「${project.name}」操作`}
                    size="sm"
                    items={[
                      { label: "新建工作区", onClick: () => setCreateMenuProjectId(project.id) },
                      { label: "重命名", onClick: () => props.onRenameProject(project) },
                      // Handle copy (plan 20260914-entity-handles): the right-click menu is the
                      // only place it surfaces — handles are never persistent UI text.
                      { label: "复制标识", onClick: () => copyEntityHandle("project", project.id) },
                      { type: "divider" },
                      projectArchiveSupported
                        ? { label: "归档项目", onClick: () => props.onArchiveProject(project) }
                        : { label: "移除项目", onClick: () => props.onRemoveProject(project) },
                    ]}
                  >
                    <div className="group/row flex h-8 items-center rounded-md text-secondary-foreground transition-colors hover:bg-accent/70 hover:text-foreground">
                      <Tooltip content={projectTooltip} placement="end" hasHoverIndication={false}>
                      <button
                        className="flex min-w-0 flex-1 items-center gap-2 self-stretch px-2 text-left"
                        onClick={() => toggleProject(project.id)}
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
                        {/* Collapsed only (an expanded row's workspaces show their own). An offline
                            device reports every workspace idle, so this never meets the grey dot. */}
                        {summary?.top ? (
                          <span className="ml-auto flex shrink-0 items-center">
                            <ActivityIcon activity={summary.top} labeled />
                          </span>
                        ) : null}
                      </button>
                      </Tooltip>
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

                  {expanded && (projectWorkspaces.length > 0 || projectPending.length > 0) ? (
                    <div className="ml-3 space-y-0.5 border-l border-border pl-1.5">
                      {projectWorkspaces.map((workspace) => (
                        <WorkspaceRow
                          key={workspace.id}
                          workspace={workspace}
                          project={project}
                          daemon={daemon}
                          activity={activities.get(workspace.id) ?? IDLE}
                          executorBusy={executorBusyOf(workspace.id, daemon)}
                          progress={workspaceProgress(workspace.id, tasks, sessionAgents)}
                          selected={workspace.id === props.selectedWorkspaceId}
                          onSelect={() => props.onSelectWorkspace(workspace.id)}
                          onRename={() => props.onRenameWorkspace(workspace)}
                          onRemove={() => props.onRemoveWorkspace(workspace)}
                        />
                      ))}
                      {/* 乐观创建中的工作区（plan 078）：无右键菜单/删除入口，不可点击——
                          点击选中已由创建动作完成，行本身只是进度占位。 */}
                      {projectPending.map((pending) => (
                        <div
                          key={pending.id}
                          className={cn(
                            "relative flex h-7 items-center rounded-md",
                            pending.id === props.selectedWorkspaceId
                              ? "bg-accent text-foreground"
                              : "text-secondary-foreground",
                          )}
                        >
                          <span className="flex min-w-0 flex-1 items-center gap-2 px-2">
                            <LoaderCircle className="size-3 shrink-0 animate-spin opacity-70" />
                            <span className="min-w-0 flex-1 truncate text-base">{pending.branch}</span>
                            <span className="shrink-0 text-sm text-muted-foreground">创建中</span>
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>

        </section>

        <SidebarSectionDivider control={sectionSizes.divider("projects", "devices")} />

        <section
          ref={sectionSizes.sectionRef("devices")}
          style={{ flexGrow: sectionSizes.weights.devices }}
          className="scrollbar-on-hover min-h-16 basis-0 overflow-y-auto px-2 pb-1.5"
        >
          <div className="sticky top-0 z-10 mb-1.5 flex h-9 items-center bg-sidebar px-2 pt-2">
            <span className="text-sm text-muted-foreground">设备</span>
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
              <Plus className="size-3.5" />
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
                : transport?.mode === "peer"
                  ? "P2P 直连"
                  : transport?.mode === "relay"
                    ? "中继连接"
                    : transport?.mode === "remote"
                      ? "远程连接"
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
              const connected = transport?.mode === "direct" || transport?.mode === "peer" || transport?.mode === "relay" || transport?.mode === "remote";
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
              // 图标与圆点共用同一套延迟分档；direct=闪电、relay=云，与 tooltip 标题里的
              // 图标保持同一套语汇，未建连时才退回圆点。
              const iconClass = tone === "success"
                ? "text-success"
                : tone === "warning" ? "text-warning" : "text-muted-foreground";
              // 形状语汇：direct=闪电、p2p=电波、relay=云。
              const RouteIcon = transport?.mode === "direct" ? Zap : transport?.mode === "peer" ? Radio : (transport?.mode === "relay" || transport?.mode === "remote") ? Cloud : null;
              const rttText = rttMs === undefined ? "" : ` · ${Math.round(rttMs)}ms`;
              // 挂在整行而非那个 12px 图标上：图标太小，只挂它等于挂了个瞄不准的靶子。
              // 用组件库 Tooltip 而非原生 title：原生要悬停约 1s 才弹，且弹出后内容不再随
              // 心跳更新——延迟读数正是每 15s 会变的东西。
              // 布局照 Cursor：一行标题说结论（走哪条路 + 多快），下面是图标条目列表铺上下文。
              const tooltipRows: { icon: ReactNode; text: string }[] = [
                { icon: <DeviceOsMark platform={daemon.platform} className="size-3 shrink-0 opacity-70" />, text: `${daemon.host} · ${deviceOsName(daemon.platform)}` },
              ];
              const tooltipContent = (
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-1.5 font-medium">
                    {transport?.mode === "direct" ? <Zap className="size-3 shrink-0" /> : transport?.mode === "peer" ? <Radio className="size-3 shrink-0" /> : <Cloud className="size-3 shrink-0" />}
                    {routeLabel}{rttText}
                  </div>
                  <div className="flex flex-col gap-0.5">
                    {tooltipRows.map((row) => (
                      <span key={row.text} className="flex items-center gap-1.5 text-sm text-muted-foreground">
                        {row.icon}
                        <span className="truncate">{row.text}</span>
                      </span>
                    ))}
                  </div>
                </div>
              );
              return (
                <Fragment key={daemon.daemonId}>
                <ContextMenu
                  label={`设备「${daemon.name}」操作`}
                  size="sm"
                  items={[
                    ...(daemon.capabilities.includes(SCREEN_CAPABILITY) && daemon.daemonId !== props.localDaemonId
                      ? [{ label: "打开屏幕", isDisabled: !daemon.online, onClick: () => props.onOpenScreen(daemon) }, { type: "divider" as const }]
                      : []),
                    { label: "重命名", onClick: () => props.onRenameDevice(daemon) },
                    { label: "复制标识", onClick: () => copyEntityHandle("device", daemon.daemonId) },
                    { type: "divider" },
                    { label: "移除设备", onClick: () => props.onRemoveDevice(daemon) },
                  ]}
                >
                  <Tooltip content={tooltipContent} placement="end" hasHoverIndication={false}>
                    <div
                      data-reveal-key={`device:${daemon.daemonId}`}
                      className={cn(
                        "group/device flex h-7 items-center rounded-md text-base transition-colors",
                        daemon.daemonId === props.selectedDeviceId
                          ? "bg-accent text-foreground"
                          : "text-secondary-foreground hover:bg-accent/70 hover:text-foreground",
                      )}
                    >
                      {/* 点击进入设备详情（plan 048）：主体是 button，删除按钮平级在行尾 */}
                      <button
                        className="flex min-w-0 flex-1 items-center gap-2 self-stretch px-2 text-left"
                        onClick={() => props.onSelectDevice(daemon.daemonId)}
                      >
                        {/* 固定 12px 槽位：图标与圆点尺寸不同，不统一宽度设备名会参差。 */}
                        <span className="flex size-3 shrink-0 items-center justify-center">
                          {RouteIcon ? (
                            <RouteIcon className={cn("size-3", iconClass)} aria-label={`${routeLabel}${rttText}`} />
                          ) : (
                            <span className={cn("size-1.5 rounded-full", dotClass)} />
                          )}
                        </span>
                        <DeviceOsMark platform={daemon.platform} className="size-3.5 opacity-70" />
                        <span className="min-w-0 flex-1 truncate">
                          {daemon.name}
                        </span>
                        {orphans.length > 0 ? (
                          <span
                            className="shrink-0 rounded bg-warning/10 px-1 text-xs text-warning"
                            title={`本机存在 ${orphans.length} 个中心 catalog 未登记的存活 session：${orphans.map((item) => item.sessionId).join(", ")}`}
                          >
                            本地 {orphans.length}
                          </span>
                        ) : null}
                      </button>
                      <button
                        className="mr-1 flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-all hover:bg-muted hover:text-foreground group-hover/device:opacity-100 focus-visible:opacity-100"
                        onClick={() => props.onRemoveDevice(daemon)}
                        title="移除设备"
                      >
                        <Trash2 className="size-3" />
                      </button>
                    </div>
                  </Tooltip>
                </ContextMenu>
                {screenRecords[daemon.daemonId] ? (
                  <ScreenRow
                    runtime={props.screens}
                    daemonId={daemon.daemonId}
                    selected={daemon.daemonId === props.selectedScreenDeviceId}
                    onSelect={() => props.onSelectScreen(daemon.daemonId)}
                    onDisconnect={() => props.onDisconnectScreen(daemon.daemonId)}
                  />
                ) : null}
                </Fragment>
              );
            })}
          </div>
        </section>
      </div>

      {/* 账号脚部（plan 110）：固定在滚动区之外，不随项目/设备列表滚动；不声明拖拽区。 */}
      <AccountFooter
        client={client}
        isSettingsOpen={false}
        onToggleSettings={props.onToggleSettings}
        tooltipControl={props.settingsTooltip}
      />

      <SidebarResizeHandle control={props.widthControl} />
    </aside>
  );
}
