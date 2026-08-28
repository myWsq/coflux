/**
 * Postgres schema 迁移器。
 *
 * 设计约束：
 * - advisory lock、ledger 校验和所有 DDL 必须在同一个事务连接里；并发启动只会有一个执行者。
 * - 旧库没有 ledger 时只允许从完整的 legacy baseline 起步；partial schema 一律 fail-closed。
 * - 数据约束迁移先做只读 preflight；不会为了让约束通过而静默删除、改归属或去重业务数据。
 */
import { createHash, randomInt } from "node:crypto";
import type postgres from "postgres";

type MigrationSql = postgres.TransactionSql<{}>;

interface Migration {
  version: number;
  name: string;
  definition: string;
  apply(sql: MigrationSql): Promise<void>;
}

interface AppliedMigrationRow {
  version: number;
  name: string;
  checksum: string;
  baseline: boolean;
}

interface BaselineIssueRow {
  kind: string;
  objectName: string;
  expected: string;
  actual: string | null;
}

interface ColumnShapeRow {
  schemaName: string;
  tableName: string;
  columnName: string;
  dataType: string;
  notNull: boolean;
  defaultExpression: string | null;
  generatedKind: string;
  identityKind: string;
  collationName: string | null;
  storageKind: string;
  compressionMethod: string;
}

interface IndexShapeRow {
  schemaName: string;
  indexName: string;
  tableName: string;
  isUnique: boolean;
  accessMethod: string;
  keyDefinitions: string[];
  includeDefinitions: string[];
  predicate: string | null;
  isValid: boolean;
  isReady: boolean;
  nullsNotDistinct: boolean;
  isConstraintBacked: boolean;
}

interface TableShapeRow {
  schemaName: string;
  tableName: string;
  relationKind: string;
  persistenceKind: string;
  isPartition: boolean;
  hasSubclass: boolean;
  rowSecurity: boolean;
  forceRowSecurity: boolean;
  accessMethod: string | null;
}

interface LedgerColumnShapeRow extends ColumnShapeRow {
  ordinalPosition: number;
}

interface ConstraintShapeRow {
  schemaName: string;
  tableName: string;
  constraintType: string;
  definition: string;
  validated: boolean;
  deferrable: boolean;
  deferred: boolean;
  noInherit: boolean;
}

interface CatalogObjectRow {
  kind: string;
  objectName: string;
  definition: string;
}

interface PreflightCheck {
  id: string;
  description: string;
  remediation: string;
  query: string;
}

const APP_SCHEMA = "coflux";
const LEGACY_TABLE_NAMES = [
  "accounts",
  "client_tokens",
  "users",
  "memberships",
  "meta",
  "devices",
  "projects",
  "workspaces",
  "tasks",
  "local_gateways",
  "local_browser_grants",
  "local_device_leases",
  "prepared_device_operations",
  "session_checkpoints",
] as const;

// 固定 bigint key；transaction-level lock 会随提交/回滚自动释放，不能换成连接池级 session lock。
const MIGRATION_LOCK_SQL = "SELECT pg_advisory_xact_lock(4851331370698507379::bigint)";

function quoteIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) throw new Error(`非法数据库标识符：${value}`);
  return `"${value}"`;
}

/** migration ledger 是迁移起点的信任根；新建与既有库校验共用同一份冻结定义。 */
function migrationLedgerSql(schema: string): string {
  const s = quoteIdentifier(schema);
  return `
    CREATE TABLE ${s}.schema_migrations (
      version INTEGER PRIMARY KEY CHECK (version > 0),
      name TEXT NOT NULL,
      checksum TEXT NOT NULL CHECK (length(checksum) = 64),
      applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      baseline BOOLEAN NOT NULL DEFAULT false
    )
  `;
}

// legacy 接管先在无锁快照上给出可操作的 partial-schema 诊断；确认形状完整后，再按这一
// 列表一次拿齐最终强锁并复验。把最常发生在途写的 workspaces 放首位：若需等待，不会先
// 占住其余表；等待期间发生在其他表上的 DDL 会被锁后复验捕获。
const LEGACY_BASELINE_LOCK_TABLES = [
  "workspaces",
  ...LEGACY_TABLE_NAMES.filter((table) => table !== "workspaces"),
] as const;
const LEGACY_BASELINE_LOCK_SQL = `
  LOCK TABLE
    ${LEGACY_BASELINE_LOCK_TABLES.map((table) => `${quoteIdentifier(APP_SCHEMA)}.${quoteIdentifier(table)}`).join(",\n    ")}
  IN ACCESS EXCLUSIVE MODE
`;

/** 冻结的 ledger 前 baseline。新库执行它；旧库用同一份定义做 catalog 结构比对。 */
function initialSchemaSql(schema: string): string {
  const s = quoteIdentifier(schema);
  return `
    CREATE TABLE ${s}.accounts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at DOUBLE PRECISION NOT NULL
    );

    CREATE TABLE ${s}.client_tokens (
      token_hash TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      created_at DOUBLE PRECISION NOT NULL,
      revoked BOOLEAN NOT NULL DEFAULT false,
      expires_at DOUBLE PRECISION,
      user_id TEXT
    );

    CREATE TABLE ${s}.users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at DOUBLE PRECISION NOT NULL
    );

    CREATE TABLE ${s}.memberships (
      user_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      role TEXT NOT NULL,
      created_at DOUBLE PRECISION NOT NULL,
      PRIMARY KEY (user_id, account_id)
    );

    CREATE TABLE ${s}.meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE ${s}.devices (
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

    CREATE TABLE ${s}.projects (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      daemon_id TEXT NOT NULL,
      name TEXT NOT NULL,
      repo_path TEXT NOT NULL,
      default_branch TEXT NOT NULL,
      created_at DOUBLE PRECISION NOT NULL
    );

    CREATE TABLE ${s}.workspaces (
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

    CREATE TABLE ${s}.tasks (
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

    CREATE TABLE ${s}.local_gateways (
      daemon_id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      protocol_version INTEGER NOT NULL,
      port INTEGER NOT NULL,
      public_key_sec1 BYTEA NOT NULL,
      updated_at DOUBLE PRECISION NOT NULL
    );

    CREATE TABLE ${s}.local_browser_grants (
      grant_id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      daemon_id TEXT NOT NULL,
      origin TEXT NOT NULL,
      public_key_sec1 BYTEA NOT NULL,
      offline_scopes INTEGER[] NOT NULL,
      client_token_hash TEXT,
      pair_request_id TEXT NOT NULL,
      state TEXT NOT NULL,
      control_request_id TEXT,
      control_action TEXT,
      error TEXT,
      created_at DOUBLE PRECISION NOT NULL,
      updated_at DOUBLE PRECISION NOT NULL,
      revoked_at DOUBLE PRECISION,
      UNIQUE (account_id, pair_request_id)
    );

    CREATE TABLE ${s}.local_device_leases (
      lease_id TEXT PRIMARY KEY,
      grant_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      daemon_id TEXT NOT NULL,
      client_token_hash TEXT,
      scopes INTEGER[] NOT NULL,
      expires_at DOUBLE PRECISION NOT NULL,
      created_at DOUBLE PRECISION NOT NULL,
      revoked BOOLEAN NOT NULL DEFAULT false
    );

    CREATE TABLE ${s}.prepared_device_operations (
      operation_id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      daemon_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      target_id TEXT,
      target_version DOUBLE PRECISION,
      frame BYTEA NOT NULL,
      metadata TEXT NOT NULL,
      expires_at DOUBLE PRECISION NOT NULL,
      state TEXT NOT NULL,
      completed BOOLEAN NOT NULL DEFAULT false,
      install_error TEXT,
      report_ok BOOLEAN,
      report_task_id TEXT,
      report_session_id TEXT,
      report_pid INTEGER,
      report_exit_code INTEGER,
      report_error TEXT,
      result_frame BYTEA,
      created_at DOUBLE PRECISION NOT NULL,
      updated_at DOUBLE PRECISION NOT NULL
    );

    CREATE TABLE ${s}.session_checkpoints (
      session_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      daemon_id TEXT NOT NULL,
      snapshot_seq NUMERIC(20, 0) NOT NULL,
      ansi_snapshot BYTEA NOT NULL,
      cols INTEGER NOT NULL,
      rows INTEGER NOT NULL,
      captured_at DOUBLE PRECISION NOT NULL,
      updated_at DOUBLE PRECISION NOT NULL
    );
  `;
}

const LEGACY_INCREMENTAL_COLUMNS = [
  ["workspaces", "additions"],
  ["workspaces", "deletions"],
  ["projects", "deleting"],
  ["session_checkpoints", "title"],
] as const;

