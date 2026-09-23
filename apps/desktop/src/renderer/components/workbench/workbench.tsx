import { PortMenu } from "./port-menu";
import { NotificationInbox } from "./notification-inbox";
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import { useStore } from "zustand";
import { AlertCircle, FileDiff, FolderGit2, LoaderCircle, Plus, RefreshCw, SquareTerminal, X } from "lucide-react";
import { type DaemonInfo, type Project, type Task, type Workspace } from "@coflux/protocol";

import { AuthMessage, AuthShell, LoginScreen, authFooterText } from "@/components/auth/auth-shell";
import { dismissBootOverlay } from "@/boot-overlay";
import { Button } from "@astryxdesign/core/Button";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import {
  ConfirmActionDialog,
  DeviceRenameDialog,
  EnrollmentDialog,
  ProjectRenameDialog,
  ShortcutsHelpDialog,
  WorkspaceRenameDialog,
  type ConfirmAction,
} from "@/components/workbench/dialogs";
import { DaemonOnboardingDialog } from "@/components/workbench/daemon-onboarding";
import { NavigationPalette } from "@/components/workbench/command-palette";
import { deviceVisitKey, terminalVisitKey, workspaceVisitKey } from "@/components/workbench/command-palette-data";
import { recordRecentPlace, type RecentPlacesStore } from "@/components/workbench/command-palette-recent";
import { SettingsPage } from "@/components/settings/settings-page";
import { useSettingsTooltipControl } from "@/components/workbench/account-footer";
import { countLocalRunningTerminals } from "@/components/workbench/daemon-view";
import { attentionNotificationText, attentionSnapshot, diffAttention, type AttentionSnapshot } from "@/components/workbench/desktop-attention";
import { resolveOutdatedPrompt } from "@/components/workbench/desktop-update";
import { DESKTOP_DRAG_BAND_STYLE, NO_DRAG_REGION_STYLE } from "@/components/workbench/drag-region";
import { ImportProjectWizard } from "@/components/workbench/import-project-wizard";
import { Sidebar, type PendingWorkspace } from "@/components/workbench/sidebar";
import { useTerminalAttach } from "@/components/workbench/terminal-attach";
import { useDesktopDaemonState } from "@/components/workbench/use-desktop-daemon";
import { useExecutorBridge } from "@/components/workbench/use-executor-bridge";
import { useDesktopUpdateState } from "@/components/workbench/use-desktop-update";
import { useGlobalShortcuts } from "@/components/workbench/use-global-shortcuts";
import { useSidebarWidth } from "@/components/workbench/use-sidebar-width";
import type { WorkspaceLayoutActions, WorkspaceTerminalHandle } from "@/components/workbench/workspace-terminal";
import {
  EMPTY_LAYOUT,
  PENDING_TAB_PREFIX,
  activeTabIds,
  beginPendingTab,
  dropPendingTab,
  effectiveLayout,
  findCreatedTask,
  focusGroup,
  focusGroupByIndex,
  focusGroupInDirection,
  focusedGroupRelativeTab,
  focusedGroupTabAt,
  focusedTabId,
  groupBodyStyle,
  groupOfTab,
  layoutGeometry,
  planLayoutPersist,
  readStoredLayouts,
  revealTab,
  writeStoredLayouts,
  type LayoutSide,
  type TerminalLayout,
  type TerminalLayoutStore,
} from "@/components/workbench/terminal-layout";
import {
  parseStoredSelection,
  resolveSelectionAfterTaskMove,
  resolveWorkbenchSelection,
  resolveWorkbenchSurface,
  serializeSelection,
  shouldShowReconnectBanner,
  taskCloseNeedsConfirmation,
  type WorkbenchSelection,
} from "@/components/workbench/workbench-state";
import { COMMAND_PALETTE_RECENT_KEY, DAEMON_ONBOARDING_DISMISSED_KEY, TERMINAL_LAYOUTS_KEY, WORKSPACE_KEY, desktop } from "@/config";
import type { DesktopBridge } from "@/desktop-bridge";
import { cn } from "@/lib/utils";
import { isDirWorkspace, type CofluxClient } from "@coflux/client";

// 终端栈（xterm + WorkspaceTerminal/TerminalPanes）懒加载，不进首屏主 chunk：
// 登录页与"未选中工作区"的空状态都不需要它。module 级别声明，保证只 lazy() 一次，
// 不随 Workbench 重渲染重建（重建会丢已缓存的加载态触发重复 Suspense）。
// 接管状态机（terminal-attach）只在类型层面依赖 terminal-pane，静态导入不会把 xterm 拖进主 chunk。
const WorkspaceTerminal = lazy(() =>
  import("@/components/workbench/workspace-terminal").then((module) => ({ default: module.WorkspaceTerminal })),
);
const TerminalPanes = lazy(() =>
  import("@/components/workbench/terminal-panes").then((module) => ({ default: module.TerminalPanes })),
);

// 乐观创建（plan 078）的本地兜底：服务端既不广播成功也不广播错误时，撤掉 pending 条目，
// 避免永久滞留。与遮罩的 8s 无关——工作区创建含 daemon 侧 git worktree add，慢链路可能更长。
const PENDING_CREATE_TIMEOUT_MS = 15_000;

/** Terminal layouts are written this long after the last change (plan 20260923-terminal-split-groups). */
const LAYOUT_PERSIST_DELAY_MS = 400;

/**
 * 无顶栏的空态主区（plan 108）：顶部留一条与侧栏空白带等高的窗口拖拽带，没有终端顶栏时
 * 也能从主区顶部拖动 / 双击窗口；空态内容在余下区域里继续垂直居中，按钮不落进拖拽带
 * （拖拽区吞指针事件，见 drag-region.ts）。
 */
function EmptyMain({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <main className="flex min-w-0 flex-1 flex-col bg-terminal">
      <div className="shrink-0" style={DESKTOP_DRAG_BAND_STYLE} />
      <div className={cn("flex min-h-0 flex-1 items-center justify-center", className)}>{children}</div>
    </main>
  );
}

function readStoredSelection(): WorkbenchSelection | null {
  return parseStoredSelection(localStorage.getItem(WORKSPACE_KEY));
}

function persistSelection(selection: WorkbenchSelection | null) {
  const serialized = serializeSelection(selection);
  if (serialized === null) localStorage.removeItem(WORKSPACE_KEY);
  else localStorage.setItem(WORKSPACE_KEY, serialized);
}

/**
 * Where the ⌘P palette's 「最近」 list lives (plan 20260921). The store is the injection point the
 * MRU module asks for: it never reaches for `@/config` or `localStorage` itself, so it stays
 * unit-testable, and every read and write inside it is already guarded against storage throwing.
 */
const RECENT_PLACES_STORE: RecentPlacesStore = { storage: localStorage, key: COMMAND_PALETTE_RECENT_KEY };

/**
 * Where the terminal editor-group layouts live (plan 20260923-terminal-split-groups). Injected into
 * the layout module the same way: it never imports `@/config` or touches `localStorage` itself, and
 * every read and write inside it is guarded.
 */
const TERMINAL_LAYOUT_STORE: TerminalLayoutStore = { storage: localStorage, key: TERMINAL_LAYOUTS_KEY };

/** Nothing on screen: no workspace selected, or its changes overlay covers the groups. */
const NO_SCREEN: { visible: ReadonlySet<string>; focused: string | null } = { visible: new Set(), focused: null };

/** A workspace's task ids in creation order — the order new tabs join a strip. */
function workspaceTaskIds(tasks: readonly Task[], workspaceId: string): string[] {
  return tasks
    .filter((task) => task.workspaceId === workspaceId)
    .sort((left, right) => left.createdAt - right.createdAt)
    .map((task) => task.id);
}

/** 接入引导点过「暂不」（plan 113）：之后不再自动弹，只从账号菜单再进。localStorage 不可用时按没点过。 */
function persistOnboardingDismissed() {
  try {
    localStorage.setItem(DAEMON_ONBOARDING_DISMISSED_KEY, "1");
  } catch {
    // 记不住就下次登录再弹一次，无害
  }
}

/**
 * 桌面通知 + Dock 角标的驱动器（plan 103）：自己订阅 store（tasks/sessionAgents
 * 高频变化，不让根 Workbench 跟着重渲染），按两次快照的差分决定「新进入等待」才通知；角标按当前
 * 等待数设置、恢复即减。主进程只执行，不另起连接。渲染 null。
 */
