/**
 * Hub —— 服务器的编排/路由核心。
 *
 * 模型（项目制）：Account → Device → Project(git 仓库) → Workspace(主=仓库本身 / 其它=git worktree) → Task → Session。
 *
 * 认证（Tailscale 式）：daemonId 服务器签发绑定不可冒充；account 隔离。
 * 健壮性（经两轮对抗式审查）：daemon 上行消息按 task.daemonId === conn.daemonId 归属校验；
 *   重启后绝不重复起 PTY；session 生命周期 closing 标志；pending 超时 + 掉线清理；client 越权拦截。
 *
 * 存储层是 Postgres（异步）：所有触库路径已 async 化。并发语义靠 DB 约束兜底（主键/唯一约束/
 * ON CONFLICT）而非应用层锁；级联删除、lazy provision 等多语句操作经 `store.transaction()` 保证
 * 原子性。单连接内消息处理不做串行队列（同连接消息仍可能交错，见 plans/002 决策）——各 handler
 * 内部保持"写完再广播"的顺序（await 与其后的同步语句之间不留出让点），确需的跨语句原子性交给事务。
 *
 * wire（plan 009）：WS 上只有 binary message，每条 = 一个 protobuf 信封。pty/proxy 数据面不再是
 * 独立的自定义二进制帧，而是信封 oneof 里的普通 case（pty_output/pty_replay/proxy_data/pty_input），
 * 与其它控制面消息走同一个 switch —— 旧的 handleDaemonBinary/handleClientBinary 已整体删除。
 */
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { WebSocket } from "ws";
import {
  create,
  clampDim,
  encodeServerToDaemon,
  encodeServerToClient,
  ServerToDaemonSchema,
  ServerToClientSchema,
  ProjectSchema,
  WorkspaceSchema,
  TaskSchema,
  TaskStatus,
  type AccountId,
  type DaemonId,
  type DaemonToServer,
  type ClientToServer,
  type ServerToDaemonPayload,
  type ServerToClientPayload,
  type ClientAuth,
  type SessionId,
  type Project,
  type ProjectId,
  type Task,
  type TaskId,
  type Workspace,
  type WorkspaceId,
} from "@coflux/protocol";
import { createLogger } from "@coflux/core";
import { Store } from "./store.js";
import { genToken, hashToken } from "./secrets.js";
import { config } from "./config.js";
import { PendingRegistry } from "./pending.js";
import { ProxyRouteTable, ProxyGate, TunnelRegistry, buildPreviewUrl, parseProxyRedirect, buildAuthCallbackUrl } from "./proxy.js";
import type { SupabaseVerifier, SupabaseIdentity } from "./auth.js";

const log = createLogger("hub");

/** daemon 展示信息：不用生成的 DaemonInfo 消息类型（无需 $typeName）——它只作为其它信封消息的
 * 嵌套字段被构造（nested init 接受纯对象），从不单独序列化，用生成类型纯属多余的仪式。 */
interface DaemonInfoData {
  daemonId: DaemonId;
  name: string;
  host: string;
  platform: string;
  online: boolean;
}

export interface DaemonConn {
  info: DaemonInfoData;
  accountId: AccountId;
  ws: WebSocket;
}
export interface ClientConn {
  ws: WebSocket;
  accountId: AccountId | null;
  subscribed: boolean;
  /** 本连接认证所用会话 token 的 hash（登出时按它撤销） */
  tokenHash?: string;
  /** device.authorize(Info) 猜测失败次数（同连接累计）；达上限后拒绝再试（限速见 plan 003） */
  authorizeFailures?: number;
}
export interface DaemonCtx {
  ws: WebSocket;
  daemonId: DaemonId | null;
  accountId: AccountId | null;
  /** 已发起 daemon.enrollRequest 且尚未被确认/过期/断线清理时，指向 pendingAuthorizations 里的 token */
  pendingAuthToken?: string;
}

/** 一次性设备授权请求（Tailscale 式）：纯内存态，见 docs/OPEN_QUESTIONS.md B7（单实例部署，无需持久化）。
 * 生命周期三选一了结：TTL 超时 / daemon 断线 / device.authorize 兑现——任一发生即从表里摘除。 */
interface PendingAuthorization {
  token: string;
  conn: DaemonCtx;
  name: string;
  host: string;
  platform: string;
  createdAt: number;
  timer: ReturnType<typeof setTimeout>;
}

interface RuntimeSession {
  sessionId: SessionId;
  daemonId: DaemonId;
  accountId: AccountId;
  taskId: TaskId;
  /** 独占模型：同一时刻只有一个控制端；attach 即接管，原控制端被踢 */
  holder: ClientConn | null;
  closing: boolean;
  /** session.create 后的启动确认超时；收到 session.started 即清除。超时未确认视为启动失败 */
  startTimer?: ReturnType<typeof setTimeout>;
}

type OpData =
  | { kind: "project.import"; name: string }
  | { kind: "worktree.add"; projectId: ProjectId; workspaceId: WorkspaceId; name: string };

type RelayKind = "exec" | "fs.list" | "fs.read";

export class Hub {
  private daemons = new Map<DaemonId, DaemonConn>();
  private sessions = new Map<SessionId, RuntimeSession>();
  private clients = new Set<ClientConn>();
  private pendingOps = new PendingRegistry<ClientConn, OpData>(config.pendingTimeoutMs);
  private pendingReplays = new PendingRegistry<ClientConn, { sessionId: SessionId }>(config.pendingTimeoutMs);
  /** exec/fs 这类"client 发起、daemon 应答、原样回传给 client"的中继 */
  private pendingRelays = new PendingRegistry<ClientConn, { clientRequestId: string; kind: RelayKind }>(config.pendingTimeoutMs);
  /** 待确认的设备授权请求，键为一次性 token（cf_authz_*） */
  private pendingAuthorizations = new Map<string, PendingAuthorization>();

  /** 端口转发（plan 006）：路由表 + 门禁（code/cookie）+ 隧道注册表。三者只做机制，
   * 归属/账号校验都在 hub 这层（下面的 handlePortsUpdate/handleProxyIssueAuth/dropSession）。 */
  readonly routeTable = new ProxyRouteTable();
  readonly proxyGate = new ProxyGate();
  readonly tunnels = new TunnelRegistry({
    sendControl: (daemonId, payload) => {
      const d = this.daemons.get(daemonId);
      if (d) this.sendDaemon(d, payload);
    },
  });

  /** supabase 模式下的验签器；local 模式为 undefined */
  constructor(private store: Store, private verifier?: SupabaseVerifier) {}