const LEGACY_INDEX_NAMES = [
  "idx_memberships_user",
  "idx_devices_account",
  "idx_devices_token",
  "idx_projects_account",
  "idx_ws_account",
  "idx_ws_project",
  "idx_tasks_account",
  "idx_tasks_workspace",
  "idx_tasks_project",
  "idx_tasks_session",
  "idx_local_gateways_account",
  "idx_local_grants_daemon",
  "idx_local_grants_account",
  "idx_local_grants_token",
  "idx_local_grants_control",
  "idx_local_leases_grant",
  "idx_local_leases_daemon",
  "idx_local_leases_expiry",
  "idx_prepared_daemon",
  "idx_prepared_account",
  "idx_prepared_target",
  "uq_prepared_active_target",
  "idx_checkpoints_account",
  "idx_checkpoints_task",
] as const;

function legacyColumnAndIndexSql(schema: string): string {
  const s = quoteIdentifier(schema);
  return `
    ALTER TABLE ${s}.workspaces ADD COLUMN IF NOT EXISTS additions INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE ${s}.workspaces ADD COLUMN IF NOT EXISTS deletions INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE ${s}.projects ADD COLUMN IF NOT EXISTS deleting BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE ${s}.session_checkpoints ADD COLUMN IF NOT EXISTS title TEXT NOT NULL DEFAULT '';

    CREATE INDEX IF NOT EXISTS idx_memberships_user ON ${s}.memberships(user_id);
    CREATE INDEX IF NOT EXISTS idx_devices_account ON ${s}.devices(account_id);
    CREATE INDEX IF NOT EXISTS idx_devices_token ON ${s}.devices(token_hash);
    CREATE INDEX IF NOT EXISTS idx_projects_account ON ${s}.projects(account_id);
    CREATE INDEX IF NOT EXISTS idx_ws_account ON ${s}.workspaces(account_id);
    CREATE INDEX IF NOT EXISTS idx_ws_project ON ${s}.workspaces(project_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_account ON ${s}.tasks(account_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_workspace ON ${s}.tasks(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_project ON ${s}.tasks(project_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_session ON ${s}.tasks(session_id);
    CREATE INDEX IF NOT EXISTS idx_local_gateways_account ON ${s}.local_gateways(account_id);
    CREATE INDEX IF NOT EXISTS idx_local_grants_daemon ON ${s}.local_browser_grants(daemon_id);
    CREATE INDEX IF NOT EXISTS idx_local_grants_account ON ${s}.local_browser_grants(account_id);
    CREATE INDEX IF NOT EXISTS idx_local_grants_token ON ${s}.local_browser_grants(client_token_hash);
    CREATE INDEX IF NOT EXISTS idx_local_grants_control ON ${s}.local_browser_grants(control_request_id);
    CREATE INDEX IF NOT EXISTS idx_local_leases_grant ON ${s}.local_device_leases(grant_id);
    CREATE INDEX IF NOT EXISTS idx_local_leases_daemon ON ${s}.local_device_leases(daemon_id);
    CREATE INDEX IF NOT EXISTS idx_local_leases_expiry ON ${s}.local_device_leases(expires_at);
    CREATE INDEX IF NOT EXISTS idx_prepared_daemon ON ${s}.prepared_device_operations(daemon_id, completed, expires_at);
    CREATE INDEX IF NOT EXISTS idx_prepared_account ON ${s}.prepared_device_operations(account_id, completed, expires_at);
    CREATE INDEX IF NOT EXISTS idx_prepared_target ON ${s}.prepared_device_operations(account_id, kind, target_id, completed);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_prepared_active_target
      ON ${s}.prepared_device_operations(account_id, kind, target_id)
      WHERE target_id IS NOT NULL AND completed = false AND state <> 'expired';
    CREATE INDEX IF NOT EXISTS idx_checkpoints_account ON ${s}.session_checkpoints(account_id, captured_at DESC);
    CREATE INDEX IF NOT EXISTS idx_checkpoints_task ON ${s}.session_checkpoints(task_id);
  `;
}

const LEGACY_COLUMN_AND_INDEX_SQL = legacyColumnAndIndexSql(APP_SCHEMA);

