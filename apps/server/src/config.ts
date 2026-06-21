/** 服务器配置：所有环境变量集中、带默认值，一处校验。 */
import { join } from "node:path";
import { DEFAULT_PORT } from "@coflux/protocol";

function int(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined) return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

export const config = {
  port: int("COFLUX_PORT", DEFAULT_PORT),
  dbPath: process.env.COFLUX_DB ?? join(process.cwd(), "data", "coflux.db"),
  enrollKey: process.env.COFLUX_ENROLL_KEY ?? "dev-enroll",
  clientToken: process.env.COFLUX_CLIENT_TOKEN ?? "dev-client",
  accountId: "default",

  maxPayload: int("COFLUX_MAX_PAYLOAD", 4 * 1024 * 1024),
  authDeadlineMs: int("COFLUX_AUTH_DEADLINE_MS", 15_000),
  heartbeatMs: int("COFLUX_HEARTBEAT_MS", 30_000),
  pendingTimeoutMs: int("COFLUX_PENDING_TIMEOUT_MS", 30_000),
  clientBufferHardLimit: int("COFLUX_CLIENT_BUFFER_LIMIT", 32 * 1024 * 1024),
  maxDevicesPerAccount: int("COFLUX_MAX_DEVICES", 100),
  execDefaultTimeoutMs: int("COFLUX_EXEC_TIMEOUT_MS", 60_000),
  execMaxTimeoutMs: int("COFLUX_EXEC_MAX_TIMEOUT_MS", 300_000),
} as const;

export type Config = typeof config;
