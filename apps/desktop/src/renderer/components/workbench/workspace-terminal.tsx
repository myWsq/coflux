import { useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { Bot, FolderTree, GitBranch, Globe, History, LoaderCircle, Monitor, Plus, Sparkles, SquareTerminal, Unplug, X } from "lucide-react";
import { TaskStatus, type Task } from "@coflux/protocol";

import { Button } from "@astryxdesign/core/Button";
import { ContextMenu } from "@astryxdesign/core/ContextMenu";
import { DropdownMenu, DropdownMenuItem, DropdownMenuSubMenu } from "@astryxdesign/core/DropdownMenu";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import { BranchMenu, type BranchTaken } from "@/components/workbench/branch-menu";
import { ChangesView, type FileReveal } from "@/components/workbench/changes-view";
import { DRAG_REGION_STYLE, NO_DRAG_REGION_STYLE } from "@/components/workbench/drag-region";
import { copyEntityHandle } from "@/components/workbench/entity-handle";
import { executorTaskIds as executorTaskIdsOf } from "@/components/workbench/executor-run";
import { ActivityDots } from "@/components/workbench/pending-dots";
import { SHORTCUT_MODIFIER_PREFIX } from "@/components/workbench/shortcut-modifier";
import { isDirWorkspace as isDirWorkspaceOf, type CofluxClient } from "@coflux/client";
import { cn } from "@/lib/utils";
import { ClawdGlyph } from "@/components/workbench/clawd-glyph";
import { AgentLogo, CodexLogo } from "@/components/settings/agent-logos";
import { effectiveAgents, type AgentId, type EffectiveAgent } from "@/components/settings/agent-settings";
import { useAgentSettings } from "@/components/settings/agent-settings-store";
import { hostLabel } from "@/components/workbench/browser-address";
import type { BrowserRuntime } from "@/components/workbench/browser-runtime";
import type { ScreenRuntime } from "@/components/workbench/screen-runtime";
import type { FileRuntime } from "@/components/workbench/file-runtime";
import { fileTabTitle } from "@/components/workbench/file-tabs";
import { FileView } from "@/components/workbench/file-view";
import { FileTypeIcon } from "@/components/workbench/changes-file-icon";
import { BrowserTabGlyph } from "@/components/workbench/browser-view";
import { desktop } from "@/config";
import type { TerminalAttach } from "@/components/workbench/terminal-attach";
import type { TerminalControlState } from "@/components/workbench/terminal-pane";
import {
  activateTab,
  equalizeSplit,
  focusGroup,
  groupBodyStyle,
  groupFrameStyle,
  isBrowserTabId,
  isFileTabId,
  isScreenTabId,
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
 * Codex shows its logo (plan 20261001-desktop-agents) and any other agent the lucide robot, both
 * with the state tints (approval/question→warning, done→success, as in the sidebar). */
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
  if (agent === "codex") return <CodexLogo className={cn("size-3 shrink-0", tone, className)} />;
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
  /** ⌘T: toggles the focused group's ＋ menu, opened as from the keyboard (first item focused, arrows, Enter). */
  toggleNewTabMenu: () => void;
  /** 文件 → 新建终端: a new terminal in the focused group. */
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
  /** 文件 / ⌘P → 新建浏览器标签页 (plan 20260924-desktop-browser-tab): a blank browser tab in the focused group. */
  openBrowserTab: () => void;
  /** 文件 / ⌘P → 新建屏幕标签页 (plan 20260929-remote-desktop): the workspace device's screen in the focused group; a no-op where not offered. */
  openScreenTab: () => void;
};

/**
 * What a workspace container may ask Workbench to do. Workbench owns every workspace's layout
 * (plan 20260923-terminal-split-groups): the container renders chrome from the layout it is given
 * and reports intents; it keeps no second copy of tab selection.
 */
export type WorkspaceLayoutActions = {
  /**
   * Apply a layout change that makes no tab newly chosen by the user (focus a group, resize a
   * split). `transient` changes (every pointermove of a sash drag) are not written to storage until
   * `persist` is called.
   */
  update: (workspaceId: string, change: (layout: TerminalLayout) => TerminalLayout, options?: { transient?: boolean }) => void;
  /** Write the layouts to storage now (the end of a sash drag). */
  persist: () => void;
  /** Current layout (not the render's copy): a sash drag reads its starting sizes from it. */
  get: (workspaceId: string) => TerminalLayout;
  /** A user action on a tab (click, banner's 重新接管): activates it, claims it back if detached, focuses it. */
  activateTab: (workspaceId: string, taskId: string) => void;
  /** A user moved a tab (drop, context-menu split): the moved tab is then activated as a user action. */
  moveTab: (workspaceId: string, taskId: string, change: (layout: TerminalLayout) => TerminalLayout) => void;
  /** ＋ in a group (or the empty state): focuses that group, then opens a terminal there. */
  createTerminal: (workspaceId: string, groupId: string) => void;
  /**
   * ＋ menu's Agent ▸ (plan 20261001-desktop-agents): focuses that group, then opens a terminal there
   * titled with the agent's name, which types the agent's launch command once the shell is ready.
   */
  createAgentTerminal: (workspaceId: string, groupId: string, agentId: AgentId) => void;
  /** ＋ menu's 浏览器: focuses that group, then opens a blank browser tab there. */
  createBrowserTab: (workspaceId: string, groupId: string) => void;
  /**
   * Opens (groupId) or closes (null) a group's ＋ menu. Workbench holds which one is open so ⌘T can
   * open the focused group's; at most one is open at a time.
   */
  setNewTabMenu: (workspaceId: string, groupId: string | null) => void;
  /** The ＋ menu closed and left the caret on its trigger (or nowhere): hand it back to the focused tab. */
  focusActiveTab: (workspaceId: string) => void;
  /** A browser tab's close button / context menu: removes the tab, no confirmation (plan 20260924-desktop-browser-tab). */
  closeBrowserTab: (workspaceId: string, tabId: string) => void;
  reloadBrowserTab: (tabId: string) => void;
  /** ＋ menu's 屏幕 (plan 20260929-remote-desktop): focuses that group, then opens the device's screen there. */
  createScreenTab: (workspaceId: string, groupId: string) => void;
  /** A screen tab's close button / context menu: ends the remote session, no confirmation. */
  closeScreenTab: (workspaceId: string, tabId: string) => void;
  /** A file tab's close button / context menu (plan 20261001-terminal-file-tab): removes the tab, no confirmation. */
  closeFileTab: (workspaceId: string, tabId: string) => void;
  /** 「在标签页中打开」 in the files overlay (plan 20261002-workspace-files-view): opens or focuses the file's tab. */
  openFileTab: (workspaceId: string, path: string, line?: number) => void;
};

type WorkspaceTerminalProps = {
  workspaceId: string;
  /** Whether this is the workspace on screen. Hidden ones stay mounted (the changes view keeps its collapsed state and fetched data). */
  active: boolean;
  client: CofluxClient;
  onCloseTask: (task: Task) => void;
  /** Panes and the attach machine live in Workbench (plan 104); the container only reads control states and reopens exited terminals through it. */
  attach: TerminalAttach;
  /** This workspace's layout, already reconciled against the task list by Workbench. */
  layout: TerminalLayout;
  /** The changes overlay covers the whole main area (toggled from the action dock). */
  changesOpen: boolean;
  /** Measured width of the action dock floating over the top-right strip. */
  dockWidth: number;
  /**
   * Space the left dock (the expand button right of the traffic lights) takes while the sidebar is
   * collapsed, 0 otherwise: the top-left strip and the changes overlay's header keep it free on their left.
   */
  leftDockReserve: number;
  actions: WorkspaceLayoutActions;
  /** Built-in browser tabs' titles, favicons and loading state for their strip chips. */
  browser: BrowserRuntime;
  /** Remote screen tabs' records for their strip chips (plan 20260929-remote-desktop). */
  screens: ScreenRuntime;
  /** File tabs' records and views (plan 20261001-terminal-file-tab). */
  files: FileRuntime;
  /** Whether 屏幕 is offered in this workspace's ＋ menu: its device advertises the helper and is not this Mac. */
  canOpenScreen: boolean;
  /** The group whose ＋ menu is open, if it is in this workspace. */
  newTabMenuGroupId: string | null;
  /** Terminal tabs opened as an agent (task id → agent id): their brand logo when no agent is detected. */
  agentTabs: Readonly<Record<string, AgentId>>;
  /** The latest file the workbench asked the files overlay to reveal in this workspace (plan 20261002-workspace-files-view). */
  fileReveal: FileReveal | null;
};

/**
 * The tab strip's ＋: a menu of what to open in this group — a terminal or a blank browser tab
 * (Cursor's new-tab menu without its search box). ⌘T opens the focused group's menu the same way;
 * Astryx treats that programmatic open as a keyboard one, so the first enabled item takes focus and
 * arrows / Enter / Esc work, and the items themselves carry no shortcut. While a terminal is being
 * created the terminal item waits (one create at a time) and the trigger spins in the group that
 * holds it; a browser tab can still be opened. Tooltip per docs/design-guidelines.md: a sibling
 * after the menu, suppressed while it is open.
 *
 * Agent ▸ (plan 20261001-desktop-agents) sits right below 终端 only while at least one agent is
 * effective in Settings; its flyout (hover, or → on it) lists those agents in catalog order. Each
 * opens a terminal, so each waits while a create is in flight, like 终端.
 */
function NewTabMenu({
  open,
  onOpenChange,
  busy,
  spinning,
  agents,
  onTerminal,
  onAgent,
  onBrowser,
  onScreen,
  onRestoreFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  busy: boolean;
  spinning: boolean;
  /** The account's effective agents in catalog order (plan 20261002-account-agent-settings). */
  agents: readonly EffectiveAgent[];
  onTerminal: () => void;
  onAgent: (agentId: AgentId) => void;
  onBrowser: () => void;
  /** 屏幕 (plan 20260929-remote-desktop); absent where the device does not offer it. */
  onScreen: (() => void) | null;
  onRestoreFocus: () => void;
}) {
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  // ⌘T with a long strip: the ＋ follows the last tab and may be scrolled out of view; the menu is
  // anchored to it, so bring it in first.
  useEffect(() => {
    if (open) anchorRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [open]);
  // A keyboard close (Esc) hands focus to the trigger before the caret goes back to the tab, and the
  // tooltip opens on keyboard focus whatever its isOpen says — it would flash. It reads isEnabled
  // from the last committed render, so it is switched off while the menu is open and stays off until
  // the trigger loses focus or the pointer comes back to it.
  const [tooltipQuiet, setTooltipQuiet] = useState(false);
  // Quieted when the menu opens: adjusted during render when `open` flips (null: not synced yet), so
  // it is committed together with the open menu.
  const [syncedOpen, setSyncedOpen] = useState<boolean | null>(null);
  if (open !== syncedOpen) {
    setSyncedOpen(open);
    if (open) setTooltipQuiet(true);
  }
  useEffect(() => {
    const trigger = anchorRef.current;
    if (!tooltipQuiet || !trigger) return;
    const release = () => setTooltipQuiet(false);
    trigger.addEventListener("focusout", release);
    trigger.addEventListener("pointerenter", release);
    return () => {
      trigger.removeEventListener("focusout", release);
      trigger.removeEventListener("pointerenter", release);
    };
  }, [tooltipQuiet]);
  function changeOpen(next: boolean) {
    onOpenChange(next);
    if (next) return;
    // A keyboard close (Esc, Enter on an item) puts the caret on the trigger, a pointer close on
    // nothing; either way the terminal would stop taking keys. Astryx moves focus after this
    // callback, so look once it settled, and leave alone a caret that went somewhere on purpose.
    requestAnimationFrame(() => {
      const focused = document.activeElement;
      if (!focused || focused === document.body || focused === anchorRef.current) onRestoreFocus();
    });
  }
  return (
    <>
      <DropdownMenu
        isMenuOpen={open}
        onOpenChange={changeOpen}
        menuWidth={200}
        // Lands on the role="menu" list; index.css exempts it from the no-pre-highlight rule so the
        // first item ⌘T focuses stays visible.
        className="coflux-new-tab-menu"
        hasChevron={false}
        placement="below"
        alignment="start"
        button={{
          ref: anchorRef,
          label: "新建标签页",
          icon: spinning ? <LoaderCircle className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />,
          isIconOnly: true,
          variant: "ghost",
          size: "sm",
          // Astryx puts the style on the <button> itself, so the no-drag hole lands on the trigger.
          style: { color: "var(--muted-foreground)", height: 24, width: 24, minWidth: 24, paddingInline: 0, marginLeft: 2, flexShrink: 0, ...NO_DRAG_REGION_STYLE },
        }}
      >
        <DropdownMenuItem
          icon={<SquareTerminal className="size-3.5" />}
          label="终端"
          isDisabled={busy}
          onClick={onTerminal}
        />
        {agents.length > 0 ? (
          <DropdownMenuSubMenu icon={<Sparkles className="size-3.5" />} label="Agent">
            {agents.map((agent) => (
              <DropdownMenuItem
                key={agent.id}
                icon={<AgentLogo agent={agent.id} className="size-3.5" />}
                label={agent.name}
                isDisabled={busy}
                onClick={() => onAgent(agent.id)}
              />
            ))}
          </DropdownMenuSubMenu>
        ) : null}
        <DropdownMenuItem icon={<Globe className="size-3.5" />} label="浏览器" onClick={onBrowser} />
        {onScreen ? <DropdownMenuItem icon={<Monitor className="size-3.5" />} label="屏幕" onClick={onScreen} /> : null}
      </DropdownMenu>
      <Tooltip anchorRef={anchorRef} isEnabled={!open && !tooltipQuiet} isOpen={open ? false : undefined} content="新建标签页" />
    </>
  );
}

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

/**
 * The drop highlight's box within a group body, as four insets. All four are always set, so moving
 * between zones is a plain CSS transition of top/right/bottom/left — the highlight glides from one
 * half to another instead of jumping.
 */
function zoneHighlightInsets(zone: LayoutSide | "center"): { top: string; right: string; bottom: string; left: string } {
  switch (zone) {
    case "left":
      return { top: "0%", right: "50%", bottom: "0%", left: "0%" };
    case "right":
      return { top: "0%", right: "0%", bottom: "0%", left: "50%" };
    case "up":
      return { top: "0%", right: "0%", bottom: "50%", left: "0%" };
    case "down":
      return { top: "50%", right: "0%", bottom: "0%", left: "0%" };
    default:
      return { top: "0%", right: "0%", bottom: "0%", left: "0%" };
  }
}

/**
 * A fully transparent 1×1 image handed to setDragImage. Chromium's own drag image is a snapshot of
 * the tab, and on macOS the pixels outside its rounded corners come out black; the tab is drawn by
 * us instead (see the drag ghost below), following the pointer.
 */
const EMPTY_DRAG_IMAGE: HTMLImageElement | null = (() => {
  if (typeof Image === "undefined") return null;
  const image = new Image();
  image.src = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
  return image;
})();

/** What the drag ghost shows and where the pointer held the tab. */
type DragGhost = {
  title: string;
  /** A browser tab's ghost shows its favicon (or a globe) instead of the terminal glyph. */
  browser: { favicon: string | null } | null;
  /** A screen tab's ghost shows the monitor glyph (plan 20260929-remote-desktop). */
  screen: boolean;
  /** A file tab's ghost shows its file-type icon (plan 20261001-terminal-file-tab): the file's path. */
  file: string | null;
  width: number;
  offsetX: number;
  offsetY: number;
  x: number;
  y: number;
};

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
  onEnd,
  onEqualize,
}: {
  sash: LayoutSash;
  /** The split's extent in px and its sizes at the start of the drag, or null when there is nothing to drag. */
  onStart: (container: HTMLElement) => { splitPx: number; startSizes: readonly number[] } | null;
  onResize: (deltaPx: number, splitPx: number, startSizes: readonly number[]) => void;
  /** The drag ended (released, cancelled or unmounted): the owner persists the final sizes. */
  onEnd: () => void;
  onEqualize: () => void;
}) {
  const [isResizing, setIsResizing] = useState(false);
  const dragRef = useRef<SashDrag | null>(null);
  // Unmounted mid-drag (a remote close collapsed a group, the tree reshaped): put the document's
  // cursor and text selection back, and tell the owner the drag is over. Pointer capture dies with
  // the element.
  const onEndRef = useRef(onEnd);
  useLayoutEffect(() => {
    onEndRef.current = onEnd;
  });
  useEffect(
    () => () => {
      const drag = dragRef.current;
      if (!drag) return;
      dragRef.current = null;
      document.documentElement.style.cursor = drag.previousCursor;
      document.documentElement.style.userSelect = drag.previousUserSelect;
      onEndRef.current();
    },
    [],
  );
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
    onEnd();
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

export function WorkspaceTerminal({
  workspaceId,
  active,
  client,
  onCloseTask,
  attach,
  layout,
  changesOpen,
  dockWidth,
  leftDockReserve,
  actions,
  browser,
  screens,
  files,
  canOpenScreen,
  newTabMenuGroupId,
  agentTabs,
  fileReveal,
}: WorkspaceTerminalProps) {
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
  // Agent ▸ lists the account's effective agents (plan 20261002-account-agent-settings); the hook
  // selects the stored configuration and derives in render, never a fresh array from the selector.
  const agentSettings = useAgentSettings(client);
  const effectiveAgentList = useMemo(() => effectiveAgents(agentSettings), [agentSettings]);
  const modPrefix = SHORTCUT_MODIFIER_PREFIX;
  const browserTabs = useStore(browser.tabs, (state) => state.tabs);
  const screenTabs = useStore(screens.tabs, (state) => state.tabs);
  const fileTabs = useStore(files.tabs, (state) => state.tabs);
  const daemons = useStore(client.store, (state) => state.daemons);
  // agent presence（plan 073/075）：引用只在实际变化时更新（worker 变化才发），直接订阅。
  const sessionAgents = useStore(client.store, (state) => state.sessionAgents);
  // Executor runs (plan 20260929-executor-pip): a tab whose terminal delegated a sub-task shows an
  // activity indicator while it is not on screen. The map only changes with a center snapshot.
  const executorRuns = useStore(client.store, (state) => state.executorRuns);
  const executorTaskIds = executorTaskIdsOf(executorRuns);
  // OSC 终端标题（plan 075）：来自 sessionMetadata（plan 20261010-terminal-checkpoint-energy），
  // 仍用选择器把本工作区的 title 摘出来浅比较，别的终端换标题时不重渲染整棵 WorkspaceTerminal。
  const checkpointTitles = useStore(
    client.store,
    useShallow((state) => {
      const titles: Record<string, string> = {};
      for (const task of state.tasks) {
        if (task.workspaceId !== workspaceId || !task.sessionId) continue;
        const title = state.sessionMetadata[task.sessionId]?.title;
        if (title) titles[task.sessionId] = title;
      }
      return titles;
    }),
  );

  // Directory workspace (no repo, plan 045/048): the carrier of a device detail view. It keeps terminal
  // tabs and ＋, but nothing with git semantics (branch button, diff) is rendered; the files overlay
  // shows its tree without the git parts (plan 20261002-workspace-files-view).
  const isDirWorkspace = Boolean(workspace && isDirWorkspaceOf(workspace));

  /** 切换分支中：目标分支名（按钮 pending 态；成功由 daemon 上报驱动 branch 变更后自动清除） */
  const [pendingBranch, setPendingBranch] = useState<string | null>(null);
  // 完成态看过一次就不再撒花：按 sessionId 记，下一轮又干活时清掉。
  const [seenDone, setSeenDone] = useState<ReadonlySet<string>>(() => new Set());
  // Tab drag (plan 20260923-terminal-split-groups): the dragged task, and where it would land.
  const [dragTaskId, setDragTaskId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  // Set by dragend. The drag state is entered one task after dragstart; if the drag never really
  // started (dragend first), entering it then would leave the strips without their drag region and
  // the drop zones covering every pane for good.
  const dragEndedRef = useRef(true);
  // The drawn drag image: captured at dragstart, moved by a window dragover listener straight on the
  // DOM node (one transform per frame, no React render per pointer move).
  // The state copy is what the ghost renders from; the ref is what the dragover listener moves.
  const dragGhostRef = useRef<DragGhost | null>(null);
  const [dragGhost, setDragGhost] = useState<DragGhost | null>(null);
  const ghostNodeRef = useRef<HTMLDivElement | null>(null);
  // The last zone each group highlighted, so a highlight fading out stays where it was instead of
  // snapping back to the centre while it fades.
  const [lastZones, setLastZones] = useState<ReadonlyMap<string, LayoutSide | "center">>(() => new Map());

  useEffect(() => {
    if (!dragTaskId) return;
    let frame = 0;
    function place() {
      frame = 0;
      const ghost = dragGhostRef.current;
      const node = ghostNodeRef.current;
      if (!ghost || !node) return;
      node.style.transform = `translate3d(${ghost.x - ghost.offsetX}px, ${ghost.y - ghost.offsetY}px, 0)`;
    }
    function onDragOver(event: DragEvent) {
      const ghost = dragGhostRef.current;
      // Chromium reports 0,0 on some drag events at the window edge; keep the last real position.
      if (!ghost || (event.clientX === 0 && event.clientY === 0)) return;
      ghost.x = event.clientX;
      ghost.y = event.clientY;
      if (!frame) frame = requestAnimationFrame(place);
    }
    place();
    window.addEventListener("dragover", onDragOver, { capture: true });
    return () => {
      window.removeEventListener("dragover", onDragOver, { capture: true });
      if (frame) cancelAnimationFrame(frame);
    };
  }, [dragTaskId]);

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
  // Cleared during render as soon as the reported branch has reached the target.
  if (pendingBranch && workspace?.branch === pendingBranch) setPendingBranch(null);
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

  // Which finished agents have been seen, as of this render: a session is forgotten once its agent
  // works again, and marked seen when its tab is on screen (this workspace is shown, the changes
  // overlay is closed, and it is its group's active tab). Adjusted during render; the tabs below
  // render from `seenNow`.
  let seenNext = seenDone;
  for (const { group } of geometry.groups) {
    for (const taskId of group.tabs) {
      if (isBrowserTabId(taskId) || isScreenTabId(taskId)) continue;
      const sessionId = taskById.get(taskId)?.sessionId;
      if (!sessionId) continue;
      const agentState = sessionAgents[sessionId]?.state;
      const done = agentState === "done" || agentState === "waiting";
      if (agentState && !done && seenNext.has(sessionId)) {
        const next = new Set(seenNext);
        next.delete(sessionId);
        seenNext = next;
      } else if (done && active && !changesOpen && group.activeTabId === taskId && !seenNext.has(sessionId)) {
        seenNext = new Set(seenNext).add(sessionId);
      }
    }
  }
  if (seenNext !== seenDone) setSeenDone(seenNext);
  const seenNow = seenNext;

  function endDrag() {
    setDragTaskId(null);
    setDropTarget(null);
    setDragGhost(null);
    dragGhostRef.current = null;
    setLastZones((current) => (current.size === 0 ? current : new Map()));
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

  /** Native HTML5 drag of any tab (terminal or browser); its payload is not a file type. */
  function tabDragProps(tabId: string, title: string, browserGhost: DragGhost["browser"], screenGhost = false, fileGhost: string | null = null) {
    return {
      draggable: true,
      onDragStart: (event: ReactDragEvent<HTMLDivElement>) => {
        event.dataTransfer.setData(TAB_DRAG_TYPE, tabId);
        event.dataTransfer.effectAllowed = "move";
        if (EMPTY_DRAG_IMAGE) event.dataTransfer.setDragImage(EMPTY_DRAG_IMAGE, 0, 0);
        const tabRect = event.currentTarget.getBoundingClientRect();
        dragGhostRef.current = {
          title,
          browser: browserGhost,
          screen: screenGhost,
          file: fileGhost,
          width: tabRect.width,
          offsetX: event.clientX - tabRect.left,
          offsetY: event.clientY - tabRect.top,
          x: event.clientX,
          y: event.clientY,
        };
        // Changing the DOM inside dragstart can cancel the drag in Chromium; let it start first.
        dragEndedRef.current = false;
        window.setTimeout(() => {
          if (dragEndedRef.current) return;
          setDragTaskId(tabId);
          setDragGhost(dragGhostRef.current);
        }, 0);
      },
      onDragEnd: () => {
        dragEndedRef.current = true;
        endDrag();
      },
    };
  }

  /**
   * A built-in browser tab's chip (plan 20260924-desktop-browser-tab): favicon (a spinner while
   * loading), the page title (else its host), a close button — the same chrome, drag and split
   * behaviour as a terminal tab. Closing needs no confirmation.
   */
  function renderBrowserTab(
    group: LayoutGroup,
    tabId: string,
    isActive: boolean,
    bright: boolean,
    activeClass: string,
    idleClass: string,
    indicators: ReactNode,
  ) {
    const view = browserTabs[tabId];
    const url = view?.url ?? "";
    const label = view?.title || (url ? hostLabel(url) : "新标签页");
    const canSplit = group.tabs.length > 1;
    return (
      <div
        key={tabId}
        data-tab-slot
        className={cn("relative shrink-0", dragTaskId === tabId && "opacity-50")}
        style={NO_DRAG_REGION_STYLE}
        {...tabDragProps(tabId, label, { favicon: view?.favicon ?? null })}
      >
        <ContextMenu
          label={`标签页「${label}」操作`}
          size="sm"
          items={[
            { label: "复制网址", isDisabled: !url, onClick: () => desktop.writeClipboard(url) },
            { label: "重新加载", isDisabled: !url, onClick: () => actions.reloadBrowserTab(tabId) },
            { type: "divider" },
            {
              label: "移到右侧新分组",
              isDisabled: !canSplit,
              onClick: () => actions.moveTab(workspaceId, tabId, (current) => moveTabToNewGroup(current, tabId, group.id, "right")),
            },
            {
              label: "移到下方新分组",
              isDisabled: !canSplit,
              onClick: () => actions.moveTab(workspaceId, tabId, (current) => moveTabToNewGroup(current, tabId, group.id, "down")),
            },
            { type: "divider" },
            { label: "关闭标签页", onClick: () => actions.closeBrowserTab(workspaceId, tabId) },
          ]}
        >
          <div className={cn("group flex h-7 max-w-52 items-center rounded-md text-sm transition-colors", isActive ? activeClass : idleClass)}>
            <button className="flex min-w-0 flex-1 items-center gap-1.5 self-stretch px-2.5 text-left" onClick={() => actions.activateTab(workspaceId, tabId)}>
              <BrowserTabGlyph favicon={view?.favicon ?? null} loading={view?.loading ?? false} className={bright ? "opacity-90" : "opacity-70"} />
              {url && view?.title ? (
                <Tooltip content={`${view.title} · ${url}`} placement="below">
                  <span className="truncate">{label}</span>
                </Tooltip>
              ) : (
                <span className="truncate">{label}</span>
              )}
            </button>
            {/* ⌘W closes the focused group's active tab only, so only that tab advertises it. */}
            <Tooltip content={bright ? `关闭标签页 ${modPrefix}W` : "关闭标签页"} placement="below">
              <button
                className="mr-0.5 flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-all hover:bg-muted hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
                onClick={() => actions.closeBrowserTab(workspaceId, tabId)}
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

  /**
   * A remote screen tab's chip (plan 20260929-remote-desktop): the monitor glyph, the device name, a
   * close button — the same chrome, drag and split behaviour as the other tabs. Closing ends the
   * remote session without confirmation (nothing on the remote is lost: its windows stay).
   */
  function renderScreenTab(
    group: LayoutGroup,
    tabId: string,
    isActive: boolean,
    bright: boolean,
    activeClass: string,
    idleClass: string,
    indicators: ReactNode,
  ) {
    const record = screenTabs[tabId];
    const daemon = record ? daemons.find((item) => item.daemonId === record.daemonId) : undefined;
    const label = daemon?.name ? `${daemon.name} 的屏幕` : "屏幕";
    const canSplit = group.tabs.length > 1;
    return (
      <div
        key={tabId}
        data-tab-slot
        className={cn("relative shrink-0", dragTaskId === tabId && "opacity-50")}
        style={NO_DRAG_REGION_STYLE}
        {...tabDragProps(tabId, label, null, true)}
      >
        <ContextMenu
          label={`标签页「${label}」操作`}
          size="sm"
          items={[
            {
              label: "移到右侧新分组",
              isDisabled: !canSplit,
              onClick: () => actions.moveTab(workspaceId, tabId, (current) => moveTabToNewGroup(current, tabId, group.id, "right")),
            },
            {
              label: "移到下方新分组",
              isDisabled: !canSplit,
              onClick: () => actions.moveTab(workspaceId, tabId, (current) => moveTabToNewGroup(current, tabId, group.id, "down")),
            },
            { type: "divider" },
            { label: "断开并关闭", onClick: () => actions.closeScreenTab(workspaceId, tabId) },
          ]}
        >
          <div className={cn("group flex h-7 max-w-52 items-center rounded-md text-sm transition-colors", isActive ? activeClass : idleClass)}>
            <button className="flex min-w-0 flex-1 items-center gap-1.5 self-stretch px-2.5 text-left" onClick={() => actions.activateTab(workspaceId, tabId)}>
              <Monitor className={cn("size-3 shrink-0", bright ? "opacity-90" : "opacity-70")} />
              <span className="truncate">{label}</span>
            </button>
            <Tooltip content={bright ? `断开并关闭 ${modPrefix}W` : "断开并关闭"} placement="below">
              <button
                className="mr-0.5 flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-all hover:bg-muted hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
                onClick={() => actions.closeScreenTab(workspaceId, tabId)}
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

  /**
   * A file tab's chip (plan 20261001-terminal-file-tab): the file-type icon, the file name (the
   * workspace-relative path in a tooltip, since names collide and truncate), a close button — the
   * same chrome, drag and split behaviour as the other tabs. Closing needs no confirmation.
   */
  function renderFileTab(
    group: LayoutGroup,
    tabId: string,
    isActive: boolean,
    bright: boolean,
    activeClass: string,
    idleClass: string,
    indicators: ReactNode,
  ) {
    const record = fileTabs[tabId];
    const path = record?.path ?? "";
    const label = path ? fileTabTitle(path) : "文件";
    const canSplit = group.tabs.length > 1;
    return (
      <div
        key={tabId}
        data-tab-slot
        className={cn("relative shrink-0", dragTaskId === tabId && "opacity-50")}
        style={NO_DRAG_REGION_STYLE}
        {...tabDragProps(tabId, label, null, false, path)}
      >
        <ContextMenu
          label={`标签页「${label}」操作`}
          size="sm"
          items={[
            { label: "复制路径", isDisabled: !path, onClick: () => desktop.writeClipboard(path) },
            { type: "divider" },
            {
              label: "移到右侧新分组",
              isDisabled: !canSplit,
              onClick: () => actions.moveTab(workspaceId, tabId, (current) => moveTabToNewGroup(current, tabId, group.id, "right")),
            },
            {
              label: "移到下方新分组",
              isDisabled: !canSplit,
              onClick: () => actions.moveTab(workspaceId, tabId, (current) => moveTabToNewGroup(current, tabId, group.id, "down")),
            },
            { type: "divider" },
            { label: "关闭标签页", onClick: () => actions.closeFileTab(workspaceId, tabId) },
          ]}
        >
          <div className={cn("group flex h-7 max-w-52 items-center rounded-md text-sm transition-colors", isActive ? activeClass : idleClass)}>
            <button className="flex min-w-0 flex-1 items-center gap-1.5 self-stretch px-2.5 text-left" onClick={() => actions.activateTab(workspaceId, tabId)}>
              <FileTypeIcon path={path} className={bright ? "opacity-90" : "opacity-70"} />
              {path ? (
                <Tooltip content={path} placement="below">
                  <span className="truncate">{label}</span>
                </Tooltip>
              ) : (
                <span className="truncate">{label}</span>
              )}
            </button>
            {/* ⌘W closes the focused group's active tab only, so only that tab advertises it. */}
            <Tooltip content={bright ? `关闭标签页 ${modPrefix}W` : "关闭标签页"} placement="below">
              <button
                className="mr-0.5 flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-all hover:bg-muted hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
                onClick={() => actions.closeFileTab(workspaceId, tabId)}
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
      // Optimistic pending tab (plan 078): a click only focuses it, never entering the activation/attach
      // machine; it has no close button and cannot be dragged.
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

    if (isBrowserTabId(taskId)) return renderBrowserTab(group, taskId, isActive, isActive && groupFocused, activeClass, idleClass, indicators);
    if (isScreenTabId(taskId)) return renderScreenTab(group, taskId, isActive, isActive && groupFocused, activeClass, idleClass, indicators);
    if (isFileTabId(taskId)) return renderFileTab(group, taskId, isActive, isActive && groupFocused, activeClass, idleClass, indicators);

    const task = taskById.get(taskId);
    if (!task) return null;
    const state = stateOf(task);
    const agentEntry = task.sessionId ? sessionAgents[task.sessionId] : undefined;
    // Opened as an agent from the ＋ menu: its logo whenever presence detection reports nothing, so
    // the brand identity comes back once the agent exits (detection overlays it while it runs).
    const launchedAgent = agentTabs[task.id];
    const sessionId = task.sessionId;
    const agentState = agentEntry?.state;
    const tabSeenDone = Boolean(sessionId && seenNow.has(sessionId));
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
        {...tabDragProps(task.id, tabTitle || "终端", null)}
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
              label: "移到右侧新分组",
              isDisabled: !canSplit,
              onClick: () => actions.moveTab(workspaceId, task.id, (current) => moveTabToNewGroup(current, task.id, group.id, "right")),
            },
            {
              label: "移到下方新分组",
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
                <AgentGlyph agent={agentEntry.agent} state={agentEntry.state} seen={tabSeenDone} className={bright ? "opacity-90" : "opacity-70"} />
              ) : launchedAgent ? (
                <AgentLogo agent={launchedAgent} className={cn("size-3", bright ? "opacity-90" : "opacity-70")} />
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
              {/* An executor run delegated from this terminal (plan 20260929-executor-pip), shown
                  only while the terminal is not on screen — on screen the card itself is visible. */}
              {executorTaskIds.has(task.id) && !(active && !changesOpen && isActive) ? (
                <Tooltip content="executor 正在执行子任务" placement="below">
                  <span className="flex shrink-0 items-center">
                    <ActivityDots status="active" label="executor 正在执行子任务" />
                  </span>
                </Tooltip>
              ) : null}
            </button>
            {/* ⌘W closes the focused group's active tab only, so only that tab advertises it. */}
            <Tooltip content={bright ? `关闭终端 ${modPrefix}W` : "关闭终端"} placement="below">
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
    const reserveLeftDock = top && touchesLeft(rect) && leftDockReserve > 0;
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
        {/* Group tab strip. The top-left group carries the branch button (with no split this is the old top
            bar, minus 「变更」, which moved into the action dock). Strips touching the window's top edge are
            window drag regions (plan 108): drag the window from empty space, double-click follows the macOS
            title-bar preference; lower groups' strips are not. A drag region swallows pointer events, so
            anything clickable or hoverable added here needs NO_DRAG_REGION_STYLE (see drag-region.ts). The
            top-right group reserves the action dock's measured width; with the sidebar collapsed the top-left
            group reserves the left dock's (traffic lights plus the expand button) the same way — as padding
            of this header, so that space drags the window exactly when the rest of the strip does. */}
        {/* `h-9` is GROUP_TAB_STRIP_HEIGHT (terminal-layout.ts): panes are placed that far below the group's top. */}
        <header
          className="flex h-9 min-w-0 shrink-0 items-center gap-2 border-b border-border bg-background pl-3"
          style={{
            ...(stripIsDragRegion ? DRAG_REGION_STYLE : NO_DRAG_REGION_STYLE),
            paddingRight: reserveDock ? dockWidth : 8,
            ...(reserveLeftDock ? { paddingLeft: leftDockReserve } : null),
          }}
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
            {/* ＋ follows the last tab (browser style) rather than sitting at the far right; like Cursor's, it
                asks what to open in this group. */}
            <NewTabMenu
              open={newTabMenuGroupId === group.id}
              onOpenChange={(open) => actions.setNewTabMenu(workspaceId, open ? group.id : null)}
              busy={Boolean(pending)}
              spinning={holdsPending}
              agents={effectiveAgentList}
              onTerminal={() => actions.createTerminal(workspaceId, group.id)}
              onAgent={(agentId) => actions.createAgentTerminal(workspaceId, group.id, agentId)}
              onBrowser={() => actions.createBrowserTab(workspaceId, group.id)}
              onScreen={canOpenScreen ? () => actions.createScreenTab(workspaceId, group.id) : null}
              onRestoreFocus={() => actions.focusActiveTab(workspaceId)}
            />
          </div>
        </header>

        {/* Group body. The pane layer covers it with the same rectangle (later in the DOM, pointer-events-none
            as a whole), so the empty state, the creating placeholder and the banners here still get clicks;
            banners are z-10, above the pane. */}
        <div className="relative min-h-0 min-w-0 flex-1 bg-terminal">
          {/* A file tab's view (plan 20261001-terminal-file-tab) lives in the group body: no pane layer,
              no webview. It remounts when its group's active tab changes; the runtime keeps what it
              showed, so it comes back at once and only asks whether the file changed. */}
          {group.activeTabId && isFileTabId(group.activeTabId) ? (
            <FileView key={group.activeTabId} runtime={files} client={client} tabId={group.activeTabId} onScreen={active && !changesOpen} />
          ) : null}
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
                <p className="mt-1.5 text-sm leading-5 text-muted-foreground">创建后会立即启动 shell，并作为一个新 Tab 打开。也可以按 {modPrefix}T 新建标签页。</p>
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
            <div className="absolute inset-x-0 top-0 z-10 flex items-center justify-between gap-2 border-b border-warning/20 bg-warning/10 px-4 py-2 text-sm text-warning backdrop-blur">
              <span className="flex min-w-0 items-center gap-2">
                <Unplug className="size-3.5 shrink-0" />
                <span className="truncate">此终端已被其它客户端接管，当前输入已锁定。</span>
              </span>
              <Button label="重新接管" variant="secondary" size="sm" onClick={() => actions.activateTab(workspaceId, activeTask.id)} />
            </div>
          ) : null}

          {/* 已退出终端（plan 097）：画面是回放的最后输出，重开 shell 是显式动作，不再一点 Tab 就悄悄起新会话。 */}
          {activeTask && activeTask.status === TaskStatus.EXITED && activeControlState === "stopped" ? (
            <div className="absolute inset-x-0 top-0 z-10 flex items-center justify-between gap-2 border-b border-border bg-background/80 px-4 py-2 text-sm text-muted-foreground backdrop-blur">
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

  // The container renders only group chrome (strips, body placeholders, sashes, drop zones) and the
  // changes overlay; panes are mounted by Workbench (plan 104). The wrapper is absolute inset-0 (see
  // workbench.tsx), so every rectangle here is relative to the terminal main area.
  return (
    <>
      {geometry.groups.map((entry) => renderGroup(entry.group, entry.rect))}

      {/* Sashes: after the group chrome (later in document order than the strips' drag regions, see drag-region.ts), z-20 above the pane layer. */}
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
                actions.update(
                  workspaceId,
                  (current) => resizeSplit(current, sash.path, sash.index, startSizes, deltaPx / splitPx, minPx / splitPx),
                  { transient: true },
                );
              }}
              onEnd={actions.persist}
              onEqualize={() => actions.update(workspaceId, (current) => equalizeSplit(current, sash.path))}
            />
          ))}

      {/* Drop zones, only while a tab is dragged: above the pane layer, so a tab dragged over a terminal lands
          here and never on the pane — whose drop upload only accepts files, and the tab payload is
          deliberately not a file. */}
      {dragTaskId && !changesOpen
        ? geometry.groups.map(({ group, rect }) => {
            const target = dropTarget?.kind === "zone" && dropTarget.groupId === group.id ? dropTarget.zone : null;
            const shownZone = target ?? lastZones.get(group.id) ?? "center";
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
                  if (target === zone) return;
                  setDropTarget({ kind: "zone", groupId: group.id, zone });
                  // Remembered so the highlight fades out where it was instead of snapping to the centre.
                  setLastZones((current) => (current.get(group.id) === zone ? current : new Map(current).set(group.id, zone)));
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
                {/* Always mounted while dragging: entering fades in, moving between zones glides the insets,
                    leaving fades out in place. The 4px inset keeps it clear of the group's edges. */}
                <div
                  aria-hidden
                  className={cn(
                    "pointer-events-none absolute rounded-md border border-primary/40 bg-primary/15 transition-[top,right,bottom,left,opacity] duration-150 ease-out",
                    target ? "opacity-100" : "opacity-0",
                  )}
                  style={Object.fromEntries(
                    Object.entries(zoneHighlightInsets(shownZone)).map(([edge, value]) => [edge, `calc(${value} + 4px)`]),
                  )}
                />
              </div>
            );
          })
        : null}

      {/* The drag image, drawn here (see EMPTY_DRAG_IMAGE): an opaque tab that follows the pointer.
          Positioned by the dragover listener, fixed to the viewport, never a pointer target. */}
      {dragTaskId && dragGhost ? (
        <div
          ref={ghostNodeRef}
          aria-hidden
          className="pointer-events-none fixed left-0 top-0 z-50 will-change-transform"
          style={{ transform: `translate3d(${dragGhost.x - dragGhost.offsetX}px, ${dragGhost.y - dragGhost.offsetY}px, 0)` }}
        >
          <div
            className="flex h-7 max-w-52 items-center gap-1.5 rounded-md border border-border bg-popover px-2.5 text-sm text-foreground shadow-lg transition-[opacity,transform] duration-150 ease-out starting:scale-95 starting:opacity-0"
            style={{ minWidth: Math.min(dragGhost.width, 208) }}
          >
            {dragGhost.browser ? (
              <BrowserTabGlyph favicon={dragGhost.browser.favicon} loading={false} className="opacity-90" />
            ) : dragGhost.screen ? (
              <Monitor className="size-3 shrink-0 opacity-90" />
            ) : dragGhost.file !== null ? (
              <FileTypeIcon path={dragGhost.file} />
            ) : (
              <SquareTerminal className="size-3 shrink-0 opacity-90" />
            )}
            <span className="truncate">{dragGhost.title}</span>
          </div>
        </div>
      ) : null}

      {/* The files overlay (「文件」, plan 20261002-workspace-files-view): opened from the action dock, it
          covers the whole main area (every group stays as it is underneath, agents keep running); pressing
          again or Esc returns to the groups. Kept alive like the panes (hidden, not unmounted), so its folded
          state and fetched data survive. Its top band is a window drag region as tall as a strip, so the
          window stays draggable while it is open; it reserves both docks' space, the left one only while the
          sidebar is collapsed. Directory workspaces render it too, without its git parts. */}
      <div className={cn("absolute inset-0 z-20 flex flex-col bg-terminal", changesOpen ? "" : "hidden")}>
        <header
          className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-background pl-3 text-sm"
          style={{ ...DRAG_REGION_STYLE, paddingRight: dockWidth, ...(leftDockReserve > 0 ? { paddingLeft: leftDockReserve } : null) }}
        >
          <FolderTree className="size-3 shrink-0 opacity-90" />
          <span>文件</span>
          <span className="text-sm text-muted-foreground">Esc 返回终端</span>
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
              isDirWorkspace={isDirWorkspace}
              reveal={fileReveal}
              onOpenFileTab={(path, line) => actions.openFileTab(workspaceId, path, line)}
            />
          </div>
        </div>
      </div>
    </>
  );
}