  /* ============================ 发送工具 ============================ */
  private sendDaemon(d: DaemonConn, payload: ServerToDaemonPayload) {
    if (d.ws.readyState === d.ws.OPEN) d.ws.send(encodeServerToDaemon(create(ServerToDaemonSchema, { payload })));
  }
  /** 认证完成前（daemonId 尚未落地到 this.daemons）直接对 ws 发送 */
  private sendRaw(ws: WebSocket, payload: ServerToDaemonPayload) {
    if (ws.readyState === ws.OPEN) ws.send(encodeServerToDaemon(create(ServerToDaemonSchema, { payload })));
  }
  private sendClient(c: ClientConn, payload: ServerToClientPayload) {
    if (c.ws.readyState === c.ws.OPEN) c.ws.send(encodeServerToClient(create(ServerToClientSchema, { payload })));
  }
  private broadcast(accountId: AccountId, payload: ServerToClientPayload) {
    for (const c of this.clients) if (c.subscribed && c.accountId === accountId) this.sendClient(c, payload);
  }
  private emitTask(task: Task) {
    this.broadcast(task.accountId, { case: "taskUpdated", value: { task } });
  }
  private isDaemonOnline(daemonId: DaemonId): boolean {
    return this.daemons.has(daemonId);
  }
  /** 给 client 回一个带它自定 requestId 的失败结果（超时/不支持/掉线等） */
  private relayError(client: ClientConn, kind: RelayKind, clientRequestId: string, message: string) {
    if (kind === "exec") this.sendClient(client, { case: "execResult", value: { requestId: clientRequestId, ok: false, exitCode: -1, stdout: "", stderr: "", error: message } });
    else if (kind === "fs.list") this.sendClient(client, { case: "fsListed", value: { requestId: clientRequestId, ok: false, entries: [], error: message } });
    else this.sendClient(client, { case: "fsReadResult", value: { requestId: clientRequestId, ok: false, content: "", error: message } });
  }
  /** 把 client 设为某会话的控制端；若原控制端是别人，则踢出并通知（handoff 接管） */
  private setHolder(s: RuntimeSession, client: ClientConn) {
    if (s.holder && s.holder !== client) {
      this.sendClient(s.holder, { case: "taskDetached", value: { taskId: s.taskId } });
    }
    s.holder = client;
  }

  private async daemonInfoList(accountId: AccountId): Promise<DaemonInfoData[]> {
    const list: DaemonInfoData[] = [];
    const seen = new Set<DaemonId>();
    for (const d of this.daemons.values()) {
      if (d.accountId !== accountId) continue;
      list.push({ ...d.info, online: true });
      seen.add(d.info.daemonId);
    }
    for (const dev of await this.store.listDevices(accountId)) {
      if (seen.has(dev.id)) continue;
      seen.add(dev.id);
      list.push({ daemonId: dev.id, name: dev.name, host: dev.host, platform: dev.platform, online: false });
    }
    return list;
  }

  private routeToSessionDaemon(sessionId: SessionId, payload: ServerToDaemonPayload): boolean {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    const d = this.daemons.get(s.daemonId);
    if (!d) return false;
    this.sendDaemon(d, payload);
    return true;
  }

  private async registerDaemonConn(conn: DaemonCtx, info: DaemonInfoData, accountId: AccountId): Promise<void> {
    const prev = this.daemons.get(info.daemonId);
    if (prev && prev.ws !== conn.ws) {
      try {
        prev.ws.close(4002, "replaced by new connection");
      } catch {
        /* ignore */
      }
    }
    conn.daemonId = info.daemonId;
    conn.accountId = accountId;
    this.daemons.set(info.daemonId, { ws: conn.ws, info, accountId });
    await this.store.touchDevice(info.daemonId, Date.now());
    this.broadcast(accountId, { case: "daemonUpdated", value: { daemon: { ...info, online: true } } });
  }

