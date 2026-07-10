import { useEffect, useState } from "react";
import { AlertCircle, FolderGit2, X } from "lucide-react";
import type { DaemonInfo, Project, Task, Workspace } from "@coflux/protocol";

import { Button } from "@/components/ui/button";
import { WORKSPACE_KEY, USE_SUPABASE } from "@/config";
import type { CofluxClient } from "@/hooks/use-coflux-client";
import { Sidebar } from "@/components/workbench/sidebar";
import { WorkspaceTerminal } from "@/components/workbench/workspace-terminal";

export function Workbench({ client }: { client: CofluxClient }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(() => localStorage.getItem(WORKSPACE_KEY));
  const [dismissedErrorId, setDismissedErrorId] = useState<number | null>(null);

  useEffect(() => {
    if (client.snapshotRevision === 0) return;
    if (selectedWorkspaceId && client.workspaces.some((workspace) => workspace.id === selectedWorkspaceId)) {
      localStorage.setItem(WORKSPACE_KEY, selectedWorkspaceId);
      return;
    }

    const firstProject = [...client.projects].sort((left, right) => left.createdAt - right.createdAt)[0];
    const fallback = firstProject
      ? client.workspaces.find((workspace) => workspace.projectId === firstProject.id && workspace.isMain)
      : client.workspaces[0];
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

  function importProject() {
    const onlineDaemons = client.daemons.filter((daemon) => daemon.online);
    if (onlineDaemons.length === 0) {
      window.alert("当前没有在线设备，请先添加或启动一台设备");
      return;
    }

    let daemonId = onlineDaemons[0].daemonId;
    if (onlineDaemons.length > 1) {
      const options = onlineDaemons.map((daemon, index) => `${index + 1}. ${daemon.name}`).join("\n");
      const choice = window.prompt(`选择仓库所在设备：\n${options}`, "1");
      const index = Number(choice) - 1;
      if (!(index >= 0 && index < onlineDaemons.length)) return;
      daemonId = onlineDaemons[index].daemonId;
    }

    const path = window.prompt("输入该设备上的 git 仓库绝对路径");
    if (path?.trim()) client.send({ type: "project.import", daemonId, path: path.trim() });
  }

  function createWorkspace(project: Project) {
    const name = window.prompt("工作区名称", "feature");
    if (!name?.trim()) return;
    const branch = window.prompt("分支名", name.trim())?.trim() || name.trim();
    const createNew = window.confirm("是否从当前 HEAD 创建新分支？\n\n取消将检出已有分支。");
    client.send({ type: "workspace.create", projectId: project.id, name: name.trim(), branch, createNew });
  }

  function removeProject(project: Project) {
    if (window.confirm(`移除项目「${project.name}」？\n\n只会移除 coflux 记录与其子工作区，不会改动主仓库。`)) {
      client.send({ type: "project.remove", projectId: project.id });
    }
  }

  function removeWorkspace(workspace: Workspace) {
    if (window.confirm(`删除工作区「${workspace.name}」？\n\n对应的 git worktree 目录会被移除。`)) {
      client.send({ type: "workspace.remove", workspaceId: workspace.id });
    }
  }

  function removeDevice(daemon: DaemonInfo) {
    if (window.confirm(`移除设备「${daemon.name}」？\n\n其下的所有项目、工作区和终端记录也会删除。`)) {
      client.send({ type: "client.removeDevice", daemonId: daemon.daemonId });
    }
  }

  function closeTask(task: Task) {
    if (task.status === "running" && !window.confirm(`关闭终端「${task.title}」？\n\n正在运行的 shell 会先停止，随后删除此 Tab。`)) return;
    client.send({ type: "task.stop", taskId: task.id });
    client.send({ type: "task.remove", taskId: task.id });
  }

  async function copyEnrollCommand() {
    if (!client.enrollCommand) return;
    try {
      await navigator.clipboard.writeText(client.enrollCommand);
    } catch {
      window.prompt("浏览器无法自动复制，请手动复制以下命令", client.enrollCommand);
    }
  }

  const selectedWorkspace = client.workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? null;
  const showError = client.lastError && client.lastError.id !== dismissedErrorId;

  return (
    <div className="flex h-screen min-h-[640px] min-w-[1024px] overflow-hidden bg-background text-foreground">
      {client.authState !== "authed" && (
        <div className="login">
          <form className="login-card" onSubmit={login}>
            <div className="brand-lg">coflux</div>
            <p className="login-hint">{USE_SUPABASE ? "用邮箱 + 密码登录" : "用用户名 + 密码登录"}</p>
            <input
              autoFocus
              type={USE_SUPABASE ? "email" : "text"}
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder={USE_SUPABASE ? "邮箱" : "用户名"}
              autoComplete={USE_SUPABASE ? "email" : "username"}
            />
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="密码"
              autoComplete="current-password"
            />
            <button type="submit">登录</button>
            {client.authState === "authenticating" && <div className="login-status">连接中…</div>}
            {client.authState === "auth-failed" && <div className="login-status err">{client.loginError || "登录失败"}</div>}
          </form>
        </div>
      )}

      <Sidebar
        client={client}
        selectedWorkspaceId={selectedWorkspaceId}
        onSelectWorkspace={selectWorkspace}
        onImportProject={importProject}
        onCreateWorkspace={createWorkspace}
        onRemoveProject={removeProject}
        onRemoveWorkspace={removeWorkspace}
        onAddDevice={client.requestEnrollmentKey}
        onRemoveDevice={removeDevice}
        onCopyEnrollCommand={copyEnrollCommand}
      />

      {selectedWorkspace ? (
        <WorkspaceTerminal key={selectedWorkspace.id} workspace={selectedWorkspace} client={client} onCloseTask={closeTask} />
      ) : (
        <main className="flex min-w-0 flex-1 items-center justify-center bg-terminal">
          <div className="flex max-w-sm flex-col items-center text-center">
            <div className="mb-4 flex size-12 items-center justify-center rounded-xl border border-border bg-card text-muted-foreground shadow-sm">
              <FolderGit2 className="size-6" />
            </div>
            <h1 className="text-sm font-medium">选择一个工作区</h1>
            <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
              {client.projects.length === 0 ? "先导入在线设备上的 git 仓库，主工作区会自动创建。" : "从左侧项目或子工作区进入终端工作台。"}
            </p>
            {client.projects.length === 0 && (
              <Button className="mt-5" size="sm" onClick={importProject}>导入项目</Button>
            )}
          </div>
        </main>
      )}

      {showError && client.lastError && (
        <div className="fixed bottom-4 right-4 z-40 flex max-w-md items-start gap-3 rounded-lg border border-destructive/30 bg-popover px-4 py-3 text-sm shadow-2xl">
          <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
          <span className="leading-5 text-foreground">{client.lastError.message}</span>
          <button className="ml-2 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => setDismissedErrorId(client.lastError!.id)} title="关闭">
            <X className="size-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}
