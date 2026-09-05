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
 * 原子性。transport 对每条连接严格按 wire 顺序执行，并以条数/字节硬上限约束积压；不同连接之间
 * 仍会并发，跨连接不变量必须由条件更新、父行锁或事务维护，不能依赖应用层检查后再写。
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
  encodeServerToDaemon,
  encodeServerToClient,
  MAX_FRAME_ID_BYTES,
  MAX_SESSION_CHECKPOINT_BYTES,
  ServerToDaemonSchema,
  ServerToClientSchema,
  WorkspaceSchema,
  TaskSchema,
  TaskStatus,
  DeviceScope,
  type AccountId,
  type DaemonId,
  type DeviceRelayConnect,
  type DeviceP2pOffer,
  type DeviceP2pChannelOpen,
  type DeviceP2pAnswerReport,
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
  type DeviceSessionCatalog,
  type DeviceSessionInfo,
  type SessionAgentRef,
  type SessionCheckpoint,
  type AgentControlRequest,
  type AgentControlResultPayload,
  type ServerAgentResult,
} from "@coflux/protocol";
import { createLogger } from "@coflux/core";
import {
  Store,
  type PreparedOperationRecord,
  type SessionCheckpointRecord,
} from "./store.js";
import { genToken, hashToken } from "./secrets.js";
import { config } from "./config.js";
import { ProxyRouteTable, ProxyGate, TunnelRegistry, buildPreviewUrl, parseProxyRedirect, buildAuthCallbackUrl } from "./proxy.js";
import { RelayTokenSigner, allowRendezvous, buildRelayPipeUrl, selectRelayNode, supportsP2pDial, supportsRelayDial, validRelayId } from "./relay-rendezvous.js";
import { LocalControlPlane } from "./local-control.js";
import { verifyPassword } from "./auth.js";
import { OAuthService } from "./oauth.js";
import {
  createPreparedOperationService,
  MAX_PREPARED_FRAME_BYTES,
  SERVER_INITIATOR,
  type PreparedOperationService,
} from "./prepared-operation.service.js";
import { PreparedOperationConvergenceService, type OperationEffect } from "./prepared-operation-convergence.service.js";
import {
  DAEMON_CAPABILITY_PREPARED_EXECUTE,
  DAEMON_CAPABILITY_TERMINAL_IO,
  daemonUpgradeRequired,
} from "./daemon-capabilities.js";

const log = createLogger("hub");
const MAX_CATALOG_ENTRIES = 4096;
const MAX_CATALOG_PATH_BYTES = 16 * 1024;
const MAX_RETAINED_CATALOG_BYTES = 4 * 1024 * 1024;
const MAX_AGENT_ENTRIES = 1024;
const MAX_ENROLL_NAME_BYTES = 256;
const MAX_ENROLL_HOST_BYTES = 256;
const MAX_ENROLL_PLATFORM_BYTES = 64;
const MAX_ENROLL_VERSION_BYTES = 128;
const MAX_ENROLL_ARCH_BYTES = 32;
const MAX_LOGIN_NAME_BYTES = 320;
const MAX_LOGIN_PASSWORD_BYTES = 1024;
const MAX_CLIENT_TOKEN_BYTES = 512;
const MAX_RATE_LIMIT_KEYS = 10_000;
const MAX_SNAPSHOT_BACKLOG_MESSAGES = 4_096;
/** agent 自建终端的初始视口（plan 074）：没有真实 client 视口可依，取一个比 80×24 宽的默认值——
 * agent 是靠读 checkpoint 文本判断进度的，行太窄会把输出折得难认。用户接管时 xterm 会重新 resize。 */
/** terminal list 回给 agent 的最大条数（取最近的）：用久的工作区会攒下几十个 exited 终端。 */
const MAX_AGENT_TERMINAL_LIST = 50;
const AGENT_TERMINAL_COLS = 120;
const AGENT_TERMINAL_ROWS = 40;
const MAX_AGENT_NAME_BYTES = 64;
/** 每台 daemon 在单个 Hub 生命周期内最多接受这么多次 supervisor owner 切换。达到上限后
 * 继续接受当前 owner 的递增 epoch，但 fail-closed 拒绝任何新 owner，避免淘汰古老 owner 后重放。 */
const MAX_RETIRED_RESYNC_OWNERS = 16;
/** notify 留言的字节兜底（worker 已按字符钳过，这里防伪造/畸形上报） */
const MAX_AGENT_MESSAGE_BYTES = 1024;
/** daemon 宣告的能力名（plan 091）：条数/单条字节上限，超限整条握手拒绝（同其它握手字段）。 */
const MAX_CAPABILITY_ENTRIES = 32;
const MAX_CAPABILITY_BYTES = 64;
/** 完成原语（plan 091）的等待者总上限：MCP 一个请求一个等待者，256 已远超单账号并发。 */
const MAX_COMPLETION_WAITERS = 256;
/** 中心发起的 prepared 操作（建/删 worktree、建会话）的完成等待上限：Claude Code 远程 MCP 单请求
 * 60 秒，到期返回「已提交、稍后用 list_* 查」而不是挂着。 */
const OPERATION_WAIT_MS = 30_000;
/** wait_terminal 的默认与上限（同上，≤ 50 秒）。 */
const TERMINAL_WAIT_DEFAULT_MS = 30_000;
const TERMINAL_WAIT_MAX_MS = 50_000;
/** stop_terminal 发出 sessionClose 后等退出的上限；到期按「已在退出中」返回。 */
const STOP_WAIT_MS = 15_000;
/** server→daemon 读/写请求的回执超时。写入超时不重发（结果未知，先 read 再决定）。 */
const AGENT_REQUEST_TIMEOUT_MS = 10_000;
const MAX_PENDING_AGENT_REQUESTS = 256;
/** create_terminal 命令与 send_terminal_input 单次输入的字节上限（worker 侧另有同级钳制）。 */
const MAX_TERMINAL_COMMAND_BYTES = 16 * 1024;
const MAX_TERMINAL_INPUT_BYTES = 64 * 1024;
const MAX_TERMINAL_TITLE_BYTES = 256;
const MAX_BRANCH_BYTES = 255;
const MAX_WORKSPACE_NAME_BYTES = 256;
/** read_terminal 经 daemon 读取的字节上限（与 checkpoint 同级）。 */
const MAX_TERMINAL_READ_BYTES = 256 * 1024;

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

/** agent presence 条目（plan 073）：不用生成的 SessionAgentRef 消息类型（无需 $typeName）——
 * 只作为广播消息的嵌套字段被构造（nested init 接受纯对象），从不单独序列化。 */
interface SessionAgentData {
  sessionId: SessionId;
  taskId: TaskId;
  agent: string;
  /** hook 上报的回合状态：active / approval / question / done，空 = 无 hook 信号 */
  state: string;
  /** `cofluxd notify` 的留言（plan 074）：与 state 同生命周期，纯展示 */
  message: string;
  /** `cofluxd progress` 的进度短评（plan 088）：跨 hook 事件存活，覆盖式，纯展示 */
  progress: string;
}

interface DaemonResyncAuthority {
  ownerId: string;
  epoch: bigint;
  retiredOwnerIds: Set<string>;
}

/** state 白名单：名单外的按畸形消息整条丢弃。waiting 是 v0.21 旧值，仍收以免混版本丢条目。 */
const AGENT_STATES = new Set(["", "active", "approval", "question", "done", "waiting"]);

export interface DaemonConn {
  info: DaemonInfoData;
  accountId: AccountId;
  /** 握手上报的 CPU 架构（std::env::consts::ARCH），仅供自动升级编排做 target 映射，不下发给 web。 */
  arch: string;
  /** 握手宣告的控制面能力名（plan 091）：MCP 写 tools 发送新增控制消息前按它做门禁。纯连接内存态。 */
  capabilities: ReadonlySet<string>;
  ws: WebSocket;
  /** daemon 探测选出的 home relay；纯连接 presence，重连后由新 worker 重新上报。 */
  homeRelayId?: string;
  /** 只接受当前 server WS 主动索要的完整 catalog；候选集冻结在请求发出前，避免请求后的
   * 新 session 因不可能出现在旧快照里而被误判缺席。旧连接/outbox 的 requestId 不能提交。 */
  catalogRequest?: {
    requestId: string;
    absenceCandidates: readonly { taskId: TaskId; sessionId: SessionId }[];
  };
}
export interface ClientConn {
  ws: WebSocket;
  accountId: AccountId | null;
  subscribed: boolean;
  /** subscribe 查询期间暂存跨连接广播；先发完整快照再按到达顺序回放，避免查询窗口永久丢事件。 */
  snapshotBacklog?: { frames: Uint8Array[]; bytes: number; overflowed: boolean };
  /** TCP peer，或同机可信反代覆盖的首个 X-Forwarded-For；仅用于资源限速，不参与身份。 */
  remoteAddress: string;
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
  /** 含义同 ClientConn.remoteAddress。 */
  remoteAddress: string;
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
  capabilities: readonly string[];
  createdAt: number;
  timer: ReturnType<typeof setTimeout>;
}

interface RuntimeSession {
  sessionId: SessionId;
  daemonId: DaemonId;
  accountId: AccountId;
  taskId: TaskId;
}

interface DeviceEffectGuard {
  cancelled: boolean;
}

interface TaskEffectGuard {
  cancelled: boolean;
}

interface WorkspaceEffectGuard {
  cancelled: boolean;
}

interface ProjectEffectGuard {
  cancelled: boolean;
}

interface DaemonGenerationGate {
  tail: Promise<void>;
  users: number;
}

/** async catalog 收敛期间 daemon WS 已被同设备的新连接替换。抛进 store.transaction()
 * 会让已执行的 task 更新随事务回滚；外层只静默终止这份旧代际快照。 */
class StaleDaemonConnectionError extends Error {}

/** 操作层（plan 091，MCP 写 tools 消费）的统一结果：错误一律是可读文案，不抛。 */
export type OperationOutcome<T> = { ok: true; value: T } | { ok: false; error: string };

/** prepared 操作（按 operationId）的完成结果：applied 携带收敛 effect；failed 携带可读错误。 */
export type OperationWaitResult =
  | { case: "applied"; effect: OperationEffect }
  | { case: "failed"; message: string }
  | { case: "timeout" };

/** 任务退出（按 taskId）的等待结果。 */
export type TaskExitWaitResult =
  | { case: "exited"; exitCode: number }
  | { case: "failed"; message: string }
  | { case: "timeout" };

/** read_terminal 的内容来源：log/snapshot 经 daemon，checkpoint 是中心缓存，none 三者皆无。 */
export type TerminalReadSource = "log" | "snapshot" | "checkpoint" | "none";

interface CompletionWaiter<T> {
  daemonId: DaemonId;
  resolve: (value: T) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * 完成原语（plan 091）：中心发起的 daemon 副作用没有 client 可通知，MCP tool 按 key（operationId /
 * taskId）在这里等一个有界的结果。唤醒点在 Hub 既有的收敛路径末尾（report 收敛、sessionExit、
 * catalog exit、任务删除、daemon 断开/换代），不引入新的状态机。等待者有总数上限与超时。
 */
class CompletionTable<T> {
  private readonly waiters = new Map<string, Set<CompletionWaiter<T>>>();
  private count = 0;

  wait(key: string, daemonId: DaemonId, timeoutMs: number, onTimeout: T): Promise<T> | undefined {
    if (this.count >= MAX_COMPLETION_WAITERS) return undefined;
    return new Promise<T>((resolve) => {
      const set = this.waiters.get(key) ?? new Set<CompletionWaiter<T>>();
      const waiter: CompletionWaiter<T> = {
        daemonId,
        resolve,
        timer: setTimeout(() => {
          if (this.remove(key, waiter)) resolve(onTimeout);
        }, timeoutMs),
      };
      waiter.timer.unref?.();
      set.add(waiter);
      this.waiters.set(key, set);
      this.count += 1;
    });
  }

  resolve(key: string, value: T): void {
    const set = this.waiters.get(key);
    if (!set) return;
    this.waiters.delete(key);
    for (const waiter of set) {
      clearTimeout(waiter.timer);
      this.count -= 1;
      waiter.resolve(value);
    }
  }

  /** daemon 断开/换代/撤销：该设备上所有等待者以同一可读错误唤醒。 */
  failDaemon(daemonId: DaemonId, value: T): void {
    for (const [key, set] of [...this.waiters]) {
      for (const waiter of [...set]) {
        if (waiter.daemonId !== daemonId) continue;
        this.remove(key, waiter);
        waiter.resolve(value);
      }
    }
  }

  failAll(value: T): void {
    for (const [key, set] of [...this.waiters]) {
      for (const waiter of [...set]) {
        this.remove(key, waiter);
        waiter.resolve(value);
      }
    }
  }

  private remove(key: string, waiter: CompletionWaiter<T>): boolean {
    const set = this.waiters.get(key);
    if (!set?.delete(waiter)) return false;
    clearTimeout(waiter.timer);
    this.count -= 1;
    if (set.size === 0) this.waiters.delete(key);
    return true;
  }
}

/** server→daemon 读/写请求（plan 091）的在飞表项：requestId → 回执等待者。 */
interface PendingAgentRequest {
  daemonId: DaemonId;
  resolve: (result: ServerAgentResult | undefined) => void;
  timer: ReturnType<typeof setTimeout>;
}

type ServerAgentRequestPayload =
  | { case: "terminalRead"; value: { taskId: TaskId; sessionId: SessionId; maxBytes: number } }
  | { case: "terminalInput"; value: { sessionId: SessionId; data: Uint8Array } };

/** 固定窗口 + LRU 键上限：既限制单来源请求速率，也不让伪造来源把 limiter 自身撑爆内存。 */
class FixedWindowLimiter {
  private readonly windows = new Map<string, { startedAt: number; count: number }>();

  constructor(private readonly limit: number, private readonly windowMs: number) {}

  allow(key: string, now = Date.now()): boolean {
    const previous = this.windows.get(key);
    const entry = !previous || now - previous.startedAt >= this.windowMs
      ? { startedAt: now, count: 1 }
      : { startedAt: previous.startedAt, count: previous.count + 1 };
    this.windows.delete(key);
    this.windows.set(key, entry);
    if (this.windows.size > MAX_RATE_LIMIT_KEYS) {
      const oldest = this.windows.keys().next().value;
      if (oldest !== undefined) this.windows.delete(oldest);
    }
    return entry.count <= this.limit;
  }
}

export class Hub {
  private daemons = new Map<DaemonId, DaemonConn>();
  /** catalog 的 DB COMMIT 与同 daemonId 的 current swap/delete 共用短临界区。普通对象身份
   * 检查覆盖不了 postgres.js「callback 返回 → COMMIT 完成」之间的异步窗口。 */
  private daemonGenerationGates = new Map<DaemonId, DaemonGenerationGate>();
  /** shutdown 不能 await gate；先同步置位并清 current map，使所有在途 continuation fail-closed。 */
  private shuttingDown = false;
  /** daemon.resync authority 属于设备在本 Hub 生命周期内的状态，不属于某条易失 WS。断线重连
   * 必须保留 owner/epoch 与退休 owner；仅设备被撤销或 Hub 结束时清理。 */
  private daemonResyncAuthorities = new Map<DaemonId, DaemonResyncAuthority>();
  private sessions = new Map<SessionId, RuntimeSession>();
  private clients = new Set<ClientConn>();
  private readonly preparedOperations: PreparedOperationService<ClientConn, DaemonConn>;
  /** 完成原语（plan 091）：中心发起的 prepared 操作按 operationId、任务退出按 taskId 等结果。 */
  private readonly operationCompletions = new CompletionTable<OperationWaitResult>();
  private readonly taskExitCompletions = new CompletionTable<TaskExitWaitResult>();
  /** server→daemon 读/写请求的在飞表（plan 091）。 */
  private readonly pendingAgentRequests = new Map<string, PendingAgentRequest>();
  private catalog = new Map<DaemonId, Map<SessionId, DeviceSessionInfo>>();
  /** agent presence（plan 073）：daemon 上报的"会话进程树内检测到的 agent CLI"。派生运行时
   * 事实——纯内存、不落库，daemon 断开即清空并广播；订阅时按设备补发当前全量。 */
  private sessionAgents = new Map<DaemonId, { accountId: AccountId; sessions: SessionAgentData[] }>();
  private readonly localControl: LocalControlPlane<ClientConn, DaemonConn>;
  /** 独立 relay 的 token 签发（plan 043）；server 不再承载 relay 数据面。 */
  private readonly relayTokens: RelayTokenSigner;
  /** 待确认的设备授权请求，键为一次性 token（cf_authz_*） */
  private pendingAuthorizations = new Map<string, PendingAuthorization>();
  /** MCP 宿主的 OAuth 授权服务器（plan 090）：待确认请求/授权码在它的内存里，与设备授权同款生命周期；
   * HTTP 端点经 HubState 取它，确认页的两条 client 消息在下方 handleClientMessage 里落地。 */
  readonly oauth: OAuthService;
  private readonly enrollLimiter = new FixedWindowLimiter(config.enrollRateLimit, config.authRateWindowMs);
  private readonly daemonAuthLimiter = new FixedWindowLimiter(config.daemonAuthRateLimit, config.authRateWindowMs);
  private readonly loginLimiter = new FixedWindowLimiter(config.loginRateLimit, config.authRateWindowMs);
  private readonly tokenAuthLimiter = new FixedWindowLimiter(config.tokenAuthRateLimit, config.authRateWindowMs);
  private activePasswordChecks = 0;
  /** device 子项事务提交后到内存/广播副作用之间有一个极短窗口。removeDevice
   * 提交后取消已在途的 guard，防旧 handler 在删除广播后又复活 UI/runtime。 */
  private deviceEffectGuards = new Map<DaemonId, Set<DeviceEffectGuard>>();
  /** task 删除与 session exit/catalog 收敛可跨连接并发。删除提交后取消在途
   * task 副作用，防 RETURNING 的旧 continuation 在 taskRemoved 后补发 taskUpdated。 */
  private taskEffectGuards = new Map<TaskId, Set<TaskEffectGuard>>();
  /** workspace/project 更新与删除来自不同连接；删除提交后必须让旧 RETURNING/report
   * continuation 静默退休，不能在 removed 广播之后再用 Created(upsert) 复活 UI。 */
  private workspaceEffectGuards = new Map<WorkspaceId, Set<WorkspaceEffectGuard>>();
  private projectEffectGuards = new Map<ProjectId, Set<ProjectEffectGuard>>();

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

  constructor(private store: Store) {
    this.oauth = new OAuthService(store);
    this.localControl = new LocalControlPlane(
      store,
      (daemonId) => this.daemons.get(daemonId),
      (daemon, payload) => this.sendDaemon(daemon, payload),
      (client, payload) => this.sendClient(client, payload),
    );
    this.relayTokens = new RelayTokenSigner(config.relaySigningKeySeed);
    this.preparedOperations = createPreparedOperationService(store, {
      getDaemon: (daemonId) => this.daemons.get(daemonId),
      isCurrentDaemon: (daemon) => this.isCurrentDaemon(daemon),
      sendDaemon: (daemon, payload) => this.sendDaemon(daemon, payload),
      sendClient: (client, payload, initialSnapshot) => initialSnapshot
        ? this.sendClientNow(client, payload)
        : this.sendClient(client, payload),
      validControlId,
      failServerOperation: (operationId, message) =>
        this.operationCompletions.resolve(operationId, { case: "failed", message }),
    });
  }

  /* ============================ 发送工具 ============================ */
  private async withDeviceEffectGuard<T>(daemonId: DaemonId, fn: (guard: DeviceEffectGuard) => Promise<T>): Promise<T> {
    const guard: DeviceEffectGuard = { cancelled: false };
    let guards = this.deviceEffectGuards.get(daemonId);
    if (!guards) {
      guards = new Set();
      this.deviceEffectGuards.set(daemonId, guards);
    }
    guards.add(guard);
    try {
      return await fn(guard);
    } finally {
      guards.delete(guard);
      if (guards.size === 0 && this.deviceEffectGuards.get(daemonId) === guards) {
        this.deviceEffectGuards.delete(daemonId);
      }
    }
  }

  private cancelDeviceEffects(daemonId: DaemonId): void {
    const guards = this.deviceEffectGuards.get(daemonId);
    if (!guards) return;
    // 先摘 Map；删除提交后新进来的 handler 会拿新 Set，但其
    // claimActiveDevice 必然因 revoked 失败。旧 Set 随各 handler finally 自然释放。
    this.deviceEffectGuards.delete(daemonId);
    for (const guard of guards) guard.cancelled = true;
  }

