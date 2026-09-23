import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { TaskStatus, type Task } from "@coflux/protocol";

import type { CofluxClient } from "@coflux/client";
import type { TerminalController, TerminalControlState } from "@/components/workbench/terminal-pane";

// attach 后即使无 ptyOutput 回放（空 scrollback）也要在 500ms 后判定 owned；有输出则立即 owned。
const ATTACH_GRACE_MS = 500;

/**
 * 终端接管状态机（plan 104：随终端面板一起从 WorkspaceTerminal 提升到 Workbench 层）。
 *
 * 全部按 task id 记账、不认工作区：终端被搬进别的工作区（TaskUpdated 带新 workspaceId）时，
 * 面板与这里的账本原样留在原地——不重建 xterm、不重新 attach，也不因为某个 task 离开了某个
 * 工作区就去抢那个工作区里别的 Tab 的控制权。
 */
export type TerminalAttach = {
  controlStates: Record<string, TerminalControlState>;
  /** RUNNING 且尚未（且可能永不）发起 attach 的任务（后台面板 / 隐藏工作区 / 旁观页面）
   * 回落为 "idle"：Tab 图标呈中性终端图标，不是永转的 attaching spinner。 */
  stateOf: (task: Task) => TerminalControlState;
  /**
   * A user action on a specific tab (click, shortcut, drop, palette/notification jump, the banner's
   * 重新接管): may force-claim a detached task. Tab selection itself lives in the layout
   * (plan 20260923-terminal-split-groups); this is only the state-machine part.
   */
  requestActivation: (taskId: string, forceClaim?: boolean) => void;
  /**
   * A pane became visible without the user choosing that tab (overlay closed, workspace switch,
   * a background group's fallback, a restored layout): fit, then attach without forcing. A detached
   * task stays detached — taking it back needs a user action. Never moves keyboard focus.
   */
  ensureVisible: (taskId: string) => void;
  /** Keyboard focus to a pane (next frame). Only the focused group's active pane is ever passed here. */
  focusTask: (taskId: string) => void;
  /** 横幅「重新打开」（plan 097）：在同一个 Tab 里起新 shell。 */
  reopenTask: (taskId: string) => void;
  /** Panes on screen = the active tab of every group of the selected workspace while the changes
   * overlay is closed. The attach gate reads it, so Workbench writes it synchronously during render
   * and in every layout commit (the same synchronous-read contract as before, now a set). */
  setVisibleTaskIds: (taskIds: ReadonlySet<string>) => void;
  handleTerminalReady: (taskId: string, controller: TerminalController) => void;
  handleTerminalDispose: (taskId: string, controller: TerminalController) => void;
  handleSessionReady: (taskId: string, sessionId: string, controller: TerminalController) => void;
  handleOutput: (taskId: string, sessionId: string) => void;
};

