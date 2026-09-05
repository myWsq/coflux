/**
 * 服务器持久化层（Postgres，porsager/postgres 客户端）。
 * 持久化：账号/设备/业务元数据，以及 local gateway grant、prepared operation、checkpoint cache。
 * 运行时（不落盘）：daemon/client 连接、relay channel、短期 waiter —— 见 hub。
 * token 一律只存 sha256 hash（见 secrets.ts）。
 *
 * 表全部位于独立 schema `coflux`（历史因由：曾托管 Supabase 时避开其自带对象/PostgREST 暴露面；
 * 2026-07-28 迁 prod-jp 自托管后沿用，不折腾）；
 * 连接时用 `connection.search_path` 固定指向它，SQL 里不必显式加 schema 前缀。
 *
 * 列名用 snake_case（Postgres 惯例，免加引号）；应用层对象一律 camelCase（匹配 @coflux/protocol），
 * 由 `transform: postgres.camel` 双向自动转换（结果行自动转 camelCase；`sql(obj, ...cols)` 插入/更新
 * 助手自动把 camelCase 键转 snake_case 列）。时间戳（ms since epoch）用 DOUBLE PRECISION 而非
 * BIGINT——避免 postgres.js 默认把 int8 解析成 string（协议侧类型是 number），float64 精度在这个量级
 * 完全无损。
 */
import postgres from "postgres";
import { runSchemaMigrations } from "./infra/database/schema-migrations.js";
import {
  create,
  TaskStatus,
  ProjectSchema,
  WorkspaceSchema,
  TaskSchema,
  type AccountId,
  type DaemonId,
  type Project,
  type ProjectId,
  type Task,
  type TaskId,
  type Workspace,
  type WorkspaceId,
  type SessionId,
  type DeviceOperationReport,
  type LocalBrowserGrant,
  type LocalGatewayDescriptor,
  type OnlineDeviceLease,
  type SessionCheckpoint,
} from "@coflux/protocol";

const MAX_SESSION_CHECKPOINTS_PER_ACCOUNT = 256;
const MAX_SESSION_CHECKPOINT_BYTES_PER_ACCOUNT = 64 * 1024 * 1024;
const SESSION_CHECKPOINT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** DB 里 tasks.status 列存字符串（可读、迁移友好）；协议侧是 proto enum TaskStatus。
 * 这一对 helper 是两者唯一的换算点，别处一律用 TaskStatus。 */
function taskStatusToDb(status: TaskStatus): string {
  switch (status) {
    case TaskStatus.RUNNING:
      return "running";
    case TaskStatus.EXITED:
      return "exited";
    case TaskStatus.IDLE:
    default:
      return "idle";
  }
}
function taskStatusFromDb(status: string): TaskStatus {
  switch (status) {
    case "running":
      return TaskStatus.RUNNING;
    case "exited":
      return TaskStatus.EXITED;
    default:
      return TaskStatus.IDLE;
  }
}

/** tasks 表的 DB 行形状（status 是字符串，与 Task 消息的 enum 字段区分开）。 */
interface TaskRow {
  id: string;
  accountId: string;
  daemonId: string;
  projectId: string | null;
  workspaceId: string;
  title: string;
  status: string;
  sessionId: string | null;
  exitCode: number | null;
  createdAt: number;
  updatedAt: number;
}

function rowToTask(r: TaskRow): Task {
  return create(TaskSchema, {
    id: r.id,
    accountId: r.accountId,
    daemonId: r.daemonId,
    projectId: r.projectId ?? "",
    workspaceId: r.workspaceId,
    title: r.title,
    status: taskStatusFromDb(r.status),
    sessionId: r.sessionId ?? undefined,
    exitCode: r.exitCode ?? undefined,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  });
}

/** 目录 workspace 在协议层沿用空 projectId；数据库用 NULL 表达可选 FK。 */
type WorkspaceRow = Omit<Workspace, "projectId"> & { projectId: string | null };

function rowToWorkspace(row: WorkspaceRow): Workspace {
  return create(WorkspaceSchema, { ...row, projectId: row.projectId ?? "" });
}

export interface Account {
  id: AccountId;
  name: string;
  createdAt: number;
}

/** password 模式（plan 059）的登录账号：email 归一化小写存储/查询。 */
export interface User {
  id: string;
  email: string;
  passwordHash: string;
  createdAt: number;
}

export interface Device {
  id: DaemonId;
  accountId: AccountId;
  name: string;
  host: string;
  platform: string;
  tokenHash: string;
  createdAt: number;
  lastSeenAt: number;
  revoked: boolean;
}

export interface LocalGatewayRecord {
  daemonId: DaemonId;
  accountId: AccountId;
  protocolVersion: number;
  port: number;
  publicKeySec1: Uint8Array;
  updatedAt: number;
}

export type LocalGrantState = "pending_install" | "active" | "install_failed" | "pending_revoke" | "revoked";
export type LocalGrantControlAction = "install" | "sync_install" | "revoke" | "sync_revoke";

export interface LocalGrantRecord {
  grantId: string;
  accountId: AccountId;
  daemonId: DaemonId;
  origin: string;
  publicKeySec1: Uint8Array;
  offlineScopes: number[];
  clientTokenHash: string | null;
  pairRequestId: string;
  state: LocalGrantState;
  controlRequestId: string | null;
  controlAction: LocalGrantControlAction | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  revokedAt: number | null;
}

export interface LocalLeaseRecord {
  leaseId: string;
  grantId: string;
  accountId: AccountId;
  daemonId: DaemonId;
  clientTokenHash: string | null;
  scopes: number[];
  expiresAt: number;
  createdAt: number;
  revoked: boolean;
}

export type PreparedOperationState =
  | "pending_install"
  | "installed"
  | "install_failed"
  | "expired"
  | "applying"
  | "completed"
  | "failed";

export interface PreparedOperationRecord {
  operationId: string;
  accountId: AccountId;
  daemonId: DaemonId;
  kind: string;
  targetId: string | null;
  targetVersion: number | null;
  frame: Uint8Array;
  metadata: string;
  expiresAt: number;
  state: PreparedOperationState;
  completed: boolean;
  installError: string | null;
  reportOk: boolean | null;
  reportTaskId: string | null;
  reportSessionId: string | null;
  reportPid: number | null;
  reportExitCode: number | null;
  reportError: string | null;
  resultFrame: Uint8Array | null;
  createdAt: number;
  updatedAt: number;
}

export type NewPreparedOperation = Pick<
  PreparedOperationRecord,
  "operationId" | "accountId" | "daemonId" | "kind" | "targetId" | "targetVersion" | "frame" | "metadata" | "expiresAt"
>;

interface SessionCheckpointRow {
  sessionId: SessionId;
  taskId: TaskId;
  accountId: AccountId;
  daemonId: DaemonId;
  snapshotSeq: string;
  ansiSnapshot: Uint8Array;
  cols: number;
  rows: number;
  title: string;
  capturedAt: number;
  updatedAt: number;
}

export interface SessionCheckpointRecord extends Omit<SessionCheckpointRow, "snapshotSeq"> {
  snapshotSeq: bigint;
}

/** OAuth 2.1 动态注册的公共客户端（plan 090）。redirectUris/grantTypes 在 DB 里是 JSON 文本，
 * metadata 是注册应答全文（RFC 7591 要求原样回显）。 */