const CORE_PREFLIGHT_CHECKS: readonly PreflightCheck[] = [
  {
    id: "membership_account_orphan",
    description: "membership 引用了不存在的 account",
    remediation: "补回对应 account 父行，或在确认归属后删除无效 membership",
    query: `
      SELECT m.user_id, m.account_id
      FROM coflux.memberships m
      LEFT JOIN coflux.accounts a ON a.id = m.account_id
      WHERE a.id IS NULL
      ORDER BY m.user_id, m.account_id
      LIMIT 5
    `,
  },
  {
    id: "membership_user_duplicate",
    description: "同一 user 关联了多个 account，违反当前个人账号 1:1 语义",
    remediation: "确认应保留的 account，把业务数据合并后删除其余 membership",
    query: `
      SELECT user_id, COUNT(*)::int AS membership_count, ARRAY_AGG(account_id ORDER BY account_id) AS account_ids
      FROM coflux.memberships
      GROUP BY user_id
      HAVING COUNT(*) > 1
      ORDER BY user_id
      LIMIT 5
    `,
  },
  {
    id: "client_token_account_orphan",
    description: "client token 引用了不存在的 account",
    remediation: "撤销并清理无效 token，或在确认归属后补回对应 account",
    query: `
      SELECT t.token_hash, t.account_id
      FROM coflux.client_tokens t
      LEFT JOIN coflux.accounts a ON a.id = t.account_id
      WHERE a.id IS NULL
      ORDER BY t.token_hash
      LIMIT 5
    `,
  },
  {
    id: "device_account_orphan",
    description: "device 引用了不存在的 account",
    remediation: "补回账号父行，或在确认设备无效后清理该设备及全部子数据",
    query: `
      SELECT d.id AS daemon_id, d.account_id
      FROM coflux.devices d
      LEFT JOIN coflux.accounts a ON a.id = d.account_id
      WHERE a.id IS NULL
      ORDER BY d.id
      LIMIT 5
    `,
  },
  {
    id: "device_token_duplicate",
    description: "多个 device 共用了同一 token hash，认证查询无法确定唯一设备",
    remediation: "撤销重复设备并为保留设备重新登记独立凭证",
    query: `
      SELECT COUNT(*)::int AS device_count, ARRAY_AGG(id ORDER BY id) AS daemon_ids
      FROM coflux.devices
      GROUP BY token_hash
      HAVING COUNT(*) > 1
      ORDER BY token_hash
      LIMIT 5
    `,
  },
  {
    id: "local_gateway_device_mismatch",
    description: "local gateway 的 daemon 不存在，或 account 与设备归属不一致",
    remediation: "清理失效 gateway，或修正其 account_id/daemon_id 归属",
    query: `
      SELECT g.daemon_id, g.account_id, d.account_id AS device_account_id
      FROM coflux.local_gateways g
      LEFT JOIN coflux.devices d ON d.id = g.daemon_id
      WHERE d.id IS NULL OR d.account_id <> g.account_id
      ORDER BY g.daemon_id
      LIMIT 5
    `,
  },
  {
    id: "local_grant_device_mismatch",
    description: "local browser grant 的 daemon 不存在，或 account 与设备归属不一致",
    remediation: "撤销并清理失效 grant/lease，或修正其 account_id/daemon_id 归属",
    query: `
      SELECT g.grant_id, g.account_id, g.daemon_id, d.account_id AS device_account_id
      FROM coflux.local_browser_grants g
      LEFT JOIN coflux.devices d ON d.id = g.daemon_id
      WHERE d.id IS NULL OR d.account_id <> g.account_id
      ORDER BY g.grant_id
      LIMIT 5
    `,
  },
  {
    id: "local_lease_grant_mismatch",
    description: "local device lease 的 grant 不存在，或 account/daemon 与 grant 归属不一致",
    remediation: "撤销并清理失效 lease，或修正其 grant_id/account_id/daemon_id 归属",
    query: `
      SELECT l.lease_id, l.grant_id, l.account_id, l.daemon_id,
             g.account_id AS grant_account_id, g.daemon_id AS grant_daemon_id
      FROM coflux.local_device_leases l
      LEFT JOIN coflux.local_browser_grants g ON g.grant_id = l.grant_id
      WHERE g.grant_id IS NULL OR g.account_id <> l.account_id OR g.daemon_id <> l.daemon_id
      ORDER BY l.lease_id
      LIMIT 5
    `,
  },
  {
    id: "prepared_operation_device_mismatch",
    description: "prepared device operation 的 daemon 不存在，或 account 与设备归属不一致",
    remediation: "将失效 operation 标记完成后清理，或修正其 account_id/daemon_id 归属",
    query: `
      SELECT o.operation_id, o.account_id, o.daemon_id, d.account_id AS device_account_id
      FROM coflux.prepared_device_operations o
      LEFT JOIN coflux.devices d ON d.id = o.daemon_id
      WHERE d.id IS NULL OR d.account_id <> o.account_id
      ORDER BY o.operation_id
      LIMIT 5
    `,
  },
  {
    id: "project_device_mismatch",
    description: "project 的 daemon 不存在，或 project.account_id 与设备归属不一致",
    remediation: "修正 project 的 account_id/daemon_id，或在确认无效后按任务→工作区→项目顺序清理",
    query: `
      SELECT p.id AS project_id, p.account_id, p.daemon_id, d.account_id AS device_account_id
      FROM coflux.projects p
      LEFT JOIN coflux.devices d ON d.id = p.daemon_id
      WHERE d.id IS NULL OR d.account_id <> p.account_id
      ORDER BY p.id
      LIMIT 5
    `,
  },
  {
    id: "workspace_device_mismatch",
    description: "workspace 的 daemon 不存在，或 workspace.account_id 与设备归属不一致",
    remediation: "修正 workspace 归属，或在确认无效后先清理其 task/checkpoint",
    query: `
      SELECT w.id AS workspace_id, w.account_id, w.daemon_id, d.account_id AS device_account_id
      FROM coflux.workspaces w
      LEFT JOIN coflux.devices d ON d.id = w.daemon_id
      WHERE d.id IS NULL OR d.account_id <> w.account_id
      ORDER BY w.id
      LIMIT 5
    `,
  },
  {
    id: "workspace_project_mismatch",
    description: "仓库 workspace 的 project 不存在，或 account/daemon 归属不一致",
    remediation: "修正 project_id 与归属；目录 workspace 应使用空 project_id（迁移后落为 NULL）",
    query: `
      SELECT w.id AS workspace_id, w.account_id, w.daemon_id, w.project_id,
             p.account_id AS project_account_id, p.daemon_id AS project_daemon_id
      FROM coflux.workspaces w
      LEFT JOIN coflux.projects p ON p.id = NULLIF(w.project_id, '')
      WHERE NULLIF(w.project_id, '') IS NOT NULL
        AND (p.id IS NULL OR p.account_id <> w.account_id OR p.daemon_id <> w.daemon_id)
      ORDER BY w.id
      LIMIT 5
    `,
  },
  {
    id: "directory_workspace_duplicate",
    description: "同一账号/设备存在多个目录 workspace，违反 terminalCreate 的幂等语义",
    remediation: "保留 created_at 最早的 canonical workspace，把 task 合并后删除其余记录",
    query: `
      SELECT account_id, daemon_id, COUNT(*)::int AS workspace_count,
             ARRAY_AGG(id ORDER BY created_at, id) AS workspace_ids
      FROM coflux.workspaces
      WHERE NULLIF(project_id, '') IS NULL
      GROUP BY account_id, daemon_id
      HAVING COUNT(*) > 1
      ORDER BY account_id, daemon_id
      LIMIT 5
    `,
  },
  {
    id: "task_workspace_mismatch",
    description: "task 的 workspace 不存在，或 account/daemon/project 与 workspace 不一致",
    remediation: "修正 task 归属；无法确认归属的 task 应连同 checkpoint 一并清理",
    query: `
      SELECT t.id AS task_id, t.account_id, t.daemon_id, t.project_id, t.workspace_id,
             w.account_id AS workspace_account_id, w.daemon_id AS workspace_daemon_id,
             w.project_id AS workspace_project_id
      FROM coflux.tasks t
      LEFT JOIN coflux.workspaces w ON w.id = t.workspace_id
      WHERE w.id IS NULL
         OR w.account_id <> t.account_id
         OR w.daemon_id <> t.daemon_id
         OR NULLIF(w.project_id, '') IS DISTINCT FROM NULLIF(t.project_id, '')
      ORDER BY t.id
      LIMIT 5
    `,
  },
  {
    id: "task_session_duplicate",
    description: "同一非空 session_id 绑定了多个 task",
    remediation: "根据 supervisor catalog 确认唯一 task；其余 task 清空 session_id 并收敛为 exited",
    query: `
      SELECT session_id, COUNT(*)::int AS task_count, ARRAY_AGG(id ORDER BY created_at, id) AS task_ids
      FROM coflux.tasks
      WHERE session_id IS NOT NULL
      GROUP BY session_id
      HAVING COUNT(*) > 1
      ORDER BY session_id
      LIMIT 5
    `,
  },
  {
    id: "checkpoint_task_mismatch",
    description: "checkpoint 的 task 不存在，或 account/daemon 与 task 归属不一致",
    remediation: "checkpoint 是派生缓存；确认 task 已不存在后可删除对应 checkpoint",
    query: `
      SELECT c.session_id, c.task_id, c.account_id, c.daemon_id,
             t.account_id AS task_account_id, t.daemon_id AS task_daemon_id
      FROM coflux.session_checkpoints c
      LEFT JOIN coflux.tasks t ON t.id = c.task_id
      WHERE t.id IS NULL OR t.account_id <> c.account_id OR t.daemon_id <> c.daemon_id
      ORDER BY c.session_id
      LIMIT 5
    `,
  },
];

const CORE_INTEGRITY_SQL = `
  -- 空字符串是旧持久化层对“目录工作区没有 project”的哨兵；NULL 才能让 FK 正确表达可选关系。
  ALTER TABLE coflux.workspaces ALTER COLUMN project_id DROP NOT NULL;
  ALTER TABLE coflux.tasks ALTER COLUMN project_id DROP NOT NULL;
  UPDATE coflux.workspaces SET project_id = NULL WHERE project_id = '';
  UPDATE coflux.tasks SET project_id = NULL WHERE project_id = '';

  -- MATCH SIMPLE 会在 task.project_id 为 NULL 时跳过四列 FK。把可空业务值归一成非空 key，
  -- 目录 workspace/task 都映射为 ''，repo 则映射为真实 project_id，保持 store 写入面不变。
  ALTER TABLE coflux.workspaces
    ADD COLUMN project_key TEXT GENERATED ALWAYS AS (COALESCE(project_id, '')) STORED NOT NULL;
  ALTER TABLE coflux.tasks
    ADD COLUMN project_key TEXT GENERATED ALWAYS AS (COALESCE(project_id, '')) STORED NOT NULL;

  ALTER TABLE coflux.memberships
    ADD CONSTRAINT uq_memberships_user UNIQUE (user_id),
    ADD CONSTRAINT fk_memberships_account FOREIGN KEY (account_id) REFERENCES coflux.accounts(id)
      ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;

  ALTER TABLE coflux.client_tokens
    ADD CONSTRAINT fk_client_tokens_account FOREIGN KEY (account_id) REFERENCES coflux.accounts(id)
      ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;

  ALTER TABLE coflux.devices
    ADD CONSTRAINT uq_devices_token_hash UNIQUE (token_hash),
    ADD CONSTRAINT uq_devices_id_account UNIQUE (id, account_id),
    ADD CONSTRAINT fk_devices_account FOREIGN KEY (account_id) REFERENCES coflux.accounts(id)
      ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;

  ALTER TABLE coflux.local_gateways
    ADD CONSTRAINT fk_local_gateways_device FOREIGN KEY (daemon_id, account_id)
      REFERENCES coflux.devices(id, account_id)
      ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;

  ALTER TABLE coflux.local_browser_grants
    ADD CONSTRAINT uq_local_grants_id_account_daemon UNIQUE (grant_id, account_id, daemon_id),
    ADD CONSTRAINT fk_local_grants_device FOREIGN KEY (daemon_id, account_id)
      REFERENCES coflux.devices(id, account_id)
      ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;

  ALTER TABLE coflux.local_device_leases
    ADD CONSTRAINT fk_local_leases_grant FOREIGN KEY (grant_id, account_id, daemon_id)
      REFERENCES coflux.local_browser_grants(grant_id, account_id, daemon_id)
      ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;

  ALTER TABLE coflux.prepared_device_operations
    ADD CONSTRAINT fk_prepared_operations_device FOREIGN KEY (daemon_id, account_id)
      REFERENCES coflux.devices(id, account_id)
      ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;

  ALTER TABLE coflux.projects
    ADD CONSTRAINT uq_projects_id_account_daemon UNIQUE (id, account_id, daemon_id),
    ADD CONSTRAINT fk_projects_device FOREIGN KEY (daemon_id, account_id)
      REFERENCES coflux.devices(id, account_id)
      ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;

  ALTER TABLE coflux.workspaces
    ADD CONSTRAINT uq_workspaces_id_account_daemon UNIQUE (id, account_id, daemon_id),
    ADD CONSTRAINT uq_workspaces_id_account_daemon_project UNIQUE (id, account_id, daemon_id, project_key),
    ADD CONSTRAINT fk_workspaces_device FOREIGN KEY (daemon_id, account_id)
      REFERENCES coflux.devices(id, account_id)
      ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
    ADD CONSTRAINT fk_workspaces_project FOREIGN KEY (project_id, account_id, daemon_id)
      REFERENCES coflux.projects(id, account_id, daemon_id)
      ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;

  CREATE UNIQUE INDEX uq_workspaces_directory_device
    ON coflux.workspaces(account_id, daemon_id)
    WHERE project_id IS NULL;

  ALTER TABLE coflux.tasks
    ADD CONSTRAINT uq_tasks_id_account_daemon UNIQUE (id, account_id, daemon_id),
    ADD CONSTRAINT fk_tasks_workspace FOREIGN KEY (workspace_id, account_id, daemon_id)
      REFERENCES coflux.workspaces(id, account_id, daemon_id)
      ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
    ADD CONSTRAINT fk_tasks_workspace_project FOREIGN KEY (workspace_id, account_id, daemon_id, project_key)
      REFERENCES coflux.workspaces(id, account_id, daemon_id, project_key)
      ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;

  CREATE UNIQUE INDEX uq_tasks_session
    ON coflux.tasks(session_id)
    WHERE session_id IS NOT NULL;

  ALTER TABLE coflux.session_checkpoints
    ADD CONSTRAINT fk_checkpoints_task FOREIGN KEY (task_id, account_id, daemon_id)
      REFERENCES coflux.tasks(id, account_id, daemon_id)
      ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
`;