function DesktopAttention({ client, bridge, selectedWorkspaceId }: { client: CofluxClient; bridge: DesktopBridge; selectedWorkspaceId: string | null }) {
  const workspaces = useStore(client.store, (state) => state.workspaces);
  const daemons = useStore(client.store, (state) => state.daemons);
  const tasks = useStore(client.store, (state) => state.tasks);
  const sessionAgents = useStore(client.store, (state) => state.sessionAgents);
  const projects = useStore(client.store, (state) => state.projects);
  const unreadCount = useStore(client.store, (state) => state.notificationInbox.unreadCount);
  const previousRef = useRef<AttentionSnapshot>({});
  const badgeRef = useRef(0);

  useEffect(() => {
    const next = attentionSnapshot({ workspaces, daemons, tasks, sessionAgents, projects });
    const { entered, badgeCount: waitingCount } = diffAttention(previousRef.current, next);
    const badgeCount = waitingCount + unreadCount;
    previousRef.current = next;
    if (badgeCount !== badgeRef.current) {
      badgeRef.current = badgeCount;
      bridge.setBadge(badgeCount);
    }
    for (const { workspaceId, entry } of entered) {
      // 正看着这个工作区且窗口有焦点：人已经在现场，只留角标不弹通知
      if (workspaceId === selectedWorkspaceId && document.hasFocus()) continue;
      bridge.notify({ workspaceId, ...attentionNotificationText(entry) });
    }
  }, [workspaces, daemons, tasks, sessionAgents, projects, bridge, selectedWorkspaceId, unreadCount]);

  // 卸载（登出、掉到 outdated/login 面）时清角标并重置快照：否则 Dock 会停在最后一个数字，
  // 且重新挂载后旧快照会让本该重新提醒的等待被当成「已提醒过」。
  useEffect(
    () => () => {
      previousRef.current = {};
      if (badgeRef.current !== 0) {
        badgeRef.current = 0;
        bridge.setBadge(0);
      }
    },
    [bridge],
  );

  return null;
}

/**
 * 版本准入被拒页（plan 103 / 105）：只在 app 的控制面协议版本低于中心最低支持版本时出现，被拒不是断线——
 * 挂载即触发一次更新检查，按 electron-updater 状态显示进度/重启按钮。
 */
function DesktopOutdated({ bridge }: { bridge: DesktopBridge }) {
  // 订阅 + 补拉一次由共用 hook 负责（侧栏账号脚部同款）；「挂载即检查」是本页独有的，留在这里。
  const update = useDesktopUpdateState(bridge);
  useEffect(() => {
    bridge.checkForUpdates();
  }, [bridge]);
  const prompt = resolveOutdatedPrompt(update);
  return (
    <AuthShell tagline="Coflux 需要更新" footer={authFooterText(bridge.serverUrl, bridge.version)}>
      <AuthMessage
        icon={prompt.busy ? <LoaderCircle className="size-5 animate-spin text-primary" /> : <RefreshCw className="size-5 text-primary" />}
        title={prompt.title}
        description={prompt.description}
      >
        {prompt.action ? (
          <Button
            className="mt-4 w-full"
            label={prompt.action.label}
            variant="primary"
            onClick={() => (prompt.action?.kind === "install" ? bridge.installUpdate() : bridge.checkForUpdates())}
          />
        ) : null}
      </AuthMessage>
    </AuthShell>
  );
}

