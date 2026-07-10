import { useCallback, useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { DaemonInfo, Task } from "@coflux/protocol";

import { USE_SUPABASE } from "@/config";
import type { CofluxClient } from "@/hooks/use-coflux-client";

const STATUS_LABEL: Record<Task["status"], string> = { idle: "未启动", running: "运行中", exited: "已结束" };

/** 协议拆分阶段保留的旧视图；下一里程碑会由工作区 Tab 工作台整体替换。 */
export function LegacyWorkbench({ client }: { client: CofluxClient }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const activeSessionRef = useRef<string | null>(null);
  const activeTaskRef = useRef<string | null>(null);
  const unregisterConsumerRef = useRef<(() => void) | null>(null);
  const detachedTaskIdsRef = useRef(client.detachedTaskIds);
  const tasksRef = useRef(client.tasks);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);

  detachedTaskIdsRef.current = client.detachedTaskIds;
  tasksRef.current = client.tasks;

  const bindSession = useCallback(
    (sessionId: string) => {
      if (activeSessionRef.current === sessionId) return;
      unregisterConsumerRef.current?.();
      activeSessionRef.current = sessionId;
      unregisterConsumerRef.current = client.registerSessionConsumer(sessionId, (data) => terminalRef.current?.write(data));
    },
    [client.registerSessionConsumer],
  );

  const clearActive = useCallback(() => {
    unregisterConsumerRef.current?.();
    unregisterConsumerRef.current = null;
    activeTaskRef.current = null;
    activeSessionRef.current = null;
    setActiveTaskId(null);
    terminalRef.current?.clear();
  }, []);

  useEffect(() => {
    const terminal = new Terminal({
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 13,
      cursorBlink: true,
      theme: { background: "#111214", foreground: "#e7e9ee" },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(hostRef.current!);
    fit.fit();
    terminalRef.current = terminal;
    fitRef.current = fit;

    const dataDisposable = terminal.onData((data) => {
      const taskId = activeTaskRef.current;
      const sessionId = activeSessionRef.current;
      if (taskId && sessionId && !detachedTaskIdsRef.current.has(taskId)) client.sendInput(sessionId, data);
    });
    const resizeDisposable = terminal.onResize(({ cols, rows }) => {
      const taskId = activeTaskRef.current;
      const sessionId = activeSessionRef.current;
      if (taskId && sessionId && !detachedTaskIdsRef.current.has(taskId)) {
        client.send({ type: "pty.resize", sessionId, cols, rows });
      }
    });
    const onWindowResize = () => fit.fit();
    window.addEventListener("resize", onWindowResize);

    return () => {
      window.removeEventListener("resize", onWindowResize);
      dataDisposable.dispose();
      resizeDisposable.dispose();
      unregisterConsumerRef.current?.();
      terminal.dispose();
    };
  }, [client.send, client.sendInput]);

  useEffect(() => {
    if (!activeTaskId) return;
    const task = client.tasks.find((item) => item.id === activeTaskId);
    if (!task) {
      clearActive();
      return;
    }
    if (task.status === "running" && task.sessionId) {
      bindSession(task.sessionId);
      fitRef.current?.fit();
      terminalRef.current?.focus();
    }
  }, [activeTaskId, bindSession, clearActive, client.tasks]);

  useEffect(() => {
    const taskId = activeTaskRef.current;
    if (!taskId || !client.detachedTaskIds.has(taskId)) return;
    terminalRef.current?.writeln("\r\n\x1b[33m[控制权已被其它客户端接管，此终端已断开。再次打开可夺回控制权]\x1b[0m");
    unregisterConsumerRef.current?.();
    unregisterConsumerRef.current = null;
    activeTaskRef.current = null;
    activeSessionRef.current = null;
    setActiveTaskId(null);
  }, [client.detachedTaskIds]);

  useEffect(() => {
    if (!client.lastError) return;
    terminalRef.current?.writeln(`\r\n\x1b[31m[错误] ${client.lastError.message}\x1b[0m`);
  }, [client.lastError]);

  useEffect(() => {
    const taskId = activeTaskRef.current;
    if (!taskId) return;
    const task = tasksRef.current.find((item) => item.id === taskId);
    if (!task || task.status !== "running" || !task.sessionId) return;
    bindSession(task.sessionId);
    client.send({ type: "task.attach", taskId });
  }, [bindSession, client.send, client.snapshotRevision]);

  function openTask(task: Task) {
    const terminal = terminalRef.current;
    if (!terminal) return;
    activeTaskRef.current = task.id;
    setActiveTaskId(task.id);
    terminal.clear();
    unregisterConsumerRef.current?.();
    unregisterConsumerRef.current = null;
    activeSessionRef.current = null;
    if (task.status === "running" && task.sessionId) bindSession(task.sessionId);
    fitRef.current?.fit();
    client.startTask(task.id, terminal.cols, terminal.rows);
    terminal.focus();
  }

  async function login(event: React.FormEvent) {
    event.preventDefault();
    await client.login(username, password);
  }

  function importProject() {
    const online = client.daemons.filter((daemon) => daemon.online);
    if (online.length === 0) {
      alert("无在线设备，请先在某台机器上启动 daemon");
      return;
    }
    let daemonId = online[0].daemonId;
    if (online.length > 1) {
      const list = online.map((daemon, index) => `${index + 1}. ${daemon.name}`).join("\n");
      const pick = window.prompt(`选择设备：\n${list}`, "1");
      const index = Number(pick) - 1;
      if (!(index >= 0 && index < online.length)) return;
      daemonId = online[index].daemonId;
    }
    const path = window.prompt("git 仓库绝对路径（该设备上已存在）");
    if (path) client.send({ type: "project.import", daemonId, path });
  }

  function createWorkspace(projectId: string) {
    const name = window.prompt("工作区名称（用于分支/目录名）", "feature");
    if (!name) return;
    const branch = window.prompt("分支名", name) || name;
    const createNew = window.confirm("创建新分支？\n\n确定 = 从当前 HEAD 新建分支\n取消 = 检出已有分支");
    client.send({ type: "workspace.create", projectId, name, branch, createNew });
  }

  function createTask(workspaceId: string) {
    const title = window.prompt("任务标题", "终端") ?? "终端";
    client.send({ type: "task.create", workspaceId, title });
  }

  function removeWorkspace(workspaceId: string) {
    if (confirm("删除该工作区？（git worktree 会被移除）")) client.send({ type: "workspace.remove", workspaceId });
  }

  function removeProject(projectId: string) {
    if (confirm("删除该项目？（仅移除 coflux 记录与其 worktree，不动你的主仓库）")) {
      client.send({ type: "project.remove", projectId });
    }
  }

  function removeDevice(daemon: DaemonInfo) {
    if (confirm(`移除设备 ${daemon.name}？将删除其下所有项目/工作区/任务。`)) {
      client.send({ type: "client.removeDevice", daemonId: daemon.daemonId });
    }
  }

  async function copyEnrollCommand() {
    if (!client.enrollCommand) return;
    try {
      await navigator.clipboard.writeText(client.enrollCommand);
    } catch {
      window.prompt("复制以下命令：", client.enrollCommand);
    }
  }

  const workspacesOf = (projectId: string) =>
    client.workspaces
      .filter((workspace) => workspace.projectId === projectId)
      .sort((left, right) => (left.isMain === right.isMain ? left.createdAt - right.createdAt : left.isMain ? -1 : 1));

  return (
    <div className="app">
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

      <div className="sidebar">
        <div className="sidebar-head">
          <span className="brand">coflux</span>
          <span className={`status ${client.status}`}>{client.status}</span>
          <span className="spacer" />
          <button className="mini" onClick={client.logout} title="退出登录">退出</button>
        </div>

        <div className="section-head">
          <span>项目</span>
          <button className="mini" onClick={importProject} title="导入 git 仓库为项目">＋ 导入项目</button>
        </div>
        {client.projects.length === 0 && <div className="empty">还没有项目，点「导入项目」选一个 git 仓库</div>}
        {client.projects.map((project) => {
          const daemon = client.daemons.find((item) => item.daemonId === project.daemonId);
          return (
            <div key={project.id} className="project">
              <div className="project-head">
                <span className="project-name" title={project.repoPath}>{project.name}</span>
                {daemon && <span className={`device-badge ${daemon.online ? "on" : "off"}`} title={`${daemon.host}/${daemon.platform}`}>{daemon.name}</span>}
                <button className="mini" title="新建工作区（git worktree）" onClick={() => createWorkspace(project.id)}>＋ws</button>
                <button className="mini danger" title="删除项目" onClick={() => removeProject(project.id)}>✕</button>
              </div>
              {workspacesOf(project.id).map((workspace) => (
                <div key={workspace.id} className="workspace">
                  <div className="workspace-head">
                    <span className="workspace-name" title={workspace.path}>{workspace.name}</span>
                    <span className="branch-badge" title="分支">{workspace.branch}</span>
                    {workspace.isMain && <span className="main-badge">主</span>}
                    <button className="mini" title="新建任务" onClick={() => createTask(workspace.id)}>＋task</button>
                    {!workspace.isMain && <button className="mini danger" title="删除工作区" onClick={() => removeWorkspace(workspace.id)}>✕</button>}
                  </div>
                  {client.tasks.filter((task) => task.workspaceId === workspace.id).map((task) => (
                    <div key={task.id} className={`task ${task.id === activeTaskId ? "active" : ""}`} onClick={() => openTask(task)}>
                      <span className={`task-status ${task.status}`}>{STATUS_LABEL[task.status]}</span>
                      <span className="task-title">{task.title}</span>
                      {(client.ports[task.id] ?? []).map((preview) => (
                        <a key={preview.port} className="port-badge" href={preview.url} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>
                          :{preview.port}
                        </a>
                      ))}
                      <span className="task-actions">
                        {task.status === "running" && <button className="mini" title="停止" onClick={(event) => { event.stopPropagation(); client.send({ type: "task.stop", taskId: task.id }); }}>■</button>}
                        <button className="mini danger" title="删除" onClick={(event) => { event.stopPropagation(); if (confirm("删除该任务？")) client.send({ type: "task.remove", taskId: task.id }); }}>✕</button>
                      </span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          );
        })}

        <div className="section-head devices-head">
          <span>设备</span>
          <button className="mini" onClick={client.requestEnrollmentKey} title="生成登记命令，在新机器上安装 daemon">＋ 添加设备</button>
        </div>
        {client.enrollCommand && (
          <div className="enroll-panel">
            <div className="enroll-title">在新机器上运行：</div>
            <pre className="enroll-cmd">{client.enrollCommand}</pre>
            <div className="enroll-actions">
              <button className="mini" onClick={copyEnrollCommand}>复制</button>
              <button className="mini" onClick={client.clearEnrollmentCommand}>关闭</button>
            </div>
            <p className="enroll-hint">运行后设备会自动出现在列表中</p>
          </div>
        )}
        {client.daemons.length === 0 && !client.enrollCommand && <div className="empty">还没有设备，点「添加设备」获取安装命令</div>}
        {client.daemons.map((daemon) => (
          <div key={daemon.daemonId} className="device-row">
            <span className={`dot ${daemon.online ? "on" : "off"}`} />
            <span className="device-row-name" title={`${daemon.host}/${daemon.platform}`}>{daemon.name}</span>
            <button className="mini danger" title="移除设备" onClick={() => removeDevice(daemon)}>✕</button>
          </div>
        ))}
      </div>
      <div className="terminal-host" ref={hostRef} />
    </div>
  );
}