const CORE_PREFLIGHT_LOCK_SQL = `
  -- 一次拿到后续 DDL 所需的最终强锁，避免先冻结写入、再升级锁时与在途事务形成环路。
  -- 代价是迁移窗口内短暂阻断核心表读取；单次启动迁移优先选择确定性与 fail-closed。
  LOCK TABLE
    coflux.accounts,
    coflux.users,
    coflux.memberships,
    coflux.client_tokens,
    coflux.devices,
    coflux.local_gateways,
    coflux.local_browser_grants,
    coflux.local_device_leases,
    coflux.prepared_device_operations,
    coflux.projects,
    coflux.workspaces,
    coflux.tasks,
    coflux.session_checkpoints
  IN ACCESS EXCLUSIVE MODE
`;

const MIGRATION_MAX_ATTEMPTS = 4;
const MIGRATION_RETRY_BASE_MS = 25;
const RETRYABLE_MIGRATION_CODES = new Set(["40P01", "55P03"]);

function postgresErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

async function waitBeforeMigrationRetry(attempt: number): Promise<void> {
  const delayMs = attempt * MIGRATION_RETRY_BASE_MS + randomInt(0, MIGRATION_RETRY_BASE_MS + 1);
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

function checksum(migration: Pick<Migration, "version" | "name" | "definition">): string {
  return createHash("sha256")
    .update(`${migration.version}\n${migration.name}\n${migration.definition}`)
    .digest("hex");
}

async function dropExpectedSchema(sql: MigrationSql, schema: string): Promise<void> {
  const expected = quoteIdentifier(schema);
  const dropTables = LEGACY_TABLE_NAMES
    .map((table) => `DROP TABLE ${expected}.${quoteIdentifier(table)}`)
    .join(";\n");
  await sql.unsafe(`${dropTables};\nDROP SCHEMA ${expected}`);
}

function columnShape(row: ColumnShapeRow): string {
  return JSON.stringify({
    dataType: row.dataType,
    notNull: row.notNull,
    defaultExpression: row.defaultExpression,
    generatedKind: row.generatedKind,
    identityKind: row.identityKind,
    collationName: row.collationName,
    storageKind: row.storageKind,
    compressionMethod: row.compressionMethod,
  });
}

function indexShape(row: IndexShapeRow): string {
  return JSON.stringify({
    table: row.tableName,
    unique: row.isUnique,
    accessMethod: row.accessMethod,
    keys: row.keyDefinitions,
    include: row.includeDefinitions,
    predicate: row.predicate,
    valid: row.isValid,
    ready: row.isReady,
    nullsNotDistinct: row.nullsNotDistinct,
    constraintBacked: row.isConstraintBacked,
  });
}

function tableShape(row: TableShapeRow): string {
  return JSON.stringify({
    relationKind: row.relationKind,
    persistenceKind: row.persistenceKind,
    isPartition: row.isPartition,
    hasSubclass: row.hasSubclass,
    rowSecurity: row.rowSecurity,
    forceRowSecurity: row.forceRowSecurity,
    accessMethod: row.accessMethod,
  });
}

function ledgerColumnShape(row: LedgerColumnShapeRow): string {
  return JSON.stringify({
    ordinalPosition: row.ordinalPosition,
    dataType: row.dataType,
    notNull: row.notNull,
    defaultExpression: row.defaultExpression,
    generatedKind: row.generatedKind,
    identityKind: row.identityKind,
    collationName: row.collationName,
    storageKind: row.storageKind,
    compressionMethod: row.compressionMethod,
  });
}

function constraintShape(row: ConstraintShapeRow): string {
  return JSON.stringify({
    type: row.constraintType,
    definition: row.definition,
    validated: row.validated,
    deferrable: row.deferrable,
    deferred: row.deferred,
    noInherit: row.noInherit,
  });
}

/** multiset 差：约束名可由旧 DDL 自定义，按语义 shape 比较并保留重复项计数。 */
function multisetRemainder(left: readonly string[], right: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const value of right) counts.set(value, (counts.get(value) ?? 0) + 1);
  const remainder: string[] = [];
  for (const value of left) {
    const count = counts.get(value) ?? 0;
    if (count === 0) remainder.push(value);
    else if (count === 1) counts.delete(value);
    else counts.set(value, count - 1);
  }
  return remainder;
}

/**
 * ledger 即使为空也决定“这是新库还是已迁移库”，不能只凭表名信任。用同一 backend 的临时
 * canonical 表比对 relation/列/约束/PK 索引，并拒绝会改变写入或读取语义的继承、trigger、rule、
 * RLS policy 与额外 UNIQUE index。普通非唯一辅助索引不改变可接受数据集合，允许保留。
 */
