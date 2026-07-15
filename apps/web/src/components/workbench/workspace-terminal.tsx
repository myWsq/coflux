import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, untrack } from "solid-js";
import { createStore } from "solid-js/store";
import { ExternalLink, LoaderCircle, Plus, SquareTerminal, Unplug, X } from "lucide-solid";
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

export function WorkspaceTerminal(props: WorkspaceTerminalProps) {
  const client = props.client;
  const workspace = createMemo(() => client.workspaces().find((item) => item.id === props.workspaceId));
  const workspaceTasks = createMemo(() =>
    client
      .tasks()
      .filter((task) => task.workspaceId === props.workspaceId)
      .sort((left, right) => left.createdAt - right.createdAt),
  );
  const taskIds = createMemo(() => workspaceTasks().map((task) => task.id));

  const [activeTaskId, setActiveTaskId] = createSignal<string | null>(null);
  const [controlStates, setControlStates] = createStore<Record<string, TerminalControlState>>({});
  const [creating, setCreating] = createSignal(false);

  // 接管状态机的非响应式内部账本：只驱动副作用，不驱动渲染。
  const controllers = new Map<string, TerminalController>();
  const sessionReady = new Map<string, string>(); // taskId -> 已注册 consumer 的 sessionId
  const attachedKeys = new Map<string, string>(); // taskId -> attach 去重 key
  const attachTimers = new Map<string, number>();
  let attachSequence = 0;
  const launchingTaskIds = new Set<string>(); // 自己发起启动（非 attach）的任务
  const activationRequests = new Set<string>();
  const forcedClaims = new Set<string>();
  let pendingCreate: { knownTaskIds: Set<string> } | null = null;

  const currentTasks = () => untrack(workspaceTasks);

  function updateControlState(taskId: string, state: TerminalControlState) {
    if (controlStates[taskId] === state) return;
    setControlStates(taskId, state);
  }

  function clearAttachTimer(taskId: string) {
    const timer = attachTimers.get(taskId);
    if (timer !== undefined) window.clearTimeout(timer);
    attachTimers.delete(taskId);
  }

  // 拿到控制权后必须 fit + focus + ptyResize：把本端尺寸推给 PTY，
  // 否则远端 PTY 保持上一个 holder 的尺寸导致排版错乱。
  function markOwned(taskId: string, sessionId: string) {
    const task = currentTasks().find((item) => item.id === taskId);
    if (!task || task.status !== TaskStatus.RUNNING || task.sessionId !== sessionId) return;
    if (controlStates[taskId] === "detached") return;
    clearAttachTimer(taskId);
    updateControlState(taskId, "owned");
    if (untrack(activeTaskId) === taskId) {
      const controller = controllers.get(taskId);
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
    if (sessionReady.get(task.id) !== task.sessionId) return;
    const attachKey = force
      ? `claim:${++attachSequence}:${task.sessionId}`
      : `${untrack(client.snapshotRevision)}:${task.sessionId}`;
    if (!force && attachedKeys.get(task.id) === attachKey) return;

    attachedKeys.set(task.id, attachKey);
    updateControlState(task.id, "attaching");
    const { cols, rows } = controller.dimensions();
    client.startTask(task.id, cols, rows);
    clearAttachTimer(task.id);
    attachSequence += 1;
    const timer = window.setTimeout(() => {
      if (controlStates[task.id] === "attaching") markOwned(task.id, task.sessionId!);
    }, ATTACH_GRACE_MS);
    attachTimers.set(task.id, timer);
  }

  function performActivation(taskId: string) {
    const task = currentTasks().find((item) => item.id === taskId);
    const controller = controllers.get(taskId);
    if (!task || !controller) return;

    controller.fit();
    controller.focus();
    if (task.status === TaskStatus.RUNNING && task.sessionId) {
      if (sessionReady.get(taskId) !== task.sessionId) return;
      activationRequests.delete(taskId);
      const force = forcedClaims.delete(taskId) || controlStates[taskId] === "detached";
      beginAttach(task, controller, force);
      return;
    }

    activationRequests.delete(taskId);
    forcedClaims.delete(taskId);
    if (launchingTaskIds.has(taskId)) return;
    // EXITED 任务重启前 reset 终端，避免旧输出与新会话混叠。
    if (task.status === TaskStatus.EXITED) controller.reset();
    launchingTaskIds.add(taskId);
    updateControlState(taskId, "attaching");
    const { cols, rows } = controller.dimensions();
    client.startTask(taskId, cols, rows);
  }

  function requestActivation(taskId: string, forceClaim = false) {
    setActiveTaskId(taskId);
    activationRequests.add(taskId);
    if (forceClaim) forcedClaims.add(taskId);
    requestAnimationFrame(() => performActivation(taskId));
  }

  function handleTerminalReady(taskId: string, controller: TerminalController) {
    controllers.set(taskId, controller);
    if (activationRequests.has(taskId)) performActivation(taskId);
  }

  function handleTerminalDispose(taskId: string, controller: TerminalController) {
    if (controllers.get(taskId) === controller) controllers.delete(taskId);
    sessionReady.delete(taskId);
    clearAttachTimer(taskId);
  }

  // 新建启动 vs attach 区分：自己发起启动的任务在 session 就绪后直接 markOwned，
  // 不再发第二次 taskStart。
  function handleSessionReady(taskId: string, sessionId: string, controller: TerminalController) {
    sessionReady.set(taskId, sessionId);
    const task = currentTasks().find((item) => item.id === taskId);
    if (!task || task.sessionId !== sessionId || task.status !== TaskStatus.RUNNING) return;

    if (launchingTaskIds.delete(taskId)) {
      attachedKeys.set(taskId, `${untrack(client.snapshotRevision)}:${sessionId}`);
      markOwned(taskId, sessionId);
    } else {
      beginAttach(task, controller, false);
    }
    if (activationRequests.has(taskId)) performActivation(taskId);
  }

  function handleOutput(taskId: string, sessionId: string) {
    if (controlStates[taskId] === "attaching") markOwned(taskId, sessionId);
  }

  // taskCreate 无请求-响应关联：靠"快照增量中新出现的未知 task id"识别自己创建的任务。
  function createTerminal() {
    if (pendingCreate) return;
    pendingCreate = { knownTaskIds: new Set(currentTasks().map((task) => task.id)) };
    setCreating(true);
    client.send({ case: "taskCreate", value: { workspaceId: props.workspaceId, title: `终端 ${currentTasks().length + 1}` } });
  }

  createEffect(
    on(workspaceTasks, (tasks) => {
      const ids = new Set(tasks.map((task) => task.id));
      for (const taskId of [...attachedKeys.keys()]) {
        if (!ids.has(taskId)) {
          attachedKeys.delete(taskId);
          sessionReady.delete(taskId);
          launchingTaskIds.delete(taskId);
          activationRequests.delete(taskId);
          forcedClaims.delete(taskId);
          clearAttachTimer(taskId);
        }
      }

      for (const task of tasks) {
        if (task.status !== TaskStatus.RUNNING) {
          attachedKeys.delete(task.id);
          sessionReady.delete(task.id);
          if (!launchingTaskIds.has(task.id)) updateControlState(task.id, "stopped");
        }
      }

      if (pendingCreate) {
        const created = tasks.find((task) => !pendingCreate!.knownTaskIds.has(task.id));
        if (created) {
          pendingCreate = null;
          setCreating(false);
          requestActivation(created.id);
        }
      }

      const currentActive = untrack(activeTaskId);
      if (currentActive && ids.has(currentActive)) return;
      const nextTask = tasks[0];
      if (nextTask) requestActivation(nextTask.id);
      else setActiveTaskId(null);
    }),
  );

  // taskDetached 广播：被他端接管 → 置 detached、清 attach key、终端内写系统提示行。
  // 重新接管走 force claim（Tab 点击或横幅按钮）。
  createEffect(
    on(client.detachedTaskIds, (detachedIds) => {
      for (const taskId of detachedIds) {
        const task = currentTasks().find((item) => item.id === taskId);
        if (!task || controlStates[taskId] === "detached") continue;
        clearAttachTimer(taskId);
        attachedKeys.delete(taskId);
        updateControlState(taskId, "detached");
        controllers.get(taskId)?.writeSystem("控制权已被其它客户端接管，点击此 Tab 可重新接管");
      }
    }),
  );

  // snapshotRevision 变更 = 重连/重登：server 侧旧连接的 holder 已失效，
  // 必须对所有 RUNNING 任务重新 beginAttach 重新申请 holder，否则变成只读观众。
  createEffect(
    on(client.snapshotRevision, (revision) => {
      if (revision === 0) return;
      const frame = requestAnimationFrame(() => {
        for (const task of currentTasks()) {
          const controller = controllers.get(task.id);
          if (task.status === TaskStatus.RUNNING && task.sessionId && controller && sessionReady.get(task.id) === task.sessionId) {
            beginAttach(task, controller, false);
          }
        }
      });
      onCleanup(() => cancelAnimationFrame(frame));
    }),
  );

  // error 消息到达时清 pending 创建态与 launching 态（taskCreate/taskStart 失败兜底）。
  createEffect(
    on(client.lastError, (error) => {
      if (!error) return;
      if (pendingCreate) {
        pendingCreate = null;
        setCreating(false);
      }
      for (const taskId of launchingTaskIds) updateControlState(taskId, "stopped");
      launchingTaskIds.clear();
    }),
  );

  onCleanup(() => {
    for (const timer of attachTimers.values()) window.clearTimeout(timer);
    attachTimers.clear();
  });

  const stateOf = (task: Task): TerminalControlState =>
    controlStates[task.id] ?? (task.status === TaskStatus.RUNNING ? "attaching" : "stopped");

  const activeTask = createMemo(() => workspaceTasks().find((task) => task.id === activeTaskId()) ?? null);
  const activeControl = (): TerminalControlState => {
    const task = activeTask();
    return task ? stateOf(task) : "stopped";
  };
  const activePorts = () => {
    const task = activeTask();
    return task ? client.ports()[task.id] ?? [] : [];
  };

  return (
    <section class="flex min-w-0 flex-1 flex-col bg-terminal">
      {/* Cursor 式顶栏：工作区信息压成一行，Tab 用间距而非竖线分隔 */}
      <header class="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-background px-3">
        <span class="truncate text-[12px] text-foreground">{workspace()?.name}</span>
        <span class="max-w-48 truncate font-mono text-[10px] text-muted-foreground" title={workspace()?.branch}>
          {workspace()?.branch}
        </span>
        <div class="ml-auto flex items-center gap-1">
          <For each={activePorts()}>
            {(preview) => (
              <a
                href={preview.url}
                target="_blank"
                rel="noreferrer"
                class="inline-flex h-5 items-center gap-1 rounded px-1.5 font-mono text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                :{preview.port}
                <ExternalLink class="size-2.5" />
              </a>
            )}
          </For>
        </div>
      </header>

      <div class="flex h-9 shrink-0 items-center gap-0.5 overflow-hidden border-b border-border bg-background px-1.5">
        <div class="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <For each={workspaceTasks()}>
            {(task) => {
              const state = () => stateOf(task);
              const isActive = () => task.id === activeTaskId();
              const taskPorts = () => client.ports()[task.id] ?? [];
              return (
                <div
                  class={cn(
                    "group flex h-7 max-w-52 shrink-0 items-center rounded-md text-[12px] transition-colors",
                    isActive() ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                  )}
                >
                  <button
                    class="flex min-w-0 flex-1 items-center gap-1.5 self-stretch px-2.5 text-left"
                    onClick={() => requestActivation(task.id, state() === "detached")}
                    title={state() === "detached" ? `${task.title}（已被接管，点击重新接管）` : task.title}
                  >
                    {state() === "attaching" ? (
                      <LoaderCircle class="size-3 shrink-0 animate-spin text-muted-foreground" />
                    ) : state() === "detached" ? (
                      <Unplug class="size-3 shrink-0 text-warning" />
                    ) : (
                      <SquareTerminal class={cn("size-3 shrink-0", isActive() ? "opacity-90" : "opacity-50")} />
                    )}
                    <span class="truncate">{task.title || "终端"}</span>
                    <Show when={taskPorts().length > 0}>
                      <span class="ml-0.5 font-mono text-[9px] text-muted-foreground">:{taskPorts()[0].port}</span>
                    </Show>
                  </button>
                  <button
                    class="mr-0.5 flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground/50 opacity-0 transition-all hover:bg-muted hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
                    onClick={() => props.onCloseTask(task)}
                    title="关闭终端"
                  >
                    <X class="size-3" />
                  </button>
                </div>
              );
            }}
          </For>
        </div>
        <button
          class="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-wait disabled:opacity-50"
          onClick={createTerminal}
          disabled={creating()}
          title="新建终端"
        >
          {creating() ? <LoaderCircle class="size-3.5 animate-spin" /> : <Plus class="size-3.5" />}
        </button>
      </div>

      <div class="relative min-h-0 flex-1 bg-terminal">
        {/* 面板按 taskId 建立稳定身份：任务实体更新不重建 xterm（重建会丢 scrollback）。 */}
        <For each={taskIds()}>
          {(taskId) => {
            const task = () => workspaceTasks().find((item) => item.id === taskId);
            return (
              <TerminalPane
                taskId={taskId}
                sessionId={task()?.sessionId ?? null}
                active={taskId === activeTaskId()}
                controlState={controlStates[taskId] ?? (task()?.status === TaskStatus.RUNNING ? "attaching" : "stopped")}
                registerSessionConsumer={client.registerSessionConsumer}
                sendInput={client.sendInput}
                sendResize={(sessionId, cols, rows) => client.send({ case: "ptyResize", value: { sessionId, cols, rows } })}
                onReady={handleTerminalReady}
                onDispose={handleTerminalDispose}
                onSessionReady={handleSessionReady}
                onOutput={handleOutput}
              />
            );
          }}
        </For>

        <Show when={workspaceTasks().length === 0}>
          <div class="absolute inset-0 flex items-center justify-center">
            <div class="flex max-w-sm flex-col items-center text-center">
              <div class="mb-4 flex size-10 items-center justify-center rounded-lg border border-border text-muted-foreground">
                <SquareTerminal class="size-5" />
              </div>
              <h2 class="text-[13px] font-medium text-foreground">这个工作区还没有终端</h2>
              <p class="mt-1.5 text-[12px] leading-5 text-muted-foreground">创建后会立即启动 shell，并作为一个新 Tab 打开。</p>
              <Button class="mt-5" size="sm" onClick={createTerminal} disabled={creating()}>
                {creating() ? <LoaderCircle class="animate-spin" /> : <Plus />}
                新建终端
              </Button>
            </div>
          </div>
        </Show>

        <Show when={activeTask() && activeControl() === "detached"}>
          <div class="absolute inset-x-0 top-0 z-10 flex items-center justify-between border-b border-warning/20 bg-warning/10 px-4 py-2 text-xs text-warning backdrop-blur">
            <span class="flex items-center gap-2">
              <Unplug class="size-3.5" />
              此终端已被其它客户端接管，当前输入已锁定。
            </span>
            <Button
              variant="outline"
              size="sm"
              class="h-7 border-warning/30 text-warning hover:bg-warning/10"
              onClick={() => requestActivation(activeTask()!.id, true)}
            >
              重新接管
            </Button>
          </div>
        </Show>
      </div>
    </section>
  );
}
