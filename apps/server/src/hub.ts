/**
 * Hub —— 服务器的编排/路由核心。
 *
 * 模型（项目制）：Account → Device → Project(git 仓库) → Workspace(主=仓库本身 / 其它=git worktree) → Task → Session。
 *
 * 认证（Tailscale 式）：daemonId 服务器签发绑定不可冒充；account 隔离。
 * 健壮性（经两轮对抗式审查）：daemon 上行消息按 task.daemonId === conn.daemonId 归属校验；
 *   重启后绝不重复起 PTY；pending 超时 + 掉线清理；client 越权拦截。
 *
 * 存储层是 Postgres（异步）：所有触库路径已 async 化。并发语义靠 DB 约束兜底（主键/唯一约束/
 * ON CONFLICT）而非应用层锁；级联删除、lazy provision 等多语句操作经 `store.transaction()` 保证
 * 原子性。单连接内消息处理不做串行队列（同连接消息仍可能交错，见 plans/002 决策）——各 handler
 * 内部保持"写完再广播"的顺序（await 与其后的同步语句之间不留出让点），确需的跨语句原子性交给事务。
 *
 * wire：WS 上只有 binary protobuf 信封。terminal 与普通设备 RPC 封装在端到端 DeviceEnvelope，
 * 中心只转发 opaque bytes；中心可见的数据面只剩端口代理的 ProxyData 与派生 checkpoint。
 */
import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import type { WebSocket } from "ws";
import {
  create,
  clampDim,
  decodeDeviceEnvelope,
  DEVICE_PROTOCOL_VERSION,
  encodeDeviceEnvelope,
  encodeServerToDaemon,
  encodeServerToClient,
  MAX_SESSION_CHECKPOINT_BYTES,
  DeviceEnvelopeSchema,
  ServerToDaemonSchema,
  ServerToClientSchema,
  ProjectSchema,
  WorkspaceSchema,
  TaskSchema,
  TaskStatus,
  DeviceScope,
  type AccountId,
  type DaemonId,
  type DeviceRelayConnect,
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
  type DeviceOperationReport,
  type DeviceEnvelope,
  type DeviceEnvelopePayload,
  type DeviceSessionCatalog,
  type DeviceSessionInfo,
  type SessionCheckpoint,
} from "@coflux/protocol";
import { createLogger } from "@coflux/core";
import {
  Store,
  type NewPreparedOperation,
  type PreparedOperationRecord,
  type SessionCheckpointRecord,
} from "./store.js";
import { genToken, hashToken } from "./secrets.js";
import { config } from "./config.js";
import { ProxyRouteTable, ProxyGate, TunnelRegistry, buildPreviewUrl, parseProxyRedirect, buildAuthCallbackUrl } from "./proxy.js";
import { RelayTokenSigner, allowRendezvous, buildRelayPipeUrl, validRelayId } from "./relay-rendezvous.js";
import { LocalControlPlane } from "./local-control.js";
import type { SupabaseVerifier, SupabaseIdentity } from "./auth.js";

const log = createLogger("hub");
const MAX_PREPARED_FRAME_BYTES = 1024 * 1024;
const MAX_ACTIVE_PREPARED_PER_DAEMON = 128;
const MAX_CATALOG_ENTRIES = 4096;
const MAX_CATALOG_PATH_BYTES = 16 * 1024;
const MAX_RETAINED_CATALOG_BYTES = 4 * 1024 * 1024;
const MAX_CONTROL_ID_BYTES = 256;

/** daemon 展示信息：不用生成的 DaemonInfo 消息类型（无需 $typeName）——它只作为其它信封消息的
 * 嵌套字段被构造（nested init 接受纯对象），从不单独序列化，用生成类型纯属多余的仪式。 */
interface DaemonInfoData {
  daemonId: DaemonId;
  name: string;
  host: string;
  platform: string;
  online: boolean;
  /** 热更新编排（plan 015）：在线连接握手时上报，供 web 展示 + server 自动升级比对；
   * 离线设备（来自 devices 表）无此信息——版本不入库，纯在线连接内存态，空串即"未知"。 */
  workerVersion: string;
  supervisorVersion: string;
}

export interface DaemonConn {
  info: DaemonInfoData;
  accountId: AccountId;
  /** 握手上报的 CPU 架构（std::env::consts::ARCH），仅供自动升级编排做 target 映射，不下发给 web。 */
  arch: string;
  ws: WebSocket;
}
export interface ClientConn {
  ws: WebSocket;
  accountId: AccountId | null;
  subscribed: boolean;
  /** 浏览器 WebSocket 握手的真实 Origin；localPairRequest 的自报 origin 必须与它精确相等。 */
  origin?: string;
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
  workerVersion: string;
  supervisorVersion: string;
  arch: string;
  createdAt: number;
  timer: ReturnType<typeof setTimeout>;
}

interface RuntimeSession {
  sessionId: SessionId;
  daemonId: DaemonId;
  accountId: AccountId;
  taskId: TaskId;
}

interface PreparedWaiter {
  client: ClientConn;
  timer: ReturnType<typeof setTimeout>;
}

interface OperationEffect {
  accountId: AccountId;
  daemonId: DaemonId;
  project?: Project;
  workspace?: Workspace;
  task?: Task;
  sessionId?: SessionId;
  removedTaskIds?: TaskId[];
  removedWorkspaceId?: WorkspaceId;
  deletingProjectId?: ProjectId;
  error?: string;
}

class OperationConvergenceError extends Error {}

export class Hub {
  private daemons = new Map<DaemonId, DaemonConn>();
  private sessions = new Map<SessionId, RuntimeSession>();
  private clients = new Set<ClientConn>();
  private preparedWaiters = new Map<string, Set<PreparedWaiter>>();
  private preparedRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private catalog = new Map<DaemonId, Map<SessionId, DeviceSessionInfo>>();
  private readonly localControl: LocalControlPlane<ClientConn, DaemonConn>;
  /** 独立 relay 的 token 签发（plan 043）；server 不再承载 relay 数据面。 */
  private readonly relayTokens: RelayTokenSigner;
  /** 待确认的设备授权请求，键为一次性 token（cf_authz_*） */
  private pendingAuthorizations = new Map<string, PendingAuthorization>();

  /** daemon 握手完成的回调（plan 015 自动更新编排挂载点）：index.ts 在 Hub 与编排单元都构造完后
   * 赋值，避免 hub.ts 反向 import 编排模块——依赖倒置，同 tunnels 的 sendControl 回调先例。 */
  onDaemonHandshake?: (daemonId: DaemonId) => void;

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
  constructor(private store: Store, private verifier?: SupabaseVerifier) {
    this.localControl = new LocalControlPlane(
      store,
      (daemonId) => this.daemons.get(daemonId),
      (daemon, payload) => this.sendDaemon(daemon, payload),
      (client, payload) => this.sendClient(client, payload),
    );
    this.relayTokens = new RelayTokenSigner(config.relaySigningKeySeed);
  }

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
      list.push({ daemonId: dev.id, name: dev.name, host: dev.host, platform: dev.platform, online: false, workerVersion: "", supervisorVersion: "" });
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

