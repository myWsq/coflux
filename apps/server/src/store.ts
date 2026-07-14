/**
 * 服务器持久化层（Postgres，porsager/postgres 客户端）。
 * 持久化：accounts / devices / enrollment_keys / client_tokens / memberships / projects / workspaces / tasks。
 * 运行时（不落盘）：daemon 连接、运行时 session —— 见 hub。
 * token 一律只存 sha256 hash（见 secrets.ts）。
 *
 * 表全部位于独立 schema `coflux`（不用 `public`，避免与 Supabase 自带对象/PostgREST 暴露面混杂）；
 * 连接时用 `connection.search_path` 固定指向它，SQL 里不必显式加 schema 前缀。
 *
 * 列名用 snake_case（Postgres 惯例，免加引号）；应用层对象一律 camelCase（匹配 @coflux/protocol），
 * 由 `transform: postgres.camel` 双向自动转换（结果行自动转 camelCase；`sql(obj, ...cols)` 插入/更新
 * 助手自动把 camelCase 键转 snake_case 列）。时间戳（ms since epoch）用 DOUBLE PRECISION 而非
 * BIGINT——避免 postgres.js 默认把 int8 解析成 string（协议侧类型是 number），float64 精度在这个量级
 * 完全无损。
 */
import postgres from "postgres";
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
} from "@coflux/protocol";

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
  projectId: string;
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
    projectId: r.projectId,
    workspaceId: r.workspaceId,
    title: r.title,
    status: taskStatusFromDb(r.status),
    sessionId: r.sessionId ?? undefined,
    exitCode: r.exitCode ?? undefined,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  });
}

export interface Account {
  id: AccountId;
  name: string;
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

/** 建表 DDL：一个 simple-query 多语句块，启动时幂等执行（CREATE ... IF NOT EXISTS）。 */
const SCHEMA_DDL = `
  CREATE SCHEMA IF NOT EXISTS coflux;

  CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at DOUBLE PRECISION NOT NULL
  );

  CREATE TABLE IF NOT EXISTS enrollment_keys (
    key_hash TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    created_at DOUBLE PRECISION NOT NULL,
    revoked BOOLEAN NOT NULL DEFAULT false
  );

  CREATE TABLE IF NOT EXISTS client_tokens (
    token_hash TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    created_at DOUBLE PRECISION NOT NULL,
    revoked BOOLEAN NOT NULL DEFAULT false,
    expires_at DOUBLE PRECISION,
    user_id TEXT
  );

  CREATE TABLE IF NOT EXISTS memberships (
    user_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    role TEXT NOT NULL,
    created_at DOUBLE PRECISION NOT NULL,
    PRIMARY KEY (user_id, account_id)
  );
  CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id);

  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    name TEXT NOT NULL,
    host TEXT NOT NULL,
    platform TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    created_at DOUBLE PRECISION NOT NULL,
    last_seen_at DOUBLE PRECISION NOT NULL,
    revoked BOOLEAN NOT NULL DEFAULT false
  );
  CREATE INDEX IF NOT EXISTS idx_devices_account ON devices(account_id);
  CREATE INDEX IF NOT EXISTS idx_devices_token ON devices(token_hash);

  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    daemon_id TEXT NOT NULL,
    name TEXT NOT NULL,
    repo_path TEXT NOT NULL,
    default_branch TEXT NOT NULL,
    created_at DOUBLE PRECISION NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_projects_account ON projects(account_id);

  CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    daemon_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    branch TEXT NOT NULL,
    is_main BOOLEAN NOT NULL,
    created_at DOUBLE PRECISION NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ws_account ON workspaces(account_id);
  CREATE INDEX IF NOT EXISTS idx_ws_project ON workspaces(project_id);

  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    daemon_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL,
    session_id TEXT,
    exit_code INTEGER,
    created_at DOUBLE PRECISION NOT NULL,
    updated_at DOUBLE PRECISION NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_tasks_account ON tasks(account_id);
  CREATE INDEX IF NOT EXISTS idx_tasks_workspace ON tasks(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
  CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id);
`;

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

  /** 建连 + 建 schema/表。生产/开发通用；`databaseUrl` 由 config.ts 的 fail-closed 体系提供。 */
  static async connect(databaseUrl: string): Promise<Store> {
    const sql = postgres(databaseUrl, {
      max: 5, // 生产走 Supabase session pooler，免费版客户端连接额度有限，单实例用不了多的
      ssl: "prefer", // 本地自托管通常明文；托管 Supabase pooler 要求 TLS——两边都能连
      transform: postgres.camel,
      connection: { search_path: "coflux" },
    });
    const store = new Store(sql);
    await store.init();
    return store;
  }

  private async init(): Promise<void> {
    await this.sql.unsafe(SCHEMA_DDL);
    await this.migrate();
  }

