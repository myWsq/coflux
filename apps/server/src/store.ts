/**
 * 服务器持久化层（node:sqlite，零原生依赖）。
 * 持久化：accounts / devices / enrollment_keys / client_tokens / projects / workspaces / tasks。
 * 运行时（不落盘）：daemon 连接、运行时 session —— 见 hub。
 * token 一律只存 sha256 hash（见 secrets.ts）。
 */
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  AccountId,
  DaemonId,
  Project,
  ProjectId,
  Task,
  TaskId,
  TaskStatus,
  Workspace,
  WorkspaceId,
  SessionId,
} from "@coflux/protocol";

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
  revoked: number;
}

export class Store {
  private db: DatabaseSync;
  private stmtCache = new Map<string, StatementSync>();

  /** 预编译语句缓存：同一 SQL 只 prepare 一次，避免热路径重复编译（node:sqlite 同步 API） */
  private prep(sql: string): StatementSync {
    let s = this.stmtCache.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmtCache.set(sql, s);
    }
    return s;
  }

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA wal_autocheckpoint = 1000;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, createdAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS enrollment_keys (
        keyHash TEXT PRIMARY KEY, accountId TEXT NOT NULL, createdAt INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS client_tokens (
        tokenHash TEXT PRIMARY KEY, accountId TEXT NOT NULL, createdAt INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0,
        expiresAt INTEGER
      );
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY, value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY, accountId TEXT NOT NULL, name TEXT NOT NULL, host TEXT NOT NULL, platform TEXT NOT NULL,
        tokenHash TEXT NOT NULL,
        createdAt INTEGER NOT NULL, lastSeenAt INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_devices_account ON devices(accountId);
      CREATE INDEX IF NOT EXISTS idx_devices_token   ON devices(tokenHash);
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, accountId TEXT NOT NULL, daemonId TEXT NOT NULL,
        name TEXT NOT NULL, repoPath TEXT NOT NULL, defaultBranch TEXT NOT NULL, createdAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_projects_account ON projects(accountId);
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY, accountId TEXT NOT NULL, daemonId TEXT NOT NULL, projectId TEXT NOT NULL,
        name TEXT NOT NULL, path TEXT NOT NULL, branch TEXT NOT NULL, isMain INTEGER NOT NULL, createdAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ws_account ON workspaces(accountId);
      CREATE INDEX IF NOT EXISTS idx_ws_project ON workspaces(projectId);
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, accountId TEXT NOT NULL, daemonId TEXT NOT NULL, projectId TEXT NOT NULL, workspaceId TEXT NOT NULL,
        title TEXT NOT NULL, status TEXT NOT NULL, sessionId TEXT, exitCode INTEGER,
        createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_account   ON tasks(accountId);
      CREATE INDEX IF NOT EXISTS idx_tasks_workspace ON tasks(workspaceId);
      CREATE INDEX IF NOT EXISTS idx_tasks_project   ON tasks(projectId);
      CREATE INDEX IF NOT EXISTS idx_tasks_session   ON tasks(sessionId);
    `);
    this.migrate();
  }

  /** 轻量 migration：给旧库补新增列（CREATE TABLE IF NOT EXISTS 不改已存在表结构）。 */
  private migrate(): void {
    const cols = this.db.prepare("PRAGMA table_info(client_tokens)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "expiresAt")) {
      // 旧库既有 token expiresAt 为 NULL（视为不过期），仅新签发的带有效期。
      this.db.exec("ALTER TABLE client_tokens ADD COLUMN expiresAt INTEGER");
    }
  }

  /* ------------------------------ meta ----------------------------- */
  getMeta(key: string): string | undefined {
    const row = this.prep("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value;
  }
  setMeta(key: string, value: string): void {
    this.prep("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  /** 在单个事务里执行 fn（级联删除等多语句操作用它保证原子性） */
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* ignore */
      }
      throw err;
    }
  }

  /** 轻量探活（供 /health） */
  ping(): boolean {
    try {
      this.prep("SELECT 1").get();
      return true;
    } catch {
      return false;
    }
  }

  /** 优雅关闭：checkpoint WAL 后关闭句柄 */
  close(): void {
    try {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      /* ignore */
    }
    try {
      this.db.close();
    } catch {
      /* ignore */
    }
  }

  /* ---------------------------- accounts ---------------------------- */
  getAccount(id: AccountId): Account | undefined {
    return this.prep("SELECT * FROM accounts WHERE id = ?").get(id) as unknown as Account | undefined;
  }
  createAccount(a: Account): Account {
    this.prep("INSERT INTO accounts (id, name, createdAt) VALUES (?, ?, ?)").run(a.id, a.name, a.createdAt);
    return a;
  }

  /* ------------------------ enrollment keys ------------------------ */
  upsertEnrollmentKey(keyHash: string, accountId: AccountId, createdAt: number): void {
    this.prep("INSERT OR IGNORE INTO enrollment_keys (keyHash, accountId, createdAt, revoked) VALUES (?, ?, ?, 0)").run(keyHash, accountId, createdAt);
  }
  createEnrollmentKey(keyHash: string, accountId: AccountId, createdAt: number): void {
    this.prep("INSERT INTO enrollment_keys (keyHash, accountId, createdAt, revoked) VALUES (?, ?, ?, 0)").run(keyHash, accountId, createdAt);
  }
  accountForEnrollmentKey(keyHash: string): AccountId | undefined {
    const row = this.prep("SELECT accountId FROM enrollment_keys WHERE keyHash = ? AND revoked = 0").get(keyHash) as { accountId: string } | undefined;
    return row?.accountId;
  }

  /* ------------------------- client tokens ------------------------- */
  upsertClientToken(tokenHash: string, accountId: AccountId, createdAt: number, expiresAt: number | null): void {
    this.prep("INSERT OR IGNORE INTO client_tokens (tokenHash, accountId, createdAt, revoked, expiresAt) VALUES (?, ?, ?, 0, ?)").run(tokenHash, accountId, createdAt, expiresAt);
  }
  /** 返回未撤销且未过期（expiresAt 为 NULL 视为不过期）的 token 归属账号。 */
  accountForClientToken(tokenHash: string, now: number): AccountId | undefined {
    const row = this.prep("SELECT accountId FROM client_tokens WHERE tokenHash = ? AND revoked = 0 AND (expiresAt IS NULL OR expiresAt > ?)").get(tokenHash, now) as { accountId: string } | undefined;
    return row?.accountId;
  }
  revokeClientToken(tokenHash: string): void {
    this.prep("UPDATE client_tokens SET revoked = 1 WHERE tokenHash = ?").run(tokenHash);
  }
  revokeAllClientTokens(accountId: AccountId): void {
    this.prep("UPDATE client_tokens SET revoked = 1 WHERE accountId = ?").run(accountId);
  }
  /** 清理已撤销 / 已过期的 token，防表无界增长。 */
  pruneClientTokens(now: number): void {
    this.prep("DELETE FROM client_tokens WHERE revoked = 1 OR (expiresAt IS NOT NULL AND expiresAt <= ?)").run(now);
  }

  /* ---------------------------- devices ---------------------------- */
  createDevice(d: Device): Device {
    this.prep("INSERT INTO devices (id, accountId, name, host, platform, tokenHash, createdAt, lastSeenAt, revoked) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(d.id, d.accountId, d.name, d.host, d.platform, d.tokenHash, d.createdAt, d.lastSeenAt, d.revoked);
    return d;
  }
  getDevice(id: DaemonId): Device | undefined {
    const row = this.prep("SELECT * FROM devices WHERE id = ?").get(id);
    return row ? rowToDevice(row) : undefined;
  }
  getDeviceByTokenHash(tokenHash: string): Device | undefined {
    const row = this.prep("SELECT * FROM devices WHERE tokenHash = ? AND revoked = 0").get(tokenHash);
    return row ? rowToDevice(row) : undefined;
  }
  listDevices(accountId: AccountId): Device[] {
    return this.prep("SELECT * FROM devices WHERE accountId = ? AND revoked = 0 ORDER BY createdAt").all(accountId).map(rowToDevice);
  }
  countDevices(accountId: AccountId): number {
    const row = this.prep("SELECT COUNT(*) AS n FROM devices WHERE accountId = ? AND revoked = 0").get(accountId) as { n: number };
    return row.n;
  }
  touchDevice(id: DaemonId, ts: number): void {
    this.prep("UPDATE devices SET lastSeenAt = ? WHERE id = ?").run(ts, id);
  }
  revokeDevice(id: DaemonId): void {
    this.prep("UPDATE devices SET revoked = 1 WHERE id = ?").run(id);
  }

  /* ---------------------------- projects --------------------------- */
  createProject(p: Project): Project {
    this.prep("INSERT INTO projects (id, accountId, daemonId, name, repoPath, defaultBranch, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(p.id, p.accountId, p.daemonId, p.name, p.repoPath, p.defaultBranch, p.createdAt);
    return p;
  }
  getProject(id: ProjectId): Project | undefined {
    return this.prep("SELECT * FROM projects WHERE id = ?").get(id) as unknown as Project | undefined;
  }
  listProjects(accountId: AccountId): Project[] {
    return this.prep("SELECT * FROM projects WHERE accountId = ? ORDER BY createdAt").all(accountId) as unknown as Project[];
  }
  listProjectsByDaemon(daemonId: DaemonId): Project[] {
    return this.prep("SELECT * FROM projects WHERE daemonId = ?").all(daemonId) as unknown as Project[];
  }
  removeProject(id: ProjectId): void {
    this.prep("DELETE FROM projects WHERE id = ?").run(id);
  }

  /* --------------------------- workspaces -------------------------- */
  createWorkspace(w: Workspace): Workspace {
    this.prep("INSERT INTO workspaces (id, accountId, daemonId, projectId, name, path, branch, isMain, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(w.id, w.accountId, w.daemonId, w.projectId, w.name, w.path, w.branch, w.isMain ? 1 : 0, w.createdAt);
    return w;
  }
  getWorkspace(id: WorkspaceId): Workspace | undefined {
    const row = this.prep("SELECT * FROM workspaces WHERE id = ?").get(id);
    return row ? rowToWorkspace(row) : undefined;
  }
  listWorkspaces(accountId: AccountId): Workspace[] {
    return this.prep("SELECT * FROM workspaces WHERE accountId = ? ORDER BY isMain DESC, createdAt").all(accountId).map(rowToWorkspace);
  }
  listWorkspacesByProject(projectId: ProjectId): Workspace[] {
    return this.prep("SELECT * FROM workspaces WHERE projectId = ?").all(projectId).map(rowToWorkspace);
  }
  listWorkspacesByDaemon(daemonId: DaemonId): Workspace[] {
    return this.prep("SELECT * FROM workspaces WHERE daemonId = ?").all(daemonId).map(rowToWorkspace);
  }
  removeWorkspace(id: WorkspaceId): void {
    this.prep("DELETE FROM workspaces WHERE id = ?").run(id);
  }

  /* ----------------------------- tasks ----------------------------- */
  listTasks(accountId: AccountId): Task[] {
    return this.prep("SELECT * FROM tasks WHERE accountId = ? ORDER BY createdAt").all(accountId).map(rowToTask);
  }
  getTask(id: TaskId): Task | undefined {
    const row = this.prep("SELECT * FROM tasks WHERE id = ?").get(id);
    return row ? rowToTask(row) : undefined;
  }
  getTaskBySession(sessionId: SessionId): Task | undefined {
    const row = this.prep("SELECT * FROM tasks WHERE sessionId = ?").get(sessionId);
    return row ? rowToTask(row) : undefined;
  }
  listTasksByWorkspace(workspaceId: WorkspaceId): Task[] {
    return this.prep("SELECT * FROM tasks WHERE workspaceId = ?").all(workspaceId).map(rowToTask);
  }
  listRunningTasksByDaemon(daemonId: DaemonId): Task[] {
    return this.prep("SELECT * FROM tasks WHERE daemonId = ? AND status = 'running'").all(daemonId).map(rowToTask);
  }
  listTasksByDaemon(daemonId: DaemonId): Task[] {
    return this.prep("SELECT * FROM tasks WHERE daemonId = ?").all(daemonId).map(rowToTask);
  }
  createTask(t: Task): Task {
    this.prep("INSERT INTO tasks (id, accountId, daemonId, projectId, workspaceId, title, status, sessionId, exitCode, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(t.id, t.accountId, t.daemonId, t.projectId, t.workspaceId, t.title, t.status, t.sessionId, t.exitCode, t.createdAt, t.updatedAt);
    return t;
  }
  updateTask(id: TaskId, patch: Partial<Pick<Task, "status" | "sessionId" | "exitCode" | "title">>): Task | undefined {
    const existing = this.getTask(id);
    if (!existing) return undefined;
    const next: Task = { ...existing, ...patch, updatedAt: Date.now() };
    this.prep("UPDATE tasks SET status = ?, sessionId = ?, exitCode = ?, title = ?, updatedAt = ? WHERE id = ?")
      .run(next.status, next.sessionId, next.exitCode, next.title, next.updatedAt, id);
    return next;
  }
  removeTask(id: TaskId): void {
    this.prep("DELETE FROM tasks WHERE id = ?").run(id);
  }
  removeTasksByWorkspace(workspaceId: WorkspaceId): TaskId[] {
    const ids = this.listTasksByWorkspace(workspaceId).map((t) => t.id);
    this.prep("DELETE FROM tasks WHERE workspaceId = ?").run(workspaceId);
    return ids;
  }
  removeTasksByDaemon(daemonId: DaemonId): TaskId[] {
    const ids = this.listTasksByDaemon(daemonId).map((t) => t.id);
    this.prep("DELETE FROM tasks WHERE daemonId = ?").run(daemonId);
    return ids;
  }
}

function rowToDevice(row: any): Device {
  return {
    id: row.id,
    accountId: row.accountId,
    name: row.name,
    host: row.host,
    platform: row.platform,
    tokenHash: row.tokenHash,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    revoked: row.revoked,
  };
}

function rowToWorkspace(row: any): Workspace {
  return {
    id: row.id,
    accountId: row.accountId,
    daemonId: row.daemonId,
    projectId: row.projectId,
    name: row.name,
    path: row.path,
    branch: row.branch,
    isMain: !!row.isMain,
    createdAt: row.createdAt,
  };
}

function rowToTask(row: any): Task {
  return {
    id: row.id,
    accountId: row.accountId,
    daemonId: row.daemonId,
    projectId: row.projectId,
    workspaceId: row.workspaceId,
    title: row.title,
    status: row.status as TaskStatus,
    sessionId: row.sessionId ?? null,
    exitCode: row.exitCode ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