async function validateMigrationLedgerShape(sql: MigrationSql): Promise<void> {
  const backendRows = await sql<{ pid: number }[]>`SELECT pg_backend_pid()::int AS pid`;
  const expectedSchema = `coflux_migration_ledger_expected_${backendRows[0].pid}`;
  await sql.unsafe(`CREATE SCHEMA ${quoteIdentifier(expectedSchema)}`);

  let tables: TableShapeRow[];
  let columns: LedgerColumnShapeRow[];
  let constraints: ConstraintShapeRow[];
  let indexes: IndexShapeRow[];
  let dangerousObjects: CatalogObjectRow[];
  try {
    await sql.unsafe(migrationLedgerSql(expectedSchema));
    tables = await sql.unsafe<TableShapeRow[]>(
      `
        SELECT n.nspname AS "schemaName", c.relname AS "tableName",
               c.relkind AS "relationKind", c.relpersistence AS "persistenceKind",
               c.relispartition AS "isPartition", c.relhassubclass AS "hasSubclass",
               c.relrowsecurity AS "rowSecurity", c.relforcerowsecurity AS "forceRowSecurity",
               am.amname AS "accessMethod"
        FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_catalog.pg_am am ON am.oid = c.relam
        WHERE n.nspname IN ($1, $2) AND c.relname = 'schema_migrations'
      `,
      [expectedSchema, APP_SCHEMA],
    );
    columns = await sql.unsafe<LedgerColumnShapeRow[]>(
      `
        SELECT n.nspname AS "schemaName", c.relname AS "tableName", a.attname AS "columnName",
               a.attnum::int AS "ordinalPosition",
               pg_catalog.format_type(a.atttypid, a.atttypmod) AS "dataType",
               a.attnotnull AS "notNull",
               pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS "defaultExpression",
               a.attgenerated AS "generatedKind", a.attidentity AS "identityKind",
               CASE WHEN a.attcollation = 0 THEN NULL ELSE a.attcollation::regcollation::text END AS "collationName",
               a.attstorage AS "storageKind", a.attcompression AS "compressionMethod"
        FROM pg_catalog.pg_attribute a
        JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE n.nspname IN ($1, $2)
          AND c.relname = 'schema_migrations'
          AND a.attnum > 0
          AND NOT a.attisdropped
      `,
      [expectedSchema, APP_SCHEMA],
    );
    constraints = await sql.unsafe<ConstraintShapeRow[]>(
      `
        SELECT n.nspname AS "schemaName", c.relname AS "tableName",
               k.contype AS "constraintType",
               pg_catalog.pg_get_constraintdef(k.oid, false) AS definition,
               k.convalidated AS validated, k.condeferrable AS deferrable,
               k.condeferred AS deferred, k.connoinherit AS "noInherit"
        FROM pg_catalog.pg_constraint k
        JOIN pg_catalog.pg_class c ON c.oid = k.conrelid
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname IN ($1, $2) AND c.relname = 'schema_migrations'
      `,
      [expectedSchema, APP_SCHEMA],
    );
    indexes = await sql.unsafe<IndexShapeRow[]>(
      `
        SELECT tn.nspname AS "schemaName", ic.relname AS "indexName", tc.relname AS "tableName",
               i.indisunique AS "isUnique", am.amname AS "accessMethod",
               ARRAY(
                 SELECT pg_catalog.pg_get_indexdef(i.indexrelid, position, true)
                 FROM generate_series(1, i.indnkeyatts) AS position
                 ORDER BY position
               ) AS "keyDefinitions",
               ARRAY(
                 SELECT pg_catalog.pg_get_indexdef(i.indexrelid, position, true)
                 FROM generate_series(i.indnkeyatts + 1, i.indnatts) AS position
                 ORDER BY position
               ) AS "includeDefinitions",
               pg_catalog.pg_get_expr(i.indpred, i.indrelid, true) AS predicate,
               i.indisvalid AS "isValid", i.indisready AS "isReady",
               i.indnullsnotdistinct AS "nullsNotDistinct",
               EXISTS (
                 SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.conindid = i.indexrelid
               ) AS "isConstraintBacked"
        FROM pg_catalog.pg_index i
        JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
        JOIN pg_catalog.pg_class tc ON tc.oid = i.indrelid
        JOIN pg_catalog.pg_namespace tn ON tn.oid = tc.relnamespace
        JOIN pg_catalog.pg_am am ON am.oid = ic.relam
        WHERE tn.nspname IN ($1, $2) AND tc.relname = 'schema_migrations'
      `,
      [expectedSchema, APP_SCHEMA],
    );
    dangerousObjects = await sql.unsafe<CatalogObjectRow[]>(
      `
        WITH ledger AS (
          SELECT c.oid
          FROM pg_catalog.pg_class c
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relname = 'schema_migrations'
        )
        SELECT 'extra_inheritance' AS kind,
               format('%I.%I -> %I.%I', pn.nspname, parent.relname, cn.nspname, child.relname) AS "objectName",
               format('inhseqno=%s', i.inhseqno) AS definition
        FROM pg_catalog.pg_inherits i
        JOIN pg_catalog.pg_class parent ON parent.oid = i.inhparent
        JOIN pg_catalog.pg_namespace pn ON pn.oid = parent.relnamespace
        JOIN pg_catalog.pg_class child ON child.oid = i.inhrelid
        JOIN pg_catalog.pg_namespace cn ON cn.oid = child.relnamespace
        WHERE i.inhparent IN (SELECT oid FROM ledger) OR i.inhrelid IN (SELECT oid FROM ledger)
        UNION ALL
        SELECT 'extra_trigger', 'schema_migrations.' || t.tgname,
               pg_catalog.pg_get_triggerdef(t.oid, false) || format(' enabled=%s', t.tgenabled)
        FROM pg_catalog.pg_trigger t
        WHERE t.tgrelid IN (SELECT oid FROM ledger) AND NOT t.tgisinternal
        UNION ALL
        SELECT 'extra_rule', 'schema_migrations.' || r.rulename,
               pg_catalog.pg_get_ruledef(r.oid, false) || format(' enabled=%s', r.ev_enabled)
        FROM pg_catalog.pg_rewrite r
        WHERE r.ev_class IN (SELECT oid FROM ledger) AND r.rulename <> '_RETURN'
        UNION ALL
        SELECT 'extra_policy', 'schema_migrations.' || p.polname,
               format(
                 'command=%s permissive=%s roles=%s using=%s check=%s',
                 p.polcmd, p.polpermissive, p.polroles::text,
                 COALESCE(pg_catalog.pg_get_expr(p.polqual, p.polrelid), ''),
                 COALESCE(pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid), '')
               )
        FROM pg_catalog.pg_policy p
        WHERE p.polrelid IN (SELECT oid FROM ledger)
        ORDER BY kind, "objectName"
      `,
      [APP_SCHEMA],
    );
  } finally {
    const expected = quoteIdentifier(expectedSchema);
    await sql.unsafe(`DROP TABLE ${expected}.schema_migrations; DROP SCHEMA ${expected}`);
  }

  const issues: string[] = [];
  const expectedTable = tables.find((row) => row.schemaName === expectedSchema);
  const actualTable = tables.find((row) => row.schemaName === APP_SCHEMA);
  if (!expectedTable) throw new Error("迁移器内部错误：canonical migration ledger 表不存在");
  if (!actualTable) {
    issues.push(`missing_table:schema_migrations（期望 ${tableShape(expectedTable)}）`);
  } else if (tableShape(actualTable) !== tableShape(expectedTable)) {
    issues.push(
      `table_mismatch:schema_migrations（期望 ${tableShape(expectedTable)}，实际 ${tableShape(actualTable)}）`,
    );
  }

  const expectedColumns = columns.filter((row) => row.schemaName === expectedSchema);
  const actualColumns = columns.filter((row) => row.schemaName === APP_SCHEMA);
  for (const expected of expectedColumns) {
    const actual = actualColumns.find((row) => row.columnName === expected.columnName);
    if (!actual) {
      issues.push(`missing_column:schema_migrations.${expected.columnName}（期望 ${ledgerColumnShape(expected)}）`);
    } else if (ledgerColumnShape(actual) !== ledgerColumnShape(expected)) {
      issues.push(
        `column_mismatch:schema_migrations.${expected.columnName}` +
          `（期望 ${ledgerColumnShape(expected)}，实际 ${ledgerColumnShape(actual)}）`,
      );
    }
  }
  for (const actual of actualColumns) {
    if (!expectedColumns.some((expected) => expected.columnName === actual.columnName)) {
      issues.push(`extra_column:schema_migrations.${actual.columnName}（实际 ${ledgerColumnShape(actual)}）`);
    }
  }

  const expectedConstraintShapes = constraints
    .filter((row) => row.schemaName === expectedSchema)
    .map(constraintShape);
  const actualConstraintShapes = constraints
    .filter((row) => row.schemaName === APP_SCHEMA)
    .map(constraintShape);
  for (const shape of multisetRemainder(expectedConstraintShapes, actualConstraintShapes)) {
    issues.push(`missing_constraint:schema_migrations（期望 ${shape}）`);
  }
  for (const shape of multisetRemainder(actualConstraintShapes, expectedConstraintShapes)) {
    issues.push(`extra_constraint:schema_migrations（实际 ${shape}）`);
  }

  const expectedConstraintIndexes = indexes
    .filter((row) => row.schemaName === expectedSchema && row.isConstraintBacked)
    .map(indexShape);
  const actualConstraintIndexes = indexes
    .filter((row) => row.schemaName === APP_SCHEMA && row.isConstraintBacked)
    .map(indexShape);
  for (const shape of multisetRemainder(expectedConstraintIndexes, actualConstraintIndexes)) {
    issues.push(`missing_constraint_index:schema_migrations（期望 ${shape}）`);
  }
  for (const shape of multisetRemainder(actualConstraintIndexes, expectedConstraintIndexes)) {
    issues.push(`extra_constraint_index:schema_migrations（实际 ${shape}）`);
  }
  for (const actual of indexes) {
    if (actual.schemaName === APP_SCHEMA && actual.isUnique && !actual.isConstraintBacked) {
      issues.push(`unexpected_unique_index:${actual.indexName}（实际 ${indexShape(actual)}）`);
    }
  }
  for (const object of dangerousObjects) {
    issues.push(`${object.kind}:${object.objectName}（实际 ${object.definition}）`);
  }

  if (issues.length === 0) return;
  throw new Error(
    `migration ledger catalog shape 校验失败：${issues.join("；")}。` +
      " schema_migrations 是迁移起点的信任根；拒绝猜测畸形 ledger 的含义，请人工恢复 canonical 结构后重启。",
  );
}