  private async registerDaemonConn(conn: DaemonCtx, info: DaemonInfoData, accountId: AccountId, arch: string): Promise<void> {
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
    const daemon = { ws: conn.ws, info, accountId, arch };
    this.daemons.set(info.daemonId, daemon);
    await this.store.touchDevice(info.daemonId, Date.now());
    this.broadcast(accountId, { case: "daemonUpdated", value: { daemon: { ...info, online: true } } });
    await this.pushWorkspaceList(info.daemonId);
    // 握手完成时机：下发最新设备名称以支持设备重命名同步（plan 018）
    this.sendDaemon(daemon, { case: "daemonSetName", value: { name: info.name } });
    // durable grant/prepared state 由中心在每次 daemon 认证后重装；lease 不跨连接恢复。
    await this.localControl.restoreDaemon(daemon);
    await this.restorePreparedOperations(daemon);
    await this.reconcileDeletingProjects(daemon);
    this.requestSessionCatalog(daemon);
    // 握手完成时机（plan 015）：给自动更新编排一个立即比对本台 daemon 的机会，不必等下一次轮询。
    this.onDaemonHandshake?.(info.daemonId);
  }

  /** 自动更新编排（plan 015）读取在线 daemon 快照用于比对期望版本。 */
  listOnlineDaemonsForUpdate(): { daemonId: DaemonId; workerVersion: string; platform: string; arch: string }[] {
    return [...this.daemons.values()].map((d) => ({ daemonId: d.info.daemonId, workerVersion: d.info.workerVersion, platform: d.info.platform, arch: d.arch }));
  }

  /** 对某在线 daemon 下发 worker 升级：复用 clientUpgradeDaemon 的发送路径，不绕过/复制 supervisor 侧语义。 */
  sendWorkerUpgrade(daemonId: DaemonId, payload: { version: string; url: string; sha256: string; signature: string }): boolean {
    const d = this.daemons.get(daemonId);
    if (!d) return false;
    this.sendDaemon(d, { case: "workerUpgrade", value: payload });
    return true;
  }

  /** 全量下发某设备的工作区清单（连接时 + 工作区增删时），worker 据此监视各 worktree 的 HEAD 分支 +
   * git diff 统计；defaultBranch 带出所属 project 的默认分支（diff 统计基准），server DB 是权威值，
   * worker 不自行猜测。 */
  private async pushWorkspaceList(daemonId: DaemonId): Promise<void> {
    const daemon = this.daemons.get(daemonId);
    if (!daemon) return;
    const [workspaces, projects] = await Promise.all([this.store.listWorkspacesByDaemon(daemonId), this.store.listProjectsByDaemon(daemonId)]);
    const defaultBranchByProject = new Map(projects.map((p) => [p.id, p.defaultBranch]));
    this.sendDaemon(daemon, {
      case: "workspaceList",
      value: { workspaces: workspaces.map((ws) => ({ workspaceId: ws.id, path: ws.path, defaultBranch: defaultBranchByProject.get(ws.projectId) ?? "" })) },
    });
  }

  private currentDaemon(conn: DaemonCtx): DaemonConn | undefined {
    if (!conn.daemonId) return undefined;
    const daemon = this.daemons.get(conn.daemonId);
    return daemon?.ws === conn.ws ? daemon : undefined;
  }

  private requestSessionCatalog(daemon: DaemonConn): void {
    this.sendDaemon(daemon, { case: "sessionCatalogRequest", value: { requestId: randomUUID() } });
  }

  /**
   * sessiond catalog/tombstone 是活 PTY truth。unknown/mismatched session 只保留为 local orphan；
   * 中心不自动创建 task，也绝不因“不认识”而关闭它。
   */
  private async reconcileSessionCatalog(daemon: DaemonConn, catalog: DeviceSessionCatalog): Promise<void> {
    if (!validControlId(catalog.requestId) || catalog.sessions.length > MAX_CATALOG_ENTRIES || catalog.exits.length > MAX_CATALOG_ENTRIES) return;
    const live = new Map<SessionId, DeviceSessionInfo>();
    let retainedBytes = 0;
    for (const session of catalog.sessions) {
      if (!validControlId(session.sessionId) || !validControlId(session.taskId) || live.has(session.sessionId)) continue;
      const cwdBytes = Buffer.byteLength(session.cwd, "utf8");
      const entryBytes = Buffer.byteLength(session.sessionId, "utf8") + Buffer.byteLength(session.taskId, "utf8") + cwdBytes + 64;
      if (
        cwdBytes > MAX_CATALOG_PATH_BYTES ||
        retainedBytes > MAX_RETAINED_CATALOG_BYTES - entryBytes ||
        session.pid <= 0 ||
        session.cols < 1 ||
        session.cols > 1000 ||
        session.rows < 1 ||
        session.rows > 1000 ||
        !Number.isFinite(session.startedAt) ||
        session.startedAt <= 0
      ) continue;
      retainedBytes += entryBytes;
      live.set(session.sessionId, session);
      const task = await this.store.getTask(session.taskId);
      if (!task || task.accountId !== daemon.accountId || task.daemonId !== daemon.info.daemonId) continue;
      if (task.sessionId && task.sessionId !== session.sessionId) continue;
      if (task.status === TaskStatus.EXITED && !task.sessionId) {
        const latest = await this.store.findLatestPreparedOperation(task.accountId, task.daemonId, "session.create", task.id);
        if (latest?.reportSessionId === session.sessionId && latest.reportExitCode !== null) continue;
      }
      if (!this.sessions.has(session.sessionId)) {
        this.sessions.set(session.sessionId, {
          sessionId: session.sessionId,
          daemonId: daemon.info.daemonId,
          accountId: daemon.accountId,
          taskId: session.taskId,
        });
      }
      if (task.status !== TaskStatus.RUNNING || task.sessionId !== session.sessionId) {
        const updated = await this.store.updateTask(task.id, { status: TaskStatus.RUNNING, sessionId: session.sessionId, exitCode: undefined });
        if (updated) this.emitTask(updated);
      }
    }
    this.catalog.set(daemon.info.daemonId, live);

    const ackIds: string[] = [];
    const seenExitEvents = new Set<string>();
    for (const exit of catalog.exits) {
      if (
        !validControlId(exit.eventId) ||
        !validControlId(exit.sessionId) ||
        !validControlId(exit.taskId) ||
        seenExitEvents.has(exit.eventId) ||
        !Number.isFinite(exit.exitedAt)
      ) continue;
      seenExitEvents.add(exit.eventId);
      const updated = await this.store.transaction(async (tx) => {
        const task = await tx.getTask(exit.taskId);
        if (!task || task.accountId !== daemon.accountId || task.daemonId !== daemon.info.daemonId) return undefined;
        const operation = await tx.findLatestPreparedOperation(task.accountId, task.daemonId, "session.create", task.id);
        const metadata = operation ? parseOperationMetadata(operation.metadata) : undefined;
        const preparedSessionId = metadata && metadataString(metadata, "sessionId");
        const matchesCurrent = task.sessionId === exit.sessionId;
        const matchesPendingCreate = !task.sessionId && preparedSessionId === exit.sessionId;
        if (!matchesCurrent && !matchesPendingCreate) return undefined;
        if (task.status === TaskStatus.EXITED && task.exitCode === exit.exitCode && !task.sessionId) {
          if (operation && !operation.completed) {
            await tx.finishPreparedOperationFromExit(operation.operationId, task.id, exit.sessionId, exit.exitCode);
          }
          return undefined;
        }
        const changed = await tx.updateTask(task.id, {
          status: TaskStatus.EXITED,
          sessionId: undefined,
          exitCode: exit.exitCode,
        });
        if (operation && preparedSessionId === exit.sessionId && !operation.completed) {
          await tx.finishPreparedOperationFromExit(operation.operationId, task.id, exit.sessionId, exit.exitCode);
        }
        return changed;
      });
      if (updated) this.emitTask(updated);
      this.dropSession(exit.sessionId);
      // unknown/orphan tombstone 无需业务映射，但仍可在持久化收敛后 ack 让 sessiond 有界清理。
      ackIds.push(exit.eventId);
    }
    if (ackIds.length > 0) this.sendDaemon(daemon, { case: "exitAck", value: { eventIds: ackIds } });
    log.debug("session catalog reconciled", { daemonId: daemon.info.daemonId, live: live.size, exits: ackIds.length });
  }

