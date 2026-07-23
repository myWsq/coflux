import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { ExternalLink, FileDiff, GitBranch, LoaderCircle, Plus, Router, SquareTerminal, Unplug, X } from "lucide-react";
import { TaskStatus, type Task } from "@coflux/protocol";

import { Button } from "@astryxdesign/core/Button";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import { BranchMenu, type BranchTaken } from "@/components/workbench/branch-menu";
import { ChangesView } from "@/components/workbench/changes-view";
import { shortcutModifierPrefix, useIsStandalone } from "@/components/workbench/use-shortcut-modifier";
import type { CofluxClient } from "@/client/store";
import { cn } from "@/lib/utils";
import { TerminalPane, type TerminalController, type TerminalControlState } from "@/components/workbench/terminal-pane";

// attach 后即使无 ptyOutput 回放（空 scrollback）也要在 500ms 后判定 owned；有输出则立即 owned。
const ATTACH_GRACE_MS = 500;

type WorkspaceTerminalProps = {
  workspaceId: string;
  /** 是否为当前显示的工作区：隐藏时保持挂载与 attach，仅切回时 fit + focus。 */
  active: boolean;
  client: CofluxClient;
  onCloseTask: (task: Task) => void;
};

/**
 * 全局快捷键（plan 015）向 active 实例下发的命令。Workbench 只把 ref 挂在
 * active===true 的那个实例上（见 workbench.tsx），保活但隐藏的实例永远拿不到这份 ref，
 * 天然满足"只有 active 实例响应快捷键"的约束。
 */
export type WorkspaceTerminalHandle = {
  createTerminal: () => void;
  /** 复用 onCloseTask（RUNNING 走既有确认对话框），无 active Tab 时安静忽略 */
  closeActiveTab: () => void;
  /** index 越界安静忽略 */
  selectTabByIndex: (index: number) => void;
  /** 按 Tab 栏顺序循环切换；无 Tab 时安静忽略 */
  selectRelativeTab: (delta: number) => void;
};