  private async withTaskEffectGuard<T>(taskId: TaskId, fn: (guard: TaskEffectGuard) => Promise<T>): Promise<T> {
    const guard: TaskEffectGuard = { cancelled: false };
    let guards = this.taskEffectGuards.get(taskId);
    if (!guards) {
      guards = new Set();
      this.taskEffectGuards.set(taskId, guards);
    }
    guards.add(guard);
    try {
      return await fn(guard);
    } finally {
      guards.delete(guard);
      if (guards.size === 0 && this.taskEffectGuards.get(taskId) === guards) {
        this.taskEffectGuards.delete(taskId);
      }
    }
  }

  private cancelTaskEffects(taskId: TaskId): void {
    const guards = this.taskEffectGuards.get(taskId);
    if (!guards) return;
    this.taskEffectGuards.delete(taskId);
    for (const guard of guards) guard.cancelled = true;
  }

  private async withWorkspaceEffectGuard<T>(
    workspaceId: WorkspaceId,
    fn: (guard: WorkspaceEffectGuard) => Promise<T>,
  ): Promise<T> {
    const guard: WorkspaceEffectGuard = { cancelled: false };
    let guards = this.workspaceEffectGuards.get(workspaceId);
    if (!guards) {
      guards = new Set();
      this.workspaceEffectGuards.set(workspaceId, guards);
    }
    guards.add(guard);
    try {
      return await fn(guard);
    } finally {
      guards.delete(guard);
      if (guards.size === 0 && this.workspaceEffectGuards.get(workspaceId) === guards) {
        this.workspaceEffectGuards.delete(workspaceId);
      }
    }
  }

  private cancelWorkspaceEffects(workspaceId: WorkspaceId): void {
    const guards = this.workspaceEffectGuards.get(workspaceId);
    if (!guards) return;
    this.workspaceEffectGuards.delete(workspaceId);
    for (const guard of guards) guard.cancelled = true;
  }

  private async withProjectEffectGuard<T>(
    projectId: ProjectId,
    fn: (guard: ProjectEffectGuard) => Promise<T>,
  ): Promise<T> {
    const guard: ProjectEffectGuard = { cancelled: false };
    let guards = this.projectEffectGuards.get(projectId);
    if (!guards) {
      guards = new Set();
      this.projectEffectGuards.set(projectId, guards);
    }
    guards.add(guard);
    try {
      return await fn(guard);
    } finally {
      guards.delete(guard);
      if (guards.size === 0 && this.projectEffectGuards.get(projectId) === guards) {
        this.projectEffectGuards.delete(projectId);
      }
    }
  }

  private cancelProjectEffects(projectId: ProjectId): void {
    const guards = this.projectEffectGuards.get(projectId);
    if (!guards) return;
    this.projectEffectGuards.delete(projectId);
    for (const guard of guards) guard.cancelled = true;
  }

  /** task 批量删除提交后的同步退休出口。必须先取消整批旧 DB continuation，再开始 drop；
   * dropSession 会广播 portsUpdated，逐 task 边取消边 drop 会让前一条广播越过后一 task 的
   * guard 取消。runtime 按完整业务身份扫描，不能只信删除事务返回的 session_id，因为并发
   * exit 可能已先把它清空。调用方必须在任何 await 或业务删除广播前执行。 */
  private retireTaskRuntimes(
    taskIds: readonly TaskId[],
    accountId: AccountId,
    daemonId: DaemonId,
    closeSession: boolean,
  ): void {
    const retiredTaskIds = new Set(taskIds);
    for (const taskId of retiredTaskIds) {
      this.cancelTaskEffects(taskId);
      this.taskExitCompletions.resolve(taskId, { case: "failed", message: "任务已删除" });
    }
    for (const [sessionId, runtime] of this.sessions) {
      if (
        !retiredTaskIds.has(runtime.taskId) ||
        runtime.accountId !== accountId ||
        runtime.daemonId !== daemonId
      ) continue;
      if (closeSession) {
        this.routeToSessionDaemon(sessionId, { case: "sessionClose", value: { sessionId } });
      }
      this.dropSession(sessionId);
    }
  }

  private retireTaskRuntime(
    taskId: TaskId,
    accountId: AccountId,
    daemonId: DaemonId,
    closeSession: boolean,
  ): void {
    this.retireTaskRuntimes([taskId], accountId, daemonId, closeSession);
  }

  private sendDaemon(d: DaemonConn, payload: ServerToDaemonPayload): boolean {
    if (d.ws.readyState !== d.ws.OPEN) return false;
    return this.sendWs(d.ws, encodeServerToDaemon(create(ServerToDaemonSchema, { payload })), "daemon");
  }
  /** 认证完成前（daemonId 尚未落地到 this.daemons）直接对 ws 发送 */
  private sendRaw(ws: WebSocket, payload: ServerToDaemonPayload): boolean {
    if (ws.readyState !== ws.OPEN) return false;
    return this.sendWs(ws, encodeServerToDaemon(create(ServerToDaemonSchema, { payload })), "pending-daemon");
  }
  private sendClient(c: ClientConn, payload: ServerToClientPayload): boolean {
    if (c.ws.readyState !== c.ws.OPEN) return false;
    const frame = encodeServerToClient(create(ServerToClientSchema, { payload }));
    const backlog = c.snapshotBacklog;
    if (backlog) {
      if (backlog.overflowed) return false;
      if (
        backlog.frames.length >= MAX_SNAPSHOT_BACKLOG_MESSAGES ||
        frame.byteLength > config.clientBufferHardLimit - backlog.bytes
      ) {
        backlog.frames.length = 0;
        backlog.bytes = 0;
        backlog.overflowed = true;
        log.warn("subscribe 查询期间广播积压超过上限，断开慢客户端", {
          frameBytes: frame.byteLength,
          maxMessages: MAX_SNAPSHOT_BACKLOG_MESSAGES,
          maxBytes: config.clientBufferHardLimit,
        });
        try {
          c.ws.close(1013, "snapshot backlog limit");
        } catch {
          /* close handler 会清理 client。 */
        }
        return false;
      }
      backlog.frames.push(frame);
      backlog.bytes += frame.byteLength;
      return true;
    }
    return this.sendWs(c.ws, frame, "client");
  }
  private sendClientNow(c: ClientConn, payload: ServerToClientPayload): boolean {
    if (c.ws.readyState !== c.ws.OPEN) return false;
    return this.sendWs(c.ws, encodeServerToClient(create(ServerToClientSchema, { payload })), "client");
  }
  /** `ws` 会替应用无界缓存 send；慢消费者若持续不读，单连接即可耗尽 server 内存。
   * 把所有控制面发送统一卡在硬水位，断开后由既有重连+快照/catalog 自愈。 */
  private sendWs(ws: WebSocket, frame: Uint8Array, peer: "client" | "daemon" | "pending-daemon"): boolean {
    if (ws.readyState !== ws.OPEN) return false;
    const limit = config.clientBufferHardLimit;
    if (frame.byteLength > limit || ws.bufferedAmount > limit - frame.byteLength) {
      log.warn("WS 发送缓冲超过硬上限，断开慢消费者", {
        peer,
        bufferedBytes: ws.bufferedAmount,
        frameBytes: frame.byteLength,
        limitBytes: limit,
      });
      try {
        ws.close(1013, "send buffer limit");
      } catch {
        /* close handler 会做业务清理；这里只阻止继续排队。 */
      }
      return false;
    }
    try {
      ws.send(frame);
      return true;
    } catch (error) {
      log.warn("WS 发送失败", { peer, err: error instanceof Error ? error.message : String(error) });
      return false;
    }
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

  /** 账号下设备清单（在线连接优先，离线补自 devices 表）。clientSubscribe 与 MCP list_devices 共用。 */
  async daemonInfoList(accountId: AccountId): Promise<DaemonInfoData[]> {
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
    return this.sendDaemon(d, payload);
  }

  private async registerDaemonConn(
    conn: DaemonCtx,
    observedInfo: DaemonInfoData,
    accountId: AccountId,
    arch: string,
    capabilities: readonly string[],
    authSuccess: ServerToDaemonPayload,
  ): Promise<boolean> {
    return await this.withDaemonGenerationGate(observedInfo.daemonId, async () => {
      if (this.shuttingDown || conn.ws.readyState !== conn.ws.OPEN) return false;

      // token lookup 在 gate 外，可能拿到 removeDevice 提交前的旧 active snapshot。这里按统一的
      // gate → device row 锁序重新 claim，并把 touch 纳入同一事务；removeDevice 全程也持该 gate，
      // 因而注册/restore 与 revoke 不会交错，更不会让旧 grant 快照覆盖 pending_revoke。
      const device = await this.store.transaction(async (tx) => {
        const active = await tx.claimActiveDevice(observedInfo.daemonId, accountId);
        if (!active) return undefined;
        await tx.touchDevice(active.id, Date.now());
        return active;
      });
      if (!device || this.shuttingDown || conn.ws.readyState !== conn.ws.OPEN) {
        if (conn.ws.readyState === conn.ws.OPEN) {
          this.sendRaw(conn.ws, {
            case: "daemonAuthError",
            value: { message: "设备凭证无效或已撤销", needEnroll: true },
          });
          conn.ws.close(4001, "device revoked during auth");
        }
        return false;
      }

      const info: DaemonInfoData = {
        ...observedInfo,
        name: device.name,
        host: device.host,
        platform: device.platform,
        online: true,
      };
      const daemon: DaemonConn = { ws: conn.ws, info, accountId: device.accountId, arch, capabilities: new Set(capabilities) };
      const prev = this.daemons.get(info.daemonId);
      if (prev && prev.ws !== conn.ws) {
        try {
          prev.ws.close(4002, "replaced by new connection");
        } catch {
          /* ignore */
        }
        // 连接换代：旧连接上在飞的中心发起操作/读写请求不再有回执可等，以可读错误唤醒；
        // 已安装的 prepared 记录由下方 restore 在新连接上重装并再次 Execute（worker 侧幂等）。
        this.failDaemonWaiters(info.daemonId, "daemon 连接已换代，请重试或稍后用 list_* 查看结果");
      }
      conn.daemonId = info.daemonId;
      conn.accountId = device.accountId;
      this.daemons.set(info.daemonId, daemon);

      // 认证成功必须在任何 relay/workspace/restore 帧之前；否则 worker 仍处未认证态，会丢弃
      // 后续初始化消息。发送失败则同步撤掉刚安装的 current，不留下幽灵 online generation。
      if (!this.sendDaemon(daemon, authSuccess)) {
        if (this.daemons.get(info.daemonId) === daemon) this.daemons.delete(info.daemonId);
        conn.daemonId = null;
        conn.accountId = null;
        return false;
      }

      // generation 注册与 durable restore 是同一条线性化操作。若只保护上面的 Map 替换，
      // 旧连接的 restore continuation 可能在新连接上线后撤销新 lease、覆盖 gateway，或重装
      // 旧 prepared timer；后继连接必须等当前 generation 完成初始化后才能接管。
      // 新 oneof 对旧 worker 会按 protobuf unknown field 解成空 payload 并忽略；无需版本门。
      this.sendDaemon(daemon, { case: "relayNodeList", value: { nodes: config.relayNodes } });
      this.broadcast(device.accountId, { case: "daemonUpdated", value: { daemon: info } });
      await this.pushWorkspaceList(info.daemonId, daemon);
      if (!this.isCurrentDaemon(daemon)) return false;
      // 握手完成时机：下发最新设备名称以支持设备重命名同步（plan 018）
      this.sendDaemon(daemon, { case: "daemonSetName", value: { name: info.name } });
      // durable grant/prepared state 由中心在每次 daemon 认证后重装；lease 不跨连接恢复。
      await this.localControl.restoreDaemon(daemon);
      if (!this.isCurrentDaemon(daemon)) return false;
      await this.preparedOperations.restore(daemon);
      if (!this.isCurrentDaemon(daemon)) return false;
      await this.reconcileDeletingProjects(daemon);
      if (!this.isCurrentDaemon(daemon)) return false;
      await this.requestSessionCatalog(daemon);
      if (!this.isCurrentDaemon(daemon)) return false;
      // 握手完成时机（plan 015）：给自动更新编排一个立即比对本台 daemon 的机会，不必等下一次轮询。
      this.onDaemonHandshake?.(info.daemonId);
      return true;
    });
  }

  /** 自动更新编排（plan 015）读取在线 daemon 快照用于比对期望版本。 */
  listOnlineDaemonsForUpdate(): { daemonId: DaemonId; workerVersion: string; platform: string; arch: string }[] {
    return [...this.daemons.values()].map((d) => ({ daemonId: d.info.daemonId, workerVersion: d.info.workerVersion, platform: d.info.platform, arch: d.arch }));
  }

  /** 对某在线 daemon 下发 worker 升级：复用 clientUpgradeDaemon 的发送路径，不绕过/复制 supervisor 侧语义。 */
  sendWorkerUpgrade(
    daemonId: DaemonId,
    payload: {
      version: string;
      url: string;
      sha256: string;
      signature: string;
      target: string;
      artifactSize: bigint;
      releaseSignature: string;
    },
  ): boolean {
    const d = this.daemons.get(daemonId);
    if (!d) return false;
    return this.sendDaemon(d, { case: "workerUpgrade", value: payload });
  }

  /** 全量下发某设备的工作区清单（连接时 + 工作区增删时），worker 据此监视各 worktree 的 HEAD 分支 +
   * git diff 统计；defaultBranch 带出所属 project 的默认分支（diff 统计基准）。这里下发的是
   * **缓存**——它的真相是 daemon 本地的 origin/HEAD，server 无从验证，worker 收到后核对、不符则经
   * workspaceDefaultBranch 上报纠正（plan 072）。自愈频率绑在本方法的调用时机上：减少调用会让
   * 自愈变慢甚至失效。 */
  private async pushWorkspaceList(daemonId: DaemonId, expectedDaemon?: DaemonConn): Promise<void> {
    const daemon = expectedDaemon ?? this.daemons.get(daemonId);
    if (!daemon || !this.isCurrentDaemon(daemon)) return;
    const [workspaces, projects] = await Promise.all([this.store.listWorkspacesByDaemon(daemonId), this.store.listProjectsByDaemon(daemonId)]);
    if (!this.isCurrentDaemon(daemon)) return;
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

  private isCurrentDaemon(daemon: DaemonConn): boolean {
    return !this.shuttingDown && this.daemons.get(daemon.info.daemonId) === daemon;
  }

  private assertCurrentDaemon(daemon: DaemonConn): void {
    if (!this.isCurrentDaemon(daemon)) throw new StaleDaemonConnectionError();
  }

  /** 同一 daemonId 的 FIFO async mutex。users 同时统计 holder + waiters，最后一个离开才删 Map，
   * 避免刚释放旧 gate、尚有 waiter 时另一调用创建第二把锁闯入。 */
  private async withDaemonGenerationGate<T>(daemonId: DaemonId, fn: () => Promise<T>): Promise<T> {
    let gate = this.daemonGenerationGates.get(daemonId);
    if (!gate) {
      gate = { tail: Promise.resolve(), users: 0 };
      this.daemonGenerationGates.set(daemonId, gate);
    }
    gate.users += 1;
    const previous = gate.tail;
    let release!: () => void;
    gate.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await fn();
    } finally {
      release();
      gate.users -= 1;
      if (gate.users === 0 && this.daemonGenerationGates.get(daemonId) === gate) {
        this.daemonGenerationGates.delete(daemonId);
      }
    }
  }

  /** gate 必须包住 store.transaction() 本身而非只包 callback：postgres.js 在 callback 返回后
   * 另发 COMMIT，直到 begin promise resolve 前都不能允许 current generation 被替换。 */
  private async withCurrentDaemonTransaction<T>(daemon: DaemonConn, fn: (tx: Store) => Promise<T>): Promise<T> {
    return this.withDaemonGenerationGate(daemon.info.daemonId, async () => {
      this.assertCurrentDaemon(daemon);
      const result = await this.store.transaction(async (tx) => {
        this.assertCurrentDaemon(daemon);
        const value = await fn(tx);
        this.assertCurrentDaemon(daemon);
        return value;
      });
      this.assertCurrentDaemon(daemon);
      return result;
    });
  }

  private async requestSessionCatalog(daemon: DaemonConn): Promise<void> {
    // 缺席只对“请求发出前中心已经认为在跑”的绑定有意义。请求之后才创建/重启的 session
    // 不可能出现在这份快照中；若旧绑定随后变化，exitRunningTaskIfSession 的 CAS 会再拒绝。
    const runningTasks = await this.store.listRunningTasksByDaemon(daemon.info.daemonId);
    if (!this.isCurrentDaemon(daemon)) return;
    const absenceCandidates = runningTasks.flatMap((task) =>
      task.accountId === daemon.accountId && task.sessionId
        ? [{ taskId: task.id, sessionId: task.sessionId }]
        : []
    );
    const requestId = randomUUID();
    daemon.catalogRequest = { requestId, absenceCandidates };
    if (!this.sendDaemon(daemon, { case: "sessionCatalogRequest", value: { requestId } })) {
      if (daemon.catalogRequest?.requestId === requestId) daemon.catalogRequest = undefined;
    }
  }

  /**
   * sessiond catalog/tombstone 是活 PTY truth。unknown/mismatched session 只保留为 local orphan；
   * 中心不自动创建 task，也绝不因“不认识”而关闭它。
   */
  private async reconcileSessionCatalog(daemon: DaemonConn, catalog: DeviceSessionCatalog): Promise<void> {
    try {
      await this.reconcileCurrentSessionCatalog(daemon, catalog);
    } catch (error) {
      if (error instanceof StaleDaemonConnectionError) return;
      throw error;
    }
  }

  private async reconcileCurrentSessionCatalog(daemon: DaemonConn, catalog: DeviceSessionCatalog): Promise<void> {
    const request = daemon.catalogRequest;
    const legacyComplete =
      !catalog.snapshotOwnerId &&
      catalog.snapshotEpoch === 0n &&
      catalog.sessionOffset === 0 &&
      catalog.exitOffset === 0 &&
      catalog.nextSessionOffset === 0 &&
      catalog.nextExitOffset === 0 &&
      !catalog.complete &&
      !catalog.reset;
    const pagedComplete =
      catalog.complete &&
      !catalog.reset &&
      catalog.sessionOffset === 0 &&
      catalog.exitOffset === 0 &&
      catalog.nextSessionOffset === catalog.sessions.length &&
      catalog.nextExitOffset === catalog.exits.length;
    if (
      request?.requestId !== catalog.requestId ||
      !validControlId(catalog.requestId) ||
      (!legacyComplete && !pagedComplete) ||
      catalog.sessions.length > MAX_CATALOG_ENTRIES ||
      catalog.exits.length > MAX_CATALOG_ENTRIES
    ) return;
    this.assertCurrentDaemon(daemon);
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
      await this.withTaskEffectGuard(session.taskId, async (effectGuard) => {
        const task = await this.store.getTask(session.taskId);
        this.assertCurrentDaemon(daemon);
        if (
          effectGuard.cancelled ||
          !task ||
          task.accountId !== daemon.accountId ||
          task.daemonId !== daemon.info.daemonId
        ) return;
        // catalog 与 daemon.resync 都只能确认中心已预绑定的同一 session。EXITED 已清空
        // sessionId，是不可逆 exit fact；旧 catalog 即使晚于 sessionExit 到达也不能复活它。
        if (task.sessionId !== session.sessionId) return;
        let updated: Task | undefined;
        if (task.status !== TaskStatus.RUNNING) {
          updated = await this.withCurrentDaemonTransaction(daemon, async (tx) => {
            return await tx.runTaskIfSession(
              task.id,
              daemon.accountId,
              daemon.info.daemonId,
              session.sessionId,
            );
          });
          this.assertCurrentDaemon(daemon);
          if (!updated) return;
        }
        // 删除提交后的 cancel、daemon generation 复核、旧 incarnation route 释放、新映射和
        // taskUpdated 之间无 await：只能完整发生在 taskRemoved 前，或被删除完全抑制。
        if (effectGuard.cancelled) return;
        this.installSessionRuntime(
          session.sessionId,
          session.taskId,
          daemon.accountId,
          daemon.info.daemonId,
        );
        if (updated) this.emitTask(updated);
      });
    }

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
      await this.withTaskEffectGuard(exit.taskId, async (effectGuard) => {
        const convergence = await this.withCurrentDaemonTransaction(daemon, async (tx) => {
          // removeDevice、prepared report/admission 都以 device 父行为第一把锁；catalog exit 也必须
          // 遵循 device → task/prepared，不能先锁 task 后再与删除的 prepared → task 形成反序。
          const device = await tx.claimActiveDevice(daemon.info.daemonId, daemon.accountId);
          this.assertCurrentDaemon(daemon);
          if (!device) return undefined;
          const task = await tx.getTask(exit.taskId);
          this.assertCurrentDaemon(daemon);
          if (!task || task.accountId !== daemon.accountId || task.daemonId !== daemon.info.daemonId) return undefined;
          const operation = await tx.findLatestPreparedOperation(task.accountId, task.daemonId, "session.create", task.id);
          this.assertCurrentDaemon(daemon);
          const metadata = operation ? parseOperationMetadata(operation.metadata) : undefined;
          const preparedSessionId = metadata && metadataString(metadata, "sessionId");
          const matchesCurrent = task.sessionId === exit.sessionId;
          const matchesPendingCreate = !task.sessionId && preparedSessionId === exit.sessionId;
          if (!matchesCurrent && !matchesPendingCreate) return undefined;
          if (task.status === TaskStatus.EXITED && task.exitCode === exit.exitCode && !task.sessionId) {
            let completedOperationId: string | undefined;
            if (operation && !operation.completed) {
              const completed = await tx.finishPreparedOperationFromExit(
                operation.operationId,
                task.id,
                exit.sessionId,
                exit.exitCode,
              );
              this.assertCurrentDaemon(daemon);
              completedOperationId = completed?.operationId;
            }
            return { task: undefined, completedOperationId };
          }
          const changed = await tx.updateTask(task.id, {
            status: TaskStatus.EXITED,
            sessionId: undefined,
            exitCode: exit.exitCode,
          });
          this.assertCurrentDaemon(daemon);
          let completedOperationId: string | undefined;
          if (operation && preparedSessionId === exit.sessionId && !operation.completed) {
            const completed = await tx.finishPreparedOperationFromExit(
              operation.operationId,
              task.id,
              exit.sessionId,
              exit.exitCode,
            );
            this.assertCurrentDaemon(daemon);
            completedOperationId = completed?.operationId;
          }
          return { task: changed, completedOperationId };
        });
        // 与 report 收敛相同：数据库终态提交后先推进 prepared 投递代际，再做广播。
        if (convergence?.completedOperationId) {
          this.preparedOperations.complete(convergence.completedOperationId);
        }
        this.assertCurrentDaemon(daemon);
        const ownsRuntime = this.sessionHasIdentity(
          exit.sessionId,
          exit.taskId,
          daemon.accountId,
          daemon.info.daemonId,
        );
        // taskRemove 若已提交，会先 cancel guard/摘运行时再广播 removed。下面无 await，
        // 因而合法顺序只能是 updated→removed，或 removed 后彻底抑制这份旧 continuation。
        if (effectGuard.cancelled) return;
        if (convergence?.task) this.emitTask(convergence.task);
        if (ownsRuntime) this.dropSession(exit.sessionId);
        // tombstone 也是退出事实：sessionExit 控制消息丢失时靠它唤醒 wait_terminal（plan 091）。
        if (convergence) this.taskExitCompletions.resolve(exit.taskId, { case: "exited", exitCode: exit.exitCode });
      });
      // unknown/orphan tombstone 无需业务映射，但仍可在持久化收敛后 ack 让 sessiond 有界清理。
      ackIds.push(exit.eventId);
    }
    if (ackIds.length > 0) {
      this.assertCurrentDaemon(daemon);
      this.sendDaemon(daemon, {
        case: "exitAck",
        value: {
          eventIds: ackIds,
          requestId: catalog.requestId,
          snapshotOwnerId: catalog.snapshotOwnerId,
          snapshotEpoch: catalog.snapshotEpoch,
        },
      });
    }

