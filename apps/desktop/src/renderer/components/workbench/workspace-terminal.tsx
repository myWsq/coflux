import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { Bot, FileDiff, GitBranch, History, LoaderCircle, Plus, SquareTerminal, Unplug, X } from "lucide-react";
import { TaskStatus, type Task } from "@coflux/protocol";

import { Button } from "@astryxdesign/core/Button";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import { BranchMenu, type BranchTaken } from "@/components/workbench/branch-menu";
import { ChangesView } from "@/components/workbench/changes-view";
import { DRAG_REGION_STYLE, NO_DRAG_REGION_STYLE } from "@/components/workbench/drag-region";
import { SHORTCUT_MODIFIER_PREFIX } from "@/components/workbench/shortcut-modifier";
import { isDirWorkspace as isDirWorkspaceOf, type CofluxClient } from "@coflux/client";
import { cn } from "@/lib/utils";
import { ClawdGlyph } from "@/components/workbench/clawd-glyph";
import type { TerminalAttach } from "@/components/workbench/terminal-attach";
import type { TerminalControlState } from "@/components/workbench/terminal-pane";
import {
  resolveActiveTaskId,
  resolveActiveTaskIdAfterPendingDrop,
  shouldActivateChangesView,
} from "@/components/workbench/workbench-state";

// 乐观 tab（plan 078）的本地兜底：taskCreate 既没广播成功也没广播错误时撤掉 pending tab，
// 避免永久滞留。
const PENDING_CREATE_TIMEOUT_MS = 15_000;

/** Tab 上的 agent 图标（plan 075）：claude 用 Clawd 像素小动物并按状态换姿态；
 * 干活健身、待批准/待回答挥旗、未读完成撒花；看过完成态后冻成 gym 第 0 帧站姿。
 * 其余 agent 用 lucide 机器人轮廓，保留状态警示色（approval/question→warning、
 * done→success，与侧栏语义一致）。 */
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
  return <Bot className={cn("size-3 shrink-0", tone, className)} />;
}


/** 活动 Tab 上报（plan 104）：面板可见性与 attach 门禁都在 Workbench 层判定，
 * 容器每次改动活动 Tab / 视图都要同步告诉它。 */
export type WorkspaceActiveTab = { taskId: string | null; viewIsTerminal: boolean };