  private async acceptSessionCheckpoint(daemon: DaemonConn, checkpoint: SessionCheckpoint): Promise<void> {
    if (
      !validControlId(checkpoint.sessionId) ||
      !validControlId(checkpoint.taskId) ||
      checkpoint.ansiSnapshot.byteLength > MAX_SESSION_CHECKPOINT_BYTES ||
      checkpoint.cols < 1 ||
      checkpoint.cols > 1000 ||
      checkpoint.rows < 1 ||
      checkpoint.rows > 1000 ||
      !Number.isFinite(checkpoint.capturedAt) ||
      checkpoint.capturedAt <= 0 ||
      checkpoint.capturedAt > Date.now() + 5 * 60_000
    ) return;
    const live = this.catalog.get(daemon.info.daemonId)?.get(checkpoint.sessionId);
    const runtime = this.sessions.get(checkpoint.sessionId);
    const matchesKnownSession = live
      ? live.taskId === checkpoint.taskId
      : runtime?.daemonId === daemon.info.daemonId && runtime.taskId === checkpoint.taskId;
    if (!matchesKnownSession) return;
    const task = await this.store.getTask(checkpoint.taskId);
    if (
      !task ||
      task.accountId !== daemon.accountId ||
      task.daemonId !== daemon.info.daemonId ||
      task.sessionId !== checkpoint.sessionId ||
      task.status !== TaskStatus.RUNNING
    ) return;
    const stored = await this.store.upsertSessionCheckpoint(daemon.accountId, daemon.info.daemonId, checkpoint);
    if (!stored) return; // duplicate/older seq
    for (const client of this.clients) if (client.subscribed && client.accountId === daemon.accountId) this.sendCheckpoint(client, stored);
  }

  private sendCheckpoint(client: ClientConn, checkpoint: SessionCheckpointRecord): void {
    this.sendClient(client, {
      case: "sessionCheckpoint",
      value: {
        sessionId: checkpoint.sessionId,
        taskId: checkpoint.taskId,
        snapshotSeq: checkpoint.snapshotSeq,
        ansiSnapshot: checkpoint.ansiSnapshot,
        cols: checkpoint.cols,
        rows: checkpoint.rows,
        capturedAt: checkpoint.capturedAt,
      },
    });
  }

  /* ----------------------- durable prepared op ----------------------- */

  private preparedFrame(operationId: string, payload: DeviceEnvelopePayload): Uint8Array {
    if (!validControlId(operationId)) throw new Error("prepared operationId 无效");
    const frame = encodeDeviceEnvelope(create(DeviceEnvelopeSchema, {
      protocolVersion: DEVICE_PROTOCOL_VERSION,
      channelId: "",
      payload,
    }));
    if (frame.byteLength === 0 || frame.byteLength > MAX_PREPARED_FRAME_BYTES) throw new Error("prepared operation frame 超限");
    return frame;
  }

  private async prepareOperation(client: ClientConn, operation: NewPreparedOperation): Promise<void> {
    await this.store.expirePreparedOperations(Date.now());
    if (operation.targetId) {
      const existing = await this.store.findActivePreparedOperation(operation.accountId, operation.kind, operation.targetId, Date.now());
      if (existing) {
        if (existing.state === "installed") {
          this.sendPrepared(client, existing);
        } else {
          this.watchPrepared(existing.operationId, client);
          this.dispatchPrepared(existing);
        }
        return;
      }
    }
    if ((await this.store.countActivePreparedOperations(operation.accountId, operation.daemonId, Date.now())) >= MAX_ACTIVE_PREPARED_PER_DAEMON) {
      this.sendClient(client, { case: "error", value: { message: "该 daemon 的 prepared operation 已达上限，请稍后重试" } });
      return;
    }
    const created = await this.store.createPreparedOperation(operation);
    if (!created && operation.targetId) {
      const raced = await this.store.findActivePreparedOperation(operation.accountId, operation.kind, operation.targetId, Date.now());
      if (raced) {
        if (raced.state === "installed") {
          this.sendPrepared(client, raced);
        } else {
          this.watchPrepared(raced.operationId, client);
          this.dispatchPrepared(raced);
        }
        return;
      }
    }
    if (!created) return void this.sendClient(client, { case: "error", value: { message: "prepared operation ID 冲突" } });
    this.watchPrepared(created.operationId, client);
    this.dispatchPrepared(created);
  }

  private async restorePreparedOperations(daemon: DaemonConn): Promise<void> {
    await this.store.expirePreparedOperations(Date.now());
    for (const operation of await this.store.listInstallablePreparedOperations(daemon.info.daemonId, Date.now())) {
      if (operation.accountId === daemon.accountId) this.dispatchPrepared(operation);
    }
  }