    // 反向收敛只遍历 request 发出前冻结的 RUNNING 绑定：中心当时认为在跑、但本次全量快照没有的
    // PTY 已不存在；request 后才创建/重启的 session 不属于该快照的观察范围。tombstone 只活在
    // supervisor 内存里，整树重启后会丢；若只等 tombstone，这类 task 会永久停在 RUNNING +
    // sessionId。判缺席必须取 catalog 的原始合法 ID 集合，不能用上面的 live：live 会因 cwd/尺寸/
    // 累计字节等单项校验过滤条目，用它会误杀仍存活但本轮未保留的 PTY。
    const reportedSessionIds = new Set<SessionId>();
    for (const session of catalog.sessions) {
      if (validControlId(session.sessionId)) reportedSessionIds.add(session.sessionId);
    }
    const convergedTasks: { taskId: TaskId; sessionId: SessionId }[] = [];
    for (const task of request.absenceCandidates) {
      if (reportedSessionIds.has(task.sessionId)) continue;
      const sessionId = task.sessionId;
      // 中心不知道真实退出码，写 null（patch 中 undefined 的持久化语义）；prepared operation 仍由
      // 自己的 TTL 状态机收敛。这里只改中心状态与映射，绝不向 daemon 下发 stop/close。
      await this.withTaskEffectGuard(task.taskId, async (effectGuard) => {
        const updated = await this.withCurrentDaemonTransaction(daemon, async (tx) => {
          const changed = await tx.exitRunningTaskIfSession(
            task.taskId,
            daemon.accountId,
            daemon.info.daemonId,
            sessionId,
          );
          this.assertCurrentDaemon(daemon);
          return changed;
        });
        this.assertCurrentDaemon(daemon);
        if (!updated || effectGuard.cancelled) return;
        const ownsRuntime = this.sessionHasIdentity(
          sessionId,
          task.taskId,
          daemon.accountId,
          daemon.info.daemonId,
        );
        // identity/drop/emit 与 converged 记账是一个无 await 段；同 ID 已换 incarnation 时
        // 仍广播旧 task 的合法 DB 终态，但绝不能摘掉新 task 的 runtime/端口。
        if (ownsRuntime) this.dropSession(sessionId);
        this.emitTask(updated);
        this.taskExitCompletions.resolve(task.taskId, { case: "failed", message: "会话已不在设备上（退出码未知），任务已收敛为已退出" });
        convergedTasks.push({ taskId: task.taskId, sessionId });
      });
    }
    for (const task of convergedTasks) {
      log.info("running task 无对应活 PTY，收敛为已退出", {
        daemonId: daemon.info.daemonId,
        taskId: task.taskId,
        sessionId: task.sessionId,
        convergedCount: convergedTasks.length,
      });
    }

    this.assertCurrentDaemon(daemon);
    this.catalog.set(daemon.info.daemonId, live);
    log.debug("session catalog reconciled", { daemonId: daemon.info.daemonId, live: live.size, exits: ackIds.length });
    if (daemon.catalogRequest?.requestId === catalog.requestId) daemon.catalogRequest = undefined;
  }

  /* ==================== agent 协同控制（plan 074） ==================== */

  /** daemon 转发的 agent 控制请求。worker 已用调用方 pid 反查进程树确认它属于 `sessionId`
   * 这个存活会话；这里据它反查 task→workspace 完成归属校验——agent 不自报 workspace，
   * 也无从伪造。走 daemon 控制 WS 而非 browser 那套 prepared operation：后者的最后一跳是
   * 把 frame 交给 client 转投，而 agent 场景根本没有 client，且 daemon 控制 WS 本身就是
   * 已认证的可信面。
   *
   * 每条请求必回一条 agentControlResult：worker 侧在等，静默丢弃只会让 agent 干等到超时。 */
  private async handleAgentControl(daemon: DaemonConn, request: AgentControlRequest): Promise<void> {
    const fail = (error: string) =>
      this.sendDaemon(daemon, { case: "agentControlResult", value: { requestId: request.requestId, ok: false, error } });
    // transport 层只会 log 掉 handler 的 rejection（见 transport.ts），而 agent 在等回执——
    // 不兜底的话一次 DB 抖动就让它干等到超时。异常一律转成明确失败。
    try {
      await this.dispatchAgentControl(daemon, request, fail);
    } catch (error) {
      log.error("agent control failed", { daemonId: daemon.info.daemonId, err: (error as Error).message });
      fail("中心处理该请求时出错");
    }
  }

  private async dispatchAgentControl(daemon: DaemonConn, request: AgentControlRequest, fail: (error: string) => void): Promise<void> {
    const reply = (payload: AgentControlResultPayload) =>
      this.sendDaemon(daemon, { case: "agentControlResult", value: { requestId: request.requestId, ok: true, payload } });

    const originTask = await this.store.getTaskBySession(request.sessionId);
    if (!originTask || originTask.daemonId !== daemon.info.daemonId || originTask.accountId !== daemon.accountId) {
      return void fail("发起方会话不属于本设备的任何任务");
    }
    const workspace = await this.store.getWorkspace(originTask.workspaceId);
    if (!workspace || workspace.accountId !== daemon.accountId) return void fail("发起方工作区已不存在");

    switch (request.payload.case) {
      case "terminalNew": {
        const value = request.payload.value;
        const taskId = randomUUID();
        const sessionId = randomUUID();
        return await this.withDeviceEffectGuard(daemon.info.daemonId, async (effectGuard) => {
          return await this.withTaskEffectGuard(taskId, async (taskEffectGuard) => {
            return await this.withDaemonGenerationGate(daemon.info.daemonId, async () => {
              if (!this.isCurrentDaemon(daemon)) return void fail("daemon 连接已换代，请重试");
              const outcome = await this.store.transaction(async (tx) => {
                // 与 removeDevice 及 browser 侧所有子项写入共用 device 父行锁；
                // 锁后重读发起 task/workspace，防迟到的 agent 请求在设备删除后插入孤儿任务。
                const device = await tx.claimActiveDevice(daemon.info.daemonId, daemon.accountId);
                if (!device) return { ok: false, error: "设备已撤销或不属于本账号" } as const;
                const currentOrigin = await tx.getTask(originTask.id);
                if (
                  !currentOrigin ||
                  currentOrigin.sessionId !== request.sessionId ||
                  currentOrigin.daemonId !== daemon.info.daemonId ||
                  currentOrigin.accountId !== daemon.accountId
                ) return { ok: false, error: "发起方会话已失效" } as const;
                const currentWorkspace = await tx.getWorkspace(currentOrigin.workspaceId);
                if (
                  !currentWorkspace ||
                  currentWorkspace.accountId !== daemon.accountId ||
                  currentWorkspace.daemonId !== daemon.info.daemonId
                ) return { ok: false, error: "发起方工作区已不存在" } as const;
                if (!isDirWorkspace(currentWorkspace)) {
                  const project = await tx.claimActiveProject(currentWorkspace.projectId);
                  if (
                    !project ||
                    project.accountId !== currentWorkspace.accountId ||
                    project.daemonId !== currentWorkspace.daemonId
                  ) return { ok: false, error: "项目正在删除，不能再创建终端" } as const;
                }

                const tasks = await tx.listTasksByWorkspace(currentWorkspace.id);
                // 统计所有活跃终端而不只是 agent 建的：防的是「侧栏被刷满」，来源无所谓，而区分来源
                // 要给 Task 加一个只服务于计数的持久字段，不值得。错误信息里说清含用户自己开的。
                const active = tasks.filter((t) => t.status === TaskStatus.RUNNING).length;
                if (active >= config.maxAgentTerminalsPerWorkspace) {
                  return {
                    ok: false,
                    error: `本工作区活跃终端已达上限 ${config.maxAgentTerminalsPerWorkspace}（含用户手动开的），先停掉一些再开新的`,
                  } as const;
                }
                const ts = Date.now();
                // sessionId 建库时就写死：daemon 回 sessionStarted 时按 task.sessionId 匹配才会转 RUNNING。
                const task: Task = create(TaskSchema, {
                  id: taskId,
                  accountId: currentWorkspace.accountId,
                  daemonId: currentWorkspace.daemonId,
                  projectId: currentWorkspace.projectId,
                  workspaceId: currentWorkspace.id,
                  title: value.title.trim() || "agent 终端",
                  status: TaskStatus.IDLE,
                  sessionId,
                  createdAt: ts,
                  updatedAt: ts,
                });
                await tx.createTask(task);
                return { ok: true, task, workspace: currentWorkspace, sessionId } as const;
              });
              if (!outcome.ok) return void fail(outcome.error);
              if (effectGuard.cancelled) return void fail("设备已删除，终端创建已取消");
              if (taskEffectGuard.cancelled) return void fail("工作区或任务已删除，终端创建已取消");
              const { task, workspace: currentWorkspace } = outcome;
              if (!this.isCurrentDaemon(daemon)) {
                await this.store.removeIdleTaskIfSession(task.id, task.accountId, task.daemonId, sessionId);
                return void fail("daemon 连接已换代，请重试");
              }
              // 先确认 control frame 已进入当前 WS 发送队列，再让 task/runtime 对外可见。同步发送
              // 失败时用完整 incarnation CAS 补偿删除，并广播 removed 覆盖并发订阅快照窗口。
              const sent = this.sendDaemon(daemon, {
                case: "sessionCreate",
                // shell 指向 worker 自己写的命令包装脚本（supervisor 的 CommandBuilder 不接受 args）。
                // 路径由 daemon 生成、只回到同一个 daemon 执行，server 不解释也不校验它。
                value: { sessionId, taskId: task.id, cwd: currentWorkspace.path, shell: value.shell, cols: AGENT_TERMINAL_COLS, rows: AGENT_TERMINAL_ROWS },
              });
              if (!sent) {
                const removed = await this.store.removeIdleTaskIfSession(
                  task.id,
                  task.accountId,
                  task.daemonId,
                  sessionId,
                );
                if (removed) {
                  this.cancelTaskEffects(task.id);
                  this.broadcast(task.accountId, { case: "taskRemoved", value: { taskId: task.id } });
                }
                return void fail("daemon 连接发送失败，终端创建已取消");
              }
              // send/current/guard 复核、runtime 安装、taskUpdated 与 reply 之间无 await。
              this.installSessionRuntime(
                sessionId,
                task.id,
                currentWorkspace.accountId,
                currentWorkspace.daemonId,
              );
              this.emitTask(task);
              return void reply({ case: "terminalNew", value: { taskId: task.id, sessionId } });
            });
          });
        });
      }
      case "terminalList": {
        const tasks = await this.store.listTasksByWorkspace(workspace.id);
        // 只给最近的一批：用久的工作区会攒下几十个 exited 终端，全塞给 agent 是纯噪音。
        const terminals = tasks
          .slice()
          .sort((left, right) => left.createdAt - right.createdAt)
          .slice(-MAX_AGENT_TERMINAL_LIST)
          .map((task) => ({
            taskId: task.id,
            title: task.title,
            status: task.status,
            exitCode: task.exitCode,
            sessionId: task.sessionId,
            createdAt: task.createdAt,
          }));
        return void reply({ case: "terminalList", value: { terminals } });
      }
      case "terminalRead": {
        const target = await this.store.getTask(request.payload.value.taskId);
        if (!target || target.workspaceId !== workspace.id || target.accountId !== daemon.accountId) {
          return void fail("该终端不在本工作区");
        }
        // 按 task 查而不是按 session：session 退出时 task.sessionId 会被清空，而读已结束的
        // 终端正是最常用的场景。无 checkpoint（刚建、还没有输出）返回空内容，不算失败。
        const checkpoint = await this.store.getSessionCheckpointByTask(target.id);
        return void reply({
          case: "terminalRead",
          value: {
            ansiSnapshot: checkpoint?.ansiSnapshot ?? new Uint8Array(),
            capturedAt: checkpoint?.capturedAt ?? 0,
            status: target.status,
            exitCode: target.exitCode,
          },
        });
      }
      case "portsList": {
        // 整个工作区的端口，不只发起方那个终端——agent 常在 A 终端起 dev server、在 B 终端问 URL。
        const tasks = await this.store.listTasksByWorkspace(workspace.id);
        const ports = tasks.flatMap((task) =>
          this.routeTable.portsForTask(task.id).map((route) => ({ port: route.port, url: buildPreviewUrl(route.shortId) })),
        );
        return void reply({ case: "portsList", value: { ports } });
      }
      default:
        return void fail("未知的 agent 控制动作");
    }
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
    // title 由 sessiond 源头钳制（256B）；这里兜底截断而非整条拒收——伪造 daemon 塞超长
    // 标题不该连累 ansi_snapshot 一起丢。256 个 UTF-16 单元对展示已绰绰有余。
    // 注意不能在 surrogate pair 中间截：proto 解码保证 well-formed，半个代理对只会由
    // 这次截断制造，而它不是合法 UTF-8，会让 PG 的 TEXT 写入整条报错。
    if (checkpoint.title.length > 256) {
      const end = /[\uD800-\uDBFF]/.test(checkpoint.title[255]!) ? 255 : 256;
      checkpoint.title = checkpoint.title.slice(0, end);
    }
    const live = this.catalog.get(daemon.info.daemonId)?.get(checkpoint.sessionId);
    const runtime = this.sessions.get(checkpoint.sessionId);
    const matchesKnownSession = live
      ? live.taskId === checkpoint.taskId
      : runtime?.daemonId === daemon.info.daemonId && runtime.taskId === checkpoint.taskId;
    if (!matchesKnownSession) return;
    await this.withDeviceEffectGuard(daemon.info.daemonId, async (effectGuard) => {
      const stored = await this.store.transaction(async (tx) => {
        // checkpoint 也是 device 子记录：父锁后重读 task，与 removeDevice 的
        // 「删 checkpoint → 删 task」串行，防迟到 upsert 在删除后插回孤儿。
        const device = await tx.claimActiveDevice(daemon.info.daemonId, daemon.accountId);
        if (!device) return undefined;
        const task = await tx.getTask(checkpoint.taskId);
        if (
          !task ||
          task.accountId !== daemon.accountId ||
          task.daemonId !== daemon.info.daemonId ||
          task.sessionId !== checkpoint.sessionId ||
          task.status !== TaskStatus.RUNNING
        ) return undefined;
        return tx.upsertSessionCheckpoint(daemon.accountId, daemon.info.daemonId, checkpoint);
      });
      if (!stored || effectGuard.cancelled || this.daemons.get(daemon.info.daemonId) !== daemon) return;
      for (const client of this.clients) {
        if (client.subscribed && client.accountId === daemon.accountId) this.sendCheckpoint(client, stored);
      }
    });
  }

  private sendCheckpoint(client: ClientConn, checkpoint: SessionCheckpointRecord, initialSnapshot = false): void {
    const payload: ServerToClientPayload = {
      case: "sessionCheckpoint",
      value: {
        sessionId: checkpoint.sessionId,
        taskId: checkpoint.taskId,
        snapshotSeq: checkpoint.snapshotSeq,
        ansiSnapshot: checkpoint.ansiSnapshot,
        cols: checkpoint.cols,
        rows: checkpoint.rows,
        title: checkpoint.title,
        capturedAt: checkpoint.capturedAt,
      },
    };
    if (initialSnapshot) this.sendClientNow(client, payload);
    else this.sendClient(client, payload);
  }

  /** agent presence（plan 073）：逐条校验会话归属本连接 daemon（catalog live 或 runtime 路由，
   * 同 checkpoint 的 matchesKnownSession 口径），非法条目丢弃不广播。与现值相同则直接吸收
   * （worker 变化才发，但重连补发是无条件的）。 */
  private acceptSessionAgents(daemon: DaemonConn, sessions: readonly SessionAgentRef[]): void {
    const daemonId = daemon.info.daemonId;
    const live = this.catalog.get(daemonId);
    const valid: SessionAgentData[] = [];
    for (const entry of sessions.slice(0, MAX_AGENT_ENTRIES)) {
      if (!validControlId(entry.sessionId) || !validControlId(entry.taskId)) continue;
      if (!entry.agent || Buffer.byteLength(entry.agent) > MAX_AGENT_NAME_BYTES) continue;
      if (!AGENT_STATES.has(entry.state)) continue;
      const catalogInfo = live?.get(entry.sessionId);
      const runtime = this.sessions.get(entry.sessionId);
      const matchesKnownSession = catalogInfo
        ? catalogInfo.taskId === entry.taskId
        : runtime?.daemonId === daemonId && runtime.taskId === entry.taskId;
      if (!matchesKnownSession) continue;
      const message = Buffer.byteLength(entry.message) > MAX_AGENT_MESSAGE_BYTES ? "" : entry.message;
      const progress = Buffer.byteLength(entry.progress) > MAX_AGENT_MESSAGE_BYTES ? "" : entry.progress;
      valid.push({ sessionId: entry.sessionId, taskId: entry.taskId, agent: entry.agent, state: entry.state, message, progress });
    }
    const previous = this.sessionAgents.get(daemonId);
    const unchanged =
      previous !== undefined &&
      previous.sessions.length === valid.length &&
      previous.sessions.every(
        (p, i) =>
          p.sessionId === valid[i]!.sessionId &&
          p.taskId === valid[i]!.taskId &&
          p.agent === valid[i]!.agent &&
          p.state === valid[i]!.state &&
          p.message === valid[i]!.message &&
          p.progress === valid[i]!.progress,
      );
    if (unchanged) return;
    if (valid.length === 0 && previous === undefined) return;
    if (valid.length === 0) this.sessionAgents.delete(daemonId);
    else this.sessionAgents.set(daemonId, { accountId: daemon.accountId, sessions: valid });
    this.broadcast(daemon.accountId, { case: "sessionAgentsUpdated", value: { daemonId, sessions: valid } });
  }

