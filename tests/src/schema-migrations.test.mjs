import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";
import postgres from "postgres";
import { runSchemaMigrations } from "../../apps/server/src/infra/database/schema-migrations.ts";
import { Store } from "../../apps/server/src/store.ts";
import { Client, createTestDatabase, dropTestDatabase } from "./harness.mjs";

const ROOT = resolve(import.meta.dirname, "..", "..");
const TSX = resolve(ROOT, "node_modules/.bin/tsx");
const SERVER = resolve(ROOT, "apps/server/src/index.ts");
const LEGACY_BASELINE = await readFile(
  resolve(ROOT, "tests/fixtures/postgres-legacy-baseline.sql"),
  "utf8",
);
const EMPTY_CANONICAL_LEDGER = `
  CREATE SCHEMA coflux;
  CREATE TABLE coflux.schema_migrations (
    version INTEGER PRIMARY KEY CHECK (version > 0),
    name TEXT NOT NULL,
    checksum TEXT NOT NULL CHECK (length(checksum) = 64),
    applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    baseline BOOLEAN NOT NULL DEFAULT false
  )
`;

async function freePort() {
  const server = net.createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("无法分配测试端口");
  await new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
  return address.port;
}

function spawnServer(databaseUrl, port, { auth = "password" } = {}) {
  const child = spawn(TSX, [SERVER], {
    cwd: ROOT,
    env: {
      ...process.env,
      COFLUX_DEV: "1",
      COFLUX_AUTH: auth,
      COFLUX_PORT: String(port),
      DATABASE_URL: databaseUrl,
      COFLUX_RELAY_NODES: "[]",
      COFLUX_AUTOUPDATE_REPO: "",
      COFLUX_P2P_ENABLED: "0",
      ...(auth === "local" ? { COFLUX_USERNAME: "admin", COFLUX_PASSWORD: "admin" } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const append = (chunk) => {
    output = (output + chunk.toString()).slice(-128 * 1024);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  const exited = new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  return { child, exited, get output() { return output; } };
}

async function healthOk(port) {
  return new Promise((resolveHealth) => {
    const request = http.get({ host: "127.0.0.1", port, path: "/health", timeout: 500 }, (response) => {
      response.resume();
      resolveHealth(response.statusCode === 200);
    });
    request.on("error", () => resolveHealth(false));
    request.on("timeout", () => {
      request.destroy();
      resolveHealth(false);
    });
  });
}

async function waitHealthy(server, port, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null || server.child.signalCode !== null) {
      throw new Error(`server 在健康检查前退出：${server.output}`);
    }
    if (await healthOk(port)) return;
    await sleep(50);
  }
  throw new Error(`server 健康检查超时：${server.output}`);
}

async function waitExited(server, timeoutMs = 12_000) {
  return Promise.race([
    server.exited,
    sleep(timeoutMs).then(() => {
      throw new Error(`等待 server 退出超时：${server.output}`);
    }),
  ]);
}

async function stopServer(server) {
  if (server.child.exitCode !== null || server.child.signalCode !== null) return;
  server.child.kill("SIGTERM");
  try {
    await Promise.race([server.exited, sleep(2_000).then(() => { throw new Error("timeout"); })]);
  } catch {
    server.child.kill("SIGKILL");
    await server.exited;
  }
}

async function waitFailedExit(server) {
  try {
    return await waitExited(server);
  } finally {
    await stopServer(server);
  }
}

async function waitForValue(read, label, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await sleep(20);
  }
  throw new Error(`等待 ${label} 超时`);
}

async function withDatabase(run) {
  const database = await createTestDatabase();
  const sql = postgres(database.url, { max: 1, ssl: "prefer" });
  try {
    await run({ database, sql });
  } finally {
    await sql.end({ timeout: 0 });
    await dropTestDatabase(database.name);
  }
}

async function installLegacyBaseline(sql) {
  await sql.unsafe(LEGACY_BASELINE);
}

test("runSchemaMigrations 不依赖 postgres.camel，默认 transform pool 可直接迁移", async () => {
  await withDatabase(async ({ sql }) => {
    await runSchemaMigrations(sql);
    const ledger = await sql.unsafe(`SELECT version, baseline FROM coflux.schema_migrations ORDER BY version`);
    assert.deepEqual([...ledger], [
      { version: 1, baseline: false },
      { version: 2, baseline: false },
      { version: 3, baseline: false },
      { version: 4, baseline: false },
    ]);
  });
});

test("canonical 空 migration ledger 无业务表时可安全初始化", async () => {
  await withDatabase(async ({ sql }) => {
    await sql.unsafe(EMPTY_CANONICAL_LEDGER);
    await runSchemaMigrations(sql);
    const ledger = await sql.unsafe(`SELECT version, baseline FROM coflux.schema_migrations ORDER BY version`);
    assert.deepEqual([...ledger], [
      { version: 1, baseline: false },
      { version: 2, baseline: false },
      { version: 3, baseline: false },
      { version: 4, baseline: false },
    ]);
  });
});

const MALFORMED_EMPTY_LEDGER_FIXTURES = [
  {
    name: "列类型、nullable、default 与列集合漂移",
    mutate: `
      ALTER TABLE coflux.schema_migrations ALTER COLUMN version TYPE BIGINT;
      ALTER TABLE coflux.schema_migrations ALTER COLUMN name DROP NOT NULL;
      ALTER TABLE coflux.schema_migrations ALTER COLUMN baseline SET DEFAULT true;
      ALTER TABLE coflux.schema_migrations DROP COLUMN applied_at;
      ALTER TABLE coflux.schema_migrations ADD COLUMN note TEXT;
    `,
    expected: [
      /column_mismatch:schema_migrations\.version/,
      /column_mismatch:schema_migrations\.name/,
      /column_mismatch:schema_migrations\.baseline/,
      /missing_column:schema_migrations\.applied_at/,
      /extra_column:schema_migrations\.note/,
    ],
  },
  {
    name: "PK、CHECK 与唯一性语义漂移",
    mutate: `
      ALTER TABLE coflux.schema_migrations DROP CONSTRAINT schema_migrations_pkey;
      ALTER TABLE coflux.schema_migrations DROP CONSTRAINT schema_migrations_version_check;
      ALTER TABLE coflux.schema_migrations
        ADD CONSTRAINT schema_migrations_name_check CHECK (length(name) > 0);
      CREATE UNIQUE INDEX schema_migrations_version_unique
        ON coflux.schema_migrations(version);
    `,
    expected: [
      /missing_constraint:schema_migrations/,
      /extra_constraint:schema_migrations/,
      /missing_constraint_index:schema_migrations/,
      /unexpected_unique_index:schema_migrations_version_unique/,
    ],
  },
  {
    name: "trigger、rule、RLS policy 与额外 UNIQUE index",
    mutate: `
      CREATE FUNCTION coflux.ledger_passthrough()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RETURN NEW;
      END
      $$;
      CREATE TRIGGER ledger_trigger
        BEFORE INSERT ON coflux.schema_migrations
        FOR EACH ROW EXECUTE FUNCTION coflux.ledger_passthrough();
      CREATE RULE ledger_rule AS
        ON INSERT TO coflux.schema_migrations DO INSTEAD NOTHING;
      CREATE POLICY ledger_policy ON coflux.schema_migrations USING (true);
      CREATE UNIQUE INDEX schema_migrations_name_unique
        ON coflux.schema_migrations(name);
    `,
    expected: [
      /extra_trigger:schema_migrations\.ledger_trigger/,
      /extra_rule:schema_migrations\.ledger_rule/,
      /extra_policy:schema_migrations\.ledger_policy/,
      /unexpected_unique_index:schema_migrations_name_unique/,
    ],
  },
  {
    name: "UNLOGGED 与 inheritance 关系",
    mutate: `
      ALTER TABLE coflux.schema_migrations SET UNLOGGED;
      CREATE UNLOGGED TABLE public.schema_migrations_child ()
        INHERITS (coflux.schema_migrations);
    `,
    expected: [
      /table_mismatch:schema_migrations/,
      /extra_inheritance:coflux\.schema_migrations -> public\.schema_migrations_child/,
    ],
  },
];

for (const fixture of MALFORMED_EMPTY_LEDGER_FIXTURES) {
  test(`空 migration ledger 拒绝 ${fixture.name} 且不创建业务表`, async () => {
    await withDatabase(async ({ sql }) => {
      await sql.unsafe(EMPTY_CANONICAL_LEDGER);
      await sql.unsafe(fixture.mutate);
      await assert.rejects(
        runSchemaMigrations(sql),
        (error) => {
          assert.match(error.message, /migration ledger catalog shape 校验失败/);
          for (const expected of fixture.expected) assert.match(error.message, expected);
          return true;
        },
      );
      const businessTables = await sql.unsafe(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'coflux'
          AND table_type = 'BASE TABLE'
          AND table_name <> 'schema_migrations'
        ORDER BY table_name
      `);
      assert.deepEqual([...businessTables], [], "失败事务不得留下业务表");
      const ledgerRows = await sql.unsafe(`SELECT COUNT(*)::int AS count FROM coflux.schema_migrations`);
      assert.equal(ledgerRows[0].count, 0, "畸形空 ledger 不得被写入版本");
    });
  });
}

test("migration ledger 在两个 server 并发启动时只应用一次，核心 FK 均为可延迟 NO ACTION", async () => {
  await withDatabase(async ({ database, sql }) => {
    const ports = await Promise.all([freePort(), freePort()]);
    const servers = ports.map((port) => spawnServer(database.url, port));
    try {
      await Promise.all(servers.map((server, index) => waitHealthy(server, ports[index])));

      const ledger = await sql.unsafe(`
        SELECT version, name, baseline
        FROM coflux.schema_migrations
        ORDER BY version
      `);
      assert.deepEqual([...ledger], [
        { version: 1, name: "legacy_baseline", baseline: false },
        { version: 2, name: "legacy_columns_and_indexes", baseline: false },
        { version: 3, name: "core_relational_integrity", baseline: false },
        { version: 4, name: "oauth_clients_and_tokens", baseline: false },
      ]);

      const foreignKeys = await sql.unsafe(`
        SELECT conname, confdeltype, condeferrable, condeferred
        FROM pg_catalog.pg_constraint
        WHERE connamespace = 'coflux'::regnamespace AND contype = 'f'
        ORDER BY conname
      `);
      assert.deepEqual(
        foreignKeys.map((row) => row.conname),
        [
          "fk_checkpoints_task",
          "fk_client_tokens_account",
          "fk_devices_account",
          "fk_local_gateways_device",
          "fk_local_grants_device",
          "fk_local_leases_grant",
          "fk_memberships_account",
          "fk_prepared_operations_device",
          "fk_projects_device",
          "fk_tasks_workspace",
          "fk_tasks_workspace_project",
          "fk_workspaces_device",
          "fk_workspaces_project",
        ],
      );
      for (const foreignKey of foreignKeys) {
        assert.equal(foreignKey.confdeltype, "a", `${foreignKey.conname} 必须是 NO ACTION`);
        assert.equal(foreignKey.condeferrable, true, `${foreignKey.conname} 必须可延迟`);
        assert.equal(foreignKey.condeferred, true, `${foreignKey.conname} 必须默认延迟到事务提交`);
      }

      const indexes = await sql.unsafe(`
        SELECT indexname
        FROM pg_catalog.pg_indexes
        WHERE schemaname = 'coflux'
          AND indexname IN (
            'uq_memberships_user', 'uq_devices_token_hash',
            'uq_local_grants_id_account_daemon',
            'uq_workspaces_directory_device', 'uq_tasks_session'
          )
        ORDER BY indexname
      `);
      assert.deepEqual(indexes.map((row) => row.indexname), [
        "uq_devices_token_hash",
        "uq_local_grants_id_account_daemon",
        "uq_memberships_user",
        "uq_tasks_session",
        "uq_workspaces_directory_device",
      ]);
    } finally {
      await Promise.all(servers.map(stopServer));
    }
  });
});

test("活跃 writer 反序锁触发 deadlock 时整事务重试，期间不留下半 ledger", async () => {
  await withDatabase(async ({ database, sql }) => {
    await installLegacyBaseline(sql);
    const suffix = `${process.pid}-${Date.now()}`;
    const migrationApplicationName = `coflux-migration-retry-${suffix}`;
    const writerPool = postgres(database.url, {
      max: 1,
      ssl: "prefer",
      connection: {
        application_name: `coflux-migration-writer-${suffix}`,
        deadlock_timeout: "5s",
        statement_timeout: "5s",
      },
    });
    const migrationPool = postgres(database.url, {
      max: 1,
      ssl: "prefer",
      connection: {
        application_name: migrationApplicationName,
        deadlock_timeout: "50ms",
        lock_timeout: "2s",
      },
    });
    const writer = await writerPool.reserve();
    let migration;
    let writerInTransaction = false;
    try {
      await writer.unsafe("BEGIN");
      writerInTransaction = true;
      // writer 先持有 v2 后序表；migration 随后持有 workspaces，再等待 checkpoint。
      await writer.unsafe("LOCK TABLE coflux.session_checkpoints IN ROW EXCLUSIVE MODE");
      migration = runSchemaMigrations(migrationPool);

      const migrationPid = await waitForValue(async () => {
        const rows = await sql.unsafe(
          `SELECT pid::int FROM pg_catalog.pg_stat_activity WHERE application_name = $1`,
          [migrationApplicationName],
        );
        return rows[0]?.pid;
      }, "migration backend 上线");
      await waitForValue(async () => {
        const locks = await sql.unsafe(
          `
            SELECT c.relname, l.mode, l.granted
            FROM pg_catalog.pg_locks l
            JOIN pg_catalog.pg_class c ON c.oid = l.relation
            WHERE l.pid = $1
              AND c.relnamespace = 'coflux'::regnamespace
              AND c.relname IN ('workspaces', 'session_checkpoints')
          `,
          [migrationPid],
        );
        const holdsWorkspace = locks.some(
          (lock) => lock.relname === "workspaces" && lock.mode === "AccessExclusiveLock" && lock.granted,
        );
        const waitsCheckpoint = locks.some(
          (lock) => lock.relname === "session_checkpoints" && lock.mode === "AccessExclusiveLock" && !lock.granted,
        );
        return holdsWorkspace && waitsCheckpoint;
      }, "migration 形成反序锁前置状态");

      // 反向请求 migration 已持有的 workspaces；低 deadlock_timeout 的 migration 应成为 victim。
      await writer.unsafe("LOCK TABLE coflux.workspaces IN ROW EXCLUSIVE MODE").execute();
      const duringRetry = await sql.unsafe(`SELECT to_regclass('coflux.schema_migrations') AS ledger`);
      assert.equal(duringRetry[0].ledger, null, "失败尝试必须连 ledger DDL 一并回滚");

      await writer.unsafe("COMMIT");
      writerInTransaction = false;
      await migration;
      const ledger = await sql.unsafe(`SELECT version FROM coflux.schema_migrations ORDER BY version`);
      assert.deepEqual(ledger.map((row) => row.version), [1, 2, 3, 4]);
    } finally {
      if (writerInTransaction) await writer.unsafe("ROLLBACK").catch(() => undefined);
      writer.release();
      await writerPool.end({ timeout: 0 });
      await migrationPool.end({ timeout: 0 });
      if (migration) await migration.catch(() => undefined);
    }
  });
});

test("持续 lock_timeout(55P03) 只做有界整事务重试并给出可操作错误", async () => {
  await withDatabase(async ({ database, sql }) => {
    await installLegacyBaseline(sql);
    const writerPool = postgres(database.url, { max: 1, ssl: "prefer" });
    const migrationPool = postgres(database.url, {
      max: 1,
      ssl: "prefer",
      connection: { lock_timeout: "20ms" },
    });
    const writer = await writerPool.reserve();
    let writerInTransaction = false;
    try {
      await writer.unsafe("BEGIN");
      writerInTransaction = true;
      await writer.unsafe("LOCK TABLE coflux.accounts IN ROW EXCLUSIVE MODE");

      await assert.rejects(
        runSchemaMigrations(migrationPool),
        (error) => {
          assert.match(error.message, /连续 4 次因锁竞争失败.*Postgres 55P03/);
          assert.match(error.message, /不会留下半成品 ledger/);
          assert.equal(error.cause?.code, "55P03");
          return true;
        },
      );
      const ledger = await sql.unsafe(`SELECT to_regclass('coflux.schema_migrations') AS ledger`);
      assert.equal(ledger[0].ledger, null);
    } finally {
      if (writerInTransaction) await writer.unsafe("ROLLBACK").catch(() => undefined);
      writer.release();
      await writerPool.end({ timeout: 0 });
      await migrationPool.end({ timeout: 0 });
    }
  });
});

test("legacy 锁等待期间的并发 DDL 会被锁后复验捕获，不写 ledger 或叠加新 FK", async () => {
  await withDatabase(async ({ database, sql }) => {
    await installLegacyBaseline(sql);
    const suffix = `${process.pid}-${Date.now()}`;
    const migrationApplicationName = `coflux-migration-toctou-${suffix}`;
    const writerPool = postgres(database.url, { max: 1, ssl: "prefer" });
    const ddlPool = postgres(database.url, { max: 1, ssl: "prefer" });
    const migrationPool = postgres(database.url, {
      max: 1,
      ssl: "prefer",
      connection: { application_name: migrationApplicationName },
    });
    const writer = await writerPool.reserve();
    let writerInTransaction = false;
    let migration;
    try {
      await writer.unsafe("BEGIN");
      writerInTransaction = true;
      await writer.unsafe("LOCK TABLE coflux.workspaces IN ROW EXCLUSIVE MODE");
      migration = runSchemaMigrations(migrationPool);

      const migrationPid = await waitForValue(async () => {
        const rows = await sql.unsafe(
          `SELECT pid::int FROM pg_catalog.pg_stat_activity WHERE application_name = $1`,
          [migrationApplicationName],
        );
        return rows[0]?.pid;
      }, "legacy migration backend 上线");
      await waitForValue(async () => {
        const rows = await sql.unsafe(
          `
            SELECT 1
            FROM pg_catalog.pg_locks l
            WHERE l.pid = $1
              AND l.relation = 'coflux.workspaces'::regclass
              AND l.mode = 'AccessExclusiveLock'
              AND NOT l.granted
          `,
          [migrationPid],
        );
        return rows.length > 0;
      }, "legacy migration 等待首张 canonical 表");

      // migration 尚未锁 client_tokens；该 DDL 先提交，锁后第二次 catalog 校验必须看到它。
      await ddlPool.unsafe(`
        ALTER TABLE coflux.client_tokens
        ADD CONSTRAINT legacy_client_token_cascade
        FOREIGN KEY (account_id) REFERENCES coflux.accounts(id) ON DELETE CASCADE
      `);
      await writer.unsafe("COMMIT");
      writerInTransaction = false;

      await assert.rejects(migration, /extra_constraint:client_tokens.*ON DELETE CASCADE/);
      const ledger = await sql.unsafe(`SELECT to_regclass('coflux.schema_migrations') AS ledger`);
      assert.equal(ledger[0].ledger, null);
      const foreignKeys = await sql.unsafe(`
        SELECT conname, confdeltype
        FROM pg_catalog.pg_constraint
        WHERE conrelid = 'coflux.client_tokens'::regclass AND contype = 'f'
        ORDER BY conname
      `);
      assert.deepEqual([...foreignKeys], [{ conname: "legacy_client_token_cascade", confdeltype: "c" }]);
    } finally {
      if (writerInTransaction) await writer.unsafe("ROLLBACK").catch(() => undefined);
      writer.release();
      await writerPool.end({ timeout: 0 });
      await ddlPool.end({ timeout: 0 });
      await migrationPool.end({ timeout: 0 });
      if (migration) await migration.catch(() => undefined);
    }
  });
});

test("device 撤销保留安全归属子项，grant prune 先删 lease 再删 tombstone", async () => {
  await withDatabase(async ({ database, sql }) => {
    const store = await Store.connect(database.url);
    try {
      await sql.unsafe(`
        INSERT INTO coflux.accounts VALUES ('a1', 'a1', 1);
        INSERT INTO coflux.devices VALUES ('d1', 'a1', 'd1', 'host', 'linux', 'token-1', 1, 1, false);
        INSERT INTO coflux.local_gateways
          (daemon_id, account_id, protocol_version, port, public_key_sec1, updated_at)
        VALUES ('d1', 'a1', 1, 8788, decode('04', 'hex'), 1);
        INSERT INTO coflux.local_browser_grants
          (grant_id, account_id, daemon_id, origin, public_key_sec1, offline_scopes,
           client_token_hash, pair_request_id, state, created_at, updated_at, revoked_at)
        VALUES ('g1', 'a1', 'd1', 'https://example.test', decode('04', 'hex'), ARRAY[1],
                NULL, 'pair-1', 'active', 1, 1, NULL);
        INSERT INTO coflux.local_device_leases
          (lease_id, grant_id, account_id, daemon_id, client_token_hash, scopes,
           expires_at, created_at, revoked)
        VALUES ('l1', 'g1', 'a1', 'd1', NULL, ARRAY[1], 9999999999999, 1, false);
        INSERT INTO coflux.prepared_device_operations
          (operation_id, account_id, daemon_id, kind, frame, metadata, expires_at, state,
           completed, created_at, updated_at)
        VALUES ('o1', 'a1', 'd1', 'test', decode('00', 'hex'), '{}', 9999999999999,
                'prepared', false, 1, 1);
      `);

      await store.revokeDevice("d1");
      const afterRevoke = await sql.unsafe(`
        SELECT
          (SELECT revoked FROM coflux.devices WHERE id = 'd1') AS device_revoked,
          (SELECT COUNT(*)::int FROM coflux.local_gateways WHERE daemon_id = 'd1') AS gateways,
          (SELECT COUNT(*)::int FROM coflux.local_browser_grants WHERE daemon_id = 'd1') AS grants,
          (SELECT COUNT(*)::int FROM coflux.local_device_leases WHERE daemon_id = 'd1') AS leases,
          (SELECT COUNT(*)::int FROM coflux.prepared_device_operations WHERE daemon_id = 'd1') AS operations
      `);
      assert.deepEqual(afterRevoke[0], {
        device_revoked: true,
        gateways: 1,
        grants: 1,
        leases: 1,
        operations: 1,
      });

      await store.revokeLocalLeasesForGrant("g1");
      await sql.unsafe(`
        UPDATE coflux.local_browser_grants
        SET state = 'revoked', revoked_at = 1
        WHERE grant_id = 'g1'
      `);
      await store.pruneLocalControlState(31 * 24 * 60 * 60 * 1000);
      const afterPrune = await sql.unsafe(`
        SELECT
          (SELECT COUNT(*)::int FROM coflux.local_browser_grants WHERE grant_id = 'g1') AS grants,
          (SELECT COUNT(*)::int FROM coflux.local_device_leases WHERE grant_id = 'g1') AS leases,
          (SELECT COUNT(*)::int FROM coflux.local_gateways WHERE daemon_id = 'd1') AS gateways,
          (SELECT COUNT(*)::int FROM coflux.prepared_device_operations WHERE daemon_id = 'd1') AS operations
      `);
      assert.deepEqual(afterPrune[0], { grants: 0, leases: 0, gateways: 1, operations: 1 });
    } finally {
      await store.close();
    }
  });
});

test("完整 legacy baseline 可建账本，目录 projectId 在 DB NULL 与协议空串之间双向适配", async () => {
  await withDatabase(async ({ database, sql }) => {
    await installLegacyBaseline(sql);
    await sql.unsafe(`
      INSERT INTO coflux.accounts VALUES ('default', 'default', 1);
      INSERT INTO coflux.devices VALUES ('d1', 'default', 'dev', 'host', 'linux', 'token-1', 1, 1, false);
      INSERT INTO coflux.projects VALUES ('p1', 'default', 'd1', 'repo', '/repo', 'main', 1);
      INSERT INTO coflux.workspaces VALUES
        ('w-repo', 'default', 'd1', 'p1', 'main', '/repo', 'main', true, 1),
        ('w-dir', 'default', 'd1', '', '~', '/home/test', '', false, 2);
      INSERT INTO coflux.tasks VALUES
        ('t-repo', 'default', 'd1', 'p1', 'w-repo', 'repo task', 'idle', NULL, NULL, 1, 1),
        ('t-dir', 'default', 'd1', '', 'w-dir', 'dir task', 'running', 's-dir', NULL, 2, 2);
      INSERT INTO coflux.session_checkpoints
        (session_id, task_id, account_id, daemon_id, snapshot_seq, ansi_snapshot, cols, rows, captured_at, updated_at)
      VALUES ('s-dir', 't-dir', 'default', 'd1', 1, decode('41', 'hex'), 80, 24, 2, 2);
    `);

    const port = await freePort();
    const server = spawnServer(database.url, port, { auth: "local" });
    try {
      await waitHealthy(server, port);
      const ledger = await sql.unsafe(`SELECT version, baseline FROM coflux.schema_migrations ORDER BY version`);
      assert.deepEqual([...ledger], [
        { version: 1, baseline: true },
        { version: 2, baseline: false },
        { version: 3, baseline: false },
        { version: 4, baseline: false },
      ]);

      const persisted = await sql.unsafe(`
        SELECT
          (SELECT project_id FROM coflux.workspaces WHERE id = 'w-dir') AS workspace_project_id,
          (SELECT project_key FROM coflux.workspaces WHERE id = 'w-dir') AS workspace_project_key,
          (SELECT project_key FROM coflux.workspaces WHERE id = 'w-repo') AS repo_workspace_project_key,
          (SELECT project_id FROM coflux.tasks WHERE id = 't-dir') AS task_project_id,
          (SELECT project_key FROM coflux.tasks WHERE id = 't-dir') AS task_project_key,
          (SELECT project_key FROM coflux.tasks WHERE id = 't-repo') AS repo_task_project_key
      `);
      assert.equal(persisted[0].workspace_project_id, null);
      assert.equal(persisted[0].workspace_project_key, "");
      assert.equal(persisted[0].repo_workspace_project_key, "p1");
      assert.equal(persisted[0].task_project_id, null);
      assert.equal(persisted[0].task_project_key, "");
      assert.equal(persisted[0].repo_task_project_key, "p1");

      const client = new Client(port);
      try {
        const snapshot = await client.authSubscribe("admin", "admin");
        assert.equal(snapshot.workspaces.find((workspace) => workspace.id === "w-dir")?.projectId, "");
        assert.equal(snapshot.tasks.find((task) => task.id === "t-dir")?.projectId, "");
      } finally {
        client.close();
      }

      await assert.rejects(
        sql.unsafe(`
          INSERT INTO coflux.tasks
            (id, account_id, daemon_id, project_id, workspace_id, title, status, created_at, updated_at)
          VALUES ('orphan', 'default', 'd1', 'p1', 'missing-workspace', 'bad', 'idle', 3, 3)
        `),
        /fk_tasks_workspace/,
      );

      await sql.unsafe(`
        INSERT INTO coflux.tasks
          (id, account_id, daemon_id, project_id, workspace_id, title, status, created_at, updated_at)
        VALUES ('dir-null-project', 'default', 'd1', NULL, 'w-dir', 'good', 'idle', 4, 4)
      `);
      await assert.rejects(
        sql.unsafe(`
          INSERT INTO coflux.tasks
            (id, account_id, daemon_id, project_id, workspace_id, title, status, created_at, updated_at)
          VALUES ('repo-null-project', 'default', 'd1', NULL, 'w-repo', 'bad', 'idle', 5, 5)
        `),
        /fk_tasks_workspace_project/,
      );
    } finally {
      await stopServer(server);
    }
  });
});

test("ledger 缺失时 partial schema fail-closed，且失败事务不留下伪 baseline", async () => {
  await withDatabase(async ({ database, sql }) => {
    await sql.unsafe(`
      CREATE SCHEMA coflux;
      CREATE TABLE coflux.accounts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at DOUBLE PRECISION NOT NULL
      )
    `);
    const port = await freePort();
    const server = spawnServer(database.url, port);
    const exit = await waitFailedExit(server);
    assert.notEqual(exit.code, 0);
    assert.match(server.output, /partial\/incompatible schema/);
    assert.match(server.output, /missing_table:client_tokens/);
    const ledger = await sql.unsafe(`SELECT to_regclass('coflux.schema_migrations') AS ledger`);
    assert.equal(ledger[0].ledger, null);
  });
});

test("legacy baseline 拒绝额外 CASCADE FK，避免与新 NO ACTION 生命周期并存", async () => {
  await withDatabase(async ({ database, sql }) => {
    await installLegacyBaseline(sql);
    await sql.unsafe(`
      ALTER TABLE coflux.workspaces
      ADD CONSTRAINT legacy_project_cascade
      FOREIGN KEY (project_id) REFERENCES coflux.projects(id) ON DELETE CASCADE
    `);
    const port = await freePort();
    const server = spawnServer(database.url, port);
    const exit = await waitFailedExit(server);
    assert.notEqual(exit.code, 0);
    assert.match(server.output, /extra_constraint:workspaces/);
    assert.match(server.output, /ON DELETE CASCADE/);
    const ledger = await sql.unsafe(`SELECT to_regclass('coflux.schema_migrations') AS ledger`);
    assert.equal(ledger[0].ledger, null);
  });
});

test("legacy baseline 拒绝额外 standalone UNIQUE index 改变写入语义", async () => {
  await withDatabase(async ({ database, sql }) => {
    await installLegacyBaseline(sql);
    await sql.unsafe(`CREATE UNIQUE INDEX legacy_unique_project_name ON coflux.projects(name)`);
    const port = await freePort();
    const server = spawnServer(database.url, port);
    const exit = await waitFailedExit(server);
    assert.notEqual(exit.code, 0);
    assert.match(server.output, /unexpected_unique_index:legacy_unique_project_name/);
    const ledger = await sql.unsafe(`SELECT to_regclass('coflux.schema_migrations') AS ledger`);
    assert.equal(ledger[0].ledger, null);
  });
});

test("legacy baseline 拒绝 UNLOGGED 等 table persistence 漂移", async () => {
  await withDatabase(async ({ database, sql }) => {
    await installLegacyBaseline(sql);
    await sql.unsafe(`ALTER TABLE coflux.meta SET UNLOGGED`);
    const port = await freePort();
    const server = spawnServer(database.url, port);
    const exit = await waitFailedExit(server);
    assert.notEqual(exit.code, 0);
    assert.match(server.output, /table_mismatch:meta/);
    assert.match(server.output, /persistence/);
    const ledger = await sql.unsafe(`SELECT to_regclass('coflux.schema_migrations') AS ledger`);
    assert.equal(ledger[0].ledger, null);
  });
});

test("legacy baseline 拒绝 canonical 表参与 inheritance，避免父表查询读入未受约束子表", async () => {
  await withDatabase(async ({ database, sql }) => {
    await installLegacyBaseline(sql);
    await sql.unsafe(`
      CREATE TABLE public.legacy_devices_child () INHERITS (coflux.devices);
      INSERT INTO coflux.accounts VALUES ('a1', 'a1', 1);
      INSERT INTO coflux.devices
      VALUES ('d1', 'a1', 'parent', 'host', 'linux', 'same-token', 1, 1, false);
      INSERT INTO public.legacy_devices_child
      VALUES ('d2', 'a1', 'child', 'host', 'linux', 'same-token', 2, 2, false)
    `);
    const port = await freePort();
    const server = spawnServer(database.url, port);
    const exit = await waitFailedExit(server);
    assert.notEqual(exit.code, 0);
    assert.match(server.output, /table_mismatch:devices/);
    assert.match(server.output, /hasSubclass/);
    assert.match(server.output, /extra_inheritance:coflux\.devices -> public\.legacy_devices_child/);
    const ledger = await sql.unsafe(`SELECT to_regclass('coflux.schema_migrations') AS ledger`);
    assert.equal(ledger[0].ledger, null);
  });
});

test("legacy baseline 拒绝 canonical 表上的非内部 trigger", async () => {
  await withDatabase(async ({ database, sql }) => {
    await installLegacyBaseline(sql);
    await sql.unsafe(`
      CREATE FUNCTION coflux.legacy_token_passthrough()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RETURN NEW;
      END
      $$;
      CREATE TRIGGER legacy_token_trigger
      BEFORE INSERT ON coflux.client_tokens
      FOR EACH ROW EXECUTE FUNCTION coflux.legacy_token_passthrough()
    `);
    const port = await freePort();
    const server = spawnServer(database.url, port);
    const exit = await waitFailedExit(server);
    assert.notEqual(exit.code, 0);
    assert.match(server.output, /extra_trigger:client_tokens\.legacy_token_trigger/);
    const ledger = await sql.unsafe(`SELECT to_regclass('coflux.schema_migrations') AS ledger`);
    assert.equal(ledger[0].ledger, null);
  });
});

test("legacy baseline 拒绝 canonical 表上的 rewrite rule", async () => {
  await withDatabase(async ({ database, sql }) => {
    await installLegacyBaseline(sql);
    await sql.unsafe(`
      CREATE RULE legacy_swallow_token AS
      ON INSERT TO coflux.client_tokens DO INSTEAD NOTHING
    `);
    const port = await freePort();
    const server = spawnServer(database.url, port);
    const exit = await waitFailedExit(server);
    assert.notEqual(exit.code, 0);
    assert.match(server.output, /extra_rule:client_tokens\.legacy_swallow_token/);
    const ledger = await sql.unsafe(`SELECT to_regclass('coflux.schema_migrations') AS ledger`);
    assert.equal(ledger[0].ledger, null);
  });
});

test("v2 拒绝同名但类型/default/nullability 错误的增量列并回滚 ledger", async () => {
  await withDatabase(async ({ database, sql }) => {
    await installLegacyBaseline(sql);
    await sql.unsafe(`
      ALTER TABLE coflux.workspaces ADD COLUMN additions TEXT NOT NULL DEFAULT '0';
      ALTER TABLE coflux.workspaces ADD COLUMN deletions INTEGER DEFAULT 0;
      ALTER TABLE coflux.projects ADD COLUMN deleting BOOLEAN NOT NULL DEFAULT true;
      ALTER TABLE coflux.session_checkpoints ADD COLUMN title TEXT;
    `);

    const port = await freePort();
    const server = spawnServer(database.url, port);
    const exit = await waitFailedExit(server);
    assert.notEqual(exit.code, 0);
    assert.match(server.output, /migration v2 catalog shape 校验失败/);
    assert.match(server.output, /workspaces\.additions/);
    assert.match(server.output, /workspaces\.deletions/);
    assert.match(server.output, /projects\.deleting/);
    assert.match(server.output, /session_checkpoints\.title/);
    const ledger = await sql.unsafe(`SELECT to_regclass('coflux.schema_migrations') AS ledger`);
    assert.equal(ledger[0].ledger, null);
  });
});

test("v2 拒绝表达式相同但不可写的 generated 增量列并回滚 ledger", async () => {
  await withDatabase(async ({ database, sql }) => {
    await installLegacyBaseline(sql);
    await sql.unsafe(`
      ALTER TABLE coflux.workspaces
      ADD COLUMN additions INTEGER GENERATED ALWAYS AS (0) STORED NOT NULL
    `);

    const port = await freePort();
    const server = spawnServer(database.url, port);
    const exit = await waitFailedExit(server);
    assert.notEqual(exit.code, 0);
    assert.match(server.output, /migration v2 catalog shape 校验失败/);
    assert.match(server.output, /workspaces\.additions/);
    assert.match(server.output, /generatedKind/);
    const ledger = await sql.unsafe(`SELECT to_regclass('coflux.schema_migrations') AS ledger`);
    assert.equal(ledger[0].ledger, null);
  });
});

test("v2 拒绝同名但表/列序/DESC/unique/predicate 错误的索引并回滚 ledger", async () => {
  await withDatabase(async ({ database, sql }) => {
    await installLegacyBaseline(sql);
    await sql.unsafe(`
      CREATE INDEX idx_devices_account ON coflux.projects(account_id);
      CREATE INDEX idx_prepared_daemon
        ON coflux.prepared_device_operations(completed, daemon_id, expires_at);
      CREATE INDEX idx_checkpoints_account
        ON coflux.session_checkpoints(account_id, captured_at);
      CREATE INDEX uq_prepared_active_target
        ON coflux.prepared_device_operations(account_id, kind, target_id)
        WHERE completed = false;
    `);

    const port = await freePort();
    const server = spawnServer(database.url, port);
    const exit = await waitFailedExit(server);
    assert.notEqual(exit.code, 0);
    assert.match(server.output, /migration v2 catalog shape 校验失败/);
    assert.match(server.output, /idx_devices_account/);
    assert.match(server.output, /idx_prepared_daemon/);
    assert.match(server.output, /idx_checkpoints_account/);
    assert.match(server.output, /uq_prepared_active_target/);
    const ledger = await sql.unsafe(`SELECT to_regclass('coflux.schema_migrations') AS ledger`);
    assert.equal(ledger[0].ledger, null);
  });
});

test("v2 拒绝同名索引的 NULLS NOT DISTINCT 语义漂移并回滚 ledger", async () => {
  await withDatabase(async ({ database, sql }) => {
    await installLegacyBaseline(sql);
    await sql.unsafe(`
      CREATE UNIQUE INDEX uq_prepared_active_target
      ON coflux.prepared_device_operations(account_id, kind, target_id) NULLS NOT DISTINCT
      WHERE target_id IS NOT NULL AND completed = false AND state <> 'expired'
    `);

    const port = await freePort();
    const server = spawnServer(database.url, port);
    const exit = await waitFailedExit(server);
    assert.notEqual(exit.code, 0);
    assert.match(server.output, /migration v2 catalog shape 校验失败/);
    assert.match(server.output, /index_mismatch:uq_prepared_active_target/);
    assert.match(server.output, /nullsNotDistinct/);
    const ledger = await sql.unsafe(`SELECT to_regclass('coflux.schema_migrations') AS ledger`);
    assert.equal(ledger[0].ledger, null);
  });
});

test("已应用 migration 的 checksum 漂移会拒绝旧/篡改代码启动", async () => {
  await withDatabase(async ({ database, sql }) => {
    const firstPort = await freePort();
    const first = spawnServer(database.url, firstPort);
    try {
      await waitHealthy(first, firstPort);
    } finally {
      await stopServer(first);
    }
    await sql.unsafe(`
      UPDATE coflux.schema_migrations
      SET checksum = repeat('0', 64)
      WHERE version = 2
    `);

    const secondPort = await freePort();
    const second = spawnServer(database.url, secondPort);
    const exit = await waitFailedExit(second);
    assert.notEqual(exit.code, 0);
    assert.match(second.output, /migration ledger 第 2 版与代码不一致/);
  });
});

const DIRTY_FIXTURES = [
  {
    name: "client token/account 归属",
    checkId: "client_token_account_orphan",
    seed: `
      INSERT INTO coflux.client_tokens
        (token_hash, account_id, created_at, revoked, expires_at, user_id)
      VALUES ('token-1', 'missing-account', 1, false, NULL, NULL);
    `,
  },
  {
    name: "local gateway/device 归属",
    checkId: "local_gateway_device_mismatch",
    seed: `
      INSERT INTO coflux.accounts VALUES ('a1', 'a1', 1), ('a2', 'a2', 2);
      INSERT INTO coflux.devices VALUES ('d1', 'a1', 'd1', 'h1', 'linux', 'token-1', 1, 1, false);
      INSERT INTO coflux.local_gateways
        (daemon_id, account_id, protocol_version, port, public_key_sec1, updated_at)
      VALUES ('d1', 'a2', 1, 8788, decode('04', 'hex'), 1);
    `,
  },
  {
    name: "local grant/device 归属",
    checkId: "local_grant_device_mismatch",
    seed: `
      INSERT INTO coflux.accounts VALUES ('a1', 'a1', 1), ('a2', 'a2', 2);
      INSERT INTO coflux.devices VALUES ('d1', 'a1', 'd1', 'h1', 'linux', 'token-1', 1, 1, false);
      INSERT INTO coflux.local_browser_grants
        (grant_id, account_id, daemon_id, origin, public_key_sec1, offline_scopes,
         client_token_hash, pair_request_id, state, created_at, updated_at, revoked_at)
      VALUES ('g1', 'a2', 'd1', 'https://example.test', decode('04', 'hex'), ARRAY[1],
              NULL, 'pair-1', 'active', 1, 1, NULL);
    `,
  },
  {
    name: "local lease/grant 归属",
    checkId: "local_lease_grant_mismatch",
    seed: `
      INSERT INTO coflux.accounts VALUES ('a1', 'a1', 1);
      INSERT INTO coflux.devices VALUES ('d1', 'a1', 'd1', 'h1', 'linux', 'token-1', 1, 1, false);
      INSERT INTO coflux.local_browser_grants
        (grant_id, account_id, daemon_id, origin, public_key_sec1, offline_scopes,
         client_token_hash, pair_request_id, state, created_at, updated_at, revoked_at)
      VALUES ('g1', 'a1', 'd1', 'https://example.test', decode('04', 'hex'), ARRAY[1],
              NULL, 'pair-1', 'active', 1, 1, NULL);
      INSERT INTO coflux.local_device_leases
        (lease_id, grant_id, account_id, daemon_id, client_token_hash, scopes,
         expires_at, created_at, revoked)
      VALUES ('l1', 'g1', 'a1', 'wrong-daemon', NULL, ARRAY[1], 9999999999999, 1, false);
    `,
  },
  {
    name: "prepared operation/device 归属",
    checkId: "prepared_operation_device_mismatch",
    seed: `
      INSERT INTO coflux.accounts VALUES ('a1', 'a1', 1), ('a2', 'a2', 2);
      INSERT INTO coflux.devices VALUES ('d1', 'a1', 'd1', 'h1', 'linux', 'token-1', 1, 1, false);
      INSERT INTO coflux.prepared_device_operations
        (operation_id, account_id, daemon_id, kind, frame, metadata, expires_at, state,
         completed, created_at, updated_at)
      VALUES ('o1', 'a2', 'd1', 'test', decode('00', 'hex'), '{}', 9999999999999,
              'prepared', false, 1, 1);
    `,
  },
  {
    name: "workspace/project 归属",
    checkId: "workspace_project_mismatch",
    seed: `
      INSERT INTO coflux.accounts VALUES ('a1', 'a1', 1);
      INSERT INTO coflux.devices VALUES ('d1', 'a1', 'd1', 'h1', 'linux', 'token-1', 1, 1, false);
      INSERT INTO coflux.workspaces VALUES
        ('w1', 'a1', 'd1', 'missing-project', 'bad', '/repo', 'main', true, 1);
    `,
  },
  {
    name: "membership 1:1",
    checkId: "membership_user_duplicate",
    seed: `
      INSERT INTO coflux.accounts VALUES ('a1', 'a1', 1), ('a2', 'a2', 2);
      INSERT INTO coflux.users VALUES ('u1', 'u@example.com', 'hash', 1);
      INSERT INTO coflux.memberships VALUES ('u1', 'a1', 'owner', 1), ('u1', 'a2', 'owner', 2);
    `,
  },
  {
    name: "device token",
    checkId: "device_token_duplicate",
    seed: `
      INSERT INTO coflux.accounts VALUES ('a1', 'a1', 1);
      INSERT INTO coflux.devices VALUES
        ('d1', 'a1', 'd1', 'h1', 'linux', 'same-token', 1, 1, false),
        ('d2', 'a1', 'd2', 'h2', 'linux', 'same-token', 2, 2, false);
    `,
  },
  {
    name: "directory workspace",
    checkId: "directory_workspace_duplicate",
    seed: `
      INSERT INTO coflux.accounts VALUES ('a1', 'a1', 1);
      INSERT INTO coflux.devices VALUES ('d1', 'a1', 'd1', 'h1', 'linux', 'token-1', 1, 1, false);
      INSERT INTO coflux.workspaces VALUES
        ('w1', 'a1', 'd1', '', '~', '/home/a', '', false, 1),
        ('w2', 'a1', 'd1', '', '~', '/home/b', '', false, 2);
    `,
  },
  {
    name: "task session",
    checkId: "task_session_duplicate",
    seed: `
      INSERT INTO coflux.accounts VALUES ('a1', 'a1', 1);
      INSERT INTO coflux.devices VALUES ('d1', 'a1', 'd1', 'h1', 'linux', 'token-1', 1, 1, false);
      INSERT INTO coflux.projects VALUES ('p1', 'a1', 'd1', 'repo', '/repo', 'main', 1);
      INSERT INTO coflux.workspaces VALUES ('w1', 'a1', 'd1', 'p1', 'main', '/repo', 'main', true, 1);
      INSERT INTO coflux.tasks VALUES
        ('t1', 'a1', 'd1', 'p1', 'w1', 'one', 'running', 'same-session', NULL, 1, 1),
        ('t2', 'a1', 'd1', 'p1', 'w1', 'two', 'running', 'same-session', NULL, 2, 2);
    `,
  },
];

for (const fixture of DIRTY_FIXTURES) {
  test(`脏数据 preflight 拒绝 ${fixture.name} 约束违例且不写 ledger`, async () => {
    await withDatabase(async ({ database, sql }) => {
      await installLegacyBaseline(sql);
      await sql.unsafe(fixture.seed);
      const port = await freePort();
      const server = spawnServer(database.url, port);
      const exit = await waitFailedExit(server);
      assert.notEqual(exit.code, 0);
      assert.match(server.output, new RegExp(`preflight 失败 \\[${fixture.checkId}\\]`));
      assert.match(server.output, /修复建议/);
      const ledger = await sql.unsafe(`SELECT to_regclass('coflux.schema_migrations') AS ledger`);
      assert.equal(ledger[0].ledger, null);
    });
  });
}
