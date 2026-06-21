import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { ClientToServer, ServerToClient, DaemonInfo, Project, Workspace, Task } from "@coflux/protocol";

// 默认连同源（由 vite dev server 代理到后端）；可用 VITE_COFLUX_SERVER 覆盖
const SERVER_URL =
  import.meta.env.VITE_COFLUX_SERVER ??
  `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/client`;
const TOKEN_KEY = "coflux_token";

const STATUS_LABEL: Record<Task["status"], string> = { idle: "未启动", running: "运行中", exited: "已结束" };
type AuthState = "need-login" | "authenticating" | "authed" | "auth-failed";

export function App() {
  const hostRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const activeSessionRef = useRef<string | null>(null);
  const activeTaskRef = useRef<string | null>(null);
  const tokenRef = useRef<string>("");
  const stopReconnectRef = useRef(false);
  const shouldRetryRef = useRef(false);

  const [status, setStatus] = useState<"connecting" | "connected" | "disconnected">("connecting");
  const [authState, setAuthState] = useState<AuthState>("need-login");
  const [tokenInput, setTokenInput] = useState(localStorage.getItem(TOKEN_KEY) ?? "dev-client");
  const [daemons, setDaemons] = useState<DaemonInfo[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);

  const send = (msg: ClientToServer) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  useEffect(() => {
    const term = new Terminal({
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 13,
      cursorBlink: true,
      theme: { background: "#1a1b26", foreground: "#c0caf5" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current!);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    term.onData((data) => {
      if (activeSessionRef.current) send({ type: "pty.input", sessionId: activeSessionRef.current, data });
    });
    term.onResize(({ cols, rows }) => {
      if (activeSessionRef.current) send({ type: "pty.resize", sessionId: activeSessionRef.current, cols, rows });
    });

    const onWindowResize = () => fit.fit();
    window.addEventListener("resize", onWindowResize);

    const saved = localStorage.getItem(TOKEN_KEY);
    if (saved) connect(saved);

    return () => {
      window.removeEventListener("resize", onWindowResize);
      stopReconnectRef.current = true;
      wsRef.current?.close();
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function connect(token: string) {
    tokenRef.current = token;
    stopReconnectRef.current = false;
    setAuthState("authenticating");
    setStatus("connecting");
    const ws = new WebSocket(SERVER_URL);
    wsRef.current = ws;
    ws.onopen = () => {
      setStatus("connected");
      send({ type: "client.auth", clientToken: token });
    };
    ws.onclose = () => {
      setStatus("disconnected");
      if (!stopReconnectRef.current && shouldRetryRef.current) setTimeout(() => connect(tokenRef.current), 1500);
    };
    ws.onmessage = (ev) => {
      let msg: ServerToClient;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      handleServerMessage(msg);
    };
  }

  function login(e: React.FormEvent) {
    e.preventDefault();
    localStorage.setItem(TOKEN_KEY, tokenInput);
    connect(tokenInput);
  }
  function logout() {
    stopReconnectRef.current = true;
    shouldRetryRef.current = false;
    localStorage.removeItem(TOKEN_KEY);
    wsRef.current?.close();
    setAuthState("need-login");
    setDaemons([]);
    setProjects([]);
    setWorkspaces([]);
    setTasks([]);
  }

  function handleServerMessage(msg: ServerToClient) {
    const term = termRef.current!;
    const fit = fitRef.current!;
    switch (msg.type) {
      case "auth.ok":
        setAuthState("authed");
        shouldRetryRef.current = true;
        send({ type: "client.subscribe" });
        break;
      case "auth.error":
        setAuthState("auth-failed");
        shouldRetryRef.current = false;
        break;
      case "state.snapshot":
        setDaemons(msg.daemons);
        setProjects(msg.projects);
        setWorkspaces(msg.workspaces);
        setTasks(msg.tasks);
        if (activeTaskRef.current) {
          const t = msg.tasks.find((x) => x.id === activeTaskRef.current);
          if (t && t.status === "running" && t.sessionId) {
            activeSessionRef.current = t.sessionId;
            term.clear();
            send({ type: "task.attach", taskId: t.id });
          }
        }
        break;
      case "daemon.updated":
        setDaemons((prev) => upsert(prev, msg.daemon, (d) => d.daemonId === msg.daemon.daemonId));
        break;
      case "daemon.removed":
        setDaemons((prev) => prev.filter((d) => d.daemonId !== msg.daemonId));
        setProjects((prev) => prev.filter((p) => p.daemonId !== msg.daemonId));
        setWorkspaces((prev) => prev.filter((w) => w.daemonId !== msg.daemonId));
        setTasks((prev) => prev.filter((t) => t.daemonId !== msg.daemonId));
        break;
      case "project.created":
        setProjects((prev) => upsert(prev, msg.project, (p) => p.id === msg.project.id));
        break;
      case "project.removed":
        setProjects((prev) => prev.filter((p) => p.id !== msg.projectId));
        setWorkspaces((prev) => prev.filter((w) => w.projectId !== msg.projectId));
        setTasks((prev) => prev.filter((t) => t.projectId !== msg.projectId));
        break;
      case "workspace.created":
        setWorkspaces((prev) => upsert(prev, msg.workspace, (w) => w.id === msg.workspace.id));
        break;
      case "workspace.removed":
        setWorkspaces((prev) => prev.filter((w) => w.id !== msg.workspaceId));
        setTasks((prev) => prev.filter((t) => t.workspaceId !== msg.workspaceId));
        break;
      case "task.updated": {
        setTasks((prev) => upsert(prev, msg.task, (t) => t.id === msg.task.id));
        if (msg.task.id === activeTaskRef.current && msg.task.status === "running" && msg.task.sessionId) {
          if (activeSessionRef.current !== msg.task.sessionId) {
            activeSessionRef.current = msg.task.sessionId;
            fit.fit();
            send({ type: "pty.resize", sessionId: msg.task.sessionId, cols: term.cols, rows: term.rows });
            term.focus();
          }
        }
        break;
      }
      case "task.removed":
        setTasks((prev) => prev.filter((t) => t.id !== msg.taskId));
        if (msg.taskId === activeTaskRef.current) clearActive();
        break;
      case "task.detached":
        // 控制权被其它客户端接管：放弃控制（保留当前画面作为记录），需要时可重新点开夺回
        if (msg.taskId === activeTaskRef.current) {
          term.writeln("\r\n\x1b[33m[控制权已被其它客户端接管，此终端已断开。点任务可夺回控制权]\x1b[0m");
          activeTaskRef.current = null;
          activeSessionRef.current = null;
          setActiveTaskId(null);
        }
        break;
      case "pty.output":
        if (msg.sessionId === activeSessionRef.current) term.write(msg.data);
        break;
      case "error":
        term.writeln(`\r\n\x1b[31m[错误] ${msg.message}\x1b[0m`);
        break;
    }
  }

  function clearActive() {
    activeTaskRef.current = null;
    activeSessionRef.current = null;
    setActiveTaskId(null);
    termRef.current?.clear();
  }

  function openTask(task: Task) {
    const term = termRef.current!;
    activeTaskRef.current = task.id;
    setActiveTaskId(task.id);
    term.clear();
    activeSessionRef.current = task.status === "running" && task.sessionId ? task.sessionId : null;
    fitRef.current?.fit();
    send({ type: "task.start", taskId: task.id, cols: term.cols, rows: term.rows });
    term.focus();
  }

  function importProject() {
    const online = daemons.filter((d) => d.online);
    if (online.length === 0) {
      alert("无在线设备，请先在某台机器上启动 daemon");
      return;
    }
    let daemonId = online[0].daemonId;
    if (online.length > 1) {
      const list = online.map((d, i) => `${i + 1}. ${d.name}`).join("\n");
      const pick = window.prompt(`选择设备：\n${list}`, "1");
      const idx = Number(pick) - 1;
      if (!(idx >= 0 && idx < online.length)) return;
      daemonId = online[idx].daemonId;
    }
    const path = window.prompt("git 仓库绝对路径（该设备上已存在）");
    if (!path) return;
    send({ type: "project.import", daemonId, path });
  }
  function createWorkspace(projectId: string) {
    const name = window.prompt("工作区名称（用于分支/目录名）", "feature");
    if (!name) return;
    const branch = window.prompt("分支名", name) || name;
    const createNew = window.confirm("创建新分支？\n\n确定 = 从当前 HEAD 新建分支\n取消 = 检出已有分支");
    send({ type: "workspace.create", projectId, name, branch, createNew });
  }
  function createTask(workspaceId: string) {
    const title = window.prompt("任务标题", "终端") ?? "终端";
    send({ type: "task.create", workspaceId, title });
  }
  const stop = (e: React.MouseEvent, taskId: string) => { e.stopPropagation(); send({ type: "task.stop", taskId }); };
  const removeTask = (e: React.MouseEvent, taskId: string) => { e.stopPropagation(); if (confirm("删除该任务？")) send({ type: "task.remove", taskId }); };
  const removeWorkspace = (id: string) => { if (confirm("删除该工作区？（git worktree 会被移除）")) send({ type: "workspace.remove", workspaceId: id }); };
  const removeProject = (id: string) => { if (confirm("删除该项目？（仅移除 coflux 记录与其 worktree，不动你的主仓库）")) send({ type: "project.remove", projectId: id }); };
  const removeDevice = (d: DaemonInfo) => { if (confirm(`移除设备 ${d.name}？将删除其下所有项目/工作区/任务。`)) send({ type: "client.removeDevice", daemonId: d.daemonId }); };

  const wsOf = (projectId: string) =>
    workspaces.filter((w) => w.projectId === projectId).sort((a, b) => (a.isMain === b.isMain ? a.createdAt - b.createdAt : a.isMain ? -1 : 1));

  return (
    <div className="app">
      {authState !== "authed" && (
        <div className="login">
          <form className="login-card" onSubmit={login}>
            <div className="brand-lg">coflux</div>
            <p className="login-hint">输入账号登录令牌（默认 <code>dev-client</code>）</p>
            <input autoFocus type="password" value={tokenInput} onChange={(e) => setTokenInput(e.target.value)} placeholder="client token" />
            <button type="submit">登录</button>
            {authState === "authenticating" && <div className="login-status">连接中…</div>}
            {authState === "auth-failed" && <div className="login-status err">登录失败：令牌无效</div>}
          </form>
        </div>
      )}
      <div className="sidebar">
        <div className="sidebar-head">
          <span className="brand">coflux</span>
          <span className={`status ${status}`}>{status}</span>
          <span className="spacer" />
          <button className="mini" onClick={logout} title="退出登录">退出</button>
        </div>

        <div className="section-head">
          <span>项目</span>
          <button className="mini" onClick={importProject} title="导入 git 仓库为项目">＋ 导入项目</button>
        </div>
        {projects.length === 0 && <div className="empty">还没有项目，点「导入项目」选一个 git 仓库</div>}
        {projects.map((p) => {
          const dev = daemons.find((d) => d.daemonId === p.daemonId);
          return (
            <div key={p.id} className="project">
              <div className="project-head">
                <span className="project-name" title={p.repoPath}>{p.name}</span>
                {dev && <span className={`device-badge ${dev.online ? "on" : "off"}`} title={`${dev.host}/${dev.platform}`}>{dev.name}</span>}
                <button className="mini" title="新建工作区（git worktree）" onClick={() => createWorkspace(p.id)}>＋ws</button>
                <button className="mini danger" title="删除项目" onClick={() => removeProject(p.id)}>✕</button>
              </div>
              {wsOf(p.id).map((w) => (
                <div key={w.id} className="workspace">
                  <div className="workspace-head">
                    <span className="workspace-name" title={w.path}>{w.name}</span>
                    <span className="branch-badge" title="分支">{w.branch}</span>
                    {w.isMain && <span className="main-badge">主</span>}
                    <button className="mini" title="新建任务" onClick={() => createTask(w.id)}>＋task</button>
                    {!w.isMain && <button className="mini danger" title="删除工作区" onClick={() => removeWorkspace(w.id)}>✕</button>}
                  </div>
                  {tasks.filter((t) => t.workspaceId === w.id).map((t) => (
                    <div key={t.id} className={`task ${t.id === activeTaskId ? "active" : ""}`} onClick={() => openTask(t)}>
                      <span className={`task-status ${t.status}`}>{STATUS_LABEL[t.status]}</span>
                      <span className="task-title">{t.title}</span>
                      <span className="task-actions">
                        {t.status === "running" && <button className="mini" title="停止" onClick={(e) => stop(e, t.id)}>■</button>}
                        <button className="mini danger" title="删除" onClick={(e) => removeTask(e, t.id)}>✕</button>
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
        </div>
        {daemons.length === 0 && <div className="empty">无设备</div>}
        {daemons.map((d) => (
          <div key={d.daemonId} className="device-row">
            <span className={`dot ${d.online ? "on" : "off"}`} />
            <span className="device-row-name" title={`${d.host}/${d.platform}`}>{d.name}</span>
            <button className="mini danger" title="移除设备" onClick={() => removeDevice(d)}>✕</button>
          </div>
        ))}
      </div>
      <div className="terminal-host" ref={hostRef} />
    </div>
  );
}

function upsert<T>(list: T[], item: T, match: (x: T) => boolean): T[] {
  const i = list.findIndex(match);
  if (i === -1) return [...list, item];
  const next = list.slice();
  next[i] = item;
  return next;
}
