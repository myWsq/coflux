import { useEffect, useRef, useState, type DragEvent as ReactDragEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { Bot, FileDiff, GitBranch, History, LoaderCircle, Plus, SquareTerminal, Unplug, X } from "lucide-react";
import { TaskStatus, type Task } from "@coflux/protocol";

import { Button } from "@astryxdesign/core/Button";
import { ContextMenu } from "@astryxdesign/core/ContextMenu";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import { BranchMenu, type BranchTaken } from "@/components/workbench/branch-menu";
import { ChangesView } from "@/components/workbench/changes-view";
import { DRAG_REGION_STYLE, NO_DRAG_REGION_STYLE } from "@/components/workbench/drag-region";
import { copyEntityHandle } from "@/components/workbench/entity-handle";
import { SHORTCUT_MODIFIER_PREFIX } from "@/components/workbench/shortcut-modifier";
import { isDirWorkspace as isDirWorkspaceOf, type CofluxClient } from "@coflux/client";
import { cn } from "@/lib/utils";
import { ClawdGlyph } from "@/components/workbench/clawd-glyph";
import type { TerminalAttach } from "@/components/workbench/terminal-attach";
import type { TerminalControlState } from "@/components/workbench/terminal-pane";
import {
  activateTab,
  equalizeSplit,
  focusGroup,
  groupBodyStyle,
  groupFrameStyle,
  layoutGeometry,
  moveTabToGroup,
  moveTabToNewGroup,
  resizeSplit,
  splitSizes,
  touchesLeft,
  touchesRight,
  touchesTop,
  type LayoutGroup,
  type LayoutRect,
  type LayoutSash,
  type LayoutSide,
  type TerminalLayout,
} from "@/components/workbench/terminal-layout";
import { shouldActivateChangesView } from "@/components/workbench/workbench-state";

/** Tab 上的 agent 图标（plan 075）：claude 用 Clawd 像素小动物并按状态换姿态；
 * 干活健身、待批准/待回答挥旗、未读完成撒花；看过完成态后冻成 gym 第 0 帧站姿。
 * 其余 agent 用 lucide 机器人轮廓，保留状态警示色（approval/question→warning、
 * done→success，与侧栏语义一致）。 */
function AgentGlyph({
  agent,
  state,
  seen,
  className,
}: {
  agent: string;
  state: string;
  /** 完成态已被用户看过（点开过该 tab）→ 不再撒花。 */
  seen?: boolean;
  className?: string;
}) {
  if (agent === "claude") {
    const pose =
      state === "active"
        ? "active"
        : state === "approval" || state === "question"
          ? "raise"
          : (state === "done" || state === "waiting") && !seen
            ? "rest"
            : "idle";
    return <ClawdGlyph pose={pose} className={className} />;
  }
  const tone = state === "approval" || state === "question" ? "text-warning" : state === "done" ? "text-success" : "";
  return <Bot className={cn("size-3 shrink-0", tone, className)} />;
}

/** Drag payload type of a terminal tab. Deliberately not a file type: a tab dropped on a pane must never upload anything. */
const TAB_DRAG_TYPE = "application/x-coflux-terminal-tab";

/** Smallest group a sash drag may leave, in px (width for side-by-side groups, height for stacked ones). */
const MIN_GROUP_WIDTH = 160;
const MIN_GROUP_HEIGHT = 120;

/** A pointer this close (fraction of the body) to an edge splits there; further in it joins the group. */
const EDGE_ZONE = 0.3;

type DropTarget =
  | { kind: "strip"; groupId: string; index: number }
  | { kind: "zone"; groupId: string; zone: LayoutSide | "center" };

/**
 * Commands the global shortcuts and native menu send to the selected workspace
 * (plan 015 / 20260923-terminal-split-groups). Workbench builds the handle for the selected
 * workspace only; kept-alive hidden workspaces never receive commands.
 */
export type WorkspaceTerminalHandle = {
  /** ⌘T: a new terminal in the focused group. */
  createTerminal: () => void;
  /** ⌘W: closes the focused group's active tab. Suspended while the changes overlay is open. */
  closeActiveTab: () => void;
  /** ⌘⌥1–9: the focused group's Nth tab; out of range is ignored. */
  selectTabByIndex: (index: number) => void;
  /** ⌘[ / ⌘]: cycles the focused group's tabs. */
  selectRelativeTab: (delta: number) => void;
  /** ⌘1–9: focuses the Nth group in layout order. */
  focusGroupByIndex: (index: number) => void;
  /** ⌘⌥←/→/↑/↓: focuses the adjacent group. */
  focusGroupInDirection: (side: LayoutSide) => void;
  /** ⌘\ / ⌘⇧\: splits the focused group and opens a new terminal in the new group. */
  splitTerminal: (side: "right" | "down") => void;
};

/**
 * What a workspace container may ask Workbench to do. Workbench owns every workspace's layout
 * (plan 20260923-terminal-split-groups): the container renders chrome from the layout it is given
 * and reports intents; it keeps no second copy of tab selection.
 */
export type WorkspaceLayoutActions = {
  /** Apply a layout change that makes no tab newly chosen by the user (focus a group, resize a split). */
  update: (workspaceId: string, change: (layout: TerminalLayout) => TerminalLayout) => void;
  /** Current layout (not the render's copy): a sash drag reads its starting sizes from it. */
  get: (workspaceId: string) => TerminalLayout;
  /** A user action on a tab (click, banner's 重新接管): activates it, claims it back if detached, focuses it. */
  activateTab: (workspaceId: string, taskId: string) => void;
  /** A user moved a tab (drop, context-menu split): the moved tab is then activated as a user action. */
  moveTab: (workspaceId: string, taskId: string, change: (layout: TerminalLayout) => TerminalLayout) => void;
  /** ＋ in a group: focuses that group, then opens a terminal there. */
  createTerminal: (workspaceId: string, groupId: string) => void;
};

type WorkspaceTerminalProps = {
  workspaceId: string;
  /** 是否为当前显示的工作区：隐藏时保持挂载（「变更」视图的折叠态与已拉取数据都不丢）。 */
  active: boolean;
  client: CofluxClient;
  onCloseTask: (task: Task) => void;
  /** 终端面板与接管状态机已提升到 Workbench（plan 104）：容器只借它读控制态、重开已退出终端。 */
  attach: TerminalAttach;
  /** This workspace's layout, already reconciled against the task list by Workbench. */
  layout: TerminalLayout;
  /** The changes overlay covers the whole main area (toggled from the action dock). */
  changesOpen: boolean;
  /** Measured width of the action dock floating over the top-right strip. */
  dockWidth: number;
  actions: WorkspaceLayoutActions;
};

function zoneAt(event: ReactDragEvent<HTMLElement>): LayoutSide | "center" {
  const rect = event.currentTarget.getBoundingClientRect();
  const px = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0.5;
  const py = rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0.5;
  const edges: { side: LayoutSide; distance: number }[] = [
    { side: "left", distance: px },
    { side: "right", distance: 1 - px },
    { side: "up", distance: py },
    { side: "down", distance: 1 - py },
  ];
  const nearest = edges.reduce((best, edge) => (edge.distance < best.distance ? edge : best));
  return nearest.distance < EDGE_ZONE ? nearest.side : "center";
}

function zoneHighlightClass(zone: LayoutSide | "center"): string {
  switch (zone) {
    case "left":
      return "inset-y-0 left-0 w-1/2";
    case "right":
      return "inset-y-0 right-0 w-1/2";
    case "up":
      return "inset-x-0 top-0 h-1/2";
    case "down":
      return "inset-x-0 bottom-0 h-1/2";
    default:
      return "inset-0";
  }
}

function hasTabPayload(event: ReactDragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer.types).includes(TAB_DRAG_TYPE);
}

