import { lazy, Suspense, useEffect, useRef, useState, type FormEvent } from "react";
import { useStore } from "zustand";
import { AlertCircle, FolderGit2, LoaderCircle, X } from "lucide-react";
import { TaskStatus, type DaemonInfo, type Project, type Task, type Workspace } from "@coflux/protocol";

import { AuthShell, CredentialsForm } from "@/components/auth/auth-shell";
import { Button } from "@astryxdesign/core/Button";
import {
  ConfirmActionDialog,
  EnrollmentDialog,
  ShortcutsHelpDialog,
  WorkspaceRenameDialog,
  type ConfirmAction,
} from "@/components/workbench/dialogs";
import { ImportProjectWizard } from "@/components/workbench/import-project-wizard";
import { Sidebar } from "@/components/workbench/sidebar";
import { useGlobalShortcuts } from "@/components/workbench/use-global-shortcuts";
import type { WorkspaceTerminalHandle } from "@/components/workbench/workspace-terminal";
import { WORKSPACE_KEY, USE_SUPABASE } from "@/config";
import type { CofluxClient } from "@/client/store";

// 终端栈（xterm + WorkspaceTerminal/TerminalPane）懒加载，不进首屏主 chunk：
// 登录页与"未选中工作区"的空状态都不需要它。module 级别声明，保证只 lazy() 一次，
// 不随 Workbench 重渲染重建（重建会丢已缓存的加载态触发重复 Suspense）。
const WorkspaceTerminal = lazy(() =>
  import("@/components/workbench/workspace-terminal").then((module) => ({ default: module.WorkspaceTerminal })),
);