  /* ============================ Daemon 侧 ============================ */
  async handleDaemonMessage(conn: DaemonCtx, msg: DaemonToServer): Promise<void> {
    if (msg.payload.case !== "daemonEnroll" && msg.payload.case !== "daemonAuth" && msg.payload.case !== "daemonEnrollRequest" && !conn.daemonId) return;

    switch (msg.payload.case) {
      case "daemonEnrollRequest": {
        const value = msg.payload.value;
        // 同连接理论上只会有一个 pending（daemon 收到 authorizePending 前不会再发一次）；
        // 兜底：若已有旧 pending（例如客户端异常重发），先摘掉旧的再建新的，避免 token 泄漏。
        if (conn.pendingAuthToken) {
          const old = this.pendingAuthorizations.get(conn.pendingAuthToken);
          if (old) clearTimeout(old.timer);
          this.pendingAuthorizations.delete(conn.pendingAuthToken);
        }
        const token = genToken("cf_authz");
        const createdAt = Date.now();
        const timer = setTimeout(() => {
          this.pendingAuthorizations.delete(token);
          if (conn.pendingAuthToken === token) conn.pendingAuthToken = undefined;
        }, config.authorizeTtlMs);
        (timer as { unref?: () => void }).unref?.();
        this.pendingAuthorizations.set(token, { token, conn, name: value.name, host: value.host, platform: value.platform, createdAt, timer });
        conn.pendingAuthToken = token;
        this.sendRaw(conn.ws, { case: "daemonAuthorizePending", value: { url: `${config.webUrl}/authorize/${token}`, expiresAt: createdAt + config.authorizeTtlMs } });
        log.info("daemon authorize requested", { name: value.name, host: value.host });
        break;
      }
      case "daemonEnroll": {
        const value = msg.payload.value;
        const accountId = await this.store.accountForEnrollmentKey(hashToken(value.enrollmentKey));
        if (!accountId) {
          this.sendRaw(conn.ws, { case: "daemonAuthError", value: { message: "登记密钥无效", needEnroll: false } });
          conn.ws.close(4001, "bad enrollment key");
          return;
        }
        if ((await this.store.countDevices(accountId)) >= config.maxDevicesPerAccount) {
          this.sendRaw(conn.ws, { case: "daemonAuthError", value: { message: "账号设备数已达上限", needEnroll: false } });
          conn.ws.close(4004, "device cap reached");
          return;
        }
        const daemonId = randomUUID();
        const deviceToken = genToken("ck_dev");
        const ts = Date.now();
        await this.store.createDevice({ id: daemonId, accountId, name: value.name, host: value.host, platform: value.platform, tokenHash: hashToken(deviceToken), createdAt: ts, lastSeenAt: ts, revoked: false });
        log.info("daemon enrolled", { daemonId, name: value.name, host: value.host });
        this.sendRaw(conn.ws, { case: "daemonEnrolled", value: { daemonId, deviceToken } });
        await this.registerDaemonConn(conn, { daemonId, name: value.name, host: value.host, platform: value.platform, online: true }, accountId);
        break;
      }
      case "daemonAuth": {
        const value = msg.payload.value;
        const device = await this.store.getDeviceByTokenHash(hashToken(value.deviceToken));
        if (!device) {
          this.sendRaw(conn.ws, { case: "daemonAuthError", value: { message: "设备凭证无效或已撤销", needEnroll: true } });
          conn.ws.close(4001, "bad device token");
          return;
        }
        log.info("daemon authed", { daemonId: device.id, name: device.name });
        this.sendRaw(conn.ws, { case: "daemonAuthed", value: { daemonId: device.id } });
        await this.registerDaemonConn(conn, { daemonId: device.id, name: device.name, host: device.host, platform: device.platform, online: true }, device.accountId);
        break;
      }
      case "daemonResync": {
        const value = msg.payload.value;
        await this.reconcileDaemonSessions(conn.daemonId!, conn.accountId!, value.sessions);
        break;
      }
      case "projectValidated": {
        const value = msg.payload.value;
        const p = this.pendingOps.get(value.requestId);
        if (!p || p.data.kind !== "project.import" || p.daemonId !== conn.daemonId) return;
        this.pendingOps.take(value.requestId);
        if (!value.ok) {
          this.sendClient(p.client, { case: "error", value: { message: `不是有效的 git 仓库：${value.error ?? value.repoPath}` } });
          return;
        }
        const ts = Date.now();
        const project: Project = create(ProjectSchema, { id: randomUUID(), accountId: conn.accountId!, daemonId: conn.daemonId!, name: p.data.name, repoPath: value.repoPath, defaultBranch: value.branch, createdAt: ts });
        await this.store.createProject(project);
        const main: Workspace = create(WorkspaceSchema, { id: randomUUID(), accountId: project.accountId, daemonId: project.daemonId, projectId: project.id, name: "main", path: value.repoPath, branch: value.branch, isMain: true, createdAt: ts });
        await this.store.createWorkspace(main);
        log.info("project imported", { projectId: project.id, repoPath: project.repoPath, branch: value.branch });
        this.broadcast(project.accountId, { case: "projectCreated", value: { project } });
        this.broadcast(project.accountId, { case: "workspaceCreated", value: { workspace: main } });
        break;
      }
      case "worktreeAdded": {
        const value = msg.payload.value;
        const p = this.pendingOps.get(value.requestId);
        if (!p || p.data.kind !== "worktree.add" || p.daemonId !== conn.daemonId) return;
        this.pendingOps.take(value.requestId);
        if (!value.ok) {
          this.sendClient(p.client, { case: "error", value: { message: `创建工作区失败：${value.error ?? ""}` } });
          return;
        }
        const ws: Workspace = create(WorkspaceSchema, { id: p.data.workspaceId, accountId: conn.accountId!, daemonId: conn.daemonId!, projectId: p.data.projectId, name: p.data.name, path: value.path, branch: value.branch, isMain: false, createdAt: Date.now() });
        await this.store.createWorkspace(ws);
        log.info("worktree created", { workspaceId: ws.id, path: ws.path, branch: ws.branch });
        this.broadcast(ws.accountId, { case: "workspaceCreated", value: { workspace: ws } });
        break;
      }
      case "sessionStarted": {
        const value = msg.payload.value;
        const s = this.sessions.get(value.sessionId);
        if (s && s.daemonId !== conn.daemonId) return;
        if (s?.startTimer) {
          clearTimeout(s.startTimer);
          s.startTimer = undefined; // 已确认启动，撤销启动超时
        }
        const task = await this.store.getTask(value.taskId);
        if (task && task.daemonId === conn.daemonId && task.sessionId === value.sessionId && task.status !== TaskStatus.RUNNING) {
          const updated = await this.store.updateTask(task.id, { status: TaskStatus.RUNNING, exitCode: undefined });
          if (updated) this.emitTask(updated);
        }
        log.debug("session started", { sessionId: value.sessionId, taskId: value.taskId, pid: value.pid });
        break;
      }
      case "sessionExit": {
        const value = msg.payload.value;
        const s = this.sessions.get(value.sessionId);
        if (s && s.daemonId !== conn.daemonId) return;
        const task = await this.store.getTaskBySession(value.sessionId);
        if (task && task.daemonId === conn.daemonId && task.sessionId === value.sessionId) {
          const updated = await this.store.updateTask(task.id, { status: TaskStatus.EXITED, sessionId: undefined, exitCode: value.exitCode });
          if (updated) this.emitTask(updated);
        }
        if (s?.startTimer) clearTimeout(s.startTimer);
        if (s) this.dropSession(value.sessionId);
        log.debug("session exit", { sessionId: value.sessionId, code: value.exitCode });
        break;
      }
      case "portsUpdate": {
        await this.handlePortsUpdate(conn, msg.payload.value.sessions);
        break;
      }
      case "proxyOpened": {
        const value = msg.payload.value;
        if (conn.daemonId) this.tunnels.handleOpened(conn.daemonId, value.connId, value.ok, value.error);
        break;
      }
      case "proxyClosed": {
        const value = msg.payload.value;
        if (conn.daemonId) this.tunnels.handleClosed(conn.daemonId, value.connId);
        break;
      }
      case "proxyData": {
        const value = msg.payload.value;
        if (conn.daemonId) this.tunnels.handleData(conn.daemonId, value.connId, value.data);
        break;
      }
      /* ---------------- 数据面（原自定义二进制帧，现为普通 oneof case）---------------- */
      case "ptyOutput": {
        const value = msg.payload.value;
        const s = this.sessions.get(value.sessionId);
        if (!s || s.daemonId !== conn.daemonId || !s.holder) return;
        if (s.holder.ws.bufferedAmount > config.clientBufferHardLimit) {
          // 控制端严重落后：断开它（重连后回放 scrollback 自愈），保护服务器内存
          try {
            s.holder.ws.close(1013, "client too slow");
          } catch {
            /* ignore */
          }
          return;
        }
        this.sendClient(s.holder, { case: "ptyOutput", value });
        break;
      }
      case "ptyReplay": {
        const value = msg.payload.value;
        const p = this.pendingReplays.get(value.requestId);
        if (!p || p.daemonId !== conn.daemonId) return;
        this.pendingReplays.take(value.requestId);
        // 重新包成 pty_output 转发给控制端：bytes 原样复制，无需旧版的字节级重组 hack
        if (value.data.length > 0) {
          this.sendClient(p.client, { case: "ptyOutput", value: { sessionId: value.sessionId, data: value.data } });
        }
        // 回放完成后接管控制权（踢掉原控制端）
        const s = this.sessions.get(value.sessionId);
        if (s && !s.closing) this.setHolder(s, p.client);
        break;
      }
      case "execResult": {
        const value = msg.payload.value;
        const p = this.pendingRelays.get(value.requestId);
        if (!p || p.daemonId !== conn.daemonId) return;
        this.pendingRelays.take(value.requestId);
        this.sendClient(p.client, { case: "execResult", value: { ...value, requestId: p.data.clientRequestId } });
        break;
      }
      case "fsListed": {
        const value = msg.payload.value;
        const p = this.pendingRelays.get(value.requestId);
        if (!p || p.daemonId !== conn.daemonId) return;
        this.pendingRelays.take(value.requestId);
        this.sendClient(p.client, { case: "fsListed", value: { ...value, requestId: p.data.clientRequestId } });
        break;
      }
      case "fsReadResult": {
        const value = msg.payload.value;
        const p = this.pendingRelays.get(value.requestId);
        if (!p || p.daemonId !== conn.daemonId) return;
        this.pendingRelays.take(value.requestId);
        this.sendClient(p.client, { case: "fsReadResult", value: { ...value, requestId: p.data.clientRequestId } });
        break;
      }
    }
  }

