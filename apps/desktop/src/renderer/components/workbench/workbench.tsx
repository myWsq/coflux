import { PortMenu } from "./port-menu";
import { NotificationInbox } from "./notification-inbox";
import { lazy, Suspense, useCallback, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import { useStore } from "zustand";
import { AlertCircle, FolderGit2, FolderTree, LoaderCircle, Monitor, Plus, RefreshCw, SquareTerminal, X } from "lucide-react";
import { SCREEN_CAPABILITY, TaskStatus, type DaemonInfo, type Project, type Task, type Workspace } from "@coflux/protocol";

import { AuthMessage, AuthShell, LoginScreen, authFooterText } from "@/components/auth/auth-shell";
import { dismissBootOverlay } from "@/boot-overlay";
import { Button } from "@astryxdesign/core/Button";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import {
  ConfirmActionDialog,
  DeviceRenameDialog,
  ProjectRenameDialog,
  ShortcutsHelpDialog,
  WorkspaceRenameDialog,
  type ConfirmAction,
} from "@/components/workbench/dialogs";
import { AddDeviceDialog } from "@/components/workbench/add-device-dialog";
import { DaemonOnboardingDialog } from "@/components/workbench/daemon-onboarding";
import { NavigationPalette } from "@/components/workbench/command-palette";
import { deviceVisitKey, terminalVisitKey, workspaceVisitKey } from "@/components/workbench/command-palette-data";
import { recordRecentPlace, type RecentPlacesStore } from "@/components/workbench/command-palette-recent";
import { candidateSessionTitles, currentTerminals, nextAttentionRow } from "@/components/workbench/current-terminals";
import { SettingsPage } from "@/components/settings/settings-page";
import { useSettingsTooltipControl } from "@/components/workbench/account-footer";
import { countLocalRunningTerminals } from "@/components/workbench/daemon-view";
import { attentionNotificationText, attentionSnapshot, diffAttention, type AttentionSnapshot } from "@/components/workbench/desktop-attention";
import { resolveOutdatedPrompt } from "@/components/workbench/desktop-update";
import { DESKTOP_DRAG_BAND_STYLE, NO_DRAG_REGION_STYLE } from "@/components/workbench/drag-region";
import { ImportProjectWizard } from "@/components/workbench/import-project-wizard";
import { Sidebar, type PendingWorkspace } from "@/components/workbench/sidebar";
import {
  LEFT_DOCK_WIDTH,
  SidebarToggleButton,
  leftDockLeft,
  leftDockReserve,
  persistSidebarCollapsed,
  readSidebarCollapsed,
} from "@/components/workbench/sidebar-collapse";
import { SHORTCUT_MODIFIER_PREFIX } from "@/components/workbench/shortcut-modifier";
import { useTerminalAttach } from "@/components/workbench/terminal-attach";
import type { EffectiveAgent } from "@/components/settings/agent-settings";
import { currentEffectiveAgents } from "@/components/settings/agent-settings-store";
import { useAgentLaunches } from "@/components/workbench/use-agent-launches";
import { useDesktopDaemonState } from "@/components/workbench/use-desktop-daemon";
import { useExecutorBridge } from "@/components/workbench/use-executor-bridge";
import { BrowserViews, type BrowserViewEntry } from "@/components/workbench/browser-view";
import { createBrowserRuntime } from "@/components/workbench/browser-runtime";
import { browserScopeOfWorkspace } from "../../../shared/browser-partitions";
import { createBrowserTabId, readBrowserTabRecords, restoreBrowserTabs, type BrowserTabStore } from "@/components/workbench/browser-tabs";
import type { BrowserLibraryStore } from "@/components/workbench/browser-library";
import { localPortUrl, normalizeIncomingUrl } from "@/components/workbench/browser-address";
import { ScreenViews, type ScreenViewEntry } from "@/components/workbench/screen-view";
import { createScreenRuntime } from "@/components/workbench/screen-runtime";
import { readScreenRecords, type ScreenRecordStore } from "@/components/workbench/screen-records";
import { createFileRuntime } from "@/components/workbench/file-runtime";
import { createFileTabId, findFileTab, readFileTabRecords, restoreFileTabs, type FileTabStore } from "@/components/workbench/file-tabs";
import { useDesktopUpdateState } from "@/components/workbench/use-desktop-update";
import { useGlobalShortcuts } from "@/components/workbench/use-global-shortcuts";
import { useSidebarWidth } from "@/components/workbench/use-sidebar-width";
import type { WorkspaceLayoutActions, WorkspaceTerminalHandle } from "@/components/workbench/workspace-terminal";
import type { FileReveal } from "@/components/workbench/changes-view";
import {
  EMPTY_LAYOUT,
  PENDING_TAB_PREFIX,
  activeTabIds,
  beginPendingTab,
  dropPendingTab,
  effectiveLayout,
  findCreatedTask,
  focusGroup,
  focusedGroup,
  focusGroupByIndex,
  focusGroupInDirection,
  focusedGroupRelativeTab,
  focusedGroupTabAt,
  focusedTabId,
  groupBodyStyle,
  groupOfTab,
  isBrowserTabId,
  isFileTabId,
  isTaskTabId,
  layoutGeometry,
  openTabBeside,
  planLayoutPersist,
  readStoredLayouts,
  removeTab,
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
import {
  BROWSER_LIBRARY_KEY,
  BROWSER_TABS_KEY,
  COMMAND_PALETTE_RECENT_KEY,
  DAEMON_ONBOARDING_DISMISSED_KEY,
  FILE_TABS_KEY,
  LEGACY_SCREEN_TABS_KEY,
  SCREENS_KEY,
  TERMINAL_LAYOUTS_KEY,
  WORKSPACE_KEY,
  desktop,
} from "@/config";
import type { DesktopBridge } from "@/desktop-bridge";
import { cn } from "@/lib/utils";
import { isDirWorkspace, isProjectArchived, isWorkspaceArchived, type CofluxClient, type CofluxState } from "@coflux/client";

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
 * With the sidebar collapsed the left dock floats over the band's left end: the band holds
 * nothing that could sit under the traffic lights or the dock, so its reserved space is simply the
 * empty band, which keeps dragging the window around the dock's no-drag hole.
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

/**
 * Built-in browser tabs (plan 20260924-desktop-browser-tab): each tab's record (workspace, URL,
 * title), next to the layouts and scoped the same way; and the global history library.
 */
const BROWSER_TAB_STORE: BrowserTabStore = { storage: localStorage, key: BROWSER_TABS_KEY };
const BROWSER_LIBRARY_STORE: BrowserLibraryStore = { storage: localStorage, key: BROWSER_LIBRARY_KEY };
/** Open remote screens' records (plan 20261011-standalone-device-screen): one per device, its remote session id. */
const SCREEN_RECORD_STORE: ScreenRecordStore = { storage: localStorage, key: SCREENS_KEY };
/** File tabs' records (plan 20261001-terminal-file-tab): workspace, canonical path and line per tab. */
const FILE_TAB_STORE: FileTabStore = { storage: localStorage, key: FILE_TABS_KEY };

/** Nothing on screen: no workspace selected, or its changes overlay covers the groups. */
const NO_SCREEN: { visible: ReadonlySet<string>; focused: string | null } = { visible: new Set(), focused: null };

/** A workspace's task ids in creation order — the order new tabs join a strip. */
function workspaceTaskIds(tasks: readonly Task[], workspaceId: string): string[] {
  return tasks
    .filter((task) => task.workspaceId === workspaceId)
    .sort((left, right) => left.createdAt - right.createdAt)
    .map((task) => task.id);
}

/**
 * Stored layouts are neither reconciled nor persisted before the first snapshot: until then the
 * task list is empty because nothing has arrived, not because everything was closed.
 */
function isSnapshotReady(state: Pick<CofluxState, "snapshotRevision" | "authState">): boolean {
  return state.snapshotRevision > 0 && state.authState === "authed";
}

/** On screen: the active tab of every group of the selected workspace; nothing while its changes overlay is open. */
function screenOf(
  workspaceId: string | null,
  changesOpen: Readonly<Record<string, boolean>>,
  layouts: Readonly<Record<string, TerminalLayout>>,
): { visible: ReadonlySet<string>; focused: string | null } {
  if (!workspaceId || changesOpen[workspaceId]) return NO_SCREEN;
  const layout = layouts[workspaceId] ?? EMPTY_LAYOUT;
  // Terminals only: the pending tab and browser tabs never reach the attach machine.
  const visible = new Set(activeTabIds(layout).filter(isTaskTabId));
  const focused = focusedTabId(layout);
  return { visible, focused: focused && visible.has(focused) ? focused : null };
}

/** The terminal on screen in a workspace's layout (the sidebar's 「当前」 highlight and ⌘⇧A's start): the focused group's active tab when it is a task tab. */
function onScreenTaskOf(layout: TerminalLayout): string | null {
  const focused = focusedTabId(layout);
  return focused && isTaskTabId(focused) ? focused : null;
}

/**
 * The layouts with every mounted workspace's reconciled against the task list (plan
 * 20260923-terminal-split-groups). The same object when nothing changed, so the caller can compare
 * by identity; a workspace without a stored layout gets an entry only once reconcile changes it.
 */
function reconcileMountedLayouts(
  layouts: Record<string, TerminalLayout>,
  workspaceIds: readonly string[],
  tasks: readonly Task[],
  snapshotReady: boolean,
): Record<string, TerminalLayout> {
  let next = layouts;
  for (const workspaceId of workspaceIds) {
    const stored = layouts[workspaceId];
    const reconciled = effectiveLayout(stored, snapshotReady ? workspaceTaskIds(tasks, workspaceId) : [], { snapshotReady });
    if (reconciled !== (stored ?? EMPTY_LAYOUT)) next = { ...next, [workspaceId]: reconciled };
  }
  return next;
}

/**
 * Tasks whose pane is mounted (plan 104): a pane's life is decoupled from its workspace container,
 * so a terminal moved into a workspace that was never visited keeps its pane. Every task that has
 * been in a mounted workspace keeps one for as long as it is in the snapshot. The same set when
 * nothing changed.
 */
function retainPaneTaskIds(previous: ReadonlySet<string>, tasks: readonly Task[], isMounted: (workspaceId: string) => boolean): ReadonlySet<string> {
  const live = new Set(tasks.map((task) => task.id));
  let next: Set<string> | null = null;
  for (const taskId of previous) {
    if (live.has(taskId)) continue;
    next ??= new Set(previous);
    next.delete(taskId);
  }
  for (const task of tasks) {
    if (!isMounted(task.workspaceId) || (next ?? previous).has(task.id)) continue;
    next ??= new Set(previous);
    next.add(task.id);
  }
  return next ?? previous;
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
      bridge.notify({ workspaceId, ...(entry.taskId ? { taskId: entry.taskId } : {}), ...attentionNotificationText(entry) });
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
  // Whether the sidebar is collapsed (plan 20260930-collapsible-sidebar): a separate boolean, never
  // folded into the width control above, which the settings page's column shares and which has to
  // survive a collapse untouched. Ref mirror so a key repeated before the re-render reads "now".
  const [sidebarCollapsed, setSidebarCollapsedState] = useState(readSidebarCollapsed);
  const sidebarCollapsedRef = useRef(sidebarCollapsed);
  // ⌘N / 新建工作区 while collapsed: the project whose create menu opens once the sidebar is back.
  const pendingCreateMenuRef = useRef<string | null>(null);
  // Native full screen hides the traffic lights, and the left dock moves up to the window's edge.
  const [windowFullScreen, setWindowFullScreen] = useState(false);
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
  // Command handle of the selected workspace only, rebuilt on every commit (see terminalHandleFor):
  // kept-alive hidden workspaces never get one, so global shortcuts only ever reach the selected one.
  const activeTerminalRef = useRef<WorkspaceTerminalHandle | null>(null);
  const [notificationOpen, setNotificationOpen] = useState(false);
  // The ＋ menu that is open (a group's tab strip), whether a click or ⌘T opened it.
  const [newTabMenu, setNewTabMenu] = useState<{ workspaceId: string; groupId: string } | null>(null);
  // The selected workspace as of the last commit, or as the store subscription has just moved it:
  // handlers, the store subscription and the attach gate read it synchronously.
  const activeWorkspaceIdRef = useRef<string | null>(null);
  // 已挂过面板的 task：面板寿命与工作区容器解耦，终端被搬到没访问过的工作区也不重建。
  const [paneTaskIds, setPaneTaskIds] = useState<ReadonlySet<string>>(() => new Set());
  // Terminal editor groups (plan 20260923-terminal-split-groups). Every workspace's layout lives
  // in two places: `layouts` is what a render draws, and `layoutsRef` is what handlers, the store
  // subscription and the attach gate read and write synchronously, before React re-renders (the
  // reason the old activeTabs had a ref mirror too). Every write to the ref hands the whole object to
  // the state; a render reconciles the mounted workspaces' layouts against the task list into the
  // state; and each commit copies the state back into the ref. Stored layouts are read once and left
  // unreconciled — before the first snapshot there is nothing to reconcile them against.
  // Browser tabs come back with the layouts: a browser id without a stored record is dropped, and so
  // is a record no layout references (plan 20260924-desktop-browser-tab).
  const [initialState] = useState(() => {
    const browserRestored = restoreBrowserTabs(readStoredLayouts(TERMINAL_LAYOUT_STORE), readBrowserTabRecords(BROWSER_TAB_STORE));
    // File tabs too (plan 20261001-terminal-file-tab).
    const fileRestored = restoreFileTabs(browserRestored.layouts, readFileTabRecords(FILE_TAB_STORE));
    // Screens are no tabs any more (plan 20261011-standalone-device-screen): their records are per
    // device and come back on their own. The old per-tab records are dropped without migration; a
    // stored layout's old screen tab id is dropped by reconcile like any id that is no task.
    try {
      localStorage.removeItem(LEGACY_SCREEN_TABS_KEY);
    } catch {
      // Left behind; it is never read.
    }
    return {
      layouts: fileRestored.layouts,
      records: browserRestored.records,
      screenRecords: readScreenRecords(SCREEN_RECORD_STORE),
      fileRecords: fileRestored.records,
    };
  });
  const [layouts, setLayouts] = useState<Record<string, TerminalLayout>>(initialState.layouts);
  const layoutsRef = useRef<Record<string, TerminalLayout>>(initialState.layouts);
  // Open remote screens' runtime (plan 20261011-standalone-device-screen): per-device records and
  // the live sessions of their views.
  const [screens] = useState(() => createScreenRuntime({ desktop, recordStore: SCREEN_RECORD_STORE, initialRecords: initialState.screenRecords }));
  // File tabs' runtime (plan 20261001-terminal-file-tab): records, reveal requests, last shown content.
  const [files] = useState(() => createFileRuntime({ tabStore: FILE_TAB_STORE, initialRecords: initialState.fileRecords }));
  // The device whose screen is in immersive mode (plan 20260929-remote-desktop): sidebar and docks
  // hidden, the window full screen, the picture filling it. ⌃⌥⌘F toggles it both ways; leaving full
  // screen by any other means ends it too (main reports it).
  const [immersiveDaemonId, setImmersiveDaemonId] = useState<string | null>(null);
  // The selection the user came from before selecting a screen: disconnecting the selected screen,
  // or pressing the dock's screen button again, returns there.
  const previousSelectionRef = useRef<WorkbenchSelection | null>(null);
  // Whether a screen picture holds keyboard focus: the global shortcuts yield to it (ref: read per key).
  const screenFocusedRef = useRef(false);
  // Built-in browser tabs' runtime: what each tab shows, the library, prepared partitions, guests.
  const [browser] = useState(() =>
    createBrowserRuntime({ desktop, tabStore: BROWSER_TAB_STORE, libraryStore: BROWSER_LIBRARY_STORE, initialRecords: initialState.records }),
  );
  const lastWrittenLayoutsRef = useRef<string | null>(null);
  // Debounced persisting (see flushLayoutPersist): the layouts object last looked at, the pending
  // write, and whether a sash drag is in progress.
  const checkedLayoutsRef = useRef<Record<string, TerminalLayout> | null>(null);
  const layoutPersistTimerRef = useRef<number | undefined>(undefined);
  const transientLayoutRef = useRef(false);
  // The changes overlay, open per workspace; it survives switching away and back, as the old
  // per-container view did. Ref mirror for the same synchronous-read reason.
  const [changesOpen, setChangesOpenState] = useState<Record<string, boolean>>({});
  const changesOpenRef = useRef(changesOpen);
  // The last file each workspace's files overlay was asked to reveal (plan
  // 20261002-workspace-files-view); `seq` is new for every request, so a repeat jumps again.
  const [fileReveals, setFileReveals] = useState<Record<string, FileReveal>>({});
  const fileRevealSeqRef = useRef(0);
  // Optimistic terminal creates (plan 078) are layout entries now: this holds each workspace's
  // fallback timer, and `settledCreatesRef` the creates the store subscription answered, which an
  // effect then starts.
  const pendingCreateTimersRef = useRef(new Map<string, { pendingId: string; timer: number }>());
  const pendingCreateSeqRef = useRef(0);
  const settledCreatesRef = useRef<{ workspaceId: string; taskId: string; pendingId: string }[]>([]);
  // The action dock's measured width: the top-right group's strip reserves exactly this much.
  const [dockWidth, setDockWidth] = useState(0);

  const authState = useStore(client.store, (state) => state.authState);
  const loginError = useStore(client.store, (state) => state.loginError);
  const status = useStore(client.store, (state) => state.status);
  const allProjects = useStore(client.store, (state) => state.projects);
  const allWorkspaces = useStore(client.store, (state) => state.workspaces);
  // Archived projects (plan 20261030-project-archive) and their workspaces are invisible: everything
  // below — the selection, the mounted workspaces, the empty state — reads these, so the render an
  // archive lands in already falls back instead of mounting the archived workspace.
  const projects = useMemo(() => allProjects.filter((project) => !isProjectArchived(project)), [allProjects]);
  const workspaces = useMemo(
    () => allWorkspaces.filter((workspace) => !isWorkspaceArchived(workspace, allProjects)),
    [allWorkspaces, allProjects],
  );
  // 终端面板挂在本层（plan 104），故这里要全量 tasks：引用只在 task 实体真的变化时才换。
  const tasks = useStore(client.store, (state) => state.tasks);
  const daemons = useStore(client.store, (state) => state.daemons);
  const lastError = useStore(client.store, (state) => state.lastError);
  const snapshotRevision = useStore(client.store, (state) => state.snapshotRevision);
  // Open screens, one per device (plan 20261011-standalone-device-screen). Subscribed here so that
  // removing the selected screen's record re-validates the selection in the same render.
  const screenRecords = useStore(screens.records, (state) => state.records);

  // 快照后校准选中项：无效选择回退到首项目 main workspace（或任一工作区）。
  // device 选中以设备仍在 daemons 为有效判据（离线设备仍可进详情看现场）。
  // 乐观条目（plan 078）天然不在 workspaces 里：pending 期间视为有效，否则
  // "点击后立即切换过去"会在同一帧被这里撤销，表现为点了没反应。
  // Adjusted during render, so an invalid selection is never drawn; writing it to storage runs
  // from an effect.
  const selectionResolution =
    snapshotRevision === 0
      ? null
      : resolveWorkbenchSelection({
          selection,
          pendingWorkspaceIds: new Set(pendingWorkspaces.map((item) => item.id)),
          projects,
          workspaces,
          daemons,
          screenDeviceIds: new Set(Object.keys(screenRecords)),
        });
  if (selectionResolution?.changed) setSelection(selectionResolution.selection);
  // 假 id 其实已落盘过一次（selectWorkspace 内部即 persist）：刷新后 pendingWorkspaces 为空，
  // 校准判定 invalid 回退自愈，无害。pending 期间跳过 persist，只是不再重复写假 id。
  const persistableSelection = selectionResolution?.shouldPersist ? selectionResolution.selection : undefined;
  useEffect(() => {
    if (persistableSelection !== undefined) persistSelection(persistableSelection);
  }, [persistableSelection]);

  // 设备详情的载体（plan 048）：该设备的 canonical 目录工作区 = isDirWorkspace 且
  // daemonId 匹配、createdAt 最早。与 server 侧 terminalCreate 幂等复用规则同构。
  const canonicalDirWorkspaceOf = (daemonId: string, from: readonly Workspace[] = workspaces): Workspace | null =>
    from
      .filter((workspace) => isDirWorkspace(workspace) && workspace.daemonId === daemonId)
      .sort((left, right) => left.createdAt - right.createdAt)[0] ?? null;

  const selectedWorkspace = selection?.kind === "workspace" ? (workspaces.find((workspace) => workspace.id === selection.id) ?? null) : null;
  const selectedDevice = selection?.kind === "device" ? (daemons.find((daemon) => daemon.daemonId === selection.id) ?? null) : null;
  // 选中的乐观条目（plan 078）：pending 期间 selectedWorkspace 解析为空，由它接管主区渲染。
  const pendingSelected = selection?.kind === "workspace" ? (pendingWorkspaces.find((item) => item.id === selection.id) ?? null) : null;
  // 主区实际渲染的工作区：workspace 选中即其本身；device 选中解析 canonical 目录工作区（可能为空 → 设备空态）
  const activeWorkspace = selection?.kind === "device" ? canonicalDirWorkspaceOf(selection.id) : selectedWorkspace;
  // A screen selection (plan 20261011-standalone-device-screen) leaves no active workspace: visited
  // ones stay mounted but hidden, and workspace-scoped shortcuts have no handle to act on.
  const activeWorkspaceId = activeWorkspace?.id ?? null;
  // The selected screen's device, while its screen is open (a stale stored selection shows nothing until it is resolved).
  const selectedScreenId = selection?.kind === "screen" && screenRecords[selection.id] ? selection.id : null;
  const selectedScreenDevice = selectedScreenId ? (daemons.find((daemon) => daemon.daemonId === selectedScreenId) ?? null) : null;
  // pending 期间继续持有目标设备的 route：创建往返要走它，松开再重连只会更慢。
  const selectedDaemonId =
    selection?.kind === "device" || selection?.kind === "screen" ? selection.id : (selectedWorkspace?.daemonId ?? pendingSelected?.daemonId);
  // The current selection's device (the dock's screen button and the palette's 打开屏幕 open its screen).
  const selectionDeviceId = selection?.kind === "device" || selection?.kind === "screen" ? selection.id : (selectedWorkspace?.daemonId ?? null);

  // 接管状态机（plan 104）：与面板一起提升到本层，按 task id 记账、不认工作区。
  const attach = useTerminalAttach(client, { tasks });
  const snapshotReady = isSnapshotReady({ snapshotRevision, authState });
  // Agents launched from the ＋ menu (plan 20261001-desktop-agents): pending launch commands, the
  // typing of each one once, and the tab → agent records for tab icons.
  const agentLaunches = useAgentLaunches(client, { tasks, snapshotReady });

  /** A workspace's layout as of now (handlers and effects only; a render reads `layouts`). */
  function layoutOf(workspaceId: string): TerminalLayout {
    return layoutsRef.current[workspaceId] ?? EMPTY_LAYOUT;
  }

  function selectWorkspace(workspaceId: string) {
    const next: WorkbenchSelection = { kind: "workspace", id: workspaceId };
    setSelection(next);
    persistSelection(next);
  }

  function selectDevice(daemonId: string) {
    const next: WorkbenchSelection = { kind: "device", id: daemonId };
    setSelection(next);
    persistSelection(next);
    setDeviceTerminalError(null);
  }

  /**
   * Reconciles one workspace's layout against a task list straight into the ref — synchronously,
   * because the store subscription needs the result before anything is drawn (a reconcile one frame
   * late would let the visible set reference a vanished task or miss a new one). A pending create
   * this answers is queued for activation. The caller hands the result to the state.
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

  /** What is on screen as of now (handlers and effects only; a render derives `screen` from its own state). */
  function currentScreen(): { visible: ReadonlySet<string>; focused: string | null } {
    return screenOf(activeWorkspaceIdRef.current, changesOpenRef.current, layoutsRef.current);
  }

  /** The focused group's active tab of the selected workspace when it is a browser or file tab on screen. */
  function focusedBrowserTabId(): string | null {
    const workspaceId = activeWorkspaceIdRef.current;
    if (!workspaceId || changesOpenRef.current[workspaceId]) return null;
    const focused = focusedTabId(layoutOf(workspaceId));
    return focused && (isBrowserTabId(focused) || isFileTabId(focused)) ? focused : null;
  }

  /**
   * Keyboard focus into a tab: a terminal through the attach machine, a browser tab through its view
   * (the page, or its address bar when there is no page). `attach.focusTask` is a no-op for ids that
   * are not tasks, which is why the browser case needs its own path.
   */
  function focusTab(tabId: string) {
    if (isBrowserTabId(tabId)) browser.focus(tabId);
    else if (isFileTabId(tabId)) files.focus(tabId);
    else if (isTaskTabId(tabId)) attach.focusTask(tabId);
  }

  /** Writes the visible set into the attach gate's mirror: on every layout or overlay change, and again after every commit. */
  function syncVisible() {
    attach.setVisibleTaskIds(currentScreen().visible);
  }

  function commitLayout(workspaceId: string, next: TerminalLayout) {
    if (layoutOf(workspaceId) === next) return;
    layoutsRef.current = { ...layoutsRef.current, [workspaceId]: next };
    syncVisible();
    setLayouts(layoutsRef.current);
  }

  function updateLayout(workspaceId: string, change: (layout: TerminalLayout) => TerminalLayout, options: { transient?: boolean } = {}) {
    transientLayoutRef.current = Boolean(options.transient);
    commitLayout(workspaceId, change(layoutOf(workspaceId)));
  }

  // Persisting: only after the first snapshot, only when the layouts object changed since the last
  // look (every change replaces it, so an identity check is enough to skip unrelated renders), and
  // debounced so a burst of changes is one write. Sash drags commit transient layouts on every
  // pointermove and do not schedule a write at all; the drag's end flushes.
  function flushLayoutPersist() {
    if (layoutPersistTimerRef.current !== undefined) window.clearTimeout(layoutPersistTimerRef.current);
    layoutPersistTimerRef.current = undefined;
    const serialized = planLayoutPersist({
      snapshotReady: isSnapshotReady(client.store.getState()),
      layouts: layoutsRef.current,
      lastWritten: lastWrittenLayoutsRef.current,
    });
    if (serialized === null) return;
    lastWrittenLayoutsRef.current = serialized;
    writeStoredLayouts(TERMINAL_LAYOUT_STORE, serialized);
  }

  /** End of a sash drag: the transient sizes become the stored ones, written now. */
  function persistLayoutsNow() {
    transientLayoutRef.current = false;
    checkedLayoutsRef.current = layoutsRef.current;
    flushLayoutPersist();
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
      const focused = currentScreen().focused ?? focusedBrowserTabId();
      if (focused) focusTab(focused);
    }
  }

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
    if (isBrowserTabId(taskId)) {
      browser.focus(taskId);
      return;
    }
    if (isFileTabId(taskId)) {
      files.focus(taskId);
      return;
    }
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
   * With an agent (plan 20261001-desktop-agents) the terminal is titled with the agent's name and
   * its launch command waits, bound to this pending create, for the task that answers it.
   */
  function createTerminalIn(workspaceId: string, side: LayoutSide | null, agent: EffectiveAgent | null = null) {
    setWorkspaceChangesOpen(workspaceId, false);
    const layout = layoutOf(workspaceId);
    if (layout.pending) return;
    const known = workspaceTaskIds(client.store.getState().tasks, workspaceId);
    const title = agent ? agent.name : `终端 ${known.length + 1}`;
    const pendingId = `${PENDING_TAB_PREFIX}${++pendingCreateSeqRef.current}`;
    commitLayout(workspaceId, beginPendingTab(layout, { id: pendingId, title, knownTaskIds: known }, side));
    if (agent) agentLaunches.beginCreate(pendingId, { agentId: agent.id, command: agent.command, title });
    // Local fallback: when taskCreate is answered by neither a success nor an error broadcast, drop the pending tab.
    const timer = window.setTimeout(() => {
      if (pendingCreateTimersRef.current.get(workspaceId)?.pendingId === pendingId) pendingCreateTimersRef.current.delete(workspaceId);
      agentLaunches.discardCreate(pendingId);
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
    if (taskId && !taskId.startsWith(PENDING_TAB_PREFIX)) focusTab(taskId);
  }

  /**
   * A new built-in browser tab (plan 20260924-desktop-browser-tab): in the workspace's focused group
   * and active there — or, for a page's popup, right after its opener in the opener's group. Its
   * record is written before the layout that references it. `url` empty = a blank tab, whose address
   * bar takes the caret.
   */
  function openBrowserTab(workspaceId: string, url: string, besideTabId: string | null = null) {
    setWorkspaceChangesOpen(workspaceId, false);
    const tabId = createBrowserTabId(crypto.randomUUID());
    browser.createTab(tabId, workspaceId, url);
    const layout = layoutOf(workspaceId);
    commitLayout(workspaceId, besideTabId ? openTabBeside(layout, besideTabId, tabId) : revealTab(layout, tabId));
    if (workspaceId === activeWorkspaceIdRef.current) browser.focus(tabId);
  }

  /** Closing a browser tab just removes it — no confirmation, nothing to stop. The caret goes to the tab that takes its place. */
  function closeBrowserTab(workspaceId: string, tabId: string) {
    commitLayout(workspaceId, removeTab(layoutOf(workspaceId), tabId));
    browser.removeTab(tabId);
    if (workspaceId !== activeWorkspaceIdRef.current) return;
    const next = focusedTabId(layoutOf(workspaceId));
    if (next) focusTab(next);
  }

  /**
   * Whether 「屏幕」 may be opened for a device (plan 20260929-remote-desktop): its worker advertised
   * the screen helper (`screen_v1`, which only a macOS desktop runtime with the helper does) and it is
   * not this Mac. Read from the daemons list so a `daemonUpdated` that drops the capability hides it.
   */
  function canOpenScreenOn(daemonId: string | null | undefined): boolean {
    if (!daemonId) return false;
    const daemon = daemons.find((item) => item.daemonId === daemonId);
    return Boolean(daemon && daemon.capabilities.includes(SCREEN_CAPABILITY) && daemon.daemonId !== daemonState?.daemonId);
  }

  function selectScreen(daemonId: string) {
    const next: WorkbenchSelection = { kind: "screen", id: daemonId };
    setSelection(next);
    persistSelection(next);
  }

  /**
   * 「打开屏幕」 — the dock's screen button, a device row's context menu, the palette, the device page
   * (plan 20261011-standalone-device-screen): selects the device's screen, opening it first when the
   * device has none. Opening takes the remote session over; an already open screen is only selected —
   * same session, no takeover, so several workspaces of one device all land on the same screen. No
   * workspace is involved.
   */
  function openScreen(daemonId: string) {
    if (!screens.records.getState().records[daemonId]) {
      if (!canOpenScreenOn(daemonId)) return;
      screens.open(daemonId);
    }
    setSettingsOpen(false);
    selectScreen(daemonId);
  }

  /** Back to where the user came from before selecting a screen; the device's page when that is unknown (a restored screen selection). */
  function leaveScreen(daemonId: string) {
    const next: WorkbenchSelection = previousSelectionRef.current ?? { kind: "device", id: daemonId };
    setSelection(next);
    persistSelection(next);
  }

  /**
   * 断开 / the sidebar sub-row's ×: ends the remote session (the virtual display goes away and the
   * remote's arrangement is restored) and closes the screen. A selected screen hands the main area
   * back to the selection the user came from, in the same batch.
   */
  function disconnectScreen(daemonId: string) {
    if (immersiveDaemonId === daemonId) setImmersive(null);
    if (selection?.kind === "screen" && selection.id === daemonId) leaveScreen(daemonId);
    screens.remove(daemonId);
  }

  /**
   * A terminal file link's ⌘+click or 打开文件 (plan 20261001-terminal-file-tab). `path` is the
   * canonical workspace-relative path the device reported — the file's identity — so the same file
   * of the same workspace reuses its tab: it is activated where it is and jumps to the new line.
   * Otherwise a new file tab opens in the focused group, its record written before the layout.
   */
  function openFileTab(workspaceId: string, path: string, line?: number) {
    setWorkspaceChangesOpen(workspaceId, false);
    const existing = findFileTab(files.tabs.getState().tabs, workspaceId, path);
    if (existing && groupOfTab(layoutOf(workspaceId), existing)) {
      files.reveal(existing, line);
      activateTaskByUser(workspaceId, existing);
      return;
    }
    if (existing) files.removeTab(existing);
    const tabId = createFileTabId(crypto.randomUUID());
    files.createTab(tabId, line === undefined ? { workspaceId, path } : { workspaceId, path, line });
    commitLayout(workspaceId, revealTab(layoutOf(workspaceId), tabId));
    if (workspaceId === activeWorkspaceIdRef.current) files.focus(tabId);
  }

  /**
   * A terminal file link's ⌘+click or 打开文件 (plan 20261002-workspace-files-view): opens the 「文件」
   * overlay of that workspace and asks its view to reveal the file — the view decides how (leave
   * 「仅变更」, clear a hiding filter, open and list folders, select, land on the line). `path` is the
   * canonical workspace-relative path the device reported. The file tab stays the secondary route
   * (openFileTab, 「在标签页中打开」).
   */
  function revealFile(workspaceId: string, path: string, line?: number) {
    fileRevealSeqRef.current += 1;
    const seq = fileRevealSeqRef.current;
    setFileReveals((current) => ({ ...current, [workspaceId]: line === undefined ? { path, seq } : { path, line, seq } }));
    setWorkspaceChangesOpen(workspaceId, true);
  }

  /** Closing a file tab just removes it — no confirmation. The caret goes to the tab that takes its place. */
  function closeFileTab(workspaceId: string, tabId: string) {
    commitLayout(workspaceId, removeTab(layoutOf(workspaceId), tabId));
    files.removeTab(tabId);
    if (workspaceId !== activeWorkspaceIdRef.current) return;
    const next = focusedTabId(layoutOf(workspaceId));
    if (next) focusTab(next);
  }

  // A file tab whose workspace is gone is pruned, record and layout entry, once a snapshot says so
  // (before the first one the workspace list is empty only because nothing has arrived).
  useEffect(() => {
    if (!snapshotReady) return;
    // All workspaces, archived ones included: archiving hides a workspace, it does not remove it.
    const live = new Set(allWorkspaces.map((workspace) => workspace.id));
    for (const [tabId, record] of Object.entries(files.tabs.getState().tabs)) {
      if (live.has(record.workspaceId)) continue;
      const layout = layoutsRef.current[record.workspaceId];
      if (layout && groupOfTab(layout, tabId)) commitLayout(record.workspaceId, removeTab(layout, tabId));
      files.removeTab(tabId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allWorkspaces, snapshotReady]);

  // A screen whose device is gone (removed from the account) is closed for good once a snapshot says
  // so; the selection falls back through resolveWorkbenchSelection.
  useEffect(() => {
    if (!snapshotReady) return;
    const live = new Set(daemons.map((daemon) => daemon.daemonId));
    for (const daemonId of Object.keys(screenRecords)) {
      if (!live.has(daemonId)) screens.remove(daemonId);
    }
  }, [daemons, screenRecords, snapshotReady, screens]);

  /** Immersive mode on or off: the window follows (full screen), the sidebar and strips hide with the state. */
  function setImmersive(daemonId: string | null) {
    setImmersiveDaemonId(daemonId);
    desktop.screenImmersive(daemonId !== null);
    if (daemonId) screens.focus(daemonId);
  }
  function toggleImmersive(daemonId: string) {
    setImmersive(immersiveDaemonId === daemonId ? null : daemonId);
  }
  // Leaving full screen by the OS's own gesture ends immersive mode too. Full screen is also
  // tracked for the left dock, which needs no room for the traffic lights there.
  useEffect(
    () =>
      desktop.onScreenEvent((event) => {
        if (event.kind !== "fullscreen") return;
        setWindowFullScreen(event.on);
        // Already null when immersive mode was off: React bails out of the equal update.
        if (!event.on) setImmersiveDaemonId(null);
      }),
    [],
  );

  /** A pointer went down inside a pane: its group becomes the focused one (the pane layer sits above the chrome). */
  function focusPaneGroup(taskId: string) {
    const workspaceId = activeWorkspaceIdRef.current;
    if (!workspaceId) return;
    const layout = layoutOf(workspaceId);
    const group = groupOfTab(layout, taskId);
    if (group && group.id !== layout.focusedGroupId) commitLayout(workspaceId, focusGroup(layout, group.id));
  }

  // Main-process browser events that change the layout: a click into a page focuses its group; a
  // page's popup opens beside it. Effect events, so the subscription is made once.
  const focusBrowserGuestGroup = useEffectEvent((tabId: string) => {
    const workspaceId = activeWorkspaceIdRef.current;
    if (!workspaceId || changesOpenRef.current[workspaceId]) return;
    if (browser.tabs.getState().tabs[tabId]?.workspaceId !== workspaceId) return;
    focusPaneGroup(tabId);
  });
  const openBrowserPopup = useEffectEvent((tabId: string, url: string) => {
    const target = normalizeIncomingUrl(url);
    const workspaceId = browser.tabs.getState().tabs[tabId]?.workspaceId;
    if (!target || !workspaceId || !groupOfTab(layoutOf(workspaceId), tabId)) return;
    openBrowserTab(workspaceId, target, tabId);
  });
  useEffect(() => {
    browser.setWorkbenchHandlers({
      onGuestFocus: (tabId) => focusBrowserGuestGroup(tabId),
      onPopup: (tabId, url) => openBrowserPopup(tabId, url),
    });
    return browser.start();
  }, [browser]);

  /**
   * A terminal moved to another workspace (plan 104): when it is the one the user is watching (the
   * focused group's active tab of the selected workspace), the selection follows it, and it lands in
   * the new workspace's focused group as its active tab. Returns whether it moved.
   */
  function followMovedTerminal(allTasks: readonly Task[]): boolean {
    const workspaceId = activeWorkspaceIdRef.current;
    if (!workspaceId) return false;
    const watched = focusedTabId(layoutOf(workspaceId));
    if (!watched || !isTaskTabId(watched)) return false;
    const next = resolveSelectionAfterTaskMove({ activeWorkspaceId: workspaceId, activeTaskId: watched, tasks: allTasks });
    if (!next) return false;
    reconcileWorkspaceLayout(workspaceId, allTasks, true);
    reconcileWorkspaceLayout(next.id, allTasks, true, watched);
    if (changesOpenRef.current[next.id]) {
      changesOpenRef.current = { ...changesOpenRef.current, [next.id]: false };
      setChangesOpenState(changesOpenRef.current);
    }
    activeWorkspaceIdRef.current = next.id;
    setSelection(next);
    persistSelection(next);
    return true;
  }

  // Task-list changes that have to be settled before React renders: the store subscription fires
  // synchronously inside setState and batches with this render, so the layouts are changed right here
  // and the render already reads the final result.
  // - An optimistic create (plan 078) the change answers: the created task takes the pending tab's
  //   place, and the create is queued for the effect that starts it.
  // - A moved terminal the user is watching (see followMovedTerminal): the new workspace never first
  //   falls back to attaching another tab, and the moved terminal never flickers.
  const settleClientState = useEffectEvent((state: CofluxState, previous: CofluxState) => {
    const ready = isSnapshotReady(state);
    const tasksChanged = state.tasks !== previous.tasks;
    if (!tasksChanged && ready === isSnapshotReady(previous)) return;
    const before = layoutsRef.current;
    for (const [workspaceId, layout] of Object.entries(before)) {
      if (layout.pending) reconcileWorkspaceLayout(workspaceId, state.tasks, ready);
    }
    const moved = tasksChanged && state.snapshotRevision !== 0 && followMovedTerminal(state.tasks);
    if (!moved && layoutsRef.current === before) return;
    syncVisible();
    setLayouts(layoutsRef.current);
  });
  useEffect(() => client.store.subscribe((state, previous) => settleClientState(state, previous)), [client]);

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

  // 浏览器标签页标题跟随当前选中：项目工作区用项目名，设备详情用设备名，屏幕用「设备名 的屏幕」。
  useEffect(() => {
    const project = projects.find((item) => item.id === selectedWorkspace?.projectId);
    document.title = selectedScreenDevice
      ? `${selectedScreenDevice.name} 的屏幕 · coflux`
      : selectedDevice
        ? `${selectedDevice.name} · coflux`
        : project
          ? `${project.name} · coflux`
          : "coflux · workspace";
  }, [selectedWorkspace, selectedDevice, selectedScreenDevice, projects]);

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
   * Land on a terminal tab, wherever it lives — the one routine behind the palette and every
   * notification click. A terminal already in some group activates there and that group takes
   * focus; one the layout does not hold yet lands in the focused group. The target workspace's
   * layout is updated before it is selected, so its first render already shows the tab. Any task
   * the store still holds lands, whatever its status: an inbox notification may point at an exited
   * terminal. Reads the store rather than render state, since notification listeners may hold an
   * older closure. Returns whether it landed; the caller owns every fallback.
   */
  function landOnTask(taskId: string): boolean {
    const state = client.store.getState();
    const task = state.tasks.find((item) => item.id === taskId);
    const workspace = task && state.workspaces.find((item) => item.id === task.workspaceId);
    if (!task || !workspace) return false;
    activateTaskByUser(workspace.id, taskId);
    setSettingsOpen(false);
    // A directory workspace is the carrier of a device detail view, and selecting it directly
    // would leave the sidebar with nothing highlighted. Select the device instead — but only when
    // this really is the workspace that view resolves to, otherwise the panel would land elsewhere.
    if (isDirWorkspace(workspace) && canonicalDirWorkspaceOf(workspace.daemonId, state.workspaces)?.id === workspace.id) {
      selectDevice(workspace.daemonId);
      return true;
    }
    selectWorkspace(workspace.id);
    return true;
  }

  /**
   * ⌘⇧A 「下一个待处理」 (plan 20261110-sidebar-current-terminals): walks the sidebar's 「当前」
   * terminals, derived at the moment of the press from the store — the same list the sidebar
   * shows, never the notification snapshot — starting after the terminal on screen as of now, and
   * lands on the next waiting one. Does nothing when no terminal waits.
   */
  function goToNextAttention() {
    const state = client.store.getState();
    const workspaceId = activeWorkspaceIdRef.current;
    const rows = currentTerminals({
      projects: state.projects,
      workspaces: state.workspaces,
      daemons: state.daemons,
      tasks: state.tasks,
      sessionAgents: state.sessionAgents,
      titles: candidateSessionTitles(state.tasks, state.sessionAgents, state.sessionMetadata),
    });
    const target = nextAttentionRow(rows, workspaceId ? onScreenTaskOf(layoutOf(workspaceId)) : null);
    if (target) landOnTask(target.task.id);
  }

  /**
   * Collapse or expand the sidebar (plan 20260930-collapsible-sidebar). The button that was clicked
   * unmounts with the side it belongs to (the sidebar's band, or the left dock), which would drop
   * keyboard focus to `body` and leave the terminal deaf until clicked, so the caret goes back to the
   * focused tab — unless the expand is on the way to the create-workspace menu, which takes it.
   * Collapsing never leaves a create menu queued or open: with the sidebar unmounted it would pop
   * open on its own at the next expand.
   */
  function setSidebarCollapsed(collapsed: boolean, options: { refocus: boolean }) {
    if (sidebarCollapsedRef.current === collapsed) return;
    sidebarCollapsedRef.current = collapsed;
    setSidebarCollapsedState(collapsed);
    persistSidebarCollapsed(collapsed);
    if (collapsed) {
      pendingCreateMenuRef.current = null;
      setCreateMenuProjectId(null);
    }
    if (!options.refocus) return;
    if (selection?.kind === "screen") {
      screens.focus(selection.id);
      return;
    }
    const focused = currentScreen().focused ?? focusedBrowserTabId();
    if (focused) focusTab(focused);
  }

  /** The two buttons, ⌘B and 「视图 → 显示/隐藏侧边栏」. A no-op in immersive mode, where the sidebar is gone regardless. */
  function toggleSidebar() {
    if (immersiveDaemonId) return;
    setSidebarCollapsed(!sidebarCollapsedRef.current, { refocus: true });
  }

  /**
   * ⌘N and 「新建工作区」: the create menu lives in the sidebar, so a collapsed sidebar comes back
   * first and the menu opens once it has mounted (see the effect below) — a DropdownMenu handed
   * `isMenuOpen` on its first mount is not relied upon.
   */
  function openCreateWorkspaceMenu(projectId: string) {
    if (!sidebarCollapsedRef.current) {
      setCreateMenuProjectId(projectId);
      return;
    }
    pendingCreateMenuRef.current = projectId;
    setSidebarCollapsed(false, { refocus: false });
  }
  useEffect(() => {
    const projectId = pendingCreateMenuRef.current;
    if (sidebarCollapsed || !projectId) return;
    pendingCreateMenuRef.current = null;
    setCreateMenuProjectId(projectId);
  }, [sidebarCollapsed]);

  // The palette names the workspace too; the task alone decides where it lands.
  function openPaletteTerminal(_workspaceId: string, taskId: string) {
    landOnTask(taskId);
  }

  // 点系统通知 → 主进程把窗口带到前台、键盘交还工作台页，回传工作区 id 与等待中的终端 → 落到那个终端；
  // 终端已不在则退回选中工作区（工作区也已删则安静忽略）。
  const focusFromNotification = useEffectEvent((target: { workspaceId: string; taskId?: string | null }) => {
    if (target.taskId && landOnTask(target.taskId)) return;
    if (client.store.getState().workspaces.some((workspace) => workspace.id === target.workspaceId)) selectWorkspace(target.workspaceId);
  });
  useEffect(() => desktop.onFocusWorkspace((target) => focusFromNotification(target)), [client]);

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
  // Adjusted during render when either of them changes (not when busy itself is set).
  const [busyCheckedFor, setBusyCheckedFor] = useState({ lastError, activeWorkspaceId });
  if (busyCheckedFor.lastError !== lastError || busyCheckedFor.activeWorkspaceId !== activeWorkspaceId) {
    setBusyCheckedFor({ lastError, activeWorkspaceId });
    if (deviceTerminalBusy && (lastError || activeWorkspaceId)) setDeviceTerminalBusy(false);
  }

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
      // Workspaces hidden by a pending removal may come back on rollback: they are not the new one.
      knownIds: new Set([...client.store.getState().workspaces.map((workspace) => workspace.id), ...client.hiddenWorkspaceIds()]),
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

  const adoptCreatedWorkspace = useEffectEvent((workspaces: readonly Workspace[]) => {
    const pending = pendingWorkspaceCreateRef.current;
    if (!pending) return;
    const created = workspaces.find((workspace) => workspace.projectId === pending.projectId && !pending.knownIds.has(workspace.id));
    if (created) {
      pendingWorkspaceCreateRef.current = null;
      removePendingWorkspace(pending.pendingId);
      selectWorkspace(created.id);
    }
  });
  useEffect(() => {
    adoptCreatedWorkspace(workspaces);
  }, [workspaces]);

  // 创建失败（error 广播）时丢弃 pending，避免误认后续他端创建的工作区
  const dropPendingWorkspaceCreate = useEffectEvent(() => {
    const pending = pendingWorkspaceCreateRef.current;
    pendingWorkspaceCreateRef.current = null;
    if (pending) removePendingWorkspace(pending.pendingId);
  });
  useEffect(() => {
    if (lastError) dropPendingWorkspaceCreate();
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
      // Optimistic (plan 20261002-optimistic-removal): the project and its workspaces vanish now;
      // the selection falls back through resolveWorkbenchSelection.
      onConfirm: () => client.removeProject(project.id),
    });
  }

  /** 归档项目 (plan 20261030-project-archive): confirmed only when it would close running terminals. */
  function requestArchiveProject(project: Project) {
    const state = client.store.getState();
    const workspaceIds = new Set(state.workspaces.filter((workspace) => workspace.projectId === project.id).map((workspace) => workspace.id));
    const running = state.tasks.filter((task) => workspaceIds.has(task.workspaceId) && task.status === TaskStatus.RUNNING).length;
    if (running === 0) {
      client.setProjectArchived(project.id, true);
      return;
    }
    setConfirmAction({
      title: `归档项目「${project.name}」？`,
      description: `项目里正在运行的 ${running} 个终端会被关闭。归档后可以在 设置 → 已归档项目 里取消归档。`,
      confirmLabel: "归档项目",
      onConfirm: () => client.setProjectArchived(project.id, true),
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
      onConfirm: () => {
        // Optimistic: the row vanishes now. A shown workspace hands the main area to its own
        // project's main workspace (same batch); a rollback leaves the selection where it went.
        if (!client.removeWorkspace(workspace.id)) return;
        if (selection?.kind !== "workspace" || selection.id !== workspace.id) return;
        const main = client.store
          .getState()
          .workspaces.find((item) => item.isMain && item.id !== workspace.id && !!workspace.projectId && item.projectId === workspace.projectId);
        if (main) selectWorkspace(main.id);
      },
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

  // The selected workspace joins the visited ones (adjusted during render).
  if (activeWorkspaceId && !visitedWorkspaceIds.has(activeWorkspaceId)) setVisitedWorkspaceIds(new Set(visitedWorkspaceIds).add(activeWorkspaceId));

  // 已删除的工作区随 workspaces 过滤自动卸载；含 activeWorkspaceId 是避免等 visited 更新多一轮渲染。
  const terminalWorkspaces = workspaces.filter((workspace) => visitedWorkspaceIds.has(workspace.id) || workspace.id === activeWorkspaceId);

  // 面板寿命与工作区容器解耦（plan 104）：终端被搬进从没访问过的工作区时容器可能压根没挂载过，
  // 面板必须原样留在原地。挂过面板的 task 只要还在快照里就一直挂着，只有真的被删才收回。
  // The set is kept in state and adjusted during render.
  const mountedPaneTaskIds = retainPaneTaskIds(
    paneTaskIds,
    tasks,
    (workspaceId) => visitedWorkspaceIds.has(workspaceId) || workspaceId === activeWorkspaceId,
  );
  if (mountedPaneTaskIds !== paneTaskIds) setPaneTaskIds(mountedPaneTaskIds);
  const paneTasks = tasks
    .filter((task) => mountedPaneTaskIds.has(task.id))
    // 顺序必须稳定：快照会整体替换 tasks，按 createdAt/id 排一遍，已挂载的面板就不会被 React
    // 搬位置（搬位置＝重新插入 DOM，xterm 的 open(host) 绑定与 WebGL 上下文都可能受影响）。
    .sort((left, right) => left.createdAt - right.createdAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  // Layouts of every mounted workspace, reconciled during render (never in an effect one frame late):
  // the state is adjusted right away, so nothing un-reconciled is ever drawn, and the commit hands
  // the result to the ref and the visible set to the attach gate (see the layout effects below).
  const renderLayouts = reconcileMountedLayouts(
    layouts,
    terminalWorkspaces.map((workspace) => workspace.id),
    tasks,
    snapshotReady,
  );
  if (renderLayouts !== layouts) setLayouts(renderLayouts);
  const renderLayoutOf = (workspaceId: string): TerminalLayout => renderLayouts[workspaceId] ?? EMPTY_LAYOUT;
  const screen = screenOf(activeWorkspaceId, changesOpen, renderLayouts);
  const selectedLayout = activeWorkspaceId ? renderLayoutOf(activeWorkspaceId) : EMPTY_LAYOUT;
  // The terminal on screen, for the sidebar's 「当前」 highlight (plan 20261110-sidebar-current-terminals).
  const onScreenTaskId = activeWorkspaceId ? onScreenTaskOf(selectedLayout) : null;
  // Each visible pane sits on its group's body, in percentages the browser lays out in the same frame.
  const paneFrames = new Map<string, CSSProperties>();
  for (const { group, rect } of layoutGeometry(selectedLayout).groups) {
    if (group.activeTabId && screen.visible.has(group.activeTabId)) paneFrames.set(group.activeTabId, groupBodyStyle(rect));
  }
  const selectedChangesOpen = Boolean(activeWorkspaceId && changesOpen[activeWorkspaceId]);
  // Browser views (plan 20260924-desktop-browser-tab): one per browser tab of every mounted
  // workspace, each on its group's body rectangle whether or not it is on screen — a hidden view
  // keeps its size and its page. The list is sorted by tab id so the relative order of mounted views
  // never changes: React then never moves a view's DOM node, and a moved <webview> would reload.
  const browserEntries: BrowserViewEntry[] = [];
  for (const workspace of terminalWorkspaces) {
    const layout = renderLayoutOf(workspace.id);
    const onScreen = workspace.id === activeWorkspaceId && !changesOpen[workspace.id];
    // Browser state is the project's (every worktree shares it), or the device's on the device view
    // (plan 20260929-browser-scope-partitions); derived here, never stored with the tab.
    const scope = browserScopeOfWorkspace(workspace);
    for (const { group, rect } of layoutGeometry(layout).groups) {
      for (const tabId of group.tabs) {
        if (!isBrowserTabId(tabId)) continue;
        const visible = onScreen && group.activeTabId === tabId;
        browserEntries.push({
          tabId,
          workspaceId: workspace.id,
          daemonId: workspace.daemonId,
          scope,
          visible,
          focused: visible && group.id === layout.focusedGroupId,
          frame: groupBodyStyle(rect),
        });
      }
    }
  }
  browserEntries.sort((left, right) => (left.tabId < right.tabId ? -1 : left.tabId > right.tabId ? 1 : 0));
  // Screen views (plan 20261011-standalone-device-screen): one per open screen, sorted by device id so
  // the relative order of mounted views never changes and React never moves a view's DOM node; the
  // selected one is visible.
  const screenEntries: ScreenViewEntry[] = Object.keys(screenRecords)
    .sort()
    .map((daemonId) => ({ daemonId, visible: daemonId === selectedScreenId }));
  // Immersive mode ends with its screen leaving the main area (disconnected, something else selected).
  const immersiveOnScreen = immersiveDaemonId !== null && immersiveDaemonId === selectedScreenId;
  // What setImmersive(null) does, split: the state during render, the window (full screen off) from
  // an effect that runs once per such exit.
  const [immersiveExits, setImmersiveExits] = useState(0);
  if (immersiveDaemonId && !immersiveOnScreen) {
    setImmersiveDaemonId(null);
    setImmersiveExits((count) => count + 1);
  }
  useEffect(() => {
    if (immersiveExits > 0) desktop.screenImmersive(false);
  }, [immersiveExits]);

  // A create the store subscription answered: the task took the pending tab's place; start it as the old
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
      // An agent create binds its launch command to this task only if the task answers it (title check).
      agentLaunches.settleCreate(pendingId, taskId);
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
  const focusShownTab = useEffectEvent(() => {
    const focused = screen.focused ?? focusedBrowserTabId();
    if (focused) focusTab(focused);
  });
  useEffect(() => {
    focusShownTab();
  }, [activeWorkspaceId]);

  // Selecting a screen (plan 20261011-standalone-device-screen) hands its picture the keyboard. Views
  // are mounted ahead and hidden, so this runs after the selection committed — a click handler would
  // focus an element that is still visibility:hidden; the runtime keeps the request when the view
  // has not registered yet.
  useEffect(() => {
    if (selectedScreenId) screens.focus(selectedScreenId);
  }, [selectedScreenId, screens]);
  // The selection to return to from a screen: the last one that was not a screen.
  useEffect(() => {
    if (selection && selection.kind !== "screen") previousSelectionRef.current = selection;
  }, [selection]);

  const shownTaskIdsRef = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const previous = shownTaskIdsRef.current;
    shownTaskIdsRef.current = screen.visible;
    for (const taskId of screen.visible) if (!previous.has(taskId)) attach.ensureVisible(taskId);
  });

  // Persisting (see flushLayoutPersist), scheduled after every commit that changed the layouts.
  const flushLayoutPersistLater = useEffectEvent(() => flushLayoutPersist());
  useEffect(() => {
    if (!snapshotReady || transientLayoutRef.current || checkedLayoutsRef.current === layoutsRef.current) return;
    checkedLayoutsRef.current = layoutsRef.current;
    if (layoutPersistTimerRef.current !== undefined) window.clearTimeout(layoutPersistTimerRef.current);
    layoutPersistTimerRef.current = window.setTimeout(() => flushLayoutPersistLater(), LAYOUT_PERSIST_DELAY_MS);
  });
  // A write still waiting when the window goes away (quit, reload) happens right then.
  useEffect(() => {
    const flush = () => flushLayoutPersistLater();
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, []);

  // An error broadcast drops the in-flight optimistic creates (taskCreate failed); the attach machine clears its own launching state.
  const dropPendingCreates = useEffectEvent(() => {
    for (const [workspaceId, entry] of pendingCreateTimersRef.current) {
      window.clearTimeout(entry.timer);
      agentLaunches.discardCreate(entry.pendingId);
      updateLayout(workspaceId, (current) => dropPendingTab(current, entry.pendingId));
    }
    pendingCreateTimersRef.current.clear();
  });
  useEffect(() => {
    if (lastError) dropPendingCreates();
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
  const recordLookedAtTerminal = useEffectEvent(() => {
    const taskId = screen.focused;
    if (!taskId) return;
    if (client.store.getState().tasks.some((task) => task.id === taskId)) recordRecentPlace(RECENT_PLACES_STORE, terminalVisitKey(taskId));
  });
  useEffect(() => {
    if (lookedAtTerminalKey) recordLookedAtTerminal();
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
  const closeChangesOverlay = useEffectEvent((workspaceId: string) => setWorkspaceChangesOpen(workspaceId, false));
  useEffect(() => {
    if (!selectedChangesOpen || overlayEscapeBlocked || !activeWorkspaceId) return;
    const workspaceId = activeWorkspaceId;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const focused = document.activeElement;
      // `data-owns-escape`: an element that handles Esc itself — the changes view's comment
      // composer cancels on Esc and must not close the overlay (plan 20261001-changes-review-comments).
      if (focused instanceof Element && focused.closest('[role="menu"], [role="listbox"], [role="dialog"], [role="alertdialog"], dialog, [data-owns-escape]')) return;
      event.preventDefault();
      event.stopPropagation();
      closeChangesOverlay(workspaceId);
    }
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [selectedChangesOpen, overlayEscapeBlocked, activeWorkspaceId]);

  // The single entry point for workbench commands (global shortcuts and the native menu): built for
  // the selected workspace only, on every commit, so a hidden workspace can never receive one.
  function terminalHandleFor(workspaceId: string): WorkspaceTerminalHandle {
    return {
      toggleNewTabMenu: () => {
        if (newTabMenu?.workspaceId === workspaceId) {
          setNewTabMenu(null);
          return;
        }
        // The changes overlay covers the tab strip the menu hangs from.
        setWorkspaceChangesOpen(workspaceId, false);
        setNewTabMenu({ workspaceId, groupId: focusedGroup(layoutOf(workspaceId)).id });
      },
      createTerminal: () => createTerminalIn(workspaceId, null),
      closeActiveTab: () => {
        // Suspended while the overlay is open: a blind ⌘W would close a terminal nobody can see.
        if (changesOpenRef.current[workspaceId]) return;
        const taskId = focusedTabId(layoutOf(workspaceId));
        if (taskId && isBrowserTabId(taskId)) {
          closeBrowserTab(workspaceId, taskId);
          return;
        }
        if (taskId && isFileTabId(taskId)) {
          closeFileTab(workspaceId, taskId);
          return;
        }
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
      openBrowserTab: () => openBrowserTab(workspaceId, ""),
    };
  }

  // What handlers, the store subscription and the attach gate read synchronously, brought up to this
  // commit before any passive effect runs — the panes' own (a pane that just mounted asks the attach
  // gate whether it is visible), this component's, and every listener's after them. No child layout
  // effect reads any of it. Between commits, handlers and the store subscription keep them current.
  useLayoutEffect(() => {
    layoutsRef.current = layouts;
  }, [layouts]);
  useLayoutEffect(() => {
    activeWorkspaceIdRef.current = activeWorkspaceId;
    attach.setVisibleTaskIds(screen.visible);
    activeTerminalRef.current = activeWorkspaceId ? terminalHandleFor(activeWorkspaceId) : null;
  });

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
    createAgentTerminal: (workspaceId, groupId, agentId) => {
      // Read at the moment of choosing: the command is the one the account holds now.
      const agent = currentEffectiveAgents(client).find((item) => item.id === agentId);
      if (!agent) return;
      updateLayout(workspaceId, (layout) => focusGroup(layout, groupId));
      createTerminalIn(workspaceId, null, agent);
    },
    createBrowserTab: (workspaceId, groupId) => {
      updateLayout(workspaceId, (layout) => focusGroup(layout, groupId));
      openBrowserTab(workspaceId, "");
    },
    closeBrowserTab,
    reloadBrowserTab: (tabId) => browser.reload(tabId),
    closeFileTab,
    openFileTab,
    setNewTabMenu: (workspaceId, groupId) => setNewTabMenu(groupId ? { workspaceId, groupId } : null),
    focusActiveTab: (workspaceId) => {
      if (workspaceId !== activeWorkspaceIdRef.current) return;
      const focused = currentScreen().focused ?? focusedBrowserTabId();
      if (focused) focusTab(focused);
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
    onOpenCreateWorkspaceMenu: openCreateWorkspaceMenu,
    onToggleSidebar: toggleSidebar,
    onToggleHelp: () => setHelpOpen((open) => !open),
    onToggleSettings: () => setSettingsOpen((open) => !open),
    onTogglePalette: togglePalette,
    onNextAttention: goToNextAttention,
    // 设置页盖住工作台时终端既看不见也点不到，⌘T/⌘W/⌘1 之类再落到终端上就是盲操作；
    // 原生菜单项走同一条挂起开关。跳转面板同理，而且它还要拿回被这里吞掉的 ⌘[ ⌘]。
    isSuspended: settingsOpen || paletteOpen,
    // A focused screen picture takes every key (plan 20260929-remote-desktop); only ⌃⌥⌘F stays local.
    screenFocusedRef,
    onToggleImmersive: () => {
      if (immersiveDaemonId) setImmersive(null);
      else if (selectedScreenId) toggleImmersive(selectedScreenId);
    },
  });

  const surface = resolveWorkbenchSurface(authState);
  const showReconnectBanner = shouldShowReconnectBanner(status);
  // The left dock is on screen only while the sidebar is collapsed and the workbench is what is
  // visible: immersive mode has no chrome at all, and the settings page brings its own left column.
  const showLeftDock = sidebarCollapsed && !immersiveOnScreen && !settingsOpen;
  // The dock's screen button (plan 20261011-standalone-device-screen): the current selection's device's
  // screen, offered where that device advertises the helper and is not this Mac. Pressed while that
  // screen is the selection; pressing it then returns to where the user came from.
  const screenButtonPressed = selectedScreenId !== null;
  const screenButtonDeviceId = selectedScreenId ?? (canOpenScreenOn(selectionDeviceId) ? selectionDeviceId : null);
  const reservedLeft = sidebarCollapsed ? leftDockReserve(windowFullScreen) : 0;

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
      {immersiveOnScreen || sidebarCollapsed ? null : (
      <Sidebar
        client={client}
        selectedWorkspaceId={selection?.kind === "workspace" ? selection.id : null}
        onSelectWorkspace={selectWorkspace}
        onScreenTaskId={onScreenTaskId}
        onLandOnTask={landOnTask}
        selectedDeviceId={selection?.kind === "device" ? selection.id : null}
        onSelectDevice={selectDevice}
        onImportProject={() => setImportOpen(true)}
        onCreateWorkspace={createWorkspace}
        onRemoveProject={requestRemoveProject}
        onArchiveProject={requestArchiveProject}
        onRenameProject={setRenameProject}
        onRemoveWorkspace={requestRemoveWorkspace}
        onRenameWorkspace={setRenameWorkspace}
        onAddDevice={openEnrollment}
        onRemoveDevice={requestRemoveDevice}
        onRenameDevice={setRenameDevice}
        localDaemonId={daemonState?.daemonId ?? null}
        onOpenScreen={(daemon) => openScreen(daemon.daemonId)}
        screens={screens}
        selectedScreenDeviceId={selectedScreenId}
        onSelectScreen={selectScreen}
        onDisconnectScreen={disconnectScreen}
        createMenuProjectId={createMenuProjectId}
        onCreateMenuProjectIdChange={setCreateMenuProjectId}
        pendingWorkspaces={pendingWorkspaces}
        onToggleSettings={() => setSettingsOpen((open) => !open)}
        widthControl={sidebarWidth}
        settingsTooltip={settingsTooltip}
        onCollapse={toggleSidebar}
      />
      )}

      {terminalWorkspaces.length > 0 ? (
        // Terminal main area (plan 104 / 20260923-terminal-split-groups): one positioned box. The workspace
        // container fills it and draws each group's chrome from the layout tree (tab strips, body
        // placeholders, sashes); the pane layer is their later sibling, keyed by task id, and places
        // each visible pane on its group's body rectangle. Moving a tab between groups or a terminal
        // between workspaces only changes a rectangle: panes are neither rebuilt with a container nor
        // dependent on the new workspace's container being mounted.
        // While no workspace is selected it is hidden with its panes and browser views kept mounted —
        // taken out of the flow and made invisible, never `display: none`: a <webview> under a
        // display:none ancestor loses its guest's rendering and risks a detached guest (plan
        // 20260924-desktop-browser-tab). For the same reason the browser layer sits outside the
        // Suspense boundary, which would hide what it holds with display:none while suspended.
        <main
          className={cn(
            "isolate min-w-0 bg-terminal",
            activeWorkspaceId ? "relative flex-1" : "pointer-events-none invisible absolute bottom-0 right-0",
          )}
          // A collapsed sidebar takes no width (plan 20260930-collapsible-sidebar).
          style={activeWorkspaceId ? undefined : { top: showReconnectBanner ? 28 : 0, left: sidebarCollapsed ? 0 : sidebarWidth.width }}
          aria-hidden={!activeWorkspaceId}
        >
          <Suspense
            fallback={
              <div className="absolute inset-0 flex items-center justify-center text-muted-foreground">
                <LoaderCircle className="size-5 animate-spin" />
              </div>
            }
          >
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
                    layout={renderLayoutOf(workspace.id)}
                    changesOpen={Boolean(changesOpen[workspace.id])}
                    dockWidth={dockWidth}
                    leftDockReserve={reservedLeft}
                    actions={workspaceActions}
                    browser={browser}
                    files={files}
                    newTabMenuGroupId={isActive && newTabMenu?.workspaceId === workspace.id ? newTabMenu.groupId : null}
                    agentTabs={agentLaunches.records}
                    fileReveal={fileReveals[workspace.id] ?? null}
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
              onOpenBrowserTab={(workspaceId, url) => {
                const target = normalizeIncomingUrl(url);
                if (target) openBrowserTab(workspaceId, target);
              }}
              onOpenFile={openFileTab}
              onRevealFile={revealFile}
              onPromptStart={agentLaunches.handlePromptStart}
              client={client}
              attach={attach}
            />
          </Suspense>
          <BrowserViews
            runtime={browser}
            client={client}
            entries={browserEntries}
            onPointerFocus={focusPaneGroup}
          />
        </main>
      ) : null}
      {screenEntries.length > 0 ? (
        // The screen layer (plan 20261011-standalone-device-screen): one view per open screen, over the
        // whole main area to the right of the sidebar. A sibling of the terminal <main>, not inside it:
        // <main> exists only once a workspace was visited and is invisible without an active one. While a
        // screen is selected the layer takes the flex slot and shows that screen's view; otherwise it is
        // hidden the way <main> is — out of the flow at the same size, never unmounted — so every view's
        // canvas, decoder and session survive (paused) and the remote display keeps its size. It comes
        // before the action dock in document order, which keeps the dock's no-drag hole over the status
        // bar's drag band (see drag-region.ts).
        <div
          className={cn(
            "isolate min-w-0 bg-black",
            selectedScreenId ? "relative flex-1" : "pointer-events-none invisible absolute bottom-0 right-0",
          )}
          style={selectedScreenId ? undefined : { top: showReconnectBanner ? 28 : 0, left: sidebarCollapsed ? 0 : sidebarWidth.width }}
          aria-hidden={!selectedScreenId}
        >
          <ScreenViews
            runtime={screens}
            client={client}
            entries={screenEntries}
            immersiveDaemonId={immersiveOnScreen ? immersiveDaemonId : null}
            onToggleImmersive={toggleImmersive}
            onDisconnect={disconnectScreen}
            onFocusChange={(_daemonId, focused) => {
              screenFocusedRef.current = focused;
            }}
            dockWidth={dockWidth}
            leftDockReserve={showLeftDock ? reservedLeft : 0}
          />
        </div>
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
            <div className="mt-5 flex items-center gap-2">
              <Button
                label="新建终端"
                variant="primary"
                size="sm"
                icon={<Plus />}
                isDisabled={!selectedDevice.online}
                isLoading={deviceTerminalBusy}
                onClick={() => void createDeviceTerminal(selectedDevice.daemonId)}
              />
              {canOpenScreenOn(selectedDevice.daemonId) ? (
                // 打开屏幕 (plan 20261011-standalone-device-screen): the device's screen, no workspace needed.
                <Button
                  label="打开屏幕"
                  variant="secondary"
                  size="sm"
                  icon={<Monitor />}
                  isDisabled={!selectedDevice.online}
                  onClick={() => openScreen(selectedDevice.daemonId)}
                />
              ) : null}
            </div>
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
      {!pendingSelected && !selectedDevice && !activeWorkspace && !selectedScreenId ? (
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
              {projects.length === 0
                ? "导入在线设备上的 git 仓库，主工作区会自动创建。"
                : sidebarCollapsed
                  ? `按 ${SHORTCUT_MODIFIER_PREFIX}B 展开侧边栏，从项目或子工作区进入终端工作台。`
                  : "从左侧项目或子工作区进入终端工作台。"}
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
        <div className="fixed inset-x-0 top-0 z-50 flex h-7 items-center justify-center gap-2 border-b border-warning/20 bg-warning/10 text-sm text-warning backdrop-blur">
          <LoaderCircle className="size-3 animate-spin" />
          连接已断开，正在自动重连…下方显示的是最后一次同步的状态。
        </div>
      ) : null}

      {showError || agentLaunches.notice ? (
        <div className="fixed bottom-4 right-4 z-40 flex flex-col items-end gap-2">
          {showError ? (
            <div className="flex max-w-md items-start gap-3 rounded-lg border border-destructive/30 bg-popover px-4 py-3 text-sm shadow-2xl">
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
          {/* Agent-launch failures (plan 20261001-desktop-agents): the same toast, but desktop-local —
              never the client's lastError, whose side effects stop launching terminals and drop
              every in-flight create. */}
          {agentLaunches.notice ? (
            <div className="flex max-w-md items-start gap-3 rounded-lg border border-destructive/30 bg-popover px-4 py-3 text-sm shadow-2xl">
              <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
              <span className="leading-5 text-foreground">{agentLaunches.notice.message}</span>
              <button
                aria-label="关闭"
                className="ml-2 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                onClick={agentLaunches.dismissNotice}
              >
                <X className="size-3.5" />
              </button>
            </div>
          ) : null}
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
        onNewBrowserTab={activeWorkspaceId ? () => openBrowserTab(activeWorkspaceId, "") : undefined}
        onOpenScreen={selectionDeviceId && canOpenScreenOn(selectionDeviceId) ? () => openScreen(selectionDeviceId) : undefined}
      />
      <ShortcutsHelpDialog open={helpOpen} onOpenChange={setHelpOpen} />
      <AddDeviceDialog
        open={enrollmentOpen}
        onOpenChange={setEnrollmentOpen}
        client={client}
        daemonState={daemonState}
        onOnboardThisMac={() => {
          setEnrollmentOpen(false);
          setDaemonDialog("onboarding");
        }}
      />
      {settingsOpen ? (
        <SettingsPage
          client={client}
          daemonState={daemonState}
          runningTerminals={daemonState ? countLocalRunningTerminals(tasks, daemonState.daemonId) : 0}
          hasTopBanner={showReconnectBanner}
          widthControl={sidebarWidth}
          settingsTooltip={settingsTooltip}
          onRemoveProject={requestRemoveProject}
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
          屏幕 (plan 20261011-standalone-device-screen) comes first: it opens, or jumps to, the screen of the current
          selection's device, and takes the user back when pressed again. The screen layer's status bar is a drag
          band under this dock, which is why that layer precedes this node too.
          「文件」 (plan 20260923-terminal-split-groups, renamed from 「变更」 by plan 20261002-workspace-files-view)
          lives here instead of a resident tab: pressing it covers the whole main area with the files view,
          pressing again or Esc returns to the groups. Directory workspaces get it too; their tree has no git parts. */}
      <div
        ref={attachDock}
        role="group"
        aria-label="终端栏操作"
        className={cn("absolute right-0 z-30 flex h-9 items-center gap-2 border-b border-border bg-background px-3", immersiveOnScreen && "hidden")}
        style={{ top: showReconnectBanner ? 28 : 0, ...NO_DRAG_REGION_STYLE }}
      >
        <div aria-hidden className="pointer-events-none absolute inset-y-0 right-full w-6 bg-gradient-to-r from-transparent to-background" />
        {screenButtonDeviceId ? (
          <Tooltip content={screenButtonPressed ? "返回" : "屏幕"} placement="below">
            <button
              type="button"
              aria-label="屏幕"
              aria-pressed={screenButtonPressed}
              className={cn(
                "flex h-6 min-w-6 shrink-0 items-center justify-center rounded-md px-1.5 transition-colors",
                screenButtonPressed ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
              onClick={() => (screenButtonPressed ? leaveScreen(screenButtonDeviceId) : openScreen(screenButtonDeviceId))}
            >
              <Monitor className="size-3.5" />
            </button>
          </Tooltip>
        ) : null}
        {activeWorkspace ? (
          <Tooltip content={selectedChangesOpen ? "返回终端 Esc" : "文件"} placement="below">
            <button
              type="button"
              aria-label="文件"
              aria-pressed={selectedChangesOpen}
              className={cn(
                "flex h-6 min-w-6 shrink-0 items-center justify-center gap-1.5 rounded-md px-1.5 transition-colors",
                selectedChangesOpen ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
              onClick={() => setWorkspaceChangesOpen(activeWorkspace.id, !selectedChangesOpen)}
            >
              <FolderTree className="size-3.5" />
              {activeWorkspace.additions > 0 || activeWorkspace.deletions > 0 ? (
                <span className="whitespace-nowrap font-mono text-xs tabular-nums">
                  <span className="text-success">+{activeWorkspace.additions}</span>{" "}
                  <span className="text-destructive">−{activeWorkspace.deletions}</span>
                </span>
              ) : null}
            </button>
          </Tooltip>
        ) : null}
        <PortMenu
          key={activeWorkspaceId ?? "none"}
          client={client}
          workspaceId={activeWorkspaceId}
          onOpenInBrowser={activeWorkspaceId ? (port) => openBrowserTab(activeWorkspaceId, localPortUrl(port)) : undefined}
        />
        <NotificationInbox client={client} open={notificationOpen} onOpen={() => { setSettingsOpen(false); setNotificationOpen(true); }} onClose={() => setNotificationOpen(false)} onNavigate={landOnTask} />
      </div>

      {/* The left dock (plan 20260930-collapsible-sidebar), the action dock's mirror image: while the
          sidebar is collapsed, one instance holds the expand button just right of the traffic lights for
          every workspace and empty state. The surfaces under the window's top-left corner keep its space
          free (the top-left strip and the changes header reserve `reservedLeft`; the empty states' band is
          empty anyway) and are drag regions, so like the action dock this node comes **after** the main
          area in document order — placed before it, its no-drag hole would be filled back in and the button
          would get no click and no tooltip (see drag-region.ts). Unlike the action dock it is not shown
          over the settings page, which has its own left column and drag band. It has no background: it
          only punches a hole in whatever strip or band lies under it. */}
      {showLeftDock ? (
        <div
          role="group"
          aria-label="侧边栏"
          // As tall as a strip (h-9), so it never covers a pane; pt-0.5 nudges the button's centre towards the traffic lights' (y≈20).
          className="absolute z-30 flex h-9 items-center justify-center pt-0.5"
          style={{ top: showReconnectBanner ? 28 : 0, left: leftDockLeft(windowFullScreen), width: LEFT_DOCK_WIDTH, ...NO_DRAG_REGION_STYLE }}
        >
          <SidebarToggleButton collapsed onToggle={toggleSidebar} />
        </div>
      ) : null}
    </div>
  );
}
