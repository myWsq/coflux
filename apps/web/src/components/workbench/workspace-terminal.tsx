import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { ExternalLink, LoaderCircle, Plus, SquareTerminal, Unplug, X } from "lucide-react";
import { TaskStatus, type Task } from "@coflux/protocol";

import { Button } from "@/components/ui/button";
import type { CofluxClient } from "@/client/store";
import { cn } from "@/lib/utils";
import { TerminalPane, type TerminalController, type TerminalControlState } from "@/components/workbench/terminal-pane";

// attach 后即使无 ptyOutput 回放（空 scrollback）也要在 500ms 后判定 owned；有输出则立即 owned。
const ATTACH_GRACE_MS = 500;

type WorkspaceTerminalProps = {
  workspaceId: string;
  client: CofluxClient;
  onCloseTask: (task: Task) => void;
};

export function WorkspaceTerminal({ workspaceId, client, onCloseTask }: WorkspaceTerminalProps) {
  const workspace = useStore(client.store, (state) => state.workspaces.find((item) => item.id === workspaceId));
  const workspaceTasks = useStore(
    client.store,
    useShallow((state) =>
      state.tasks.filter((task) => task.workspaceId === workspaceId).sort((left, right) => left.createdAt - right.createdAt),
    ),
  );
  const detachedTaskIds = useStore(client.store, (state) => state.detachedTaskIds);
  const snapshotRevision = useStore(client.store, (state) => state.snapshotRevision);
  const lastError = useStore(client.store, (state) => state.lastError);
  const ports = useStore(client.store, (state) => state.ports);

  const [activeTaskId, setActiveTaskIdState] = useState<string | null>(null);
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
      beginAttach(task, controller, force);
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
    } else {
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
  // 必须对所有 RUNNING 任务重新 beginAttach 重新申请 holder，否则变成只读观众。
  useEffect(() => {
    if (snapshotRevision === 0) return;
    const frame = requestAnimationFrame(() => {
      for (const task of currentTasks()) {
        const controller = controllersRef.current.get(task.id);
        if (task.status === TaskStatus.RUNNING && task.sessionId && controller && sessionReadyRef.current.get(task.id) === task.sessionId) {
          beginAttach(task, controller, false);
        }
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

  useEffect(() => {
    return () => {
      for (const timer of attachTimersRef.current.values()) window.clearTimeout(timer);
      attachTimersRef.current.clear();
    };
  }, []);

  function stateOf(task: Task): TerminalControlState {
    return controlStates[task.id] ?? (task.status === TaskStatus.RUNNING ? "attaching" : "stopped");
  }

  const activeTask = workspaceTasks.find((task) => task.id === activeTaskId) ?? null;
  const activeControlState: TerminalControlState = activeTask ? stateOf(activeTask) : "stopped";
  const activePorts = activeTask ? (ports[activeTask.id] ?? []) : [];

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-terminal">
      {/* Cursor 式顶栏：工作区信息压成一行，Tab 用间距而非竖线分隔 */}
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-background px-3">
        <span className="truncate text-sm text-foreground">{workspace?.name}</span>
        <span className="max-w-48 truncate font-mono text-2xs text-muted-foreground" title={workspace?.branch}>
          {workspace?.branch}
        </span>
        <div className="ml-auto flex items-center gap-1">
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
      </header>

      <div className="flex h-9 shrink-0 items-center gap-0.5 overflow-hidden border-b border-border bg-background px-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {workspaceTasks.map((task) => {
            const state = stateOf(task);
            const isActive = task.id === activeTaskId;
            const taskPorts = ports[task.id] ?? [];
            return (
              <div
                key={task.id}
                className={cn(
                  "group flex h-7 max-w-52 shrink-0 items-center rounded-md text-sm transition-colors",
                  isActive ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
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
                  {taskPorts.length > 0 ? <span className="ml-0.5 font-mono text-2xs text-muted-foreground">:{taskPorts[0].port}</span> : null}
                </button>
                <button
                  className="mr-0.5 flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground/50 opacity-0 transition-all hover:bg-muted hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
                  onClick={() => onCloseTask(task)}
                  title="关闭终端"
                >
                  <X className="size-3" />
                </button>
              </div>
            );
          })}
        </div>
        <button
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-wait disabled:opacity-50"
          onClick={createTerminal}
          disabled={creating}
          title="新建终端"
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
            active={task.id === activeTaskId}
            controlState={controlStates[task.id] ?? (task.status === TaskStatus.RUNNING ? "attaching" : "stopped")}
            registerSessionConsumer={client.registerSessionConsumer}
            sendInput={client.sendInput}
            sendResize={(sessionId, cols, rows) => client.send({ case: "ptyResize", value: { sessionId, cols, rows } })}
            onReady={handleTerminalReady}
            onDispose={handleTerminalDispose}
            onSessionReady={handleSessionReady}
            onOutput={handleOutput}
          />
        ))}

        {workspaceTasks.length === 0 ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="flex max-w-sm flex-col items-center text-center">
              <div className="mb-4 flex size-10 items-center justify-center rounded-lg border border-border text-muted-foreground">
                <SquareTerminal className="size-5" />
              </div>
              <h2 className="text-base font-medium text-foreground">这个工作区还没有终端</h2>
              <p className="mt-1.5 text-sm leading-5 text-muted-foreground">创建后会立即启动 shell，并作为一个新 Tab 打开。</p>
              <Button className="mt-5" size="sm" onClick={createTerminal} disabled={creating}>
                {creating ? <LoaderCircle className="animate-spin" /> : <Plus />}
                新建终端
              </Button>
            </div>
          </div>
        ) : null}

        {activeTask && activeControlState === "detached" ? (
          <div className="absolute inset-x-0 top-0 z-10 flex items-center justify-between border-b border-warning/20 bg-warning/10 px-4 py-2 text-xs text-warning backdrop-blur">
            <span className="flex items-center gap-2">
              <Unplug className="size-3.5" />
              此终端已被其它客户端接管，当前输入已锁定。
            </span>
            <Button
              variant="outline"
              size="sm"
              className="h-7 border-warning/30 text-warning hover:bg-warning/10"
              onClick={() => requestActivation(activeTask.id, true)}
            >
              重新接管
            </Button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
