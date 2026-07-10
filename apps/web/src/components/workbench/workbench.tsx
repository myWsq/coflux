import { useEffect, useState } from "react";
import { AlertCircle, FolderGit2, X } from "lucide-react";
import type { DaemonInfo, Project, Task, Workspace } from "@coflux/protocol";

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
import type { CofluxClient } from "@/hooks/use-coflux-client";

export function Workbench({ client }: { client: CofluxClient }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(() => localStorage.getItem(WORKSPACE_KEY));
  const [dismissedErrorId, setDismissedErrorId] = useState<number | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [workspaceProject, setWorkspaceProject] = useState<Project | null>(null);
  const [enrollmentOpen, setEnrollmentOpen] = useState(false);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);

  useEffect(() => {
    if (client.snapshotRevision === 0) return;
    if (selectedWorkspaceId && client.workspaces.some((workspace) => workspace.id === selectedWorkspaceId)) {
      localStorage.setItem(WORKSPACE_KEY, selectedWorkspaceId);
      return;
    }

    const firstProject = [...client.projects].sort((left, right) => left.createdAt - right.createdAt)[0];
    const fallback =
      (firstProject && client.workspaces.find((workspace) => workspace.projectId === firstProject.id && workspace.isMain)) ??
      client.workspaces[0];
    const nextId = fallback?.id ?? null;
    setSelectedWorkspaceId(nextId);
    if (nextId) localStorage.setItem(WORKSPACE_KEY, nextId);
    else localStorage.removeItem(WORKSPACE_KEY);
  }, [client.projects, client.snapshotRevision, client.workspaces, selectedWorkspaceId]);

  function selectWorkspace(workspaceId: string) {
    setSelectedWorkspaceId(workspaceId);
    localStorage.setItem(WORKSPACE_KEY, workspaceId);
  }

  async function login(event: React.FormEvent) {
    event.preventDefault();
    await client.login(username, password);
  }

  function openEnrollment() {
    setImportOpen(false);
    client.clearEnrollmentCommand();
    setEnrollmentOpen(true);
  }

  function importProject(daemonId: string, path: string) {
    client.send({ type: "project.import", daemonId, path });
  }

  function createWorkspace(projectId: string, name: string, branch: string, createNew: boolean) {
    client.send({ type: "workspace.create", projectId, name, branch, createNew });
  }

  function requestRemoveProject(project: Project) {
    setConfirmAction({
      title: `移除项目「${project.name}」？`,
      description: "项目记录和它的子工作区会从 coflux 中移除，主仓库本身不会被改动。此操作无法撤销。",
      confirmLabel: "移除项目",
      onConfirm: () => client.send({ type: "project.remove", projectId: project.id }),
    });
  }

  function requestRemoveWorkspace(workspace: Workspace) {
    setConfirmAction({
      title: `删除工作区「${workspace.name}」？`,
      description: `对应的 git worktree 目录会被移除，分支「${workspace.branch}」不会被自动删除。`,
      confirmLabel: "删除工作区",
      onConfirm: () => client.send({ type: "workspace.remove", workspaceId: workspace.id }),
    });
  }

  function requestRemoveDevice(daemon: DaemonInfo) {
    setConfirmAction({
      title: `移除设备「${daemon.name}」？`,
      description: "这台设备下的所有项目、工作区和终端记录会一并删除。若要再次接入，需要重新登记。",
      confirmLabel: "移除设备",
      onConfirm: () => client.send({ type: "client.removeDevice", daemonId: daemon.daemonId }),
    });
  }

  function closeTaskNow(task: Task) {
    client.send({ type: "task.stop", taskId: task.id });
    client.send({ type: "task.remove", taskId: task.id });
  }

  function requestCloseTask(task: Task) {
    if (task.status !== "running") {
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

  if (client.authState !== "authed") {
    return (
      <AuthShell>
        <CredentialsForm
          title="登录到 coflux"
          description={USE_SUPABASE ? "使用你的邮箱和密码访问远程工作区" : "使用本地账号访问远程工作区"}
          username={username}
          password={password}
          busy={client.authState === "authenticating"}
          error={client.authState === "auth-failed" ? client.loginError || "登录失败" : undefined}
          onUsernameChange={setUsername}
          onPasswordChange={setPassword}
          onSubmit={login}
        />
      </AuthShell>
    );
  }

  const selectedWorkspace = client.workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? null;
  const showError = client.lastError && client.lastError.id !== dismissedErrorId;
  const displayError = client.lastError?.message.replaceAll("任务", "终端");

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

      {selectedWorkspace ? (
        <WorkspaceTerminal key={selectedWorkspace.id} workspace={selectedWorkspace} client={client} onCloseTask={requestCloseTask} />
      ) : (
        <main className="flex min-w-0 flex-1 items-center justify-center bg-terminal">
          <div className="flex max-w-sm flex-col items-center text-center">
            <div className="mb-4 flex size-12 items-center justify-center rounded-xl border border-border bg-card text-muted-foreground shadow-sm">
              <FolderGit2 className="size-6" />
            </div>
            <h1 className="text-sm font-medium">{client.projects.length === 0 ? "从一个项目开始" : "选择一个工作区"}</h1>
            <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
              {client.projects.length === 0 ? "导入在线设备上的 git 仓库，主工作区会自动创建。" : "从左侧项目或子工作区进入终端工作台。"}
            </p>
            {client.projects.length === 0 && (
              <Button className="mt-5" size="sm" onClick={() => setImportOpen(true)}>导入项目</Button>
            )}
          </div>
        </main>
      )}

      {showError && client.lastError && (
        <div className="fixed bottom-4 right-4 z-40 flex max-w-md items-start gap-3 rounded-lg border border-destructive/30 bg-popover px-4 py-3 text-sm shadow-2xl">
          <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
          <span className="leading-5 text-foreground">{displayError}</span>
          <button className="ml-2 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => setDismissedErrorId(client.lastError!.id)} title="关闭">
            <X className="size-3.5" />
          </button>
        </div>
      )}

      <ImportProjectDialog
        open={importOpen}
        daemons={client.daemons}
        onOpenChange={setImportOpen}
        onImport={importProject}
        onAddDevice={openEnrollment}
      />
      <CreateWorkspaceDialog
        project={workspaceProject}
        open={Boolean(workspaceProject)}
        onOpenChange={(open) => !open && setWorkspaceProject(null)}
        onCreate={createWorkspace}
      />
      <EnrollmentDialog
        open={enrollmentOpen}
        command={client.enrollCommand}
        lastError={client.lastError}
        onOpenChange={setEnrollmentOpen}
        onRequest={client.requestEnrollmentKey}
        onClear={client.clearEnrollmentCommand}
      />
      <ConfirmActionDialog action={confirmAction} onCancel={() => setConfirmAction(null)} />
    </div>
  );
}