  private dispatchPrepared(operation: PreparedOperationRecord): void {
    const daemon = this.daemons.get(operation.daemonId);
    if (!daemon || daemon.accountId !== operation.accountId || operation.completed || operation.expiresAt <= Date.now()) return;
    this.sendDaemon(daemon, {
      case: "preparedDeviceOperation",
      value: {
        operationId: operation.operationId,
        daemonId: operation.daemonId,
        frame: operation.frame,
        expiresAt: operation.expiresAt,
      },
    });
    const previous = this.preparedRetryTimers.get(operation.operationId);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => void this.retryPrepared(operation.operationId), 1_000);
    timer.unref?.();
    this.preparedRetryTimers.set(operation.operationId, timer);
  }

  private async retryPrepared(operationId: string): Promise<void> {
    this.preparedRetryTimers.delete(operationId);
    const operation = await this.store.getPreparedOperation(operationId);
    if (!operation || operation.completed || operation.state === "installed") return;
    if (operation.expiresAt <= Date.now()) {
      await this.store.expirePreparedOperations(Date.now());
      this.failPreparedWaiters(operationId, "prepared operation 安装超时，可安全重试");
      return;
    }
    if (!this.daemons.has(operation.daemonId)) return;
    this.dispatchPrepared(operation);
  }

  private async handlePreparedInstalled(daemon: DaemonConn, operationId: string, ok: boolean, error?: string): Promise<void> {
    if (!validControlId(operationId)) return;
    const operation = await this.store.markPreparedOperationInstalled(operationId, daemon.info.daemonId, ok, error ?? null);
    if (!operation || operation.accountId !== daemon.accountId) return;
    const retry = this.preparedRetryTimers.get(operationId);
    if (retry) clearTimeout(retry);
    this.preparedRetryTimers.delete(operationId);
    if (!ok) return void this.failPreparedWaiters(operationId, error ?? "daemon 拒绝 prepared operation");
    const waiters = this.preparedWaiters.get(operationId);
    if (waiters) for (const waiter of waiters) this.sendPrepared(waiter.client, operation);
    this.clearPreparedWaiters(operationId);
  }

  private sendPrepared(client: ClientConn, operation: PreparedOperationRecord): void {
    this.sendClient(client, {
      case: "preparedDeviceOperation",
      value: {
        operationId: operation.operationId,
        daemonId: operation.daemonId,
        frame: operation.frame,
        expiresAt: operation.expiresAt,
      },
    });
  }

  private watchPrepared(operationId: string, client: ClientConn): void {
    const waiters = this.preparedWaiters.get(operationId) ?? new Set<PreparedWaiter>();
    if ([...waiters].some((waiter) => waiter.client === client)) return;
    const waiter: PreparedWaiter = {
      client,
      timer: setTimeout(() => {
        waiters.delete(waiter);
        if (waiters.size === 0) this.preparedWaiters.delete(operationId);
        this.sendClient(client, { case: "error", value: { message: "prepared operation 安装确认超时" } });
      }, config.pendingTimeoutMs),
    };
    waiter.timer.unref?.();
    waiters.add(waiter);
    this.preparedWaiters.set(operationId, waiters);
  }

  private failPreparedWaiters(operationId: string, message: string): void {
    const waiters = this.preparedWaiters.get(operationId);
    if (waiters) for (const waiter of waiters) this.sendClient(waiter.client, { case: "error", value: { message } });
    this.clearPreparedWaiters(operationId);
  }

  private clearPreparedWaiters(operationId: string): void {
    const waiters = this.preparedWaiters.get(operationId);
    if (waiters) for (const waiter of waiters) clearTimeout(waiter.timer);
    this.preparedWaiters.delete(operationId);
  }

  private removePreparedWaitersByClient(client: ClientConn): void {
    for (const [operationId, waiters] of this.preparedWaiters) {
      for (const waiter of [...waiters]) {
        if (waiter.client !== client) continue;
        clearTimeout(waiter.timer);
        waiters.delete(waiter);
      }
      if (waiters.size === 0) this.preparedWaiters.delete(operationId);
    }
  }

  private async handleDeviceOperationReport(daemon: DaemonConn, report: DeviceOperationReport): Promise<void> {
    if (
      !validControlId(report.operationId) ||
      report.daemonId !== daemon.info.daemonId ||
      !report.resultFrame ||
      report.resultFrame.byteLength === 0 ||
      report.resultFrame.byteLength > MAX_PREPARED_FRAME_BYTES
    ) return;
    const known = await this.store.getPreparedOperation(report.operationId);
    if (!known || known.accountId !== daemon.accountId || known.daemonId !== daemon.info.daemonId || known.completed) return;
    const result = decodeDeviceEnvelope(report.resultFrame);
    if (!result || result.protocolVersion !== DEVICE_PROTOCOL_VERSION || result.channelId !== "" || !result.payload.case) return;
    if (!validOperationResult(known, report, result.payload)) return;

    let effect: OperationEffect | undefined;
    try {
      await this.store.transaction(async (tx) => {
        const operation = await tx.claimPreparedOperationReport(report.operationId, daemon.info.daemonId);
        if (!operation) return;
        const metadata = parseOperationMetadata(operation.metadata);
        if (!metadata) throw new OperationConvergenceError("prepared operation metadata 损坏");

        effect = { accountId: operation.accountId, daemonId: operation.daemonId };
        if (!report.ok) {
          effect.error = report.error ?? "设备操作失败";
        } else if (operation.kind === "project.import" && result.payload.case === "projectValidated") {
          const value = result.payload.value;
          const projectId = metadataString(metadata, "projectId");
          const workspaceId = metadataString(metadata, "workspaceId");
          if (!projectId || !workspaceId || !value.repoPath || !value.branch) throw new OperationConvergenceError("project.import report 缺少收敛字段");
          const suggestedName = value.suggestedName?.trim();
          const explicitName = metadataString(metadata, "explicitName");
          const ts = Date.now();
          const project = create(ProjectSchema, {
            id: projectId,
            accountId: operation.accountId,
            daemonId: operation.daemonId,
            name: explicitName ?? (suggestedName || basename(value.repoPath)),
            repoPath: value.repoPath,
            defaultBranch: value.branch,
            createdAt: ts,
          });
          const workspace = create(WorkspaceSchema, {
            id: workspaceId,
            accountId: operation.accountId,
            daemonId: operation.daemonId,
            projectId,
            name: "main",
            path: value.repoPath,
            branch: value.branch,
            isMain: true,
            createdAt: ts,
          });
          await tx.createProject(project);
          await tx.createWorkspace(workspace);
          effect.project = project;
          effect.workspace = workspace;
        } else if (operation.kind === "worktree.add" && result.payload.case === "worktreeAdded") {
          const value = result.payload.value;
          const projectId = metadataString(metadata, "projectId");
          const workspaceId = metadataString(metadata, "workspaceId");
          const name = metadataString(metadata, "name");
          if (!projectId || !workspaceId || !name || !value.path || !value.branch) throw new OperationConvergenceError("worktree.add report 缺少收敛字段");
          const project = await tx.claimActiveProject(projectId);
          if (
            !project ||
            project.accountId !== operation.accountId ||
            project.daemonId !== operation.daemonId
          ) throw new OperationConvergenceError("worktree.add target project 已失效或正在删除");
          const workspace = create(WorkspaceSchema, {
            id: workspaceId,
            accountId: operation.accountId,
            daemonId: operation.daemonId,
            projectId,
            name,
            path: value.path,
            branch: value.branch,
            isMain: false,
            createdAt: Date.now(),
          });
          await tx.createWorkspace(workspace);
          effect.workspace = workspace;
        } else if (operation.kind === "worktree.remove" && result.payload.case === "operationAck") {
          const workspaceId = metadataString(metadata, "workspaceId");
          const projectId = metadataString(metadata, "projectId");
          if (!workspaceId || !projectId) throw new OperationConvergenceError("worktree.remove report 缺少收敛字段");
          const workspace = await tx.getWorkspace(workspaceId);
          if (
            workspace &&
            (workspace.accountId !== operation.accountId ||
              workspace.daemonId !== operation.daemonId ||
              workspace.projectId !== projectId ||
              workspace.isMain ||
              workspace.createdAt !== operation.targetVersion)
          ) throw new OperationConvergenceError("worktree.remove target version/CAS 已变化");
          if (workspace) {
            const removedTaskIds = await tx.removeTasksByWorkspace(workspace.id);
            for (const taskId of removedTaskIds) await tx.removeSessionCheckpointsByTask(taskId);
            await tx.removeWorkspace(workspace.id);
            effect.removedTaskIds = removedTaskIds;
            effect.removedWorkspaceId = workspace.id;
          }
          // standalone workspace 删除时 finalizer 会因 project.deleting=false 安全空转；若同一 op
          // 后来被 projectRemove 复用，则仍能完成项目级收口。
          effect.deletingProjectId = projectId;
        } else if (operation.kind === "session.create" && result.payload.case === "operationAck") {
          const value = result.payload.value;
          const taskId = metadataString(metadata, "taskId");
          const sessionId = metadataString(metadata, "sessionId");
          if (
            !taskId ||
            !sessionId ||
            value.sessionId !== sessionId ||
            (report.taskId !== undefined && report.taskId !== taskId) ||
            (report.sessionId !== undefined && report.sessionId !== sessionId)
          ) throw new OperationConvergenceError("session.create report 绑定不匹配");
          const task = await tx.getTask(taskId);
          if (!task || task.accountId !== operation.accountId || task.daemonId !== operation.daemonId) throw new OperationConvergenceError("session.create target task 已失效");
          let updated = task;
          if (task.status !== TaskStatus.RUNNING || task.sessionId !== sessionId) {
            if (task.status === TaskStatus.RUNNING || task.sessionId || task.updatedAt !== operation.targetVersion) {
              throw new OperationConvergenceError("session.create target version/CAS 已变化");
            }
            const changed = await tx.updateTask(task.id, { status: TaskStatus.RUNNING, sessionId, exitCode: undefined });
            if (!changed) throw new OperationConvergenceError("session.create target task 已删除");
            updated = changed;
          }
          effect.task = updated;
          effect.sessionId = sessionId;
        } else {
          throw new OperationConvergenceError(`prepared operation result 类型不匹配: ${operation.kind}`);
        }

        const finished = await tx.finishPreparedOperation(operation.operationId, report);
        if (!finished) throw new Error("prepared operation report 提交冲突");
      });
    } catch (error) {
      if (!(error instanceof OperationConvergenceError)) throw error;
      const failed = await this.store.failPreparedOperationConvergence(report.operationId, daemon.info.daemonId, error.message);
      if (failed) {
        const retry = this.preparedRetryTimers.get(report.operationId);
        if (retry) clearTimeout(retry);
        this.preparedRetryTimers.delete(report.operationId);
        this.clearPreparedWaiters(report.operationId);
        this.broadcast(failed.accountId, { case: "error", value: { message: error.message } });
      }
      return;
    }

    if (!effect) return; // duplicate report
    const retry = this.preparedRetryTimers.get(report.operationId);
    if (retry) clearTimeout(retry);
    this.preparedRetryTimers.delete(report.operationId);
    this.clearPreparedWaiters(report.operationId);
    if (effect.project) {
      this.broadcast(effect.accountId, { case: "projectCreated", value: { project: effect.project } });
      log.info("project imported", { projectId: effect.project.id, repoPath: effect.project.repoPath });
    }
    if (effect.workspace) this.broadcast(effect.accountId, { case: "workspaceCreated", value: { workspace: effect.workspace } });
    for (const taskId of effect.removedTaskIds ?? []) this.broadcast(effect.accountId, { case: "taskRemoved", value: { taskId } });
    if (effect.removedWorkspaceId) this.broadcast(effect.accountId, { case: "workspaceRemoved", value: { workspaceId: effect.removedWorkspaceId } });
    if (effect.project || effect.workspace) await this.pushWorkspaceList(effect.daemonId);
    if (effect.removedWorkspaceId) await this.pushWorkspaceList(effect.daemonId);
    if (effect.deletingProjectId) await this.finalizeDeletingProject(effect.deletingProjectId, effect.accountId, effect.daemonId);
    if (effect.task && effect.sessionId) {
      this.sessions.set(effect.sessionId, {
        sessionId: effect.sessionId,
        daemonId: effect.daemonId,
        accountId: effect.accountId,
        taskId: effect.task.id,
      });
      this.emitTask(effect.task);
    }
    if (effect.error) this.broadcast(effect.accountId, { case: "error", value: { message: effect.error } });
  }

  private async prepareWorktreeRemoval(client: ClientConn, project: Project, workspace: Workspace, removeProject: boolean): Promise<void> {
    const operationId = randomUUID();
    const frame = this.preparedFrame(operationId, {
      case: "worktreeRemove",
      value: {
        requestId: operationId,
        operationId,
        repoPath: project.repoPath,
        worktreePath: workspace.path,
      },
    });
    await this.prepareOperation(client, {
      operationId,
      accountId: workspace.accountId,
      daemonId: workspace.daemonId,
      kind: "worktree.remove",
      targetId: workspace.id,
      targetVersion: workspace.createdAt,
      frame,
      metadata: JSON.stringify({ projectId: project.id, workspaceId: workspace.id, removeProject }),
      expiresAt: Date.now() + config.preparedOperationTtlMs,
    });
  }

  private async reconcileDeletingProjects(daemon: DaemonConn): Promise<void> {
    for (const project of await this.store.listDeletingProjectsByDaemon(daemon.info.daemonId)) {
      if (project.accountId === daemon.accountId) await this.finalizeDeletingProject(project.id, project.accountId, project.daemonId);
    }
  }

  private async finalizeDeletingProject(projectId: ProjectId, accountId: AccountId, daemonId: DaemonId): Promise<void> {
    let removedTaskIds: TaskId[] = [];
    let removedWorkspaceIds: WorkspaceId[] = [];
    const removed = await this.store.transaction(async (tx) => {
      const project = await tx.claimDeletingProject(projectId);
      if (!project || project.accountId !== accountId || project.daemonId !== daemonId) return false;
      const workspaces = await tx.listWorkspacesByProject(projectId);
      if (workspaces.some((workspace) => !workspace.isMain)) return false;
      for (const workspace of workspaces) {
        const taskIds = await tx.removeTasksByWorkspace(workspace.id);
        removedTaskIds.push(...taskIds);
        for (const taskId of taskIds) await tx.removeSessionCheckpointsByTask(taskId);
        await tx.removeWorkspace(workspace.id);
        removedWorkspaceIds.push(workspace.id);
      }
      await tx.removeProject(projectId);
      return true;
    });
    if (!removed) return;
    for (const taskId of removedTaskIds) this.broadcast(accountId, { case: "taskRemoved", value: { taskId } });
    for (const workspaceId of removedWorkspaceIds) this.broadcast(accountId, { case: "workspaceRemoved", value: { workspaceId } });
    this.broadcast(accountId, { case: "projectRemoved", value: { projectId } });
    await this.pushWorkspaceList(daemonId);
  }

  /* ============================ Daemon 侧 ============================ */
  async handleDaemonMessage(conn: DaemonCtx, msg: DaemonToServer): Promise<void> {
    if (msg.payload.case !== "daemonAuth" && msg.payload.case !== "daemonEnrollRequest" && !conn.daemonId) return;

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
        this.pendingAuthorizations.set(token, { token, conn, name: value.name, host: value.host, platform: value.platform, workerVersion: value.workerVersion, supervisorVersion: value.supervisorVersion, arch: value.arch, createdAt, timer });
        conn.pendingAuthToken = token;
        this.sendRaw(conn.ws, { case: "daemonAuthorizePending", value: { url: `${config.webUrl}/authorize/${token}`, expiresAt: createdAt + config.authorizeTtlMs } });
        log.info("daemon authorize requested", { name: value.name, host: value.host });
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
        await this.registerDaemonConn(conn, { daemonId: device.id, name: device.name, host: device.host, platform: device.platform, online: true, workerVersion: value.workerVersion, supervisorVersion: value.supervisorVersion }, device.accountId, value.arch);
        break;
      }
      case "daemonResync": {
        const value = msg.payload.value;
        await this.reconcileDaemonSessions(conn.daemonId!, conn.accountId!, value.sessions);
        break;
      }
      case "localGatewayAnnounce": {
        const daemon = this.currentDaemon(conn);
        if (daemon) await this.localControl.announce(daemon, msg.payload.value.gateway);
        break;
      }
      case "localGrantAck": {
        const daemon = this.currentDaemon(conn);
        if (daemon) await this.localControl.grantAck(daemon, msg.payload.value);
        break;
      }
      case "sessionCatalog": {
        const daemon = this.currentDaemon(conn);
        if (daemon) await this.reconcileSessionCatalog(daemon, msg.payload.value);
        break;
      }
      case "sessionCheckpoint": {
        const daemon = this.currentDaemon(conn);
        if (daemon) await this.acceptSessionCheckpoint(daemon, msg.payload.value);
        break;
      }
      case "preparedDeviceOperationInstalled": {
        const daemon = this.currentDaemon(conn);
        if (daemon) await this.handlePreparedInstalled(daemon, msg.payload.value.operationId, msg.payload.value.ok, msg.payload.value.error);
        break;
      }
      case "deviceOperationReport": {
        const daemon = this.currentDaemon(conn);
        if (daemon) await this.handleDeviceOperationReport(daemon, msg.payload.value);
        break;
      }
      // worker 观测到 worktree HEAD 变化：分支真相源在设备侧，DB 只做镜像 + 广播
      case "workspaceBranch": {
        const value = msg.payload.value;
        const ws = await this.store.getWorkspace(value.workspaceId);
        if (!ws || ws.daemonId !== conn.daemonId) return;
        const branch = value.branch.trim();
        if (!branch || branch === ws.branch) return;
        // 未起名（name === 旧 branch）时 name 跟随新分支，保持"未命名"语义
        const updated = await this.store.updateWorkspaceBranch(ws.id, branch, ws.name === ws.branch);
        if (updated) this.broadcast(updated.accountId, { case: "workspaceCreated", value: { workspace: updated } });
        break;
      }
      // worker 周期计算的 git diff 累计统计：真相源在设备侧，DB 只做镜像 + 广播（同 workspaceBranch 形态）
      case "workspaceDiff": {
        const value = msg.payload.value;
        const ws = await this.store.getWorkspace(value.workspaceId);
        if (!ws || ws.daemonId !== conn.daemonId) return;
        if (value.additions === ws.additions && value.deletions === ws.deletions) return;
        const updated = await this.store.updateWorkspaceDiff(ws.id, value.additions, value.deletions);
        if (updated) this.broadcast(updated.accountId, { case: "workspaceCreated", value: { workspace: updated } });
        break;
      }
      case "sessionStarted": {
        const value = msg.payload.value;
        const s = this.sessions.get(value.sessionId);
        if (s && s.daemonId !== conn.daemonId) return;
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
    }
  }

  private async reconcileDaemonSessions(daemonId: DaemonId, accountId: AccountId, alive: readonly { sessionId: SessionId; taskId: TaskId }[]): Promise<void> {
    const valid = alive.filter((a) => a && typeof a.sessionId === "string" && typeof a.taskId === "string");
    for (const { sessionId, taskId } of valid) {
      const task = await this.store.getTask(taskId);
      // legacy resync 只补已知 task 的路由；unknown/mismatched live PTY 是 local orphan，
      // 中心既不创建业务 task，也绝不再发 sessionClose。
      if (!task || task.accountId !== accountId || task.daemonId !== daemonId) continue;
      if (task.sessionId && task.sessionId !== sessionId) continue;
      if (!this.sessions.has(sessionId)) {
        this.sessions.set(sessionId, { sessionId, daemonId, accountId, taskId });
      }
      if (task.sessionId !== sessionId) {
        const updated = await this.store.updateTask(taskId, { status: TaskStatus.RUNNING, sessionId, exitCode: undefined });
        if (updated) this.emitTask(updated);
      }
    }
    // absence 不是 exit 事实；退出只由 sessiond tombstone/sessionExit 收敛。
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
    this.catalog.delete(daemonId);
    await this.localControl.daemonDisconnected(daemonId);
    // 端口转发：daemon 掉线即所有隧道失联，摘路由表 + 关在途连接（this.sessions 本身按既有设计不动，
    // 留给 daemon.resync 重连后自愈；shortId 会在重连后 ports.update 时重新签发，见 plan 006）。
    const releasedRoutes = this.routeTable.releaseDaemon(daemonId);
    this.tunnels.closeAllForDaemon(daemonId);
    for (const r of releasedRoutes) this.broadcastPorts(accountId, r.taskId);
    await this.store.touchDevice(daemonId, Date.now());
    log.info("daemon disconnected", { daemonId });

    const device = await this.store.getDevice(daemonId);
    if (device && !device.revoked) {
      this.broadcast(accountId, { case: "daemonUpdated", value: { daemon: { daemonId, name: device.name, host: device.host, platform: device.platform, online: false, workerVersion: "", supervisorVersion: "" } } });
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
        await this.localControl.logout(client);
        if (client.tokenHash) await this.store.revokeClientToken(client.tokenHash);
        client.ws.close(4001, "logout");
        break;
      }
      case "clientSubscribe": {
        const accountId = client.accountId!;
        // 先把快照数据查齐，最后才置 subscribed=true 并发送——避免在"已订阅但还没收到
        // 首个快照"的窗口期收到其它连接触发的广播导致乱序（landmine：广播不能抢在快照前）。
        const [daemons, projects, workspaces, tasks, checkpoints, prepared] = await Promise.all([
          this.daemonInfoList(accountId),
          this.store.listProjects(accountId),
          this.store.listWorkspaces(accountId),
          this.store.listTasks(accountId),
          this.store.listSessionCheckpoints(accountId),
          this.store.listReadyPreparedOperations(accountId, Date.now()),
        ]);
        client.subscribed = true;
        this.clients.add(client);
        this.sendClient(client, { case: "stateSnapshot", value: { daemons, projects, workspaces, tasks, ports: this.allPorts(accountId) } });
        for (const checkpoint of checkpoints) this.sendCheckpoint(client, checkpoint);
        for (const operation of prepared) this.sendPrepared(client, operation);
        break;
      }
      case "localPairRequest": {
        await this.localControl.pair(client, msg.payload.value);
        break;
      }
      case "localLeaseRequest": {
        await this.localControl.lease(client, msg.payload.value);
        break;
      }
      case "localUnpairRequest": {
        await this.localControl.unpair(client, msg.payload.value);
        break;
      }
      case "deviceRelayConnect": {
        this.handleDeviceRelayConnect(client, msg.payload.value);
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
        const explicitName = typeof value.name === "string" && value.name.trim() ? value.name.trim() : undefined;
        const operationId = randomUUID();
        const frame = this.preparedFrame(operationId, {
          case: "projectValidate",
          value: { requestId: operationId, operationId, path: value.path },
        });
        await this.prepareOperation(client, {
          operationId,
          accountId: client.accountId!,
          daemonId: value.daemonId,
          kind: "project.import",
          targetId: `${value.daemonId}:${value.path}`,
          targetVersion: null,
          frame,
          metadata: JSON.stringify({ projectId: randomUUID(), workspaceId: randomUUID(), explicitName }),
          expiresAt: Date.now() + config.preparedOperationTtlMs,
        });
        break;
      }
      case "projectRemove": {
        const project = await this.store.getProject(msg.payload.value.projectId);
        if (!project || project.accountId !== client.accountId) return;
        const initialWorkspaces = await this.store.listWorkspacesByProject(project.id);
        if (initialWorkspaces.some((workspace) => !workspace.isMain) && !this.daemons.has(project.daemonId)) {
          return void this.sendClient(client, { case: "error", value: { message: "daemon 不在线，无法删除 worktree" } });
        }
        await this.store.markProjectDeleting(project.id);
        // markProjectDeleting 与 worktree.add report 共用 project 行锁；标记完成后必须重新读取，
        // 否则等待行锁期间刚收敛的 workspace 会漏出本次删除集合，让 project 永久卡在 deleting。
        const workspaces = await this.store.listWorkspacesByProject(project.id);
        const removable = workspaces.filter((workspace) => !workspace.isMain);
        const sessionCloses: SessionId[] = [];
        for (const ws of workspaces) {
          for (const task of await this.store.listTasksByWorkspace(ws.id)) if (task.sessionId) sessionCloses.push(task.sessionId);
        }
        for (const sid of sessionCloses) {
          this.routeToSessionDaemon(sid, { case: "sessionClose", value: { sessionId: sid } });
          this.dropSession(sid);
        }
        if (removable.length === 0) await this.finalizeDeletingProject(project.id, project.accountId, project.daemonId);
        else for (const workspace of removable) await this.prepareWorktreeRemoval(client, project, workspace, true);
        break;
      }
      case "workspaceCreate": {
        const value = msg.payload.value;
        const project = await this.store.getProject(value.projectId);
        if (!project || project.accountId !== client.accountId) {
          this.sendClient(client, { case: "error", value: { message: "项目不存在或不属于本账号" } });
          return;
        }
        if (await this.store.isProjectDeleting(project.id)) {
          this.sendClient(client, { case: "error", value: { message: "项目正在删除，不能再创建工作区" } });
          return;
        }
        const d = this.daemons.get(project.daemonId);
        if (!d) {
          this.sendClient(client, { case: "error", value: { message: "daemon 不在线" } });
          return;
        }
        const workspaceId = randomUUID();
        const operationId = randomUUID();
        const name = value.name.trim() || "工作区";
        const frame = this.preparedFrame(operationId, {
          case: "worktreeAdd",
          value: {
            requestId: operationId,
            operationId,
            repoPath: project.repoPath,
            workspaceId,
            name,
            branch: value.branch,
            createNew: value.createNew,
          },
        });
        await this.prepareOperation(client, {
          operationId,
          accountId: client.accountId!,
          daemonId: project.daemonId,
          kind: "worktree.add",
          targetId: workspaceId,
          targetVersion: null,
          frame,
          metadata: JSON.stringify({ projectId: project.id, workspaceId, name }),
          expiresAt: Date.now() + config.preparedOperationTtlMs,
        });
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
        if (!project || project.daemonId !== ws.daemonId) return;
        if (!this.daemons.has(ws.daemonId)) return void this.sendClient(client, { case: "error", value: { message: "daemon 不在线" } });
        const sessionCloses = (await this.store.listTasksByWorkspace(ws.id)).filter((t) => t.sessionId).map((t) => t.sessionId!);
        for (const sid of sessionCloses) {
          this.routeToSessionDaemon(sid, { case: "sessionClose", value: { sessionId: sid } });
          this.dropSession(sid);
        }
        await this.prepareWorktreeRemoval(client, project, ws, false);
        break;
      }
      case "workspaceSetName": {
        const value = msg.payload.value;
        const ws = await this.store.getWorkspace(value.workspaceId);
        if (!ws || ws.accountId !== client.accountId) return;
        // 空名回落分支名；复用 workspaceCreated 广播（web 侧为 upsert），无需新增下行消息
        const updated = await this.store.updateWorkspaceName(ws.id, value.name.trim() || ws.branch);
        if (updated) this.broadcast(updated.accountId, { case: "workspaceCreated", value: { workspace: updated } });
        break;
      }
      case "deviceSetName": {
        const value = msg.payload.value;
        const device = await this.store.getDevice(value.daemonId);
        if (!device || device.accountId !== client.accountId) return;
        // 空名拒绝；设备没有回落默认值
        const trimmedName = value.name.trim();
        if (!trimmedName) return;
        const updated = await this.store.updateDeviceName(device.id, trimmedName);
        if (updated) {
          this.broadcast(updated.accountId, { case: "daemonUpdated", value: { daemon: { daemonId: updated.id, name: updated.name, host: updated.host, platform: updated.platform, online: this.isDaemonOnline(updated.id), workerVersion: "", supervisorVersion: "" } } });
          // 若设备当前在线，更新内存并即时下发
          const d = this.daemons.get(updated.id);
          if (d) {
            d.info.name = trimmedName;
            this.sendDaemon(d, { case: "daemonSetName", value: { name: trimmedName } });
          }
        }
        break;
      }
      case "taskCreate": {
        const value = msg.payload.value;
        const outcome = await this.store.transaction(async (tx) => {
          const ws = await tx.getWorkspace(value.workspaceId);
          if (!ws || ws.accountId !== client.accountId) return { error: "工作区不存在或不属于本账号" } as const;
          const project = await tx.claimActiveProject(ws.projectId);
          if (!project || project.accountId !== ws.accountId || project.daemonId !== ws.daemonId) {
            return { error: "项目正在删除，不能再创建任务" } as const;
          }
          const ts = Date.now();
          const task: Task = create(TaskSchema, { id: randomUUID(), accountId: ws.accountId, daemonId: ws.daemonId, projectId: ws.projectId, workspaceId: ws.id, title: value.title || "未命名任务", status: TaskStatus.IDLE, createdAt: ts, updatedAt: ts });
          await tx.createTask(task);
          return { task } as const;
        });
        if ("error" in outcome) {
          this.sendClient(client, { case: "error", value: { message: outcome.error } });
          return;
        }
        this.emitTask(outcome.task);
        break;
      }
      case "taskStart": {
        const value = msg.payload.value;
        await this.startOrAttachTask(client, value.taskId, value.cols, value.rows);
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
        await this.store.removeSessionCheckpointsByTask(task.id);
        this.broadcast(task.accountId, { case: "taskRemoved", value: { taskId: task.id } });
        break;
      }
    }
  }

  /** 构建版本准入的"允许版本集合"（plan 033）：env 显式覆盖 ∪ 每个 build-id.txt 文件的
   * 现读内容。认证是低频事件，同步读盘即可；单个文件不存在/读失败静默跳过（不影响其余
   * 来源——例如只部署了 web 还没部署 mobile 时，mobile 那个路径应静默跳过而非整体炸掉）。 */
  private allowedBuildIds(): string[] {
    const ids: string[] = [];
    if (config.buildId) ids.push(config.buildId);
    for (const path of config.buildIdFiles) {
      try {
        const content = readFileSync(path, "utf8").trim();
        if (content) ids.push(content);
      } catch {
        /* ignore：文件暂不存在也不该让版本准入本身崩掉 */
      }
    }
    return ids;
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

    // 构建版本准入（plan 033）：认证成功后、进入 subscribed 前拦截失配/缺失版本的客户端，
    // 不可能靠"连上后广播、客户端自觉 reload"——旧客户端根本不认识新消息。
    // 允许集合为空（COFLUX_BUILD_ID 与 COFLUX_BUILD_ID_FILE 均未设，本机开发 / 黑盒测试）
    // 完全跳过；client 上报 "dev"（vite dev）总放行。
    const allowedBuildIds = this.allowedBuildIds();
    if (allowedBuildIds.length > 0 && msg.clientVersion !== "dev") {
      if (!msg.clientVersion) {
        // 缺失版本 = 旧 bundle（协议里从未有过该字段）：唯一对它生效的杠杆是它已理解的
        // authError（清 token、停止重连、退回登录页）。不发 clientOutdated——旧代码不认识它。
        this.sendClient(client, { case: "authError", value: { message: "客户端版本已过期，请刷新页面" } });
        try {
          client.ws.close(4001, "outdated client");
        } catch {
          /* ignore */
        }
        return;
      }
      if (!allowedBuildIds.includes(msg.clientVersion)) {
        // 失配但认识协议的新客户端：只发 clientOutdated，不发 authError——发 authError 会清本地
        // token，等于每次部署逼所有在线用户重新登录，违背"无感升级"目标。
        this.sendClient(client, { case: "clientOutdated", value: {} });
        try {
          client.ws.close(4001, "build mismatch");
        } catch {
          /* ignore */
        }
        return;
      }
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
      return void this.sendClient(client, { case: "error", value: { message: "任务已在运行，请通过 DeviceTransport attach" } });
    }

    const d = this.daemons.get(task.daemonId);
    if (!d) return void this.sendClient(client, { case: "error", value: { message: `daemon 不在线：${task.daemonId}` } });
    const ws = await this.store.getWorkspace(task.workspaceId);
    if (!ws) return void this.sendClient(client, { case: "error", value: { message: "工作区已不存在" } });
    if (await this.store.isProjectDeleting(task.projectId)) {
      return void this.sendClient(client, { case: "error", value: { message: "项目正在删除，不能启动新 session" } });
    }

    const sessionId = randomUUID();
    const c = clampDim(cols, 80);
    const r = clampDim(rows, 24);
    const existing = await this.store.findActivePreparedOperation(task.accountId, "session.create", task.id, Date.now());
    if (existing) {
      if (existing.state === "installed") {
        this.sendPrepared(client, existing);
      } else {
        this.watchPrepared(existing.operationId, client);
        this.dispatchPrepared(existing);
      }
      return;
    }
    const operationId = randomUUID();
    const frame = this.preparedFrame(operationId, {
      case: "sessionCreate",
      value: { requestId: operationId, operationId, sessionId, taskId: task.id, cwd: ws.path, cols: c, rows: r },
    });
    await this.prepareOperation(client, {
      operationId,
      accountId: task.accountId,
      daemonId: task.daemonId,
      kind: "session.create",
      targetId: task.id,
      targetVersion: task.updatedAt,
      frame,
      metadata: JSON.stringify({ taskId: task.id, sessionId }),
      expiresAt: Date.now() + config.preparedOperationTtlMs,
    });
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

  /** 兑现一次授权：摘除 pending（一次性）、把设备绑进当前登录账号，走 createDevice +
   * registerDaemonConn 路径。 */
  private async completeDeviceAuthorize(client: ClientConn, p: PendingAuthorization): Promise<void> {
    this.pendingAuthorizations.delete(p.token);
    clearTimeout(p.timer);
    if (p.conn.pendingAuthToken === p.token) p.conn.pendingAuthToken = undefined;

    const accountId = client.accountId!;
    if ((await this.store.countDevices(accountId)) >= config.maxDevicesPerAccount) {
      // 设备数超限是致命错误，daemon 侧直接退出（needEnroll:false）。
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
    await this.registerDaemonConn(p.conn, { daemonId, name: p.name, host: p.host, platform: p.platform, online: true, workerVersion: p.workerVersion, supervisorVersion: p.supervisorVersion }, accountId, p.arch);
    this.sendClient(client, { case: "deviceAuthorized", value: {} });
  }

  /** relay rendezvous（plan 043）：校验归属 → 两端各签短时单次 token → 通知 daemon 拨号。
   * 校验语义沿用旧 DeviceRelayRouter.open；server 从此不持 channel 状态，channel 的
   * 生死由 relay 配对/两端 WS 收敛，断开即由 client 重新 rendezvous。 */
  private handleDeviceRelayConnect(client: ClientConn, request: DeviceRelayConnect): void {
    const fail = (error: string) =>
      this.sendClient(client, { case: "deviceRelayGrant", value: { channelId: request.channelId, ok: false, error } });

    if (!client.accountId) return void fail("client 未认证");
    if (
      request.protocolVersion !== DEVICE_PROTOCOL_VERSION ||
      !validRelayId(request.daemonId) ||
      !validRelayId(request.channelId) ||
      request.channelId.startsWith("__coflux-") ||
      !validRelayId(request.clientInstanceId) ||
      request.transportGeneration <= 0n
    ) {
      return void fail("relay channel/principal/version 无效");
    }
    if (!config.relayUrl) return void fail("中心未配置 relay 节点");
    if (!allowRendezvous(client)) return void fail("rendezvous 频率超限");

    const daemon = this.daemons.get(request.daemonId);
    if (!daemon || daemon.accountId !== client.accountId) return void fail("daemon 不在线或不属于本账号");

    const ttl = config.relayTokenTtlMs;
    this.sendDaemon(daemon, {
      case: "deviceRelayDial",
      value: {
        channelId: request.channelId,
        relayUrl: buildRelayPipeUrl(config.relayUrl, this.relayTokens.sign(request.channelId, "daemon", ttl)),
        accountId: client.accountId,
        clientInstanceId: request.clientInstanceId,
        transportGeneration: request.transportGeneration,
        scopes: [DeviceScope.SESSION_READ, DeviceScope.SESSION_CONTROL, DeviceScope.RPC, DeviceScope.LIFECYCLE],
        protocolVersion: DEVICE_PROTOCOL_VERSION,
      },
    });
    this.sendClient(client, {
      case: "deviceRelayGrant",
      value: {
        channelId: request.channelId,
        ok: true,
        relayUrl: buildRelayPipeUrl(config.relayUrl, this.relayTokens.sign(request.channelId, "client", ttl)),
      },
    });
  }

  private async removeDevice(client: ClientConn, daemonId: DaemonId): Promise<void> {
    const device = await this.store.getDevice(daemonId);
    if (!device || device.accountId !== client.accountId) return;
    const accountId = device.accountId;

    // 先清 origin/撤销 grant 再关闭 control WS；即使 revoke ack 丢失，durable tombstone 仍保留。
    await this.localControl.revokeDevice(daemonId);
    const conn = this.daemons.get(daemonId);
    if (conn) {
      try {
        conn.ws.close(4003, "device removed");
      } catch {
        /* ignore */
      }
      this.daemons.delete(daemonId);
    }
    this.catalog.delete(daemonId);
    for (const [sid, s] of this.sessions) if (s.daemonId === daemonId) this.dropSession(sid);
    const workspaces = await this.store.listWorkspacesByDaemon(daemonId);
    const projects = await this.store.listProjectsByDaemon(daemonId);
    let taskIds: TaskId[] = [];
    await this.store.transaction(async (tx) => {
      await tx.revokeDevice(daemonId);
      await tx.removeSessionCheckpointsByDaemon(daemonId);
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
    this.removePreparedWaitersByClient(client);
  }

  /** 运行时计数（供 /health 暴露） */
  stats(): { daemons: number; clients: number; sessions: number } {
    return { daemons: this.daemons.size, clients: this.clients.size, sessions: this.sessions.size };
  }

  /** 优雅关闭：清定时器、关所有连接 */
  shutdown(): void {
    this.localControl.shutdown();
    for (const timer of this.preparedRetryTimers.values()) clearTimeout(timer);
    this.preparedRetryTimers.clear();
    for (const waiters of this.preparedWaiters.values()) for (const waiter of waiters) clearTimeout(waiter.timer);
    this.preparedWaiters.clear();
    for (const p of this.pendingAuthorizations.values()) clearTimeout(p.timer);
    this.pendingAuthorizations.clear();
    for (const d of this.daemons.values()) try { d.ws.close(1001, "server shutting down"); } catch { /* ignore */ }
    for (const c of this.clients) try { c.ws.close(1001, "server shutting down"); } catch { /* ignore */ }
  }
}

function validOperationResult(operation: PreparedOperationRecord, report: DeviceOperationReport, payload: DeviceEnvelope["payload"]): boolean {
  if (payload.case === "error") return !report.ok;
  if (operation.kind === "project.import" && payload.case === "projectValidated") {
    return payload.value.operationId === operation.operationId && payload.value.ok === report.ok;
  }
  if (operation.kind === "worktree.add" && payload.case === "worktreeAdded") {
    return payload.value.operationId === operation.operationId && payload.value.ok === report.ok;
  }
  if (operation.kind === "worktree.remove" && payload.case === "operationAck") {
    return payload.value.operationId === operation.operationId && payload.value.ok === report.ok;
  }
  if (operation.kind === "session.create" && payload.case === "operationAck") {
    return payload.value.operationId === operation.operationId && payload.value.ok === report.ok;
  }
  return false;
}

function parseOperationMetadata(value: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function metadataString(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function validControlId(value: string): boolean {
  return value.length > 0 && Buffer.byteLength(value, "utf8") <= MAX_CONTROL_ID_BYTES && ![...value].some((char) => {
    const code = char.charCodeAt(0);
    return code < 32 || code === 127;
  });
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