  private async reconcileDaemonSessions(daemonId: DaemonId, accountId: AccountId, alive: readonly { sessionId: SessionId; taskId: TaskId }[]): Promise<void> {
    const valid = alive.filter((a) => a && typeof a.sessionId === "string" && typeof a.taskId === "string");
    const aliveIds = new Set(valid.map((a) => a.sessionId));
    const daemon = this.daemons.get(daemonId);

    for (const { sessionId, taskId } of valid) {
      const task = await this.store.getTask(taskId);
      if (!task || task.daemonId !== daemonId || task.status !== TaskStatus.RUNNING) {
        if (daemon) this.sendDaemon(daemon, { case: "sessionClose", value: { sessionId } });
        this.dropSession(sessionId);
        continue;
      }
      if (!this.sessions.has(sessionId)) this.sessions.set(sessionId, { sessionId, daemonId, accountId, taskId, holder: null, closing: false });
      if (task.sessionId !== sessionId) {
        const updated = await this.store.updateTask(taskId, { status: TaskStatus.RUNNING, sessionId, exitCode: undefined });
        if (updated) this.emitTask(updated);
      }
    }
    for (const task of await this.store.listRunningTasksByDaemon(daemonId)) {
      if (task.sessionId && !aliveIds.has(task.sessionId)) {
        const updated = await this.store.updateTask(task.id, { status: TaskStatus.EXITED, sessionId: undefined, exitCode: -1 });
        if (updated) this.emitTask(updated);
        this.dropSession(task.sessionId);
      }
    }
    log.debug("daemon resync", { daemonId, live: valid.length });
  }

  /** daemon 全量幂等上报每个存活 session 的监听端口：收敛路由表，广播受影响任务的 ports.updated。
   * 未出现在本次上报里的（该 daemon 名下）session 视为端口已清零（daemon 只报"仍有端口"的 session）。 */
  private async handlePortsUpdate(conn: DaemonCtx, reported: readonly { sessionId: SessionId; ports: readonly number[] }[]): Promise<void> {
    if (!conn.daemonId || !conn.accountId) return;
    const daemonId = conn.daemonId;
    const accountId = conn.accountId;
    // 路由标识可读化：用设备名（在线连接必有 daemons 表项；兜底 daemonId 前缀）拼 <设备名>-<端口>
    const deviceName = this.daemons.get(daemonId)?.info.name ?? daemonId.slice(0, 8);
    const changed = new Set<TaskId>();
    const touched = new Set<SessionId>();
    for (const entry of reported) {
      if (!entry || typeof entry.sessionId !== "string" || !Array.isArray(entry.ports)) continue;
      const s = this.sessions.get(entry.sessionId);
      if (!s || s.daemonId !== daemonId) continue; // 归属校验：忽略不属于该 daemon 的会话上报
      touched.add(entry.sessionId);
      const validPorts = [...new Set(entry.ports.filter((p) => Number.isInteger(p) && p > 0 && p < 65536))];
      const removedShortIds = this.routeTable.reconcile(entry.sessionId, daemonId, s.accountId, s.taskId, deviceName, validPorts);
      for (const shortId of removedShortIds) this.tunnels.closeAllForShortId(shortId);
      changed.add(s.taskId);
    }
    for (const sessionId of this.routeTable.sessionsForDaemon(daemonId)) {
      if (touched.has(sessionId)) continue;
      const released = this.routeTable.releaseSession(sessionId);
      if (!released) continue;
      for (const shortId of released.shortIds) this.tunnels.closeAllForShortId(shortId);
      changed.add(released.taskId);
    }
    for (const taskId of changed) this.broadcastPorts(accountId, taskId);
  }

  private broadcastPorts(accountId: AccountId, taskId: TaskId): void {
    const ports = this.routeTable.portsForTask(taskId).map((r) => ({ port: r.port, url: buildPreviewUrl(r.shortId) }));
    this.broadcast(accountId, { case: "portsUpdated", value: { taskId, ports } });
  }

  /** state.snapshot 里的 ports 字段按 taskId 分组（TaskPorts[]），与 ports.updated 的扁平形状不同——
   * 两者是不同消息（StateSnapshot vs PortsUpdated），语义映射见 client.proto。 */
  private allPorts(accountId: AccountId): { taskId: TaskId; ports: { port: number; url: string }[] }[] {
    const byTask = new Map<TaskId, { port: number; url: string }[]>();
    for (const r of this.routeTable.listForAccount(accountId)) {
      const entry = { port: r.port, url: buildPreviewUrl(r.shortId) };
      const list = byTask.get(r.taskId);
      if (list) list.push(entry);
      else byTask.set(r.taskId, [entry]);
    }
    return [...byTask.entries()].map(([taskId, ports]) => ({ taskId, ports }));
  }

  /** 端口转发版 proxy.issueAuth：校验 redirect 的 host 命中 <shortId>.<proxyHost> 且该 shortId
   * 当前路由属于本账号（跨账号严拒），签发一次性 code，拼出浏览器要跳转的回调 URL。 */
  private handleProxyIssueAuth(client: ClientConn, redirect: string): void {
    const parsed = parseProxyRedirect(redirect);
    if (!parsed) return void this.sendClient(client, { case: "proxyAuth", value: { ok: false, error: "目标地址无效" } });
    const route = this.routeTable.get(parsed.shortId);
    if (!route || route.accountId !== client.accountId) {
      return void this.sendClient(client, { case: "proxyAuth", value: { ok: false, error: "预览链接不存在或不属于当前账号" } });
    }
    const code = this.proxyGate.issueAuthCode(client.accountId!);
    const url = buildAuthCallbackUrl(parsed.host, code, parsed.pathAndQuery);
    this.sendClient(client, { case: "proxyAuth", value: { ok: true, url } });
  }

  /** session 终结的统一出口：除 this.sessions 外，一并摘除端口路由表条目、关闭在途隧道连接、
   * 广播受影响任务的 ports.updated（原来分散在各调用点的 `this.sessions.delete(x)` 均改走此处）。 */
  private dropSession(sessionId: SessionId): void {
    const s = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    const released = this.routeTable.releaseSession(sessionId);
    if (!released) return;
    for (const shortId of released.shortIds) this.tunnels.closeAllForShortId(shortId);
    if (s) this.broadcastPorts(s.accountId, released.taskId);
  }

  async handleDaemonClose(conn: DaemonCtx): Promise<void> {
    // 断线即作废：待授权（尚未登记，daemonId 还是 null）的连接也要在这里摘除 pending token +
    // 清 TTL 定时器，否则该 token 会一直挂在表里直到自然过期，且指向一个已死的 ws（虽然
    // sendRaw/registerDaemonConn 都会因 ws 非 OPEN 而安全失败，但会平白占用授权名额）。
    if (conn.pendingAuthToken) {
      const p = this.pendingAuthorizations.get(conn.pendingAuthToken);
      if (p) clearTimeout(p.timer);
      this.pendingAuthorizations.delete(conn.pendingAuthToken);
      conn.pendingAuthToken = undefined;
    }
    const daemonId = conn.daemonId;
    const accountId = conn.accountId;
    if (!daemonId || !accountId) return;
    const current = this.daemons.get(daemonId);
    if (!current || current.ws !== conn.ws) return;

    this.daemons.delete(daemonId);
    // 端口转发：daemon 掉线即所有隧道失联，摘路由表 + 关在途连接（this.sessions 本身按既有设计不动，
    // 留给 daemon.resync 重连后自愈；shortId 会在重连后 ports.update 时重新签发，见 plan 006）。
    const releasedRoutes = this.routeTable.releaseDaemon(daemonId);
    this.tunnels.closeAllForDaemon(daemonId);
    for (const r of releasedRoutes) this.broadcastPorts(accountId, r.taskId);
    await this.store.touchDevice(daemonId, Date.now());
    log.info("daemon disconnected", { daemonId });

    this.pendingOps.removeByDaemon(daemonId, (p) => this.sendClient(p.client, { case: "error", value: { message: "daemon 掉线，操作未完成" } }));
    this.pendingReplays.removeByDaemon(daemonId, (p) => this.sendClient(p.client, { case: "error", value: { message: "daemon 掉线，无法回放" } }));
    this.pendingRelays.removeByDaemon(daemonId, (p) => this.relayError(p.client, p.data.kind, p.data.clientRequestId, "daemon 掉线"));

    const device = await this.store.getDevice(daemonId);
    if (device && !device.revoked) {
      this.broadcast(accountId, { case: "daemonUpdated", value: { daemon: { daemonId, name: device.name, host: device.host, platform: device.platform, online: false } } });
    } else {
      this.broadcast(accountId, { case: "daemonRemoved", value: { daemonId } });
    }
  }