export function useTerminalAttach(client: CofluxClient, { tasks }: { tasks: readonly Task[] }): TerminalAttach {
  const detachedTaskIds = useStore(client.store, (state) => state.detachedTaskIds);
  const lastError = useStore(client.store, (state) => state.lastError);

  const [controlStates, setControlStatesState] = useState<Record<string, TerminalControlState>>({});

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
  // Panes that became visible on their own and still wait for a controller (the pane layer is lazy).
  const visibleRequestsRef = useRef(new Set<string>());
  const forcedClaimsRef = useRef(new Set<string>());
  // 已退出终端回放（plan 097）的账本：
  // lastSessionRef：task 最近一次已知的 sessionId（退出时中心会清空 task.sessionId，这里留底）；
  // liveOutputRef：本面板收到过输出的 sessionId（「看着它退出」的判据——画面已是全量滚屏，只追加提示不清屏）；
  // historyShownRef：已回放或已写退出提示的那一轮退出（按 task.updatedAt），同一轮不重复请求；
  // lastStatusRef：上一次看到的状态，用于识别 RUNNING→EXITED 的瞬间。
  const lastSessionRef = useRef(new Map<string, string>());
  const liveOutputRef = useRef(new Map<string, string>());
  const historyShownRef = useRef(new Map<string, number>());
  const lastStatusRef = useRef(new Map<string, TaskStatus>());

  // controlStates 的同步镜像：imperative 函数需要在 setState 后立即读到"当下"值
  // （对应 Solid 信号的同步读语义），而 React state 变量本身要等下一次渲染才更新，故用 ref 双轨。
  const controlStatesRef = useRef<Record<string, TerminalControlState>>({});
  // 可见面板集合的同步镜像：可见性由 Workbench 判定（选中工作区 + 每个分组的活动 Tab + 变更覆盖层关着），
  // 这里的回调由子组件 effect 在任意渲染代触发，直接闭包捕获会读到过期值（landmine），一律经它读。
  const visibleTaskIdsRef = useRef<ReadonlySet<string>>(new Set());

  function setVisibleTaskIds(taskIds: ReadonlySet<string>) {
    visibleTaskIdsRef.current = taskIds;
  }

  function isVisible(taskId: string): boolean {
    return visibleTaskIdsRef.current.has(taskId);
  }

  // untrack(tasks) 的对应物：直接读 store 当下状态，不经由本次渲染闭包捕获的 tasks（可能已过期）。
  function currentTask(taskId: string): Task | undefined {
    return client.store.getState().tasks.find((task) => task.id === taskId);
  }

  function updateControlState(taskId: string, state: TerminalControlState) {
    if (controlStatesRef.current[taskId] === state) return;
    const next = { ...controlStatesRef.current, [taskId]: state };
    controlStatesRef.current = next;
    setControlStatesState(next);
  }

  function clearAttachTimer(taskId: string) {
    const timer = attachTimersRef.current.get(taskId);
    if (timer !== undefined) window.clearTimeout(timer);
    attachTimersRef.current.delete(taskId);
  }

  // 拿到控制权后必须 fit + ptyResize：把本端尺寸推给 PTY，否则远端 PTY 保持上一个 holder 的尺寸导致排版错乱。
  // Never focus here: with several panes on screen an attach completing in a background group would
  // steal the caret from the group the user is typing in.
  function markOwned(taskId: string, sessionId: string) {
    const task = currentTask(taskId);
    if (!task || task.status !== TaskStatus.RUNNING || task.sessionId !== sessionId) return;
    if (controlStatesRef.current[taskId] === "detached") return;
    clearAttachTimer(taskId);
    updateControlState(taskId, "owned");
    if (isVisible(taskId)) {
      const controller = controllersRef.current.get(taskId);
      if (!controller) return;
      controller.fit();
      const { cols, rows } = controller.dimensions();
      client.resizeSession(sessionId, cols, rows);
    }
  }

  // DeviceRouter 自行处理 direct/relay generation 迁移；只按 session 去重用户级 attach。
  // 强制接管用递增序列 key 绕过去重，且显式传给 router 清除 detached 门闩。
  function beginAttach(task: Task, controller: TerminalController, force = false) {
    if (task.status !== TaskStatus.RUNNING || !task.sessionId) return;
    if (sessionReadyRef.current.get(task.id) !== task.sessionId) return;
    const attachKey = force
      ? `claim:${++attachSequenceRef.current}:${task.sessionId}`
      : `session:${task.sessionId}`;
    if (!force && attachedKeysRef.current.get(task.id) === attachKey) return;

    attachedKeysRef.current.set(task.id, attachKey);
    updateControlState(task.id, "attaching");
    const { cols, rows } = controller.dimensions();
    client.startTask(task.id, cols, rows, force);
    clearAttachTimer(task.id);
    attachSequenceRef.current += 1;
    const timer = window.setTimeout(() => {
      if (controlStatesRef.current[task.id] === "attaching") markOwned(task.id, task.sessionId!);
    }, ATTACH_GRACE_MS);
    attachTimersRef.current.set(task.id, timer);
  }

  /**
   * `user`: a user action on this tab — a detached task is force-claimed back.
   * `visible`: the pane merely became visible — never forces, and leaves a detached task alone
   * (two clients showing the same grid would otherwise steal every pane back on every switch).
   * Neither moves keyboard focus.
   */
  function performActivation(taskId: string, mode: "user" | "visible") {
    const task = currentTask(taskId);
    const controller = controllersRef.current.get(taskId);
    if (!task || !controller) return;

    controller.fit();
    if (task.status === TaskStatus.RUNNING && task.sessionId) {
      if (sessionReadyRef.current.get(taskId) !== task.sessionId) return;
      if (mode === "user") {
        activationRequestsRef.current.delete(taskId);
        const force = forcedClaimsRef.current.delete(taskId) || controlStatesRef.current[taskId] === "detached";
        // 不可见的面板一律不申请控制权：隐藏工作区里"活动 Tab 从列表消失后自动选中另一个 Tab"
        // 也会走到这里——终端被搬去别的工作区（plan 104）正是这条路，绝不能顺手抢兄弟 Tab 的
        // 控制权；旁观端打开页面同理，否则每个隐藏工作区的第一个任务都会被抢一遍。
        if (isVisible(taskId)) beginAttach(task, controller, force);
        return;
      }
      if (isVisible(taskId) && controlStatesRef.current[taskId] !== "detached") beginAttach(task, controller, false);
      return;
    }

    if (mode === "visible" && activationRequestsRef.current.has(taskId)) return;
    activationRequestsRef.current.delete(taskId);
    forcedClaimsRef.current.delete(taskId);
    if (launchingTaskIdsRef.current.has(taskId)) return;
    // EXITED（plan 097）：回放最后输出，不再悄悄重开 shell——重开是横幅上的显式动作（reopenTask）。
    if (task.status === TaskStatus.EXITED) {
      showExitedHistory(task, controller);
      return;
    }
    // IDLE（刚创建尚未启动）：自动启动，行为不变。
    launchTask(taskId, controller);
  }

  function launchTask(taskId: string, controller: TerminalController) {
    launchingTaskIdsRef.current.add(taskId);
    updateControlState(taskId, "attaching");
    const { cols, rows } = controller.dimensions();
    client.startTask(taskId, cols, rows);
  }

  /** 横幅「重新打开」（plan 097）：在同一个 Tab 里起新 shell。重启前 reset 终端，避免旧输出与新会话混叠。 */
  function reopenTask(taskId: string) {
    const task = currentTask(taskId);
    const controller = controllersRef.current.get(taskId);
    if (!task || !controller || task.status !== TaskStatus.EXITED) return;
    if (launchingTaskIdsRef.current.has(taskId)) return;
    controller.reset();
    launchTask(taskId, controller);
  }

  function exitedNotice(task: Task): { message: string; tone: "success" | "error" | "warning" } {
    if (task.exitCode === undefined) return { message: "进程已退出（退出码未知）", tone: "warning" };
    return { message: `进程已退出（退出码 ${task.exitCode}）`, tone: task.exitCode === 0 ? "success" : "error" };
  }

  /** 回放已退出终端的最后输出（plan 097）。同一轮退出（task.updatedAt）只做一次；面板若亲眼收到过本轮会话的
   * 输出，画面已是全量滚屏，只追加退出提示、不用历史覆盖（历史只是当前画面的子集，覆盖会丢 scrollback）。
   * 其余情况经中心一次 taskRead：log 是命令终端的非 tty 纯文本日志、snapshot/checkpoint 是 ANSI 屏幕。 */
  function showExitedHistory(task: Task, controller: TerminalController) {
    const round = task.updatedAt;
    if (historyShownRef.current.get(task.id) === round) return;
    historyShownRef.current.set(task.id, round);
    const notice = exitedNotice(task);
    const lastSession = lastSessionRef.current.get(task.id);
    if (lastSession && liveOutputRef.current.get(task.id) === lastSession) {
      controller.writeSystem(notice.message, notice.tone);
      return;
    }
    void client.readTask(task.id).then((result) => {
      // 结果晚于「重新打开」到达（task 已 RUNNING 或又换了一轮）或面板已重建时丢弃，不能覆盖新 shell 的画面。
      const current = currentTask(task.id);
      if (!current || current.status !== TaskStatus.EXITED || current.updatedAt !== round) return;
      if (controllersRef.current.get(task.id) !== controller) return;
      controller.reset();
      if (!result.ok) {
        controller.writeSystem(`读取最后输出失败：${result.error}`, "error");
      } else if (result.source !== "none") {
        controller.writeRaw(result.data);
      }
      controller.writeSystem(notice.message, notice.tone);
    });
  }

  function requestActivation(taskId: string, forceClaim = false) {
    activationRequestsRef.current.add(taskId);
    visibleRequestsRef.current.delete(taskId);
    if (forceClaim) forcedClaimsRef.current.add(taskId);
    requestAnimationFrame(() => performActivation(taskId, "user"));
  }

  function ensureVisible(taskId: string) {
    // A user activation for this tab is already queued and will do everything this would, with the
    // right force flag; attaching here as well would send a second, non-forced attach after it.
    if (activationRequestsRef.current.has(taskId)) return;
    if (!controllersRef.current.has(taskId)) {
      visibleRequestsRef.current.add(taskId);
      return;
    }
    requestAnimationFrame(() => {
      if (!isVisible(taskId) || activationRequestsRef.current.has(taskId)) return;
      performActivation(taskId, "visible");
    });
  }

  function focusTask(taskId: string) {
    requestAnimationFrame(() => controllersRef.current.get(taskId)?.focus());
  }

  function handleTerminalReady(taskId: string, controller: TerminalController) {
    controllersRef.current.set(taskId, controller);
    if (activationRequestsRef.current.has(taskId)) {
      performActivation(taskId, "user");
      return;
    }
    if (visibleRequestsRef.current.delete(taskId) && isVisible(taskId)) performActivation(taskId, "visible");
  }

  function handleTerminalDispose(taskId: string, controller: TerminalController) {
    if (controllersRef.current.get(taskId) === controller) controllersRef.current.delete(taskId);
    sessionReadyRef.current.delete(taskId);
    clearAttachTimer(taskId);
  }

  // durable create 完成后仍需做第一次 live attach；startTask 看到 RUNNING task 会走本地 lane，
  // 不会再次请求中心创建。
  function handleSessionReady(taskId: string, sessionId: string, controller: TerminalController) {
    sessionReadyRef.current.set(taskId, sessionId);
    const task = currentTask(taskId);
    if (!task || task.sessionId !== sessionId || task.status !== TaskStatus.RUNNING) return;

    if (launchingTaskIdsRef.current.delete(taskId)) {
      beginAttach(task, controller, false);
    } else if (isVisible(taskId)) {
      // 只有用户正看着这个面板（工作区可见且它是活动 Tab）时才主动申请控制权；
      // 后台面板 / 隐藏工作区 / 旁观页面里的面板不发 taskStart，不抢占对端 holder。
      beginAttach(task, controller, false);
    }
    if (activationRequestsRef.current.has(taskId)) performActivation(taskId, "user");
  }

  function handleOutput(taskId: string, sessionId: string) {
    liveOutputRef.current.set(taskId, sessionId);
    if (controlStatesRef.current[taskId] === "attaching") markOwned(taskId, sessionId);
  }

  function stateOf(task: Task): TerminalControlState {
    return controlStates[task.id] ?? (task.status === TaskStatus.RUNNING ? "idle" : "stopped");
  }

  useEffect(() => {
    const ids = new Set(tasks.map((task) => task.id));
    // 只清理真正从快照消失的 task：换了工作区的 task 仍在这份全量列表里，账本原样保留，
    // 面板既不重建也不重新 attach（plan 104）。
    for (const taskId of [...attachedKeysRef.current.keys()]) {
      if (!ids.has(taskId)) {
        attachedKeysRef.current.delete(taskId);
        sessionReadyRef.current.delete(taskId);
        launchingTaskIdsRef.current.delete(taskId);
        activationRequestsRef.current.delete(taskId);
        visibleRequestsRef.current.delete(taskId);
        forcedClaimsRef.current.delete(taskId);
        clearAttachTimer(taskId);
      }
    }

    for (const taskId of [...lastStatusRef.current.keys()]) {
      if (ids.has(taskId)) continue;
      lastStatusRef.current.delete(taskId);
      lastSessionRef.current.delete(taskId);
      liveOutputRef.current.delete(taskId);
      historyShownRef.current.delete(taskId);
    }

    for (const task of tasks) {
      if (task.sessionId) lastSessionRef.current.set(task.id, task.sessionId);
      const previousStatus = lastStatusRef.current.get(task.id);
      lastStatusRef.current.set(task.id, task.status);
      if (task.status !== TaskStatus.RUNNING) {
        attachedKeysRef.current.delete(task.id);
        sessionReadyRef.current.delete(task.id);
        if (!launchingTaskIdsRef.current.has(task.id)) updateControlState(task.id, "stopped");
      }
      // 看着它退出（plan 097）：RUNNING→EXITED 的瞬间，面板有本轮会话的输出就只追加退出提示；
      // 没收到过输出但正是当前可见面板的，立即回放（之后不会再有激活来触发）。其余留到 Tab 被激活时再回放。
      if (previousStatus === TaskStatus.RUNNING && task.status === TaskStatus.EXITED) {
        const controller = controllersRef.current.get(task.id);
        if (!controller) continue;
        const lastSession = lastSessionRef.current.get(task.id);
        const sawLive = Boolean(lastSession && liveOutputRef.current.get(task.id) === lastSession);
        if (sawLive || isVisible(task.id)) showExitedHistory(task, controller);
      }
    }
    // 只跟踪 tasks（对应 Solid `on(tasks, ...)` 的显式单一依赖），
    // 回调内其余状态一律读 ref/store 当下值，不纳入依赖数组。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks]);

  // Device holder 被他端接管 → 置 detached、清 attach key、终端内写系统提示行。
  // 重新接管走 force claim（Tab 点击或横幅按钮）。
  useEffect(() => {
    for (const taskId of detachedTaskIds) {
      const task = currentTask(taskId);
      if (!task || controlStatesRef.current[taskId] === "detached") continue;
      clearAttachTimer(taskId);
      attachedKeysRef.current.delete(taskId);
      updateControlState(taskId, "detached");
      controllersRef.current.get(taskId)?.writeSystem("控制权已被其它客户端接管，点击此 Tab 可重新接管");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detachedTaskIds]);

  // error 消息到达时清 launching 态（taskStart 失败兜底）；乐观 tab 的收尾仍在工作区容器里。
  useEffect(() => {
    if (!lastError) return;
    for (const taskId of launchingTaskIdsRef.current) updateControlState(taskId, "stopped");
    launchingTaskIdsRef.current.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastError]);

  // The old "workspace became visible → refit and attach" effect is gone: Workbench now diffs the
  // visible set on every commit and calls ensureVisible for each pane that just appeared, which
  // covers workspace switches, the changes overlay closing and background-group fallbacks alike.

  useEffect(() => {
    const timers = attachTimersRef.current;
    return () => {
      for (const timer of timers.values()) window.clearTimeout(timer);
      timers.clear();
    };
  }, []);

  return {
    controlStates,
    stateOf,
    requestActivation,
    ensureVisible,
    focusTask,
    reopenTask,
    setVisibleTaskIds,
    handleTerminalReady,
    handleTerminalDispose,
    handleSessionReady,
    handleOutput,
  };
}