/**
 * v2 的 IF NOT EXISTS 只解决重复执行，不会确认同名对象真的兼容。这里在同一事务中构造
 * canonical 临时 schema，再比较增量列和所有显式命名索引的 catalog shape；任何漂移都回滚 v2 ledger。
 */
async function validateLegacyColumnsAndIndexes(sql: MigrationSql): Promise<void> {
  const backendRows = await sql<{ pid: number }[]>`SELECT pg_backend_pid()::int AS pid`;
  const expectedSchema = `coflux_migration_v2_expected_${backendRows[0].pid}`;
  await sql.unsafe(`CREATE SCHEMA ${quoteIdentifier(expectedSchema)}`);

  let columns: ColumnShapeRow[];
  let indexes: IndexShapeRow[];
  try {
    await sql.unsafe(initialSchemaSql(expectedSchema));
    await sql.unsafe(legacyColumnAndIndexSql(expectedSchema));
    columns = await sql.unsafe<ColumnShapeRow[]>(
      `
        SELECT n.nspname AS "schemaName", c.relname AS "tableName", a.attname AS "columnName",
               pg_catalog.format_type(a.atttypid, a.atttypmod) AS "dataType",
               a.attnotnull AS "notNull",
               pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS "defaultExpression",
               a.attgenerated AS "generatedKind", a.attidentity AS "identityKind",
               CASE WHEN a.attcollation = 0 THEN NULL ELSE a.attcollation::regcollation::text END AS "collationName",
               a.attstorage AS "storageKind", a.attcompression AS "compressionMethod"
        FROM pg_catalog.pg_attribute a
        JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE n.nspname IN ($1, $2)
          AND c.relkind = 'r'
          AND a.attnum > 0
          AND NOT a.attisdropped
      `,
      [expectedSchema, APP_SCHEMA],
    );
    indexes = await sql.unsafe<IndexShapeRow[]>(
      `
        SELECT n.nspname AS "schemaName", ic.relname AS "indexName", tc.relname AS "tableName",
               i.indisunique AS "isUnique", am.amname AS "accessMethod",
               ARRAY(
                 SELECT pg_catalog.pg_get_indexdef(i.indexrelid, position, true)
                 FROM generate_series(1, i.indnkeyatts) AS position
                 ORDER BY position
               ) AS "keyDefinitions",
               ARRAY(
                 SELECT pg_catalog.pg_get_indexdef(i.indexrelid, position, true)
                 FROM generate_series(i.indnkeyatts + 1, i.indnatts) AS position
                 ORDER BY position
               ) AS "includeDefinitions",
               pg_catalog.pg_get_expr(i.indpred, i.indrelid, true) AS predicate,
               i.indisvalid AS "isValid", i.indisready AS "isReady",
               i.indnullsnotdistinct AS "nullsNotDistinct",
               EXISTS (
                 SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.conindid = i.indexrelid
               ) AS "isConstraintBacked"
        FROM pg_catalog.pg_index i
        JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
        JOIN pg_catalog.pg_class tc ON tc.oid = i.indrelid
        JOIN pg_catalog.pg_namespace n ON n.oid = ic.relnamespace
        JOIN pg_catalog.pg_am am ON am.oid = ic.relam
        WHERE n.nspname IN ($1, $2)
      `,
      [expectedSchema, APP_SCHEMA],
    );
  } finally {
    await dropExpectedSchema(sql, expectedSchema);
  }

  const issues: string[] = [];
  for (const [tableName, columnName] of LEGACY_INCREMENTAL_COLUMNS) {
    const expected = columns.find(
      (row) => row.schemaName === expectedSchema && row.tableName === tableName && row.columnName === columnName,
    );
    const actual = columns.find(
      (row) => row.schemaName === APP_SCHEMA && row.tableName === tableName && row.columnName === columnName,
    );
    if (!expected) throw new Error(`迁移器内部错误：canonical v2 缺少 ${tableName}.${columnName}`);
    if (!actual) {
      issues.push(`missing_column:${tableName}.${columnName}（期望 ${columnShape(expected)}）`);
    } else if (columnShape(actual) !== columnShape(expected)) {
      issues.push(
        `column_mismatch:${tableName}.${columnName}（期望 ${columnShape(expected)}，实际 ${columnShape(actual)}）`,
      );
    }
  }

  for (const indexName of LEGACY_INDEX_NAMES) {
    const expected = indexes.find((row) => row.schemaName === expectedSchema && row.indexName === indexName);
    const actual = indexes.find((row) => row.schemaName === APP_SCHEMA && row.indexName === indexName);
    if (!expected) throw new Error(`迁移器内部错误：canonical v2 缺少索引 ${indexName}`);
    if (!actual) {
      issues.push(`missing_index:${indexName}（期望 ${indexShape(expected)}）`);
    } else if (indexShape(actual) !== indexShape(expected)) {
      issues.push(`index_mismatch:${indexName}（期望 ${indexShape(expected)}，实际 ${indexShape(actual)}）`);
    }
  }

  // UNIQUE constraint 自带的索引由 baseline constraint multiset 校验；这里另拒绝未建账的
  // standalone UNIQUE index，避免额外唯一性静默改变正常 INSERT/UPDATE 的可接受集合。
  for (const actual of indexes) {
    if (actual.schemaName !== APP_SCHEMA || !actual.isUnique || actual.isConstraintBacked) continue;
    const expected = indexes.find(
      (row) => row.schemaName === expectedSchema && row.indexName === actual.indexName && !row.isConstraintBacked,
    );
    if (!expected) issues.push(`unexpected_unique_index:${actual.indexName}（实际 ${indexShape(actual)}）`);
  }

  if (issues.length === 0) return;
  throw new Error(
    `migration v2 catalog shape 校验失败：${issues.join("；")}。` +
      " 同名对象与预期定义不兼容；迁移未写入 ledger，当前事务已回滚，请人工修复后重启。",
  );
}

async function runPreflight(sql: MigrationSql): Promise<void> {
  for (const check of CORE_PREFLIGHT_CHECKS) {
    const rows = await sql.unsafe<Record<string, unknown>[]>(check.query);
    if (rows.length === 0) continue;
    throw new Error(
      [
        `数据库完整性 preflight 失败 [${check.id}]：${check.description}。`,
        `示例（最多 5 条）：${JSON.stringify(rows)}。`,
        `修复建议：${check.remediation}。`,
        "迁移未写入 ledger，当前事务已回滚；修复数据后重新启动服务。",
      ].join(" "),
    );
  }
}

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "legacy_baseline",
    definition: initialSchemaSql(APP_SCHEMA),
    async apply(sql) {
      await sql.unsafe(initialSchemaSql(APP_SCHEMA));
    },
  },
  {
    version: 2,
    name: "legacy_columns_and_indexes",
    definition: LEGACY_COLUMN_AND_INDEX_SQL,
    async apply(sql) {
      await sql.unsafe(LEGACY_COLUMN_AND_INDEX_SQL);
      await validateLegacyColumnsAndIndexes(sql);
    },
  },
  {
    version: 3,
    name: "core_relational_integrity",
    definition: `${CORE_PREFLIGHT_LOCK_SQL}\n${CORE_PREFLIGHT_CHECKS.map((check) => `${check.id}\n${check.query}`).join("\n")}\n${CORE_INTEGRITY_SQL}`,
    async apply(sql) {
      // 先等旧 server 的在途事务结束，再一次性冻结核心表读写；preflight 与随后 DDL 不再升级锁。
      await sql.unsafe(CORE_PREFLIGHT_LOCK_SQL);
      await runPreflight(sql);
      await sql.unsafe(CORE_INTEGRITY_SQL);
    },
  },
];