  /* ============================ Client 侧 ============================ */
  async handleClientMessage(client: ClientConn, msg: ClientToServer): Promise<void> {
    if (msg.payload.case !== "clientAuth" && !client.accountId) {
      this.sendClient(client, { case: "error", value: { message: "未认证" } });
      return;
    }

    switch (msg.payload.case) {
      case "clientAuth": {
        await this.handleClientAuth(client, msg.payload.value);
        break;
      }
      case "clientLogout": {
        // 服务器侧撤销本连接的会话 token（不止清本地），撤销后该 token 重连即失败。
        if (client.tokenHash) await this.store.revokeClientToken(client.tokenHash);
        client.ws.close(4001, "logout");
        break;
      }
      case "clientSubscribe": {
        const accountId = client.accountId!;
        // 先把快照数据查齐，最后才置 subscribed=true 并发送——避免在"已订阅但还没收到
        // 首个快照"的窗口期收到其它连接触发的广播导致乱序（landmine：广播不能抢在快照前）。
        const [daemons, projects, workspaces, tasks] = await Promise.all([
          this.daemonInfoList(accountId),
          this.store.listProjects(accountId),
          this.store.listWorkspaces(accountId),
          this.store.listTasks(accountId),
        ]);
        client.subscribed = true;
        this.clients.add(client);
        this.sendClient(client, { case: "stateSnapshot", value: { daemons, projects, workspaces, tasks, ports: this.allPorts(accountId) } });
        break;
      }
      case "clientCreateEnrollmentKey": {
        const enrollmentKey = genToken("cf_enroll");
        await this.store.createEnrollmentKey(hashToken(enrollmentKey), client.accountId!, Date.now());
        this.sendClient(client, { case: "enrollmentKeyCreated", value: { enrollmentKey, daemonUrl: config.daemonUrl } });
        log.info("enrollment key created", { accountId: client.accountId });
        break;
      }
      case "clientRemoveDevice": {
        await this.removeDevice(client, msg.payload.value.daemonId);
        break;
      }
      case "deviceAuthorizeInfo": {
        const p = this.checkedPendingAuth(client, msg.payload.value.token);
        if (!p) break; // helper 已回过 error
        this.sendClient(client, { case: "deviceAuthorizeInfo", value: { ok: true, name: p.name, host: p.host, platform: p.platform } });
        break;
      }
      case "deviceAuthorize": {
        const p = this.checkedPendingAuth(client, msg.payload.value.token);
        if (!p) break; // helper 已回过 error
        await this.completeDeviceAuthorize(client, p);
        break;
      }
      case "proxyIssueAuth": {
        this.handleProxyIssueAuth(client, msg.payload.value.redirect);
        break;
      }
      case "clientUpgradeDaemon": {
        const value = msg.payload.value;
        const device = await this.store.getDevice(value.daemonId);
        if (!device || device.accountId !== client.accountId) return;
        const d = this.daemons.get(value.daemonId);
        if (!d) return void this.sendClient(client, { case: "error", value: { message: "daemon 不在线" } });
        this.sendDaemon(d, { case: "workerUpgrade", value: { version: value.version, url: value.url, sha256: value.sha256, signature: value.signature } });
        log.info("worker upgrade dispatched", { daemonId: value.daemonId, version: value.version, download: !!value.url });
        break;
      }
      case "projectImport": {
        const value = msg.payload.value;
        const d = this.daemons.get(value.daemonId);
        if (!d || d.accountId !== client.accountId) {
          this.sendClient(client, { case: "error", value: { message: "daemon 不在线或不属于本账号" } });
          return;
        }
        const name = typeof value.name === "string" && value.name.trim() ? value.name.trim() : basename(value.path);
        const requestId = randomUUID();
        this.pendingOps.register(requestId, value.daemonId, client, { kind: "project.import", name }, (p) =>
          this.sendClient(p.client, { case: "error", value: { message: "导入超时" } }),
        );
        this.sendDaemon(d, { case: "projectValidate", value: { requestId, path: value.path } });
        break;
      }
      case "projectRemove": {
        const project = await this.store.getProject(msg.payload.value.projectId);
        if (!project || project.accountId !== client.accountId) return;
        const workspaces = await this.store.listWorkspacesByProject(project.id);
        const sessionCloses: SessionId[] = [];
        const worktreePaths: string[] = [];
        for (const ws of workspaces) {
          for (const task of await this.store.listTasksByWorkspace(ws.id)) if (task.sessionId) sessionCloses.push(task.sessionId);
          if (!ws.isMain) worktreePaths.push(ws.path); // 主工作区=仓库本身，不删
        }
        // 级联删除原子化：要么全删，要么不变
        let removedTaskIds: TaskId[] = [];
        await this.store.transaction(async (tx) => {
          for (const ws of workspaces) removedTaskIds.push(...(await tx.removeTasksByWorkspace(ws.id)));
          for (const ws of workspaces) await tx.removeWorkspace(ws.id);
          await tx.removeProject(project.id);
        });
        // 提交后做副作用（关 PTY、删 worktree、广播）
        for (const sid of sessionCloses) {
          this.routeToSessionDaemon(sid, { case: "sessionClose", value: { sessionId: sid } });
          this.dropSession(sid);
        }
        const daemon = this.daemons.get(project.daemonId);
        if (daemon) for (const wp of worktreePaths) this.sendDaemon(daemon, { case: "worktreeRemove", value: { repoPath: project.repoPath, worktreePath: wp } });
        for (const id of removedTaskIds) this.broadcast(project.accountId, { case: "taskRemoved", value: { taskId: id } });
        for (const ws of workspaces) this.broadcast(project.accountId, { case: "workspaceRemoved", value: { workspaceId: ws.id } });
        this.broadcast(project.accountId, { case: "projectRemoved", value: { projectId: project.id } });
        break;
      }
      case "workspaceCreate": {
        const value = msg.payload.value;
        const project = await this.store.getProject(value.projectId);
        if (!project || project.accountId !== client.accountId) {
          this.sendClient(client, { case: "error", value: { message: "项目不存在或不属于本账号" } });
          return;
        }
        const d = this.daemons.get(project.daemonId);
        if (!d) {
          this.sendClient(client, { case: "error", value: { message: "daemon 不在线" } });
          return;
        }
        const workspaceId = randomUUID();
        const requestId = randomUUID();
        const name = value.name.trim() || "工作区";
        this.pendingOps.register(requestId, project.daemonId, client, { kind: "worktree.add", projectId: project.id, workspaceId, name }, (p) =>
          this.sendClient(p.client, { case: "error", value: { message: "创建工作区超时" } }),
        );
        this.sendDaemon(d, { case: "worktreeAdd", value: { requestId, repoPath: project.repoPath, workspaceId, name, branch: value.branch, createNew: value.createNew } });
        break;
      }
      case "workspaceRemove": {
        const ws = await this.store.getWorkspace(msg.payload.value.workspaceId);
        if (!ws || ws.accountId !== client.accountId) return;
        if (ws.isMain) {
          this.sendClient(client, { case: "error", value: { message: "主工作区不能删除（删除整个项目即可）" } });
          return;
        }
        const project = await this.store.getProject(ws.projectId);
        const sessionCloses = (await this.store.listTasksByWorkspace(ws.id)).filter((t) => t.sessionId).map((t) => t.sessionId!);
        let removed: TaskId[] = [];
        await this.store.transaction(async (tx) => {
          removed = await tx.removeTasksByWorkspace(ws.id);
          await tx.removeWorkspace(ws.id);
        });
        for (const sid of sessionCloses) {
          this.routeToSessionDaemon(sid, { case: "sessionClose", value: { sessionId: sid } });
          this.dropSession(sid);
        }
        const daemon = this.daemons.get(ws.daemonId);
        if (daemon && project) this.sendDaemon(daemon, { case: "worktreeRemove", value: { repoPath: project.repoPath, worktreePath: ws.path } });
        for (const id of removed) this.broadcast(ws.accountId, { case: "taskRemoved", value: { taskId: id } });
        this.broadcast(ws.accountId, { case: "workspaceRemoved", value: { workspaceId: ws.id } });
        break;
      }
      case "taskCreate": {
        const value = msg.payload.value;
        const ws = await this.store.getWorkspace(value.workspaceId);
        if (!ws || ws.accountId !== client.accountId) {
          this.sendClient(client, { case: "error", value: { message: "工作区不存在或不属于本账号" } });
          return;
        }
        const ts = Date.now();
        const task: Task = create(TaskSchema, { id: randomUUID(), accountId: ws.accountId, daemonId: ws.daemonId, projectId: ws.projectId, workspaceId: ws.id, title: value.title || "未命名任务", status: TaskStatus.IDLE, createdAt: ts, updatedAt: ts });
        await this.store.createTask(task);
        this.emitTask(task);
        break;
      }
      case "taskStart": {
        const value = msg.payload.value;
        await this.startOrAttachTask(client, value.taskId, value.cols, value.rows);
        break;
      }
      case "taskAttach": {
        const task = await this.requireTask(client, msg.payload.value.taskId);
        if (!task) return;
        const s = task.sessionId ? this.sessions.get(task.sessionId) : undefined;
        if (task.status === TaskStatus.RUNNING && s && !s.closing) this.attachWithReplay(client, s.sessionId);
        else this.sendClient(client, { case: "error", value: { message: "任务未在运行，无法 attach" } });
        break;
      }
      case "taskStop": {
        const task = await this.requireTask(client, msg.payload.value.taskId);
        if (!task) return;
        const s = task.sessionId ? this.sessions.get(task.sessionId) : undefined;
        if (s && this.isDaemonOnline(s.daemonId)) {
          s.closing = true;
          this.routeToSessionDaemon(s.sessionId, { case: "sessionClose", value: { sessionId: s.sessionId } });
        } else if (task.status === TaskStatus.RUNNING) {
          if (task.sessionId) this.dropSession(task.sessionId);
          const updated = await this.store.updateTask(task.id, { status: TaskStatus.EXITED, sessionId: undefined, exitCode: -1 });
          if (updated) this.emitTask(updated);
        }
        break;
      }
      case "taskRemove": {
        const task = await this.requireTask(client, msg.payload.value.taskId);
        if (!task) return;
        if (task.sessionId) {
          this.routeToSessionDaemon(task.sessionId, { case: "sessionClose", value: { sessionId: task.sessionId } });
          this.dropSession(task.sessionId);
        }
        await this.store.removeTask(task.id);
        this.broadcast(task.accountId, { case: "taskRemoved", value: { taskId: task.id } });
        break;
      }
      case "ptyResize": {
        const value = msg.payload.value;
        const s = this.sessions.get(value.sessionId);
        if (!s || s.accountId !== client.accountId || s.holder !== client) return;
        this.routeToSessionDaemon(value.sessionId, { case: "ptyResize", value: { sessionId: value.sessionId, cols: clampDim(value.cols, 80), rows: clampDim(value.rows, 24) } });
        break;
      }
      case "ptyInput": {
        const value = msg.payload.value;
        const s = this.sessions.get(value.sessionId);
        if (!s || s.accountId !== client.accountId) return;
        if (s.holder !== client) {
          this.sendClient(client, { case: "error", value: { message: "无控制权：该任务已被其它客户端接管" } });
          return;
        }
        const d = this.daemons.get(s.daemonId);
        if (d) this.sendDaemon(d, { case: "ptyInput", value });
        break;
      }
      case "clientExec": {
        const value = msg.payload.value;
        const ws = await this.workspaceForClient(client, value.workspaceId);
        if (!ws) return void this.relayError(client, "exec", value.requestId, "工作区不存在或不属于本账号");
        if (!this.isDaemonOnline(ws.daemonId)) return void this.relayError(client, "exec", value.requestId, "daemon 不在线");
        const reqId = randomUUID();
        // exec 可能慢：服务器端钳制命令超时，并让中继超时 = 命令超时 + 宽限，避免命令仍在跑却误报超时
        const execTimeout = Math.min(config.execMaxTimeoutMs, value.timeoutMs && value.timeoutMs > 0 ? value.timeoutMs : config.execDefaultTimeoutMs);
        this.pendingRelays.register(reqId, ws.daemonId, client, { clientRequestId: value.requestId, kind: "exec" }, (p) => this.relayError(p.client, p.data.kind, p.data.clientRequestId, "超时"), execTimeout + 5_000);
        this.sendDaemon(this.daemons.get(ws.daemonId)!, { case: "execRun", value: { requestId: reqId, cwd: ws.path, command: value.command, args: value.args, timeoutMs: execTimeout } });
        break;
      }
      case "clientFsList": {
        const value = msg.payload.value;
        const ws = await this.workspaceForClient(client, value.workspaceId);
        if (!ws) return void this.relayError(client, "fs.list", value.requestId, "工作区不存在或不属于本账号");
        if (!this.isDaemonOnline(ws.daemonId)) return void this.relayError(client, "fs.list", value.requestId, "daemon 不在线");
        const reqId = randomUUID();
        this.pendingRelays.register(reqId, ws.daemonId, client, { clientRequestId: value.requestId, kind: "fs.list" }, (p) => this.relayError(p.client, p.data.kind, p.data.clientRequestId, "超时"));
        this.sendDaemon(this.daemons.get(ws.daemonId)!, { case: "fsList", value: { requestId: reqId, root: ws.path, path: value.path } });
        break;
      }
      case "clientFsRead": {
        const value = msg.payload.value;
        const ws = await this.workspaceForClient(client, value.workspaceId);
        if (!ws) return void this.relayError(client, "fs.read", value.requestId, "工作区不存在或不属于本账号");
        if (!this.isDaemonOnline(ws.daemonId)) return void this.relayError(client, "fs.read", value.requestId, "daemon 不在线");
        const reqId = randomUUID();
        this.pendingRelays.register(reqId, ws.daemonId, client, { clientRequestId: value.requestId, kind: "fs.read" }, (p) => this.relayError(p.client, p.data.kind, p.data.clientRequestId, "超时"));
        this.sendDaemon(this.daemons.get(ws.daemonId)!, { case: "fsRead", value: { requestId: reqId, root: ws.path, path: value.path } });
        break;
      }
    }
  }

