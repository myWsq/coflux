import { useEffect, useRef, useState } from "react";
import { ExternalLink, LoaderCircle, Plus, SquareTerminal, Unplug, X } from "lucide-react";
import type { Task, Workspace } from "@coflux/protocol";

import { Button } from "@/components/ui/button";
import type { CofluxClient } from "@/hooks/use-coflux-client";
import { cn } from "@/lib/utils";
import {
  TerminalPane,
  type TerminalController,
  type TerminalControlState,
} from "@/components/workbench/terminal-pane";

const ATTACH_GRACE_MS = 500;

type WorkspaceTerminalProps = {
  workspace: Workspace;
  client: CofluxClient;
  onCloseTask: (task: Task) => void;
};

function statusColor(task: Task, controlState: TerminalControlState) {
  if (controlState === "detached") return "bg-warning";
  if (controlState === "attaching") return "bg-ring";
  if (task.status === "running") return "bg-success";
  if (task.status === "exited") return "bg-destructive/80";
  return "bg-muted-foreground/55";
}

export function WorkspaceTerminal({ workspace, client, onCloseTask }: WorkspaceTerminalProps) {
  const workspaceTasks = client.tasks
    .filter((task) => task.workspaceId === workspace.id)
    .sort((left, right) => left.createdAt - right.createdAt);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [controlStates, setControlStates] = useState<Record<string, TerminalControlState>>({});
  const [creating, setCreating] = useState(false);

  const tasksRef = useRef(workspaceTasks);
  const activeTaskIdRef = useRef(activeTaskId);
  const controlStatesRef = useRef(controlStates);
  const detachedTaskIdsRef = useRef(client.detachedTaskIds);
  const snapshotRevisionRef = useRef(client.snapshotRevision);
  const controllersRef = useRef(new Map<string, TerminalController>());
  const sessionReadyRef = useRef(new Map<string, string>());
  const attachedKeysRef = useRef(new Map<string, string>());
  const attachTimersRef = useRef(new Map<string, number>());
  const attachSequenceRef = useRef(0);
  const launchingTaskIdsRef = useRef(new Set<string>());
  const activationRequestsRef = useRef(new Set<string>());
  const forcedClaimsRef = useRef(new Set<string>());
  const pendingCreateRef = useRef<{ knownTaskIds: Set<string> } | null>(null);

  tasksRef.current = workspaceTasks;
  activeTaskIdRef.current = activeTaskId;
  controlStatesRef.current = controlStates;
  detachedTaskIdsRef.current = client.detachedTaskIds;
  snapshotRevisionRef.current = client.snapshotRevision;

  function updateControlState(taskId: string, state: TerminalControlState) {
    if (controlStatesRef.current[taskId] === state) return;
    const next = { ...controlStatesRef.current, [taskId]: state };
    controlStatesRef.current = next;
    setControlStates(next);
  }

  function clearAttachTimer(taskId: string) {
    const timer = attachTimersRef.current.get(taskId);
    if (timer !== undefined) window.clearTimeout(timer);
    attachTimersRef.current.delete(taskId);
  }

  function markOwned(taskId: string, sessionId: string) {
    const task = tasksRef.current.find((item) => item.id === taskId);
    if (!task || task.status !== "running" || task.sessionId !== sessionId) return;
    if (controlStatesRef.current[taskId] === "detached") return;
    clearAttachTimer(taskId);
    updateControlState(taskId, "owned");
    if (activeTaskIdRef.current === taskId) {
      const controller = controllersRef.current.get(taskId);
      if (!controller) return;
      controller.fit();
      controller.focus();
      const { cols, rows } = controller.dimensions();
      client.send({ type: "pty.resize", sessionId, cols, rows });
    }
  }

  function beginAttach(task: Task, controller: TerminalController, force = false) {
    if (task.status !== "running" || !task.sessionId) return;
    if (sessionReadyRef.current.get(task.id) !== task.sessionId) return;
    const attachKey = force
      ? `claim:${++attachSequenceRef.current}:${task.sessionId}`
      : `${snapshotRevisionRef.current}:${task.sessionId}`;
    if (!force && attachedKeysRef.current.get(task.id) === attachKey) return;

    attachedKeysRef.current.set(task.id, attachKey);
    updateControlState(task.id, "attaching");
    const { cols, rows } = controller.dimensions();
    client.startTask(task.id, cols, rows);
    clearAttachTimer(task.id);
    const sequence = ++attachSequenceRef.current;
    const timer = window.setTimeout(() => {
      if (attachSequenceRef.current < sequence) return;
      if (controlStatesRef.current[task.id] === "attaching") markOwned(task.id, task.sessionId!);
    }, ATTACH_GRACE_MS);
    attachTimersRef.current.set(task.id, timer);
  }

  function performActivation(taskId: string) {
    const task = tasksRef.current.find((item) => item.id === taskId);
    const controller = controllersRef.current.get(taskId);
    if (!task || !controller) return;

    controller.fit();
    controller.focus();
    if (task.status === "running" && task.sessionId) {
      if (sessionReadyRef.current.get(taskId) !== task.sessionId) return;
      activationRequestsRef.current.delete(taskId);
      const force = forcedClaimsRef.current.delete(taskId) || controlStatesRef.current[taskId] === "detached";
      beginAttach(task, controller, force);
      return;
    }

    activationRequestsRef.current.delete(taskId);
    forcedClaimsRef.current.delete(taskId);
    if (launchingTaskIdsRef.current.has(taskId)) return;
    if (task.status === "exited") controller.reset();
    launchingTaskIdsRef.current.add(taskId);
    updateControlState(taskId, "attaching");
    const { cols, rows } = controller.dimensions();
    client.startTask(taskId, cols, rows);
  }

  function requestActivation(taskId: string, forceClaim = false) {
    activeTaskIdRef.current = taskId;
    setActiveTaskId(taskId);
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
    const task = tasksRef.current.find((item) => item.id === taskId);
    if (!task || task.sessionId !== sessionId || task.status !== "running") return;

    if (launchingTaskIdsRef.current.delete(taskId)) {
      attachedKeysRef.current.set(taskId, `${snapshotRevisionRef.current}:${sessionId}`);
      markOwned(taskId, sessionId);
    } else {
      beginAttach(task, controller, false);
    }
    if (activationRequestsRef.current.has(taskId)) performActivation(taskId);
  }

  function handleOutput(taskId: string, sessionId: string) {
    if (controlStatesRef.current[taskId] === "attaching") markOwned(taskId, sessionId);
  }

  function createTerminal() {
    if (pendingCreateRef.current) return;
    pendingCreateRef.current = { knownTaskIds: new Set(tasksRef.current.map((task) => task.id)) };
    setCreating(true);
    client.send({ type: "task.create", workspaceId: workspace.id, title: `终端 ${tasksRef.current.length + 1}` });
  }

  useEffect(() => {
    const taskIds = new Set(workspaceTasks.map((task) => task.id));
    for (const taskId of [...attachedKeysRef.current.keys()]) {
      if (!taskIds.has(taskId)) {
        attachedKeysRef.current.delete(taskId);
        sessionReadyRef.current.delete(taskId);
        launchingTaskIdsRef.current.delete(taskId);
        activationRequestsRef.current.delete(taskId);
        forcedClaimsRef.current.delete(taskId);
        clearAttachTimer(taskId);
      }
    }

    for (const task of workspaceTasks) {
      if (task.status !== "running") {
        attachedKeysRef.current.delete(task.id);
        sessionReadyRef.current.delete(task.id);
        if (!launchingTaskIdsRef.current.has(task.id)) updateControlState(task.id, "stopped");
      }
    }

    const pending = pendingCreateRef.current;
    if (pending) {
      const created = workspaceTasks.find((task) => !pending.knownTaskIds.has(task.id));
      if (created) {
        pendingCreateRef.current = null;
        setCreating(false);
        requestActivation(created.id);
      }
    }

    if (activeTaskIdRef.current && taskIds.has(activeTaskIdRef.current)) return;
    const nextTask = workspaceTasks[0];
    if (nextTask) requestActivation(nextTask.id);
    else {
      activeTaskIdRef.current = null;
      setActiveTaskId(null);
    }
  }, [client.tasks, workspace.id]);

  useEffect(() => {
    for (const taskId of client.detachedTaskIds) {
      const task = tasksRef.current.find((item) => item.id === taskId);
      if (!task || controlStatesRef.current[taskId] === "detached") continue;
      clearAttachTimer(taskId);
      attachedKeysRef.current.delete(taskId);
      updateControlState(taskId, "detached");
      controllersRef.current.get(taskId)?.writeSystem("控制权已被其它客户端接管，点击此 Tab 可重新接管");
    }
  }, [client.detachedTaskIds]);

  useEffect(() => {
    if (client.snapshotRevision === 0) return;
    const frame = requestAnimationFrame(() => {
      for (const task of tasksRef.current) {
        const controller = controllersRef.current.get(task.id);
        if (task.status === "running" && task.sessionId && controller && sessionReadyRef.current.get(task.id) === task.sessionId) {
          beginAttach(task, controller, false);
        }
      }
    });
    return () => cancelAnimationFrame(frame);
    // 每份 snapshot 代表一次登录或重连后的最新会话视图，需要重新申请 holder。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client.snapshotRevision]);

  useEffect(() => {
    if (!client.lastError) return;
    if (pendingCreateRef.current) {
      pendingCreateRef.current = null;
      setCreating(false);
    }
    for (const taskId of launchingTaskIdsRef.current) updateControlState(taskId, "stopped");
    launchingTaskIdsRef.current.clear();
  }, [client.lastError]);

  useEffect(
    () => () => {
      for (const timer of attachTimersRef.current.values()) window.clearTimeout(timer);
      attachTimersRef.current.clear();
    },
    [],
  );

  const activeTask = workspaceTasks.find((task) => task.id === activeTaskId) ?? null;
  const activeControl = activeTask ? controlStates[activeTask.id] ?? (activeTask.status === "running" ? "attaching" : "stopped") : "stopped";
  const activePorts = activeTask ? client.ports[activeTask.id] ?? [] : [];

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-terminal">
      <header className="flex h-11 shrink-0 items-center gap-3 border-b border-border bg-background px-4">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-foreground">{workspace.name}</div>
        </div>
        <span className="max-w-64 truncate rounded bg-muted px-2 py-0.5 font-mono text-[10px] text-muted-foreground" title={workspace.branch}>
          {workspace.branch}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          {activePorts.map((preview) => (
            <a
              key={preview.port}
              href={preview.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-6 items-center gap-1 rounded border border-border bg-muted/60 px-2 font-mono text-[10px] text-muted-foreground transition-colors hover:border-ring/50 hover:text-foreground"
            >
              :{preview.port}
              <ExternalLink className="size-3" />
            </a>
          ))}
        </div>
      </header>

      <div className="flex h-10 shrink-0 items-stretch overflow-hidden border-b border-border bg-sidebar">
        <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {workspaceTasks.map((task) => {
            const state = controlStates[task.id] ?? (task.status === "running" ? "attaching" : "stopped");
            const isActive = task.id === activeTaskId;
            return (
              <div
                key={task.id}
                className={cn(
                  "group flex min-w-36 max-w-60 shrink-0 items-center border-r border-border text-xs transition-colors",
                  isActive ? "bg-terminal text-foreground" : "bg-sidebar text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                )}
              >
                <button
                  className="flex min-w-0 flex-1 items-center gap-2 self-stretch px-3 text-left"
                  onClick={() => requestActivation(task.id, state === "detached")}
                  title={state === "detached" ? `${task.title}（已被接管，点击重新接管）` : task.title}
                >
                  {state === "attaching" ? (
                    <LoaderCircle className="size-3.5 shrink-0 animate-spin text-ring" />
                  ) : state === "detached" ? (
                    <Unplug className="size-3.5 shrink-0 text-warning" />
                  ) : (
                    <span className={cn("size-1.5 shrink-0 rounded-full", statusColor(task, state))} />
                  )}
                  <span className="truncate">{task.title || "终端"}</span>
                  {(client.ports[task.id] ?? []).length > 0 && (
                    <span className="ml-auto rounded bg-muted px-1.5 font-mono text-[9px] text-muted-foreground">
                      :{client.ports[task.id][0].port}
                    </span>
                  )}
                </button>
                <button
                  className="mr-1 flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground/60 opacity-0 transition-all hover:bg-accent hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
                  onClick={() => onCloseTask(task)}
                  title="关闭终端"
                >
                  <X className="size-3.5" />
                </button>
              </div>
            );
          })}
        </div>
        <button
          className="flex w-10 shrink-0 items-center justify-center border-l border-border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-wait disabled:opacity-50"
          onClick={createTerminal}
          disabled={creating}
          title="新建终端"
        >
          {creating ? <LoaderCircle className="size-4 animate-spin" /> : <Plus className="size-4" />}
        </button>
      </div>

      <div className="relative min-h-0 flex-1 bg-terminal">
        {workspaceTasks.map((task) => (
          <TerminalPane
            key={task.id}
            taskId={task.id}
            sessionId={task.sessionId}
            active={task.id === activeTaskId}
            controlState={controlStates[task.id] ?? (task.status === "running" ? "attaching" : "stopped")}
            registerSessionConsumer={client.registerSessionConsumer}
            sendInput={client.sendInput}
            sendResize={(sessionId, cols, rows) => client.send({ type: "pty.resize", sessionId, cols, rows })}
            onReady={handleTerminalReady}
            onDispose={handleTerminalDispose}
            onSessionReady={handleSessionReady}
            onOutput={handleOutput}
          />
        ))}

        {workspaceTasks.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="flex max-w-sm flex-col items-center text-center">
              <div className="mb-4 flex size-12 items-center justify-center rounded-xl border border-border bg-card text-muted-foreground shadow-sm">
                <SquareTerminal className="size-6" />
              </div>
              <h2 className="text-sm font-medium text-foreground">这个工作区还没有终端</h2>
              <p className="mt-1.5 text-xs leading-5 text-muted-foreground">创建后会立即启动 shell，并作为一个新 Tab 打开。</p>
              <Button className="mt-5" size="sm" onClick={createTerminal} disabled={creating}>
                {creating ? <LoaderCircle className="animate-spin" /> : <Plus />}
                新建终端
              </Button>
            </div>
          </div>
        )}

        {activeTask && activeControl === "detached" && (
          <div className="absolute inset-x-0 top-0 z-10 flex items-center justify-between border-b border-warning/20 bg-warning/10 px-4 py-2 text-xs text-warning backdrop-blur">
            <span className="flex items-center gap-2"><Unplug className="size-3.5" />此终端已被其它客户端接管，当前输入已锁定。</span>
            <Button variant="outline" size="sm" className="h-7 border-warning/30 text-warning hover:bg-warning/10" onClick={() => requestActivation(activeTask.id, true)}>
              重新接管
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}
