import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { encodeFrame, decodeFrame, type ClientToServer, type ServerToClient, type DaemonInfo, type Project, type Workspace, type Task } from "@coflux/protocol";

// 默认连同源（由 vite dev server 代理到后端）；可用 VITE_COFLUX_SERVER 覆盖
const SERVER_URL =
  import.meta.env.VITE_COFLUX_SERVER ??
  `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/client`;
const TOKEN_KEY = "coflux_token";

// Supabase 登录：仅当两个 build-time env 都设置时启用（email+password 换 access_token）。
// 未设时维持现状（用户名+密码直连 server）。不引 supabase-js SDK，只 fetch 一个 token 端点。
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL?.replace(/\/+$/, "");
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
const USE_SUPABASE = !!(SUPABASE_URL && SUPABASE_ANON_KEY);

const STATUS_LABEL: Record<Task["status"], string> = { idle: "未启动", running: "运行中", exited: "已结束" };
type AuthState = "need-login" | "authenticating" | "authed" | "auth-failed";

/** 无路由单页：先按路径分支，再决定渲染哪棵组件树——授权页/预览门禁页与主 app 各起各的 WS 连接，
 * 互不干扰（尤其不能让这些页也触发主 app 的 xterm/自动重连副作用，见 plan 003 landmine）。 */
export function App() {
  const m = /^\/authorize\/([^/]+)\/?$/.exec(location.pathname);
  if (m) return <AuthorizePage token={decodeURIComponent(m[1])} />;
  if (location.pathname === "/proxy-auth") return <ProxyAuthPage />;
  return <MainApp />;
}