  /**
   * client.auth：三条互斥路径
   *   1) clientToken 重连（两模式通用）——coflux 自持会话 token，全程不碰 Supabase。
   *   2) supabase 换票（仅 supabase 模式）——JWKS 本地验签 → userId → 查/建 membership → 签发会话 token。
   *   3) env 用户名+密码（仅 local 模式）——单账号 default。
   * 非 string 的凭证字段自然落空 → auth.error（与既有 clientToken 类型校验一致严格）。
   */
  private async handleClientAuth(client: ClientConn, msg: ClientAuth): Promise<void> {
    const now = Date.now();
    let accountId: AccountId | undefined;
    let issued: string | undefined;
    let tokenHash: string | undefined;
    let userId: string | null = null;

    if (typeof msg.clientToken === "string" && msg.clientToken) {
      // 重连：已签发的会话 token（校验未撤销且未过期）
      tokenHash = hashToken(msg.clientToken);
      accountId = await this.store.accountForClientToken(tokenHash, now);
    } else if (config.authProvider === "supabase" && typeof msg.supabaseToken === "string" && msg.supabaseToken) {
      // 换票：验签 Supabase JWT → userId → 查/建个人账号 → 签发 coflux 会话 token
      const identity = this.verifier ? await this.verifier.verify(msg.supabaseToken) : null;
      if (identity) {
        accountId = await this.resolveAccountForUser(identity);
        userId = identity.userId;
        issued = genToken("ck_sess");
        tokenHash = hashToken(issued);
        await this.store.upsertClientToken(tokenHash, accountId, now, now + config.sessionTtlMs, userId);
      }
    } else if (config.authProvider === "local" && typeof msg.username === "string" && typeof msg.password === "string") {
      // 登录：用户名 + 密码（单租户，对照配置）→ 签发带有效期的会话 token
      if (verifyLogin(msg.username, msg.password)) {
        accountId = config.accountId;
        issued = genToken("ck_sess");
        tokenHash = hashToken(issued);
        await this.store.upsertClientToken(tokenHash, accountId, now, now + config.sessionTtlMs, null);
      }
    }

    if (!accountId) {
      this.sendClient(client, { case: "authError", value: { message: "认证失败" } });
      try {
        client.ws.close(4001, "bad credentials");
      } catch {
        /* ignore */
      }
      return;
    }
    client.accountId = accountId;
    client.tokenHash = tokenHash;
    this.sendClient(client, { case: "authOk", value: { accountId, clientToken: issued } });
  }