  /* ----------------------- durable prepared op ----------------------- */

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
    const knownMetadata = parseOperationMetadata(known.metadata);
    const sessionCreateTaskId = known.kind === "session.create" && knownMetadata
      ? metadataString(knownMetadata, "taskId")
      : undefined;
    const guardsCreatedEntity = known.kind === "project.import" || known.kind === "worktree.add";
    const createdProjectId = guardsCreatedEntity && knownMetadata
      ? metadataString(knownMetadata, "projectId")
      : undefined;
    const createdWorkspaceId = guardsCreatedEntity && knownMetadata
      ? metadataString(knownMetadata, "workspaceId")
      : undefined;

    return await this.withDeviceEffectGuard(daemon.info.daemonId, async (effectGuard) => {
      const convergeAndApply = async (
        taskEffectGuard?: TaskEffectGuard,
        projectEffectGuard?: ProjectEffectGuard,
        workspaceEffectGuard?: WorkspaceEffectGuard,
      ): Promise<void> => {
        const outcome = await PreparedOperationConvergenceService.converge(
          this.store,
          { daemonId: daemon.info.daemonId, accountId: daemon.accountId },
          report,
          result.payload,
        );
        // worktree.remove 的 workspace DELETE 已提交；必须先同步取消所有旧 workspace
        // continuation，再做 task runtime drop、prepared completion 或任何业务广播。
        if (outcome.case === "applied" && outcome.effect.removedWorkspaceId) {
          this.cancelWorkspaceEffects(outcome.effect.removedWorkspaceId);
        }
        // worktree.remove 的 task 删除已随 convergence 提交；即使 removeDevice 已取消 device
        // guard，也必须先取消 task continuation 并摘 runtime。否则这些 task 已不在 removeDevice
        // 的 DELETE RETURNING 中，会从两条清理路径之间漏掉。
        if (outcome.case === "applied" && outcome.effect.removedTaskIds?.length) {
          this.retireTaskRuntimes(
            outcome.effect.removedTaskIds,
            outcome.effect.accountId,
            outcome.effect.daemonId,
            true,
          );
          this.preparedOperations.cancelMany(
            outcome.effect.cancelledPreparedOperationIds ?? [],
            "任务或工作区已删除，session.create 已取消",
          );
        }
        // applied/failed 都表示 prepared 行已经在数据库里终结。即使 removeDevice 随后取消
        // 业务副作用，也必须先推进投递代际并清 waiter/retry；否则取消 guard 会让并发 ready/
        // restore 查询继续信任提交前拿到的旧 installed 记录。ignored 没有终结所有权，不能清理。
        if (outcome.case !== "ignored") this.preparedOperations.complete(report.operationId);
        // 完成原语（plan 091）只在 applied/failed 唤醒：中心发起的操作在这里拿到 effect 或可读错误；
        // ignored（重复 report）既不唤醒也不清理。report 本身 !ok 时 effect 带 error，按失败唤醒。
        if (outcome.case === "failed") {
          this.operationCompletions.resolve(report.operationId, { case: "failed", message: outcome.message });
        } else if (outcome.case === "applied") {
          this.operationCompletions.resolve(
            report.operationId,
            outcome.effect.error
              ? { case: "failed", message: outcome.effect.error }
              : { case: "applied", effect: outcome.effect },
          );
        }
        if (
          !this.isCurrentDaemon(daemon) ||
          effectGuard.cancelled ||
          projectEffectGuard?.cancelled ||
          workspaceEffectGuard?.cancelled ||
          outcome.case === "ignored"
        ) return;
        if (outcome.case === "failed") {
          log.warn("prepared operation 收敛失败", {
            operationId: outcome.operation.operationId,
            daemonId: outcome.operation.daemonId,
            kind: outcome.operation.kind,
            reason: outcome.message,
          });
          this.broadcast(outcome.operation.accountId, {
            case: "error",
            value: { message: outcome.message },
          });
          return;
        }

        const { effect } = outcome;
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
          // session.create 在 convergence 前注册 task guard；删除提交后的 cancel、identity 安装与
          // taskUpdated 之间无 await，不能在 taskRemoved 后复活 mapping/UI。
          if (taskEffectGuard?.cancelled || effect.task.id !== sessionCreateTaskId) return;
          this.installSessionRuntime(
            effect.sessionId,
            effect.task.id,
            effect.accountId,
            effect.daemonId,
          );
          this.emitTask(effect.task);
        }
        if (effect.error) this.broadcast(effect.accountId, { case: "error", value: { message: effect.error } });
      };

      const convergeWithTaskGuard = async (
        projectEffectGuard?: ProjectEffectGuard,
        workspaceEffectGuard?: WorkspaceEffectGuard,
      ): Promise<void> => {
        if (sessionCreateTaskId) {
          return await this.withTaskEffectGuard(sessionCreateTaskId, (taskEffectGuard) =>
            convergeAndApply(taskEffectGuard, projectEffectGuard, workspaceEffectGuard));
        }
        return await convergeAndApply(undefined, projectEffectGuard, workspaceEffectGuard);
      };

      // project.import/worktree.add 的实体 id 在 report 前已写入 durable metadata，可在 DB
      // convergence 之前注册 guard。若只等 effect 返回后再注册，删除可能已先提交并广播。
      if (createdProjectId && createdWorkspaceId) {
        return await this.withProjectEffectGuard(createdProjectId, async (projectEffectGuard) =>
          await this.withWorkspaceEffectGuard(createdWorkspaceId, async (workspaceEffectGuard) =>
            await convergeWithTaskGuard(projectEffectGuard, workspaceEffectGuard)));
      }
      return await convergeWithTaskGuard();
    });
  }

  private async prepareWorktreeRemoval(client: ClientConn, project: Project, workspace: Workspace, removeProject: boolean): Promise<void> {
    const operationId = randomUUID();
    const frame = this.preparedOperations.createFrame(operationId, {
      case: "worktreeRemove",
      value: {
        requestId: operationId,
        operationId,
        repoPath: project.repoPath,
        worktreePath: workspace.path,
      },
    });
    await this.preparedOperations.prepare(client, {
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
    const projects = await this.store.listDeletingProjectsByDaemon(daemon.info.daemonId);
    if (!this.isCurrentDaemon(daemon)) return;
    for (const project of projects) {
      if (project.accountId === daemon.accountId) await this.finalizeDeletingProject(project.id, project.accountId, project.daemonId);
      if (!this.isCurrentDaemon(daemon)) return;
    }
  }

  private async finalizeDeletingProject(projectId: ProjectId, accountId: AccountId, daemonId: DaemonId): Promise<void> {
    let removedTaskIds: TaskId[] = [];
    let removedWorkspaceIds: WorkspaceId[] = [];
    let cancelledPreparedOperationIds: string[] = [];
    const removed = await this.store.transaction(async (tx) => {
      const device = await tx.claimActiveDevice(daemonId, accountId);
      if (!device) return false;
      const project = await tx.claimDeletingProject(projectId);
      if (!project || project.accountId !== accountId || project.daemonId !== daemonId) return false;
      const workspaces = await tx.listWorkspacesByProject(projectId);
      if (workspaces.some((workspace) => !workspace.isMain)) return false;
      for (const workspace of workspaces) {
        const taskIds = await tx.removeTasksByWorkspace(workspace.id);
        removedTaskIds.push(...taskIds);
        const now = Date.now();
        for (const taskId of taskIds) {
          cancelledPreparedOperationIds.push(...await tx.expirePreparedOperationsByTarget(
            accountId,
            daemonId,
            "session.create",
            taskId,
            now,
          ));
          await tx.removeSessionCheckpointsByTask(taskId);
        }
        await tx.removeWorkspace(workspace.id);
        removedWorkspaceIds.push(workspace.id);
      }
      await tx.removeProject(projectId);
      return true;
    });
    if (!removed) return;
    // 整批删除已提交：先统一取消 entity/task guard，再开始任何 drop/broadcast。
    this.cancelProjectEffects(projectId);
    for (const workspaceId of removedWorkspaceIds) this.cancelWorkspaceEffects(workspaceId);
    this.retireTaskRuntimes(removedTaskIds, accountId, daemonId, true);
    this.preparedOperations.cancelMany(
      cancelledPreparedOperationIds,
      "项目或工作区已删除，session.create 已取消",
    );
    for (const taskId of removedTaskIds) this.broadcast(accountId, { case: "taskRemoved", value: { taskId } });
    for (const workspaceId of removedWorkspaceIds) this.broadcast(accountId, { case: "workspaceRemoved", value: { workspaceId } });
    this.broadcast(accountId, { case: "projectRemoved", value: { projectId } });
    await this.pushWorkspaceList(daemonId);
  }

  /* ============================ Daemon 侧 ============================ */
  async handleDaemonMessage(conn: DaemonCtx, msg: DaemonToServer): Promise<void> {
    const handshake = msg.payload.case === "daemonAuth" || msg.payload.case === "daemonEnrollRequest";
    if (handshake) {
      // 已登记 socket 不能再次握手，否则旧连接 backlog 可反向替换已经上线的新连接。
      // pending enroll 允许同类续期：worker 会按 expiresAt 主动重发，而 server 的 TTL timer
      // 可能同一时刻尚未获得事件循环；daemonAuth 则不能把 enroll 中途切成另一种身份路径。
      if (conn.daemonId || (msg.payload.case === "daemonAuth" && conn.pendingAuthToken)) {
        log.warn("daemon 在同一连接重复握手", { daemonId: conn.daemonId ?? undefined, remoteAddress: conn.remoteAddress });
        conn.ws.close(1008, "duplicate daemon handshake");
        return;
      }
    } else if (!this.currentDaemon(conn)) {
      // 新连接替换旧 socket 后，旧 socket 已排队但尚未执行的消息全部失效。
      return;
    }

    switch (msg.payload.case) {
      case "daemonEnrollRequest": {
        const value = msg.payload.value;
        if (!this.enrollLimiter.allow(conn.remoteAddress)) {
          log.warn("daemon 匿名登记触发来源限速", { remoteAddress: conn.remoteAddress });
          conn.ws.close(1013, "enroll rate limit");
          return;
        }
        if (
          !validBoundedText(value.name, MAX_ENROLL_NAME_BYTES) ||
          !validBoundedText(value.host, MAX_ENROLL_HOST_BYTES) ||
          !validBoundedText(value.platform, MAX_ENROLL_PLATFORM_BYTES) ||
          !validBoundedText(value.workerVersion, MAX_ENROLL_VERSION_BYTES, true) ||
          !validBoundedText(value.supervisorVersion, MAX_ENROLL_VERSION_BYTES, true) ||
          !validBoundedText(value.arch, MAX_ENROLL_ARCH_BYTES, true) ||
          !validCapabilities(value.capabilities)
        ) {
          log.warn("daemon 匿名登记字段无效", { remoteAddress: conn.remoteAddress });
          conn.ws.close(1008, "invalid enroll request");
          return;
        }
        // 同连接理论上只会有一个 pending（daemon 收到 authorizePending 前不会再发一次）；
        // 兜底：若已有旧 pending（例如客户端异常重发），先摘掉旧的再建新的，避免 token 泄漏。
        if (conn.pendingAuthToken) {
          const old = this.pendingAuthorizations.get(conn.pendingAuthToken);
          if (old) clearTimeout(old.timer);
          this.pendingAuthorizations.delete(conn.pendingAuthToken);
        }
        if (this.pendingAuthorizations.size >= config.maxPendingAuthorizations) {
          conn.pendingAuthToken = undefined;
          log.warn("daemon 待授权请求达到全局上限", {
            remoteAddress: conn.remoteAddress,
            limit: config.maxPendingAuthorizations,
          });
          conn.ws.close(1013, "pending authorization limit");
          return;
        }
        const token = genToken("cf_authz");
        const createdAt = Date.now();
        const timer = setTimeout(() => {
          this.pendingAuthorizations.delete(token);
          if (conn.pendingAuthToken === token) conn.pendingAuthToken = undefined;
        }, config.authorizeTtlMs);
        (timer as { unref?: () => void }).unref?.();
        this.pendingAuthorizations.set(token, {
          token,
          conn,
          name: value.name.trim(),
          host: value.host.trim(),
          platform: value.platform.trim(),
          workerVersion: value.workerVersion,
          supervisorVersion: value.supervisorVersion,
          arch: value.arch,
          capabilities: [...value.capabilities],
          createdAt,
          timer,
        });
        conn.pendingAuthToken = token;
        this.sendRaw(conn.ws, { case: "daemonAuthorizePending", value: { url: `${config.webUrl}/authorize/${token}`, expiresAt: createdAt + config.authorizeTtlMs } });
        log.info("daemon authorize requested", { name: value.name.trim(), host: value.host.trim() });
        break;
      }
      case "daemonAuth": {
        const value = msg.payload.value;
        if (!this.daemonAuthLimiter.allow(conn.remoteAddress)) {
          log.warn("daemon token 认证触发来源限速", { remoteAddress: conn.remoteAddress });
          conn.ws.close(1013, "daemon auth rate limit");
          return;
        }
        if (
          !validBoundedText(value.deviceToken, MAX_CLIENT_TOKEN_BYTES) ||
          !validBoundedText(value.workerVersion, MAX_ENROLL_VERSION_BYTES, true) ||
          !validBoundedText(value.supervisorVersion, MAX_ENROLL_VERSION_BYTES, true) ||
          !validBoundedText(value.arch, MAX_ENROLL_ARCH_BYTES, true) ||
          !validCapabilities(value.capabilities)
        ) {
          log.warn("daemon 认证字段无效", { remoteAddress: conn.remoteAddress });
          conn.ws.close(1008, "invalid daemon auth");
          return;
        }
        const device = await this.store.getDeviceByTokenHash(hashToken(value.deviceToken));
        if (!device) {
          this.sendRaw(conn.ws, { case: "daemonAuthError", value: { message: "设备凭证无效或已撤销", needEnroll: true } });
          conn.ws.close(4001, "bad device token");
          return;
        }
        const registered = await this.registerDaemonConn(
          conn,
          { daemonId: device.id, name: device.name, host: device.host, platform: device.platform, online: true, workerVersion: value.workerVersion, supervisorVersion: value.supervisorVersion },
          device.accountId,
          value.arch,
          value.capabilities,
          { case: "daemonAuthed", value: { daemonId: device.id } },
        );
        if (registered) log.info("daemon authed", { daemonId: device.id, name: device.name });
        break;
      }
      case "daemonResync": {
        const value = msg.payload.value;
        const daemon = this.currentDaemon(conn);
        if (!daemon) break;
        const sessions = this.validateDaemonResyncSessions(value.sessions);
        // 先整体验证、再推进 authority。否则一份超限/畸形高 epoch 快照虽不应生效，
        // 却会消耗合法 worker 后续要使用的 owner/epoch，形成控制面的持久拒绝服务。
        if (!sessions || !this.acceptDaemonResyncSnapshot(daemon, value.snapshotOwnerId, value.snapshotEpoch)) break;
        await this.reconcileDaemonSessions(daemon, sessions);
        break;
      }
      case "deviceP2pAnswerReport": {
        const daemon = this.currentDaemon(conn);
        if (daemon) this.handleDeviceP2pAnswerReport(daemon.info.daemonId, msg.payload.value);
        break;
      }
      // 中心发起的终端读/写回执（plan 091）：按 requestId 找到等待中的 tool 调用；找不到 = 已超时摘除。
      case "serverAgentResult": {
        const daemon = this.currentDaemon(conn);
        if (daemon) this.resolveAgentRequest(daemon, msg.payload.value);
        break;
      }
      case "relayHome": {
        const daemon = this.currentDaemon(conn);
        if (!daemon) break;
        const relayId = msg.payload.value.relayId;
        if (!config.relayNodes.some((node) => node.id === relayId)) {
          log.warn("daemon reported unknown home relay", { daemonId: daemon.info.daemonId, relayId });
          break;
        }
        if (daemon.homeRelayId !== relayId) {
          daemon.homeRelayId = relayId;
          log.info("daemon home relay changed", { daemonId: daemon.info.daemonId, relayId });
        }
        break;
      }
      case "localGatewayAnnounce": {
        const value = msg.payload.value;
        const daemon = this.currentDaemon(conn);
        if (daemon) {
          // gateway descriptor 是 daemon generation 的派生事实。若旧连接在 upsert 等锁时
          // 被新连接接管，旧 continuation 不能随后覆盖新 generation 已上报的 descriptor。
          await this.withDaemonGenerationGate(daemon.info.daemonId, async () => {
            if (!this.isCurrentDaemon(daemon)) return;
            await this.localControl.announce(daemon, value.gateway);
          });
        }
        break;
      }
      case "localGrantAck": {
        const value = msg.payload.value;
        const daemon = this.currentDaemon(conn);
        if (daemon) {
          // ACK 会改 durable grant state 并清 pending waiter；与连接替换线性化，避免旧
          // generation 的迟到 ACK 清掉新连接 restore 刚重装的控制动作。
          await this.withDaemonGenerationGate(daemon.info.daemonId, async () => {
            if (!this.isCurrentDaemon(daemon)) return;
            await this.localControl.grantAck(daemon, value);
          });
        }
        break;
      }
      case "sessionCatalog": {
        const daemon = this.currentDaemon(conn);
        if (daemon) await this.reconcileSessionCatalog(daemon, msg.payload.value);
        break;
      }
      case "sessionCheckpoint": {
        const value = msg.payload.value;
        const daemon = this.currentDaemon(conn);
        if (daemon) {
          // checkpoint upsert 是 durable write；不能让旧 generation 在 replacement 上线后才
          // 提交、又因事后 current 检查吞掉广播。与连接替换串行后只有完整发生或完整丢弃。
          await this.withDaemonGenerationGate(daemon.info.daemonId, async () => {
            if (!this.isCurrentDaemon(daemon)) return;
            await this.acceptSessionCheckpoint(daemon, value);
          });
        }
        break;
      }
      case "sessionAgents": {
        const daemon = this.currentDaemon(conn);
        if (daemon) this.acceptSessionAgents(daemon, msg.payload.value.sessions);
        break;
      }
      case "agentControlRequest": {
        const daemon = this.currentDaemon(conn);
        if (daemon) await this.handleAgentControl(daemon, msg.payload.value);
        break;
      }
      case "preparedDeviceOperationInstalled": {
        const value = msg.payload.value;
        const daemon = this.currentDaemon(conn);
        if (daemon) {
          // installed ack 会改 durable state，并清 retry/waiter。整段与 connection swap 共用
          // generation gate，防旧连接的迟到 continuation 清掉新连接 restore 刚建的 timer，
          // 或用旧代际成功/失败错误放行、拒绝 client。
          await this.withDaemonGenerationGate(daemon.info.daemonId, async () => {
            if (!this.isCurrentDaemon(daemon)) return;
            await this.preparedOperations.handleInstalled(
              daemon,
              value.operationId,
              value.ok,
              value.error,
            );
          });
        }
        break;
      }
      case "deviceOperationReport": {
        const value = msg.payload.value;
        const daemon = this.currentDaemon(conn);
        if (daemon) {
          // report 的 convergence 会提交 project/workspace/task durable effect。整段与
          // connection swap 共用 gate：旧连接要么在仍为 current 时完整提交并发布，要么
          // 排在 replacement 后被丢弃，不能出现「DB 已改、广播被 current 检查吞掉」的半态。
          await this.withDaemonGenerationGate(daemon.info.daemonId, async () => {
            if (!this.isCurrentDaemon(daemon)) return;
            await this.handleDeviceOperationReport(daemon, value);
          });
        }
        break;
      }
      // worker 观测到 worktree HEAD 变化：分支真相源在设备侧，DB 只做镜像 + 广播
      case "workspaceBranch": {
        const value = msg.payload.value;
        const daemon = this.currentDaemon(conn);
        if (!daemon) return;
        await this.withWorkspaceEffectGuard(value.workspaceId, async (workspaceEffectGuard) => {
          await this.withDaemonGenerationGate(daemon.info.daemonId, async () => {
            if (!this.isCurrentDaemon(daemon) || workspaceEffectGuard.cancelled) return;
            const ws = await this.store.getWorkspace(value.workspaceId);
            if (!ws || ws.accountId !== daemon.accountId || ws.daemonId !== daemon.info.daemonId) return;
            const branch = value.branch.trim();
            if (!branch || branch === ws.branch) return;
            // 未起名（name === 旧 branch）时 name 跟随新分支，保持"未命名"语义
            const updated = await this.store.updateWorkspaceBranch(ws.id, branch, ws.name === ws.branch);
            if (!this.isCurrentDaemon(daemon) || workspaceEffectGuard.cancelled || !updated) return;
            this.broadcast(updated.accountId, { case: "workspaceCreated", value: { workspace: updated } });
          });
        });
        break;
      }
      // worker 周期计算的 git diff 累计统计：真相源在设备侧，DB 只做镜像 + 广播（同 workspaceBranch 形态）
      case "workspaceDiff": {
        const value = msg.payload.value;
        const daemon = this.currentDaemon(conn);
        if (!daemon) return;
        await this.withWorkspaceEffectGuard(value.workspaceId, async (workspaceEffectGuard) => {
          await this.withDaemonGenerationGate(daemon.info.daemonId, async () => {
            if (!this.isCurrentDaemon(daemon) || workspaceEffectGuard.cancelled) return;
            const ws = await this.store.getWorkspace(value.workspaceId);
            if (!ws || ws.accountId !== daemon.accountId || ws.daemonId !== daemon.info.daemonId) return;
            if (value.additions === ws.additions && value.deletions === ws.deletions) return;
            const updated = await this.store.updateWorkspaceDiff(ws.id, value.additions, value.deletions);
            if (!this.isCurrentDaemon(daemon) || workspaceEffectGuard.cancelled || !updated) return;
            this.broadcast(updated.accountId, { case: "workspaceCreated", value: { workspace: updated } });
          });
        });
        break;
      }
      // worker 核对本地 origin/HEAD 后上报的项目默认分支纠正（plan 072）：真相在设备侧，DB 是缓存。
      // 同一 project 的多个工作区会各报一次（refs/remotes 为 worktree 共享），靠这里比对现值幂等吸收。
      // 落库后必须重推清单——否则 worker 手里仍是旧值，diff_stat 会继续按错基准算。
      case "workspaceDefaultBranch": {
        const value = msg.payload.value;
        const daemon = this.currentDaemon(conn);
        if (!daemon) return;
        await this.withWorkspaceEffectGuard(value.workspaceId, async (workspaceEffectGuard) => {
          await this.withDaemonGenerationGate(daemon.info.daemonId, async () => {
            if (!this.isCurrentDaemon(daemon) || workspaceEffectGuard.cancelled) return;
            const ws = await this.store.getWorkspace(value.workspaceId);
            if (!ws || ws.accountId !== daemon.accountId || ws.daemonId !== daemon.info.daemonId) return;
            const defaultBranch = value.defaultBranch.trim();
            if (!defaultBranch) return;
            const project = await this.store.getProject(ws.projectId);
            // project 归属独立校验：这条消息是跨实体写入（workspace → project），不能只靠 workspace 的守卫
            if (
              !project ||
              project.accountId !== daemon.accountId ||
              project.daemonId !== daemon.info.daemonId ||
              project.defaultBranch === defaultBranch
            ) return;
            await this.withProjectEffectGuard(project.id, async (projectEffectGuard) => {
              if (workspaceEffectGuard.cancelled || projectEffectGuard.cancelled) return;
              const updated = await this.store.updateProjectDefaultBranch(project.id, defaultBranch);
              if (
                !this.isCurrentDaemon(daemon) ||
                workspaceEffectGuard.cancelled ||
                projectEffectGuard.cancelled ||
                !updated
              ) return;
              this.broadcast(updated.accountId, { case: "projectCreated", value: { project: updated } });
              await this.pushWorkspaceList(daemon.info.daemonId, daemon);
            });
          });
        });
        break;
      }
      case "sessionStarted": {
        const value = msg.payload.value;
        const daemon = this.currentDaemon(conn);
        if (!daemon) return;
        await this.withTaskEffectGuard(value.taskId, async (effectGuard) => {
          await this.withDaemonGenerationGate(daemon.info.daemonId, async () => {
            if (!this.isCurrentDaemon(daemon)) return;
            const current = this.sessions.get(value.sessionId);
            if (
              current &&
              !this.sessionHasIdentity(
                value.sessionId,
                value.taskId,
                daemon.accountId,
                daemon.info.daemonId,
              )
            ) return;
            const updated = await this.store.runTaskIfSession(
              value.taskId,
              daemon.accountId,
              daemon.info.daemonId,
              value.sessionId,
            );
            if (!this.isCurrentDaemon(daemon) || !updated || effectGuard.cancelled) return;
            const runtimeAfterUpdate = this.sessions.get(value.sessionId);
            if (
              runtimeAfterUpdate &&
              !this.sessionHasIdentity(
                value.sessionId,
                value.taskId,
                daemon.accountId,
                daemon.info.daemonId,
              )
            ) return;
            // generation/guard/runtime 复核与广播之间无 await。
            this.emitTask(updated);
            log.info("session started", { sessionId: value.sessionId, taskId: value.taskId, pid: value.pid });
          });
        });
        break;
      }
      case "sessionExit": {
        const value = msg.payload.value;
        const daemon = this.currentDaemon(conn);
        if (!daemon) return;
        const s = this.sessions.get(value.sessionId);
        if (s && (s.daemonId !== daemon.info.daemonId || s.accountId !== daemon.accountId)) return;
        // legacy/pidless 恢复路径没有 taskId，不能再按裸 sessionId 猜测当前绑定。新 worker
        // 会通过带 taskId 的 catalog tombstone 收敛；这里 fail-closed 优先于误杀换代后的新任务。
        if (!s) {
          log.warn("session exit 缺少运行时任务身份，已忽略", {
            daemonId: daemon.info.daemonId,
            sessionId: value.sessionId,
          });
          return;
        }
        // 冻结收到事件时的 taskId，并把 current-generation 复核、DB autocommit 与内存清理
        // 都收进同一 gate。后继连接不能在 UPDATE 等锁时先接管、再重用同一 sessionId。
        await this.withTaskEffectGuard(s.taskId, async (effectGuard) => {
          await this.withDaemonGenerationGate(daemon.info.daemonId, async () => {
            if (!this.isCurrentDaemon(daemon)) return;
            const updated = await this.store.exitTaskIfSession(
              s.taskId,
              daemon.accountId,
              daemon.info.daemonId,
              value.sessionId,
              value.exitCode,
            );
            if (!this.isCurrentDaemon(daemon)) return;
            const ownsRuntime = this.sessionHasIdentity(
              value.sessionId,
              s.taskId,
              daemon.accountId,
              daemon.info.daemonId,
            );
            // taskRemove 已提交或同 ID 已换成新 task 时，旧 RETURNING 不得对外可见。
            // guard/identity 检查与 emit/drop 之间无 await，不会再插入一条删除广播。
            if (!updated || effectGuard.cancelled || !ownsRuntime) return;
            this.emitTask(updated);
            this.dropSession(value.sessionId);
            this.taskExitCompletions.resolve(s.taskId, { case: "exited", exitCode: value.exitCode });
            log.info("session exit", { sessionId: value.sessionId, taskId: s.taskId, exitCode: value.exitCode });
          });
        });
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

  private acceptDaemonResyncSnapshot(daemon: DaemonConn, ownerId: string, epoch: bigint): boolean {
    const daemonId = daemon.info.daemonId;
    const current = this.daemonResyncAuthorities.get(daemonId);
    // legacy 只在本 Hub 尚未见过该设备的新 authority 时兼容。一旦 owner/epoch 建立，默认值
    // 不能绕过单调检查；旧 worker 回滚需等 server/Hub 重启，不接受同生命周期内降级。
    if (!ownerId && epoch === 0n) return current === undefined;
    if (!validControlId(ownerId) || epoch === 0n) return false;
    if (!current) {
      this.daemonResyncAuthorities.set(daemonId, { ownerId, epoch, retiredOwnerIds: new Set() });
      return true;
    }
    if (current.ownerId === ownerId) {
      if (epoch <= current.epoch) return false;
      current.epoch = epoch;
      return true;
    }
    if (current.retiredOwnerIds.has(ownerId)) return false;
    if (current.retiredOwnerIds.size >= MAX_RETIRED_RESYNC_OWNERS) return false;
    current.retiredOwnerIds.add(current.ownerId);
    current.ownerId = ownerId;
    current.epoch = epoch;
    return true;
  }

  /** daemon.resync 也受完整 catalog 同级的资源边界约束。任何非法 ID、条数/累计字节超限
   * 或一对多冲突都拒绝整份快照；完全重复项去重后才允许逐条查库。不能 slice 截断，
   * 因为 resync 表达的是完整存活集合，把前缀误当全量会制造错误的 authority 事实。 */
  private validateDaemonResyncSessions(
    alive: readonly { sessionId: SessionId; taskId: TaskId }[],
  ): { sessionId: SessionId; taskId: TaskId }[] | undefined {
    if (alive.length > MAX_CATALOG_ENTRIES) return undefined;
    const sessionToTask = new Map<SessionId, TaskId>();
    const taskToSession = new Map<TaskId, SessionId>();
    const valid: { sessionId: SessionId; taskId: TaskId }[] = [];
    let retainedBytes = 0;
    for (const entry of alive) {
      if (!entry || !validControlId(entry.sessionId) || !validControlId(entry.taskId)) return undefined;
      const entryBytes = Buffer.byteLength(entry.sessionId, "utf8") + Buffer.byteLength(entry.taskId, "utf8") + 64;
      if (retainedBytes > MAX_RETAINED_CATALOG_BYTES - entryBytes) return undefined;
      retainedBytes += entryBytes;

      const priorTask = sessionToTask.get(entry.sessionId);
      const priorSession = taskToSession.get(entry.taskId);
      if (priorTask !== undefined || priorSession !== undefined) {
        if (priorTask !== entry.taskId || priorSession !== entry.sessionId) return undefined;
        continue;
      }
      sessionToTask.set(entry.sessionId, entry.taskId);
      taskToSession.set(entry.taskId, entry.sessionId);
      valid.push(entry);
    }
    return valid;
  }

  private async reconcileDaemonSessions(daemon: DaemonConn, alive: readonly { sessionId: SessionId; taskId: TaskId }[]): Promise<void> {
    const daemonId = daemon.info.daemonId;
    const accountId = daemon.accountId;
    for (const { sessionId, taskId } of alive) {
      await this.withTaskEffectGuard(taskId, async (effectGuard) => {
        await this.withDaemonGenerationGate(daemonId, async () => {
          if (!this.isCurrentDaemon(daemon) || effectGuard.cancelled) return;
          const task = await this.store.getTask(taskId);
          if (!this.isCurrentDaemon(daemon) || effectGuard.cancelled) return;
          // resync 只重挂中心已绑定到同一 session 的 task；unknown/mismatched live PTY 是 local
          // orphan。EXITED 已清空 sessionId，是不可逆 exit fact，任何旧/新快照都不能将其复活。
          if (!task || task.accountId !== accountId || task.daemonId !== daemonId) return;
          if (task.sessionId !== sessionId) return;
          let updated: Task | undefined;
          if (task.status !== TaskStatus.RUNNING) {
            // agent terminal 在 session.create 发出前会以 IDLE+预绑定 sessionId 落库；只允许这个
            // 同一绑定经 CAS 转 RUNNING。若 exit 已清空绑定，CAS 必败，消除 exit/resync 竞态复活。
            updated = await this.store.runTaskIfSession(taskId, accountId, daemonId, sessionId);
            if (!this.isCurrentDaemon(daemon) || !updated || effectGuard.cancelled) return;
          }
          // guard/current 复核、旧 incarnation route 释放、mapping 与 emit 之间无 await。
          this.installSessionRuntime(sessionId, taskId, accountId, daemonId);
          if (updated) this.emitTask(updated);
        });
      });
      if (!this.isCurrentDaemon(daemon)) return;
    }
    // absence 不是 exit 事实；退出只由 sessiond tombstone/sessionExit 收敛。
    log.debug("daemon resync", { daemonId, live: alive.length });
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

  /** 端口转发版 proxy.issueAuth：校验 redirect 的 host 命中 <shortId>-<proxyHost> 且该 shortId
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
  private sessionHasIdentity(
    sessionId: SessionId,
    taskId: TaskId,
    accountId: AccountId,
    daemonId: DaemonId,
  ): boolean {
    const current = this.sessions.get(sessionId);
    return current?.taskId === taskId && current.accountId === accountId && current.daemonId === daemonId;
  }

  /** 安装 live runtime identity。同账号/设备内同 sessionId 换 task 表示新 incarnation；先经
   * dropSession 释放旧 task 的端口 route/隧道并广播清零，再挂新 task。跨账号/设备冲突
   * fail-closed，不能让一台 daemon 覆盖另一主体的全局 sessionId。 */
  private installSessionRuntime(
    sessionId: SessionId,
    taskId: TaskId,
    accountId: AccountId,
    daemonId: DaemonId,
  ): boolean {
    const current = this.sessions.get(sessionId);
    if (current && (current.accountId !== accountId || current.daemonId !== daemonId)) return false;
    if (current && current.taskId !== taskId) this.dropSession(sessionId);
    this.sessions.set(sessionId, { sessionId, taskId, accountId, daemonId });
    return true;
  }

  private dropSession(sessionId: SessionId): void {
    const s = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    const released = this.routeTable.releaseSession(sessionId);
    if (!released) return;
    for (const shortId of released.shortIds) this.tunnels.closeAllForShortId(shortId);
    if (s) this.broadcastPorts(s.accountId, released.taskId);
  }

  async handleDaemonClose(conn: DaemonCtx, close?: { code: number; reason: string }): Promise<void> {
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
    await this.withDaemonGenerationGate(daemonId, async () => {
      if (this.shuttingDown) return;
      const current = this.daemons.get(daemonId);
      if (!current || current.ws !== conn.ws) return;

      this.daemons.delete(daemonId);
      this.catalog.delete(daemonId);
      // 中心发起的操作/读写请求随连接一起失去回执来源（plan 091）：以可读错误唤醒，不让 tool 白等。
      this.failDaemonWaiters(daemonId, "daemon 连接已断开，请稍后重试或用 list_* 查看结果");
      // agent presence 是在线连接的派生事实：daemon 断开即清空并广播，防琥珀点残留（plan 073）
      if (this.sessionAgents.delete(daemonId)) {
        this.broadcast(accountId, { case: "sessionAgentsUpdated", value: { daemonId, sessions: [] } });
      }
      // close 清理也持 generation gate：后继连接只能在 lease/route/offline 广播全部收口后上线，
      // 避免旧 close continuation 在新连接 online 之后撤销新 lease 或补发 offline。
      await this.localControl.daemonDisconnected(daemonId);
      if (this.shuttingDown) return;
      // 端口转发：daemon 掉线即所有隧道失联，摘路由表 + 关在途连接（this.sessions 本身按既有设计不动，
      // 留给 daemon.resync 重连后自愈；shortId 会在重连后 ports.update 时重新签发，见 plan 006）。
      const releasedRoutes = this.routeTable.releaseDaemon(daemonId);
      this.tunnels.closeAllForDaemon(daemonId);
      for (const r of releasedRoutes) this.broadcastPorts(accountId, r.taskId);
      await this.store.touchDevice(daemonId, Date.now());
      if (this.shuttingDown) return;
      log.info("daemon disconnected", {
        daemonId,
        code: close?.code ?? 0,
        reason: close?.reason ?? "",
      });

      const device = await this.store.getDevice(daemonId);
      if (this.shuttingDown) return;
      if (device && !device.revoked) {
        this.broadcast(accountId, { case: "daemonUpdated", value: { daemon: { daemonId, name: device.name, host: device.host, platform: device.platform, online: false, workerVersion: "", supervisorVersion: "" } } });
      } else {
        this.broadcast(accountId, { case: "daemonRemoved", value: { daemonId } });
      }
    });
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
        if (client.subscribed) return;
        // 查询前先进入“已订阅但缓冲广播”态：跨连接提交若早于某张表的 SELECT，快照会包含它；
        // 若晚于 SELECT，对应广播会进 backlog。快照发完后顺序回放，允许幂等重复但不永久丢事件。
        const backlog = { frames: [] as Uint8Array[], bytes: 0, overflowed: false };
        client.snapshotBacklog = backlog;
        client.subscribed = true;
        this.clients.add(client);
        let daemons: DaemonInfoData[];
        let projects: Project[];
        let workspaces: Workspace[];
        let tasks: Task[];
        let checkpoints: SessionCheckpointRecord[];
        try {
          [daemons, projects, workspaces, tasks, checkpoints] = await Promise.all([
            this.daemonInfoList(accountId),
            this.store.listProjects(accountId),
            this.store.listWorkspaces(accountId),
            this.store.listTasks(accountId),
            this.store.listSessionCheckpoints(accountId),
          ]);
        } catch (error) {
          client.snapshotBacklog = undefined;
          client.subscribed = false;
          this.clients.delete(client);
          throw error;
        }
        if (backlog.overflowed) return;
        this.sendClientNow(client, { case: "stateSnapshot", value: { daemons, projects, workspaces, tasks, ports: this.allPorts(accountId) } });
        for (const checkpoint of checkpoints) this.sendCheckpoint(client, checkpoint, true);
        // agent presence 补发（plan 073）：client 的 stateSnapshot handler 会清空本地 presence，
        // 这里按设备补发当前全量——顺序在快照之后、与 checkpoint 同批，天然落在乱序防护序列内。
        for (const [daemonId, entry] of this.sessionAgents) {
          if (entry.accountId === accountId) this.sendClientNow(client, { case: "sessionAgentsUpdated", value: { daemonId, sessions: entry.sessions } });
        }
        try {
          // ready prepared 列表也必须跨 complete 稳定：查询和投递都收进 service 的同一代际，
          // 避免 Promise.all 先拿到旧 installed 记录、report 完成后又把它发给 client 执行。
          await this.preparedOperations.sendReadyToClient(client, accountId, true);
        } catch (error) {
          client.snapshotBacklog = undefined;
          client.subscribed = false;
          this.clients.delete(client);
          throw error;
        }
        // 上面的稳定查询引入了新的 await；期间 backlog 仍负责接住广播，但慢 client 可能已被
        // 硬上限关闭，close handler 也可能已摘掉本次 snapshot identity。
        if (backlog.overflowed || client.snapshotBacklog !== backlog) return;
        client.snapshotBacklog = undefined;
        for (const frame of backlog.frames) {
          if (!this.sendWs(client.ws, frame, "client")) break;
        }
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
      case "deviceP2pOffer": {
        this.handleDeviceP2pOffer(client, msg.payload.value);
        break;
      }
      case "deviceP2pChannelOpen": {
        this.handleDeviceP2pChannelOpen(client, msg.payload.value);
        break;
      }
      case "clientRemoveDevice": {
        await this.removeDevice(client, msg.payload.value.daemonId);
        break;
      }
      case "oauthAuthorizeInfo": {
        // OAuth 确认页查询（plan 090）：与 device.authorizeInfo 同一套失败计数——请求 id 是 ≥128bit
        // 随机值，限速是纵深防御。
        if ((client.authorizeFailures ?? 0) >= config.authorizeMaxFailures) {
          this.sendClient(client, { case: "oauthAuthorizeInfo", value: { ok: false, error: "尝试次数过多，请回到宿主重新发起授权" } });
          break;
        }
        const info = this.oauth.describePending(msg.payload.value.requestId);
        if (!info) {
          client.authorizeFailures = (client.authorizeFailures ?? 0) + 1;
          this.sendClient(client, { case: "oauthAuthorizeInfo", value: { ok: false, error: "授权请求无效或已过期，请回到宿主重新发起授权" } });
          break;
        }
        this.sendClient(client, { case: "oauthAuthorizeInfo", value: { ok: true, clientName: info.clientName, redirectHost: info.redirectHost, scope: info.scope } });
        break;
      }
      case "oauthAuthorizeDecide": {
        if ((client.authorizeFailures ?? 0) >= config.authorizeMaxFailures) {
          this.sendClient(client, { case: "oauthAuthorizeResult", value: { ok: false, error: "尝试次数过多，请回到宿主重新发起授权" } });
          break;
        }
        // userId 可得时（password 模式）随凭证落库；local 模式为 null。
        const userId = client.tokenHash ? await this.store.userIdForClientToken(client.tokenHash) : null;
        const result = this.oauth.decide(msg.payload.value.requestId, msg.payload.value.approve, { accountId: client.accountId!, userId });
        if (!result) {
          client.authorizeFailures = (client.authorizeFailures ?? 0) + 1;
          this.sendClient(client, { case: "oauthAuthorizeResult", value: { ok: false, error: "授权请求无效或已过期，请回到宿主重新发起授权" } });
          break;
        }
        this.sendClient(client, { case: "oauthAuthorizeResult", value: { ok: true, redirectUrl: result.redirectUrl } });
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
        this.sendDaemon(d, {
          case: "workerUpgrade",
          value: {
            version: value.version,
            url: value.url,
            sha256: value.sha256,
            signature: value.signature,
            target: value.target,
            artifactSize: value.artifactSize,
            releaseSignature: value.releaseSignature,
          },
        });
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
        const frame = this.preparedOperations.createFrame(operationId, {
          case: "projectValidate",
          value: { requestId: operationId, operationId, path: value.path },
        });
        await this.preparedOperations.prepare(client, {
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
        const sessionCloses: { sessionId: SessionId; taskId: TaskId }[] = [];
        for (const ws of workspaces) {
          for (const task of await this.store.listTasksByWorkspace(ws.id)) {
            if (task.sessionId) sessionCloses.push({ sessionId: task.sessionId, taskId: task.id });
          }
        }
        for (const { sessionId, taskId } of sessionCloses) {
          if (!this.sessionHasIdentity(sessionId, taskId, project.accountId, project.daemonId)) continue;
          this.routeToSessionDaemon(sessionId, { case: "sessionClose", value: { sessionId } });
          this.dropSession(sessionId);
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
        const frame = this.preparedOperations.createFrame(operationId, {
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
        await this.preparedOperations.prepare(client, {
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
      case "terminalCreate": {
        // 无 repo 的目录工作区（projectId 为空即目录工作区）+ 一个任务；path 是 daemon 侧
        // FsListed 回传的 HOME 绝对路径，无 git 语义可校验，直接落库、不走 prepared operation。
        const value = msg.payload.value;
        const d = this.daemons.get(value.daemonId);
        if (!d || d.accountId !== client.accountId) {
          this.sendClient(client, { case: "error", value: { message: "daemon 不在线或不属于本账号" } });
          return;
        }
        if (!value.path.trim()) {
          this.sendClient(client, { case: "error", value: { message: "终端目录路径为空" } });
          return;
        }
        // 幂等（plan 048）：每设备最多一个目录工作区。用稳定的 device 父行锁把所有当前
        // terminalCreate 写路径串行化；锁后重查 canonical，避免多个 client 同时首次创建。
        // DB 的 uq_workspaces_directory_device 是最终防线；正常并发不应靠撞约束收敛。
        const taskId = randomUUID();
        await this.withDeviceEffectGuard(value.daemonId, async (effectGuard) => {
          await this.withTaskEffectGuard(taskId, async (taskEffectGuard) => {
            const result = await this.store.transaction(async (tx) => {
              const device = await tx.claimActiveDevice(value.daemonId, client.accountId!);
              if (!device) return { error: "daemon 不存在、已撤销或不属于本账号" } as const;

              let workspace = (await tx.listWorkspacesByDaemon(value.daemonId))
                .filter((candidate) => candidate.accountId === client.accountId && isDirWorkspace(candidate))
                .sort((left, right) => left.createdAt - right.createdAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))[0];
              let createdWorkspace = false;
              const ts = Date.now();
              if (!workspace) {
                workspace = create(WorkspaceSchema, {
                  id: randomUUID(),
                  accountId: client.accountId!,
                  daemonId: value.daemonId,
                  projectId: "",
                  name: "~",
                  path: value.path,
                  branch: "",
                  isMain: false,
                  createdAt: ts,
                });
                await tx.createWorkspace(workspace);
                createdWorkspace = true;
              }
              const task: Task = create(TaskSchema, { id: taskId, accountId: workspace.accountId, daemonId: workspace.daemonId, projectId: "", workspaceId: workspace.id, title: "终端", status: TaskStatus.IDLE, createdAt: ts, updatedAt: ts });
              await tx.createTask(task);
              return { workspace, task, createdWorkspace } as const;
            });
            if ("error" in result) {
              this.sendClient(client, { case: "error", value: { message: result.error } });
              return;
            }
            if (effectGuard.cancelled) {
              this.sendClient(client, { case: "error", value: { message: "设备已删除，终端创建已取消" } });
              return;
            }
            if (taskEffectGuard.cancelled) {
              this.sendClient(client, { case: "error", value: { message: "工作区或任务已删除，终端创建已取消" } });
              return;
            }
            // guard 复核、workspace/task 广播之间无 await。
            if (result.createdWorkspace) {
              this.broadcast(result.workspace.accountId, { case: "workspaceCreated", value: { workspace: result.workspace } });
            }
            this.emitTask(result.task);
            if (result.createdWorkspace) await this.pushWorkspaceList(result.workspace.daemonId);
          });
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
        if (isDirWorkspace(ws)) {
          await this.removeDirWorkspace(ws);
          return;
        }
        const project = await this.store.getProject(ws.projectId);
        if (!project || project.daemonId !== ws.daemonId) return;
        if (!this.daemons.has(ws.daemonId)) return void this.sendClient(client, { case: "error", value: { message: "daemon 不在线" } });
        await this.closeWorkspaceSessions(ws);
        await this.prepareWorktreeRemoval(client, project, ws, false);
        break;
      }
      case "workspaceSetName": {
        const value = msg.payload.value;
        await this.renameWorkspace(client.accountId!, value.workspaceId, value.name);
        break;
      }
      case "projectSetName": {
        const value = msg.payload.value;
        await this.withProjectEffectGuard(value.projectId, async (projectEffectGuard) => {
          const project = await this.store.getProject(value.projectId);
          if (!project || project.accountId !== client.accountId || projectEffectGuard.cancelled) return;
          // 空名拒绝（同 deviceSetName）；复用 projectCreated 广播（web 侧为 upsert），无需新增下行消息
          const trimmed = value.name.trim();
          if (!trimmed) return;
          const updated = await this.store.updateProjectName(project.id, trimmed);
          if (!updated || projectEffectGuard.cancelled) return;
          this.broadcast(updated.accountId, { case: "projectCreated", value: { project: updated } });
        });
        break;
      }
      case "deviceSetName": {
        const value = msg.payload.value;
        await this.withDeviceEffectGuard(value.daemonId, async (deviceEffectGuard) => {
          const device = await this.store.getDevice(value.daemonId);
          if (!device || device.revoked || device.accountId !== client.accountId || deviceEffectGuard.cancelled) return;
          // 空名拒绝；设备没有回落默认值
          const trimmedName = value.name.trim();
          if (!trimmedName) return;
          const updated = await this.store.updateDeviceName(device.id, trimmedName);
          if (!updated || deviceEffectGuard.cancelled) return;
          this.broadcast(updated.accountId, { case: "daemonUpdated", value: { daemon: { daemonId: updated.id, name: updated.name, host: updated.host, platform: updated.platform, online: this.isDaemonOnline(updated.id), workerVersion: "", supervisorVersion: "" } } });
          // 若设备当前在线，更新内存并即时下发
          const d = this.daemons.get(updated.id);
          if (d) {
            d.info.name = trimmedName;
            this.sendDaemon(d, { case: "daemonSetName", value: { name: trimmedName } });
          }
        });
        break;
      }
      case "taskCreate": {
        const value = msg.payload.value;
        const initialWorkspace = await this.store.getWorkspace(value.workspaceId);
        if (!initialWorkspace || initialWorkspace.accountId !== client.accountId) {
          this.sendClient(client, { case: "error", value: { message: "工作区不存在或不属于本账号" } });
          return;
        }
        const taskId = randomUUID();
        await this.withDeviceEffectGuard(initialWorkspace.daemonId, async (effectGuard) => {
          await this.withTaskEffectGuard(taskId, async (taskEffectGuard) => {
            const outcome = await this.store.transaction(async (tx) => {
              const initial = await tx.getWorkspace(value.workspaceId);
              if (
                !initial ||
                initial.accountId !== client.accountId ||
                initial.daemonId !== initialWorkspace.daemonId
              ) return { error: "工作区不存在或已变更" } as const;
              // 与 removeDevice、目录 workspaceRemove、terminalCreate 共用 device 父行锁；锁后重读
              // workspace，防删除方已读完子项后本事务又插入孤儿 task。
              const device = await tx.claimActiveDevice(initial.daemonId, initial.accountId);
              if (!device) return { error: "daemon 不存在、已撤销或不属于本账号" } as const;
              const ws = await tx.getWorkspace(value.workspaceId);
              if (!ws || ws.accountId !== initial.accountId || ws.daemonId !== initial.daemonId) {
                return { error: "工作区已被删除" } as const;
              }
              // 目录工作区没有 project 可检查
              if (!isDirWorkspace(ws)) {
                const project = await tx.claimActiveProject(ws.projectId);
                if (!project || project.accountId !== ws.accountId || project.daemonId !== ws.daemonId) {
                  return { error: "项目正在删除，不能再创建任务" } as const;
                }
              }
              const ts = Date.now();
              const task: Task = create(TaskSchema, { id: taskId, accountId: ws.accountId, daemonId: ws.daemonId, projectId: ws.projectId, workspaceId: ws.id, title: value.title || "未命名任务", status: TaskStatus.IDLE, createdAt: ts, updatedAt: ts });
              await tx.createTask(task);
              return { task } as const;
            });
            if ("error" in outcome) {
              this.sendClient(client, { case: "error", value: { message: outcome.error } });
              return;
            }
            if (effectGuard.cancelled) {
              this.sendClient(client, { case: "error", value: { message: "设备已删除，任务创建已取消" } });
              return;
            }
            if (taskEffectGuard.cancelled) {
              this.sendClient(client, { case: "error", value: { message: "工作区或任务已删除，任务创建已取消" } });
              return;
            }
            // guard 复核与 taskUpdated 之间无 await。
            this.emitTask(outcome.task);
          });
        });
        break;
      }
      case "taskStart": {
        const value = msg.payload.value;
        await this.startOrAttachTask(client, value.taskId, value.cols, value.rows);
        break;
      }
      case "taskRemove": {
        const initial = await this.requireTask(client, msg.payload.value.taskId);
        if (!initial) return;
        await this.removeTaskRecord(initial, false);
        break;
      }
    }
  }

  /* ==================== 工作区 / 任务的共享写路径（web 与 MCP 同一逻辑，plan 091） ==================== */

  /** 目录工作区：只删记录，绝不进入 worktree.remove（不能对 HOME 跑 git worktree 操作），
   * daemon 离线也可删。与 terminalCreate/taskCreate/removeDevice 共用 device 父行锁，
   * 锁后重读并在同一事务内删除全部子项，防并发创建留下 orphan。返回是否真的删掉。 */
  private async removeDirWorkspace(ws: Workspace): Promise<boolean> {
    const removed = await this.store.transaction(async (tx) => {
      const device = await tx.claimActiveDevice(ws.daemonId, ws.accountId);
      if (!device) return undefined;
      const current = await tx.getWorkspace(ws.id);
      if (
        !current ||
        current.accountId !== ws.accountId ||
        current.daemonId !== ws.daemonId ||
        current.isMain ||
        !isDirWorkspace(current)
      ) return undefined;
      const removedTaskIds = await tx.removeTasksByWorkspace(current.id);
      const cancelledPreparedOperationIds: string[] = [];
      const now = Date.now();
      for (const taskId of removedTaskIds) {
        cancelledPreparedOperationIds.push(...await tx.expirePreparedOperationsByTarget(
          current.accountId,
          current.daemonId,
          "session.create",
          taskId,
          now,
        ));
        await tx.removeSessionCheckpointsByTask(taskId);
      }
      await tx.removeWorkspace(current.id);
      return { workspace: current, removedTaskIds, cancelledPreparedOperationIds };
    });
    if (!removed) return false;
    this.cancelWorkspaceEffects(removed.workspace.id);
    this.retireTaskRuntimes(
      removed.removedTaskIds,
      removed.workspace.accountId,
      removed.workspace.daemonId,
      true,
    );
    this.preparedOperations.cancelMany(
      removed.cancelledPreparedOperationIds,
      "工作区已删除，session.create 已取消",
    );
    for (const taskId of removed.removedTaskIds) this.broadcast(removed.workspace.accountId, { case: "taskRemoved", value: { taskId } });
    this.broadcast(removed.workspace.accountId, { case: "workspaceRemoved", value: { workspaceId: removed.workspace.id } });
    await this.pushWorkspaceList(removed.workspace.daemonId);
    return true;
  }

  /** 删 worktree 工作区前先关掉其下所有会话（sessionClose 直发 + 摘运行时），与 projectRemove 同一条。 */
  private async closeWorkspaceSessions(ws: Workspace): Promise<void> {
    const sessionCloses = (await this.store.listTasksByWorkspace(ws.id))
      .flatMap((task) => task.sessionId ? [{ sessionId: task.sessionId, taskId: task.id }] : []);
    for (const { sessionId, taskId } of sessionCloses) {
      if (!this.sessionHasIdentity(sessionId, taskId, ws.accountId, ws.daemonId)) continue;
      this.routeToSessionDaemon(sessionId, { case: "sessionClose", value: { sessionId } });
      this.dropSession(sessionId);
    }
  }

  /** 改名（纯中心记录）：空名回落分支名；复用 workspaceCreated 广播（web 侧为 upsert），无需新增下行消息。
   * 主工作区也可改名。返回更新后的工作区；不存在/不属于账号/已删除返回 undefined。 */
  private async renameWorkspace(accountId: AccountId, workspaceId: WorkspaceId, name: string): Promise<Workspace | undefined> {
    return await this.withWorkspaceEffectGuard(workspaceId, async (workspaceEffectGuard) => {
      const ws = await this.store.getWorkspace(workspaceId);
      if (!ws || ws.accountId !== accountId || workspaceEffectGuard.cancelled) return undefined;
      const updated = await this.store.updateWorkspaceName(ws.id, name.trim() || ws.branch);
      if (!updated || workspaceEffectGuard.cancelled) return undefined;
      this.broadcast(updated.accountId, { case: "workspaceCreated", value: { workspace: updated } });
      return updated;
    });
  }

  /** 删任务记录（含 checkpoint）：与 checkpoint/taskCreate/removeDevice 共用 device 父锁；锁后重读并在
   * 同一事务删 checkpoint + task，防迟到 checkpoint 在 taskRemove 后插回孤儿。web 由 UI 保证只删已退出的；
   * MCP 传 rejectRunning=true 在同一事务内拒绝仍在运行的终端（plan 091）。 */
  private async removeTaskRecord(initial: Task, rejectRunning: boolean): Promise<OperationOutcome<TaskId>> {
    const task = await this.store.transaction(async (tx) => {
      const device = await tx.claimActiveDevice(initial.daemonId, initial.accountId);
      if (!device) return { error: "设备已撤销或不属于本账号" } as const;
      const current = await tx.getTask(initial.id);
      if (
        !current ||
        current.accountId !== initial.accountId ||
        current.daemonId !== initial.daemonId
      ) return { error: "任务已不存在" } as const;
      if (rejectRunning && (current.status === TaskStatus.RUNNING || current.sessionId)) {
        return { error: "终端仍在运行，先 stop_terminal 再删除" } as const;
      }
      const cancelledPreparedOperationIds = await tx.expirePreparedOperationsByTarget(
        current.accountId,
        current.daemonId,
        "session.create",
        current.id,
        Date.now(),
      );
      await tx.removeSessionCheckpointsByTask(current.id);
      await tx.removeTask(current.id);
      return { task: current, cancelledPreparedOperationIds } as const;
    });
    if ("error" in task) return { ok: false, error: task.error };
    // 删除已提交：先取消旧 exit/catalog continuation，再按 task 完整身份摘运行时，
    // 最后广播 removed。catalog 可能在 taskRemove 锁后重读前已清空 DB session_id，
    // 所以不能只依赖返回 task.sessionId；内存映射仍保留可核对的 taskId。
    this.retireTaskRuntime(task.task.id, task.task.accountId, task.task.daemonId, true);
    this.preparedOperations.cancelMany(
      task.cancelledPreparedOperationIds,
      "任务已删除，session.create 已取消",
    );
    this.broadcast(task.task.accountId, { case: "taskRemoved", value: { taskId: task.task.id } });
    return { ok: true, value: task.task.id };
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
   *   1) clientToken 重连（两模式通用）——coflux 自持会话 token，全程不碰 users 表。
   *   2) 邮箱+密码（仅 password 模式）——查 users 表 → scrypt 校验 → 查/建 membership → 签发会话 token。
   *   3) env 用户名+密码（仅 local 模式）——单账号 default。
   * 非 string 的凭证字段自然落空 → auth.error（与既有 clientToken 类型校验一致严格）。
   */
  private async handleClientAuth(client: ClientConn, msg: ClientAuth): Promise<void> {
    const reject = (message: string, closeCode = 4001, closeReason = "bad credentials") => {
      this.sendClient(client, { case: "authError", value: { message } });
      try {
        client.ws.close(closeCode, closeReason);
      } catch {
        /* close handler 会清连接派生状态。 */
      }
    };
    const tokenAttempt = typeof msg.clientToken === "string" && msg.clientToken.length > 0;
    const limiter = tokenAttempt ? this.tokenAuthLimiter : this.loginLimiter;
    if (!limiter.allow(client.remoteAddress)) {
      const kind = tokenAttempt ? "client token" : "client 登录";
      log.warn(`${kind}触发来源限速`, { remoteAddress: client.remoteAddress });
      return void reject("登录尝试过于频繁，请稍后重试", 1013, "login rate limit");
    }
    if (typeof msg.username === "string" && typeof msg.password === "string") {
      if (
        !validBoundedText(msg.username, MAX_LOGIN_NAME_BYTES) ||
        !validBoundedText(msg.password, MAX_LOGIN_PASSWORD_BYTES, true, true)
      ) {
        return void reject("认证失败");
      }
    }
    if (typeof msg.clientToken === "string" && Buffer.byteLength(msg.clientToken, "utf8") > MAX_CLIENT_TOKEN_BYTES) {
      return void reject("认证失败");
    }

    const now = Date.now();
    let accountId: AccountId | undefined;
    let issued: string | undefined;
    let tokenHash: string | undefined;
    let userId: string | null = null;

    if (typeof msg.clientToken === "string" && msg.clientToken) {
      // 重连：已签发的会话 token（校验未撤销且未过期）
      tokenHash = hashToken(msg.clientToken);
      accountId = await this.store.accountForClientToken(tokenHash, now);
    } else if (config.authProvider === "password" && typeof msg.username === "string" && typeof msg.password === "string") {
      // 登录：邮箱（username 字段承载）+ 密码 → 查 users 表 → scrypt 校验 → 查/建个人账号 → 签发会话 token
      if (this.activePasswordChecks >= config.maxConcurrentPasswordChecks) {
        log.warn("password 校验达到并发上限", { limit: config.maxConcurrentPasswordChecks });
        return void reject("登录服务繁忙，请稍后重试", 1013, "password verification busy");
      }
      this.activePasswordChecks += 1;
      try {
        const email = msg.username.trim().toLowerCase();
        const user = email ? await this.store.getUserByEmail(email) : undefined;
        if (user && (await verifyPassword(msg.password, user.passwordHash))) {
          accountId = await this.resolveAccountForUser({ userId: user.id, email: user.email });
          userId = user.id;
          issued = genToken("ck_sess");
          tokenHash = hashToken(issued);
          await this.store.upsertClientToken(tokenHash, accountId, now, now + config.sessionTtlMs, userId);
        }
      } finally {
        this.activePasswordChecks -= 1;
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
      return void reject("认证失败");
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
    this.sendClient(client, { case: "authOk", value: { accountId, clientToken: issued, iceServers: config.stunUrls } });
  }

  /** 口令校验通过的合法用户：查已有个人账号，无则 lazy 建号 + owner membership。
   * 能通过口令校验 ⇒ 管理员用建号脚本亲手建的用户，故 lazy provision 安全（见 plans/001, 059）。 */
  private async resolveAccountForUser(identity: { userId: string; email: string | null }): Promise<AccountId> {
    // uq_memberships_user 固化个人账号 1:1；所有创建路径仍先锁稳定 users 父行并在锁后重查，
    // 让并发登录复用同一个 account，而不是把唯一冲突暴露给合法请求。
    const result = await this.store.transaction(async (tx) => {
      const user = await tx.claimUser(identity.userId);
      if (!user) throw new Error(`首次建号失败：用户已不存在（${identity.userId}）`);
      const existing = await tx.getMembershipByUser(identity.userId);
      if (existing) return { accountId: existing.accountId, created: false };
      const accountId = randomUUID();
      const now = Date.now();
      await tx.createAccount({ id: accountId, name: identity.email ?? identity.userId, createdAt: now });
      await tx.createMembership(identity.userId, accountId, "owner", now);
      return { accountId, created: true };
    });
    if (result.created) log.info("provisioned account for user", { accountId: result.accountId });
    return result.accountId;
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

    const fail = (message: string) => {
      log.warn("session.create 被拒", { daemonId: task.daemonId, taskId: task.id, reason: message });
      this.sendClient(client, { case: "error", value: { message } });
    };

    if (task.status === TaskStatus.RUNNING && task.sessionId) {
      return void fail("任务已在运行，请通过 DeviceTransport attach");
    }

    const d = this.daemons.get(task.daemonId);
    if (!d) return void fail(`daemon 不在线：${task.daemonId}`);
    const ws = await this.store.getWorkspace(task.workspaceId);
    if (!ws) return void fail("工作区已不存在");
    if (await this.store.isProjectDeleting(task.projectId)) {
      return void fail("项目正在删除，不能启动新 session");
    }

    const sessionId = randomUUID();
    const c = clampDim(cols, 80);
    const r = clampDim(rows, 24);
    const operationId = randomUUID();
    const frame = this.preparedOperations.createFrame(operationId, {
      case: "sessionCreate",
      value: { requestId: operationId, operationId, sessionId, taskId: task.id, cwd: ws.path, cols: c, rows: r },
    });
    await this.withTaskEffectGuard(task.id, async (effectGuard) => {
      await this.preparedOperations.prepare(client, {
        operationId,
        accountId: task.accountId,
        daemonId: task.daemonId,
        kind: "session.create",
        targetId: task.id,
        targetVersion: task.updatedAt,
        frame,
        metadata: JSON.stringify({ taskId: task.id, sessionId }),
        expiresAt: Date.now() + config.preparedOperationTtlMs,
      }, async (tx) => {
        // prepare 已持有 device 父行锁；在同一事务内重读 task/workspace/project，才能与
        // taskRemove/workspaceRemove 的删除和 prepared expiry 形成一个确定顺序。
        if (effectGuard.cancelled) return "任务或工作区已删除，session.create 已取消";
        const currentTask = await tx.getTask(task.id);
        if (
          !currentTask ||
          currentTask.accountId !== task.accountId ||
          currentTask.daemonId !== task.daemonId ||
          currentTask.workspaceId !== task.workspaceId
        ) return "任务已删除，不能启动 session";
        if (
          currentTask.status === TaskStatus.RUNNING ||
          currentTask.sessionId ||
          currentTask.updatedAt !== task.updatedAt
        ) return "任务状态已变化，请刷新后重试";
        const currentWorkspace = await tx.getWorkspace(currentTask.workspaceId);
        if (
          !currentWorkspace ||
          currentWorkspace.accountId !== task.accountId ||
          currentWorkspace.daemonId !== task.daemonId
        ) return "工作区已删除，不能启动 session";
        if (!isDirWorkspace(currentWorkspace)) {
          const project = await tx.claimActiveProject(currentWorkspace.projectId);
          if (
            !project ||
            project.accountId !== currentWorkspace.accountId ||
            project.daemonId !== currentWorkspace.daemonId
          ) return "项目正在删除，不能启动新 session";
        }
        return undefined;
      });
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
    const registered = await this.registerDaemonConn(
      p.conn,
      { daemonId, name: p.name, host: p.host, platform: p.platform, online: true, workerVersion: p.workerVersion, supervisorVersion: p.supervisorVersion },
      accountId,
      p.arch,
      p.capabilities,
      { case: "daemonEnrolled", value: { daemonId, deviceToken } },
    );
    if (!registered) {
      this.sendClient(client, {
        case: "deviceAuthorizeInfo",
        value: { ok: false, error: "设备在授权完成前已失效，请重新发起" },
      });
      return;
    }
    log.info("daemon authorized", { daemonId, name: p.name, host: p.host, accountId });
    this.sendClient(client, { case: "deviceAuthorized", value: {} });
  }

  /** relay rendezvous（plan 043）：校验归属 → 两端各签短时单次 token → 通知 daemon 拨号。
   * 校验语义沿用旧 DeviceRelayRouter.open；server 从此不持 channel 状态，channel 的
   * 生死由 relay 配对/两端 WS 收敛，断开即由 client 重新 rendezvous。 */
  private handleDeviceRelayConnect(client: ClientConn, request: DeviceRelayConnect): void {
    const fail = (error: string) => {
      log.warn("relay rendezvous 被拒", {
        daemonId: validRelayId(request.daemonId) ? request.daemonId : "<invalid>",
        channelId: validRelayId(request.channelId) ? request.channelId : "<invalid>",
        reason: error,
      });
      this.sendClient(client, { case: "deviceRelayGrant", value: { channelId: request.channelId, ok: false, error } });
    };

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
    if (config.relayNodes.length === 0) return void fail("中心未配置 relay 节点");
    if (!allowRendezvous(client)) return void fail("rendezvous 频率超限");

    const daemon = this.daemons.get(request.daemonId);
    if (!daemon || daemon.accountId !== client.accountId) return void fail("daemon 不在线或不属于本账号");
    if (!supportsRelayDial(daemon.info.workerVersion)) {
      return void fail(`设备 worker 版本过旧（${daemon.info.workerVersion}），不支持按需拨号；在该设备上运行 \`cofluxd update && cofluxd restart\` 后重试`);
    }

    const relayNode = selectRelayNode(config.relayNodes, daemon.homeRelayId);
    if (!relayNode) return void fail("中心未配置 relay 节点");
    const ttl = config.relayTokenTtlMs;
    this.sendDaemon(daemon, {
      case: "deviceRelayDial",
      value: {
        channelId: request.channelId,
        relayUrl: buildRelayPipeUrl(relayNode.url, this.relayTokens.sign(request.channelId, "daemon", ttl)),
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
        relayUrl: buildRelayPipeUrl(relayNode.url, this.relayTokens.sign(request.channelId, "client", ttl)),
      },
    });
  }

  /** P2P 信令（plan 076）：中心只做归属校验 + SDP 转发，不签 token、不持连接状态。
   * 唯一的短时状态是 answer 回程路由（connectionId → 发起 client），TTL 内未回即弃；
   * 中心重启丢 pending 只导致 client 超时回落 relay。 */
  private readonly p2pPending = new Map<string, { client: ClientConn; daemonId: DaemonId; at: number }>();

  private handleDeviceP2pOffer(client: ClientConn, request: DeviceP2pOffer): void {
    const fail = (error: string) => {
      log.warn("P2P 信令被拒", {
        daemonId: validRelayId(request.daemonId) ? request.daemonId : "<invalid>",
        connectionId: validRelayId(request.connectionId) ? request.connectionId : "<invalid>",
        reason: error,
      });
      this.sendClient(client, { case: "deviceP2pAnswer", value: { connectionId: request.connectionId, ok: false, error } });
    };

    // 总开关（config.p2pEnabled）：拒在信令入口，client 的 candidateDone("p2p", error) 会即刻
    // 触发 startRelay()，比等 15s 建连超时快得多。关掉时行为等价于 plan 076 上线前。
    if (!config.p2pEnabled) return void fail("P2P 直连已停用");
    if (!client.accountId) return void fail("client 未认证");
    if (
      request.protocolVersion !== DEVICE_PROTOCOL_VERSION ||
      !validRelayId(request.daemonId) ||
      !validRelayId(request.connectionId) ||
      request.connectionId.startsWith("__coflux-") ||
      !validRelayId(request.clientInstanceId) ||
      request.sdp.length === 0 ||
      request.sdp.length > 64 * 1024
    ) {
      return void fail("p2p connection/principal/version 无效");
    }
    if (!allowRendezvous(client)) return void fail("rendezvous 频率超限");

    const daemon = this.daemons.get(request.daemonId);
    if (!daemon || daemon.accountId !== client.accountId) return void fail("daemon 不在线或不属于本账号");
    if (!supportsP2pDial(daemon.info.workerVersion)) {
      return void fail(`设备 worker 版本过旧（${daemon.info.workerVersion}），不支持 P2P 直连；在该设备上运行 \`cofluxd update && cofluxd restart\` 后重试`);
    }

    // lazy sweep：借每次 offer 清过期 pending，无独立定时器。
    const now = Date.now();
    for (const [id, entry] of this.p2pPending) {
      if (now - entry.at > config.relayTokenTtlMs) this.p2pPending.delete(id);
    }
    if (this.p2pPending.size >= 256) return void fail("p2p 信令待处理数超限");
    this.p2pPending.set(request.connectionId, { client, daemonId: request.daemonId, at: now });

    this.sendDaemon(daemon, {
      case: "deviceP2pDial",
      value: {
        connectionId: request.connectionId,
        accountId: client.accountId,
        clientInstanceId: request.clientInstanceId,
        sdp: request.sdp,
        iceServers: config.stunUrls,
        protocolVersion: DEVICE_PROTOCOL_VERSION,
      },
    });
  }

  private handleDeviceP2pAnswerReport(daemonId: DaemonId, report: DeviceP2pAnswerReport): void {
    const pending = this.p2pPending.get(report.connectionId);
    if (!pending || pending.daemonId !== daemonId) return;
    this.p2pPending.delete(report.connectionId);
    this.sendClient(pending.client, {
      case: "deviceP2pAnswer",
      value: { connectionId: report.connectionId, ok: report.ok, sdp: report.sdp, error: report.error },
    });
  }

  /** channel 级授权与 relay rendezvous 同语义：scopes 由中心全量授予、daemon 信任控制面。
   * 授权通过但 worker 侧连接已消亡时不再有补充消息——client 靠 DataChannel open 超时回落。 */
  private handleDeviceP2pChannelOpen(client: ClientConn, request: DeviceP2pChannelOpen): void {
    const fail = (error: string) => {
      log.warn("P2P channel 授权被拒", {
        daemonId: validRelayId(request.daemonId) ? request.daemonId : "<invalid>",
        channelId: validRelayId(request.channelId) ? request.channelId : "<invalid>",
        reason: error,
      });
      this.sendClient(client, { case: "deviceP2pChannelResult", value: { channelId: request.channelId, ok: false, error } });
    };

    // 与 offer 同门：关掉 P2P 后，任何残留 PeerConnection 想开新 channel 一律拒。
    if (!config.p2pEnabled) return void fail("P2P 直连已停用");
    if (!client.accountId) return void fail("client 未认证");
    if (
      request.protocolVersion !== DEVICE_PROTOCOL_VERSION ||
      !validRelayId(request.daemonId) ||
      !validRelayId(request.connectionId) ||
      !validRelayId(request.channelId) ||
      request.channelId.startsWith("__coflux-") ||
      !validRelayId(request.clientInstanceId) ||
      request.transportGeneration <= 0n
    ) {
      return void fail("p2p channel/principal/version 无效");
    }
    if (!allowRendezvous(client)) return void fail("rendezvous 频率超限");

    const daemon = this.daemons.get(request.daemonId);
    if (!daemon || daemon.accountId !== client.accountId) return void fail("daemon 不在线或不属于本账号");

    this.sendDaemon(daemon, {
      case: "deviceP2pChannelGrant",
      value: {
        connectionId: request.connectionId,
        channelId: request.channelId,
        accountId: client.accountId,
        clientInstanceId: request.clientInstanceId,
        transportGeneration: request.transportGeneration,
        scopes: [DeviceScope.SESSION_READ, DeviceScope.SESSION_CONTROL, DeviceScope.RPC, DeviceScope.LIFECYCLE],
        protocolVersion: DEVICE_PROTOCOL_VERSION,
      },
    });
    this.sendClient(client, { case: "deviceP2pChannelResult", value: { channelId: request.channelId, ok: true } });
  }

  private async removeDevice(client: ClientConn, daemonId: DaemonId): Promise<void> {
    await this.withDaemonGenerationGate(daemonId, async () => {
      // register/restore 与 remove 必须共用完整 gate 临界区，且锁序统一为 gate → device row。
      // 若只把最后的 Map delete 放进 gate，localControl.restoreDaemon 仍可拿旧 grant 快照，
      // 与 gate 外 revoke 交错并把 pending_revoke 覆盖回 install 状态。
      const removed = await this.store.transaction(async (tx) => {
        const device = await tx.claimActiveDevice(daemonId, client.accountId!);
        if (!device) return undefined;
        const workspaces = await tx.listWorkspacesByDaemon(daemonId);
        const projects = await tx.listProjectsByDaemon(daemonId);
        await tx.revokeDevice(daemonId);
        await tx.expirePreparedOperationsByDaemon(
          device.accountId,
          daemonId,
          Date.now(),
        );
        await tx.removeSessionCheckpointsByDaemon(daemonId);
        const taskIds = await tx.removeTasksByDaemon(daemonId);
        for (const w of workspaces) await tx.removeWorkspace(w.id);
        for (const p of projects) await tx.removeProject(p.id);
        return { accountId: device.accountId, workspaces, projects, taskIds };
      });
      if (!removed) return;

      // DB 删除已提交：在任何 await/广播之前整批作废旧实体 continuation。
      this.cancelDeviceEffects(daemonId);
      for (const workspace of removed.workspaces) this.cancelWorkspaceEffects(workspace.id);
      for (const project of removed.projects) this.cancelProjectEffects(project.id);
      const runtimeTaskIds = [...this.sessions.values()].flatMap((runtime) =>
        runtime.accountId === removed.accountId && runtime.daemonId === daemonId
          ? [runtime.taskId]
          : []
      );
      this.retireTaskRuntimes(
        [...removed.taskIds, ...runtimeTaskIds],
        removed.accountId,
        daemonId,
        true,
      );
      this.preparedOperations.cancelDaemon(daemonId, "设备已撤销，prepared operation 已取消");
      this.failDaemonWaiters(daemonId, "设备已撤销");

      // 先清 origin/撤销 grant 再关闭 control WS；即使 revoke ack 丢失，durable tombstone 仍保留。
      await this.localControl.revokeDevice(daemonId);
      if (this.shuttingDown) return;
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
      this.daemonResyncAuthorities.delete(daemonId);
      for (const [sid, s] of this.sessions) {
        if (s.daemonId === daemonId && s.accountId === removed.accountId) this.dropSession(sid);
      }
      for (const id of removed.taskIds) this.broadcast(removed.accountId, { case: "taskRemoved", value: { taskId: id } });
      for (const w of removed.workspaces) this.broadcast(removed.accountId, { case: "workspaceRemoved", value: { workspaceId: w.id } });
      for (const p of removed.projects) this.broadcast(removed.accountId, { case: "projectRemoved", value: { projectId: p.id } });
      this.broadcast(removed.accountId, { case: "daemonRemoved", value: { daemonId } });
      log.info("device removed", { daemonId });
    });
  }

  handleClientClose(client: ClientConn): void {
    this.clients.delete(client);
    client.snapshotBacklog = undefined;
    client.subscribed = false;
    this.preparedOperations.removeClient(client);
  }

  /* ==================== 中心发起的 daemon 副作用 + MCP 操作层（plan 091） ==================== */

  /** daemon 断开/换代/撤销：该设备上所有完成原语等待者与在飞读写请求以同一可读错误唤醒。 */
  private failDaemonWaiters(daemonId: DaemonId, message: string): void {
    this.operationCompletions.failDaemon(daemonId, { case: "failed", message });
    this.taskExitCompletions.failDaemon(daemonId, { case: "failed", message });
    for (const [requestId, pending] of [...this.pendingAgentRequests]) {
      if (pending.daemonId !== daemonId) continue;
      this.pendingAgentRequests.delete(requestId);
      clearTimeout(pending.timer);
      pending.resolve(undefined);
    }
  }

  /** server→daemon 读/写请求（plan 091）：有界等待一条 serverAgentResult；超时/断开返回 undefined。 */
  private requestDaemonAgent(daemon: DaemonConn, payload: ServerAgentRequestPayload): Promise<ServerAgentResult | undefined> {
    if (this.pendingAgentRequests.size >= MAX_PENDING_AGENT_REQUESTS) return Promise.resolve(undefined);
    const requestId = randomUUID();
    return new Promise((resolve) => {
      const pending: PendingAgentRequest = {
        daemonId: daemon.info.daemonId,
        resolve,
        timer: setTimeout(() => {
          if (this.pendingAgentRequests.delete(requestId)) resolve(undefined);
        }, AGENT_REQUEST_TIMEOUT_MS),
      };
      pending.timer.unref?.();
      this.pendingAgentRequests.set(requestId, pending);
      if (!this.sendDaemon(daemon, { case: "serverAgentRequest", value: { requestId, payload } })) {
        this.pendingAgentRequests.delete(requestId);
        clearTimeout(pending.timer);
        resolve(undefined);
      }
    });
  }

  private resolveAgentRequest(daemon: DaemonConn, result: ServerAgentResult): void {
    const pending = this.pendingAgentRequests.get(result.requestId);
    if (!pending || pending.daemonId !== daemon.info.daemonId) return;
    this.pendingAgentRequests.delete(result.requestId);
    clearTimeout(pending.timer);
    pending.resolve(result);
  }

  /** 能力门禁（plan 091）：按 daemon 认证时宣告的能力名判定，不按版本号。必须在 prepare **之前**
   * 判定——旧 worker 对安装照常回 ok，却会永远收不到 Execute，留下占并发额度到 TTL 的僵尸记录。 */
  private requireOnlineDaemon(daemonId: DaemonId, accountId: AccountId, capability: string): OperationOutcome<DaemonConn> {
    const daemon = this.daemons.get(daemonId);
    if (!daemon || daemon.accountId !== accountId) return { ok: false, error: "设备离线，无法执行该操作" };
    if (!daemon.capabilities.has(capability)) return { ok: false, error: daemonUpgradeRequired(daemon.info.name) };
    return { ok: true, value: daemon };
  }

  private async waitOperation(operationId: string, daemonId: DaemonId): Promise<OperationWaitResult> {
    const waiting = this.operationCompletions.wait(operationId, daemonId, OPERATION_WAIT_MS, { case: "timeout" });
    if (!waiting) return { case: "failed", message: "中心等待中的操作过多，请稍后重试" };
    return await waiting;
  }

  /** 在某项目下建 worktree 工作区（与 web workspaceCreate 同一条 prepared `worktree.add`，只是发起方是中心）。 */
  async createWorkspaceForAccount(
    accountId: AccountId,
    input: { projectId: ProjectId; branch: string; createNew: boolean; name?: string },
  ): Promise<OperationOutcome<Workspace>> {
    const project = await this.store.getProject(input.projectId);
    if (!project || project.accountId !== accountId) return { ok: false, error: `项目 ${input.projectId} 不存在或不属于当前账号` };
    const branch = input.branch.trim();
    if (!validBoundedText(branch, MAX_BRANCH_BYTES) || /\s/.test(branch)) return { ok: false, error: "分支名无效（不能为空、不能含空白或控制字符）" };
    const name = (input.name ?? "").trim() || branch;
    if (!validBoundedText(name, MAX_WORKSPACE_NAME_BYTES)) return { ok: false, error: "工作区名称过长或含控制字符" };
    if (await this.store.isProjectDeleting(project.id)) return { ok: false, error: "项目正在删除，不能再创建工作区" };
    const daemon = this.requireOnlineDaemon(project.daemonId, accountId, DAEMON_CAPABILITY_PREPARED_EXECUTE);
    if (!daemon.ok) return daemon;

    const workspaceId = randomUUID();
    const operationId = randomUUID();
    const frame = this.preparedOperations.createFrame(operationId, {
      case: "worktreeAdd",
      value: { requestId: operationId, operationId, repoPath: project.repoPath, workspaceId, name, branch, createNew: input.createNew },
    });
    const prepared = await this.preparedOperations.prepareServer({
      operationId,
      accountId,
      daemonId: project.daemonId,
      kind: "worktree.add",
      targetId: workspaceId,
      targetVersion: null,
      frame,
      metadata: JSON.stringify({ projectId: project.id, workspaceId, name, initiator: SERVER_INITIATOR }),
      expiresAt: Date.now() + config.preparedOperationTtlMs,
    });
    if (prepared.case === "rejected") return { ok: false, error: prepared.message };
    const outcome = await this.waitOperation(prepared.operation.operationId, project.daemonId);
    if (outcome.case === "timeout") {
      return { ok: false, error: `工作区创建已提交但 ${OPERATION_WAIT_MS / 1000} 秒内未完成；稍后用 list_workspaces 查看（workspaceId: ${workspaceId}）` };
    }
    if (outcome.case === "failed") return { ok: false, error: `创建工作区失败：${outcome.message}` };
    const workspace = outcome.effect.workspace ?? await this.store.getWorkspace(workspaceId);
    if (!workspace) return { ok: false, error: "工作区创建已完成但记录不可读，稍后用 list_workspaces 查看" };
    return { ok: true, value: workspace };
  }

  async renameWorkspaceForAccount(accountId: AccountId, workspaceId: WorkspaceId, name: string): Promise<OperationOutcome<Workspace>> {
    const ws = await this.store.getWorkspace(workspaceId);
    if (!ws || ws.accountId !== accountId) return { ok: false, error: `工作区 ${workspaceId} 不存在或不属于当前账号` };
    if (!validBoundedText(name, MAX_WORKSPACE_NAME_BYTES, true)) return { ok: false, error: "工作区名称过长或含控制字符" };
    const updated = await this.renameWorkspace(accountId, ws.id, name);
    if (!updated) return { ok: false, error: "工作区已被删除" };
    return { ok: true, value: updated };
  }

  /** 删工作区：主工作区拒绝；目录工作区只删记录；worktree 工作区先关其下所有会话再 prepared `worktree.remove`（中心发起）。 */
  async removeWorkspaceForAccount(accountId: AccountId, workspaceId: WorkspaceId): Promise<OperationOutcome<{ workspaceId: WorkspaceId; removedTerminalIds: TaskId[] }>> {
    const ws = await this.store.getWorkspace(workspaceId);
    if (!ws || ws.accountId !== accountId) return { ok: false, error: `工作区 ${workspaceId} 不存在或不属于当前账号` };
    if (ws.isMain) return { ok: false, error: "主工作区不能删除（要删就删整个项目）" };
    if (isDirWorkspace(ws)) {
      const removedTaskIds = (await this.store.listTasksByWorkspace(ws.id)).map((task) => task.id);
      const removed = await this.removeDirWorkspace(ws);
      if (!removed) return { ok: false, error: "工作区已被删除或设备已撤销" };
      return { ok: true, value: { workspaceId: ws.id, removedTerminalIds: removedTaskIds } };
    }
    const project = await this.store.getProject(ws.projectId);
    if (!project || project.daemonId !== ws.daemonId || project.accountId !== accountId) return { ok: false, error: "所属项目已不存在" };
    const daemon = this.requireOnlineDaemon(ws.daemonId, accountId, DAEMON_CAPABILITY_PREPARED_EXECUTE);
    if (!daemon.ok) return daemon;
    await this.closeWorkspaceSessions(ws);

    const operationId = randomUUID();
    const frame = this.preparedOperations.createFrame(operationId, {
      case: "worktreeRemove",
      value: { requestId: operationId, operationId, repoPath: project.repoPath, worktreePath: ws.path },
    });
    const prepared = await this.preparedOperations.prepareServer({
      operationId,
      accountId: ws.accountId,
      daemonId: ws.daemonId,
      kind: "worktree.remove",
      targetId: ws.id,
      targetVersion: ws.createdAt,
      frame,
      metadata: JSON.stringify({ projectId: project.id, workspaceId: ws.id, removeProject: false, initiator: SERVER_INITIATOR }),
      expiresAt: Date.now() + config.preparedOperationTtlMs,
    });
    if (prepared.case === "rejected") return { ok: false, error: prepared.message };
    const outcome = await this.waitOperation(prepared.operation.operationId, ws.daemonId);
    if (outcome.case === "timeout") {
      return { ok: false, error: `工作区删除已提交但 ${OPERATION_WAIT_MS / 1000} 秒内未完成；稍后用 list_workspaces 确认` };
    }
    if (outcome.case === "failed") return { ok: false, error: `删除工作区失败：${outcome.message}` };
    return { ok: true, value: { workspaceId: ws.id, removedTerminalIds: outcome.effect.removedTaskIds ?? [] } };
  }

  /** 在工作区里开一个跑一条命令的真实终端：同一事务里建 IDLE task（沿用 terminalNew 的准入）并 prepare 带
   * command 的 `session.create`（中心发起），等收敛到 RUNNING。每工作区活跃终端上限含用户手开的。 */
  async createTerminalForAccount(
    accountId: AccountId,
    input: { workspaceId: WorkspaceId; title: string; command: string },
  ): Promise<OperationOutcome<Task>> {
    const initialWorkspace = await this.store.getWorkspace(input.workspaceId);
    if (!initialWorkspace || initialWorkspace.accountId !== accountId) return { ok: false, error: `工作区 ${input.workspaceId} 不存在或不属于当前账号` };
    const command = input.command;
    if (!command.trim() || Buffer.byteLength(command, "utf8") > MAX_TERMINAL_COMMAND_BYTES) {
      return { ok: false, error: `命令不能为空且不超过 ${MAX_TERMINAL_COMMAND_BYTES} 字节` };
    }
    const title = input.title.trim() || command.split("\n")[0]!.slice(0, 64);
    if (!validBoundedText(title, MAX_TERMINAL_TITLE_BYTES)) return { ok: false, error: "终端标题过长或含控制字符" };
    const daemon = this.requireOnlineDaemon(initialWorkspace.daemonId, accountId, DAEMON_CAPABILITY_PREPARED_EXECUTE);
    if (!daemon.ok) return daemon;

    const taskId = randomUUID();
    const sessionId = randomUUID();
    const operationId = randomUUID();
    const ts = Date.now();
    const frame = this.preparedOperations.createFrame(operationId, {
      case: "sessionCreate",
      value: { requestId: operationId, operationId, sessionId, taskId, cwd: initialWorkspace.path, cols: AGENT_TERMINAL_COLS, rows: AGENT_TERMINAL_ROWS, command },
    });
    let task: Task | undefined;
    const prepared = await this.withDeviceEffectGuard(initialWorkspace.daemonId, async (effectGuard) =>
      await this.withTaskEffectGuard(taskId, async (taskEffectGuard) => {
        const outcome = await this.preparedOperations.prepareServer({
          operationId,
          accountId,
          daemonId: initialWorkspace.daemonId,
          kind: "session.create",
          targetId: taskId,
          targetVersion: ts,
          frame,
          metadata: JSON.stringify({ taskId, sessionId, initiator: SERVER_INITIATOR }),
          expiresAt: Date.now() + config.preparedOperationTtlMs,
        }, async (tx) => {
          // prepare 已持有 device 父行锁；锁后重读 workspace/project，并在同一事务里建 IDLE task，
          // 与 workspaceRemove/removeDevice 的删除和 prepared expiry 形成一个确定顺序。
          if (effectGuard.cancelled || taskEffectGuard.cancelled) return "设备或工作区已删除，终端创建已取消";
          const ws = await tx.getWorkspace(initialWorkspace.id);
          if (!ws || ws.accountId !== accountId || ws.daemonId !== initialWorkspace.daemonId) return "工作区已被删除";
          if (!isDirWorkspace(ws)) {
            const project = await tx.claimActiveProject(ws.projectId);
            if (!project || project.accountId !== ws.accountId || project.daemonId !== ws.daemonId) return "项目正在删除，不能再创建终端";
          }
          // 统计所有活跃终端而不只是 agent 建的：防的是「侧栏被刷满」，来源无所谓（同 terminalNew）。
          const active = (await tx.listTasksByWorkspace(ws.id)).filter((t) => t.status === TaskStatus.RUNNING).length;
          if (active >= config.maxAgentTerminalsPerWorkspace) {
            return `本工作区活跃终端已达上限 ${config.maxAgentTerminalsPerWorkspace}（含用户手动开的），先 stop_terminal 停掉一些再开新的`;
          }
          task = create(TaskSchema, {
            id: taskId,
            accountId: ws.accountId,
            daemonId: ws.daemonId,
            projectId: ws.projectId,
            workspaceId: ws.id,
            title,
            status: TaskStatus.IDLE,
            createdAt: ts,
            updatedAt: ts,
          });
          await tx.createTask(task);
          return undefined;
        });
        if (outcome.case === "accepted" && effectGuard.cancelled) return { case: "rejected", message: "设备已删除，终端创建已取消" } as const;
        return outcome;
      }));
    if (prepared.case === "rejected") {
      // admission 通过但 prepared 记录没落成（并发上限/ID 冲突）时同一事务已提交了 IDLE task，
      // 它从未对外可见，直接删掉，不留孤儿。
      if (task) await this.store.removeTask(task.id).catch(() => undefined);
      return { ok: false, error: prepared.message };
    }
    if (!task) return { ok: false, error: "终端创建状态未知，请用 list_terminals 查看" };
    // IDLE 先对外可见（与 web taskCreate + taskStart 的两步一致），收敛到 RUNNING 由 report 广播。
    this.emitTask(task);
    const outcome = await this.waitOperation(prepared.operation.operationId, initialWorkspace.daemonId);
    if (outcome.case === "timeout") {
      return { ok: false, error: `终端已创建（terminalId: ${task.id}）但 ${OPERATION_WAIT_MS / 1000} 秒内未收到设备启动回执；稍后用 list_terminals / read_terminal 查看` };
    }
    if (outcome.case === "failed") return { ok: false, error: `终端启动失败（terminalId: ${task.id}，记录仍在，可 remove_terminal 清理）：${outcome.message}` };
    const running = outcome.effect.task ?? await this.store.getTask(task.id);
    if (!running) return { ok: false, error: "终端已启动但记录不可读，稍后用 list_terminals 查看" };
    return { ok: true, value: running };
  }

  /** 读终端：daemon 在线且支持 terminal_io → 经 daemon（命令日志尾部优先，否则本地快照）；否则中心 checkpoint。 */
  async readTerminalForAccount(
    accountId: AccountId,
    terminalId: TaskId,
    maxBytes = MAX_TERMINAL_READ_BYTES,
  ): Promise<OperationOutcome<{ task: Task; data: Uint8Array; source: TerminalReadSource; capturedAt: number | null; title: string }>> {
    const task = await this.store.getTask(terminalId);
    if (!task || task.accountId !== accountId) return { ok: false, error: `终端 ${terminalId} 不存在或不属于当前账号` };
    const bytes = Math.max(1, Math.min(MAX_TERMINAL_READ_BYTES, Math.floor(maxBytes)));
    const daemon = this.daemons.get(task.daemonId);
    if (daemon && daemon.accountId === accountId && daemon.capabilities.has(DAEMON_CAPABILITY_TERMINAL_IO)) {
      const result = await this.requestDaemonAgent(daemon, {
        case: "terminalRead",
        value: { taskId: task.id, sessionId: task.sessionId ?? "", maxBytes: bytes },
      });
      if (result?.ok && result.payload.case === "terminalRead" && result.payload.value.source !== "none") {
        const source: TerminalReadSource = result.payload.value.source === "log" ? "log" : "snapshot";
        const fresh = await this.store.getTask(task.id) ?? task;
        return { ok: true, value: { task: fresh, data: result.payload.value.data, source, capturedAt: Date.now(), title: fresh.title } };
      }
      if (result && !result.ok) {
        log.warn("经 daemon 读终端失败，退回 checkpoint", { taskId: task.id, daemonId: task.daemonId, reason: result.error });
      }
    }
    const checkpoint = await this.store.getSessionCheckpointByTask(task.id);
    return {
      ok: true,
      value: {
        task,
        data: checkpoint?.ansiSnapshot ?? new Uint8Array(),
        source: checkpoint ? "checkpoint" : "none",
        capturedAt: checkpoint ? checkpoint.capturedAt : null,
        title: checkpoint?.title || task.title,
      },
    };
  }

  /** 往终端写输入：经 daemon 的 agent_send_input 正门；用户正在接管时被拒（文案来自 worker）。 */
  async sendTerminalInputForAccount(accountId: AccountId, terminalId: TaskId, data: Uint8Array): Promise<OperationOutcome<{ bytes: number }>> {
    const task = await this.store.getTask(terminalId);
    if (!task || task.accountId !== accountId) return { ok: false, error: `终端 ${terminalId} 不存在或不属于当前账号` };
    if (data.byteLength === 0) return { ok: false, error: "输入为空" };
    if (data.byteLength > MAX_TERMINAL_INPUT_BYTES) return { ok: false, error: `单次输入不超过 ${MAX_TERMINAL_INPUT_BYTES} 字节` };
    if (task.status === TaskStatus.EXITED) return { ok: false, error: "终端已退出，不能再输入（要跑新命令用 create_terminal）" };
    if (task.status !== TaskStatus.RUNNING || !task.sessionId) return { ok: false, error: "终端尚未就绪（还没有会话），稍后重试" };
    const daemon = this.requireOnlineDaemon(task.daemonId, accountId, DAEMON_CAPABILITY_TERMINAL_IO);
    if (!daemon.ok) return daemon;
    const result = await this.requestDaemonAgent(daemon.value, { case: "terminalInput", value: { sessionId: task.sessionId, data } });
    if (!result) return { ok: false, error: "等待设备写入回执超时，写入结果未知；先 read_terminal 看看再决定是否重发" };
    if (!result.ok) return { ok: false, error: result.error ?? "设备拒绝写入" };
    return { ok: true, value: { bytes: data.byteLength } };
  }

  /** 有界等待终端退出：到期返回当前状态而非报错。 */
  async waitTerminalForAccount(accountId: AccountId, terminalId: TaskId, timeoutMs?: number): Promise<OperationOutcome<{ task: Task; exited: boolean; timedOut: boolean }>> {
    const initial = await this.store.getTask(terminalId);
    if (!initial || initial.accountId !== accountId) return { ok: false, error: `终端 ${terminalId} 不存在或不属于当前账号` };
    const wait = Math.max(1, Math.min(TERMINAL_WAIT_MAX_MS, Math.floor(timeoutMs ?? TERMINAL_WAIT_DEFAULT_MS)));
    if (initial.status === TaskStatus.EXITED) return { ok: true, value: { task: initial, exited: true, timedOut: false } };
    // 先登记等待者再重读，避免登记前那一瞬间的退出漏掉。
    const waiting = this.taskExitCompletions.wait(initial.id, initial.daemonId, wait, { case: "timeout" });
    if (!waiting) return { ok: false, error: "中心等待中的请求过多，请稍后重试" };
    const recheck = await this.store.getTask(initial.id);
    if (!recheck || recheck.accountId !== accountId) {
      this.taskExitCompletions.resolve(initial.id, { case: "failed", message: "任务已删除" });
      return { ok: false, error: "终端已被删除" };
    }
    if (recheck.status === TaskStatus.EXITED) {
      this.taskExitCompletions.resolve(initial.id, { case: "exited", exitCode: recheck.exitCode ?? 0 });
      return { ok: true, value: { task: recheck, exited: true, timedOut: false } };
    }
    const result = await waiting;
    const final = await this.store.getTask(initial.id);
    if (!final || final.accountId !== accountId) return { ok: false, error: "终端已被删除" };
    if (result.case === "failed" && final.status !== TaskStatus.EXITED) return { ok: false, error: result.message };
    return { ok: true, value: { task: final, exited: final.status === TaskStatus.EXITED, timedOut: result.case === "timeout" } };
  }

  /** 结束终端会话（等价 web 的停止：sessionClose 直发），随后有界等 sessionExit；返回时会话已退出或已在退出中。 */
  async stopTerminalForAccount(accountId: AccountId, terminalId: TaskId): Promise<OperationOutcome<{ task: Task; exited: boolean }>> {
    const task = await this.store.getTask(terminalId);
    if (!task || task.accountId !== accountId) return { ok: false, error: `终端 ${terminalId} 不存在或不属于当前账号` };
    if (task.status === TaskStatus.EXITED) return { ok: true, value: { task, exited: true } };
    if (!task.sessionId) return { ok: false, error: "终端还没有会话，无需停止（要删除用 remove_terminal）" };
    const daemon = this.daemons.get(task.daemonId);
    if (!daemon || daemon.accountId !== accountId) return { ok: false, error: "设备离线，无法停止终端" };
    if (!this.sessionHasIdentity(task.sessionId, task.id, task.accountId, task.daemonId)) {
      return { ok: false, error: "该会话不在设备的当前运行时里（可能正在对账），稍后重试" };
    }
    const waiting = this.taskExitCompletions.wait(task.id, task.daemonId, STOP_WAIT_MS, { case: "timeout" });
    if (!this.sendDaemon(daemon, { case: "sessionClose", value: { sessionId: task.sessionId } })) {
      if (waiting) this.taskExitCompletions.resolve(task.id, { case: "failed", message: "daemon 连接发送失败" });
      return { ok: false, error: "daemon 连接发送失败，请重试" };
    }
    if (waiting) await waiting;
    const final = await this.store.getTask(task.id);
    if (!final || final.accountId !== accountId) return { ok: false, error: "终端已被删除" };
    return { ok: true, value: { task: final, exited: final.status === TaskStatus.EXITED } };
  }

  /** 删除终端记录（含 checkpoint）；仍在运行的必须先 stop_terminal。 */
  async removeTerminalForAccount(accountId: AccountId, terminalId: TaskId): Promise<OperationOutcome<TaskId>> {
    const task = await this.store.getTask(terminalId);
    if (!task || task.accountId !== accountId) return { ok: false, error: `终端 ${terminalId} 不存在或不属于当前账号` };
    if (task.status === TaskStatus.RUNNING || task.sessionId) return { ok: false, error: "终端仍在运行，先 stop_terminal 再删除" };
    return await this.removeTaskRecord(task, true);
  }

  /** 运行时计数（供 /health 暴露） */
  stats(): { daemons: number; clients: number; sessions: number } {
    return { daemons: this.daemons.size, clients: this.clients.size, sessions: this.sessions.size };
  }

  /** 优雅关闭：清定时器、关所有连接 */
  shutdown(): void {
    this.shuttingDown = true;
    // shutdown 是 Raven 同步生命周期钩子，不能 await generation gate。先同步摘掉 current
    // identity；所有在途 await/排队 registration 都会在下一次 guard 处 fail-closed。
    const daemons = [...this.daemons.values()];
    this.daemons.clear();
    this.catalog.clear();
    this.localControl.shutdown();
    this.preparedOperations.shutdown();
    this.operationCompletions.failAll({ case: "failed", message: "中心正在关闭" });
    this.taskExitCompletions.failAll({ case: "failed", message: "中心正在关闭" });
    for (const pending of this.pendingAgentRequests.values()) {
      clearTimeout(pending.timer);
      pending.resolve(undefined);
    }
    this.pendingAgentRequests.clear();
    for (const p of this.pendingAuthorizations.values()) clearTimeout(p.timer);
    this.pendingAuthorizations.clear();
    this.oauth.shutdown();
    this.daemonResyncAuthorities.clear();
    for (const d of daemons) try { d.ws.close(1001, "server shutting down"); } catch { /* ignore */ }
    for (const c of this.clients) try { c.ws.close(1001, "server shutting down"); } catch { /* ignore */ }
  }
}

/** 目录工作区（无 repo 终端，plan 045）：projectId 为空即目录工作区，判定收敛在此一处 */
function isDirWorkspace(ws: Workspace): boolean {
  return !ws.projectId;
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
  return value.length > 0 && Buffer.byteLength(value, "utf8") <= MAX_FRAME_ID_BYTES && ![...value].some((char) => {
    const code = char.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

/** 握手宣告的能力名（plan 091）：有界、无控制字符；名单外的名字原样保存（前向兼容，门禁只看已知名）。 */
function validCapabilities(values: readonly string[]): boolean {
  if (values.length > MAX_CAPABILITY_ENTRIES) return false;
  return values.every((value) => validBoundedText(value, MAX_CAPABILITY_BYTES));
}

function validBoundedText(value: string, maxBytes: number, allowEmpty = false, allowControl = false): boolean {
  if (Buffer.byteLength(value, "utf8") > maxBytes) return false;
  if (!allowEmpty && value.trim().length === 0) return false;
  return allowControl || ![...value].some((char) => {
    const code = char.charCodeAt(0);
    return code < 32 || code === 127;
  });
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