function MainApp() {
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
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState<string>("");
  const [daemons, setDaemons] = useState<DaemonInfo[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [enrollCommand, setEnrollCommand] = useState<string | null>(null);
  // 端口转发（plan 006）：taskId -> 该任务当前可访问的端口/预览链接列表
  const [ports, setPorts] = useState<Record<string, { port: number; url: string }[]>>({});

  const send = (msg: ClientToServer) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };
  // 数据面：pty.input 以二进制帧发送
  const sendInput = (sessionId: string, data: string) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(encodeFrame({ type: "pty.input", sessionId, data }));
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
      if (activeSessionRef.current) sendInput(activeSessionRef.current, data);
    });
    term.onResize(({ cols, rows }) => {
      if (activeSessionRef.current) send({ type: "pty.resize", sessionId: activeSessionRef.current, cols, rows });
    });

    const onWindowResize = () => fit.fit();
    window.addEventListener("resize", onWindowResize);

    const saved = localStorage.getItem(TOKEN_KEY); // 已签发的会话 token
    if (saved) {
      tokenRef.current = saved;
      connect({ token: saved });
    }

    return () => {
      window.removeEventListener("resize", onWindowResize);
      stopReconnectRef.current = true;
      wsRef.current?.close();
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function connect(cred: { token: string } | { supabaseToken: string } | { username: string; password: string }) {
    stopReconnectRef.current = false;
    setAuthState("authenticating");
    setStatus("connecting");
    const ws = new WebSocket(SERVER_URL);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;
    ws.onopen = () => {
      setStatus("connected");
      // 重连用 coflux 会话 token；首次登录用 supabaseToken 换票（supabase 模式）或用户名+密码（local 模式）。
      if ("token" in cred) send({ type: "client.auth", clientToken: cred.token });
      else if ("supabaseToken" in cred) send({ type: "client.auth", supabaseToken: cred.supabaseToken });
      else send({ type: "client.auth", username: cred.username, password: cred.password });
    };
    ws.onclose = () => {
      setStatus("disconnected");
      // 重连用已签发的会话 token（不重发密码）
      if (!stopReconnectRef.current && shouldRetryRef.current && tokenRef.current) setTimeout(() => connect({ token: tokenRef.current }), 1500);
    };
    ws.onmessage = (ev) => {
      // 数据面：二进制帧（pty.output）→ 直接写入终端
      if (ev.data instanceof ArrayBuffer) {
        const frame = decodeFrame(new Uint8Array(ev.data));
        if (frame && frame.type === "pty.output" && frame.sessionId === activeSessionRef.current) termRef.current?.write(frame.data);
        return;
      }
      let msg: ServerToClient;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      handleServerMessage(msg);
    };
  }

  async function login(e: React.FormEvent) {
    e.preventDefault();
    setLoginError("");
    if (!USE_SUPABASE) {
      connect({ username, password });
      return;
    }
    // Supabase 模式：email+password 换 access_token（一个 fetch，不引 SDK），再经 WS 换票。
    setAuthState("authenticating");
    try {
      const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
        method: "POST",
        headers: { "content-type": "application/json", apikey: SUPABASE_ANON_KEY! },
        body: JSON.stringify({ email: username, password }),
      });
      if (!res.ok) {
        setLoginError("邮箱或密码错误");
        setAuthState("auth-failed");
        return;
      }
      const data = await res.json();
      if (!data?.access_token) {
        setLoginError("登录失败：未获得访问令牌");
        setAuthState("auth-failed");
        return;
      }
      connect({ supabaseToken: data.access_token });
    } catch {
      setLoginError("网络错误：无法连接认证服务");
      setAuthState("auth-failed");
    }
  }
  function logout() {
    stopReconnectRef.current = true;
    shouldRetryRef.current = false;
    // 请服务器撤销该会话 token（不止清本地），撤销后旧 token 无法再重连
    if (wsRef.current?.readyState === WebSocket.OPEN) send({ type: "client.logout" });
    tokenRef.current = "";
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
        setLoginError("");
        shouldRetryRef.current = true;
        if (msg.clientToken) {
          // 登录签发的会话 token：存下来用于重连（密码不落盘）
          tokenRef.current = msg.clientToken;
          localStorage.setItem(TOKEN_KEY, msg.clientToken);
        }
        send({ type: "client.subscribe" });
        break;
      case "auth.error":
        // token 过期/被撤销（或凭证错误）：清掉本地坏 token，避免每次刷新都用死 token 自动重连
        tokenRef.current = "";
        localStorage.removeItem(TOKEN_KEY);
        setLoginError(USE_SUPABASE ? "登录失败：会话已过期或凭证无效，请重新登录" : "登录失败：用户名或密码错误");
        setAuthState("auth-failed");
        shouldRetryRef.current = false;
        break;
      case "state.snapshot": {
        setDaemons(msg.daemons);
        setProjects(msg.projects);
        setWorkspaces(msg.workspaces);
        setTasks(msg.tasks);
        const nextPorts: Record<string, { port: number; url: string }[]> = {};
        for (const p of msg.ports ?? []) (nextPorts[p.taskId] ??= []).push({ port: p.port, url: p.url });
        setPorts(nextPorts);
        if (activeTaskRef.current) {
          const t = msg.tasks.find((x) => x.id === activeTaskRef.current);
          if (t && t.status === "running" && t.sessionId) {
            activeSessionRef.current = t.sessionId;
            term.clear();
            send({ type: "task.attach", taskId: t.id });
          }
        }
        break;
      }
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
        setPorts((prev) => {
          if (!(msg.taskId in prev)) return prev;
          const next = { ...prev };
          delete next[msg.taskId];
          return next;
        });
        if (msg.taskId === activeTaskRef.current) clearActive();
        break;
      case "ports.updated":
        setPorts((prev) => ({ ...prev, [msg.taskId]: msg.ports }));
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
      case "enrollmentKey.created":
        setEnrollCommand(`npm i -g cofluxd && cofluxd up --server ${msg.daemonUrl} --enroll-key ${msg.enrollmentKey}`);
        break;
      // pty.output 走二进制数据面（见 ws.onmessage 的 ArrayBuffer 分支）
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
  const addDevice = () => send({ type: "client.createEnrollmentKey" });
  const copyEnrollCommand = async () => {
    if (!enrollCommand) return;
    try {
      await navigator.clipboard.writeText(enrollCommand);
    } catch {
      window.prompt("复制以下命令：", enrollCommand);
    }
  };

  const wsOf = (projectId: string) =>
    workspaces.filter((w) => w.projectId === projectId).sort((a, b) => (a.isMain === b.isMain ? a.createdAt - b.createdAt : a.isMain ? -1 : 1));

  return (
    <div className="app">
      {authState !== "authed" && (
        <div className="login">
          <form className="login-card" onSubmit={login}>
            <div className="brand-lg">coflux</div>
            <p className="login-hint">{USE_SUPABASE ? "用邮箱 + 密码登录" : "用用户名 + 密码登录"}</p>
            <input
              autoFocus
              type={USE_SUPABASE ? "email" : "text"}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder={USE_SUPABASE ? "邮箱" : "用户名"}
              autoComplete={USE_SUPABASE ? "email" : "username"}
            />
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="密码" autoComplete="current-password" />
            <button type="submit">登录</button>
            {authState === "authenticating" && <div className="login-status">连接中…</div>}
            {authState === "auth-failed" && <div className="login-status err">{loginError || "登录失败"}</div>}
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
                      {(ports[t.id] ?? []).map((p) => (
                        <a
                          key={p.port}
                          className="port-badge"
                          href={p.url}
                          target="_blank"
                          rel="noreferrer"
                          title={`预览端口 ${p.port}：${p.url}`}
                          onClick={(e) => e.stopPropagation()}
                        >
                          :{p.port}
                        </a>
                      ))}
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
          <button className="mini" onClick={addDevice} title="生成登记命令，在新机器上安装 daemon">＋ 添加设备</button>
        </div>
        {enrollCommand && (
          <div className="enroll-panel">
            <div className="enroll-title">在新机器上运行：</div>
            <pre className="enroll-cmd">{enrollCommand}</pre>
            <div className="enroll-actions">
              <button className="mini" onClick={copyEnrollCommand}>复制</button>
              <button className="mini" onClick={() => setEnrollCommand(null)}>关闭</button>
            </div>
            <p className="enroll-hint">运行后设备会自动出现在列表中</p>
          </div>
        )}
        {daemons.length === 0 && !enrollCommand && <div className="empty">还没有设备，点「添加设备」获取安装命令</div>}
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

/** /authorize/<token>：Tailscale 式设备授权确认页（plan 003 M4）。
 * 独立组件树、独立 WS 连接——不碰 MainApp 的 xterm/自动重连/数据面逻辑。
 * 复用已有登录态（localStorage 里的会话 token）；没有或失效则退回登录表单，
 * 与 MainApp 用同一套 CSS（login-card/brand-lg/login-hint/login-status）。 */
type AuthorizeState =
  | { phase: "need-login" }
  | { phase: "authenticating" }
  | { phase: "auth-failed"; message: string }
  | { phase: "looking-up" }
  | { phase: "invalid"; message: string }
  | { phase: "confirm"; name?: string; host?: string; platform?: string }
  | { phase: "authorizing" }
  | { phase: "done" }
  | { phase: "failed"; message: string };

function AuthorizePage({ token }: { token: string }) {
  const wsRef = useRef<WebSocket | null>(null);
  const [state, setState] = useState<AuthorizeState>({ phase: "need-login" });
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const send = (msg: ClientToServer) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  function connect(cred: { token: string } | { supabaseToken: string } | { username: string; password: string }) {
    setState({ phase: "authenticating" });
    const ws = new WebSocket(SERVER_URL);
    wsRef.current = ws;
    ws.onopen = () => {
      if ("token" in cred) send({ type: "client.auth", clientToken: cred.token });
      else if ("supabaseToken" in cred) send({ type: "client.auth", supabaseToken: cred.supabaseToken });
      else send({ type: "client.auth", username: cred.username, password: cred.password });
    };
    ws.onclose = () => {
      setState((s) => (s.phase === "done" ? s : { phase: "failed", message: "连接已断开，请刷新页面重试" }));
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      let msg: ServerToClient;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      switch (msg.type) {
        case "auth.ok":
          setState({ phase: "looking-up" });
          send({ type: "device.authorizeInfo", token });
          break;
        case "auth.error":
          localStorage.removeItem(TOKEN_KEY);
          setState({ phase: "auth-failed", message: USE_SUPABASE ? "登录失败：会话已过期或凭证无效，请重新登录" : "登录失败：用户名或密码错误" });
          break;
        case "device.authorizeInfo":
          if (msg.ok) setState({ phase: "confirm", name: msg.name, host: msg.host, platform: msg.platform });
          else setState({ phase: "invalid", message: msg.error || "授权链接无效或已过期" });
          break;
        case "device.authorized":
          setState({ phase: "done" });
          break;
        default:
          break;
      }
    };
  }

  useEffect(() => {
    const saved = localStorage.getItem(TOKEN_KEY);
    if (saved) connect({ token: saved });
    return () => {
      wsRef.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function login(e: React.FormEvent) {
    e.preventDefault();
    if (!USE_SUPABASE) {
      connect({ username, password });
      return;
    }
    setState({ phase: "authenticating" });
    try {
      const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
        method: "POST",
        headers: { "content-type": "application/json", apikey: SUPABASE_ANON_KEY! },
        body: JSON.stringify({ email: username, password }),
      });
      if (!res.ok) {
        setState({ phase: "auth-failed", message: "邮箱或密码错误" });
        return;
      }
      const data = await res.json();
      if (!data?.access_token) {
        setState({ phase: "auth-failed", message: "登录失败：未获得访问令牌" });
        return;
      }
      connect({ supabaseToken: data.access_token });
    } catch {
      setState({ phase: "auth-failed", message: "网络错误：无法连接认证服务" });
    }
  }

  function confirm() {
    setState({ phase: "authorizing" });
    send({ type: "device.authorize", token });
  }

  const showLogin = state.phase === "need-login" || state.phase === "authenticating" || state.phase === "auth-failed";

  return (
    <div className="app">
      <div className="login">
        {showLogin ? (
          <form className="login-card" onSubmit={login}>
            <div className="brand-lg">coflux</div>
            <p className="login-hint">授权新设备 —— 请先登录你的账号</p>
            <input
              autoFocus
              type={USE_SUPABASE ? "email" : "text"}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder={USE_SUPABASE ? "邮箱" : "用户名"}
              autoComplete={USE_SUPABASE ? "email" : "username"}
            />
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="密码" autoComplete="current-password" />
            <button type="submit">登录</button>
            {state.phase === "authenticating" && <div className="login-status">连接中…</div>}
            {state.phase === "auth-failed" && <div className="login-status err">{state.message}</div>}
          </form>
        ) : (
          <div className="login-card">
            <div className="brand-lg">coflux</div>
            {state.phase === "looking-up" && <p className="login-hint">正在核对授权链接…</p>}
            {state.phase === "invalid" && <p className="login-status err">{state.message}</p>}
            {state.phase === "confirm" && (
              <>
                <p className="login-hint">授权以下设备接入你的账号：</p>
                <p>
                  <b>{state.name || "（未命名设备）"}</b>
                  <br />
                  {state.host} · {state.platform}
                </p>
                <button onClick={confirm}>授权此设备</button>
              </>
            )}
            {state.phase === "authorizing" && <p className="login-hint">正在授权…</p>}
            {state.phase === "done" && <p className="login-status">✓ 授权成功，设备已登记。可以关闭此页面了。</p>}
            {state.phase === "failed" && <p className="login-status err">{state.message}</p>}
          </div>
        )}
      </div>
    </div>
  );
}

/** /proxy-auth：端口转发预览链接的登录门禁跳转页（plan 006）。
 * 浏览器访问 `<shortId>.<proxyHost>` 未带门禁 cookie 时被 302 到这里（?to=<原始完整 URL>）；
 * 本页复用已登录态换一次性回调 URL（WS proxy.issueAuth），再把浏览器整个导航过去（该回调
 * 落在预览域上，服务器在那里种下 Domain=.<proxyHost> 的 cookie 后再 302 回原路径）。
 * 与 AuthorizePage 同构：独立组件树、独立 WS 连接，登录表单复用同一套 CSS。 */
type ProxyAuthState =
  | { phase: "need-login" }
  | { phase: "authenticating" }
  | { phase: "auth-failed"; message: string }
  | { phase: "invalid" }
  | { phase: "issuing" }
  | { phase: "failed"; message: string };

function ProxyAuthPage() {
  const wsRef = useRef<WebSocket | null>(null);
  const to = new URLSearchParams(location.search).get("to");
  const [state, setState] = useState<ProxyAuthState>(to ? { phase: "need-login" } : { phase: "invalid" });
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const send = (msg: ClientToServer) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  function connect(cred: { token: string } | { supabaseToken: string } | { username: string; password: string }) {
    setState({ phase: "authenticating" });
    const ws = new WebSocket(SERVER_URL);
    wsRef.current = ws;
    ws.onopen = () => {
      if ("token" in cred) send({ type: "client.auth", clientToken: cred.token });
      else if ("supabaseToken" in cred) send({ type: "client.auth", supabaseToken: cred.supabaseToken });
      else send({ type: "client.auth", username: cred.username, password: cred.password });
    };
    ws.onclose = () => {
      setState((s) => (s.phase === "issuing" ? s : { phase: "failed", message: "连接已断开，请刷新页面重试" }));
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      let msg: ServerToClient;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      switch (msg.type) {
        case "auth.ok":
          setState({ phase: "issuing" });
          send({ type: "proxy.issueAuth", redirect: to! });
          break;
        case "auth.error":
          localStorage.removeItem(TOKEN_KEY);
          setState({ phase: "auth-failed", message: USE_SUPABASE ? "登录失败：会话已过期或凭证无效，请重新登录" : "登录失败：用户名或密码错误" });
          break;
        case "proxy.auth":
          if (msg.ok && msg.url) location.href = msg.url; // 整页导航到预览域回调，完成后落地回原路径
          else setState({ phase: "failed", message: msg.error || "无法访问该预览链接" });
          break;
        default:
          break;
      }
    };
  }

  useEffect(() => {
    if (!to) return;
    const saved = localStorage.getItem(TOKEN_KEY);
    if (saved) connect({ token: saved });
    return () => {
      wsRef.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function login(e: React.FormEvent) {
    e.preventDefault();
    if (!USE_SUPABASE) {
      connect({ username, password });
      return;
    }
    setState({ phase: "authenticating" });
    try {
      const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
        method: "POST",
        headers: { "content-type": "application/json", apikey: SUPABASE_ANON_KEY! },
        body: JSON.stringify({ email: username, password }),
      });
      if (!res.ok) {
        setState({ phase: "auth-failed", message: "邮箱或密码错误" });
        return;
      }
      const data = await res.json();
      if (!data?.access_token) {
        setState({ phase: "auth-failed", message: "登录失败：未获得访问令牌" });
        return;
      }
      connect({ supabaseToken: data.access_token });
    } catch {
      setState({ phase: "auth-failed", message: "网络错误：无法连接认证服务" });
    }
  }

  const showLogin = state.phase === "need-login" || state.phase === "authenticating" || state.phase === "auth-failed";

  return (
    <div className="app">
      <div className="login">
        {state.phase === "invalid" ? (
          <div className="login-card">
            <div className="brand-lg">coflux</div>
            <p className="login-status err">链接无效：缺少跳转目标</p>
          </div>
        ) : showLogin ? (
          <form className="login-card" onSubmit={login}>
            <div className="brand-lg">coflux</div>
            <p className="login-hint">访问预览链接 —— 请先登录你的账号</p>
            <input
              autoFocus
              type={USE_SUPABASE ? "email" : "text"}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder={USE_SUPABASE ? "邮箱" : "用户名"}
              autoComplete={USE_SUPABASE ? "email" : "username"}
            />
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="密码" autoComplete="current-password" />
            <button type="submit">登录</button>
            {state.phase === "authenticating" && <div className="login-status">连接中…</div>}
            {state.phase === "auth-failed" && <div className="login-status err">{state.message}</div>}
          </form>
        ) : (
          <div className="login-card">
            <div className="brand-lg">coflux</div>
            {state.phase === "issuing" && <p className="login-hint">正在跳转到预览页…</p>}
            {state.phase === "failed" && <p className="login-status err">{state.message}</p>}
          </div>
        )}
      </div>
    </div>
  );
}
