import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { ArrowLeft, FileDiff, GitBranch, LoaderCircle, Plus, SquareTerminal, Unplug, X } from "lucide-react";
import { TaskStatus, type Task } from "@coflux/protocol";

import { Button } from "@astryxdesign/core/Button";
import { ChangesView } from "@/components/changes-view";
import { ShortcutBar } from "@/components/shortcut-bar";
import { TerminalPane, type TerminalController, type TerminalControlState } from "@/components/terminal-pane";
import type { CofluxClient } from "@coflux/client";
import { cn } from "@/lib/utils";

// attach 后即使无 ptyOutput 回放（空 scrollback）也要在 500ms 后判定 owned；有输出则立即 owned。
const ATTACH_GRACE_MS = 500;

type WorkspaceDetailProps = {
  client: CofluxClient;
  workspaceId: string;
  onBack: () => void;
};

/** 工作区详情：终端 Tab 条 + 常驻「变更」Tab + 快捷键条。移动端进入即挂载、返回列表即整体
 * 卸载（不像桌面端把访问过的工作区隐藏保活），所以这里不需要桌面 workspace-terminal.tsx
 * 那套"隐藏但挂载"的 active 矩阵；接管状态机（attach/markOwned/beginAttach/性能激活）逐字
 * 照搬桌面实现，因为它是安全语义而非体验细节。分支切换 / 端口转发 / 多设备管理均出 plan
 * 032 范围，不搬。 */