async function validateLegacyBaseline(sql: MigrationSql): Promise<void> {
  const backendRows = await sql<{ pid: number }[]>`SELECT pg_backend_pid()::int AS pid`;
  const expectedSchema = `coflux_migration_expected_${backendRows[0].pid}`;
  await sql.unsafe(`CREATE SCHEMA ${quoteIdentifier(expectedSchema)}`);
  let issues: BaselineIssueRow[];
  try {
    await sql.unsafe(initialSchemaSql(expectedSchema));
    issues = await sql.unsafe<BaselineIssueRow[]>(
      `
        WITH expected_tables AS (
          SELECT c.relname AS table_name, c.relkind, c.relpersistence, c.relispartition, c.relhassubclass,
                 c.relrowsecurity, c.relforcerowsecurity, am.amname AS access_method
          FROM pg_catalog.pg_class c
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          LEFT JOIN pg_catalog.pg_am am ON am.oid = c.relam
          WHERE n.nspname = $1 AND c.relkind = 'r'
        ),
        actual_tables AS (
          SELECT c.relname AS table_name, c.relkind, c.relpersistence, c.relispartition, c.relhassubclass,
                 c.relrowsecurity, c.relforcerowsecurity, am.amname AS access_method
          FROM pg_catalog.pg_class c
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          LEFT JOIN pg_catalog.pg_am am ON am.oid = c.relam
          WHERE n.nspname = $2
            AND c.relkind IN ('r', 'p', 'f')
            AND c.relname <> 'schema_migrations'
        ),
        expected_columns AS (
          SELECT c.relname AS table_name, a.attname AS column_name,
                 pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
                 a.attnotnull, pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS default_expr,
                 a.attgenerated, a.attidentity,
                 CASE WHEN a.attcollation = 0 THEN NULL ELSE a.attcollation::regcollation::text END AS collation_name,
                 a.attstorage, a.attcompression
          FROM pg_catalog.pg_attribute a
          JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
          WHERE n.nspname = $1 AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
        ),
        actual_columns AS (
          SELECT c.relname AS table_name, a.attname AS column_name,
                 pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
                 a.attnotnull, pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS default_expr,
                 a.attgenerated, a.attidentity,
                 CASE WHEN a.attcollation = 0 THEN NULL ELSE a.attcollation::regcollation::text END AS collation_name,
                 a.attstorage, a.attcompression
          FROM pg_catalog.pg_attribute a
          JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
          WHERE n.nspname = $2 AND c.relkind IN ('r', 'p', 'f')
            AND c.relname <> 'schema_migrations'
            AND a.attnum > 0 AND NOT a.attisdropped
        ),
        expected_constraints AS (
          SELECT c.relname AS table_name, k.contype,
                 pg_catalog.pg_get_constraintdef(k.oid, false) AS definition,
                 k.convalidated, k.condeferrable, k.condeferred
          FROM pg_catalog.pg_constraint k
          JOIN pg_catalog.pg_class c ON c.oid = k.conrelid
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1
        ),
        actual_constraints AS (
          SELECT c.relname AS table_name, k.contype,
                 pg_catalog.pg_get_constraintdef(k.oid, false) AS definition,
                 k.convalidated, k.condeferrable, k.condeferred
          FROM pg_catalog.pg_constraint k
          JOIN pg_catalog.pg_class c ON c.oid = k.conrelid
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $2
            AND c.relname IN (SELECT table_name FROM expected_tables)
        ),
        missing_constraints AS (
          SELECT * FROM expected_constraints
          EXCEPT ALL
          SELECT * FROM actual_constraints
        ),
        extra_constraints AS (
          SELECT * FROM actual_constraints
          EXCEPT ALL
          SELECT * FROM expected_constraints
        ),
        actual_inherits AS (
          SELECT format('%I.%I', pn.nspname, parent.relname) AS parent_name,
                 format('%I.%I', cn.nspname, child.relname) AS child_name,
                 i.inhseqno
          FROM pg_catalog.pg_inherits i
          JOIN pg_catalog.pg_class parent ON parent.oid = i.inhparent
          JOIN pg_catalog.pg_namespace pn ON pn.oid = parent.relnamespace
          JOIN pg_catalog.pg_class child ON child.oid = i.inhrelid
          JOIN pg_catalog.pg_namespace cn ON cn.oid = child.relnamespace
          WHERE (pn.nspname = $2 AND parent.relname IN (SELECT table_name FROM expected_tables))
             OR (cn.nspname = $2 AND child.relname IN (SELECT table_name FROM expected_tables))
        ),
        actual_triggers AS (
          SELECT c.relname AS table_name, t.tgname AS trigger_name, t.tgenabled,
                 pg_catalog.pg_get_triggerdef(t.oid, false) AS definition
          FROM pg_catalog.pg_trigger t
          JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $2
            AND c.relname IN (SELECT table_name FROM expected_tables)
            AND NOT t.tgisinternal
        ),
        actual_rules AS (
          SELECT c.relname AS table_name, r.rulename, r.ev_enabled,
                 pg_catalog.pg_get_ruledef(r.oid, false) AS definition
          FROM pg_catalog.pg_rewrite r
          JOIN pg_catalog.pg_class c ON c.oid = r.ev_class
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $2
            AND c.relname IN (SELECT table_name FROM expected_tables)
            AND r.rulename <> '_RETURN'
        )
        SELECT 'missing_table' AS kind, e.table_name AS "objectName",
               jsonb_build_object(
                 'relkind', e.relkind, 'persistence', e.relpersistence, 'partition', e.relispartition,
                 'hasSubclass', e.relhassubclass,
                 'rowSecurity', e.relrowsecurity, 'forceRowSecurity', e.relforcerowsecurity,
                 'accessMethod', e.access_method
               )::text AS expected,
               NULL::text AS actual
        FROM expected_tables e
        LEFT JOIN actual_tables a USING (table_name)
        WHERE a.table_name IS NULL
        UNION ALL
        SELECT 'extra_table', a.table_name,
               '不存在（legacy baseline 只允许冻结表集合）',
               jsonb_build_object(
                 'relkind', a.relkind, 'persistence', a.relpersistence, 'partition', a.relispartition,
                 'hasSubclass', a.relhassubclass,
                 'rowSecurity', a.relrowsecurity, 'forceRowSecurity', a.relforcerowsecurity,
                 'accessMethod', a.access_method
               )::text
        FROM actual_tables a
        LEFT JOIN expected_tables e USING (table_name)
        WHERE e.table_name IS NULL
        UNION ALL
        SELECT 'table_mismatch', e.table_name,
               jsonb_build_object(
                 'relkind', e.relkind, 'persistence', e.relpersistence, 'partition', e.relispartition,
                 'hasSubclass', e.relhassubclass,
                 'rowSecurity', e.relrowsecurity, 'forceRowSecurity', e.relforcerowsecurity,
                 'accessMethod', e.access_method
               )::text,
               jsonb_build_object(
                 'relkind', a.relkind, 'persistence', a.relpersistence, 'partition', a.relispartition,
                 'hasSubclass', a.relhassubclass,
                 'rowSecurity', a.relrowsecurity, 'forceRowSecurity', a.relforcerowsecurity,
                 'accessMethod', a.access_method
               )::text
        FROM expected_tables e
        JOIN actual_tables a USING (table_name)
        WHERE (e.relkind, e.relpersistence, e.relispartition, e.relhassubclass, e.relrowsecurity,
               e.relforcerowsecurity, e.access_method)
          IS DISTINCT FROM
              (a.relkind, a.relpersistence, a.relispartition, a.relhassubclass, a.relrowsecurity,
               a.relforcerowsecurity, a.access_method)
        UNION ALL
        SELECT 'missing_column', e.table_name || '.' || e.column_name,
               jsonb_build_object(
                 'dataType', e.data_type, 'notNull', e.attnotnull, 'defaultExpression', e.default_expr,
                 'generatedKind', e.attgenerated, 'identityKind', e.attidentity,
                 'collationName', e.collation_name, 'storageKind', e.attstorage,
                 'compressionMethod', e.attcompression
               )::text,
               NULL::text
        FROM expected_columns e
        JOIN actual_tables t USING (table_name)
        LEFT JOIN actual_columns a USING (table_name, column_name)
        WHERE a.column_name IS NULL
        UNION ALL
        SELECT 'extra_column', a.table_name || '.' || a.column_name,
               '不存在或属于已知 legacy 增量列',
               jsonb_build_object(
                 'dataType', a.data_type, 'notNull', a.attnotnull, 'defaultExpression', a.default_expr,
                 'generatedKind', a.attgenerated, 'identityKind', a.attidentity,
                 'collationName', a.collation_name, 'storageKind', a.attstorage,
                 'compressionMethod', a.attcompression
               )::text
        FROM actual_columns a
        JOIN expected_tables t USING (table_name)
        LEFT JOIN expected_columns e USING (table_name, column_name)
        WHERE e.column_name IS NULL
          AND (a.table_name, a.column_name) NOT IN (
            ('workspaces', 'additions'), ('workspaces', 'deletions'),
            ('projects', 'deleting'), ('session_checkpoints', 'title')
          )
        UNION ALL
        SELECT 'column_mismatch', e.table_name || '.' || e.column_name,
               jsonb_build_object(
                 'dataType', e.data_type, 'notNull', e.attnotnull, 'defaultExpression', e.default_expr,
                 'generatedKind', e.attgenerated, 'identityKind', e.attidentity,
                 'collationName', e.collation_name, 'storageKind', e.attstorage,
                 'compressionMethod', e.attcompression
               )::text,
               jsonb_build_object(
                 'dataType', a.data_type, 'notNull', a.attnotnull, 'defaultExpression', a.default_expr,
                 'generatedKind', a.attgenerated, 'identityKind', a.attidentity,
                 'collationName', a.collation_name, 'storageKind', a.attstorage,
                 'compressionMethod', a.attcompression
               )::text
        FROM expected_columns e
        JOIN actual_columns a USING (table_name, column_name)
        WHERE (e.data_type, e.attnotnull, e.default_expr, e.attgenerated, e.attidentity,
               e.collation_name, e.attstorage, e.attcompression)
          IS DISTINCT FROM
              (a.data_type, a.attnotnull, a.default_expr, a.attgenerated, a.attidentity,
               a.collation_name, a.attstorage, a.attcompression)
        UNION ALL
        SELECT 'missing_constraint', e.table_name,
               e.contype::text || ' ' || e.definition ||
                 format(' validated=%s deferrable=%s deferred=%s', e.convalidated, e.condeferrable, e.condeferred),
               NULL::text
        FROM missing_constraints e
        UNION ALL
        SELECT 'extra_constraint', a.table_name,
               '不存在（legacy baseline 不允许额外写约束）',
               a.contype::text || ' ' || a.definition ||
                 format(' validated=%s deferrable=%s deferred=%s', a.convalidated, a.condeferrable, a.condeferred)
        FROM extra_constraints a
        UNION ALL
        SELECT 'extra_inheritance', i.parent_name || ' -> ' || i.child_name,
               '不存在（canonical 表不参与 inheritance/partition 关系）',
               format('inhseqno=%s', i.inhseqno)
        FROM actual_inherits i
        UNION ALL
        SELECT 'extra_trigger', t.table_name || '.' || t.trigger_name,
               '不存在（legacy baseline 不允许非内部 trigger）',
               t.definition || format(' enabled=%s', t.tgenabled)
        FROM actual_triggers t
        UNION ALL
        SELECT 'extra_rule', r.table_name || '.' || r.rulename,
               '不存在（legacy baseline 不允许 rewrite rule）',
               r.definition || format(' enabled=%s', r.ev_enabled)
        FROM actual_rules r
        ORDER BY kind DESC, "objectName"
        LIMIT 50
      `,
      [expectedSchema, APP_SCHEMA],
    );
  } finally {
    await dropExpectedSchema(sql, expectedSchema);
  }

  if (issues.length === 0) return;
  const details = issues
    .map((issue) => `${issue.kind}:${issue.objectName}（期望 ${issue.expected}${issue.actual ? `，实际 ${issue.actual}` : ""}）`)
    .join("；");
  throw new Error(
    `检测到没有 migration ledger 的 partial/incompatible schema，拒绝自动补洞：${details}。` +
      " 请从完整备份恢复 legacy baseline，或人工修复表结构后重启；迁移器不会猜测缺失对象是否可安全重建。",
  );
}

