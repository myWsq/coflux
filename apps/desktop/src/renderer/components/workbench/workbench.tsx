import { NotificationInbox } from "./notification-inbox";
import { lazy, Suspense, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useStore } from "zustand";
import { AlertCircle, FolderGit2, LoaderCircle, Plus, RefreshCw, SquareTerminal, X } from "lucide-react";
import { type DaemonInfo, type Project, type Task, type Workspace } from "@coflux/protocol";

import { AuthMessage, AuthShell, CredentialsForm } from "@/components/auth/auth-shell";
import { dismissBootOverlay } from "@/boot-overlay";
import { Button } from "@astryxdesign/core/Button";
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
import { SettingsPage } from "@/components/settings/settings-page";
import { useSettingsTooltipControl } from "@/components/workbench/account-footer";
import { countLocalRunningTerminals } from "@/components/workbench/daemon-view";
import { attentionNotificationText, attentionSnapshot, diffAttention, type AttentionSnapshot } from "@/components/workbench/desktop-attention";
import { resolveOutdatedPrompt } from "@/components/workbench/desktop-update";
import { DESKTOP_DRAG_BAND_STYLE } from "@/components/workbench/drag-region";
import { ImportProjectWizard } from "@/components/workbench/import-project-wizard";
import { Sidebar, type PendingWorkspace } from "@/components/workbench/sidebar";
import { useTerminalAttach } from "@/components/workbench/terminal-attach";
import { useDesktopDaemonState } from "@/components/workbench/use-desktop-daemon";
import { useExecutorBridge } from "@/components/workbench/use-executor-bridge";
import { useDesktopUpdateState } from "@/components/workbench/use-desktop-update";
import { useGlobalShortcuts } from "@/components/workbench/use-global-shortcuts";
import { useSidebarWidth } from "@/components/workbench/use-sidebar-width";
import type { WorkspaceActiveTab, WorkspaceTerminalHandle } from "@/components/workbench/workspace-terminal";
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
import { DAEMON_ONBOARDING_DISMISSED_KEY, WORKSPACE_KEY, desktop } from "@/config";
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
    <AuthShell>
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
  // 只指向当前 active 的 WorkspaceTerminal 实例：ref 只挂在 active===true 的那个元素上（见下方渲染），
  // 保活但隐藏的实例永远拿不到这份 ref，全局快捷键天然只广播给 active 实例。
  const activeTerminalRef = useRef<WorkspaceTerminalHandle | null>(null);
  // 各工作区当前的活动 Tab（由 WorkspaceTerminal 同步上报，plan 104）：终端面板挂在本层，
  // 可见面板 = 选中工作区的活动 Tab 且它处在终端视图。ref 双轨的理由同容器内部——
  // 接管状态机要在 setState 生效之前就读到"当下"值。
  const [activeTabs, setActiveTabs] = useState<Record<string, WorkspaceActiveTab>>({});
  const activeTabsRef = useRef(activeTabs);
  // 终端被搬进某工作区后要求它继续当活动 Tab（plan 104）：一次性，容器消费掉即清。
  const [notificationOpen, setNotificationOpen] = useState(false);
  const [followTask, setFollowTask] = useState<{ workspaceId: string; taskId: string } | null>(null);
  const activeWorkspaceIdRef = useRef<string | null>(null);
  // 已挂过面板的 task：面板寿命与工作区容器解耦，终端被搬到没访问过的工作区也不重建。
  const paneTaskIdsRef = useRef(new Set<string>());

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
  const attach = useTerminalAttach(client, { tasks, activeWorkspaceId });

  /** 可见面板 = 选中工作区的终端视图活动 Tab；同步写进状态机的门禁镜像。 */
  function syncVisibleTask() {
    const workspaceId = activeWorkspaceIdRef.current;
    const entry = workspaceId ? activeTabsRef.current[workspaceId] : undefined;
    attach.setVisibleTaskId(entry?.viewIsTerminal ? entry.taskId : null);
  }
  // 渲染期同步一次：切换工作区时门禁必须立刻跟上（同 WorkspaceTerminal 里 ref 镜像 prop 的写法）。
  syncVisibleTask();
  const syncVisibleTaskRef = useRef(syncVisibleTask);
  syncVisibleTaskRef.current = syncVisibleTask;

  function reportActiveTab(workspaceId: string, next: WorkspaceActiveTab) {
    const previous = activeTabsRef.current[workspaceId];
    if (previous && previous.taskId === next.taskId && previous.viewIsTerminal === next.viewIsTerminal) return;
    activeTabsRef.current = { ...activeTabsRef.current, [workspaceId]: next };
    setActiveTabs(activeTabsRef.current);
    syncVisibleTask();
  }

  const activeTab = activeWorkspaceId ? activeTabs[activeWorkspaceId] : undefined;
  const visibleTaskId = activeTab?.viewIsTerminal ? activeTab.taskId : null;

  // 终端被搬到别的工作区（plan 104）：用户正看着的终端搬走时选中态跟过去，它在新工作区里
  // 仍是活动 Tab。这件事必须赶在 React 渲染之前定下来——工作区容器的 tasks effect 先于本组件的
  // effect 跑（子先于父），等父 effect 再改选中就晚了：新工作区容器会先按"没有活动 Tab"回退去
  // attach 第一个兄弟 Tab。store 订阅在 setState 中同步触发、与本轮渲染合批，容器读到的就是
  // 最终结果；面板可见性也在同一帧就位，被搬走的终端不会闪一下。
  useEffect(() => {
    return client.store.subscribe((state, previous) => {
      if (state.tasks === previous.tasks) return;
      const workspaceId = activeWorkspaceIdRef.current;
      const entry = workspaceId ? activeTabsRef.current[workspaceId] : undefined;
      const taskId = entry?.taskId ?? null;
      const next = resolveSelectionAfterTaskMove({ activeWorkspaceId: workspaceId, activeTaskId: taskId, tasks: state.tasks });
      if (!next || !taskId) return;
      activeTabsRef.current = { ...activeTabsRef.current, [next.id]: { taskId, viewIsTerminal: true } };
      setActiveTabs(activeTabsRef.current);
      setFollowTask({ workspaceId: next.id, taskId });
      activeWorkspaceIdRef.current = next.id;
      setSelection(next);
      persistSelection(next);
      syncVisibleTaskRef.current();
    });
  }, [client]);

  // 跟随只生效一次：容器已在同一轮 commit 里把它选成活动 Tab，留着会在后续 tasks 变化时
  // 反复抢走用户自己切过去的 Tab。
  useEffect(() => {
    if (followTask) setFollowTask(null);
  }, [followTask]);

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

  // 连接从进入页面就开始，而不是等进某个项目：侧栏要对每台在线设备显示延迟，就得有连接。
  // measureOnly = 一条 relay lane + 心跳，不碰 loopback（direct 只对与浏览器同机的那台设备
  // 有意义，为一个读数去敲它，对其余设备是每 5s 一次注定失败的重试）。顺带把连接焐热，
  // 之后真进某台设备时不用再从 rendezvous 开始等。
  // 依赖收敛成排序后的 id 串：daemons 每次广播都是新数组，直接依赖它会反复 retain/release。
  const onlineDaemonIds = daemons.filter((daemon) => daemon.online).map((daemon) => daemon.daemonId).sort().join(",");
  useEffect(() => {
    if (!onlineDaemonIds) return;
    const releases = onlineDaemonIds.split(",").map((id) => client.retainDevice(id, { measureOnly: true }));
    return () => releases.forEach((release) => release());
  }, [client, onlineDaemonIds]);

  function selectWorkspace(workspaceId: string) {
    const next: WorkbenchSelection = { kind: "workspace", id: workspaceId };
    setSelection(next);
    persistSelection(next);
  }

  function navigateNotificationTask(taskId: string): boolean {
    const state = client.store.getState();
    const task = state.tasks.find((item) => item.id === taskId);
    if (!task || !state.workspaces.some((item) => item.id === task.workspaceId)) return false;
    activeTabsRef.current = { ...activeTabsRef.current, [task.workspaceId]: { taskId, viewIsTerminal: true } };
    setActiveTabs(activeTabsRef.current);
    setFollowTask({ workspaceId: task.workspaceId, taskId });
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
  const showError = lastError !== null && lastError.id !== dismissedErrorId;
  const displayError = lastError?.message.replaceAll("任务", "终端");

  useGlobalShortcuts({
    selectedProjectId: selectedWorkspace?.projectId ?? null,
    activeTerminalRef,
    onOpenCreateWorkspaceMenu: setCreateMenuProjectId,
    onToggleHelp: () => setHelpOpen((open) => !open),
    onToggleSettings: () => setSettingsOpen((open) => !open),
    // 设置页盖住工作台时终端既看不见也点不到，⌘T/⌘W/⌘1 之类再落到终端上就是盲操作；
    // 原生菜单项走同一条挂起开关。
    isSuspended: settingsOpen,
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
      <AuthShell>
        <CredentialsForm
          title="登录到 coflux"
          description="使用你的账号访问远程工作区"
          username={username}
          password={password}
          busy={false}
          error={authState === "auth-failed" ? loginError || "登录失败" : undefined}
          onUsernameChange={setUsername}
          onPasswordChange={setPassword}
          onSubmit={login}
        />
      </AuthShell>
    );
  }

  return (
    // 断线时给顶部横幅留出 h-7：横幅是 fixed 的，不留白就会压住终端 tab 栏，中心离线期间
    // 点不到切换/关闭终端（padding 改变容器高度，终端 fit 由 ResizeObserver 跟随）。
    <div
      className={cn(
        "flex h-screen min-h-[640px] min-w-[1024px] overflow-hidden bg-background text-foreground",
        showReconnectBanner && "pt-7",
      )}
    >
      <DesktopAttention client={client} bridge={desktop} selectedWorkspaceId={selection?.kind === "workspace" ? selection.id : null} />
      <NotificationInbox client={client} open={notificationOpen} onOpen={() => setNotificationOpen(true)} onClose={() => setNotificationOpen(false)} onNavigate={navigateNotificationTask} />
      <Sidebar
        onOpenNotifications={() => setNotificationOpen((open) => !open)}
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
          {/* 终端主区（plan 104）：顶栏一行、主体一行的两行网格。工作区容器经 display:contents
              把自己的顶栏与主体覆盖层放进这两格；终端面板层是它们的兄弟节点，按 task id 常驻，
              终端换工作区时既不跟着容器重建，也不依赖新工作区的容器是否挂载。
              未选中工作区时整块隐藏（设备空态 / 引导空态自己占位），面板保持挂载不卸载。 */}
          <main
            className={cn(
              "min-w-0 flex-1 bg-terminal",
              activeWorkspaceId ? "grid grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)]" : "hidden",
            )}
          >
            {terminalWorkspaces.map((workspace) => {
              const isActive = workspace.id === activeWorkspaceId;
              return (
                // display:contents 让顶栏与主体直接落进上面的两行网格
                <div key={workspace.id} className={isActive ? "contents" : "hidden"}>
                  <WorkspaceTerminal
                    // ref 只挂在 active 实例上：非 active 的保活实例传 undefined，永远拿不到命令句柄。
                    ref={isActive ? activeTerminalRef : undefined}
                    workspaceId={workspace.id}
                    active={isActive}
                    client={client}
                    onCloseTask={requestCloseTask}
                    attach={attach}
                    followTaskId={followTask?.workspaceId === workspace.id ? followTask.taskId : null}
                    onActiveTabChange={reportActiveTab}
                  />
                </div>
              );
            })}
            <TerminalPanes tasks={paneTasks} visibleTaskId={visibleTaskId} client={client} attach={attach} />
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
    </div>
  );
}