function percent(value: number): string {
  return `${Math.round(value * 1e6) / 1e4}%`;
}

type SashDrag = {
  pointerId: number;
  start: number;
  splitPx: number;
  startSizes: readonly number[];
  previousCursor: string;
  previousUserSelect: string;
};

/**
 * The line between two groups; drag to resize, double-click to equalise that split. Same
 * hand-written pointer-capture pattern as the sidebar's resize handle (use-sidebar-width.ts).
 * It sits above the pane layer (z-20) so pointer events reach it even though panes come later in
 * the DOM, and it is `no-drag` because a vertical sash crosses the top strips' window drag region.
 */
function GroupSash({
  sash,
  onStart,
  onResize,
  onEqualize,
}: {
  sash: LayoutSash;
  /** The split's extent in px and its sizes at the start of the drag, or null when there is nothing to drag. */
  onStart: (container: HTMLElement) => { splitPx: number; startSizes: readonly number[] } | null;
  onResize: (deltaPx: number, splitPx: number, startSizes: readonly number[]) => void;
  onEqualize: () => void;
}) {
  const [isResizing, setIsResizing] = useState(false);
  const dragRef = useRef<SashDrag | null>(null);
  const row = sash.direction === "row";
  const rect: LayoutRect = sash.splitRect;
  const style = row
    ? { left: `calc(${percent(sash.position)} - 3px)`, top: percent(rect.y), height: percent(rect.h), ...NO_DRAG_REGION_STYLE }
    : { top: `calc(${percent(sash.position)} - 3px)`, left: percent(rect.x), width: percent(rect.w), ...NO_DRAG_REGION_STYLE };

  function finish(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    document.documentElement.style.cursor = drag.previousCursor;
    document.documentElement.style.userSelect = drag.previousUserSelect;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setIsResizing(false);
  }

  return (
    <div
      className={cn("group/sash absolute z-20 touch-none", row ? "w-1.5 cursor-col-resize" : "h-1.5 cursor-row-resize")}
      style={style}
      onPointerDown={(event) => {
        if (!event.isPrimary || event.button !== 0 || dragRef.current) return;
        const container = event.currentTarget.parentElement;
        if (!container) return;
        const start = onStart(container);
        if (!start) return;
        event.preventDefault();
        event.stopPropagation();
        dragRef.current = {
          pointerId: event.pointerId,
          start: row ? event.clientX : event.clientY,
          splitPx: start.splitPx,
          startSizes: start.startSizes,
          previousCursor: document.documentElement.style.cursor,
          previousUserSelect: document.documentElement.style.userSelect,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
        document.documentElement.style.cursor = row ? "col-resize" : "row-resize";
        document.documentElement.style.userSelect = "none";
        setIsResizing(true);
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        onResize((row ? event.clientX : event.clientY) - drag.start, drag.splitPx, drag.startSizes);
      }}
      onPointerUp={finish}
      onPointerCancel={finish}
      onLostPointerCapture={finish}
      onDoubleClick={onEqualize}
    >
      <div
        className={cn(
          "pointer-events-none absolute transition-colors",
          row ? "inset-y-0 left-1/2 w-px -translate-x-1/2" : "inset-x-0 top-1/2 h-px -translate-y-1/2",
          isResizing ? "bg-primary/70" : "bg-border group-hover/sash:bg-primary/50",
        )}
      />
    </div>
  );
}

export function WorkspaceTerminal({ workspaceId, active, client, onCloseTask, attach, layout, changesOpen, dockWidth, actions }: WorkspaceTerminalProps) {
  const workspace = useStore(client.store, (state) => state.workspaces.find((item) => item.id === workspaceId));
  const projectWorkspaces = useStore(
    client.store,
    useShallow((state) => state.workspaces.filter((item) => item.projectId === workspace?.projectId)),
  );
  // diff 基准（merge-base 用）：与 024 的 worker 侧 diff_stat 同一权威值，来自 project 实体。
  const defaultBranch = useStore(client.store, (state) => state.projects.find((item) => item.id === workspace?.projectId)?.defaultBranch ?? "");
  const workspaceTasks = useStore(
    client.store,
    useShallow((state) =>
      state.tasks.filter((task) => task.workspaceId === workspaceId).sort((left, right) => left.createdAt - right.createdAt),
    ),
  );
  const modPrefix = SHORTCUT_MODIFIER_PREFIX;
  // agent presence（plan 073/075）：引用只在实际变化时更新（worker 变化才发），直接订阅。
  const sessionAgents = useStore(client.store, (state) => state.sessionAgents);
  // OSC 终端标题（plan 075）：checkpoint 每 ~2s 换引用（有输出即上报），必须用选择器把
  // 本工作区的 title 摘出来浅比较，否则整棵 WorkspaceTerminal 会跟着 2s 心跳空转重渲染。
  const checkpointTitles = useStore(
    client.store,
    useShallow((state) => {
      const titles: Record<string, string> = {};
      for (const task of state.tasks) {
        if (task.workspaceId !== workspaceId || !task.sessionId) continue;
        const title = state.sessionCheckpoints[task.sessionId]?.title;
        if (title) titles[task.sessionId] = title;
      }
      return titles;
    }),
  );

  // 目录工作区（无 repo 终端，plan 045/048）：作为设备详情的载体，保留终端 Tabs/新建，
  // 但 git 语义（分支按钮/「变更」覆盖层/diff）全部不渲染。
  const isDirWorkspace = Boolean(workspace && isDirWorkspaceOf(workspace));

  /** 切换分支中：目标分支名（按钮 pending 态；成功由 daemon 上报驱动 branch 变更后自动清除） */
  const [pendingBranch, setPendingBranch] = useState<string | null>(null);
  // 完成态看过一次就不再撒花：按 sessionId 记，下一轮又干活时清掉。
  const seenDoneRef = useRef(new Set<string>());
  // Tab drag (plan 20260923-terminal-split-groups): the dragged task, and where it would land.
  const [dragTaskId, setDragTaskId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);

  // 分支切换：checkout 在本 worktree 内经 Device exec 完成，成功后同步元数据（workspaceSetBranch）。
  const takenBranches = new Map<string, BranchTaken>(
    projectWorkspaces.map((item) =>
      item.id === workspaceId
        ? [item.branch, { hint: "当前分支", reason: "已是当前工作区的分支" }]
        : [item.branch, { hint: "已被检出", reason: `已被工作区「${item.name}」检出，同一分支不能检出到两个 worktree` }],
    ),
  );

  async function listBranches() {
    const result = await client.execInWorkspace(workspaceId, "git", ["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
    if (!result.ok || result.exitCode !== 0) {
      return { ok: false, branches: [], error: result.error || result.stderr.trim() || "获取分支列表失败" };
    }
    return { ok: true, branches: result.stdout.split("\n").map((line) => line.trim()).filter(Boolean), error: "" };
  }

  function switchBranch(branch: string, createNew: boolean) {
    setPendingBranch(branch);
    void (async () => {
      const result = await client.execInWorkspace(workspaceId, "git", createNew ? ["checkout", "-b", branch] : ["checkout", branch]);
      if (!result.ok || result.exitCode !== 0) {
        client.reportLocalError(`切换分支失败：${result.error || result.stderr.trim() || "未知错误"}`);
        setPendingBranch(null);
      }
      // 成功不在此处收尾：分支真相源在设备侧，daemon 上报 branch 变更后（≤3s）由下面的效果清除 pending
    })();
  }

  // pending 收敛：store 中分支已到目标值即清除；20s 兜底解锁（上报丢失时下次快照仍会纠正显示）
  useEffect(() => {
    if (pendingBranch && workspace?.branch === pendingBranch) setPendingBranch(null);
  }, [pendingBranch, workspace?.branch]);
  useEffect(() => {
    if (!pendingBranch) return;
    const timer = window.setTimeout(() => setPendingBranch(null), 20_000);
    return () => window.clearTimeout(timer);
  }, [pendingBranch]);

  const stateOf = attach.stateOf;
  const taskById = new Map(workspaceTasks.map((task) => [task.id, task]));
  const pending = layout.pending ?? null;
  const geometry = layoutGeometry(layout);
  const singleGroup = geometry.groups.length === 1;

  function endDrag() {
    setDragTaskId(null);
    setDropTarget(null);
  }

  function dropOnStrip(group: LayoutGroup, index: number) {
    const taskId = dragTaskId;
    endDrag();
    if (!taskId) return;
    actions.moveTab(workspaceId, taskId, (current) => moveTabToGroup(current, taskId, group.id, index));
  }

  function dropOnZone(group: LayoutGroup, zone: LayoutSide | "center") {
    const taskId = dragTaskId;
    endDrag();
    if (!taskId) return;
    if (zone === "center") {
      if (group.tabs.includes(taskId)) return;
      actions.moveTab(workspaceId, taskId, (current) => moveTabToGroup(current, taskId, group.id, group.tabs.length));
      return;
    }
    actions.moveTab(workspaceId, taskId, (current) => moveTabToNewGroup(current, taskId, group.id, zone));
  }

  /** Insertion index in a strip from the pointer: before the first tab whose midpoint is right of it. */
  function stripIndexAt(event: ReactDragEvent<HTMLElement>, group: LayoutGroup): number {
    const slots = event.currentTarget.querySelectorAll<HTMLElement>("[data-tab-slot]");
    for (let index = 0; index < slots.length; index++) {
      const rect = slots[index]!.getBoundingClientRect();
      if (event.clientX < rect.left + rect.width / 2) return index;
    }
    return group.tabs.length;
  }

  function renderTab(group: LayoutGroup, taskId: string, index: number, groupFocused: boolean) {
    const isActive = group.activeTabId === taskId;
    // The focused group's active tab carries the full highlight; other groups' active tabs a weaker one.
    const activeClass = groupFocused ? "bg-accent text-foreground" : "bg-accent/40 text-foreground/80";
    const idleClass = "text-secondary-foreground hover:bg-accent/60 hover:text-foreground";
    const stripTarget = dropTarget?.kind === "strip" && dropTarget.groupId === group.id ? dropTarget.index : null;
    const indicators = (
      <>
        {stripTarget === index ? <div aria-hidden className="pointer-events-none absolute inset-y-1 -left-px w-0.5 rounded-full bg-primary" /> : null}
        {stripTarget === group.tabs.length && index === group.tabs.length - 1 ? (
          <div aria-hidden className="pointer-events-none absolute inset-y-1 -right-px w-0.5 rounded-full bg-primary" />
        ) : null}
      </>
    );

    if (pending && taskId === pending.id) {
      // 乐观 pending tab（plan 078）：点击只回焦点，不进激活/attach 状态机；无关闭入口，不可拖。
      return (
        <div key={taskId} data-tab-slot className="relative shrink-0" style={NO_DRAG_REGION_STYLE}>
          <div className={cn("flex h-7 max-w-52 items-center rounded-md text-sm transition-colors", isActive ? activeClass : idleClass)}>
            <button
              className="flex min-w-0 flex-1 items-center gap-1.5 self-stretch px-2.5 text-left"
              onClick={() => actions.update(workspaceId, (current) => activateTab(current, taskId))}
            >
              <LoaderCircle className="size-3 shrink-0 animate-spin text-muted-foreground" />
              <span className="truncate">{pending.title}</span>
            </button>
          </div>
          {indicators}
        </div>
      );
    }

    const task = taskById.get(taskId);
    if (!task) return null;
    const state = stateOf(task);
    const agentEntry = task.sessionId ? sessionAgents[task.sessionId] : undefined;
    const sessionId = task.sessionId;
    const agentState = agentEntry?.state;
    if (sessionId && agentState && agentState !== "done" && agentState !== "waiting") {
      seenDoneRef.current.delete(sessionId);
    }
    // 本工作区正显示、变更覆盖层关着、且它是所在分组的活动 Tab（即它在屏幕上），才算已读。
    if (active && !changesOpen && isActive && sessionId && (agentState === "done" || agentState === "waiting")) {
      seenDoneRef.current.add(sessionId);
    }
    const seenDone = Boolean(sessionId && seenDoneRef.current.has(sessionId));
    // OSC 标题非空即覆盖显示；EXITED 后 sessionId 清空 → 自动回落 task.title。
    const tabTitle = (task.sessionId && checkpointTitles[task.sessionId]) || task.title;
    // Moving a group's only tab into a new group beside that group would leave nothing behind.
    const canSplit = group.tabs.length > 1;
    const bright = isActive && groupFocused;
    return (
      // The flex-item box stays on an outer wrapper rather than on the tab itself:
      // ContextMenu inserts its own trigger element between the two, and that element
      // cannot be styled from here (its `className`/`style` props address the menu
      // surface, and `triggerXstyle` needs StyleX, which this app does not compile).
      // Without shrink-0 out here the tabs would squeeze instead of the strip scrolling.
      // The whole tab also stays outside the native drag region, as before. The wrapper is
      // also the drag source (native HTML5 DnD; its payload is not a file type).
      <div
        key={task.id}
        data-tab-slot
        className={cn("relative shrink-0", dragTaskId === task.id && "opacity-50")}
        style={NO_DRAG_REGION_STYLE}
        draggable
        onDragStart={(event) => {
          event.dataTransfer.setData(TAB_DRAG_TYPE, task.id);
          event.dataTransfer.effectAllowed = "move";
          // Changing the DOM inside dragstart can cancel the drag in Chromium; let it start first.
          window.setTimeout(() => setDragTaskId(task.id), 0);
        }}
        onDragEnd={endDrag}
      >
        <ContextMenu
          label={`终端「${tabTitle || "终端"}」操作`}
          size="sm"
          // Handle copy (plan 20260914-entity-handles): a terminal's handle is the task
          // id's first 8 hex characters; it appears here and nowhere else on screen.
          items={[
            { label: "复制标识", onClick: () => copyEntityHandle("terminal", task.id) },
            { type: "divider" },
            {
              label: "向右拆分",
              isDisabled: !canSplit,
              onClick: () => actions.moveTab(workspaceId, task.id, (current) => moveTabToNewGroup(current, task.id, group.id, "right")),
            },
            {
              label: "向下拆分",
              isDisabled: !canSplit,
              onClick: () => actions.moveTab(workspaceId, task.id, (current) => moveTabToNewGroup(current, task.id, group.id, "down")),
            },
          ]}
        >
          <div className={cn("group flex h-7 max-w-52 items-center rounded-md text-sm transition-colors", isActive ? activeClass : idleClass)}>
            <button
              className="flex min-w-0 flex-1 items-center gap-1.5 self-stretch px-2.5 text-left"
              onClick={() => actions.activateTab(workspaceId, task.id)}
            >
              {state === "attaching" ? (
                <LoaderCircle className="size-3 shrink-0 animate-spin text-muted-foreground" />
              ) : state === "detached" ? (
                <Unplug className="size-3 shrink-0 text-warning" />
              ) : agentEntry ? (
                <AgentGlyph agent={agentEntry.agent} state={agentEntry.state} seen={seenDone} className={bright ? "opacity-90" : "opacity-70"} />
              ) : (
                <SquareTerminal className={cn("size-3 shrink-0", bright ? "opacity-90" : "opacity-50")} />
              )}
              {tabTitle === task.title || !tabTitle ? (
                <span className="truncate">{tabTitle || "终端"}</span>
              ) : (
                // OSC 标题往往比 tab 宽，悬浮给全文（设计约定：Tooltip 组件，不用原生 title）
                <Tooltip content={tabTitle} placement="below">
                  <span className="truncate">{tabTitle}</span>
                </Tooltip>
              )}
            </button>
            <Tooltip content={`关闭终端 ${modPrefix}W`} placement="below">
              <button
                className="mr-0.5 flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-all hover:bg-muted hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
                onClick={() => onCloseTask(task)}
              >
                <X className="size-3" />
              </button>
            </Tooltip>
          </div>
        </ContextMenu>
        {indicators}
      </div>
    );
  }

  function renderGroup(group: LayoutGroup, rect: LayoutRect) {
    const groupFocused = active && !changesOpen && group.id === layout.focusedGroupId;
    const top = touchesTop(rect);
    const showBranch = !isDirWorkspace && top && touchesLeft(rect);
    const reserveDock = top && touchesRight(rect);
    const activeTask = group.activeTabId ? (taskById.get(group.activeTabId) ?? null) : null;
    const activeControlState: TerminalControlState = activeTask ? stateOf(activeTask) : "stopped";
    const showsPending = Boolean(pending && group.activeTabId === pending.id);
    const holdsPending = Boolean(pending && group.tabs.includes(pending.id));
    // While a tab is being dragged the strips drop their window drag region, so the whole strip can
    // take the drop (a drag region swallows pointer and drag events).
    const stripIsDragRegion = top && !dragTaskId;
    return (
      <div
        key={group.id}
        className="absolute flex flex-col"
        style={groupFrameStyle(rect)}
        onPointerDown={() => {
          if (group.id !== layout.focusedGroupId) actions.update(workspaceId, (current) => focusGroup(current, group.id));
        }}
      >
        {/* 分组标签栏：左上分组带分支按钮（没有拆分时，这就是原来那条顶栏，只是「变更」挪进了右上角操作坞）。
            贴着窗口上沿的标签栏是窗口拖拽区（plan 108）：空白处按住能拖窗口、双击走 macOS 标题栏双击偏好；
            下方分组的标签栏不是。拖拽区吞掉指针事件——往里加任何可点/可悬浮的元素都必须带
            NO_DRAG_REGION_STYLE（见 drag-region.ts）。右上分组给操作坞留出它实测的宽度。 */}
        <header
          className="flex h-9 min-w-0 shrink-0 items-center gap-2 border-b border-border bg-background pl-3"
          style={{ ...(stripIsDragRegion ? DRAG_REGION_STYLE : NO_DRAG_REGION_STYLE), paddingRight: reserveDock ? dockWidth : 8 }}
        >
          {showBranch ? (
            <>
              <BranchMenu
                currentBranch={workspace?.branch ?? ""}
                button={{
                  label: pendingBranch ?? workspace?.branch ?? "",
                  icon: pendingBranch ? <LoaderCircle className="size-3 animate-spin" /> : <GitBranch className="size-3" />,
                  isDisabled: Boolean(pendingBranch),
                  variant: "ghost",
                  size: "sm",
                  // ghost 默认色偏亮、内边距偏大：压到与顶栏辅助元素一致（内联样式压 StyleX）。
                  // Astryx Button 把 style 合到 <button> 本身、不套包裹层，no-drag 落点正确。
                  style: { color: "var(--secondary-foreground)", height: 24, paddingInline: 6, gap: 6, ...NO_DRAG_REGION_STYLE },
                }}
                listBranches={listBranches}
                takenBranches={takenBranches}
                onPick={switchBranch}
              />
              <div className="h-4 w-px shrink-0 bg-border" />
            </>
          ) : null}
          <div
            className="flex min-w-0 flex-1 items-center gap-0.5 self-stretch overflow-x-auto pr-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            onDragOver={(event) => {
              if (!dragTaskId || !hasTabPayload(event)) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              const index = stripIndexAt(event, group);
              if (dropTarget?.kind !== "strip" || dropTarget.groupId !== group.id || dropTarget.index !== index) {
                setDropTarget({ kind: "strip", groupId: group.id, index });
              }
            }}
            onDragLeave={(event) => {
              const next = event.relatedTarget;
              if (next instanceof Node && event.currentTarget.contains(next)) return;
              if (dropTarget?.kind === "strip" && dropTarget.groupId === group.id) setDropTarget(null);
            }}
            onDrop={(event) => {
              if (!dragTaskId || !hasTabPayload(event)) return;
              event.preventDefault();
              dropOnStrip(group, stripIndexAt(event, group));
            }}
          >
            {group.tabs.map((taskId, index) => renderTab(group, taskId, index, groupFocused))}
            {/* 新建按钮跟随最后一个 Tab（浏览器式），不钉在最右；在哪个分组点就开在哪个分组。 */}
            <Tooltip content={`新建终端 ${modPrefix}T`} placement="below">
              <button
                className="ml-0.5 flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-wait disabled:opacity-50"
                style={NO_DRAG_REGION_STYLE}
                onClick={() => actions.createTerminal(workspaceId, group.id)}
                disabled={Boolean(pending)}
              >
                {holdsPending ? <LoaderCircle className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
              </button>
            </Tooltip>
          </div>
        </header>

        {/* 分组主体：面板层按同一个矩形盖在它上面（面板层 DOM 在后、整层 pointer-events-none），
            这里的空态 / 创建中 / 横幅照常收得到点击；横幅 z-10 压在面板之上。 */}
        <div className="relative min-h-0 min-w-0 flex-1 bg-terminal">
          {showsPending && pending ? (
            // pending tab 的主区（plan 078）：不挂 TerminalPane（假 id 不产生请求），只显示创建中。
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="flex max-w-sm flex-col items-center text-center">
                <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
                <p className="mt-4 text-sm leading-5 text-muted-foreground">正在创建终端…</p>
              </div>
            </div>
          ) : null}

          {group.tabs.length === 0 ? (
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="flex max-w-sm flex-col items-center text-center">
                <div className="mb-4 flex size-10 items-center justify-center rounded-lg border border-border text-muted-foreground">
                  <SquareTerminal className="size-5" />
                </div>
                <h2 className="text-base font-medium text-foreground">{isDirWorkspace ? "这台设备还没有终端" : "这个工作区还没有终端"}</h2>
                <p className="mt-1.5 text-sm leading-5 text-muted-foreground">创建后会立即启动 shell，并作为一个新 Tab 打开。也可以按 {modPrefix}T 快速新建。</p>
                <Button
                  className="mt-5"
                  label="新建终端"
                  variant="primary"
                  size="sm"
                  icon={<Plus />}
                  isLoading={Boolean(pending)}
                  onClick={() => actions.createTerminal(workspaceId, group.id)}
                />
              </div>
            </div>
          ) : null}

          {activeTask && activeControlState === "detached" ? (
            <div className="absolute inset-x-0 top-0 z-10 flex items-center justify-between gap-2 border-b border-warning/20 bg-warning/10 px-4 py-2 text-xs text-warning backdrop-blur">
              <span className="flex min-w-0 items-center gap-2">
                <Unplug className="size-3.5 shrink-0" />
                <span className="truncate">此终端已被其它客户端接管，当前输入已锁定。</span>
              </span>
              <Button label="重新接管" variant="secondary" size="sm" onClick={() => actions.activateTab(workspaceId, activeTask.id)} />
            </div>
          ) : null}

          {/* 已退出终端（plan 097）：画面是回放的最后输出，重开 shell 是显式动作，不再一点 Tab 就悄悄起新会话。 */}
          {activeTask && activeTask.status === TaskStatus.EXITED && activeControlState === "stopped" ? (
            <div className="absolute inset-x-0 top-0 z-10 flex items-center justify-between gap-2 border-b border-border bg-background/80 px-4 py-2 text-xs text-muted-foreground backdrop-blur">
              <span className="flex min-w-0 items-center gap-2">
                <History className="size-3.5 shrink-0" />
                <span className="truncate">
                  {activeTask.exitCode === undefined
                    ? "此终端已退出，画面是最后的输出。"
                    : `此终端已退出（退出码 ${activeTask.exitCode}），画面是最后的输出。`}
                </span>
              </span>
              <Button label="重新打开" variant="secondary" size="sm" onClick={() => attach.reopenTask(activeTask.id)} />
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  // 容器只出分组外壳（标签栏、主体占位、分隔条、拖放区）与「变更」覆盖层，终端面板由 Workbench 层统一挂
  // （plan 104）。外层是一层 absolute inset-0（见 workbench.tsx），这里的矩形都相对终端主区。
  return (
    <>
      {geometry.groups.map((entry) => renderGroup(entry.group, entry.rect))}

      {/* 分隔条：排在分组外壳之后（文档顺序晚于标签栏的拖拽区，见 drag-region.ts），z-20 压在面板层之上。 */}
      {changesOpen || singleGroup
        ? null
        : geometry.sashes.map((sash) => (
            <GroupSash
              key={`${sash.path.join(".")}:${sash.index}`}
              sash={sash}
              onStart={(container) => {
                const startSizes = splitSizes(actions.get(workspaceId), sash.path);
                const bounds = container.getBoundingClientRect();
                const splitPx = sash.direction === "row" ? bounds.width * sash.splitRect.w : bounds.height * sash.splitRect.h;
                return startSizes && splitPx > 0 ? { splitPx, startSizes } : null;
              }}
              onResize={(deltaPx, splitPx, startSizes) => {
                const minPx = sash.direction === "row" ? MIN_GROUP_WIDTH : MIN_GROUP_HEIGHT;
                actions.update(workspaceId, (current) => resizeSplit(current, sash.path, sash.index, startSizes, deltaPx / splitPx, minPx / splitPx));
              }}
              onEqualize={() => actions.update(workspaceId, (current) => equalizeSplit(current, sash.path))}
            />
          ))}

      {/* 拖放区（标签拖动期间才有）：盖在面板层之上，拖着标签经过终端时事件落在这里而不是面板上——
          面板的拖放上传只认文件，标签的拖动载荷也刻意不是文件。 */}
      {dragTaskId && !changesOpen
        ? geometry.groups.map(({ group, rect }) => {
            const target = dropTarget?.kind === "zone" && dropTarget.groupId === group.id ? dropTarget.zone : null;
            return (
              <div
                key={`drop:${group.id}`}
                className="absolute z-20"
                style={groupBodyStyle(rect)}
                onDragOver={(event) => {
                  if (!hasTabPayload(event)) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                  const zone = zoneAt(event);
                  if (target !== zone) setDropTarget({ kind: "zone", groupId: group.id, zone });
                }}
                onDragLeave={(event) => {
                  const next = event.relatedTarget;
                  if (next instanceof Node && event.currentTarget.contains(next)) return;
                  if (target) setDropTarget(null);
                }}
                onDrop={(event) => {
                  if (!hasTabPayload(event)) return;
                  event.preventDefault();
                  dropOnZone(group, zoneAt(event));
                }}
              >
                {target ? (
                  <div aria-hidden className={cn("pointer-events-none absolute rounded-md border border-primary/40 bg-primary/15", zoneHighlightClass(target))} />
                ) : null}
              </div>
            );
          })
        : null}

      {/* 「变更」覆盖层：从右上角操作坞打开，盖住整个终端主区（下面所有分组原样留着，agent 照跑）；
          再点一次或 Esc 回到原来的分组布局。与终端面板同保活模式（隐藏不卸载），折叠态/已拉取数据才不随切换丢失。
          顶部留一条与标签栏等高的窗口拖拽带，覆盖层开着时窗口照样能拖。目录工作区无 git 语义，整层不渲染。 */}
      {isDirWorkspace ? null : (
        <div className={cn("absolute inset-0 z-20 flex flex-col bg-terminal", changesOpen ? "" : "hidden")}>
          <header
            className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-background pl-3 text-sm"
            style={{ ...DRAG_REGION_STYLE, paddingRight: dockWidth }}
          >
            <FileDiff className="size-3 shrink-0 opacity-90" />
            <span>变更</span>
            <span className="text-xs text-muted-foreground">Esc 返回终端</span>
          </header>
          <div className="relative min-h-0 flex-1">
            <div className="absolute inset-0">
              <ChangesView
                workspaceId={workspaceId}
                active={shouldActivateChangesView(active, changesOpen)}
                client={client}
                defaultBranch={defaultBranch}
                additions={workspace?.additions ?? 0}
                deletions={workspace?.deletions ?? 0}
              />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