export function Workbench({ client }: { client: CofluxClient }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(() => localStorage.getItem(WORKSPACE_KEY));
  // 访问过的工作区保持挂载（display 隐藏而非卸载）：卸载会 dispose xterm，
  // 丢 scrollback / 活跃 Tab / 控制权，切回来要重新 attach。同 TerminalPane 的 Tab 保活模式上移一层。
  const [visitedWorkspaceIds, setVisitedWorkspaceIds] = useState<ReadonlySet<string>>(new Set());
  const [dismissedErrorId, setDismissedErrorId] = useState<number | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [enrollmentOpen, setEnrollmentOpen] = useState(false);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);
  const [renameWorkspace, setRenameWorkspace] = useState<Workspace | null>(null);
  // 新建工作区菜单当前打开的项目：Sidebar 的 + 按钮/右键菜单与 Cmd+Ctrl+N 快捷键共用同一份受控状态。
  const [createMenuProjectId, setCreateMenuProjectId] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  // 只指向当前 active 的 WorkspaceTerminal 实例：ref 只挂在 active===true 的那个元素上（见下方渲染），
  // 保活但隐藏的实例永远拿不到这份 ref，全局快捷键天然只广播给 active 实例。
  const activeTerminalRef = useRef<WorkspaceTerminalHandle | null>(null);

  const authState = useStore(client.store, (state) => state.authState);
  const loginError = useStore(client.store, (state) => state.loginError);
  const status = useStore(client.store, (state) => state.status);
  const projects = useStore(client.store, (state) => state.projects);
  const workspaces = useStore(client.store, (state) => state.workspaces);
  const daemons = useStore(client.store, (state) => state.daemons);
  const lastError = useStore(client.store, (state) => state.lastError);
  const enrollCommand = useStore(client.store, (state) => state.enrollCommand);
  const snapshotRevision = useStore(client.store, (state) => state.snapshotRevision);

  // 快照后校准选中工作区：无效选择回退到首项目 main workspace（或任一工作区）。
  useEffect(() => {
    if (snapshotRevision === 0) return;
    if (selectedWorkspaceId && workspaces.some((workspace) => workspace.id === selectedWorkspaceId)) {
      localStorage.setItem(WORKSPACE_KEY, selectedWorkspaceId);
      return;
    }

    const firstProject = [...projects].sort((left, right) => left.createdAt - right.createdAt)[0];
    const fallback =
      (firstProject && workspaces.find((workspace) => workspace.projectId === firstProject.id && workspace.isMain)) ?? workspaces[0];
    const nextId = fallback?.id ?? null;
    setSelectedWorkspaceId(nextId);
    if (nextId) localStorage.setItem(WORKSPACE_KEY, nextId);
    else localStorage.removeItem(WORKSPACE_KEY);
  }, [snapshotRevision, projects, workspaces, selectedWorkspaceId]);

  function selectWorkspace(workspaceId: string) {
    setSelectedWorkspaceId(workspaceId);
    localStorage.setItem(WORKSPACE_KEY, workspaceId);
  }

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await client.login(username, password);
  }

  function openEnrollment() {
    setImportOpen(false);
    client.clearEnrollmentCommand();
    setEnrollmentOpen(true);
  }

  function importProject(daemonId: string, path: string) {
    client.send({ case: "projectImport", value: { daemonId, path } });
  }

  // workspaceCreate 无请求-响应关联：记下发起时已知的工作区 id，
  // 广播中新出现的该项目工作区即本次创建的，自动切换过去（同终端创建的识别模式）。
  const pendingWorkspaceCreateRef = useRef<{ projectId: string; knownIds: Set<string> } | null>(null);

  function createWorkspace(project: Project, branch: string, createNew: boolean) {
    pendingWorkspaceCreateRef.current = { projectId: project.id, knownIds: new Set(client.store.getState().workspaces.map((workspace) => workspace.id)) };
    // name = branch（未起名语义）；创建成功后由下面的效果自动切换过去
    client.send({ case: "workspaceCreate", value: { projectId: project.id, name: branch, branch, createNew } });
  }

  useEffect(() => {
    const pending = pendingWorkspaceCreateRef.current;
    if (!pending) return;
    const created = workspaces.find((workspace) => workspace.projectId === pending.projectId && !pending.knownIds.has(workspace.id));
    if (created) {
      pendingWorkspaceCreateRef.current = null;
      selectWorkspace(created.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaces]);

  // 创建失败（error 广播）时丢弃 pending，避免误认后续他端创建的工作区
  useEffect(() => {
    if (lastError) pendingWorkspaceCreateRef.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastError]);


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
    client.send({ case: "taskStop", value: { taskId: task.id } });
    client.send({ case: "taskRemove", value: { taskId: task.id } });
  }

  function requestCloseTask(task: Task) {
    if (task.status !== TaskStatus.RUNNING) {
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
    if (!selectedWorkspaceId) return;
    setVisitedWorkspaceIds((prev) => (prev.has(selectedWorkspaceId) ? prev : new Set(prev).add(selectedWorkspaceId)));
  }, [selectedWorkspaceId]);

  const selectedWorkspace = workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? null;
  // 已删除的工作区随 workspaces 过滤自动卸载；含 selectedWorkspaceId 是避免等 visited 效果多一帧空白。
  const terminalWorkspaces = workspaces.filter((workspace) => visitedWorkspaceIds.has(workspace.id) || workspace.id === selectedWorkspaceId);
  const showError = lastError !== null && lastError.id !== dismissedErrorId;
  const displayError = lastError?.message.replaceAll("任务", "终端");

  useGlobalShortcuts({
    selectedProjectId: selectedWorkspace?.projectId ?? null,
    activeTerminalRef,
    onOpenCreateWorkspaceMenu: setCreateMenuProjectId,
    onToggleHelp: () => setHelpOpen((open) => !open),
  });

  // 恢复会话 / 登录握手中：只显示安静加载，不渲染登录表单（避免刷新闪一下）。
  if (authState === "authenticating") {
    return (
      <div className="flex h-screen min-w-[1024px] items-center justify-center bg-background text-muted-foreground">
        <LoaderCircle className="size-5 animate-spin" />
      </div>
    );
  }

  if (authState !== "authed") {
    return (
      <AuthShell>
        <CredentialsForm
          title="登录到 coflux"
          description={USE_SUPABASE ? "使用你的邮箱和密码访问远程工作区" : "使用本地账号访问远程工作区"}
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
    <div className="flex h-screen min-h-[640px] min-w-[1024px] overflow-hidden bg-background text-foreground">
      <Sidebar
        client={client}
        selectedWorkspaceId={selectedWorkspaceId}
        onSelectWorkspace={selectWorkspace}
        onImportProject={() => setImportOpen(true)}
        onCreateWorkspace={createWorkspace}
        onRemoveProject={requestRemoveProject}
        onRemoveWorkspace={requestRemoveWorkspace}
        onRenameWorkspace={setRenameWorkspace}
        onAddDevice={openEnrollment}
        onRemoveDevice={requestRemoveDevice}
        createMenuProjectId={createMenuProjectId}
        onCreateMenuProjectIdChange={setCreateMenuProjectId}
      />

      {terminalWorkspaces.length > 0 ? (
        <Suspense
          fallback={
            <main className="flex min-w-0 flex-1 items-center justify-center bg-terminal text-muted-foreground">
              <LoaderCircle className="size-5 animate-spin" />
            </main>
          }
        >
          {terminalWorkspaces.map((workspace) => {
            const isActive = workspace.id === selectedWorkspaceId;
            return (
              // display:contents 让 <section> 仍作为根 flex 行的直接子项参与布局
              <div key={workspace.id} className={isActive ? "contents" : "hidden"}>
                <WorkspaceTerminal
                  // ref 只挂在 active 实例上：非 active 的保活实例传 undefined，永远拿不到命令句柄。
                  ref={isActive ? activeTerminalRef : undefined}
                  workspaceId={workspace.id}
                  active={isActive}
                  client={client}
                  onCloseTask={requestCloseTask}
                />
              </div>
            );
          })}
        </Suspense>
      ) : null}
      {!selectedWorkspace ? (
        <main className="flex min-w-0 flex-1 items-center justify-center bg-terminal">
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
        </main>
      ) : null}

      {/* 断线重连横幅：保留最后快照渲染（乐观 UI），只提示连接状态。 */}
      {status !== "connected" ? (
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
      <ConfirmActionDialog action={confirmAction} onCancel={() => setConfirmAction(null)} />
      <ShortcutsHelpDialog open={helpOpen} onOpenChange={setHelpOpen} />
    </div>
  );
}
