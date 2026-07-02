/**
 * Hub —— 服务器的编排/路由核心。
 *
 * 模型（项目制）：Account → Device → Project(git 仓库) → Workspace(主=仓库本身 / 其它=git worktree) → Task → Session。
 *
 * 认证（Tailscale 式）：daemonId 服务器签发绑定不可冒充；account 隔离。
 * 健壮性（经两轮对抗式审查）：daemon 上行消息按 task.daemonId === conn.daemonId 归属校验；
 *   重启后绝不重复起 PTY；session 生命周期 closing 标志；pending 超时 + 掉线清理；client 越权拦截。
 */
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { WebSocket } from "ws";
import {
  encode,
  clampDim,
  decodeFrame,
  replayFrameToOutput,
  type AccountId,
  type DaemonInfo,
  type DaemonId,
  type DaemonToServer,
  type ClientToServer,
  type ServerToDaemon,
  type ServerToClient,
  type SessionId,
  type RequestId,
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

const log = createLogger("hub");

export interface DaemonConn {
  info: DaemonInfo;
  accountId: AccountId;
  ws: WebSocket;
}
export interface ClientConn {
  ws: WebSocket;
  accountId: AccountId | null;
  subscribed: boolean;
  /** 本连接认证所用会话 token 的 hash（登出时按它撤销） */
  tokenHash?: string;
}
export interface DaemonCtx {
  ws: WebSocket;
  daemonId: DaemonId | null;
  accountId: AccountId | null;
}

interface RuntimeSession {
  sessionId: SessionId;
  daemonId: DaemonId;
  accountId: AccountId;
  taskId: TaskId;
  /** 独占模型：同一时刻只有一个控制端；attach 即接管，原控制端被踢 */
  holder: ClientConn | null;
  closing: boolean;
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

  constructor(private store: Store) {}

  /* ============================ 发送工具 ============================ */
  private sendDaemon(d: DaemonConn, msg: ServerToDaemon) {
    if (d.ws.readyState === d.ws.OPEN) d.ws.send(encode(msg));
  }
  private sendRaw(ws: WebSocket, msg: ServerToDaemon | ServerToClient) {
    if (ws.readyState === ws.OPEN) ws.send(encode(msg));
  }
  private sendClient(c: ClientConn, msg: ServerToClient) {
    if (c.ws.readyState === c.ws.OPEN) c.ws.send(encode(msg));
  }
  /** 数据面：发二进制帧给控制端 */
  private sendClientFrame(c: ClientConn, frame: Uint8Array) {
    if (c.ws.readyState === c.ws.OPEN) c.ws.send(frame);
  }
  private broadcast(accountId: AccountId, msg: ServerToClient) {
    for (const c of this.clients) if (c.subscribed && c.accountId === accountId) this.sendClient(c, msg);
  }
  private emitTask(task: Task) {
    this.broadcast(task.accountId, { type: "task.updated", task });
  }
  private isDaemonOnline(daemonId: DaemonId): boolean {
    return this.daemons.has(daemonId);
  }
  /** 给 client 回一个带它自定 requestId 的失败结果（超时/不支持/掉线等） */
  private relayError(client: ClientConn, kind: RelayKind, clientRequestId: string, message: string) {
    if (kind === "exec") this.sendClient(client, { type: "exec.result", requestId: clientRequestId, ok: false, exitCode: -1, stdout: "", stderr: "", error: message });
    else if (kind === "fs.list") this.sendClient(client, { type: "fs.listed", requestId: clientRequestId, ok: false, entries: [], error: message });
    else this.sendClient(client, { type: "fs.read.result", requestId: clientRequestId, ok: false, content: "", error: message });
  }
  /** 把 client 设为某会话的控制端；若原控制端是别人，则踢出并通知（handoff 接管） */
  private setHolder(s: RuntimeSession, client: ClientConn) {
    if (s.holder && s.holder !== client) {
      this.sendClient(s.holder, { type: "task.detached", taskId: s.taskId });
    }
    s.holder = client;
  }

  private daemonInfoList(accountId: AccountId): DaemonInfo[] {
    const list: DaemonInfo[] = [];
    const seen = new Set<DaemonId>();
    for (const d of this.daemons.values()) {
      if (d.accountId !== accountId) continue;
      list.push({ ...d.info, online: true });
      seen.add(d.info.daemonId);
    }
    for (const dev of this.store.listDevices(accountId)) {
      if (seen.has(dev.id)) continue;
      seen.add(dev.id);
      list.push({ daemonId: dev.id, name: dev.name, host: dev.host, platform: dev.platform, online: false });
    }
    return list;
  }

  private routeToSessionDaemon(sessionId: SessionId, msg: ServerToDaemon): boolean {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    const d = this.daemons.get(s.daemonId);
    if (!d) return false;
    this.sendDaemon(d, msg);
    return true;
  }

  /* ===================== 数据面（二进制帧）===================== */

  /** daemon → server 的二进制帧：pty.output（转发给控制端）/ pty.replay（取 pending、转 output 并接管控制权） */
  handleDaemonBinary(conn: DaemonCtx, buf: Buffer): void {
    const frame = decodeFrame(buf);
    if (!frame) return;
    if (frame.type === "pty.output") {
      const s = this.sessions.get(frame.sessionId);
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
      // 同一帧格式，原始字节直接转发给控制端
      if (s.holder.ws.readyState === s.holder.ws.OPEN) s.holder.ws.send(buf);
      return;
    }
    if (frame.type === "pty.replay") {
      const p = this.pendingReplays.get(frame.requestId);
      if (!p || p.daemonId !== conn.daemonId) return;
      this.pendingReplays.take(frame.requestId);
      // 字节级重组为 output 帧转发（保留 scrollback 原始字节，与实时 output 路径一致）
      if (frame.data) {
        const outFrame = replayFrameToOutput(buf);
        if (outFrame) this.sendClientFrame(p.client, outFrame);
      }
      // 回放完成后接管控制权（踢掉原控制端）
      const s = this.sessions.get(frame.sessionId);
      if (s && !s.closing) this.setHolder(s, p.client);
      return;
    }
    // pty.input 不应从 daemon 上行，忽略
  }

  /** client → server 的二进制帧：pty.input（校验控制权后转发给会话所属 daemon） */
  handleClientBinary(client: ClientConn, buf: Buffer): void {
    const frame = decodeFrame(buf);
    if (!frame || frame.type !== "pty.input") return;
    const s = this.sessions.get(frame.sessionId);
    if (!s || s.accountId !== client.accountId) return;
    if (s.holder !== client) {
      this.sendClient(client, { type: "error", message: "无控制权：该任务已被其它客户端接管" });
      return;
    }
    // 同一帧格式，原始字节直接转发给会话所属 daemon
    const d = this.daemons.get(s.daemonId);
    if (d && d.ws.readyState === d.ws.OPEN) d.ws.send(buf);
  }

  private registerDaemonConn(conn: DaemonCtx, info: DaemonInfo, accountId: AccountId) {
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
    this.store.touchDevice(info.daemonId, Date.now());
    this.broadcast(accountId, { type: "daemon.updated", daemon: { ...info, online: true } });
  }

  /* ============================ Daemon 侧 ============================ */
  handleDaemonMessage(conn: DaemonCtx, msg: DaemonToServer): void {
    if (msg.type !== "daemon.enroll" && msg.type !== "daemon.auth" && !conn.daemonId) return;

    switch (msg.type) {
      case "daemon.enroll": {
        const accountId = this.store.accountForEnrollmentKey(hashToken(msg.enrollmentKey));
        if (!accountId) {
          this.sendRaw(conn.ws, { type: "daemon.authError", message: "登记密钥无效", needEnroll: false });
          conn.ws.close(4001, "bad enrollment key");
          return;
        }
        if (this.store.countDevices(accountId) >= config.maxDevicesPerAccount) {
          this.sendRaw(conn.ws, { type: "daemon.authError", message: "账号设备数已达上限", needEnroll: false });
          conn.ws.close(4004, "device cap reached");
          return;
        }
        const daemonId = randomUUID();
        const deviceToken = genToken("ck_dev");
        const ts = Date.now();
        this.store.createDevice({ id: daemonId, accountId, name: msg.name, host: msg.host, platform: msg.platform, tokenHash: hashToken(deviceToken), createdAt: ts, lastSeenAt: ts, revoked: 0 });
        log.info("daemon enrolled", { daemonId, name: msg.name, host: msg.host });
        this.sendRaw(conn.ws, { type: "daemon.enrolled", daemonId, deviceToken });
        this.registerDaemonConn(conn, { daemonId, name: msg.name, host: msg.host, platform: msg.platform, online: true }, accountId);
        break;
      }
      case "daemon.auth": {
        const device = this.store.getDeviceByTokenHash(hashToken(msg.deviceToken));
        if (!device) {
          this.sendRaw(conn.ws, { type: "daemon.authError", message: "设备凭证无效或已撤销", needEnroll: true });
          conn.ws.close(4001, "bad device token");
          return;
        }
        log.info("daemon authed", { daemonId: device.id, name: device.name });
        this.sendRaw(conn.ws, { type: "daemon.authed", daemonId: device.id });
        this.registerDaemonConn(conn, { daemonId: device.id, name: device.name, host: device.host, platform: device.platform, online: true }, device.accountId);
        break;
      }
      case "daemon.resync": {
        this.reconcileDaemonSessions(conn.daemonId!, conn.accountId!, msg.sessions);
        break;
      }
      case "project.validated": {
        const p = this.pendingOps.get(msg.requestId);
        if (!p || p.data.kind !== "project.import" || p.daemonId !== conn.daemonId) return;
        this.pendingOps.take(msg.requestId);
        if (!msg.ok) {
          this.sendClient(p.client, { type: "error", message: `不是有效的 git 仓库：${msg.error ?? msg.repoPath}` });
          return;
        }
        const ts = Date.now();
        const project: Project = { id: randomUUID(), accountId: conn.accountId!, daemonId: conn.daemonId!, name: p.data.name, repoPath: msg.repoPath, defaultBranch: msg.branch, createdAt: ts };
        this.store.createProject(project);
        const main: Workspace = { id: randomUUID(), accountId: project.accountId, daemonId: project.daemonId, projectId: project.id, name: "main", path: msg.repoPath, branch: msg.branch, isMain: true, createdAt: ts };
        this.store.createWorkspace(main);
        log.info("project imported", { projectId: project.id, repoPath: project.repoPath, branch: msg.branch });
        this.broadcast(project.accountId, { type: "project.created", project });
        this.broadcast(project.accountId, { type: "workspace.created", workspace: main });
        break;
      }
      case "worktree.added": {
        const p = this.pendingOps.get(msg.requestId);
        if (!p || p.data.kind !== "worktree.add" || p.daemonId !== conn.daemonId) return;
        this.pendingOps.take(msg.requestId);
        if (!msg.ok) {
          this.sendClient(p.client, { type: "error", message: `创建工作区失败：${msg.error ?? ""}` });
          return;
        }
        const ws: Workspace = { id: p.data.workspaceId, accountId: conn.accountId!, daemonId: conn.daemonId!, projectId: p.data.projectId, name: p.data.name, path: msg.path, branch: msg.branch, isMain: false, createdAt: Date.now() };
        this.store.createWorkspace(ws);
        log.info("worktree created", { workspaceId: ws.id, path: ws.path, branch: ws.branch });
        this.broadcast(ws.accountId, { type: "workspace.created", workspace: ws });
        break;
      }
      case "session.started": {
        const s = this.sessions.get(msg.sessionId);
        if (s && s.daemonId !== conn.daemonId) return;
        const task = this.store.getTask(msg.taskId);
        if (task && task.daemonId === conn.daemonId && task.sessionId === msg.sessionId && task.status !== "running") {
          const updated = this.store.updateTask(task.id, { status: "running", exitCode: null });
          if (updated) this.emitTask(updated);
        }
        log.debug("session started", { sessionId: msg.sessionId, taskId: msg.taskId, pid: msg.pid });
        break;
      }
      case "session.exit": {
        const s = this.sessions.get(msg.sessionId);
        if (s && s.daemonId !== conn.daemonId) return;
        const task = this.store.getTaskBySession(msg.sessionId);
        if (task && task.daemonId === conn.daemonId && task.sessionId === msg.sessionId) {
          const updated = this.store.updateTask(task.id, { status: "exited", sessionId: null, exitCode: msg.exitCode });
          if (updated) this.emitTask(updated);
        }
        if (s) this.sessions.delete(msg.sessionId);
        log.debug("session exit", { sessionId: msg.sessionId, code: msg.exitCode });
        break;
      }
      // pty.output / pty.replay 走二进制数据面（见 handleDaemonBinary）
      case "exec.result":
      case "fs.listed":
      case "fs.read.result": {
        // exec/fs 结果：取出中继、把 requestId 换回 client 自定的，原样回传
        const p = this.pendingRelays.get(msg.requestId);
        if (!p || p.daemonId !== conn.daemonId) return;
        this.pendingRelays.take(msg.requestId);
        this.sendClient(p.client, { ...msg, requestId: p.data.clientRequestId });
        break;
      }
    }
  }

  private reconcileDaemonSessions(daemonId: DaemonId, accountId: AccountId, alive: { sessionId: SessionId; taskId: TaskId }[]): void {
    if (!Array.isArray(alive)) return;
    const valid = alive.filter((a) => a && typeof a.sessionId === "string" && typeof a.taskId === "string");
    const aliveIds = new Set(valid.map((a) => a.sessionId));
    const daemon = this.daemons.get(daemonId);

    for (const { sessionId, taskId } of valid) {
      const task = this.store.getTask(taskId);
      if (!task || task.daemonId !== daemonId || task.status !== "running") {
        if (daemon) this.sendDaemon(daemon, { type: "session.close", sessionId });
        this.sessions.delete(sessionId);
        continue;
      }
      if (!this.sessions.has(sessionId)) this.sessions.set(sessionId, { sessionId, daemonId, accountId, taskId, holder: null, closing: false });
      if (task.sessionId !== sessionId) {
        const updated = this.store.updateTask(taskId, { status: "running", sessionId, exitCode: null });
        if (updated) this.emitTask(updated);
      }
    }
    for (const task of this.store.listRunningTasksByDaemon(daemonId)) {
      if (task.sessionId && !aliveIds.has(task.sessionId)) {
        const updated = this.store.updateTask(task.id, { status: "exited", sessionId: null, exitCode: -1 });
        if (updated) this.emitTask(updated);
        this.sessions.delete(task.sessionId);
      }
    }
    log.debug("daemon resync", { daemonId, live: valid.length });
  }

  handleDaemonClose(conn: DaemonCtx): void {
    const daemonId = conn.daemonId;
    const accountId = conn.accountId;
    if (!daemonId || !accountId) return;
    const current = this.daemons.get(daemonId);
    if (!current || current.ws !== conn.ws) return;

    this.daemons.delete(daemonId);
    this.store.touchDevice(daemonId, Date.now());
    log.info("daemon disconnected", { daemonId });

    this.pendingOps.removeByDaemon(daemonId, (p) => this.sendClient(p.client, { type: "error", message: "daemon 掉线，操作未完成" }));
    this.pendingReplays.removeByDaemon(daemonId, (p) => this.sendClient(p.client, { type: "error", message: "daemon 掉线，无法回放" }));
    this.pendingRelays.removeByDaemon(daemonId, (p) => this.relayError(p.client, p.data.kind, p.data.clientRequestId, "daemon 掉线"));

    const device = this.store.getDevice(daemonId);
    if (device && !device.revoked) {
      this.broadcast(accountId, { type: "daemon.updated", daemon: { daemonId, name: device.name, host: device.host, platform: device.platform, online: false } });
    } else {
      this.broadcast(accountId, { type: "daemon.removed", daemonId });
    }
  }

  /* ============================ Client 侧 ============================ */
  handleClientMessage(client: ClientConn, msg: ClientToServer): void {
    if (msg.type !== "client.auth" && !client.accountId) {
      this.sendClient(client, { type: "error", message: "未认证" });
      return;
    }

    switch (msg.type) {
      case "client.auth": {
        let accountId: AccountId | undefined;
        let issued: string | undefined;
        let tokenHash: string | undefined;
        const now = Date.now();
        if (typeof msg.clientToken === "string" && msg.clientToken) {
          // 重连：已签发的会话 token（校验未撤销且未过期）
          tokenHash = hashToken(msg.clientToken);
          accountId = this.store.accountForClientToken(tokenHash, now);
        } else if (typeof msg.username === "string" && typeof msg.password === "string") {
          // 登录：用户名 + 密码（单租户，对照配置）→ 签发带有效期的会话 token
          if (verifyLogin(msg.username, msg.password)) {
            accountId = config.accountId;
            issued = genToken("ck_sess");
            tokenHash = hashToken(issued);
            this.store.upsertClientToken(tokenHash, accountId, now, now + config.sessionTtlMs);
          }
        }
        if (!accountId) {
          this.sendClient(client, { type: "auth.error", message: "用户名或密码错误" });
          client.ws.close(4001, "bad credentials");
          return;
        }
        client.accountId = accountId;
        client.tokenHash = tokenHash;
        this.sendClient(client, { type: "auth.ok", accountId, clientToken: issued });
        break;
      }
      case "client.logout": {
        // 服务器侧撤销本连接的会话 token（不止清本地），撤销后该 token 重连即失败。
        if (client.tokenHash) this.store.revokeClientToken(client.tokenHash);
        client.ws.close(4001, "logout");
        break;
      }
      case "client.subscribe": {
        client.subscribed = true;
        this.clients.add(client);
        const accountId = client.accountId!;
        this.sendClient(client, {
          type: "state.snapshot",
          daemons: this.daemonInfoList(accountId),
          projects: this.store.listProjects(accountId),
          workspaces: this.store.listWorkspaces(accountId),
          tasks: this.store.listTasks(accountId),
        });
        break;
      }
      case "client.createEnrollmentKey": {
        const enrollmentKey = genToken("cf_enroll");
        this.store.createEnrollmentKey(hashToken(enrollmentKey), client.accountId!, Date.now());
        this.sendClient(client, { type: "enrollmentKey.created", enrollmentKey, daemonUrl: config.daemonUrl });
        log.info("enrollment key created", { accountId: client.accountId });
        break;
      }
      case "client.removeDevice": {
        this.removeDevice(client, msg.daemonId);
        break;
      }
      case "client.upgradeDaemon": {
        const device = this.store.getDevice(msg.daemonId);
        if (!device || device.accountId !== client.accountId) return;
        const d = this.daemons.get(msg.daemonId);
        if (!d) return void this.sendClient(client, { type: "error", message: "daemon 不在线" });
        this.sendDaemon(d, { type: "worker.upgrade", version: msg.version, url: msg.url, sha256: msg.sha256, signature: msg.signature });
        log.info("worker upgrade dispatched", { daemonId: msg.daemonId, version: msg.version, download: !!msg.url });
        break;
      }
      case "project.import": {
        const d = this.daemons.get(msg.daemonId);
        if (!d || d.accountId !== client.accountId) {
          this.sendClient(client, { type: "error", message: "daemon 不在线或不属于本账号" });
          return;
        }
        const name = typeof msg.name === "string" && msg.name.trim() ? msg.name.trim() : basename(msg.path);
        const requestId = randomUUID();
        this.pendingOps.register(requestId, msg.daemonId, client, { kind: "project.import", name }, (p) =>
          this.sendClient(p.client, { type: "error", message: "导入超时" }),
        );
        this.sendDaemon(d, { type: "project.validate", requestId, path: msg.path });
        break;
      }
      case "project.remove": {
        const project = this.store.getProject(msg.projectId);
        if (!project || project.accountId !== client.accountId) return;
        const workspaces = this.store.listWorkspacesByProject(project.id);
        const sessionCloses: SessionId[] = [];
        const worktreePaths: string[] = [];
        for (const ws of workspaces) {
          for (const task of this.store.listTasksByWorkspace(ws.id)) if (task.sessionId) sessionCloses.push(task.sessionId);
          if (!ws.isMain) worktreePaths.push(ws.path); // 主工作区=仓库本身，不删
        }
        // 级联删除原子化：要么全删，要么不变
        let removedTaskIds: TaskId[] = [];
        this.store.transaction(() => {
          for (const ws of workspaces) removedTaskIds.push(...this.store.removeTasksByWorkspace(ws.id));
          for (const ws of workspaces) this.store.removeWorkspace(ws.id);
          this.store.removeProject(project.id);
        });
        // 提交后做副作用（关 PTY、删 worktree、广播）
        for (const sid of sessionCloses) {
          this.routeToSessionDaemon(sid, { type: "session.close", sessionId: sid });
          this.sessions.delete(sid);
        }
        const daemon = this.daemons.get(project.daemonId);
        if (daemon) for (const wp of worktreePaths) this.sendDaemon(daemon, { type: "worktree.remove", repoPath: project.repoPath, worktreePath: wp });
        for (const id of removedTaskIds) this.broadcast(project.accountId, { type: "task.removed", taskId: id });
        for (const ws of workspaces) this.broadcast(project.accountId, { type: "workspace.removed", workspaceId: ws.id });
        this.broadcast(project.accountId, { type: "project.removed", projectId: project.id });
        break;
      }
      case "workspace.create": {
        const project = this.store.getProject(msg.projectId);
        if (!project || project.accountId !== client.accountId) {
          this.sendClient(client, { type: "error", message: "项目不存在或不属于本账号" });
          return;
        }
        const d = this.daemons.get(project.daemonId);
        if (!d) {
          this.sendClient(client, { type: "error", message: "daemon 不在线" });
          return;
        }
        const workspaceId = randomUUID();
        const requestId = randomUUID();
        const name = msg.name.trim() || "工作区";
        this.pendingOps.register(requestId, project.daemonId, client, { kind: "worktree.add", projectId: project.id, workspaceId, name }, (p) =>
          this.sendClient(p.client, { type: "error", message: "创建工作区超时" }),
        );
        this.sendDaemon(d, { type: "worktree.add", requestId, repoPath: project.repoPath, workspaceId, name, branch: msg.branch, createNew: msg.createNew });
        break;
      }
      case "workspace.remove": {
        const ws = this.store.getWorkspace(msg.workspaceId);
        if (!ws || ws.accountId !== client.accountId) return;
        if (ws.isMain) {
          this.sendClient(client, { type: "error", message: "主工作区不能删除（删除整个项目即可）" });
          return;
        }
        const project = this.store.getProject(ws.projectId);
        const sessionCloses = this.store.listTasksByWorkspace(ws.id).filter((t) => t.sessionId).map((t) => t.sessionId!);
        let removed: TaskId[] = [];
        this.store.transaction(() => {
          removed = this.store.removeTasksByWorkspace(ws.id);
          this.store.removeWorkspace(ws.id);
        });
        for (const sid of sessionCloses) {
          this.routeToSessionDaemon(sid, { type: "session.close", sessionId: sid });
          this.sessions.delete(sid);
        }
        const daemon = this.daemons.get(ws.daemonId);
        if (daemon && project) this.sendDaemon(daemon, { type: "worktree.remove", repoPath: project.repoPath, worktreePath: ws.path });
        for (const id of removed) this.broadcast(ws.accountId, { type: "task.removed", taskId: id });
        this.broadcast(ws.accountId, { type: "workspace.removed", workspaceId: ws.id });
        break;
      }
      case "task.create": {
        const ws = this.store.getWorkspace(msg.workspaceId);
        if (!ws || ws.accountId !== client.accountId) {
          this.sendClient(client, { type: "error", message: "工作区不存在或不属于本账号" });
          return;
        }
        const ts = Date.now();
        const task: Task = { id: randomUUID(), accountId: ws.accountId, daemonId: ws.daemonId, projectId: ws.projectId, workspaceId: ws.id, title: msg.title || "未命名任务", status: "idle", sessionId: null, exitCode: null, createdAt: ts, updatedAt: ts };
        this.store.createTask(task);
        this.emitTask(task);
        break;
      }
      case "task.start": {
        this.startOrAttachTask(client, msg.taskId, msg.cols, msg.rows);
        break;
      }
      case "task.attach": {
        const task = this.requireTask(client, msg.taskId);
        if (!task) return;
        const s = task.sessionId ? this.sessions.get(task.sessionId) : undefined;
        if (task.status === "running" && s && !s.closing) this.attachWithReplay(client, s.sessionId);
        else this.sendClient(client, { type: "error", message: "任务未在运行，无法 attach" });
        break;
      }
      case "task.stop": {
        const task = this.requireTask(client, msg.taskId);
        if (!task) return;
        const s = task.sessionId ? this.sessions.get(task.sessionId) : undefined;
        if (s && this.isDaemonOnline(s.daemonId)) {
          s.closing = true;
          this.routeToSessionDaemon(s.sessionId, { type: "session.close", sessionId: s.sessionId });
        } else if (task.status === "running") {
          if (task.sessionId) this.sessions.delete(task.sessionId);
          const updated = this.store.updateTask(task.id, { status: "exited", sessionId: null, exitCode: -1 });
          if (updated) this.emitTask(updated);
        }
        break;
      }
      case "task.remove": {
        const task = this.requireTask(client, msg.taskId);
        if (!task) return;
        if (task.sessionId) {
          this.routeToSessionDaemon(task.sessionId, { type: "session.close", sessionId: task.sessionId });
          this.sessions.delete(task.sessionId);
        }
        this.store.removeTask(task.id);
        this.broadcast(task.accountId, { type: "task.removed", taskId: task.id });
        break;
      }
      // pty.input 走二进制数据面（见 handleClientBinary）
      case "pty.resize": {
        const s = this.sessions.get(msg.sessionId);
        if (!s || s.accountId !== client.accountId || s.holder !== client) return;
        this.routeToSessionDaemon(msg.sessionId, { type: "pty.resize", sessionId: msg.sessionId, cols: clampDim(msg.cols, 80), rows: clampDim(msg.rows, 24) });
        break;
      }
      case "client.exec": {
        const ws = this.workspaceForClient(client, msg.workspaceId);
        if (!ws) return void this.relayError(client, "exec", msg.requestId, "工作区不存在或不属于本账号");
        if (!this.isDaemonOnline(ws.daemonId)) return void this.relayError(client, "exec", msg.requestId, "daemon 不在线");
        const reqId = randomUUID();
        // exec 可能慢：服务器端钳制命令超时，并让中继超时 = 命令超时 + 宽限，避免命令仍在跑却误报超时
        const execTimeout = Math.min(config.execMaxTimeoutMs, msg.timeoutMs && msg.timeoutMs > 0 ? msg.timeoutMs : config.execDefaultTimeoutMs);
        this.pendingRelays.register(reqId, ws.daemonId, client, { clientRequestId: msg.requestId, kind: "exec" }, (p) => this.relayError(p.client, p.data.kind, p.data.clientRequestId, "超时"), execTimeout + 5_000);
        this.sendDaemon(this.daemons.get(ws.daemonId)!, { type: "exec.run", requestId: reqId, cwd: ws.path, command: msg.command, args: msg.args, timeoutMs: execTimeout });
        break;
      }
      case "client.fs.list": {
        const ws = this.workspaceForClient(client, msg.workspaceId);
        if (!ws) return void this.relayError(client, "fs.list", msg.requestId, "工作区不存在或不属于本账号");
        if (!this.isDaemonOnline(ws.daemonId)) return void this.relayError(client, "fs.list", msg.requestId, "daemon 不在线");
        const reqId = randomUUID();
        this.pendingRelays.register(reqId, ws.daemonId, client, { clientRequestId: msg.requestId, kind: "fs.list" }, (p) => this.relayError(p.client, p.data.kind, p.data.clientRequestId, "超时"));
        this.sendDaemon(this.daemons.get(ws.daemonId)!, { type: "fs.list", requestId: reqId, root: ws.path, path: msg.path });
        break;
      }
      case "client.fs.read": {
        const ws = this.workspaceForClient(client, msg.workspaceId);
        if (!ws) return void this.relayError(client, "fs.read", msg.requestId, "工作区不存在或不属于本账号");
        if (!this.isDaemonOnline(ws.daemonId)) return void this.relayError(client, "fs.read", msg.requestId, "daemon 不在线");
        const reqId = randomUUID();
        this.pendingRelays.register(reqId, ws.daemonId, client, { clientRequestId: msg.requestId, kind: "fs.read" }, (p) => this.relayError(p.client, p.data.kind, p.data.clientRequestId, "超时"));
        this.sendDaemon(this.daemons.get(ws.daemonId)!, { type: "fs.read", requestId: reqId, root: ws.path, path: msg.path });
        break;
      }
    }
  }

  private workspaceForClient(client: ClientConn, workspaceId: WorkspaceId): Workspace | undefined {
    const ws = this.store.getWorkspace(workspaceId);
    return ws && ws.accountId === client.accountId ? ws : undefined;
  }

  private requireTask(client: ClientConn, taskId: TaskId): Task | undefined {
    const task = this.store.getTask(taskId);
    if (!task || task.accountId !== client.accountId) {
      this.sendClient(client, { type: "error", message: `任务不存在：${taskId}` });
      return undefined;
    }
    return task;
  }

  private startOrAttachTask(client: ClientConn, taskId: TaskId, cols: number, rows: number): void {
    const task = this.requireTask(client, taskId);
    if (!task) return;

    if (task.status === "running" && task.sessionId) {
      const s = this.sessions.get(task.sessionId);
      if (s && !s.closing) return void this.attachWithReplay(client, s.sessionId);
      if (s && s.closing) return void this.sendClient(client, { type: "error", message: "任务正在停止，请稍候重试" });
      this.sendClient(client, { type: "error", message: "会话恢复中，请稍候重试" });
      return;
    }

    const d = this.daemons.get(task.daemonId);
    if (!d) return void this.sendClient(client, { type: "error", message: `daemon 不在线：${task.daemonId}` });
    const ws = this.store.getWorkspace(task.workspaceId);
    if (!ws) return void this.sendClient(client, { type: "error", message: "工作区已不存在" });

    const sessionId = randomUUID();
    this.sessions.set(sessionId, { sessionId, daemonId: task.daemonId, accountId: task.accountId, taskId: task.id, holder: client, closing: false });
    this.sendDaemon(d, { type: "session.create", sessionId, taskId: task.id, cwd: ws.path, cols: clampDim(cols, 80), rows: clampDim(rows, 24) });
    const updated = this.store.updateTask(task.id, { status: "running", sessionId, exitCode: null });
    if (updated) this.emitTask(updated);
  }

  private attachWithReplay(client: ClientConn, sessionId: SessionId): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    if (!this.isDaemonOnline(s.daemonId)) return void this.sendClient(client, { type: "error", message: "daemon 离线，无法回放" });
    const requestId = randomUUID();
    this.pendingReplays.register(requestId, s.daemonId, client, { sessionId }, (p) =>
      this.sendClient(p.client, { type: "error", message: "回放超时" }),
    );
    const ok = this.routeToSessionDaemon(sessionId, { type: "session.replay", sessionId, requestId });
    if (!ok) {
      this.pendingReplays.take(requestId);
      this.sendClient(client, { type: "error", message: "daemon 离线，无法回放" });
    }
  }

  private removeDevice(client: ClientConn, daemonId: DaemonId): void {
    const device = this.store.getDevice(daemonId);
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
    for (const [sid, s] of this.sessions) if (s.daemonId === daemonId) this.sessions.delete(sid);
    this.pendingOps.removeByDaemon(daemonId);
    this.pendingReplays.removeByDaemon(daemonId);
    this.pendingRelays.removeByDaemon(daemonId, (p) => this.relayError(p.client, p.data.kind, p.data.clientRequestId, "daemon 已移除"));

    const workspaces = this.store.listWorkspacesByDaemon(daemonId);
    const projects = this.store.listProjectsByDaemon(daemonId);
    let taskIds: TaskId[] = [];
    this.store.transaction(() => {
      this.store.revokeDevice(daemonId);
      taskIds = this.store.removeTasksByDaemon(daemonId);
      for (const w of workspaces) this.store.removeWorkspace(w.id);
      for (const p of projects) this.store.removeProject(p.id);
    });
    for (const id of taskIds) this.broadcast(accountId, { type: "task.removed", taskId: id });
    for (const w of workspaces) this.broadcast(accountId, { type: "workspace.removed", workspaceId: w.id });
    for (const p of projects) this.broadcast(accountId, { type: "project.removed", projectId: p.id });
    this.broadcast(accountId, { type: "daemon.removed", daemonId });
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