  /** 验签通过且合法的 Supabase 用户：查已有个人账号，无则 lazy 建号 + owner membership。
   * 能出示合法 JWT ⇒ 管理员在 Supabase 亲手建的用户，故 lazy provision 安全（见 plans/001）。 */
  private async resolveAccountForUser(identity: SupabaseIdentity): Promise<AccountId> {
    const existing = await this.store.getMembershipByUser(identity.userId);
    if (existing) return existing.accountId;
    const accountId = randomUUID();
    const now = Date.now();
    await this.store.transaction(async (tx) => {
      await tx.createAccount({ id: accountId, name: identity.email ?? identity.userId, createdAt: now });
      await tx.createMembership(identity.userId, accountId, "owner", now);
    });
    log.info("provisioned account for supabase user", { accountId });
    return accountId;
  }

  private async workspaceForClient(client: ClientConn, workspaceId: WorkspaceId): Promise<Workspace | undefined> {
    const ws = await this.store.getWorkspace(workspaceId);
    return ws && ws.accountId === client.accountId ? ws : undefined;
  }

  private async requireTask(client: ClientConn, taskId: TaskId): Promise<Task | undefined> {
    const task = await this.store.getTask(taskId);
    if (!task || task.accountId !== client.accountId) {
      this.sendClient(client, { case: "error", value: { message: `任务不存在：${taskId}` } });
      return undefined;
    }
    return task;
  }

  private async startOrAttachTask(client: ClientConn, taskId: TaskId, cols: number, rows: number): Promise<void> {
    const task = await this.requireTask(client, taskId);
    if (!task) return;

    if (task.status === TaskStatus.RUNNING && task.sessionId) {
      const s = this.sessions.get(task.sessionId);
      if (s && !s.closing) return void this.attachWithReplay(client, s.sessionId);
      if (s && s.closing) return void this.sendClient(client, { case: "error", value: { message: "任务正在停止，请稍候重试" } });
      this.sendClient(client, { case: "error", value: { message: "会话恢复中，请稍候重试" } });
      return;
    }

    const d = this.daemons.get(task.daemonId);
    if (!d) return void this.sendClient(client, { case: "error", value: { message: `daemon 不在线：${task.daemonId}` } });
    const ws = await this.store.getWorkspace(task.workspaceId);
    if (!ws) return void this.sendClient(client, { case: "error", value: { message: "工作区已不存在" } });

    const sessionId = randomUUID();
    const session: RuntimeSession = { sessionId, daemonId: task.daemonId, accountId: task.accountId, taskId: task.id, holder: client, closing: false };
    // 启动确认超时：daemon 收到 session.create 却起 PTY 失败又不回消息时，避免 task 永久卡 running + session 泄漏。
    const startTimer = setTimeout(() => void this.onSessionStartTimeout(sessionId), config.pendingTimeoutMs);
    (startTimer as { unref?: () => void }).unref?.();
    session.startTimer = startTimer;
    this.sessions.set(sessionId, session);
    this.sendDaemon(d, { case: "sessionCreate", value: { sessionId, taskId: task.id, cwd: ws.path, cols: clampDim(cols, 80), rows: clampDim(rows, 24) } });
    const updated = await this.store.updateTask(task.id, { status: TaskStatus.RUNNING, sessionId, exitCode: undefined });
    if (updated) this.emitTask(updated);
  }