type WorkspaceTerminalProps = {
  workspaceId: string;
  /** 是否为当前显示的工作区：隐藏时保持挂载与 attach，仅切回时 fit + focus。 */
  active: boolean;
  client: CofluxClient;
  onCloseTask: (task: Task) => void;
  /** 终端面板与接管状态机已提升到 Workbench（plan 104）：容器只借它读控制态、发起激活。 */
  attach: TerminalAttach;
  /** 被搬进本工作区、必须继续当活动 Tab 的终端（plan 104）；一次性，Workbench 下发后即清除。 */
  followTaskId: string | null;
  onActiveTabChange: (workspaceId: string, active: WorkspaceActiveTab) => void;
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
  { workspaceId, active, client, onCloseTask, attach, followTaskId, onActiveTabChange },
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
  const daemons = useStore(client.store, (state) => state.daemons);
  const modPrefix = SHORTCUT_MODIFIER_PREFIX;
  const lastError = useStore(client.store, (state) => state.lastError);
  // agent presence（plan 073/075）：引用只在实际变化时更新（worker 变化才发），直接订阅。
  const sessionAgents = useStore(client.store, (state) => state.sessionAgents);
  // OSC 终端标题（plan 075）：checkpoint 每 ~2s 换引用（有输出即上报），必须用选择器把
  // 本工作区的 title 摘出来浅比较，否则整棵 WorkspaceTerminal 会跟着 2s 心跳空转重渲染。
  const checkpointTitles = useStore(
    client.store,
    useShallow((state) => {
      const titles: Record<string, string> = {};
      for (const task of state.tasks) {
        if (task.workspaceId !== workspaceId || !task.sessionId) continue;
        const title = state.sessionCheckpoints[task.sessionId]?.title;
        if (title) titles[task.sessionId] = title;
      }
      return titles;
    }),
  );

  // 目录工作区（无 repo 终端，plan 045/048）：作为设备详情的载体，顶栏保留终端
  // Tabs/新建/端口，但 git 语义（分支按钮/「变更」tab/diff）全部不渲染。
  const isDirWorkspace = Boolean(workspace && isDirWorkspaceOf(workspace));

  const [activeTaskId, setActiveTaskIdState] = useState<string | null>(null);
  // 主面板视图：常驻「变更」tab 与终端 Tab 互斥（plan 025）。本组件随工作区常驻挂载
  // （workbench.tsx 隐藏而非卸载），故该 state 天然按工作区独立保留，无需额外持久化。
  const [view, setView] = useState<"terminal" | "changes">("terminal");
  /** 切换分支中：目标分支名（按钮 pending 态；成功由 daemon 上报驱动 branch 变更后自动清除） */
  const [pendingBranch, setPendingBranch] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // 乐观终端 tab（plan 078）：taskCreate 发出后下一帧即出现并被选中。只动视图态——
  // 不进接管状态机、不挂 TerminalPane（面板按真实 task id 挂在 Workbench 层），假 id 不产生任何请求。
  // createTerminal 有 pendingCreateRef 单发门禁，同一工作区同一时刻至多一个 pending tab。
  const [pendingTab, setPendingTab] = useState<{ id: string; title: string } | null>(null);
  const pendingTabRef = useRef<{ id: string; title: string } | null>(null);
  const pendingTabTimerRef = useRef<number | undefined>(undefined);
  const pendingTabSeqRef = useRef(0);

  const pendingCreateRef = useRef<{ knownTaskIds: Set<string> } | null>(null);
  // 完成态看过一次就不再撒花：按 sessionId 记，下一轮又干活时清掉。
  const seenDoneRef = useRef(new Set<string>());

  // activeTaskId/view 的同步镜像：imperative 函数需要在 setState 后立即读到"当下"值
  // （对应 Solid 信号的同步读语义），而 React state 变量本身要等下一次渲染才更新，故用 ref 双轨。
  // 上报给 Workbench 的活动 Tab 也读这两份 ref：面板可见性与 attach 门禁靠它，慢一拍就会误判。
  const activeTaskIdRef = useRef<string | null>(null);
  const viewRef = useRef<"terminal" | "changes">("terminal");
  // onActiveTabChange 的镜像：上报由 effect / 定时器在任意渲染代触发，直接闭包捕获会读到过期的 prop
  // （同 landmine：React 每次渲染都换一份闭包）。
  const reportRef = useRef(onActiveTabChange);
  reportRef.current = onActiveTabChange;

  function reportActiveTab() {
    reportRef.current(workspaceId, { taskId: activeTaskIdRef.current, viewIsTerminal: viewRef.current === "terminal" });
  }

  function updateActiveTaskId(taskId: string | null) {
    activeTaskIdRef.current = taskId;
    setActiveTaskIdState(taskId);
    reportActiveTab();
  }

  function updateView(next: "terminal" | "changes") {
    viewRef.current = next;
    setView(next);
    reportActiveTab();
  }

  // untrack(workspaceTasks) 的对应物：直接读 store 当下状态，不经由本次渲染闭包捕获的
  // workspaceTasks（可能已过期）。
  function currentTasks(): Task[] {
    return client.store
      .getState()
      .tasks.filter((task) => task.workspaceId === workspaceId)
      .sort((left, right) => left.createdAt - right.createdAt);
  }

  /** 激活某个终端 Tab：选中态归本容器，接管/回放归提升到 Workbench 的状态机（plan 104）。 */
  function requestActivation(taskId: string, forceClaim = false) {
    updateView("terminal"); // 任何终端 Tab 的激活（点击/键盘/新建）都切回终端视图，与「变更」互斥
    updateActiveTaskId(taskId);
    attach.requestActivation(taskId, forceClaim);
  }

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
    const title = `终端 ${tasksNow.length + 1}`;
    pendingCreateRef.current = { knownTaskIds: new Set(tasksNow.map((task) => task.id)) };
    const pending = { id: `pending-tab-${++pendingTabSeqRef.current}`, title };
    updatePendingTab(pending);
    setCreating(true);
    // 乐观选中：任何终端 Tab 的激活都切回终端视图；不调用 requestActivation——
    // 那会进接管状态机的 activationRequests 并在 rAF 里 performActivation，假 id 绝不能碰那条路。
    updateView("terminal");
    updateActiveTaskId(pending.id);
    pendingTabTimerRef.current = window.setTimeout(() => {
      pendingCreateRef.current = null;
      setCreating(false);
      dropPendingTab();
    }, PENDING_CREATE_TIMEOUT_MS);
    client.send({ case: "taskCreate", value: { workspaceId, title } });
  }

  function updatePendingTab(next: { id: string; title: string } | null) {
    pendingTabRef.current = next;
    setPendingTab(next);
  }

  // 清计时与状态（转正/失败/超时共用），不管焦点。
  function settlePendingTab() {
    if (pendingTabTimerRef.current !== undefined) window.clearTimeout(pendingTabTimerRef.current);
    pendingTabTimerRef.current = undefined;
    updatePendingTab(null);
  }

  // 失败/超时撤 pending tab：若焦点还在它身上，回落到第一个真实任务（或清空）。
  function dropPendingTab() {
    const pending = pendingTabRef.current;
    if (!pending) return;
    settlePendingTab();
    const currentActive = activeTaskIdRef.current;
    const nextActive = resolveActiveTaskIdAfterPendingDrop(
      currentActive,
      pending.id,
      currentTasks().map((task) => task.id),
    );
    if (nextActive === currentActive) return;
    if (nextActive) requestActivation(nextActive);
    else updateActiveTaskId(null);
  }

  useEffect(() => {
    if (pendingCreateRef.current) {
      const created = workspaceTasks.find((task) => !pendingCreateRef.current!.knownTaskIds.has(task.id));
      if (created) {
        pendingCreateRef.current = null;
        setCreating(false);
        // 转正不抢焦点：等待期间用户已手动切到别的 Tab，则保持其选择，只撤乐观条目。
        const pending = pendingTabRef.current;
        settlePendingTab();
        if (!pending || activeTaskIdRef.current === pending.id) requestActivation(created.id);
      }
    }

    const currentActive = activeTaskIdRef.current;
    const nextActive = resolveActiveTaskId(
      currentActive,
      workspaceTasks.map((task) => task.id),
      pendingTabRef.current?.id ?? null,
      followTaskId,
    );
    if (nextActive === currentActive) return;
    // 活动 Tab 被搬去别的工作区（plan 104）也走这条回退：此时本工作区已经不可见（选中态跟着
    // 终端过去了），提升后的状态机按"面板可见"门禁，绝不会顺手 attach 这里的兄弟 Tab。
    if (nextActive) requestActivation(nextActive);
    else updateActiveTaskId(null);
    // 只跟踪 workspaceTasks（对应 Solid `on(workspaceTasks, ...)` 的显式单一依赖），
    // 回调内其余状态一律读 ref/store 当下值，不纳入依赖数组；followTaskId 与 workspaceTasks
    // 同批到达（Workbench 在 store 订阅里同步定下跟随），本次运行读到的就是最终值。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceTasks]);

  // error 消息到达时清 pending 创建态（taskCreate 失败兜底）；launching 态归提升后的状态机清。
  useEffect(() => {
    if (!lastError) return;
    if (pendingCreateRef.current) {
      pendingCreateRef.current = null;
      setCreating(false);
    }
    dropPendingTab();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastError]);

  useEffect(() => {
    return () => {
      if (pendingTabTimerRef.current !== undefined) window.clearTimeout(pendingTabTimerRef.current);
    };
  }, []);

  const stateOf = attach.stateOf;

  const activeTask = workspaceTasks.find((task) => task.id === activeTaskId) ?? null;
  const activeControlState: TerminalControlState = activeTask ? stateOf(activeTask) : "stopped";

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

  // 容器只出顶栏与主体覆盖层，终端面板由 Workbench 层统一挂（plan 104）。外层包一层
  // display:contents（见 workbench.tsx），这两块直接落进工作台的两行网格：顶栏一行、主体一行，
  // 主体与面板层共用同一个网格单元。
  return (
    <>
      {/* 单栏顶栏：名称（如有）＋ 可点的分支按钮 │ 终端 Tabs（Tab 用间距而非竖线分隔）＋ 新建/端口。
          目录工作区（设备详情，plan 048）保留 Tabs/新建/端口，不渲染分支按钮与「变更」tab。
          顶栏整条是窗口拖拽区（plan 108）：空白处按住能拖窗口、双击走 macOS 标题栏双击偏好。
          代价是拖拽区吞掉指针事件——以后往顶栏里加任何可点/可悬浮的元素，都必须给它带上
          NO_DRAG_REGION_STYLE，否则在桌面版里点不到、Tooltip 也不出（见 drag-region.ts）。 */}
      <header
        className="col-start-1 row-start-1 flex h-9 min-w-0 items-center gap-2 border-b border-border bg-background pl-3 pr-20"
        style={DRAG_REGION_STYLE}
      >
        {isDirWorkspace ? null : (
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
        )}
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto pr-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {/* 常驻「变更」tab（plan 025）：与终端 Tab 同级同组、选中态互斥；
              统计徽标并入 tab，X=Y=0 时数字隐藏，min-w 对齐「终端 N」默认标题 Tab 的实际宽度（≈96px）避免显得过窄，内容靠左。 */}
          {isDirWorkspace ? null : (
            <button
              className={cn(
                "flex h-7 min-w-24 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-sm transition-colors",
                view === "changes"
                  ? "bg-accent text-foreground"
                  : "text-secondary-foreground hover:bg-accent/60 hover:text-foreground",
              )}
              style={NO_DRAG_REGION_STYLE}
              onClick={() => updateView("changes")}
            >
              <FileDiff className={cn("size-3 shrink-0", view === "changes" ? "opacity-90" : "opacity-50")} />
              <span>变更</span>
              {workspace && (workspace.additions > 0 || workspace.deletions > 0) ? (
                <span className="whitespace-nowrap font-mono text-2xs tabular-nums" title={`+${workspace.additions} −${workspace.deletions}`}>
                  <span className="text-success">+{workspace.additions}</span> <span className="text-destructive">−{workspace.deletions}</span>
                </span>
              ) : null}
            </button>
          )}
          {workspaceTasks.map((task) => {
            const state = stateOf(task);
            // 「变更」视图激活时终端 Tab 一律去高亮，两种视图选中态互斥（plan 025）。
            const isActive = view === "terminal" && task.id === activeTaskId;
            const daemon = daemons.find((item) => item.daemonId === task.daemonId);
            const agentEntry = task.sessionId ? sessionAgents[task.sessionId] : undefined;
            const sessionId = task.sessionId;
            const agentState = agentEntry?.state;
            if (sessionId && agentState && agentState !== "done" && agentState !== "waiting") {
              seenDoneRef.current.delete(sessionId);
            }
            // 本工作区正显示且用户正看着这个 tab，才算已读。
            if (active && isActive && sessionId && (agentState === "done" || agentState === "waiting")) {
              seenDoneRef.current.add(sessionId);
            }
            const seenDone = Boolean(sessionId && seenDoneRef.current.has(sessionId));
            // OSC 标题非空即覆盖显示；EXITED 后 sessionId 清空 → 自动回落 task.title。
            const tabTitle = (task.sessionId && checkpointTitles[task.sessionId]) || task.title;
            return (
              <div
                key={task.id}
                className={cn(
                  "group flex h-7 max-w-52 shrink-0 items-center rounded-md text-sm transition-colors",
                  isActive ? "bg-accent text-foreground" : "text-secondary-foreground hover:bg-accent/60 hover:text-foreground",
                )}
                // Keep tab selection and close controls outside the native drag region.
                style={NO_DRAG_REGION_STYLE}
              >
                  <button
                    className="flex min-w-0 flex-1 items-center gap-1.5 self-stretch px-2.5 text-left"
                    onClick={() => requestActivation(task.id, state === "detached")}
                  >
                    {state === "attaching" ? (
                      <LoaderCircle className="size-3 shrink-0 animate-spin text-muted-foreground" />
                    ) : state === "detached" ? (
                      <Unplug className="size-3 shrink-0 text-warning" />
                    ) : agentEntry ? (
                      <AgentGlyph
                        agent={agentEntry.agent}
                        state={agentEntry.state}
                        seen={seenDone}
                        className={isActive ? "opacity-90" : "opacity-70"}
                      />
                    ) : (
                      <SquareTerminal className={cn("size-3 shrink-0", isActive ? "opacity-90" : "opacity-50")} />
                    )}
                    {tabTitle === task.title || !tabTitle ? (
                      <span className="truncate">{tabTitle || "终端"}</span>
                    ) : (
                      // OSC 标题往往比 tab 宽，悬浮给全文（设计约定：Tooltip 组件，不用原生 title）
                      <Tooltip content={tabTitle} placement="below">
                        <span className="truncate">{tabTitle}</span>
                      </Tooltip>
                    )}
                  </button>
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
          {/* 乐观 pending tab（plan 078）：点击只回焦点，不进激活/attach 状态机；无关闭入口。 */}
          {pendingTab ? (
            <div
              className={cn(
                "flex h-7 max-w-52 shrink-0 items-center rounded-md text-sm transition-colors",
                view === "terminal" && pendingTab.id === activeTaskId
                  ? "bg-accent text-foreground"
                  : "text-secondary-foreground hover:bg-accent/60 hover:text-foreground",
              )}
              style={NO_DRAG_REGION_STYLE}
            >
              <button
                className="flex min-w-0 flex-1 items-center gap-1.5 self-stretch px-2.5 text-left"
                onClick={() => {
                  updateView("terminal");
                  updateActiveTaskId(pendingTab.id);
                }}
              >
                <LoaderCircle className="size-3 shrink-0 animate-spin text-muted-foreground" />
                <span className="truncate">{pendingTab.title}</span>
              </button>
            </div>
          ) : null}
          {/* 新建按钮跟随最后一个 Tab（浏览器式），不钉在最右 */}
          <Tooltip content={`新建终端 ${modPrefix}T`} placement="below">
            <button
              className="ml-0.5 flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-wait disabled:opacity-50"
              style={NO_DRAG_REGION_STYLE}
              onClick={createTerminal}
              disabled={creating}
            >
              {creating ? <LoaderCircle className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
            </button>
          </Tooltip>
        </div>
      </header>

      {/* 主体：与面板层同占网格第二行（面板层在 DOM 上排在后面、整层 pointer-events-none，
          故这里的空态/横幅/「变更」视图照常收得到点击）。 */}
      <div className="relative col-start-1 row-start-2 min-h-0 min-w-0 bg-terminal">
        {view === "terminal" && pendingTab && activeTaskId === pendingTab.id ? (
          // pending tab 的主区（plan 078）：不挂 TerminalPane（假 id 不产生请求），只显示创建中。
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="flex max-w-sm flex-col items-center text-center">
              <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
              <p className="mt-4 text-sm leading-5 text-muted-foreground">正在创建终端…</p>
            </div>
          </div>
        ) : null}

        {view === "terminal" && workspaceTasks.length === 0 && !pendingTab ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="flex max-w-sm flex-col items-center text-center">
              <div className="mb-4 flex size-10 items-center justify-center rounded-lg border border-border text-muted-foreground">
                <SquareTerminal className="size-5" />
              </div>
              <h2 className="text-base font-medium text-foreground">{isDirWorkspace ? "这台设备还没有终端" : "这个工作区还没有终端"}</h2>
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

        {/* 已退出终端（plan 097）：画面是回放的最后输出，重开 shell 是显式动作，不再一点 Tab 就悄悄起新会话。 */}
        {view === "terminal" && activeTask && activeTask.status === TaskStatus.EXITED && activeControlState === "stopped" ? (
          <div className="absolute inset-x-0 top-0 z-10 flex items-center justify-between border-b border-border bg-background/80 px-4 py-2 text-xs text-muted-foreground backdrop-blur">
            <span className="flex items-center gap-2">
              <History className="size-3.5" />
              {activeTask.exitCode === undefined
                ? "此终端已退出，画面是最后的输出。"
                : `此终端已退出（退出码 ${activeTask.exitCode}），画面是最后的输出。`}
            </span>
            <Button label="重新打开" variant="secondary" size="sm" onClick={() => attach.reopenTask(activeTask.id)} />
          </div>
        ) : null}

        {/* 「变更」视图：与终端面板同保活模式（隐藏不卸载），折叠态/已拉取数据才不随切换丢失。
            目录工作区无 git 语义，整个视图不渲染（顶栏已隐藏，view 也不可能切到 changes）。 */}
        {isDirWorkspace ? null : (
          <div className={cn("absolute inset-0 bg-terminal", view === "changes" ? "block" : "hidden")}>
            <ChangesView
              workspaceId={workspaceId}
              active={shouldActivateChangesView(active, view)}
              client={client}
              defaultBranch={defaultBranch}
              additions={workspace?.additions ?? 0}
              deletions={workspace?.deletions ?? 0}
            />
          </div>
        )}
      </div>
    </>
  );
});