export interface OAuthClientRecord {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  grantTypes: string[];
  tokenEndpointAuthMethod: string;
  metadata: string;
  createdAt: number;
  lastUsedAt: number | null;
}

interface OAuthClientRow {
  clientId: string;
  clientName: string;
  redirectUris: string;
  grantTypes: string;
  tokenEndpointAuthMethod: string;
  metadata: string;
  createdAt: number;
  lastUsedAt: number | null;
}

function rowToOAuthClient(row: OAuthClientRow): OAuthClientRecord {
  return { ...row, redirectUris: parseStringList(row.redirectUris), grantTypes: parseStringList(row.grantTypes) };
}

function parseStringList(raw: string): string[] {
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export type OAuthTokenKind = "access" | "refresh";

/** OAuth token 行（只存 hash）。同一次授权签出的 access+refresh 共享 grantId，refresh 轮换沿用它。 */
export interface OAuthTokenRecord {
  tokenHash: string;
  kind: OAuthTokenKind;
  grantId: string;
  clientId: string;
  accountId: AccountId;
  userId: string | null;
  scope: string;
  createdAt: number;
  expiresAt: number;
  revoked: boolean;
}

function rowToCheckpoint(row: SessionCheckpointRow): SessionCheckpointRecord {
  return { ...row, snapshotSeq: BigInt(row.snapshotSeq) };
}

export class Store {
  /**
   * 顶层实例持有连接池（`postgres.Sql`）；事务作用域实例（见 `transaction()`）持有
   * `sql.begin` 回调给的事务专属连接（`postgres.TransactionSql`）。两者对本类用到的语句
   * （tagged template / `.unsafe`）结构兼容；仅 `.begin`/`.end` 只在顶层实例上调用。
   */
  private readonly sql: postgres.Sql<{}>;

  private constructor(sql: postgres.Sql<{}>) {
    this.sql = sql;
  }

  /** 建连 + 运行版本化 schema migration。生产/开发通用；URL 由 config.ts 的 fail-closed 体系提供。 */
  static async connect(databaseUrl: string): Promise<Store> {
    const sql = postgres(databaseUrl, {
      max: 5, // 单用户轻负载，单实例用不了多的（生产是 prod-jp 本机 PG，plan 063）
      ssl: "prefer", // 本机/localhost 明文直连；若换要求 TLS 的托管 PG 也能连
      transform: postgres.camel,
      // extra_float_digits=3：float8 按 shortest-round-trip 输出，读回不丢精度
      // （postgres.js 启动包默认压成 0，会把 capturedAt 之类的时间戳截到 15 位）。
      connection: { search_path: "coflux", extra_float_digits: 3 },
    });
    try {
      await runSchemaMigrations(sql);
      return new Store(sql);
    } catch (error) {
      // 启动迁移失败时连接池尚未交给 Raven 生命周期，必须在这里主动收口。
      await sql.end({ timeout: 0 }).catch(() => undefined);
      throw error;
    }
  }

  /**
   * 在单个事务里执行 fn（级联删除、lazy provision 等多语句操作用它保证原子性）。
   * fn 拿到的是事务专属的 Store 句柄——所有语句必须经它执行，不能碰外层的 this，
   * 否则语句会逃逸出事务（静默的原子性丢失）。
   */
  async transaction<T>(fn: (tx: Store) => Promise<T>): Promise<T> {
    // .begin<T>() 显式钉住类型参数：让 TS 推导返回 fn(...) 的结果本身（而非 begin 内部的
    // UnwrapPromiseArray<T> 助手类型，那个类型对泛型 T 不可靠地推导为"与 T 无关的任意类型"）。
    const result = await this.sql.begin<T>((txSql) => fn(new Store(txSql as unknown as postgres.Sql<{}>)));
    return result as T;
  }

  /** 轻量探活（供 /health） */
  async ping(): Promise<boolean> {
    try {
      await this.sql`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }

  /** 优雅关闭：等在途查询结束后断开连接池 */
  async close(): Promise<void> {
    try {
      await this.sql.end({ timeout: 5 });
    } catch {
      /* ignore */
    }
  }

  /* ------------------------------ meta ----------------------------- */
  async getMeta(key: string): Promise<string | undefined> {
    const rows = await this.sql<{ value: string }[]>`SELECT value FROM meta WHERE key = ${key}`;
    return rows[0]?.value;
  }
  async setMeta(key: string, value: string): Promise<void> {
    await this.sql`
      INSERT INTO meta (key, value) VALUES (${key}, ${value})
      ON CONFLICT (key) DO UPDATE SET value = excluded.value
    `;
  }

  /* ---------------------------- accounts ---------------------------- */
  async getAccount(id: AccountId): Promise<Account | undefined> {
    const rows = await this.sql<Account[]>`SELECT * FROM accounts WHERE id = ${id}`;
    return rows[0];
  }
  async createAccount(a: Account): Promise<Account> {
    await this.sql`INSERT INTO accounts ${this.sql(a, "id", "name", "createdAt")}`;
    return a;
  }

  /* ------------------------- users（password 模式） ------------------------- */
  async getUserByEmail(email: string): Promise<User | undefined> {
    const rows = await this.sql<User[]>`SELECT * FROM users WHERE email = ${email}`;
    return rows[0];
  }
  /** 必须在 transaction() 内调用：锁住稳定的 user 父行，串行化该用户首次建个人账号。
   * uq_memberships_user 是最终防线；父行锁让并发请求复用 canonical account，而不是撞唯一约束。 */
  async claimUser(id: string): Promise<User | undefined> {
    const rows = await this.sql<User[]>`SELECT * FROM users WHERE id = ${id} FOR UPDATE`;
    return rows[0];
  }
  /** 建号脚本用：邮箱已存在则更新口令哈希（保留原 id/createdAt），否则新建。 */
  async upsertUser(u: User): Promise<User> {
    const rows = await this.sql<User[]>`
      INSERT INTO users ${this.sql(u, "id", "email", "passwordHash", "createdAt")}
      ON CONFLICT (email) DO UPDATE SET password_hash = excluded.password_hash
      RETURNING *
    `;
    return rows[0];
  }

  /* ------------------------ memberships ---------------------------- */
  /** 个人账号业务语义为 1:1；ORDER BY 让迁移前排障读取也保持确定性。 */
  async getMembershipByUser(userId: string): Promise<{ accountId: AccountId; role: string } | undefined> {
    const rows = await this.sql<{ accountId: string; role: string }[]>`
      SELECT account_id, role FROM memberships WHERE user_id = ${userId} ORDER BY created_at, account_id LIMIT 1
    `;
    return rows[0];
  }
  async createMembership(userId: string, accountId: AccountId, role: string, createdAt: number): Promise<void> {
    await this.sql`
      INSERT INTO memberships (user_id, account_id, role, created_at)
      VALUES (${userId}, ${accountId}, ${role}, ${createdAt})
      ON CONFLICT (user_id, account_id) DO NOTHING
    `;
  }

  /* ------------------------- client tokens ------------------------- */
  async upsertClientToken(
    tokenHash: string,
    accountId: AccountId,
    createdAt: number,
    expiresAt: number | null,
    userId: string | null = null,
  ): Promise<void> {
    await this.sql`
      INSERT INTO client_tokens (token_hash, account_id, created_at, revoked, expires_at, user_id)
      VALUES (${tokenHash}, ${accountId}, ${createdAt}, false, ${expiresAt}, ${userId})
      ON CONFLICT (token_hash) DO NOTHING
    `;
  }
  /** 返回未撤销且未过期（expiresAt 为 NULL 视为不过期）的 token 归属账号。 */
  async accountForClientToken(tokenHash: string, now: number): Promise<AccountId | undefined> {
    const rows = await this.sql<{ accountId: string }[]>`
      SELECT account_id FROM client_tokens
      WHERE token_hash = ${tokenHash} AND revoked = false AND (expires_at IS NULL OR expires_at > ${now})
    `;
    return rows[0]?.accountId;
  }
  /** 会话 token 绑定的登录用户（password 模式才有；local 模式为 NULL）。OAuth 确认页把它写进签发的凭证。 */
  async userIdForClientToken(tokenHash: string): Promise<string | null> {
    const rows = await this.sql<{ userId: string | null }[]>`SELECT user_id FROM client_tokens WHERE token_hash = ${tokenHash}`;
    return rows[0]?.userId ?? null;
  }
  async revokeClientToken(tokenHash: string): Promise<void> {
    await this.sql`UPDATE client_tokens SET revoked = true WHERE token_hash = ${tokenHash}`;
  }
  async revokeAllClientTokens(accountId: AccountId): Promise<void> {
    await this.sql`UPDATE client_tokens SET revoked = true WHERE account_id = ${accountId}`;
  }
  /** 清理已撤销 / 已过期的 token，防表无界增长。 */
  async pruneClientTokens(now: number): Promise<void> {
    await this.sql`DELETE FROM client_tokens WHERE revoked = true OR (expires_at IS NOT NULL AND expires_at <= ${now})`;
  }

  /* ---------------------------- devices ---------------------------- */
  async createDevice(d: Device): Promise<Device> {
    await this.sql`
      INSERT INTO devices ${this.sql(d, "id", "accountId", "name", "host", "platform", "tokenHash", "createdAt", "lastSeenAt", "revoked")}
    `;
    return d;
  }
  async getDevice(id: DaemonId): Promise<Device | undefined> {
    const rows = await this.sql<Device[]>`SELECT * FROM devices WHERE id = ${id}`;
    return rows[0];
  }
  /** 必须在 transaction() 内调用：同时校验设备归属/撤销状态并锁住稳定父行。
   * terminalCreate、prepared admission 等所有 device 子项写路径都持有此锁；对应唯一约束
   * 是最终防线，父行锁负责串行化跨连接的检查后写入。 */
  async claimActiveDevice(id: DaemonId, accountId: AccountId): Promise<Device | undefined> {
    const rows = await this.sql<Device[]>`
      SELECT * FROM devices
      WHERE id = ${id} AND account_id = ${accountId} AND revoked = false
      FOR UPDATE
    `;
    return rows[0];
  }
  async getDeviceByTokenHash(tokenHash: string): Promise<Device | undefined> {
    const rows = await this.sql<Device[]>`SELECT * FROM devices WHERE token_hash = ${tokenHash} AND revoked = false`;
    return rows[0];
  }
  async listDevices(accountId: AccountId): Promise<Device[]> {
    return this.sql<Device[]>`SELECT * FROM devices WHERE account_id = ${accountId} AND revoked = false ORDER BY created_at`;
  }
  async countDevices(accountId: AccountId): Promise<number> {
    const rows = await this.sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM devices WHERE account_id = ${accountId} AND revoked = false`;
    return rows[0].n;
  }
  async touchDevice(id: DaemonId, ts: number): Promise<void> {
    await this.sql`UPDATE devices SET last_seen_at = ${ts} WHERE id = ${id}`;
  }
  async revokeDevice(id: DaemonId): Promise<void> {
    await this.sql`UPDATE devices SET revoked = true WHERE id = ${id}`;
  }
  async updateDeviceName(id: DaemonId, name: string): Promise<Device | undefined> {
    const rows = await this.sql<Device[]>`UPDATE devices SET name = ${name} WHERE id = ${id} RETURNING *`;
    return rows[0];
  }

  /* ---------------------- local gateway / grants ---------------------- */
  async upsertLocalGateway(accountId: AccountId, daemonId: DaemonId, gateway: LocalGatewayDescriptor, updatedAt: number): Promise<LocalGatewayRecord> {
    const rows = await this.sql<LocalGatewayRecord[]>`
      INSERT INTO local_gateways (daemon_id, account_id, protocol_version, port, public_key_sec1, updated_at)
      VALUES (${daemonId}, ${accountId}, ${gateway.protocolVersion}, ${gateway.port}, ${Buffer.from(gateway.publicKeySec1)}, ${updatedAt})
      ON CONFLICT (daemon_id) DO UPDATE SET
        account_id = excluded.account_id,
        protocol_version = excluded.protocol_version,
        port = excluded.port,
        public_key_sec1 = excluded.public_key_sec1,
        updated_at = excluded.updated_at
      RETURNING *
    `;
    return rows[0];
  }

  async getLocalGateway(daemonId: DaemonId): Promise<LocalGatewayRecord | undefined> {
    const rows = await this.sql<LocalGatewayRecord[]>`SELECT * FROM local_gateways WHERE daemon_id = ${daemonId}`;
    return rows[0];
  }

  async createLocalGrant(grant: LocalBrowserGrant, clientTokenHash: string | null, pairRequestId: string): Promise<LocalGrantRecord | undefined> {
    const now = Date.now();
    const rows = await this.sql<LocalGrantRecord[]>`
      INSERT INTO local_browser_grants (
        grant_id, account_id, daemon_id, origin, public_key_sec1, offline_scopes,
        client_token_hash, pair_request_id, state, created_at, updated_at
      ) VALUES (
        ${grant.grantId}, ${grant.accountId}, ${grant.daemonId}, ${grant.origin}, ${Buffer.from(grant.publicKeySec1)},
        ${grant.offlineScopes}, ${clientTokenHash}, ${pairRequestId}, 'pending_install', ${grant.createdAt}, ${now}
      )
      ON CONFLICT DO NOTHING
      RETURNING *
    `;
    return rows[0];
  }

  async getLocalGrant(grantId: string): Promise<LocalGrantRecord | undefined> {
    const rows = await this.sql<LocalGrantRecord[]>`SELECT * FROM local_browser_grants WHERE grant_id = ${grantId}`;
    return rows[0];
  }

  async getLocalGrantByPairRequest(accountId: AccountId, pairRequestId: string): Promise<LocalGrantRecord | undefined> {
    const rows = await this.sql<LocalGrantRecord[]>`
      SELECT * FROM local_browser_grants WHERE account_id = ${accountId} AND pair_request_id = ${pairRequestId}
    `;
    return rows[0];
  }

  async bindLocalGrantToClientToken(grantId: string, accountId: AccountId, tokenHash: string): Promise<LocalGrantRecord | undefined> {
    const rows = await this.sql<LocalGrantRecord[]>`
      UPDATE local_browser_grants SET client_token_hash = ${tokenHash}, updated_at = ${Date.now()}
      WHERE grant_id = ${grantId} AND account_id = ${accountId} AND state NOT IN ('pending_revoke', 'revoked')
      RETURNING *
    `;
    return rows[0];
  }

  async findMatchingLocalGrant(accountId: AccountId, daemonId: DaemonId, origin: string, publicKeySec1: Uint8Array): Promise<LocalGrantRecord | undefined> {
    const rows = await this.sql<LocalGrantRecord[]>`
      SELECT * FROM local_browser_grants
      WHERE account_id = ${accountId} AND daemon_id = ${daemonId} AND origin = ${origin}
        AND public_key_sec1 = ${Buffer.from(publicKeySec1)} AND state NOT IN ('pending_revoke', 'revoked')
      ORDER BY created_at DESC LIMIT 1
    `;
    return rows[0];
  }

  async listLocalGrantsByDaemon(daemonId: DaemonId): Promise<LocalGrantRecord[]> {
    return this.sql<LocalGrantRecord[]>`
      SELECT * FROM local_browser_grants WHERE daemon_id = ${daemonId} ORDER BY created_at
    `;
  }

  async listLocalGrantsByClientToken(accountId: AccountId, tokenHash: string): Promise<LocalGrantRecord[]> {
    return this.sql<LocalGrantRecord[]>`
      SELECT * FROM local_browser_grants
      WHERE account_id = ${accountId} AND client_token_hash = ${tokenHash} AND state NOT IN ('pending_revoke', 'revoked')
      ORDER BY created_at
    `;
  }

  async countLiveLocalGrants(accountId: AccountId, daemonId: DaemonId): Promise<number> {
    const rows = await this.sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM local_browser_grants
      WHERE account_id = ${accountId} AND daemon_id = ${daemonId} AND state NOT IN ('pending_revoke', 'revoked')
    `;
    return rows[0].n;
  }

  async countRetainedLocalGrants(accountId: AccountId, daemonId: DaemonId): Promise<number> {
    const rows = await this.sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM local_browser_grants
      WHERE account_id = ${accountId} AND daemon_id = ${daemonId}
    `;
    return rows[0].n;
  }

  async beginLocalGrantControl(
    grantId: string,
    state: LocalGrantState,
    requestId: string,
    action: LocalGrantControlAction,
    now: number,
  ): Promise<LocalGrantRecord | undefined> {
    const revokedAt = action === "revoke" || action === "sync_revoke" ? now : null;
    const rows = await this.sql<LocalGrantRecord[]>`
      UPDATE local_browser_grants SET
        state = ${state}, control_request_id = ${requestId}, control_action = ${action},
        error = NULL, updated_at = ${now},
        revoked_at = CASE WHEN ${revokedAt}::double precision IS NULL THEN revoked_at ELSE ${revokedAt} END
      WHERE grant_id = ${grantId}
      RETURNING *
    `;
    return rows[0];
  }

  /** 只接收当前 control request 的 ack；重连后迟到的旧 ack 不得覆盖新状态。 */
  async applyLocalGrantAck(requestId: string, grantId: string, daemonId: DaemonId, ok: boolean, error: string | null, now: number): Promise<LocalGrantRecord | undefined> {
    const rows = await this.sql<LocalGrantRecord[]>`
      UPDATE local_browser_grants SET
        state = CASE
          WHEN ${ok} AND control_action IN ('revoke', 'sync_revoke') THEN 'revoked'
          WHEN ${ok} THEN 'active'
          WHEN control_action IN ('revoke', 'sync_revoke') THEN 'pending_revoke'
          ELSE 'install_failed'
        END,
        error = ${ok ? null : error},
        control_request_id = NULL,
        control_action = NULL,
        updated_at = ${now}
      WHERE grant_id = ${grantId} AND daemon_id = ${daemonId} AND control_request_id = ${requestId}
      RETURNING *
    `;
    return rows[0];
  }

  async createLocalLease(lease: OnlineDeviceLease, clientTokenHash: string | null, createdAt: number): Promise<LocalLeaseRecord> {
    const rows = await this.sql<LocalLeaseRecord[]>`
      INSERT INTO local_device_leases (
        lease_id, grant_id, account_id, daemon_id, client_token_hash, scopes, expires_at, created_at, revoked
      ) VALUES (
        ${lease.leaseId}, ${lease.grantId}, ${lease.accountId}, ${lease.daemonId}, ${clientTokenHash},
        ${lease.scopes}, ${lease.expiresAt}, ${createdAt}, false
      ) RETURNING *
    `;
    return rows[0];
  }

  async countActiveLocalLeases(accountId: AccountId, daemonId: DaemonId, now: number): Promise<number> {
    const rows = await this.sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM local_device_leases
      WHERE account_id = ${accountId} AND daemon_id = ${daemonId} AND revoked = false AND expires_at > ${now}
    `;
    return rows[0].n;
  }

  async revokeLocalLeasesForGrant(grantId: string): Promise<void> {
    await this.sql`UPDATE local_device_leases SET revoked = true WHERE grant_id = ${grantId}`;
  }

  async revokeLocalLeasesForDaemon(daemonId: DaemonId): Promise<void> {
    await this.sql`UPDATE local_device_leases SET revoked = true WHERE daemon_id = ${daemonId} AND revoked = false`;
  }

  async pruneLocalControlState(now: number): Promise<void> {
    await this.sql`DELETE FROM local_device_leases WHERE revoked = true OR expires_at <= ${now}`;
    // 已确认撤销的 grant 仍保留一段时间作为重连 revoke tombstone；避免表无限增长。
    await this.sql`
      DELETE FROM local_browser_grants
      WHERE state = 'revoked' AND revoked_at IS NOT NULL AND revoked_at < ${now - 30 * 24 * 60 * 60 * 1000}
    `;
  }

  /* ---------------------------- projects --------------------------- */
  async createProject(p: Project): Promise<Project> {
    await this.sql`
      INSERT INTO projects ${this.sql(p, "id", "accountId", "daemonId", "name", "repoPath", "defaultBranch", "createdAt")}
    `;
    return p;
  }
  async getProject(id: ProjectId): Promise<Project | undefined> {
    const rows = await this.sql<Project[]>`SELECT * FROM projects WHERE id = ${id}`;
    return rows[0] && create(ProjectSchema, rows[0]);
  }
  async listProjects(accountId: AccountId): Promise<Project[]> {
    const rows = await this.sql<Project[]>`SELECT * FROM projects WHERE account_id = ${accountId} ORDER BY created_at`;
    return rows.map((r) => create(ProjectSchema, r));
  }
  async listProjectsByDaemon(daemonId: DaemonId): Promise<Project[]> {
    const rows = await this.sql<Project[]>`SELECT * FROM projects WHERE daemon_id = ${daemonId}`;
    return rows.map((r) => create(ProjectSchema, r));
  }
  async listDeletingProjectsByDaemon(daemonId: DaemonId): Promise<Project[]> {
    const rows = await this.sql<Project[]>`SELECT * FROM projects WHERE daemon_id = ${daemonId} AND deleting = true`;
    return rows.map((r) => create(ProjectSchema, r));
  }
  /** 默认分支的真相是 daemon 本地的 origin/HEAD，DB 只是缓存；daemon 核对后上报纠正（plan 072）。 */
  async updateProjectDefaultBranch(id: ProjectId, defaultBranch: string): Promise<Project | undefined> {
    const rows = await this.sql<Project[]>`
      UPDATE projects SET default_branch = ${defaultBranch} WHERE id = ${id} RETURNING *
    `;
    return rows[0] && create(ProjectSchema, rows[0]);
  }
  async updateProjectName(id: ProjectId, name: string): Promise<Project | undefined> {
    const rows = await this.sql<Project[]>`UPDATE projects SET name = ${name} WHERE id = ${id} RETURNING *`;
    return rows[0] && create(ProjectSchema, rows[0]);
  }
  async markProjectDeleting(id: ProjectId): Promise<void> {
    await this.sql`UPDATE projects SET deleting = true WHERE id = ${id}`;
  }
  async isProjectDeleting(id: ProjectId): Promise<boolean> {
    const rows = await this.sql<{ deleting: boolean }[]>`SELECT deleting FROM projects WHERE id = ${id}`;
    return rows[0]?.deleting ?? false;
  }
  /** 必须在 transaction() 内调用；与 project 删除共用行锁，避免迟到的 worktree report
   * 在 finalizer 已读取子项后重新插入 workspace。 */
  async claimActiveProject(id: ProjectId): Promise<Project | undefined> {
    const rows = await this.sql<Project[]>`SELECT * FROM projects WHERE id = ${id} AND deleting = false FOR UPDATE`;
    return rows[0] && create(ProjectSchema, rows[0]);
  }
  /** 必须在 transaction() 内调用；串行化 project 删除的最终收口，避免重复广播/级联。 */
  async claimDeletingProject(id: ProjectId): Promise<Project | undefined> {
    const rows = await this.sql<Project[]>`SELECT * FROM projects WHERE id = ${id} AND deleting = true FOR UPDATE`;
    return rows[0] && create(ProjectSchema, rows[0]);
  }
  async removeProject(id: ProjectId): Promise<void> {
    await this.sql`DELETE FROM projects WHERE id = ${id}`;
  }

  /* --------------------------- workspaces -------------------------- */
  async createWorkspace(w: Workspace): Promise<Workspace> {
    const row: WorkspaceRow = { ...w, projectId: w.projectId || null };
    await this.sql`
      INSERT INTO workspaces ${this.sql(row, "id", "accountId", "daemonId", "projectId", "name", "path", "branch", "isMain", "createdAt", "additions", "deletions")}
    `;
    return w;
  }
  async getWorkspace(id: WorkspaceId): Promise<Workspace | undefined> {
    const rows = await this.sql<WorkspaceRow[]>`SELECT * FROM workspaces WHERE id = ${id}`;
    return rows[0] && rowToWorkspace(rows[0]);
  }
  async listWorkspaces(accountId: AccountId): Promise<Workspace[]> {
    const rows = await this.sql<WorkspaceRow[]>`SELECT * FROM workspaces WHERE account_id = ${accountId} ORDER BY is_main DESC, created_at`;
    return rows.map(rowToWorkspace);
  }
  async listWorkspacesByProject(projectId: ProjectId): Promise<Workspace[]> {
    const rows = await this.sql<WorkspaceRow[]>`SELECT * FROM workspaces WHERE project_id = ${projectId}`;
    return rows.map(rowToWorkspace);
  }
  async listWorkspacesByDaemon(daemonId: DaemonId): Promise<Workspace[]> {
    const rows = await this.sql<WorkspaceRow[]>`SELECT * FROM workspaces WHERE daemon_id = ${daemonId}`;
    return rows.map(rowToWorkspace);
  }
  async updateWorkspaceName(id: WorkspaceId, name: string): Promise<Workspace | undefined> {
    const rows = await this.sql<WorkspaceRow[]>`UPDATE workspaces SET name = ${name} WHERE id = ${id} RETURNING *`;
    return rows[0] && rowToWorkspace(rows[0]);
  }
  async updateWorkspaceBranch(id: WorkspaceId, branch: string, alsoName: boolean): Promise<Workspace | undefined> {
    const rows = alsoName
      ? await this.sql<WorkspaceRow[]>`UPDATE workspaces SET branch = ${branch}, name = ${branch} WHERE id = ${id} RETURNING *`
      : await this.sql<WorkspaceRow[]>`UPDATE workspaces SET branch = ${branch} WHERE id = ${id} RETURNING *`;
    return rows[0] && rowToWorkspace(rows[0]);
  }
  async updateWorkspaceDiff(id: WorkspaceId, additions: number, deletions: number): Promise<Workspace | undefined> {
    const rows = await this.sql<WorkspaceRow[]>`
      UPDATE workspaces SET additions = ${additions}, deletions = ${deletions} WHERE id = ${id} RETURNING *
    `;
    return rows[0] && rowToWorkspace(rows[0]);
  }
  async removeWorkspace(id: WorkspaceId): Promise<void> {
    await this.sql`DELETE FROM workspaces WHERE id = ${id}`;
  }

  /* ----------------------------- tasks ----------------------------- */
  async listTasks(accountId: AccountId): Promise<Task[]> {
    const rows = await this.sql<TaskRow[]>`SELECT * FROM tasks WHERE account_id = ${accountId} ORDER BY created_at`;
    return rows.map(rowToTask);
  }
  async getTask(id: TaskId): Promise<Task | undefined> {
    const rows = await this.sql<TaskRow[]>`SELECT * FROM tasks WHERE id = ${id}`;
    return rows[0] && rowToTask(rows[0]);
  }
  async getTaskBySession(sessionId: SessionId): Promise<Task | undefined> {
    const rows = await this.sql<TaskRow[]>`SELECT * FROM tasks WHERE session_id = ${sessionId}`;
    return rows[0] && rowToTask(rows[0]);
  }
  async listTasksByWorkspace(workspaceId: WorkspaceId): Promise<Task[]> {
    const rows = await this.sql<TaskRow[]>`SELECT * FROM tasks WHERE workspace_id = ${workspaceId}`;
    return rows.map(rowToTask);
  }
  async listRunningTasksByDaemon(daemonId: DaemonId): Promise<Task[]> {
    const rows = await this.sql<TaskRow[]>`SELECT * FROM tasks WHERE daemon_id = ${daemonId} AND status = 'running'`;
    return rows.map(rowToTask);
  }
  async listTasksByDaemon(daemonId: DaemonId): Promise<Task[]> {
    const rows = await this.sql<TaskRow[]>`SELECT * FROM tasks WHERE daemon_id = ${daemonId}`;
    return rows.map(rowToTask);
  }
  async createTask(t: Task): Promise<Task> {
    const row = { id: t.id, accountId: t.accountId, daemonId: t.daemonId, projectId: t.projectId || null, workspaceId: t.workspaceId, title: t.title, status: taskStatusToDb(t.status), sessionId: t.sessionId ?? null, exitCode: t.exitCode ?? null, createdAt: t.createdAt, updatedAt: t.updatedAt };
    await this.sql`
      INSERT INTO tasks ${this.sql(row, "id", "accountId", "daemonId", "projectId", "workspaceId", "title", "status", "sessionId", "exitCode", "createdAt", "updatedAt")}
    `;
    return t;
  }
  /** 单语句 UPDATE ... RETURNING：与 removeTask 并发时"先读后写"会把已删的行拼回内存对象返回，
   * 调用方 emitTask 广播出去就是复活的僵尸任务（web 侧 taskRemoved 之后又收到 taskUpdated）。
   * patch 语义与对象 spread 一致：键存在即写入（undefined → NULL 清空），键缺席保持原值。 */
  async updateTask(id: TaskId, patch: Partial<Pick<Task, "status" | "sessionId" | "exitCode" | "title">>): Promise<Task | undefined> {
    const set: Record<string, unknown> = { updatedAt: Date.now() };
    if ("status" in patch) set.status = taskStatusToDb(patch.status!);
    if ("sessionId" in patch) set.sessionId = patch.sessionId ?? null;
    if ("exitCode" in patch) set.exitCode = patch.exitCode ?? null;
    if ("title" in patch) set.title = patch.title;
    const rows = await this.sql<TaskRow[]>`
      UPDATE tasks SET ${this.sql(set, ...Object.keys(set))} WHERE id = ${id} RETURNING *
    `;
    return rows[0] && rowToTask(rows[0]);
  }
  /** sessionStarted 的单语句 CAS：只能把仍绑定同一 session 的本账号/设备任务转为 RUNNING。
   * 即使旧事件在 sessionExit 清空绑定后才落到这里，也不能制造 RUNNING + NULL session_id。 */
  async runTaskIfSession(
    id: TaskId,
    accountId: AccountId,
    daemonId: DaemonId,
    sessionId: SessionId,
  ): Promise<Task | undefined> {
    const rows = await this.sql<TaskRow[]>`
      UPDATE tasks
      SET status = 'running', exit_code = NULL, updated_at = ${Date.now()}
      WHERE id = ${id}
        AND account_id = ${accountId}
        AND daemon_id = ${daemonId}
        AND session_id = ${sessionId}
        AND status <> 'running'
      RETURNING *
    `;
    return rows[0] && rowToTask(rows[0]);
  }
  /** sessionExit 的单语句 CAS：事件入口先冻结 taskId，这里再同时核对账号、设备与
   * session 绑定。即使同一 sessionId 在连接换代后已绑到新 task，旧事件也不会跨行收敛。 */
  async exitTaskIfSession(
    id: TaskId,
    accountId: AccountId,
    daemonId: DaemonId,
    sessionId: SessionId,
    exitCode: number,
  ): Promise<Task | undefined> {
    const rows = await this.sql<TaskRow[]>`
      UPDATE tasks
      SET status = 'exited', session_id = NULL, exit_code = ${exitCode}, updated_at = ${Date.now()}
      WHERE id = ${id}
        AND account_id = ${accountId}
        AND daemon_id = ${daemonId}
        AND session_id = ${sessionId}
      RETURNING *
    `;
    return rows[0] && rowToTask(rows[0]);
  }
  /** catalog 反向收敛的条件更新：读取快照后 sessionExit/remove 可能并发先落库，必须把
   * account/daemon/status/session 四个判据留在同一条 UPDATE，避免把真实 exitCode 覆盖成未知。 */
  async exitRunningTaskIfSession(
    id: TaskId,
    accountId: AccountId,
    daemonId: DaemonId,
    sessionId: SessionId,
  ): Promise<Task | undefined> {
    const rows = await this.sql<TaskRow[]>`
      UPDATE tasks
      SET status = 'exited', session_id = NULL, exit_code = NULL, updated_at = ${Date.now()}
      WHERE id = ${id}
        AND account_id = ${accountId}
        AND daemon_id = ${daemonId}
        AND status = 'running'
        AND session_id = ${sessionId}
      RETURNING *
    `;
    return rows[0] && rowToTask(rows[0]);
  }
  async removeTask(id: TaskId): Promise<void> {
    await this.sql`DELETE FROM tasks WHERE id = ${id}`;
  }
  /** agent terminalNew 已提交、但 control WS 同步发送失败时的补偿 CAS。只删除尚未启动且仍
   * 绑定本次随机 sessionId 的新任务，绝不误删已经被 sessionStarted 推进的 incarnation。 */
  async removeIdleTaskIfSession(
    id: TaskId,
    accountId: AccountId,
    daemonId: DaemonId,
    sessionId: SessionId,
  ): Promise<Task | undefined> {
    const rows = await this.sql<TaskRow[]>`
      DELETE FROM tasks
      WHERE id = ${id} AND account_id = ${accountId} AND daemon_id = ${daemonId}
        AND status = 'idle' AND session_id = ${sessionId}
      RETURNING *
    `;
    return rows[0] && rowToTask(rows[0]);
  }
  /** 删除并原样返回被删任务的 id（单语句 DELETE ... RETURNING，天然原子，无需先查后删）。 */
  async removeTasksByWorkspace(workspaceId: WorkspaceId): Promise<TaskId[]> {
    const rows = await this.sql<{ id: TaskId }[]>`DELETE FROM tasks WHERE workspace_id = ${workspaceId} RETURNING id`;
    return rows.map((r) => r.id);
  }
  async removeTasksByDaemon(daemonId: DaemonId): Promise<TaskId[]> {
    const rows = await this.sql<{ id: TaskId }[]>`DELETE FROM tasks WHERE daemon_id = ${daemonId} RETURNING id`;
    return rows.map((r) => r.id);
  }

  /* ---------------------- prepared operations ---------------------- */
  async createPreparedOperation(operation: NewPreparedOperation): Promise<PreparedOperationRecord | undefined> {
    const now = Date.now();
    const rows = await this.sql<PreparedOperationRecord[]>`
      INSERT INTO prepared_device_operations (
        operation_id, account_id, daemon_id, kind, target_id, target_version, frame, metadata,
        expires_at, state, completed, created_at, updated_at
      ) VALUES (
        ${operation.operationId}, ${operation.accountId}, ${operation.daemonId}, ${operation.kind},
        ${operation.targetId}, ${operation.targetVersion}, ${Buffer.from(operation.frame)}, ${operation.metadata},
        ${operation.expiresAt}, 'pending_install', false, ${now}, ${now}
      )
      ON CONFLICT DO NOTHING
      RETURNING *
    `;
    return rows[0];
  }

  async getPreparedOperation(operationId: string): Promise<PreparedOperationRecord | undefined> {
    const rows = await this.sql<PreparedOperationRecord[]>`
      SELECT * FROM prepared_device_operations WHERE operation_id = ${operationId}
    `;
    return rows[0];
  }

  async findActivePreparedOperation(accountId: AccountId, kind: string, targetId: string, now: number): Promise<PreparedOperationRecord | undefined> {
    const rows = await this.sql<PreparedOperationRecord[]>`
      SELECT * FROM prepared_device_operations
      WHERE account_id = ${accountId} AND kind = ${kind} AND target_id = ${targetId}
        AND completed = false AND expires_at > ${now} AND state <> 'expired'
      ORDER BY created_at DESC LIMIT 1
    `;
    return rows[0];
  }

  async findLatestPreparedOperation(accountId: AccountId, daemonId: DaemonId, kind: string, targetId: string): Promise<PreparedOperationRecord | undefined> {
    const rows = await this.sql<PreparedOperationRecord[]>`
      SELECT * FROM prepared_device_operations
      WHERE account_id = ${accountId} AND daemon_id = ${daemonId} AND kind = ${kind} AND target_id = ${targetId}
      ORDER BY created_at DESC LIMIT 1
    `;
    return rows[0];
  }

  async countActivePreparedOperations(accountId: AccountId, daemonId: DaemonId, now: number): Promise<number> {
    const rows = await this.sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM prepared_device_operations
      WHERE account_id = ${accountId} AND daemon_id = ${daemonId}
        AND completed = false AND expires_at > ${now} AND state <> 'expired'
    `;
    return rows[0].n;
  }

  async listInstallablePreparedOperations(daemonId: DaemonId, now: number): Promise<PreparedOperationRecord[]> {
    return this.sql<PreparedOperationRecord[]>`
      SELECT operation.*
      FROM prepared_device_operations AS operation
      JOIN devices AS device
        ON device.id = operation.daemon_id AND device.account_id = operation.account_id
      WHERE operation.daemon_id = ${daemonId} AND device.revoked = false
        AND operation.completed = false AND operation.expires_at > ${now}
        AND operation.state IN ('pending_install', 'installed', 'install_failed')
      ORDER BY operation.created_at LIMIT 1024
    `;
  }

  async listReadyPreparedOperations(accountId: AccountId, now: number): Promise<PreparedOperationRecord[]> {
    return this.sql<PreparedOperationRecord[]>`
      SELECT operation.*
      FROM prepared_device_operations AS operation
      JOIN devices AS device
        ON device.id = operation.daemon_id AND device.account_id = operation.account_id
      WHERE operation.account_id = ${accountId} AND device.revoked = false
        AND operation.completed = false AND operation.expires_at > ${now}
        AND operation.state = 'installed'
      ORDER BY operation.created_at LIMIT 1024
    `;
  }

  async markPreparedOperationInstalled(operationId: string, daemonId: DaemonId, ok: boolean, error: string | null): Promise<PreparedOperationRecord | undefined> {
    const now = Date.now();
    const rows = await this.sql<PreparedOperationRecord[]>`
      UPDATE prepared_device_operations SET
        state = ${ok ? "installed" : "install_failed"}, install_error = ${ok ? null : error}, updated_at = ${now}
      WHERE operation_id = ${operationId} AND daemon_id = ${daemonId} AND completed = false
        AND expires_at > ${now} AND state IN ('pending_install', 'installed', 'install_failed')
      RETURNING *
    `;
    return rows[0];
  }

  /** 在事务内原子 claim report；重复/并发 report 只有一个调用方拿到记录。 */
  async claimPreparedOperationReport(operationId: string, daemonId: DaemonId): Promise<PreparedOperationRecord | undefined> {
    const rows = await this.sql<PreparedOperationRecord[]>`
      UPDATE prepared_device_operations SET state = 'applying', updated_at = ${Date.now()}
      WHERE operation_id = ${operationId} AND daemon_id = ${daemonId} AND completed = false
        AND state NOT IN ('applying', 'expired')
      RETURNING *
    `;
    return rows[0];
  }

  async finishPreparedOperation(operationId: string, report: DeviceOperationReport): Promise<PreparedOperationRecord | undefined> {
    const rows = await this.sql<PreparedOperationRecord[]>`
      UPDATE prepared_device_operations SET
        state = ${report.ok ? "completed" : "failed"}, completed = true,
        report_ok = ${report.ok}, report_task_id = ${report.taskId ?? null},
        report_session_id = ${report.sessionId ?? null}, report_pid = ${report.pid ?? null},
        report_exit_code = ${report.exitCode ?? null}, report_error = ${report.error ?? null},
        result_frame = ${report.resultFrame ? Buffer.from(report.resultFrame) : null}, updated_at = ${Date.now()}
      WHERE operation_id = ${operationId} AND state = 'applying' AND completed = false
      RETURNING *
    `;
    return rows[0];
  }

  async finishPreparedOperationFromExit(
    operationId: string,
    taskId: TaskId,
    sessionId: SessionId,
    exitCode: number,
  ): Promise<PreparedOperationRecord | undefined> {
    const rows = await this.sql<PreparedOperationRecord[]>`
      UPDATE prepared_device_operations SET
        state = 'completed', completed = true, report_ok = true,
        report_task_id = ${taskId}, report_session_id = ${sessionId}, report_exit_code = ${exitCode},
        report_error = NULL, updated_at = ${Date.now()}
      WHERE operation_id = ${operationId} AND completed = false
      RETURNING *
    `;
    return rows[0];
  }

  async failPreparedOperationConvergence(operationId: string, daemonId: DaemonId, error: string): Promise<PreparedOperationRecord | undefined> {
    const rows = await this.sql<PreparedOperationRecord[]>`
      UPDATE prepared_device_operations SET
        state = 'failed', completed = true, report_ok = false, report_error = ${error}, updated_at = ${Date.now()}
      WHERE operation_id = ${operationId} AND daemon_id = ${daemonId} AND completed = false
      RETURNING *
    `;
    return rows[0];
  }

  /** 永久撤销设备时，在持有 device 父行锁的同一事务内终结其全部 active prepared 记录。
   * 返回 ID 供提交后的易失投递层推进代际、取消 waiter/retry。 */
  async expirePreparedOperationsByDaemon(
    accountId: AccountId,
    daemonId: DaemonId,
    now: number,
  ): Promise<void> {
    await this.sql`
      UPDATE prepared_device_operations SET state = 'expired', updated_at = ${now}
      WHERE account_id = ${accountId} AND daemon_id = ${daemonId}
        AND completed = false AND state <> 'expired'
    `;
  }

  /** task/workspace 删除事务内终结尚未完成的目标 operation。调用方持有对应 device 父行锁，
   * 因此 admission/report 与删除对同一 target 只有一个确定顺序；返回 ID 供提交后同步取消
   * waiter/retry，不能让删除前查到的旧 prepared continuation 再下发。 */
  async expirePreparedOperationsByTarget(
    accountId: AccountId,
    daemonId: DaemonId,
    kind: string,
    targetId: string,
    now: number,
  ): Promise<string[]> {
    const rows = await this.sql<{ operationId: string }[]>`
      UPDATE prepared_device_operations SET state = 'expired', updated_at = ${now}
      WHERE account_id = ${accountId} AND daemon_id = ${daemonId}
        AND kind = ${kind} AND target_id = ${targetId}
        AND completed = false AND state <> 'expired'
      RETURNING operation_id
    `;
    return rows.map((row) => row.operationId);
  }

  async expirePreparedOperations(now: number): Promise<number> {
    const rows = await this.sql<{ count: number }[]>`
      WITH expired AS (
        UPDATE prepared_device_operations SET state = 'expired', updated_at = ${now}
        WHERE completed = false AND expires_at <= ${now} AND state NOT IN ('applying', 'expired')
        RETURNING 1
      )
      SELECT COUNT(*)::int AS count FROM expired
    `;
    // 完成或过期记录只保留 30 天；后者刻意保留 completed=false，让迟到的 session exit
    // 仍可补齐审计结果，但也不能因此永久占用数据库。
    await this.sql`
      DELETE FROM prepared_device_operations
      WHERE (completed = true OR state = 'expired')
        AND updated_at < ${now - 30 * 24 * 60 * 60 * 1000}
    `;
    return rows[0]?.count ?? 0;
  }

  /* ------------------------ oauth clients / tokens ------------------------ */
  async createOAuthClient(client: OAuthClientRecord): Promise<void> {
    await this.sql`
      INSERT INTO oauth_clients (client_id, client_name, redirect_uris, grant_types, token_endpoint_auth_method, metadata, created_at, last_used_at)
      VALUES (
        ${client.clientId}, ${client.clientName}, ${JSON.stringify(client.redirectUris)}, ${JSON.stringify(client.grantTypes)},
        ${client.tokenEndpointAuthMethod}, ${client.metadata}, ${client.createdAt}, ${client.lastUsedAt}
      )
    `;
  }
  async getOAuthClient(clientId: string): Promise<OAuthClientRecord | undefined> {
    const rows = await this.sql<OAuthClientRow[]>`SELECT * FROM oauth_clients WHERE client_id = ${clientId}`;
    return rows[0] && rowToOAuthClient(rows[0]);
  }
  async touchOAuthClient(clientId: string, ts: number): Promise<void> {
    await this.sql`UPDATE oauth_clients SET last_used_at = ${ts} WHERE client_id = ${clientId}`;
  }
  async countOAuthClients(): Promise<number> {
    const rows = await this.sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM oauth_clients`;
    return rows[0].n;
  }

  async insertOAuthToken(token: OAuthTokenRecord): Promise<void> {
    await this.sql`
      INSERT INTO oauth_tokens (token_hash, kind, grant_id, client_id, account_id, user_id, scope, created_at, expires_at, revoked)
      VALUES (
        ${token.tokenHash}, ${token.kind}, ${token.grantId}, ${token.clientId}, ${token.accountId}, ${token.userId},
        ${token.scope}, ${token.createdAt}, ${token.expiresAt}, ${token.revoked}
      )
    `;
  }
  /** 按 hash + 类型取 token 行（含已撤销/已过期的，refresh 重放检测要看到"已撤销"这个事实）。 */
  async getOAuthToken(tokenHash: string, kind: OAuthTokenKind): Promise<OAuthTokenRecord | undefined> {
    const rows = await this.sql<OAuthTokenRecord[]>`SELECT * FROM oauth_tokens WHERE token_hash = ${tokenHash} AND kind = ${kind}`;
    return rows[0];
  }
  async revokeOAuthToken(tokenHash: string): Promise<void> {
    await this.sql`UPDATE oauth_tokens SET revoked = true WHERE token_hash = ${tokenHash}`;
  }
  /** 整链撤销：refresh 重放 / 授权码二次使用时把同一 grant 下的全部 token 作废。 */
  async revokeOAuthGrant(grantId: string): Promise<void> {
    await this.sql`UPDATE oauth_tokens SET revoked = true WHERE grant_id = ${grantId}`;
  }
  /** 清理已撤销 / 已过期的 token，防表无界增长（与 pruneClientTokens 同款，启动时跑）。 */
  async pruneOAuthTokens(now: number): Promise<void> {
    await this.sql`DELETE FROM oauth_tokens WHERE revoked = true OR expires_at <= ${now}`;
  }

  /* ------------------------- checkpoint cache ------------------------ */
  async upsertSessionCheckpoint(accountId: AccountId, daemonId: DaemonId, checkpoint: SessionCheckpoint): Promise<SessionCheckpointRecord | undefined> {
    const now = Date.now();
    const rows = await this.sql<{ sessionId: SessionId }[]>`
      INSERT INTO session_checkpoints (
        session_id, task_id, account_id, daemon_id, snapshot_seq, ansi_snapshot,
        cols, rows, title, captured_at, updated_at
      ) VALUES (
        ${checkpoint.sessionId}, ${checkpoint.taskId}, ${accountId}, ${daemonId}, ${checkpoint.snapshotSeq.toString()},
        ${Buffer.from(checkpoint.ansiSnapshot)}, ${checkpoint.cols}, ${checkpoint.rows}, ${checkpoint.title}, ${checkpoint.capturedAt}, ${now}
      )
      ON CONFLICT (session_id) DO UPDATE SET
        task_id = excluded.task_id,
        account_id = excluded.account_id,
        daemon_id = excluded.daemon_id,
        snapshot_seq = excluded.snapshot_seq,
        ansi_snapshot = excluded.ansi_snapshot,
        cols = excluded.cols,
        rows = excluded.rows,
        title = excluded.title,
        captured_at = excluded.captured_at,
        updated_at = excluded.updated_at
      WHERE session_checkpoints.daemon_id = excluded.daemon_id
        AND session_checkpoints.task_id = excluded.task_id
        AND session_checkpoints.snapshot_seq < excluded.snapshot_seq
      RETURNING session_id
    `;
    // 不 RETURNING *：ansi_snapshot 上百 KB，回传是纯浪费；快照本就在入参里。
    if (!rows[0]) return undefined;
    await this.pruneSessionCheckpoints(accountId, now);
    return {
      sessionId: checkpoint.sessionId,
      taskId: checkpoint.taskId,
      accountId,
      daemonId,
      snapshotSeq: checkpoint.snapshotSeq,
      ansiSnapshot: checkpoint.ansiSnapshot,
      cols: checkpoint.cols,
      rows: checkpoint.rows,
      title: checkpoint.title,
      capturedAt: checkpoint.capturedAt,
      updatedAt: now,
    };
  }

  async getSessionCheckpoint(sessionId: SessionId): Promise<SessionCheckpointRecord | undefined> {
    const rows = await this.sql<SessionCheckpointRow[]>`
      SELECT * FROM session_checkpoints
      WHERE session_id = ${sessionId} AND updated_at >= ${Date.now() - SESSION_CHECKPOINT_RETENTION_MS}
    `;
    return rows[0] && rowToCheckpoint(rows[0]);
  }

  /** 按 task 取最新 checkpoint（plan 074）。agent 读终端必须走这条而不是 getSessionCheckpoint：
   * session 退出时 task.sessionId 被清空（见 hub 的 sessionExit 处理），而「命令跑完了看输出」
   * 恰恰是 agent 最常用的场景——按 session 查在那一刻永远查不到东西。同 task 多次运行时取最新。 */
  async getSessionCheckpointByTask(taskId: TaskId): Promise<SessionCheckpointRecord | undefined> {
    const rows = await this.sql<SessionCheckpointRow[]>`
      SELECT * FROM session_checkpoints
      WHERE task_id = ${taskId} AND updated_at >= ${Date.now() - SESSION_CHECKPOINT_RETENTION_MS}
      ORDER BY captured_at DESC LIMIT 1
    `;
    return rows[0] && rowToCheckpoint(rows[0]);
  }

  async listSessionCheckpoints(accountId: AccountId): Promise<SessionCheckpointRecord[]> {
    await this.pruneSessionCheckpoints(accountId, Date.now());
    const rows = await this.sql<SessionCheckpointRow[]>`
      SELECT * FROM session_checkpoints WHERE account_id = ${accountId} ORDER BY captured_at DESC
    `;
    return rows.map(rowToCheckpoint);
  }

  /** checkpoint 是可丢派生缓存：按账号同时限制保留期、条目数和 BYTEA 总量。 */
  private async pruneSessionCheckpoints(accountId: AccountId, now: number): Promise<void> {
    await this.sql`
      WITH ranked AS (
        SELECT
          session_id,
          updated_at,
          ROW_NUMBER() OVER (ORDER BY updated_at DESC, session_id) AS row_number,
          SUM(OCTET_LENGTH(ansi_snapshot)) OVER (ORDER BY updated_at DESC, session_id) AS cumulative_bytes
        FROM session_checkpoints
        WHERE account_id = ${accountId}
      )
      DELETE FROM session_checkpoints AS checkpoints
      USING ranked
      WHERE checkpoints.session_id = ranked.session_id
        AND (
          ranked.updated_at < ${now - SESSION_CHECKPOINT_RETENTION_MS}
          OR ranked.row_number > ${MAX_SESSION_CHECKPOINTS_PER_ACCOUNT}
          OR ranked.cumulative_bytes > ${MAX_SESSION_CHECKPOINT_BYTES_PER_ACCOUNT}
        )
    `;
  }

  async removeSessionCheckpointsByTask(taskId: TaskId): Promise<void> {
    await this.sql`DELETE FROM session_checkpoints WHERE task_id = ${taskId}`;
  }

  async removeSessionCheckpointsByDaemon(daemonId: DaemonId): Promise<void> {
    await this.sql`DELETE FROM session_checkpoints WHERE daemon_id = ${daemonId}`;
  }
}