  /** 轻量列迁移的挂载点（information_schema 查列补列）：当前全新建表已含所有列，暂无需迁移。
   * 保留此方法承接未来的增量 schema 演进，沿用与旧 sqlite 版本相同的思路。 */
  private async migrate(): Promise<void> {
    /* no-op for now */
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

  /* ------------------------ enrollment keys ------------------------ */
  async upsertEnrollmentKey(keyHash: string, accountId: AccountId, createdAt: number): Promise<void> {
    await this.sql`
      INSERT INTO enrollment_keys (key_hash, account_id, created_at, revoked)
      VALUES (${keyHash}, ${accountId}, ${createdAt}, false)
      ON CONFLICT (key_hash) DO NOTHING
    `;
  }
  async createEnrollmentKey(keyHash: string, accountId: AccountId, createdAt: number): Promise<void> {
    await this.sql`
      INSERT INTO enrollment_keys (key_hash, account_id, created_at, revoked)
      VALUES (${keyHash}, ${accountId}, ${createdAt}, false)
    `;
  }
  async accountForEnrollmentKey(keyHash: string): Promise<AccountId | undefined> {
    const rows = await this.sql<{ accountId: string }[]>`
      SELECT account_id FROM enrollment_keys WHERE key_hash = ${keyHash} AND revoked = false
    `;
    return rows[0]?.accountId;
  }

  /* ------------------------ memberships ---------------------------- */
  /** 个人账号 1:1：一个 userId 只有一条 membership。返回其账号与角色。 */
  async getMembershipByUser(userId: string): Promise<{ accountId: AccountId; role: string } | undefined> {
    const rows = await this.sql<{ accountId: string; role: string }[]>`
      SELECT account_id, role FROM memberships WHERE user_id = ${userId} ORDER BY created_at LIMIT 1
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
  async removeProject(id: ProjectId): Promise<void> {
    await this.sql`DELETE FROM projects WHERE id = ${id}`;
  }

  /* --------------------------- workspaces -------------------------- */
  async createWorkspace(w: Workspace): Promise<Workspace> {
    await this.sql`
      INSERT INTO workspaces ${this.sql(w, "id", "accountId", "daemonId", "projectId", "name", "path", "branch", "isMain", "createdAt")}
    `;
    return w;
  }
  async getWorkspace(id: WorkspaceId): Promise<Workspace | undefined> {
    const rows = await this.sql<Workspace[]>`SELECT * FROM workspaces WHERE id = ${id}`;
    return rows[0] && create(WorkspaceSchema, rows[0]);
  }
  async listWorkspaces(accountId: AccountId): Promise<Workspace[]> {
    const rows = await this.sql<Workspace[]>`SELECT * FROM workspaces WHERE account_id = ${accountId} ORDER BY is_main DESC, created_at`;
    return rows.map((r) => create(WorkspaceSchema, r));
  }
  async listWorkspacesByProject(projectId: ProjectId): Promise<Workspace[]> {
    const rows = await this.sql<Workspace[]>`SELECT * FROM workspaces WHERE project_id = ${projectId}`;
    return rows.map((r) => create(WorkspaceSchema, r));
  }
  async listWorkspacesByDaemon(daemonId: DaemonId): Promise<Workspace[]> {
    const rows = await this.sql<Workspace[]>`SELECT * FROM workspaces WHERE daemon_id = ${daemonId}`;
    return rows.map((r) => create(WorkspaceSchema, r));
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
    const row = { id: t.id, accountId: t.accountId, daemonId: t.daemonId, projectId: t.projectId, workspaceId: t.workspaceId, title: t.title, status: taskStatusToDb(t.status), sessionId: t.sessionId ?? null, exitCode: t.exitCode ?? null, createdAt: t.createdAt, updatedAt: t.updatedAt };
    await this.sql`
      INSERT INTO tasks ${this.sql(row, "id", "accountId", "daemonId", "projectId", "workspaceId", "title", "status", "sessionId", "exitCode", "createdAt", "updatedAt")}
    `;
    return t;
  }
  async updateTask(id: TaskId, patch: Partial<Pick<Task, "status" | "sessionId" | "exitCode" | "title">>): Promise<Task | undefined> {
    const existing = await this.getTask(id);
    if (!existing) return undefined;
    const next: Task = { ...existing, ...patch, updatedAt: Date.now() };
    const row = { status: taskStatusToDb(next.status), sessionId: next.sessionId ?? null, exitCode: next.exitCode ?? null, title: next.title, updatedAt: next.updatedAt };
    await this.sql`
      UPDATE tasks SET ${this.sql(row, "status", "sessionId", "exitCode", "title", "updatedAt")} WHERE id = ${id}
    `;
    return next;
  }
  async removeTask(id: TaskId): Promise<void> {
    await this.sql`DELETE FROM tasks WHERE id = ${id}`;
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
}