async function insertLedger(sql: MigrationSql, migration: Migration, baseline: boolean): Promise<void> {
  await sql`
    INSERT INTO coflux.schema_migrations (version, name, checksum, baseline)
    VALUES (${migration.version}, ${migration.name}, ${checksum(migration)}, ${baseline})
  `;
}

function validateLedger(rows: readonly AppliedMigrationRow[]): Map<number, AppliedMigrationRow> {
  const known = new Map(MIGRATIONS.map((migration) => [migration.version, migration] as const));
  const applied = new Map<number, AppliedMigrationRow>();
  for (const row of rows) {
    const migration = known.get(row.version);
    if (!migration) {
      throw new Error(
        `数据库 schema migration 版本 ${row.version} 高于当前服务可识别范围；拒绝用旧服务启动，请部署不低于该数据库版本的服务。`,
      );
    }
    const expectedChecksum = checksum(migration);
    if (row.name !== migration.name || row.checksum !== expectedChecksum) {
      throw new Error(
        `migration ledger 第 ${row.version} 版与代码不一致（ledger=${row.name}/${row.checksum}，` +
          `code=${migration.name}/${expectedChecksum}）；禁止修改已发布迁移，请恢复匹配版本。`,
      );
    }
    applied.set(row.version, row);
  }
  for (let version = 1; version <= rows.length; version += 1) {
    if (!applied.has(version)) {
      throw new Error(`migration ledger 存在版本断层：缺少 ${version}，禁止跨版本继续迁移。`);
    }
  }
  return applied;
}

/**
 * 运行 schema migration。调用方传顶层连接池；内部 `.begin()` 保证 advisory lock、catalog
 * preflight、DDL 与 ledger INSERT 全在同一事务/同一 backend 上。
 */
async function runSchemaMigrationAttempt(pool: postgres.Sql<{}>): Promise<void> {
  await pool.begin(async (sql) => {
    await sql.unsafe(MIGRATION_LOCK_SQL);

    const schemaRows = await sql<{ exists: boolean }[]>`
      SELECT to_regnamespace('coflux') IS NOT NULL AS exists
    `;
    const ledgerBeforeRows = await sql<{ exists: boolean }[]>`
      SELECT to_regclass('coflux.schema_migrations') IS NOT NULL AS exists
    `;
    const ledgerExisted = ledgerBeforeRows[0].exists;

    if (!schemaRows[0].exists) await sql.unsafe("CREATE SCHEMA coflux");
    if (!ledgerExisted) {
      await sql.unsafe(migrationLedgerSql(APP_SCHEMA));
      // 新表尚未提交，不存在并发 DDL 窗口；仍走 canonical descriptor，防定义与校验漂移。
      await validateMigrationLedgerShape(sql);
    } else {
      // 先给畸形 relation/列/危险对象可操作诊断；通过后拿最终强锁再复验，关闭
      // catalog-check → ledger SELECT/INSERT 的 TOCTOU。ledger 很小，启动迁移期间短暂独占。
      await validateMigrationLedgerShape(sql);
      await sql.unsafe("LOCK TABLE coflux.schema_migrations IN ACCESS EXCLUSIVE MODE");
      await validateMigrationLedgerShape(sql);
    }

    const rows = await sql<AppliedMigrationRow[]>`
      SELECT version, name, checksum, baseline
      FROM coflux.schema_migrations
      ORDER BY version
    `;
    const applied = validateLedger(rows);

    if (!applied.has(1)) {
      if (rows.length > 0) throw new Error("migration ledger 缺少版本 1 baseline，禁止猜测迁移起点。");
      const tableRows = await sql<{ tableName: string }[]>`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'coflux'
          AND table_type = 'BASE TABLE'
          AND table_name <> 'schema_migrations'
        ORDER BY table_name
      `;
      if (tableRows.length === 0) {
        await MIGRATIONS[0].apply(sql);
        await insertLedger(sql, MIGRATIONS[0], false);
      } else {
        if (ledgerExisted) {
          throw new Error(
            "schema_migrations 已存在但为空，同时发现业务表；该状态不是合法 legacy baseline，需人工核对后再启动。",
          );
        }
        // 第一次只读校验保留 missing table/column 等可操作错误；全部通过后冻结完整 canonical
        // 表集合（含 meta），再用新 statement snapshot 复验，关闭 catalog-check → v2 DDL 的 TOCTOU。
        await validateLegacyBaseline(sql);
        await sql.unsafe(LEGACY_BASELINE_LOCK_SQL);
        await validateLegacyBaseline(sql);
        await insertLedger(sql, MIGRATIONS[0], true);
      }
      applied.set(1, {
        version: 1,
        name: MIGRATIONS[0].name,
        checksum: checksum(MIGRATIONS[0]),
        baseline: tableRows.length > 0,
      });
    }

    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      await migration.apply(sql);
      await insertLedger(sql, migration, false);
      applied.set(migration.version, {
        version: migration.version,
        name: migration.name,
        checksum: checksum(migration),
        baseline: false,
      });
    }
  });
}

export async function runSchemaMigrations(pool: postgres.Sql<{}>): Promise<void> {
  for (let attempt = 1; attempt <= MIGRATION_MAX_ATTEMPTS; attempt += 1) {
    try {
      await runSchemaMigrationAttempt(pool);
      return;
    } catch (error) {
      const code = postgresErrorCode(error);
      if (!code || !RETRYABLE_MIGRATION_CODES.has(code)) throw error;
      if (attempt === MIGRATION_MAX_ATTEMPTS) {
        throw new Error(
          `数据库 schema migration 连续 ${MIGRATION_MAX_ATTEMPTS} 次因锁竞争失败（Postgres ${code}）；` +
            "每次整事务尝试均已回滚，不会留下半成品 ledger。请停止并发 schema/长事务后重启服务。",
          { cause: error },
        );
      }
      await waitBeforeMigrationRetry(attempt);
    }
  }
}