export function WorkspaceDetail({ client, workspaceId, onBack }: WorkspaceDetailProps) {
  const workspace = useStore(client.store, (state) => state.workspaces.find((item) => item.id === workspaceId));
  const defaultBranch = useStore(
    client.store,
    (state) => state.projects.find((item) => item.id === workspace?.projectId)?.defaultBranch ?? "",
  );
  const workspaceTasks = useStore(
    client.store,
    useShallow((state) =>
      state.tasks.filter((task) => task.workspaceId === workspaceId).sort((left, right) => left.createdAt - right.createdAt),
    ),
  );
  const detachedTaskIds = useStore(client.store, (state) => state.detachedTaskIds);
  const snapshotRevision = useStore(client.store, (state) => state.snapshotRevision);
  const lastError = useStore(client.store, (state) => state.lastError);

  const [activeTaskId, setActiveTaskIdState] = useState<string | null>(null);
  // 「变更」与终端 Tab 互斥（同桌面端 plan 025 决策）。
  const [view, setView] = useState<"terminal" | "changes">("terminal");
  const [controlStates, setControlStatesState] = useState<Record<string, TerminalControlState>>({});
  const [creating, setCreating] = useState(false);
  // 粘滞 Ctrl 的武装态：只对当前激活 Tab 生效（见下方 TerminalPane 的 ctrlArmed 传值）。
  const [ctrlArmed, setCtrlArmed] = useState(false);

  const controllersRef = useRef(new Map<string, TerminalController>());
  const sessionReadyRef = useRef(new Map<string, string>()); // taskId -> 已注册 consumer 的 sessionId
  const attachedKeysRef = useRef(new Map<string, string>()); // taskId -> attach 去重 key
  const attachTimersRef = useRef(new Map<string, number>());
  const attachSequenceRef = useRef(0);
  const launchingTaskIdsRef = useRef(new Set<string>()); // 自己发起启动（非 attach）的任务
  const activationRequestsRef = useRef(new Set<string>());
  const forcedClaimsRef = useRef(new Set<string>());
  const pendingCreateRef = useRef<{ knownTaskIds: Set<string> } | null>(null);

  const activeTaskIdRef = useRef<string | null>(null);
  const controlStatesRef = useRef<Record<string, TerminalControlState>>({});

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
      beginAttach(task, controller, force);
      return;
    }

    activationRequestsRef.current.delete(taskId);
    forcedClaimsRef.current.delete(taskId);
    if (launchingTaskIdsRef.current.has(taskId)) return;
    if (task.status === TaskStatus.EXITED) controller.reset();
    launchingTaskIdsRef.current.add(taskId);
    updateControlState(taskId, "attaching");
    const { cols, rows } = controller.dimensions();
    client.startTask(taskId, cols, rows);
  }

  function requestActivation(taskId: string, forceClaim = false) {
    setView("terminal");
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

  function handleSessionReady(taskId: string, sessionId: string, controller: TerminalController) {
    sessionReadyRef.current.set(taskId, sessionId);
    const task = currentTasks().find((item) => item.id === taskId);
    if (!task || task.sessionId !== sessionId || task.status !== TaskStatus.RUNNING) return;

    if (launchingTaskIdsRef.current.delete(taskId)) {
      attachedKeysRef.current.set(taskId, `${client.store.getState().snapshotRevision}:${sessionId}`);
      markOwned(taskId, sessionId);
    } else if (activeTaskIdRef.current === taskId) {
      beginAttach(task, controller, false);
    }
    if (activationRequestsRef.current.has(taskId)) performActivation(taskId);
  }

  function handleOutput(taskId: string, sessionId: string) {
    if (controlStatesRef.current[taskId] === "attaching") markOwned(taskId, sessionId);
  }

  // taskCreate 无请求-响应关联：靠"快照增量中新出现的未知 task id"识别自己创建的任务。
  function createTerminal() {
    if (pendingCreateRef.current) return;
    const tasksNow = currentTasks();
    pendingCreateRef.current = { knownTaskIds: new Set(tasksNow.map((task) => task.id)) };
    setCreating(true);
    client.send({ case: "taskCreate", value: { workspaceId, title: `终端 ${tasksNow.length + 1}` } });
  }

  function closeTaskNow(task: Task) {
    // 只发 taskRemove：server 侧 handler 自带 sessionClose + dropSession。
    client.send({ case: "taskRemove", value: { taskId: task.id } });
  }

  function requestCloseTask(task: Task) {
    if (task.status !== TaskStatus.RUNNING) {
      closeTaskNow(task);
      return;
    }
    // ponytail: 桌面端用自研 ConfirmDialog 组件，移动端没有搬那套弹层体系的必要——
    // 原生 confirm() 足够表达"运行中终端关闭需二次确认"，唯一破坏性操作，出现频率低。
    if (window.confirm(`关闭终端「${task.title || "终端"}」？\n正在运行的 shell 会先停止，随后永久删除这个 Tab，历史输出不会保留。`)) {
      closeTaskNow(task);
    }
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceTasks]);

  // taskDetached 广播：被他端接管 → 置 detached、清 attach key、终端内写系统提示行。
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

  // snapshotRevision 变更 = 重连/重登：server 侧旧连接的 holder 已失效，正在看的那个终端
  // 必须重新 beginAttach，否则变成只读观众。
  useEffect(() => {
    if (snapshotRevision === 0) return;
    const frame = requestAnimationFrame(() => {
      const taskId = activeTaskIdRef.current;
      if (!taskId) return;
      const task = currentTasks().find((item) => item.id === taskId);
      const controller = controllersRef.current.get(taskId);
      if (
        task &&
        task.status === TaskStatus.RUNNING &&
        task.sessionId &&
        controller &&
        sessionReadyRef.current.get(taskId) === task.sessionId
      ) {
        beginAttach(task, controller, false);
      }
    });
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshotRevision]);

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

  useEffect(() => {
    return () => {
      for (const timer of attachTimersRef.current.values()) window.clearTimeout(timer);
      attachTimersRef.current.clear();
    };
  }, []);

  function stateOf(task: Task): TerminalControlState {
    return controlStates[task.id] ?? (task.status === TaskStatus.RUNNING ? "idle" : "stopped");
  }

  const activeTask = workspaceTasks.find((task) => task.id === activeTaskId) ?? null;
  const activeControlState: TerminalControlState = activeTask ? stateOf(activeTask) : "stopped";

  function sendControl(bytes: string) {
    if (!activeTask?.sessionId || activeControlState !== "owned") return;
    client.sendInput(activeTask.sessionId, bytes);
  }

  return (
    <div className="flex h-full flex-col bg-terminal">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-background px-2">
        <button
          className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground active:bg-accent"
          onClick={onBack}
        >
          <ArrowLeft className="size-4" />
        </button>
        <div className="flex min-w-0 items-center gap-1 text-sm text-secondary-foreground">
          <GitBranch className="size-3 shrink-0" />
          <span className="truncate">{workspace?.branch ?? ""}</span>
        </div>
      </header>

      <div className="flex h-10 shrink-0 items-center gap-1 overflow-x-auto border-b border-border bg-background px-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {/* 常驻「变更」Tab（同桌面端 plan 025），统计并入 Tab、X=Y=0 时数字隐藏。 */}
        <button
          className={cn(
            "flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-sm",
            view === "changes" ? "bg-accent text-foreground" : "text-secondary-foreground active:bg-accent/60",
          )}
          onClick={() => setView("changes")}
        >
          <FileDiff className={cn("size-3 shrink-0", view === "changes" ? "opacity-90" : "opacity-50")} />
          <span>变更</span>
          {workspace && (workspace.additions > 0 || workspace.deletions > 0) ? (
            <span className="whitespace-nowrap font-mono text-2xs tabular-nums">
              <span className="text-success">+{workspace.additions}</span> <span className="text-destructive">−{workspace.deletions}</span>
            </span>
          ) : null}
        </button>
        {workspaceTasks.map((task) => {
          const state = stateOf(task);
          const isActive = view === "terminal" && task.id === activeTaskId;
          return (
            <div
              key={task.id}
              className={cn(
                "flex h-7 max-w-40 shrink-0 items-center rounded-md text-sm",
                isActive ? "bg-accent text-foreground" : "text-secondary-foreground active:bg-accent/60",
              )}
            >
              <button
                className="flex min-w-0 flex-1 items-center gap-1.5 self-stretch pl-2.5 pr-1 text-left"
                onClick={() => requestActivation(task.id, state === "detached")}
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
              {/* 常显关闭按钮：触屏没有 hover，不能像桌面那样 hover 才显（group-hover）。 */}
              <button
                className="mr-1 flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground active:bg-muted"
                onClick={() => requestCloseTask(task)}
              >
                <X className="size-3" />
              </button>
            </div>
          );
        })}
        <button
          className="ml-0.5 flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground active:bg-accent disabled:cursor-wait disabled:opacity-50"
          onClick={createTerminal}
          disabled={creating}
        >
          {creating ? <LoaderCircle className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
        </button>
      </div>

      <div className="relative min-h-0 flex-1 bg-terminal">
        {/* 面板按 taskId 建立稳定身份（React key）：任务实体更新不重建 xterm（重建会丢 scrollback）。 */}
        {workspaceTasks.map((task) => (
          <TerminalPane
            key={task.id}
            taskId={task.id}
            sessionId={task.sessionId ?? null}
            active={view === "terminal" && task.id === activeTaskId}
            controlState={stateOf(task)}
            registerSessionConsumer={client.registerSessionConsumer}
            sendInput={client.sendInput}
            sendResize={(sessionId, cols, rows) => client.send({ case: "ptyResize", value: { sessionId, cols, rows } })}
            onReady={handleTerminalReady}
            onDispose={handleTerminalDispose}
            onSessionReady={handleSessionReady}
            onOutput={handleOutput}
            ctrlArmed={task.id === activeTaskId && ctrlArmed}
            onCtrlConsumed={() => setCtrlArmed(false)}
          />
        ))}

        {view === "terminal" && workspaceTasks.length === 0 ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
            <SquareTerminal className="size-6 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">这个工作区还没有终端</p>
            <Button label="新建终端" variant="primary" size="sm" icon={<Plus />} isLoading={creating} onClick={createTerminal} />
          </div>
        ) : null}

        {view === "terminal" && activeTask && activeControlState === "detached" ? (
          <div className="absolute inset-x-0 top-0 z-10 flex flex-col gap-1.5 border-b border-warning/20 bg-warning/10 px-3 py-2 text-xs text-warning backdrop-blur">
            <span className="flex items-center gap-1.5">
              <Unplug className="size-3.5 shrink-0" />
              此终端已被其它客户端接管，当前输入已锁定
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

      {view === "terminal" ? (
        <ShortcutBar
          disabled={activeControlState !== "owned"}
          ctrlArmed={ctrlArmed}
          onToggleCtrl={() => setCtrlArmed((prev) => !prev)}
          onSend={sendControl}
        />
      ) : null}
    </div>
  );
}