  /** session.create 超时未确认启动：清运行时 session、标 task exited、通知控制端。 */
  private async onSessionStartTimeout(sessionId: SessionId): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s || !s.startTimer) return; // 已确认启动（timer 被清）或已清理
    this.dropSession(sessionId);
    const task = await this.store.getTaskBySession(sessionId);
    if (task && task.sessionId === sessionId && task.status === TaskStatus.RUNNING) {
      const updated = await this.store.updateTask(task.id, { status: TaskStatus.EXITED, sessionId: undefined, exitCode: -1 });
      if (updated) this.emitTask(updated);
    }
    if (s.holder) this.sendClient(s.holder, { case: "error", value: { message: "会话启动超时" } });
    log.warn("session start timed out", { sessionId });
  }

  private attachWithReplay(client: ClientConn, sessionId: SessionId): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    if (!this.isDaemonOnline(s.daemonId)) return void this.sendClient(client, { case: "error", value: { message: "daemon 离线，无法回放" } });
    const requestId = randomUUID();
    this.pendingReplays.register(requestId, s.daemonId, client, { sessionId }, (p) =>
      this.sendClient(p.client, { case: "error", value: { message: "回放超时" } }),
    );
    const ok = this.routeToSessionDaemon(sessionId, { case: "sessionReplay", value: { sessionId, requestId } });
    if (!ok) {
      this.pendingReplays.take(requestId);
      this.sendClient(client, { case: "error", value: { message: "daemon 离线，无法回放" } });
    }
  }

  /** device.authorizeInfo / device.authorize 共用的 token 查找 + 限速门。
   * 未命中（无效/已过期/已被兑现/daemon 已断线）计入失败次数；命中不消费（由调用方决定是否消费）。 */
  private checkedPendingAuth(client: ClientConn, token: string): PendingAuthorization | undefined {
    if ((client.authorizeFailures ?? 0) >= config.authorizeMaxFailures) {
      this.sendClient(client, { case: "deviceAuthorizeInfo", value: { ok: false, error: "尝试次数过多，请重新申请授权链接" } });
      return undefined;
    }
    const p = this.pendingAuthorizations.get(token);
    if (!p) {
      client.authorizeFailures = (client.authorizeFailures ?? 0) + 1;
      this.sendClient(client, { case: "deviceAuthorizeInfo", value: { ok: false, error: "授权链接无效或已过期" } });
      return undefined;
    }
    return p;
  }

  /** 兑现一次授权：摘除 pending（一次性）、把设备绑进当前登录账号、走与 daemon.enroll 完全相同的
   * createDevice + registerDaemonConn 路径——授权完成后的 daemon 与 enrollmentKey 登记的设备无状态差异。 */
  private async completeDeviceAuthorize(client: ClientConn, p: PendingAuthorization): Promise<void> {
    this.pendingAuthorizations.delete(p.token);
    clearTimeout(p.timer);
    if (p.conn.pendingAuthToken === p.token) p.conn.pendingAuthToken = undefined;

    const accountId = client.accountId!;
    if ((await this.store.countDevices(accountId)) >= config.maxDevicesPerAccount) {
      // 与 daemon.enroll 路径一致：设备数超限是致命错误，daemon 侧直接退出（needEnroll:false）。
      this.sendRaw(p.conn.ws, { case: "daemonAuthError", value: { message: "账号设备数已达上限", needEnroll: false } });
      try {
        p.conn.ws.close(4004, "device cap reached");
      } catch {
        /* ignore */
      }
      this.sendClient(client, { case: "deviceAuthorizeInfo", value: { ok: false, error: "账号设备数已达上限" } });
      return;
    }

    const daemonId = randomUUID();
    const deviceToken = genToken("ck_dev");
    const ts = Date.now();
    await this.store.createDevice({ id: daemonId, accountId, name: p.name, host: p.host, platform: p.platform, tokenHash: hashToken(deviceToken), createdAt: ts, lastSeenAt: ts, revoked: false });
    log.info("daemon authorized", { daemonId, name: p.name, host: p.host, accountId });
    this.sendRaw(p.conn.ws, { case: "daemonEnrolled", value: { daemonId, deviceToken } });
    await this.registerDaemonConn(p.conn, { daemonId, name: p.name, host: p.host, platform: p.platform, online: true }, accountId);
    this.sendClient(client, { case: "deviceAuthorized", value: {} });
  }

  private async removeDevice(client: ClientConn, daemonId: DaemonId): Promise<void> {
    const device = await this.store.getDevice(daemonId);
    if (!device || device.accountId !== client.accountId) return;
    const accountId = device.accountId;

    const conn = this.daemons.get(daemonId);
    if (conn) {
      try {
        conn.ws.close(4003, "device removed");
      } catch {
        /* ignore */
      }
      this.daemons.delete(daemonId);
    }
    for (const [sid, s] of this.sessions) if (s.daemonId === daemonId) this.dropSession(sid);
    this.pendingOps.removeByDaemon(daemonId);
    this.pendingReplays.removeByDaemon(daemonId);
    this.pendingRelays.removeByDaemon(daemonId, (p) => this.relayError(p.client, p.data.kind, p.data.clientRequestId, "daemon 已移除"));

    const workspaces = await this.store.listWorkspacesByDaemon(daemonId);
    const projects = await this.store.listProjectsByDaemon(daemonId);
    let taskIds: TaskId[] = [];
    await this.store.transaction(async (tx) => {
      await tx.revokeDevice(daemonId);
      taskIds = await tx.removeTasksByDaemon(daemonId);
      for (const w of workspaces) await tx.removeWorkspace(w.id);
      for (const p of projects) await tx.removeProject(p.id);
    });
    for (const id of taskIds) this.broadcast(accountId, { case: "taskRemoved", value: { taskId: id } });
    for (const w of workspaces) this.broadcast(accountId, { case: "workspaceRemoved", value: { workspaceId: w.id } });
    for (const p of projects) this.broadcast(accountId, { case: "projectRemoved", value: { projectId: p.id } });
    this.broadcast(accountId, { case: "daemonRemoved", value: { daemonId } });
    log.info("device removed", { daemonId });
  }

  handleClientClose(client: ClientConn): void {
    this.clients.delete(client);
    for (const s of this.sessions.values()) if (s.holder === client) s.holder = null;
    this.pendingReplays.removeByClient(client);
    this.pendingOps.removeByClient(client);
    this.pendingRelays.removeByClient(client);
  }

  /** 运行时计数（供 /health 暴露） */
  stats(): { daemons: number; clients: number; sessions: number } {
    return { daemons: this.daemons.size, clients: this.clients.size, sessions: this.sessions.size };
  }

  /** 优雅关闭：清定时器、关所有连接 */
  shutdown(): void {
    this.pendingOps.clear();
    this.pendingReplays.clear();
    this.pendingRelays.clear();
    for (const p of this.pendingAuthorizations.values()) clearTimeout(p.timer);
    this.pendingAuthorizations.clear();
    for (const d of this.daemons.values()) try { d.ws.close(1001, "server shutting down"); } catch { /* ignore */ }
    for (const c of this.clients) try { c.ws.close(1001, "server shutting down"); } catch { /* ignore */ }
  }
}

function basename(p: string): string {
  const parts = p.replace(/[/\\]+$/, "").split(/[/\\]/);
  return parts[parts.length - 1] || p;
}

/** 单租户登录校验：用户名 + 密码对照配置（定时安全比较，避免时序侧信道） */
function verifyLogin(username: string, password: string): boolean {
  return timingSafeStrEq(username, config.username) && timingSafeStrEq(password, config.password);
}
function timingSafeStrEq(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