export const WorkspaceTerminal = forwardRef<WorkspaceTerminalHandle, WorkspaceTerminalProps>(function WorkspaceTerminal(
  { workspaceId, active, client, onCloseTask },
  ref,
) {
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
  const detachedTaskIds = useStore(client.store, (state) => state.detachedTaskIds);
  const modPrefix = shortcutModifierPrefix(useIsStandalone());
  const snapshotRevision = useStore(client.store, (state) => state.snapshotRevision);
  const lastError = useStore(client.store, (state) => state.lastError);
  const ports = useStore(client.store, (state) => state.ports);

  const [activeTaskId, setActiveTaskIdState] = useState<string | null>(null);
  // 主面板视图：常驻「变更」tab 与终端 Tab 互斥（plan 025）。本组件随工作区常驻挂载
  // （workbench.tsx 隐藏而非卸载），故该 state 天然按工作区独立保留，无需额外持久化。
  const [view, setView] = useState<"terminal" | "changes">("terminal");
  /** 切换分支中：目标分支名（按钮 pending 态；成功由 daemon 上报驱动 branch 变更后自动清除） */
  const [pendingBranch, setPendingBranch] = useState<string | null>(null);
  const [controlStates, setControlStatesState] = useState<Record<string, TerminalControlState>>({});
  const [creating, setCreating] = useState(false);

  // 接管状态机的非响应式内部账本：只驱动副作用，不驱动渲染（landmine 17：
  // Solid 组件体只跑一次、这些 Map/Set 天然是长生命周期闭包；React 每次渲染都跑组件体，
  // 必须挪进 useRef 才能跨渲染保持同一份引用）。
  const controllersRef = useRef(new Map<string, TerminalController>());
  const sessionReadyRef = useRef(new Map<string, string>()); // taskId -> 已注册 consumer 的 sessionId
  const attachedKeysRef = useRef(new Map<string, string>()); // taskId -> attach 去重 key
  const attachTimersRef = useRef(new Map<string, number>());
  const attachSequenceRef = useRef(0);
  const launchingTaskIdsRef = useRef(new Set<string>()); // 自己发起启动（非 attach）的任务
  const activationRequestsRef = useRef(new Set<string>());
  const forcedClaimsRef = useRef(new Set<string>());
  const pendingCreateRef = useRef<{ knownTaskIds: Set<string> } | null>(null);

  // activeTaskId/controlStates 的同步镜像：imperative 函数需要在 setState 后立即读到"当下"值
  // （对应 Solid 信号的同步读语义），而 React state 变量本身要等下一次渲染才更新，故用 ref 双轨。
  const activeTaskIdRef = useRef<string | null>(null);
  const controlStatesRef = useRef<Record<string, TerminalControlState>>({});
  // active prop 的镜像：handleSessionReady 等回调由子组件 effect 在任意渲染代触发，
  // 直接闭包捕获 active 会读到过期值（landmine），渲染期同步赋值即可，无需 useEffect。
  const activeRef = useRef(active);
  activeRef.current = active;

  function updateActiveTaskId(taskId: string | null) {
    activeTaskIdRef.current = taskId;
    setActiveTaskIdState(taskId);
  }

  function updateControlState(taskId: string, state: TerminalControlState) {
    if (controlStatesRef.current[taskId] === state) return;
    const next = { ...controlStatesRef.current, [taskId]: state };
    controlStatesRef.current = next;
    setControlStatesState(next);
  }

  // untrack(workspaceTasks) 的对应物：直接读 store 当下状态，不经由本次渲染闭包捕获的
  // workspaceTasks（可能已过期）。
  function currentTasks(): Task[] {
    return client.store
      .getState()
      .tasks.filter((task) => task.workspaceId === workspaceId)
      .sort((left, right) => left.createdAt - right.createdAt);
  }

  function clearAttachTimer(taskId: string) {
    const timer = attachTimersRef.current.get(taskId);
    if (timer !== undefined) window.clearTimeout(timer);
    attachTimersRef.current.delete(taskId);
  }

  // 拿到控制权后必须 fit + focus + ptyResize：把本端尺寸推给 PTY，
  // 否则远端 PTY 保持上一个 holder 的尺寸导致排版错乱。
  function markOwned(taskId: string, sessionId: string) {
    const task = currentTasks().find((item) => item.id === taskId);
    if (!task || task.status !== TaskStatus.RUNNING || task.sessionId !== sessionId) return;
    if (controlStatesRef.current[taskId] === "detached") return;
    clearAttachTimer(taskId);
    updateControlState(taskId, "owned");
    if (activeTaskIdRef.current === taskId) {
      const controller = controllersRef.current.get(taskId);
      if (!controller) return;
      controller.fit();
      controller.focus();
      const { cols, rows } = controller.dimensions();
      client.send({ case: "ptyResize", value: { sessionId, cols, rows } });
    }
  }

  // attach 即 taskStart（申请接管）；去重 key = `${snapshotRevision}:${sessionId}`，
  // 同一快照代内对同一 session 只 attach 一次；强制接管用递增序列 key 绕过去重。
  function beginAttach(task: Task, controller: TerminalController, force = false) {
    if (task.status !== TaskStatus.RUNNING || !task.sessionId) return;
    if (sessionReadyRef.current.get(task.id) !== task.sessionId) return;
    const attachKey = force
      ? `claim:${++attachSequenceRef.current}:${task.sessionId}`
      : `${client.store.getState().snapshotRevision}:${task.sessionId}`;
    if (!force && attachedKeysRef.current.get(task.id) === attachKey) return;

    attachedKeysRef.current.set(task.id, attachKey);
    updateControlState(task.id, "attaching");
    const { cols, rows } = controller.dimensions();
    client.startTask(task.id, cols, rows);
    clearAttachTimer(task.id);
    attachSequenceRef.current += 1;
    const timer = window.setTimeout(() => {
      if (controlStatesRef.current[task.id] === "attaching") markOwned(task.id, task.sessionId!);
    }, ATTACH_GRACE_MS);
    attachTimersRef.current.set(task.id, timer);
  }

  function performActivation(taskId: string) {
    const task = currentTasks().find((item) => item.id === taskId);
    const controller = controllersRef.current.get(taskId);
    if (!task || !controller) return;

    controller.fit();
    controller.focus();
    if (task.status === TaskStatus.RUNNING && task.sessionId) {
      if (sessionReadyRef.current.get(taskId) !== task.sessionId) return;
      activationRequestsRef.current.delete(taskId);
      const force = forcedClaimsRef.current.delete(taskId) || controlStatesRef.current[taskId] === "detached";
      // 隐藏实例的自动激活（workspaceTasks 效果里"无 currentActive 时选第一个任务"）也会
      // 走到这里：本实例不可见时不申请控制权，否则旁观端打开页面会把每个隐藏工作区的
      // 第一个任务都抢一遍。点击 Tab / 快捷键触发的 performActivation 只可能发生在可见实例，不受影响。
      if (activeRef.current) beginAttach(task, controller, force);
      return;
    }

    activationRequestsRef.current.delete(taskId);
    forcedClaimsRef.current.delete(taskId);
    if (launchingTaskIdsRef.current.has(taskId)) return;
    // EXITED 任务重启前 reset 终端，避免旧输出与新会话混叠。
    if (task.status === TaskStatus.EXITED) controller.reset();
    launchingTaskIdsRef.current.add(taskId);
    updateControlState(taskId, "attaching");
    const { cols, rows } = controller.dimensions();
    client.startTask(taskId, cols, rows);
  }

  function requestActivation(taskId: string, forceClaim = false) {
    setView("terminal"); // 任何终端 Tab 的激活（点击/键盘/新建）都切回终端视图，与「变更」互斥
    updateActiveTaskId(taskId);
    activationRequestsRef.current.add(taskId);
    if (forceClaim) forcedClaimsRef.current.add(taskId);
    requestAnimationFrame(() => performActivation(taskId));
  }

  function handleTerminalReady(taskId: string, controller: TerminalController) {
    controllersRef.current.set(taskId, controller);
    if (activationRequestsRef.current.has(taskId)) performActivation(taskId);
  }

  function handleTerminalDispose(taskId: string, controller: TerminalController) {
    if (controllersRef.current.get(taskId) === controller) controllersRef.current.delete(taskId);
    sessionReadyRef.current.delete(taskId);
    clearAttachTimer(taskId);
  }

  // 新建启动 vs attach 区分：自己发起启动的任务在 session 就绪后直接 markOwned，
  // 不再发第二次 taskStart。
  function handleSessionReady(taskId: string, sessionId: string, controller: TerminalController) {
    sessionReadyRef.current.set(taskId, sessionId);
    const task = currentTasks().find((item) => item.id === taskId);
    if (!task || task.sessionId !== sessionId || task.status !== TaskStatus.RUNNING) return;

    if (launchingTaskIdsRef.current.delete(taskId)) {
      attachedKeysRef.current.set(taskId, `${client.store.getState().snapshotRevision}:${sessionId}`);
      markOwned(taskId, sessionId);
    } else if (activeRef.current && activeTaskIdRef.current === taskId) {
      // 只有本实例可见（用户正在看这个工作区）且该任务是激活 Tab 时才主动申请控制权；
      // 后台面板 / 隐藏工作区 / 旁观页面里的非激活任务不发 taskStart，不抢占对端 holder。
      beginAttach(task, controller, false);
    }
    if (activationRequestsRef.current.has(taskId)) performActivation(taskId);
  }

  function handleOutput(taskId: string, sessionId: string) {
    if (controlStatesRef.current[taskId] === "attaching") markOwned(taskId, sessionId);
  }

  // 分支切换：checkout 在本 worktree 内经 clientExec 完成，成功后同步元数据（workspaceSetBranch）。
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

  // taskCreate 无请求-响应关联：靠"快照增量中新出现的未知 task id"识别自己创建的任务。
  function createTerminal() {
    if (pendingCreateRef.current) return;
    const tasksNow = currentTasks();
    pendingCreateRef.current = { knownTaskIds: new Set(tasksNow.map((task) => task.id)) };
    setCreating(true);
    client.send({ case: "taskCreate", value: { workspaceId, title: `终端 ${tasksNow.length + 1}` } });
  }

  useEffect(() => {
    const ids = new Set(workspaceTasks.map((task) => task.id));
    for (const taskId of [...attachedKeysRef.current.keys()]) {
      if (!ids.has(taskId)) {
        attachedKeysRef.current.delete(taskId);
        sessionReadyRef.current.delete(taskId);
        launchingTaskIdsRef.current.delete(taskId);
        activationRequestsRef.current.delete(taskId);
        forcedClaimsRef.current.delete(taskId);
        clearAttachTimer(taskId);
      }
    }

    for (const task of workspaceTasks) {
      if (task.status !== TaskStatus.RUNNING) {
        attachedKeysRef.current.delete(task.id);
        sessionReadyRef.current.delete(task.id);
        if (!launchingTaskIdsRef.current.has(task.id)) updateControlState(task.id, "stopped");
      }
    }

    if (pendingCreateRef.current) {
      const created = workspaceTasks.find((task) => !pendingCreateRef.current!.knownTaskIds.has(task.id));
      if (created) {
        pendingCreateRef.current = null;
        setCreating(false);
        requestActivation(created.id);
      }
    }

    const currentActive = activeTaskIdRef.current;
    if (currentActive && ids.has(currentActive)) return;
    const nextTask = workspaceTasks[0];
    if (nextTask) requestActivation(nextTask.id);
    else updateActiveTaskId(null);
    // 只跟踪 workspaceTasks（对应 Solid `on(workspaceTasks, ...)` 的显式单一依赖），
    // 回调内其余状态一律读 ref/store 当下值，不纳入依赖数组。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceTasks]);

  // taskDetached 广播：被他端接管 → 置 detached、清 attach key、终端内写系统提示行。
  // 重新接管走 force claim（Tab 点击或横幅按钮）。
  useEffect(() => {
    for (const taskId of detachedTaskIds) {
      const task = currentTasks().find((item) => item.id === taskId);
      if (!task || controlStatesRef.current[taskId] === "detached") continue;
      clearAttachTimer(taskId);
      attachedKeysRef.current.delete(taskId);
      updateControlState(taskId, "detached");
      controllersRef.current.get(taskId)?.writeSystem("控制权已被其它客户端接管，点击此 Tab 可重新接管");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detachedTaskIds]);

  // snapshotRevision 变更 = 重连/重登：server 侧旧连接的 holder 已失效，
  // 正在看的那个终端必须重新 beginAttach 重新申请 holder，否则变成只读观众；
  // 隐藏工作区 / 非激活 Tab 不重新申请（避免把对端手里的 RUNNING 终端整批抢一遍）。
  useEffect(() => {
    if (snapshotRevision === 0 || !activeRef.current) return;
    const frame = requestAnimationFrame(() => {
      const taskId = activeTaskIdRef.current;
      if (!taskId) return;
      const task = currentTasks().find((item) => item.id === taskId);
      const controller = controllersRef.current.get(taskId);
      if (task && task.status === TaskStatus.RUNNING && task.sessionId && controller && sessionReadyRef.current.get(taskId) === task.sessionId) {
        beginAttach(task, controller, false);
      }
    });
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshotRevision]);

  // error 消息到达时清 pending 创建态与 launching 态（taskCreate/taskStart 失败兜底）。
  useEffect(() => {
    if (!lastError) return;
    if (pendingCreateRef.current) {
      pendingCreateRef.current = null;
      setCreating(false);
    }
    for (const taskId of launchingTaskIdsRef.current) updateControlState(taskId, "stopped");
    launchingTaskIdsRef.current.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastError]);

  // 工作区从隐藏切回显示：重新 fit（隐藏期间尺寸为 0，ResizeObserver 的 fit 被 no-op 掉）并聚焦；
  // 激活 Tab 若隐藏期间从未 attach（idle）或恰逢重连（snapshotRevision 效果被跳过）而丢了 holder，
  // 在此补一次 beginAttach——dedup key 天然区分"已 attach 过同一代 no-op" vs "换代需重新申请"，
  // 无需额外区分场景。detached 显式排除：必须由用户点击才重新接管，不能一切回工作区就自动抢回。
  useEffect(() => {
    if (!active) return;
    const frame = requestAnimationFrame(() => {
      const taskId = activeTaskIdRef.current;
      if (!taskId) return;
      const controller = controllersRef.current.get(taskId);
      controller?.fit();
      controller?.focus();
      const task = currentTasks().find((item) => item.id === taskId);
      if (
        task &&
        controller &&
        task.status === TaskStatus.RUNNING &&
        task.sessionId &&
        sessionReadyRef.current.get(taskId) === task.sessionId &&
        controlStatesRef.current[taskId] !== "detached"
      ) {
        beginAttach(task, controller, false);
      }
    });
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  useEffect(() => {
    return () => {
      for (const timer of attachTimersRef.current.values()) window.clearTimeout(timer);
      attachTimersRef.current.clear();
    };
  }, []);

  // RUNNING 且尚未（且可能永不）发起 attach 的任务（后台面板 / 隐藏工作区 / 旁观页面）
  // 回落为 "idle"：Tab 图标呈中性终端图标，不是永转的 attaching spinner。
  function stateOf(task: Task): TerminalControlState {
    return controlStates[task.id] ?? (task.status === TaskStatus.RUNNING ? "idle" : "stopped");
  }

  const activeTask = workspaceTasks.find((task) => task.id === activeTaskId) ?? null;
  const activeControlState: TerminalControlState = activeTask ? stateOf(activeTask) : "stopped";
  const activePorts = activeTask ? (ports[activeTask.id] ?? []) : [];

  useImperativeHandle(ref, () => ({
    createTerminal,
    closeActiveTab: () => {
      if (activeTask) onCloseTask(activeTask);
    },
    selectTabByIndex: (index: number) => {
      const task = workspaceTasks[index];
      if (task) requestActivation(task.id, stateOf(task) === "detached");
    },
    selectRelativeTab: (delta: number) => {
      if (workspaceTasks.length === 0) return;
      const currentIndex = workspaceTasks.findIndex((task) => task.id === activeTaskId);
      const base = currentIndex === -1 ? 0 : currentIndex;
      const next = ((base + delta) % workspaceTasks.length + workspaceTasks.length) % workspaceTasks.length;
      const task = workspaceTasks[next]!;
      requestActivation(task.id, stateOf(task) === "detached");
    },
  }));

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-terminal">
      {/* 单栏顶栏：名称（如有）＋ 可点的分支按钮 │ 终端 Tabs（Tab 用间距而非竖线分隔）＋ 新建/端口 */}
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-background px-3">
        <BranchMenu
          currentBranch={workspace?.branch ?? ""}
          button={{
            label: pendingBranch ?? workspace?.branch ?? "",
            icon: pendingBranch ? <LoaderCircle className="size-3 animate-spin" /> : <GitBranch className="size-3" />,
            isDisabled: Boolean(pendingBranch),
            variant: "ghost",
            size: "sm",
            // ghost 默认色偏亮、内边距偏大：压到与顶栏辅助元素一致（内联样式压 StyleX）
            style: { color: "var(--secondary-foreground)", height: 24, paddingInline: 6, gap: 6 },
          }}
          listBranches={listBranches}
          takenBranches={takenBranches}
          onPick={switchBranch}
        />
        <div className="h-4 w-px shrink-0 bg-border" />
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {/* 常驻「变更」tab（plan 025）：与终端 Tab 同级同组、选中态互斥；
              统计徽标并入 tab，X=Y=0 时数字隐藏，tab 本身仍在。 */}
          <button
            className={cn(
              "flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-sm transition-colors",
              view === "changes"
                ? "bg-accent text-foreground"
                : "text-secondary-foreground hover:bg-accent/60 hover:text-foreground",
            )}
            onClick={() => setView("changes")}
          >
            <FileDiff className={cn("size-3 shrink-0", view === "changes" ? "opacity-90" : "opacity-50")} />
            <span>变更</span>
            {workspace && (workspace.additions > 0 || workspace.deletions > 0) ? (
              <span className="whitespace-nowrap font-mono text-2xs tabular-nums" title={`+${workspace.additions} −${workspace.deletions}`}>
                <span className="text-success">+{workspace.additions}</span> <span className="text-destructive">−{workspace.deletions}</span>
              </span>
            ) : null}
          </button>
          {workspaceTasks.map((task) => {
            const state = stateOf(task);
            // 「变更」视图激活时终端 Tab 一律去高亮，两种视图选中态互斥（plan 025）。
            const isActive = view === "terminal" && task.id === activeTaskId;
            const taskPorts = ports[task.id] ?? [];
            return (
              <div
                key={task.id}
                className={cn(
                  "group flex h-7 max-w-52 shrink-0 items-center rounded-md text-sm transition-colors",
                  isActive ? "bg-accent text-foreground" : "text-secondary-foreground hover:bg-accent/60 hover:text-foreground",
                )}
              >
                <button
                  className="flex min-w-0 flex-1 items-center gap-1.5 self-stretch px-2.5 text-left"
                  onClick={() => requestActivation(task.id, state === "detached")}
                  title={state === "detached" ? `${task.title}（已被接管，点击重新接管）` : task.title}
                >
                  {state === "attaching" ? (
                    <LoaderCircle className="size-3 shrink-0 animate-spin text-muted-foreground" />
                  ) : state === "detached" ? (
                    <Unplug className="size-3 shrink-0 text-warning" />
                  ) : (
                    <SquareTerminal className={cn("size-3 shrink-0", isActive ? "opacity-90" : "opacity-50")} />
                  )}
                  <span className="truncate">{task.title || "终端"}</span>
                </button>
                {taskPorts.length > 0 ? (
                  <DropdownMenu
                    button={{
                      label: "转发端口",
                      tooltip: "转发端口",
                      icon: <Router className="size-3" />,
                      isIconOnly: true,
                      variant: "ghost",
                      size: "sm",
                      className:
                        "mr-0.5 flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-70 transition-colors hover:bg-muted hover:text-foreground",
                    }}
                    hasChevron={false}
                    items={taskPorts.map((preview) => ({
                      label: `:${preview.port}`,
                      onClick: () => window.open(preview.url, "_blank", "noreferrer"),
                    }))}
                  />
                ) : null}
                <Tooltip content={`关闭终端 ${modPrefix}W`} placement="below">
                  <button
                    className="mr-0.5 flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-all hover:bg-muted hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
                    onClick={() => onCloseTask(task)}
                  >
                    <X className="size-3" />
                  </button>
                </Tooltip>
              </div>
            );
          })}
          {/* 新建按钮跟随最后一个 Tab（浏览器式），不钉在最右 */}
          <Tooltip content={`新建终端 ${modPrefix}T`} placement="below">
            <button
              className="ml-0.5 flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-wait disabled:opacity-50"
              onClick={createTerminal}
              disabled={creating}
            >
              {creating ? <LoaderCircle className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
            </button>
          </Tooltip>
        </div>
        {activePorts.length > 0 ? (
          <div className="flex shrink-0 items-center gap-1">
            {activePorts.map((preview) => (
              <a
                key={preview.port}
                href={preview.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-5 items-center gap-1 rounded px-1.5 font-mono text-2xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                :{preview.port}
                <ExternalLink className="size-2.5" />
              </a>
            ))}
          </div>
        ) : null}
      </header>

      <div className="relative min-h-0 flex-1 bg-terminal">
        {/* 面板按 taskId 建立稳定身份（React key）：任务实体更新不重建 xterm（重建会丢 scrollback）。 */}
        {workspaceTasks.map((task) => (
          <TerminalPane
            key={task.id}
            taskId={task.id}
            sessionId={task.sessionId ?? null}
            workspaceId={workspaceId}
            active={view === "terminal" && task.id === activeTaskId}
            controlState={stateOf(task)}
            registerSessionConsumer={client.registerSessionConsumer}
            sendInput={client.sendInput}
            sendResize={(sessionId, cols, rows) => client.send({ case: "ptyResize", value: { sessionId, cols, rows } })}
            sendFsWrite={client.sendFsWrite}
            onReady={handleTerminalReady}
            onDispose={handleTerminalDispose}
            onSessionReady={handleSessionReady}
            onOutput={handleOutput}
          />
        ))}

        {view === "terminal" && workspaceTasks.length === 0 ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="flex max-w-sm flex-col items-center text-center">
              <div className="mb-4 flex size-10 items-center justify-center rounded-lg border border-border text-muted-foreground">
                <SquareTerminal className="size-5" />
              </div>
              <h2 className="text-base font-medium text-foreground">这个工作区还没有终端</h2>
              <p className="mt-1.5 text-sm leading-5 text-muted-foreground">创建后会立即启动 shell，并作为一个新 Tab 打开。也可以按 {modPrefix}T 快速新建。</p>
              <Button className="mt-5" label="新建终端" variant="primary" size="sm" icon={<Plus />} isLoading={creating} onClick={createTerminal} />
            </div>
          </div>
        ) : null}

        {view === "terminal" && activeTask && activeControlState === "detached" ? (
          <div className="absolute inset-x-0 top-0 z-10 flex items-center justify-between border-b border-warning/20 bg-warning/10 px-4 py-2 text-xs text-warning backdrop-blur">
            <span className="flex items-center gap-2">
              <Unplug className="size-3.5" />
              此终端已被其它客户端接管，当前输入已锁定。
            </span>
            <Button label="重新接管" variant="secondary" size="sm" onClick={() => requestActivation(activeTask.id, true)} />
          </div>
        ) : null}

        {/* 「变更」视图：与终端面板同保活模式（隐藏不卸载），折叠态/已拉取数据才不随切换丢失。 */}
        <div className={cn("absolute inset-0 bg-terminal", view === "changes" ? "block" : "hidden")}>
          <ChangesView
            workspaceId={workspaceId}
            active={view === "changes"}
            client={client}
            defaultBranch={defaultBranch}
            additions={workspace?.additions ?? 0}
            deletions={workspace?.deletions ?? 0}
          />
        </div>
      </div>

    </section>
  );
});
