import { lazy, Suspense, useEffect, useState, type FormEvent } from "react";
import { useStore } from "zustand";
import { AlertCircle, FolderGit2, LoaderCircle, X } from "lucide-react";
import { TaskStatus, type DaemonInfo, type Project, type Task, type Workspace } from "@coflux/protocol";

import { AuthShell, CredentialsForm } from "@/components/auth/auth-shell";
import { Button } from "@/components/ui/button";
import {
  ConfirmActionDialog,
  CreateWorkspaceDialog,
  EnrollmentDialog,
  ImportProjectDialog,
  type ConfirmAction,
} from "@/components/workbench/dialogs";
import { Sidebar } from "@/components/workbench/sidebar";
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
  const [dismissedErrorId, setDismissedErrorId] = useState<number | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [workspaceProject, setWorkspaceProject] = useState<Project | null>(null);
  const [enrollmentOpen, setEnrollmentOpen] = useState(false);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);

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

  function createWorkspace(projectId: string, name: string, branch: string, createNew: boolean) {
    client.send({ case: "workspaceCreate", value: { projectId, name, branch, createNew } });
  }

  function requestRemoveProject(project: Project) {
    setConfirmAction({
      title: `移除项目「${project.name}」？`,
      description: "项目记录和它的子工作区会从 coflux 中移除，主仓库本身不会被改动。此操作无法撤销。",
      confirmLabel: "移除项目",
      onConfirm: () => client.send({ case: "projectRemove", value: { projectId: project.id } }),
    });
  }

  function requestRemoveWorkspace(workspace: Workspace) {
    setConfirmAction({
      title: `删除工作区「${workspace.name}」？`,
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

  const selectedWorkspace = workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? null;
  const showError = lastError !== null && lastError.id !== dismissedErrorId;
  const displayError = lastError?.message.replaceAll("任务", "终端");

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
        onCreateWorkspace={setWorkspaceProject}
        onRemoveProject={requestRemoveProject}
        onRemoveWorkspace={requestRemoveWorkspace}
        onAddDevice={openEnrollment}
        onRemoveDevice={requestRemoveDevice}
      />

      {selectedWorkspace?.id ? (
        <Suspense
          fallback={
            <main className="flex min-w-0 flex-1 items-center justify-center bg-terminal text-muted-foreground">
              <LoaderCircle className="size-5 animate-spin" />
            </main>
          }
        >
          <WorkspaceTerminal key={selectedWorkspace.id} workspaceId={selectedWorkspace.id} client={client} onCloseTask={requestCloseTask} />
        </Suspense>
      ) : (
        <main className="flex min-w-0 flex-1 items-center justify-center bg-terminal">
          <div className="flex max-w-sm flex-col items-center text-center">
            <div className="mb-4 flex size-10 items-center justify-center rounded-lg border border-border text-muted-foreground">
              <FolderGit2 className="size-5" />
            </div>
            <h1 className="text-[13px] font-medium">{projects.length === 0 ? "从一个项目开始" : "选择一个工作区"}</h1>
            <p className="mt-1.5 text-[12px] leading-5 text-muted-foreground">
              {projects.length === 0 ? "导入在线设备上的 git 仓库，主工作区会自动创建。" : "从左侧项目或子工作区进入终端工作台。"}
            </p>
            {projects.length === 0 ? (
              <Button className="mt-5" size="sm" onClick={() => setImportOpen(true)}>
                导入项目
              </Button>
            ) : null}
          </div>
        </main>
      )}

      {/* 断线重连横幅：保留最后快照渲染（乐观 UI），只提示连接状态。 */}
      {status !== "connected" ? (
        <div className="fixed inset-x-0 top-0 z-50 flex h-7 items-center justify-center gap-2 border-b border-warning/20 bg-warning/10 text-[11px] text-warning backdrop-blur">
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

      <ImportProjectDialog open={importOpen} daemons={daemons} onOpenChange={setImportOpen} onImport={importProject} onAddDevice={openEnrollment} />
      <CreateWorkspaceDialog
        project={workspaceProject}
        open={Boolean(workspaceProject)}
        onOpenChange={(open) => !open && setWorkspaceProject(null)}
        onCreate={createWorkspace}
      />
      <EnrollmentDialog
        open={enrollmentOpen}
        command={enrollCommand}
        lastError={lastError}
        onOpenChange={setEnrollmentOpen}
        onRequest={client.requestEnrollmentKey}
        onClear={client.clearEnrollmentCommand}
      />
      <ConfirmActionDialog action={confirmAction} onCancel={() => setConfirmAction(null)} />
    </div>
  );
}