export function Workbench({ client }: { client: CofluxClient }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [selection, setSelection] = useState<WorkbenchSelection | null>(readStoredSelection);
  // 访问过的工作区保持挂载（display 隐藏而非卸载）：卸载会 dispose xterm，
  // 丢 scrollback / 活跃 Tab / 控制权，切回来要重新 attach。同 TerminalPane 的 Tab 保活模式上移一层。
  const [visitedWorkspaceIds, setVisitedWorkspaceIds] = useState<ReadonlySet<string>>(new Set());
  const [dismissedErrorId, setDismissedErrorId] = useState<number | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [enrollmentOpen, setEnrollmentOpen] = useState(false);
  // 设备空态「新建终端」的进行中/错误态（plan 048）：fsList 失败在空态原地显示；
  // server 端拒绝走 error 广播 toast，同时解除 busy。
  const [deviceTerminalBusy, setDeviceTerminalBusy] = useState(false);
  const [deviceTerminalError, setDeviceTerminalError] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);
  const [renameWorkspace, setRenameWorkspace] = useState<Workspace | null>(null);
  const [renameDevice, setRenameDevice] = useState<DaemonInfo | null>(null);
  const [renameProject, setRenameProject] = useState<Project | null>(null);
  // 新建工作区菜单当前打开的项目：Sidebar 的 + 按钮/右键菜单与 Cmd+Ctrl+N 快捷键共用同一份受控状态。
  const [createMenuProjectId, setCreateMenuProjectId] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  // 本机 daemon（plan 113）：状态对象一份订阅，驱动账号菜单一行、面板与接入引导；引导只在登录成功
  // （中心已连上）后按状态自动弹一次，之后从账号菜单再进。
  const daemonState = useDesktopDaemonState(desktop);
  // executor（plan 116）：渲染层只把本机 daemon 的 device 通道两头接上，作业表在主进程。
  useExecutorBridge(client, daemonState?.daemonId);
  const [daemonDialog, setDaemonDialog] = useState<"onboarding" | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // The ⌘P navigation palette (plan 20260921). While it is open the whole workbench shortcut set
  // is suspended, which is what lets ⌘[ / ⌘] reach its filter tabs.
  const [paletteOpen, setPaletteOpen] = useState(false);
  // 侧栏宽度在这里持有一份，工作台侧栏与设置页左栏共用，避免设置页盖上来时宽度突变。
  const sidebarWidth = useSidebarWidth();
  // 齿轮 tooltip 的压制开关同理：点一下齿轮就换了一个脚部实例接管同一个位置，状态必须在它们之上。
  const settingsTooltip = useSettingsTooltipControl();
  const attemptedAuthToken = useRef<string | null>(null);
  const [localAuthError, setLocalAuthError] = useState<string | null>(null);
  const [authRetry, setAuthRetry] = useState(0);
  // 乐观工作区条目（plan 078）：存组件层、渲染时与 store 数据合并，不进共享 store——
  // 快照对 workspaces 是整体替换，注入的假条目会被无声抹掉；共享包也不该背 web 专有语义。
  const [pendingWorkspaces, setPendingWorkspaces] = useState<PendingWorkspace[]>([]);
  const pendingWorkspaceTimersRef = useRef(new Map<string, number>());
  const pendingWorkspaceSeqRef = useRef(0);
  // Command handle of the selected workspace only, rebuilt during render (see terminalHandleFor):
  // kept-alive hidden workspaces never get one, so global shortcuts only ever reach the selected one.
  const activeTerminalRef = useRef<WorkspaceTerminalHandle | null>(null);
  const [notificationOpen, setNotificationOpen] = useState(false);
  const activeWorkspaceIdRef = useRef<string | null>(null);
  // 已挂过面板的 task：面板寿命与工作区容器解耦，终端被搬到没访问过的工作区也不重建。
  const paneTaskIdsRef = useRef(new Set<string>());
  // Terminal editor groups (plan 20260923-terminal-split-groups). Every workspace's layout lives
  // here, and the ref is the source of truth: shortcuts, the store subscription and the attach gate
  // all read "now" values before React re-renders (the reason the old activeTabs had a ref mirror
  // too). `layoutVersion` only asks for a render. Stored layouts are read once and left
  // unreconciled — before the first snapshot there is nothing to reconcile them against.
  const [initialLayouts] = useState(() => readStoredLayouts(TERMINAL_LAYOUT_STORE));
  const layoutsRef = useRef<Record<string, TerminalLayout>>(initialLayouts);
  const [, setLayoutVersion] = useState(0);
  const lastWrittenLayoutsRef = useRef<string | null>(null);
  // Debounced persisting (see flushLayoutPersist): the layouts object last looked at, the pending
  // write, whether a sash drag is in progress, and the snapshot gate as of the last render.
  const checkedLayoutsRef = useRef<Record<string, TerminalLayout> | null>(null);
  const layoutPersistTimerRef = useRef<number | undefined>(undefined);
  const transientLayoutRef = useRef(false);
  const snapshotReadyRef = useRef(false);
  // The changes overlay, open per workspace; it survives switching away and back, as the old
  // per-container view did. Ref mirror for the same synchronous-read reason.
  const [changesOpen, setChangesOpenState] = useState<Record<string, boolean>>({});
  const changesOpenRef = useRef(changesOpen);
  // Optimistic terminal creates (plan 078) are layout entries now: this holds each workspace's
  // fallback timer, and `settledCreatesRef` the creates a reconcile answered during render, which an
  // effect then starts.
  const pendingCreateTimersRef = useRef(new Map<string, { pendingId: string; timer: number }>());
  const pendingCreateSeqRef = useRef(0);
  const settledCreatesRef = useRef<{ workspaceId: string; taskId: string; pendingId: string }[]>([]);
  // The action dock's measured width: the top-right group's strip reserves exactly this much.
  const [dockWidth, setDockWidth] = useState(0);

  const authState = useStore(client.store, (state) => state.authState);
  const loginError = useStore(client.store, (state) => state.loginError);
  const status = useStore(client.store, (state) => state.status);
  const projects = useStore(client.store, (state) => state.projects);
  const workspaces = useStore(client.store, (state) => state.workspaces);
  // 终端面板挂在本层（plan 104），故这里要全量 tasks：引用只在 task 实体真的变化时才换。
  const tasks = useStore(client.store, (state) => state.tasks);
  const daemons = useStore(client.store, (state) => state.daemons);
  const lastError = useStore(client.store, (state) => state.lastError);
  const snapshotRevision = useStore(client.store, (state) => state.snapshotRevision);

  // 设备详情的载体（plan 048）：该设备的 canonical 目录工作区 = isDirWorkspace 且
  // daemonId 匹配、createdAt 最早。与 server 侧 terminalCreate 幂等复用规则同构。
  const canonicalDirWorkspaceOf = (daemonId: string): Workspace | null =>
    workspaces
      .filter((workspace) => isDirWorkspace(workspace) && workspace.daemonId === daemonId)
      .sort((left, right) => left.createdAt - right.createdAt)[0] ?? null;

  const selectedWorkspace = selection?.kind === "workspace" ? (workspaces.find((workspace) => workspace.id === selection.id) ?? null) : null;
  const selectedDevice = selection?.kind === "device" ? (daemons.find((daemon) => daemon.daemonId === selection.id) ?? null) : null;
  // 选中的乐观条目（plan 078）：pending 期间 selectedWorkspace 解析为空，由它接管主区渲染。
  const pendingSelected = selection?.kind === "workspace" ? (pendingWorkspaces.find((item) => item.id === selection.id) ?? null) : null;
  // 主区实际渲染的工作区：workspace 选中即其本身；device 选中解析 canonical 目录工作区（可能为空 → 设备空态）
  const activeWorkspace = selection?.kind === "device" ? canonicalDirWorkspaceOf(selection.id) : selectedWorkspace;
  const activeWorkspaceId = activeWorkspace?.id ?? null;
  // pending 期间继续持有目标设备的 route：创建往返要走它，松开再重连只会更慢。
  const selectedDaemonId = selection?.kind === "device" ? selection.id : (selectedWorkspace?.daemonId ?? pendingSelected?.daemonId);

  // 选中工作区的同步镜像：面板可见性判定由渲染期与上报回调共用，直接闭包捕获会读到过期值。
  activeWorkspaceIdRef.current = activeWorkspaceId;

  // 接管状态机（plan 104）：与面板一起提升到本层，按 task id 记账、不认工作区。
  const attach = useTerminalAttach(client, { tasks });
  // Stored layouts are neither reconciled nor persisted before the first snapshot: until then the
  // task list is empty because nothing has arrived, not because everything was closed.
  const snapshotReady = snapshotRevision > 0 && authState === "authed";

  function layoutOf(workspaceId: string): TerminalLayout {
    return layoutsRef.current[workspaceId] ?? EMPTY_LAYOUT;
  }

  /**
   * Reconciles one workspace's layout against a task list straight into the ref — synchronously,
   * because both the render and the store subscription need the result before anything is drawn
   * (a reconcile one frame late would let the visible set reference a vanished task or miss a new
   * one). A pending create this answers is queued for activation.
   */
  function reconcileWorkspaceLayout(workspaceId: string, allTasks: readonly Task[], ready: boolean, follow: string | null = null): TerminalLayout {
    const stored = layoutsRef.current[workspaceId];
    const taskIds = ready ? workspaceTaskIds(allTasks, workspaceId) : [];
    const created = ready && stored ? findCreatedTask(stored, taskIds) : null;
    const next = effectiveLayout(stored, taskIds, { snapshotReady: ready, follow });
    if (next !== (stored ?? EMPTY_LAYOUT)) layoutsRef.current = { ...layoutsRef.current, [workspaceId]: next };
    if (created && stored?.pending) settledCreatesRef.current.push({ workspaceId, taskId: created, pendingId: stored.pending.id });
    return next;
  }
  const reconcileWorkspaceLayoutRef = useRef(reconcileWorkspaceLayout);
  reconcileWorkspaceLayoutRef.current = reconcileWorkspaceLayout;

  /** On screen: the active tab of every group of the selected workspace; nothing while its changes overlay is open. */
  function currentScreen(): { visible: ReadonlySet<string>; focused: string | null } {
    const workspaceId = activeWorkspaceIdRef.current;
    if (!workspaceId || changesOpenRef.current[workspaceId]) return NO_SCREEN;
    const layout = layoutOf(workspaceId);
    const visible = new Set(activeTabIds(layout).filter((id) => !id.startsWith(PENDING_TAB_PREFIX)));
    const focused = focusedTabId(layout);
    return { visible, focused: focused && visible.has(focused) ? focused : null };
  }

  /** Writes the visible set into the attach gate's mirror: once during render, again on every layout or overlay commit. */
  function syncVisible() {
    attach.setVisibleTaskIds(currentScreen().visible);
  }
  const syncVisibleRef = useRef(syncVisible);
  syncVisibleRef.current = syncVisible;

  function commitLayout(workspaceId: string, next: TerminalLayout) {
    if (layoutOf(workspaceId) === next) return;
    layoutsRef.current = { ...layoutsRef.current, [workspaceId]: next };
    syncVisible();
    setLayoutVersion((version) => version + 1);
  }

  function updateLayout(workspaceId: string, change: (layout: TerminalLayout) => TerminalLayout, options: { transient?: boolean } = {}) {
    transientLayoutRef.current = Boolean(options.transient);
    commitLayout(workspaceId, change(layoutOf(workspaceId)));
  }

  /** End of a sash drag: the transient sizes become the stored ones, written now. */
  function persistLayoutsNow() {
    transientLayoutRef.current = false;
    checkedLayoutsRef.current = layoutsRef.current;
    flushLayoutPersistRef.current();
  }

  function setWorkspaceChangesOpen(workspaceId: string, open: boolean) {
    if (Boolean(changesOpenRef.current[workspaceId]) === open) return;
    changesOpenRef.current = { ...changesOpenRef.current, [workspaceId]: open };
    setChangesOpenState(changesOpenRef.current);
    syncVisible();
    // Opening takes the caret out of the terminal, so no key — Esc above all — reaches a shell
    // hidden under the overlay. Closing is a user action (dock button, Esc, an activating command)
    // and hands the caret back to the focused pane explicitly: the dock button that was just clicked
    // holds focus, and the pane's own focus-on-`focused` yields to any element holding focus.
    if (open && document.activeElement instanceof HTMLElement) document.activeElement.blur();
    if (!open) {
      const focused = currentScreen().focused;
      if (focused) attach.focusTask(focused);
    }
  }
  const setWorkspaceChangesOpenRef = useRef(setWorkspaceChangesOpen);
  setWorkspaceChangesOpenRef.current = setWorkspaceChangesOpen;

  /**
   * A user action on one tab: click, shortcut, drop, palette or notification jump, the banner's
   * 重新接管. The tab is activated where it is (or joins the focused group when the layout does not
   * hold it yet), and this is the only path that may force-claim a detached task. Every activating
   * command closes the changes overlay first.
   */
  function activateTaskByUser(workspaceId: string, taskId: string) {
    setWorkspaceChangesOpen(workspaceId, false);
    commitLayout(workspaceId, revealTab(layoutOf(workspaceId), taskId));
    if (taskId.startsWith(PENDING_TAB_PREFIX)) return;
    const task = client.store.getState().tasks.find((item) => item.id === taskId);
    if (!task) return;
    attach.requestActivation(taskId, attach.stateOf(task) === "detached");
    attach.focusTask(taskId);
  }

  /** A user moved a tab (drop, context-menu split). Its pane only changes rectangle; the tab is then activated as a user action. */
  function moveTabByUser(workspaceId: string, taskId: string, change: (layout: TerminalLayout) => TerminalLayout) {
    commitLayout(workspaceId, change(layoutOf(workspaceId)));
    activateTaskByUser(workspaceId, taskId);
  }

  /**
   * Opens a terminal in the focused group or, with a side, in a new group split off it (⌘\ / ⌘⇧\).
   * Optimistic (plan 078): the pending tab is a layout entry until the created task replaces it in
   * place. One create per workspace at a time; asking again while one is in flight is a no-op.
   */
  function createTerminalIn(workspaceId: string, side: LayoutSide | null) {
    setWorkspaceChangesOpen(workspaceId, false);
    const layout = layoutOf(workspaceId);
    if (layout.pending) return;
    const known = workspaceTaskIds(client.store.getState().tasks, workspaceId);
    const title = `终端 ${known.length + 1}`;
    const pendingId = `${PENDING_TAB_PREFIX}${++pendingCreateSeqRef.current}`;
    commitLayout(workspaceId, beginPendingTab(layout, { id: pendingId, title, knownTaskIds: known }, side));
    // Local fallback: when taskCreate is answered by neither a success nor an error broadcast, drop the pending tab.
    const timer = window.setTimeout(() => {
      if (pendingCreateTimersRef.current.get(workspaceId)?.pendingId === pendingId) pendingCreateTimersRef.current.delete(workspaceId);
      updateLayout(workspaceId, (current) => dropPendingTab(current, pendingId));
    }, PENDING_CREATE_TIMEOUT_MS);
    pendingCreateTimersRef.current.set(workspaceId, { pendingId, timer });
    client.send({ case: "taskCreate", value: { workspaceId, title } });
  }

  /** Focus moves between groups (⌘1–9, ⌘⌥ arrows). No tab is newly chosen, so nothing is claimed. */
  function focusGroupBy(workspaceId: string, change: (layout: TerminalLayout) => TerminalLayout) {
    setWorkspaceChangesOpen(workspaceId, false);
    const next = change(layoutOf(workspaceId));
    commitLayout(workspaceId, next);
    const taskId = focusedTabId(next);
    if (taskId && !taskId.startsWith(PENDING_TAB_PREFIX)) attach.focusTask(taskId);
  }

  /** A pointer went down inside a pane: its group becomes the focused one (the pane layer sits above the chrome). */
  function focusPaneGroup(taskId: string) {
    const workspaceId = activeWorkspaceIdRef.current;
    if (!workspaceId) return;
    const layout = layoutOf(workspaceId);
    const group = groupOfTab(layout, taskId);
    if (group && group.id !== layout.focusedGroupId) commitLayout(workspaceId, focusGroup(layout, group.id));
  }

  // A terminal moved to another workspace (plan 104): when it is the one the user is watching (the
  // focused group's active tab of the selected workspace), the selection follows it, and it lands in
  // the new workspace's focused group as its active tab. This has to be settled before React renders:
  // the store subscription fires synchronously inside setState and batches with this render, so both
  // workspaces' layouts are moved right here and the render already reads the final result — the new
  // workspace never first falls back to attaching another tab, and the moved terminal never flickers.
  useEffect(() => {
    return client.store.subscribe((state, previous) => {
      if (state.tasks === previous.tasks || state.snapshotRevision === 0) return;
      const workspaceId = activeWorkspaceIdRef.current;
      if (!workspaceId) return;
      const watched = focusedTabId(layoutsRef.current[workspaceId] ?? EMPTY_LAYOUT);
      if (!watched || watched.startsWith(PENDING_TAB_PREFIX)) return;
      const next = resolveSelectionAfterTaskMove({ activeWorkspaceId: workspaceId, activeTaskId: watched, tasks: state.tasks });
      if (!next) return;
      reconcileWorkspaceLayoutRef.current(workspaceId, state.tasks, true);
      reconcileWorkspaceLayoutRef.current(next.id, state.tasks, true, watched);
      if (changesOpenRef.current[next.id]) {
        changesOpenRef.current = { ...changesOpenRef.current, [next.id]: false };
        setChangesOpenState(changesOpenRef.current);
      }
      activeWorkspaceIdRef.current = next.id;
      setSelection(next);
      persistSelection(next);
      syncVisibleRef.current();
      setLayoutVersion((version) => version + 1);
    });
  }, [client]);

  // 自动接入不依赖对话框打开；仍通过已登录客户端兑现一次性设备授权。
  const localAuthToken = daemonState?.status === "pending-auth" ? daemonState.authToken : undefined;
  useEffect(() => {
    if (authState !== "authed" || status !== "connected" || !localAuthToken || attemptedAuthToken.current === localAuthToken) return;
    attemptedAuthToken.current = localAuthToken;
    setLocalAuthError(null);
    void client.authorizeDevice(localAuthToken).then((result) => {
      if (!result.ok) {
        setLocalAuthError(result.error);
        setDaemonDialog("onboarding");
      }
    }).catch((error) => {
      setLocalAuthError(String(error));
      setDaemonDialog("onboarding");
    });
  }, [authState, status, localAuthToken, client, authRetry]);

  // 冷启动遮罩撤除（plan 078）：首快照到达即撤（snapshotRevision 单调递增，>0 一旦为真
  // 永远为真，断线不会误触发）；need-login/auth-failed 立即让位给登录表单。
  // 中心不可达的 8s 无条件兜底在 App.tsx。
  useEffect(() => {
    if (snapshotRevision > 0 || authState === "need-login" || authState === "auth-failed") dismissBootOverlay();
  }, [snapshotRevision, authState]);

  // 快照后校准选中项：无效选择回退到首项目 main workspace（或任一工作区）。
  // device 选中以设备仍在 daemons 为有效判据（离线设备仍可进详情看现场）。
  // 乐观条目（plan 078）天然不在 workspaces 里：pending 期间视为有效，否则
  // "点击后立即切换过去"会在同一帧被这里撤销，表现为点了没反应。
  useEffect(() => {
    if (snapshotRevision === 0) return;
    const resolution = resolveWorkbenchSelection({
      selection,
      pendingWorkspaceIds: new Set(pendingWorkspaces.map((item) => item.id)),
      projects,
      workspaces,
      daemons,
    });
    // 假 id 其实已落盘过一次（selectWorkspace 内部即 persist）：刷新后 pendingWorkspaces 为空，
    // 本 effect 判定 invalid 回退自愈，无害。pending 期间跳过 persist，只是不再重复写假 id。
    if (resolution.changed) setSelection(resolution.selection);
    if (resolution.shouldPersist) persistSelection(resolution.selection);
  }, [snapshotRevision, projects, workspaces, daemons, selection, pendingWorkspaces]);

  // 浏览器标签页标题跟随当前选中：项目工作区用项目名，设备详情用设备名。
  useEffect(() => {
    const project = projects.find((item) => item.id === selectedWorkspace?.projectId);
    document.title = selectedDevice ? `${selectedDevice.name} · coflux` : project ? `${project.name} · coflux` : "coflux · workspace";
  }, [selectedWorkspace, selectedDevice, projects]);

  // 只为当前进入的工作区显式持有 Device route；隐藏终端若仍 desired，会由 session 自身继续
  // 持有。切换/删除工作区时 release，避免一次 probe 永久留下 socket 与轮询器。
  useEffect(() => {
    if (!selectedDaemonId) return;
    return client.retainDevice(selectedDaemonId);
  }, [client, selectedDaemonId]);

  // 连接从进入页面就开始，而不是等进某个项目：侧栏要对每台在线设备显示延迟与路径，就得
  // 有连接。measureOnly = 一条 remote lane + 心跳，不碰 loopback、不配对、不轮询会话清单
  // （direct 只对与本机同机的那台设备有意义，为一个读数去敲它，对其余设备是注定失败的重试）。
  // 顺带把连接焐热，之后真进某台设备时不用再从头建连。
  // 依赖收敛成排序后的 id 串：daemons 每次广播都是新数组，直接依赖它会反复 retain/release。
  const onlineDaemonIds = daemons.filter((daemon) => daemon.online).map((daemon) => daemon.daemonId).sort().join(",");
  // 按设备增量维护，而不是整组重建：整组重建意味着任意一台设备睡下或新入网，都会把其余
  // 每一台的隧道拆掉重拨——侧栏会集体闪回 probing，重拨还会挤中心的 rendezvous 限流。
  const measurementHolds = useRef<{ client: CofluxClient | null; releases: Map<string, () => void> }>({ client: null, releases: new Map() });
  useEffect(() => {
    const held = measurementHolds.current;
    if (held.client !== client) {
      for (const release of held.releases.values()) release();
      held.releases.clear();
      held.client = client;
    }
    const wanted = new Set(onlineDaemonIds ? onlineDaemonIds.split(",") : []);
    for (const [daemonId, release] of [...held.releases]) {
      if (wanted.has(daemonId)) continue;
      release();
      held.releases.delete(daemonId);
    }
    for (const daemonId of wanted) {
      if (held.releases.has(daemonId)) continue;
      held.releases.set(daemonId, client.retainDevice(daemonId, { measureOnly: true }));
    }
  }, [client, onlineDaemonIds]);
  useEffect(() => () => {
    const held = measurementHolds.current;
    for (const release of held.releases.values()) release();
    held.releases.clear();
    held.client = null;
  }, []);

  function selectWorkspace(workspaceId: string) {
    const next: WorkbenchSelection = { kind: "workspace", id: workspaceId };
    setSelection(next);
    persistSelection(next);
  }

  /**
   * ⌘P (plan 20260921). Opening the palette closes the settings page first: settings owns Escape
   * in the capture phase and stops propagation, so with both on screen Escape would close settings
   * and leave the palette stranded. Closing needs no interlock — nothing can be under it by then.
   */
  function togglePalette() {
    if (paletteOpen) {
      setPaletteOpen(false);
      return;
    }
    setSettingsOpen(false);
    setPaletteOpen(true);
  }

  /**
   * Land on a terminal tab, wherever it lives. A terminal already in some group activates there and
   * that group takes focus; one the layout does not hold yet lands in the focused group. The target
   * workspace's layout is updated before it is selected, so its first render already shows the tab.
   */
  function openPaletteTerminal(workspaceId: string, taskId: string) {
    activateTaskByUser(workspaceId, taskId);
    // A directory workspace is the carrier of a device detail view, and selecting it directly
    // would leave the sidebar with nothing highlighted. Select the device instead — but only when
    // this really is the workspace that view resolves to, otherwise the panel would land elsewhere.
    const workspace = workspaces.find((item) => item.id === workspaceId);
    if (workspace && isDirWorkspace(workspace) && canonicalDirWorkspaceOf(workspace.daemonId)?.id === workspaceId) {
      selectDevice(workspace.daemonId);
      return;
    }
    selectWorkspace(workspaceId);
  }

  function navigateNotificationTask(taskId: string): boolean {
    const state = client.store.getState();
    const task = state.tasks.find((item) => item.id === taskId);
    if (!task || !state.workspaces.some((item) => item.id === task.workspaceId)) return false;
    activateTaskByUser(task.workspaceId, taskId);
    setSettingsOpen(false);
    selectWorkspace(task.workspaceId);
    return true;
  }

  // 点系统通知 → 主进程把窗口带到前台并回传工作区 id → 选中它（工作区已删则安静忽略）。
  useEffect(() => {
    return desktop.onFocusWorkspace((workspaceId) => {
      if (client.store.getState().workspaces.some((workspace) => workspace.id === workspaceId)) selectWorkspace(workspaceId);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  function selectDevice(daemonId: string) {
    const next: WorkbenchSelection = { kind: "device", id: daemonId };
    setSelection(next);
    persistSelection(next);
    setDeviceTerminalError(null);
  }

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await client.login(username, password);
  }

  /** Browser sign-in finished (plan 20260923): the main process stored the new token; connect with it. */
  async function loginWithBrowserToken() {
    const token = await desktop.getSessionToken().catch(() => "");
    if (token) client.loginWithToken(token);
  }

  function openEnrollment() {
    setImportOpen(false);
    setEnrollmentOpen(true);
  }

  function importProject(daemonId: string, path: string) {
    client.send({ case: "projectImport", value: { daemonId, path } });
  }

  // 设备详情首次开终端（plan 045/048）：先经设备浏览通道解析 HOME 绝对路径（FsListed.path），
  // 再发 terminalCreate；全链路绝对路径，daemon 侧不做 `~` 展开。设备已选中，无需自动切换——
  // workspaceCreated 广播到达后 canonical 解析自然让终端出现，busy 随空态卸载一并失效。
  async function createDeviceTerminal(daemonId: string) {
    setDeviceTerminalBusy(true);
    setDeviceTerminalError(null);
    const result = await client.listDeviceDirectory(daemonId, "~");
    if (!result.ok || !result.path) {
      setDeviceTerminalBusy(false);
      setDeviceTerminalError(result.error || "无法解析设备 HOME 目录");
      return;
    }
    client.send({ case: "terminalCreate", value: { daemonId, path: result.path } });
  }

  // server 拒绝（error 广播）或工作区已出现时解除设备空态的 busy。
  useEffect(() => {
    if (deviceTerminalBusy && (lastError || activeWorkspaceId)) setDeviceTerminalBusy(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastError, activeWorkspaceId]);

  // workspaceCreate 无请求-响应关联：记下发起时已知的工作区 id，
  // 广播中新出现的该项目工作区即本次创建的，自动切换过去（同终端创建的识别模式）。
  // pendingId 把这条识别与乐观条目（plan 078）绑定：转正/失败/超时都按它收敛。
  const pendingWorkspaceCreateRef = useRef<{ projectId: string; knownIds: Set<string>; pendingId: string } | null>(null);

  function removePendingWorkspace(pendingId: string) {
    const timer = pendingWorkspaceTimersRef.current.get(pendingId);
    if (timer !== undefined) window.clearTimeout(timer);
    pendingWorkspaceTimersRef.current.delete(pendingId);
    setPendingWorkspaces((prev) => prev.filter((item) => item.id !== pendingId));
  }

  function createWorkspace(project: Project, branch: string, createNew: boolean) {
    const pendingId = `pending-ws-${++pendingWorkspaceSeqRef.current}`;
    pendingWorkspaceCreateRef.current = {
      projectId: project.id,
      knownIds: new Set(client.store.getState().workspaces.map((workspace) => workspace.id)),
      pendingId,
    };
    // name = branch（未起名语义）；乐观条目下一帧即出现在侧栏并被选中，主区显示创建中
    setPendingWorkspaces((prev) => [...prev, { id: pendingId, projectId: project.id, branch, daemonId: project.daemonId }]);
    selectWorkspace(pendingId);
    pendingWorkspaceTimersRef.current.set(
      pendingId,
      window.setTimeout(() => {
        // 成功/失败广播都没到的兜底：撤条目，选中校准会把它回退到有效工作区。
        if (pendingWorkspaceCreateRef.current?.pendingId === pendingId) pendingWorkspaceCreateRef.current = null;
        removePendingWorkspace(pendingId);
      }, PENDING_CREATE_TIMEOUT_MS),
    );
    client.send({ case: "workspaceCreate", value: { projectId: project.id, name: branch, branch, createNew } });
  }

  useEffect(() => {
    const pending = pendingWorkspaceCreateRef.current;
    if (!pending) return;
    const created = workspaces.find((workspace) => workspace.projectId === pending.projectId && !pending.knownIds.has(workspace.id));
    if (created) {
      pendingWorkspaceCreateRef.current = null;
      removePendingWorkspace(pending.pendingId);
      selectWorkspace(created.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaces]);

  // 创建失败（error 广播）时丢弃 pending，避免误认后续他端创建的工作区
  useEffect(() => {
    if (!lastError) return;
    const pending = pendingWorkspaceCreateRef.current;
    pendingWorkspaceCreateRef.current = null;
    if (pending) removePendingWorkspace(pending.pendingId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastError]);

  // 卸载时清掉未收敛的 pending 兜底定时器（同 workspace-terminal 的 pendingTabTimer 清理）。
  useEffect(() => {
    const timers = pendingWorkspaceTimersRef.current;
    return () => {
      for (const timer of timers.values()) window.clearTimeout(timer);
      timers.clear();
    };
  }, []);


  function requestRemoveProject(project: Project) {
    setConfirmAction({
      title: `移除项目「${project.name}」？`,
      description: "项目记录和它的子工作区会从 coflux 中移除，主仓库本身不会被改动。此操作无法撤销。",
      confirmLabel: "移除项目",
      onConfirm: () => client.send({ case: "projectRemove", value: { projectId: project.id } }),
    });
  }

  function saveWorkspaceName(workspaceId: string, name: string) {
    client.send({ case: "workspaceSetName", value: { workspaceId, name } });
  }

  function saveDeviceName(daemonId: string, name: string) {
    client.send({ case: "deviceSetName", value: { daemonId, name } });
  }

  function saveProjectName(projectId: string, name: string) {
    client.send({ case: "projectSetName", value: { projectId, name } });
  }

  function requestRemoveWorkspace(workspace: Workspace) {
    setConfirmAction({
      title: `删除工作区「${workspace.branch}」？`,
      description: `对应的 git worktree 目录会被移除，分支「${workspace.branch}」不会被自动删除。`,
      confirmLabel: "删除工作区",
      onConfirm: () => client.send({ case: "workspaceRemove", value: { workspaceId: workspace.id } }),
    });
  }

  function requestRemoveDevice(daemon: DaemonInfo) {
    setConfirmAction({
      title: `移除设备「${daemon.name}」？`,
      description: "这台设备下的所有项目、工作区和终端记录会一并删除。若要再次接入，需要重新登记。",
      confirmLabel: "移除设备",
      onConfirm: () => client.send({ case: "clientRemoveDevice", value: { daemonId: daemon.daemonId } }),
    });
  }

  function closeTaskNow(task: Task) {
    // RUNNING 先由本机 session authority 停 PTY；中心已认证时再删除 catalog task。中心离线时
    // 只记录明确的本地 exit，不伪造远端 task 删除。
    void client.closeTask(task);
  }

  function requestCloseTask(task: Task) {
    if (!taskCloseNeedsConfirmation(task.status)) {
      closeTaskNow(task);
      return;
    }
    setConfirmAction({
      title: `关闭终端「${task.title || "终端"}」？`,
      description: "正在运行的 shell 会先停止，随后永久删除这个 Tab。终端中的历史输出不会保留。",
      confirmLabel: "停止并关闭",
      onConfirm: () => closeTaskNow(task),
    });
  }

  useEffect(() => {
    if (!activeWorkspaceId) return;
    setVisitedWorkspaceIds((prev) => (prev.has(activeWorkspaceId) ? prev : new Set(prev).add(activeWorkspaceId)));
  }, [activeWorkspaceId]);

  // 已删除的工作区随 workspaces 过滤自动卸载；含 activeWorkspaceId 是避免等 visited 效果多一帧空白。
  const terminalWorkspaces = workspaces.filter((workspace) => visitedWorkspaceIds.has(workspace.id) || workspace.id === activeWorkspaceId);

  // 面板寿命与工作区容器解耦（plan 104）：终端被搬进从没访问过的工作区时容器可能压根没挂载过，
  // 面板必须原样留在原地。挂过面板的 task 只要还在快照里就一直挂着，只有真的被删才收回。
  const liveTaskIds = new Set(tasks.map((task) => task.id));
  for (const taskId of paneTaskIdsRef.current) {
    if (!liveTaskIds.has(taskId)) paneTaskIdsRef.current.delete(taskId);
  }
  const paneTasks = tasks
    .filter((task) => {
      if (visitedWorkspaceIds.has(task.workspaceId) || task.workspaceId === activeWorkspaceId) paneTaskIdsRef.current.add(task.id);
      return paneTaskIdsRef.current.has(task.id);
    })
    // 顺序必须稳定：快照会整体替换 tasks，按 createdAt/id 排一遍，已挂载的面板就不会被 React
    // 搬位置（搬位置＝重新插入 DOM，xterm 的 open(host) 绑定与 WebGL 上下文都可能受影响）。
    .sort((left, right) => left.createdAt - right.createdAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  // Layouts of every mounted workspace, reconciled during render (never in an effect one frame late),
  // then the visible set written straight into the attach gate.
  const workspaceLayouts = new Map<string, TerminalLayout>();
  for (const workspace of terminalWorkspaces) workspaceLayouts.set(workspace.id, reconcileWorkspaceLayout(workspace.id, tasks, snapshotReady));
  const screen = currentScreen();
  attach.setVisibleTaskIds(screen.visible);
  const selectedLayout = activeWorkspaceId ? layoutOf(activeWorkspaceId) : EMPTY_LAYOUT;
  // Each visible pane sits on its group's body, in percentages the browser lays out in the same frame.
  const paneFrames = new Map<string, CSSProperties>();
  for (const { group, rect } of layoutGeometry(selectedLayout).groups) {
    if (group.activeTabId && screen.visible.has(group.activeTabId)) paneFrames.set(group.activeTabId, groupBodyStyle(rect));
  }
  const selectedChangesOpen = Boolean(activeWorkspaceId && changesOpen[activeWorkspaceId]);

  // A create that reconcile answered: the task took the pending tab's place; start it as the old
  // container did — unless the user picked another tab in that group while waiting (settling never steals the choice).
  // Declared before the visible-set effect below so the user-action path is queued first.
  useEffect(() => {
    if (settledCreatesRef.current.length === 0) return;
    const settled = settledCreatesRef.current;
    settledCreatesRef.current = [];
    for (const { workspaceId, taskId, pendingId } of settled) {
      const timer = pendingCreateTimersRef.current.get(workspaceId);
      if (timer?.pendingId === pendingId) {
        window.clearTimeout(timer.timer);
        pendingCreateTimersRef.current.delete(workspaceId);
      }
      const layout = layoutOf(workspaceId);
      if (groupOfTab(layout, taskId)?.activeTabId !== taskId) continue;
      attach.requestActivation(taskId);
      if (workspaceId === activeWorkspaceIdRef.current && focusedTabId(layout) === taskId) attach.focusTask(taskId);
    }
  });

  // Panes that came on screen without the user choosing that tab — workspace switch, overlay
  // closed, a background group's fallback, a restored layout — are refitted and attached without
  // forcing. A user activation is already queued by then and makes this a no-op for its tab.
  // Switching workspace is a user action: the focused pane takes the caret even though the sidebar
  // entry that was clicked holds focus (the pane's own focus-on-`focused` yields to it).
  useEffect(() => {
    if (screen.focused) attach.focusTask(screen.focused);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeWorkspaceId]);

  const shownTaskIdsRef = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const previous = shownTaskIdsRef.current;
    shownTaskIdsRef.current = screen.visible;
    for (const taskId of screen.visible) if (!previous.has(taskId)) attach.ensureVisible(taskId);
  });

  // Persisting: only after the first snapshot, only when the layouts object changed since the last
  // look (every change replaces it, so an identity check is enough to skip unrelated renders), and
  // debounced so a burst of changes is one write. Sash drags commit transient layouts on every
  // pointermove and do not schedule a write at all; the drag's end flushes.
  snapshotReadyRef.current = snapshotReady;
  function flushLayoutPersist() {
    if (layoutPersistTimerRef.current !== undefined) window.clearTimeout(layoutPersistTimerRef.current);
    layoutPersistTimerRef.current = undefined;
    const serialized = planLayoutPersist({
      snapshotReady: snapshotReadyRef.current,
      layouts: layoutsRef.current,
      lastWritten: lastWrittenLayoutsRef.current,
    });
    if (serialized === null) return;
    lastWrittenLayoutsRef.current = serialized;
    writeStoredLayouts(TERMINAL_LAYOUT_STORE, serialized);
  }
  const flushLayoutPersistRef = useRef(flushLayoutPersist);
  flushLayoutPersistRef.current = flushLayoutPersist;
  useEffect(() => {
    if (!snapshotReady || transientLayoutRef.current || checkedLayoutsRef.current === layoutsRef.current) return;
    checkedLayoutsRef.current = layoutsRef.current;
    if (layoutPersistTimerRef.current !== undefined) window.clearTimeout(layoutPersistTimerRef.current);
    layoutPersistTimerRef.current = window.setTimeout(() => flushLayoutPersistRef.current(), LAYOUT_PERSIST_DELAY_MS);
  });
  // A write still waiting when the window goes away (quit, reload) happens right then.
  useEffect(() => {
    const flush = () => flushLayoutPersistRef.current();
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, []);

  // An error broadcast drops the in-flight optimistic creates (taskCreate failed); the attach machine clears its own launching state.
  useEffect(() => {
    if (!lastError) return;
    for (const [workspaceId, entry] of pendingCreateTimersRef.current) {
      window.clearTimeout(entry.timer);
      updateLayout(workspaceId, (current) => dropPendingTab(current, entry.pendingId));
    }
    pendingCreateTimersRef.current.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastError]);

  useEffect(() => {
    const timers = pendingCreateTimersRef.current;
    return () => {
      for (const entry of timers.values()) window.clearTimeout(entry.timer);
      timers.clear();
    };
  }, []);

  // The ⌘P recent list (plan 20260921) only counts the terminal the user is actually looking at:
  // the focused group's active tab while on screen — never a background group's fallback, never
  // the optimistic tab. Declared before the workspace-visit effect below so that on a workspace
  // switch the workspace still ends up in front, as it always did.
  const lookedAtTerminalKey = activeWorkspaceId && screen.focused ? `${activeWorkspaceId}:${screen.focused}` : null;
  useEffect(() => {
    const taskId = screen.focused;
    if (!lookedAtTerminalKey || !taskId) return;
    if (client.store.getState().tasks.some((task) => task.id === taskId)) recordRecentPlace(RECENT_PLACES_STORE, terminalVisitKey(taskId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lookedAtTerminalKey]);

  // The ⌘P recent list (plan 20260921) records the place the user is actually looking at, which
  // includes the one restored from storage on a cold start — without that, the first ⌘P after a
  // restart would have no "previous place" to bounce back to. Keying the effect on the composed
  // key rather than the selection object keeps snapshot reconciliation, which re-resolves the
  // selection on every batch, from writing on every batch; recording is move-to-front anyway.
  const visitedPlaceKey =
    selection?.kind === "device" ? deviceVisitKey(selection.id) : selectedWorkspace ? workspaceVisitKey(selectedWorkspace.id) : null;
  useEffect(() => {
    if (visitedPlaceKey) recordRecentPlace(RECENT_PLACES_STORE, visitedPlaceKey);
  }, [visitedPlaceKey]);

  // Esc closes the changes overlay — only while nothing else that owns Esc is open (settings,
  // palette, dialogs, the notification inbox), and only when no menu or dialog holds the focus:
  // sibling capture listeners on one target cannot stop each other.
  const overlayEscapeBlocked =
    settingsOpen ||
    paletteOpen ||
    helpOpen ||
    notificationOpen ||
    importOpen ||
    enrollmentOpen ||
    confirmAction !== null ||
    renameWorkspace !== null ||
    renameDevice !== null ||
    renameProject !== null ||
    daemonDialog !== null;
  useEffect(() => {
    if (!selectedChangesOpen || overlayEscapeBlocked || !activeWorkspaceId) return;
    const workspaceId = activeWorkspaceId;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const focused = document.activeElement;
      if (focused instanceof Element && focused.closest('[role="menu"], [role="listbox"], [role="dialog"], [role="alertdialog"], dialog')) return;
      event.preventDefault();
      event.stopPropagation();
      setWorkspaceChangesOpenRef.current(workspaceId, false);
    }
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [selectedChangesOpen, overlayEscapeBlocked, activeWorkspaceId]);

  // The single entry point for workbench commands (global shortcuts and the native menu): built for
  // the selected workspace only, during render, so a hidden workspace can never receive one.
  function terminalHandleFor(workspaceId: string): WorkspaceTerminalHandle {
    return {
      createTerminal: () => createTerminalIn(workspaceId, null),
      closeActiveTab: () => {
        // Suspended while the overlay is open: a blind ⌘W would close a terminal nobody can see.
        if (changesOpenRef.current[workspaceId]) return;
        const taskId = focusedTabId(layoutOf(workspaceId));
        const task = taskId ? client.store.getState().tasks.find((item) => item.id === taskId) : undefined;
        if (task) requestCloseTask(task);
      },
      selectTabByIndex: (index) => {
        const taskId = focusedGroupTabAt(layoutOf(workspaceId), index);
        if (taskId) activateTaskByUser(workspaceId, taskId);
        else setWorkspaceChangesOpen(workspaceId, false);
      },
      selectRelativeTab: (delta) => {
        const taskId = focusedGroupRelativeTab(layoutOf(workspaceId), delta);
        if (taskId) activateTaskByUser(workspaceId, taskId);
        else setWorkspaceChangesOpen(workspaceId, false);
      },
      focusGroupByIndex: (index) => focusGroupBy(workspaceId, (layout) => focusGroupByIndex(layout, index)),
      focusGroupInDirection: (side) => focusGroupBy(workspaceId, (layout) => focusGroupInDirection(layout, side)),
      splitTerminal: (side) => createTerminalIn(workspaceId, side),
    };
  }
  activeTerminalRef.current = activeWorkspaceId ? terminalHandleFor(activeWorkspaceId) : null;

  const workspaceActions: WorkspaceLayoutActions = {
    update: updateLayout,
    persist: persistLayoutsNow,
    get: layoutOf,
    activateTab: activateTaskByUser,
    moveTab: moveTabByUser,
    createTerminal: (workspaceId, groupId) => {
      updateLayout(workspaceId, (layout) => focusGroup(layout, groupId));
      createTerminalIn(workspaceId, null);
    },
  };

  // The dock is measured rather than sized by a constant: with the changes button and its +X −Y
  // badge its width varies, and the top-right strip's reserved space and the fade follow it.
  const attachDock = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    setDockWidth(node.offsetWidth);
    const observer = new ResizeObserver(() => setDockWidth(node.offsetWidth));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const showError = lastError !== null && lastError.id !== dismissedErrorId;
  const displayError = lastError?.message.replaceAll("任务", "终端");

  useGlobalShortcuts({
    selectedProjectId: selectedWorkspace?.projectId ?? null,
    activeTerminalRef,
    onOpenCreateWorkspaceMenu: setCreateMenuProjectId,
    onToggleHelp: () => setHelpOpen((open) => !open),
    onToggleSettings: () => setSettingsOpen((open) => !open),
    onTogglePalette: togglePalette,
    // 设置页盖住工作台时终端既看不见也点不到，⌘T/⌘W/⌘1 之类再落到终端上就是盲操作；
    // 原生菜单项走同一条挂起开关。跳转面板同理，而且它还要拿回被这里吞掉的 ⌘[ ⌘]。
    isSuspended: settingsOpen || paletteOpen,
  });

  const surface = resolveWorkbenchSurface(authState);
  const showReconnectBanner = shouldShowReconnectBanner(status);

  // 恢复会话 / 登录握手中：只显示安静加载，不渲染登录表单（避免刷新闪一下）。
  if (surface === "authenticating") {
    return (
      <div className="flex h-screen min-w-[1024px] items-center justify-center bg-background text-muted-foreground">
        <LoaderCircle className="size-5 animate-spin" />
      </div>
    );
  }

  // 版本准入被拒（协议过旧，plan 105）：不是认证失败，独立展示面，不复用登录表单的 error 语义
  // （混用会误导用户以为账号/密码有问题）。bundle 在 app 里、reload 不会变新：显示「需要更新」并触发自动更新检查。
  if (surface === "outdated") return <DesktopOutdated bridge={desktop} />;

  if (surface === "login") {
    return (
      <LoginScreen
        bridge={desktop}
        username={username}
        password={password}
        passwordError={authState === "auth-failed" ? loginError || "登录失败" : undefined}
        onUsernameChange={setUsername}
        onPasswordChange={setPassword}
        onSubmit={login}
        onBrowserLogin={() => void loginWithBrowserToken()}
      />
    );
  }

  return (
    // 断线时给顶部横幅留出 h-7：横幅是 fixed 的，不留白就会压住终端 tab 栏，中心离线期间
    // 点不到切换/关闭终端（padding 改变容器高度，终端 fit 由 ResizeObserver 跟随）。
    <div
      className={cn(
        "relative flex h-screen min-h-[640px] min-w-[1024px] overflow-hidden bg-background text-foreground",
        showReconnectBanner && "pt-7",
      )}
    >
      <DesktopAttention client={client} bridge={desktop} selectedWorkspaceId={selection?.kind === "workspace" ? selection.id : null} />
      <Sidebar
        client={client}
        selectedWorkspaceId={selection?.kind === "workspace" ? selection.id : null}
        onSelectWorkspace={selectWorkspace}
        selectedDeviceId={selection?.kind === "device" ? selection.id : null}
        onSelectDevice={selectDevice}
        onImportProject={() => setImportOpen(true)}
        onCreateWorkspace={createWorkspace}
        onRemoveProject={requestRemoveProject}
        onRenameProject={setRenameProject}
        onRemoveWorkspace={requestRemoveWorkspace}
        onRenameWorkspace={setRenameWorkspace}
        onAddDevice={openEnrollment}
        onRemoveDevice={requestRemoveDevice}
        onRenameDevice={setRenameDevice}
        createMenuProjectId={createMenuProjectId}
        onCreateMenuProjectIdChange={setCreateMenuProjectId}
        pendingWorkspaces={pendingWorkspaces}
        onToggleSettings={() => setSettingsOpen((open) => !open)}
        widthControl={sidebarWidth}
        settingsTooltip={settingsTooltip}
      />

      {terminalWorkspaces.length > 0 ? (
        <Suspense
          fallback={
            <EmptyMain className="text-muted-foreground">
              <LoaderCircle className="size-5 animate-spin" />
            </EmptyMain>
          }
        >
          {/* Terminal main area (plan 104 / 20260923-terminal-split-groups): one positioned box. The workspace
              container fills it and draws each group's chrome from the layout tree (tab strips, body
              placeholders, sashes); the pane layer is their later sibling, keyed by task id, and places
              each visible pane on its group's body rectangle. Moving a tab between groups or a terminal
              between workspaces only changes a rectangle: panes are neither rebuilt with a container nor
              dependent on the new workspace's container being mounted. Hidden, with panes kept mounted,
              while no workspace is selected. */}
          <main className={cn("relative isolate min-w-0 flex-1 bg-terminal", !activeWorkspaceId && "hidden")}>
            {terminalWorkspaces.map((workspace) => {
              const isActive = workspace.id === activeWorkspaceId;
              return (
                <div key={workspace.id} className={isActive ? "absolute inset-0" : "hidden"}>
                  <WorkspaceTerminal
                    workspaceId={workspace.id}
                    active={isActive}
                    client={client}
                    onCloseTask={requestCloseTask}
                    attach={attach}
                    layout={workspaceLayouts.get(workspace.id) ?? layoutOf(workspace.id)}
                    changesOpen={Boolean(changesOpen[workspace.id])}
                    dockWidth={dockWidth}
                    actions={workspaceActions}
                  />
                </div>
              );
            })}
            <TerminalPanes
              tasks={paneTasks}
              visibleTaskIds={screen.visible}
              focusedTaskId={screen.focused}
              frames={paneFrames}
              onPaneFocus={focusPaneGroup}
              client={client}
              attach={attach}
            />
          </main>
        </Suspense>
      ) : null}
      {selectedDevice && !activeWorkspace ? (
        // 设备详情空态（plan 048）：这台设备还没有目录工作区，首次新建走 fsList(~) + terminalCreate；
        // 创建成功后 canonical 解析让终端自然出现，本空态随之卸载。
        <EmptyMain>
          <div className="flex max-w-sm flex-col items-center text-center">
            <div className="mb-4 flex size-10 items-center justify-center rounded-lg border border-border text-muted-foreground">
              <SquareTerminal className="size-5" />
            </div>
            <h1 className="text-base font-medium">在「{selectedDevice.name}」上开一个终端</h1>
            <p className="mt-1.5 text-sm leading-5 text-muted-foreground">
              {selectedDevice.online
                ? "终端会打开在这台设备的 HOME 目录，之后可以在顶栏继续开更多 Tab。"
                : "设备当前离线，上线后才能新建终端。"}
            </p>
            <Button
              className="mt-5"
              label="新建终端"
              variant="primary"
              size="sm"
              icon={<Plus />}
              isDisabled={!selectedDevice.online}
              isLoading={deviceTerminalBusy}
              onClick={() => void createDeviceTerminal(selectedDevice.daemonId)}
            />
            {deviceTerminalError ? <p className="mt-3 text-sm leading-5 text-destructive">{deviceTerminalError}</p> : null}
          </div>
        </EmptyMain>
      ) : null}
      {pendingSelected ? (
        // 乐观工作区的主区（plan 078）：pending 条目不进 attach/终端状态机、不产生任何
        // 指向假 id 的请求，主区只显示创建中提示；广播到达后由上面的识别效果原地转正。
        <EmptyMain>
          <div className="flex max-w-sm flex-col items-center text-center">
            <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
            <h1 className="mt-4 text-base font-medium">正在创建工作区「{pendingSelected.branch}」</h1>
            <p className="mt-1.5 text-sm leading-5 text-muted-foreground">正在设备上准备 git worktree，完成后会自动切换过去。</p>
          </div>
        </EmptyMain>
      ) : null}
      {!pendingSelected && !selectedDevice && !activeWorkspace ? (
        snapshotRevision === 0 ? (
          // 首快照未到：数据没到 ≠ 数据为空（plan 078 第③跳），不得误报引导空态。
          // 遮罩正常会盖住这里；遮罩兜底撤除后（中心不可达）这里配合断线横幅语义成立。
          <EmptyMain className="text-muted-foreground">
            <LoaderCircle className="size-5 animate-spin" />
          </EmptyMain>
        ) : (
        <EmptyMain>
          <div className="flex max-w-sm flex-col items-center text-center">
            <div className="mb-4 flex size-10 items-center justify-center rounded-lg border border-border text-muted-foreground">
              <FolderGit2 className="size-5" />
            </div>
            <h1 className="text-base font-medium">{projects.length === 0 ? "从一个项目开始" : "选择一个工作区"}</h1>
            <p className="mt-1.5 text-sm leading-5 text-muted-foreground">
              {projects.length === 0 ? "导入在线设备上的 git 仓库，主工作区会自动创建。" : "从左侧项目或子工作区进入终端工作台。"}
            </p>
            {projects.length === 0 ? (
              <Button className="mt-5" label="导入项目" variant="primary" size="sm" onClick={() => setImportOpen(true)} />
            ) : null}
          </div>
        </EmptyMain>
        )
      ) : null}

      {/* 断线重连横幅：保留最后快照渲染（乐观 UI），只提示连接状态。根容器同步留出 pt-7。 */}
      {showReconnectBanner ? (
        <div className="fixed inset-x-0 top-0 z-50 flex h-7 items-center justify-center gap-2 border-b border-warning/20 bg-warning/10 text-xs text-warning backdrop-blur">
          <LoaderCircle className="size-3 animate-spin" />
          连接已断开，正在自动重连…下方显示的是最后一次同步的状态。
        </div>
      ) : null}

      {showError ? (
        <div className="fixed bottom-4 right-4 z-40 flex max-w-md items-start gap-3 rounded-lg border border-destructive/30 bg-popover px-4 py-3 text-sm shadow-2xl">
          <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
          <span className="leading-5 text-foreground">{displayError}</span>
          <button
            className="ml-2 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={() => setDismissedErrorId(lastError!.id)}
            title="关闭"
          >
            <X className="size-3.5" />
          </button>
        </div>
      ) : null}

      <ImportProjectWizard
        open={importOpen}
        daemons={daemons}
        onOpenChange={setImportOpen}
        onImport={importProject}
        onAddDevice={openEnrollment}
        listDirectory={client.listDeviceDirectory}
      />
      <WorkspaceRenameDialog
        workspace={renameWorkspace}
        open={Boolean(renameWorkspace)}
        onOpenChange={(open) => !open && setRenameWorkspace(null)}
        onSave={saveWorkspaceName}
      />
      <DeviceRenameDialog
        daemon={renameDevice}
        open={Boolean(renameDevice)}
        onOpenChange={(open) => !open && setRenameDevice(null)}
        onSave={saveDeviceName}
      />
      <ProjectRenameDialog
        project={renameProject}
        open={Boolean(renameProject)}
        onOpenChange={(open) => !open && setRenameProject(null)}
        onSave={saveProjectName}
      />
      <ConfirmActionDialog action={confirmAction} onCancel={() => setConfirmAction(null)} />
      {/* The ⌘P navigation palette (plan 20260921). Kept mounted and toggled through `isOpen`
          rather than mounted on demand: astryx's Dialog hands focus back to whatever was focused
          before it opened, and unmounting it means nobody does — Escape would leave the terminal
          without focus. The palette rebuilds its snapshot in the render that opens it, so nothing
          of the previous open survives. */}
      <NavigationPalette
        isOpen={paletteOpen}
        onOpenChange={setPaletteOpen}
        client={client}
        recentStore={RECENT_PLACES_STORE}
        current={{
          workspaceId: activeWorkspaceId,
          // The focused group's active tab while on screen (null under the changes overlay), never a background group's.
          taskId: screen.focused,
          daemonId: selection?.kind === "device" ? selection.id : null,
        }}
        onOpenWorkspace={selectWorkspace}
        onOpenTerminal={openPaletteTerminal}
        onOpenDevice={selectDevice}
      />
      <ShortcutsHelpDialog open={helpOpen} onOpenChange={setHelpOpen} />
      <EnrollmentDialog open={enrollmentOpen} onOpenChange={setEnrollmentOpen} />
      {settingsOpen ? (
        <SettingsPage
          client={client}
          daemonState={daemonState}
          runningTerminals={daemonState ? countLocalRunningTerminals(tasks, daemonState.daemonId) : 0}
          hasTopBanner={showReconnectBanner}
          widthControl={sidebarWidth}
          settingsTooltip={settingsTooltip}
          onClose={() => setSettingsOpen(false)}
          onOpenOnboarding={() => {
            setSettingsOpen(false);
            setDaemonDialog("onboarding");
          }}
        />
      ) : null}

      {/* 本机 daemon（plan 113）：接入引导；状态没到之前不渲染 */}
      {daemonState ? (
        <DaemonOnboardingDialog
          open={daemonDialog === "onboarding"}
          onOpenChange={(open) => !open && setDaemonDialog(null)}
          state={daemonState}
          client={client}
          bridge={desktop}
          authError={localAuthError}
          onRetryAuthorize={() => { attemptedAuthToken.current = null; setAuthRetry((value) => value + 1); }}
          onDismiss={persistOnboardingDismissed}
        />
      ) : null}

      {/* The action dock at the top right: one instance serves every workspace, empty states included,
          so it stays outside the tab strips. It floats over the space the top-right group's strip
          reserves for it (its measured width, see attachDock), and that strip is a window drag region
          (plan 108). Electron composes drag regions in **document order** — `drag` is a union, `no-drag`
          a difference — so this node must come after the main area: placed before it, the hole it punches
          is filled back in by the strip's later `drag`, and the dock's buttons get no click or mouseenter
          (dead buttons, no tooltips; see drag-region.ts). It is absolutely positioned, so being last only
          changes composition and paint order, not layout.
          「变更」 (plan 20260923-terminal-split-groups) lives here instead of a resident tab: pressing it
          covers the whole main area with the changes view, pressing again or Esc returns to the groups.
          Directory workspaces have no git semantics and get no such button. */}
      <div
        ref={attachDock}
        role="group"
        aria-label="终端栏操作"
        className="absolute right-0 z-30 flex h-9 items-center gap-2 border-b border-border bg-background px-3"
        style={{ top: showReconnectBanner ? 28 : 0, ...NO_DRAG_REGION_STYLE }}
      >
        <div aria-hidden className="pointer-events-none absolute inset-y-0 right-full w-6 bg-gradient-to-r from-transparent to-background" />
        {activeWorkspace && !isDirWorkspace(activeWorkspace) ? (
          <Tooltip content={selectedChangesOpen ? "返回终端 Esc" : "变更"} placement="below">
            <button
              type="button"
              aria-label="变更"
              aria-pressed={selectedChangesOpen}
              className={cn(
                "flex h-6 min-w-6 shrink-0 items-center justify-center gap-1.5 rounded-md px-1.5 transition-colors",
                selectedChangesOpen ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
              onClick={() => setWorkspaceChangesOpen(activeWorkspace.id, !selectedChangesOpen)}
            >
              <FileDiff className="size-3.5" />
              {activeWorkspace.additions > 0 || activeWorkspace.deletions > 0 ? (
                <span className="whitespace-nowrap font-mono text-2xs tabular-nums">
                  <span className="text-success">+{activeWorkspace.additions}</span>{" "}
                  <span className="text-destructive">−{activeWorkspace.deletions}</span>
                </span>
              ) : null}
            </button>
          </Tooltip>
        ) : null}
        <PortMenu key={activeWorkspaceId ?? "none"} client={client} workspaceId={activeWorkspaceId} />
        <NotificationInbox client={client} open={notificationOpen} onOpen={() => { setSettingsOpen(false); setNotificationOpen(true); }} onClose={() => setNotificationOpen(false)} onNavigate={navigateNotificationTask} />
      </div>
    </div>
  );
}
