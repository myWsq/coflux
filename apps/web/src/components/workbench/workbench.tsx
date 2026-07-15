import { Match, Show, Switch, createEffect, createMemo, createSignal, on } from "solid-js";
import { AlertCircle, FolderGit2, LoaderCircle, X } from "lucide-solid";
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
import { WorkspaceTerminal } from "@/components/workbench/workspace-terminal";
import { WORKSPACE_KEY, USE_SUPABASE } from "@/config";
import type { CofluxClient } from "@/client/store";

export function Workbench(props: { client: CofluxClient }) {
  const client = props.client;
  const [username, setUsername] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [selectedWorkspaceId, setSelectedWorkspaceId] = createSignal<string | null>(localStorage.getItem(WORKSPACE_KEY));
  const [dismissedErrorId, setDismissedErrorId] = createSignal<number | null>(null);
  const [importOpen, setImportOpen] = createSignal(false);
  const [workspaceProject, setWorkspaceProject] = createSignal<Project | null>(null);
  const [enrollmentOpen, setEnrollmentOpen] = createSignal(false);
  const [confirmAction, setConfirmAction] = createSignal<ConfirmAction | null>(null);

  // 快照后校准选中工作区：无效选择回退到首项目 main workspace（或任一工作区）。
  createEffect(
    on(
      () => [client.snapshotRevision(), client.projects(), client.workspaces(), selectedWorkspaceId()] as const,
      ([revision, projects, workspaces, selectedId]) => {
        if (revision === 0) return;
        if (selectedId && workspaces.some((workspace) => workspace.id === selectedId)) {
          localStorage.setItem(WORKSPACE_KEY, selectedId);
          return;
        }

        const firstProject = [...projects].sort((left, right) => left.createdAt - right.createdAt)[0];
        const fallback =
          (firstProject && workspaces.find((workspace) => workspace.projectId === firstProject.id && workspace.isMain)) ?? workspaces[0];
        const nextId = fallback?.id ?? null;
        setSelectedWorkspaceId(nextId);
        if (nextId) localStorage.setItem(WORKSPACE_KEY, nextId);
        else localStorage.removeItem(WORKSPACE_KEY);
      },
    ),
  );

  function selectWorkspace(workspaceId: string) {
    setSelectedWorkspaceId(workspaceId);
    localStorage.setItem(WORKSPACE_KEY, workspaceId);
  }

  async function login(event: SubmitEvent) {
    event.preventDefault();
    await client.login(username(), password());
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

  const selectedWorkspace = createMemo(() => client.workspaces().find((workspace) => workspace.id === selectedWorkspaceId()) ?? null);
  const showError = () => {
    const error = client.lastError();
    return error !== null && error.id !== dismissedErrorId();
  };
  const displayError = () => client.lastError()?.message.replaceAll("任务", "终端");

  return (
    <Switch>
      {/* 恢复会话 / 登录握手中：只显示安静加载，不渲染登录表单（避免刷新闪一下）。 */}
      <Match when={client.authState() === "authenticating"}>
        <div class="flex h-screen min-w-[1024px] items-center justify-center bg-background text-muted-foreground">
          <LoaderCircle class="size-5 animate-spin" />
        </div>
      </Match>
      <Match when={client.authState() !== "authed"}>
        <AuthShell>
          <CredentialsForm
            title="登录到 coflux"
            description={USE_SUPABASE ? "使用你的邮箱和密码访问远程工作区" : "使用本地账号访问远程工作区"}
            username={username()}
            password={password()}
            busy={false}
            error={client.authState() === "auth-failed" ? client.loginError() || "登录失败" : undefined}
            onUsernameChange={setUsername}
            onPasswordChange={setPassword}
            onSubmit={login}
          />
        </AuthShell>
      </Match>
      <Match when={true}>
        <div class="flex h-screen min-h-[640px] min-w-[1024px] overflow-hidden bg-background text-foreground">
          <Sidebar
            client={client}
            selectedWorkspaceId={selectedWorkspaceId()}
            onSelectWorkspace={selectWorkspace}
            onImportProject={() => setImportOpen(true)}
            onCreateWorkspace={setWorkspaceProject}
            onRemoveProject={requestRemoveProject}
            onRemoveWorkspace={requestRemoveWorkspace}
            onAddDevice={openEnrollment}
            onRemoveDevice={requestRemoveDevice}
          />

          <Show
            when={selectedWorkspace()?.id}
            keyed
            fallback={
              <main class="flex min-w-0 flex-1 items-center justify-center bg-terminal">
                <div class="flex max-w-sm flex-col items-center text-center">
                  <div class="mb-4 flex size-10 items-center justify-center rounded-lg border border-border text-muted-foreground">
                    <FolderGit2 class="size-5" />
                  </div>
                  <h1 class="text-[13px] font-medium">{client.projects().length === 0 ? "从一个项目开始" : "选择一个工作区"}</h1>
                  <p class="mt-1.5 text-[12px] leading-5 text-muted-foreground">
                    {client.projects().length === 0 ? "导入在线设备上的 git 仓库，主工作区会自动创建。" : "从左侧项目或子工作区进入终端工作台。"}
                  </p>
                  <Show when={client.projects().length === 0}>
                    <Button class="mt-5" size="sm" onClick={() => setImportOpen(true)}>
                      导入项目
                    </Button>
                  </Show>
                </div>
              </main>
            }
          >
            {(workspaceId) => <WorkspaceTerminal workspaceId={workspaceId} client={client} onCloseTask={requestCloseTask} />}
          </Show>

          {/* 断线重连横幅：保留最后快照渲染（乐观 UI），只提示连接状态。 */}
          <Show when={client.status() !== "connected"}>
            <div class="fixed inset-x-0 top-0 z-50 flex h-7 items-center justify-center gap-2 border-b border-warning/20 bg-warning/10 text-[11px] text-warning backdrop-blur">
              <LoaderCircle class="size-3 animate-spin" />
              连接已断开，正在自动重连…下方显示的是最后一次同步的状态。
            </div>
          </Show>

          <Show when={showError()}>
            <div class="fixed bottom-4 right-4 z-40 flex max-w-md items-start gap-3 rounded-lg border border-destructive/30 bg-popover px-4 py-3 text-sm shadow-2xl">
              <AlertCircle class="mt-0.5 size-4 shrink-0 text-destructive" />
              <span class="leading-5 text-foreground">{displayError()}</span>
              <button
                class="ml-2 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                onClick={() => setDismissedErrorId(client.lastError()!.id)}
                title="关闭"
              >
                <X class="size-3.5" />
              </button>
            </div>
          </Show>

          <ImportProjectDialog
            open={importOpen()}
            daemons={client.daemons()}
            onOpenChange={setImportOpen}
            onImport={importProject}
            onAddDevice={openEnrollment}
          />
          <CreateWorkspaceDialog
            project={workspaceProject()}
            open={Boolean(workspaceProject())}
            onOpenChange={(open) => !open && setWorkspaceProject(null)}
            onCreate={createWorkspace}
          />
          <EnrollmentDialog
            open={enrollmentOpen()}
            command={client.enrollCommand()}
            lastError={client.lastError()}
            onOpenChange={setEnrollmentOpen}
            onRequest={client.requestEnrollmentKey}
            onClear={client.clearEnrollmentCommand}
          />
          <ConfirmActionDialog action={confirmAction()} onCancel={() => setConfirmAction(null)} />
        </div>
      </Match>
    </Switch>
  );
}
