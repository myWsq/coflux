-- migration ledger 引入前的完整 Postgres baseline。
-- 这是冻结测试输入：刻意不含 projects.deleting、workspace diff、checkpoint title 与新 FK/UNIQUE。
CREATE SCHEMA coflux;

CREATE TABLE coflux.accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at DOUBLE PRECISION NOT NULL
);

CREATE TABLE coflux.client_tokens (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  created_at DOUBLE PRECISION NOT NULL,
  revoked BOOLEAN NOT NULL DEFAULT false,
  expires_at DOUBLE PRECISION,
  user_id TEXT
);

CREATE TABLE coflux.users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at DOUBLE PRECISION NOT NULL
);

CREATE TABLE coflux.memberships (
  user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (user_id, account_id)
);

CREATE TABLE coflux.meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE coflux.devices (
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

CREATE TABLE coflux.projects (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  daemon_id TEXT NOT NULL,
  name TEXT NOT NULL,
  repo_path TEXT NOT NULL,
  default_branch TEXT NOT NULL,
  created_at DOUBLE PRECISION NOT NULL
);

CREATE TABLE coflux.workspaces (
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

CREATE TABLE coflux.tasks (
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

CREATE TABLE coflux.local_gateways (
  daemon_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  protocol_version INTEGER NOT NULL,
  port INTEGER NOT NULL,
  public_key_sec1 BYTEA NOT NULL,
  updated_at DOUBLE PRECISION NOT NULL
);

CREATE TABLE coflux.local_browser_grants (
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

CREATE TABLE coflux.local_device_leases (
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

CREATE TABLE coflux.prepared_device_operations (
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

CREATE TABLE coflux.session_checkpoints (
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
