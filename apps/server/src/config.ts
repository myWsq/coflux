/** 服务器配置：所有环境变量集中、带默认值，一处校验。 */
import { join } from "node:path";
import { DEFAULT_PORT } from "@coflux/protocol";

function int(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined) return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

// 开发模式（pnpm dev:server 设 COFLUX_DEV=1）才允许秘密类配置回落到弱默认值；
// 生产不设此标志时，缺失的秘密会被记入 missing 并在下方拒绝启动（fail-closed）。
const isDev = process.env.COFLUX_DEV === "1";
const missingSecrets: string[] = [];

// 身份提供方：local（默认，env 用户名+密码单账号）| supabase（Supabase Auth 换票多账号）。
// 见 plans/001。local 模式行为与历史完全一致；supabase 模式只把「你是谁」的认证外包给 Supabase，
// 会话/数据/授权全部由 coflux 自持（验签得 userId → 查/建 membership → 签发 coflux 会话 token）。
const authRaw = process.env.COFLUX_AUTH ?? "local";
if (authRaw !== "local" && authRaw !== "supabase") {
  console.error(`[config] COFLUX_AUTH 取值非法：${authRaw}（仅支持 local | supabase）。`);
  process.exit(1);
}
const authProvider: "local" | "supabase" = authRaw;
const isLocal = authProvider === "local";

/** 秘密类配置：生产必须由环境变量提供；开发回落到 devDefault（弱值，仅本地用）。
 * required=false 的项（如 supabase 模式下的 env 口令/登记密钥）不参与 fail-closed 校验。 */
function secret(name: string, devDefault: string, required = true): string {
  const v = process.env[name];
  if (v !== undefined && v !== "") return v;
  if (!isDev && required) missingSecrets.push(name);
  return devDefault;
}

// supabase 模式必需 SUPABASE_URL（验签的 iss / JWKS 来源）；去掉尾斜杠以稳定拼接。
const supabaseUrl = (process.env.SUPABASE_URL ?? "").replace(/\/+$/, "");
if (authProvider === "supabase" && !supabaseUrl) missingSecrets.push("SUPABASE_URL");

export const config = {
  authProvider,
  supabaseUrl,
  port: int("COFLUX_PORT", DEFAULT_PORT),
  // 默认只绑 localhost：生产由反向代理(Caddy)对外，不直接暴露端口。需对外监听设 COFLUX_HOST=0.0.0.0。
  host: process.env.COFLUX_HOST ?? "127.0.0.1",
  dbPath: process.env.COFLUX_DB ?? join(process.cwd(), "data", "coflux.db"),
  // 登记密钥 / env 口令仅 local 模式必需；supabase 模式下登记密钥走 UI 生成、web 登录走 Supabase。
  enrollKey: secret("COFLUX_ENROLL_KEY", "dev-enroll", isLocal),
  // web 登录：用户名 + 密码（单租户）。登录成功签发会话 token 给 web 存用，用户不碰 token。
  // username 非秘密（账号名），保留默认；password 是秘密，local 生产必须由 env 提供。
  username: process.env.COFLUX_USERNAME ?? "admin",
  password: secret("COFLUX_PASSWORD", "admin", isLocal),
  accountId: "default",
  /** daemon 连接地址，展示在 web「添加设备」命令里；反代/公网部署时用 COFLUX_DAEMON_URL 覆盖 */
  daemonUrl: process.env.COFLUX_DAEMON_URL ?? `ws://127.0.0.1:${int("COFLUX_PORT", DEFAULT_PORT)}/daemon`,

  // web 会话 token 有效期：登录签发后多久过期（重连也用它）。默认 30 天。
  sessionTtlMs: int("COFLUX_SESSION_TTL_MS", 30 * 24 * 60 * 60 * 1000),

  maxPayload: int("COFLUX_MAX_PAYLOAD", 4 * 1024 * 1024),
  authDeadlineMs: int("COFLUX_AUTH_DEADLINE_MS", 15_000),
  heartbeatMs: int("COFLUX_HEARTBEAT_MS", 30_000),
  pendingTimeoutMs: int("COFLUX_PENDING_TIMEOUT_MS", 30_000),
  clientBufferHardLimit: int("COFLUX_CLIENT_BUFFER_LIMIT", 32 * 1024 * 1024),
  maxDevicesPerAccount: int("COFLUX_MAX_DEVICES", 100),
  execDefaultTimeoutMs: int("COFLUX_EXEC_TIMEOUT_MS", 60_000),
  execMaxTimeoutMs: int("COFLUX_EXEC_MAX_TIMEOUT_MS", 300_000),
} as const;

// fail-closed：生产（非 COFLUX_DEV）缺任何秘密类 env 就拒绝启动，绝不带弱默认口令上线。
if (missingSecrets.length > 0) {
  console.error(
    `[config] 生产模式缺少必需的环境变量: ${missingSecrets.join(", ")}。\n` +
      `请设置后再启动；仅本地开发可用 COFLUX_DEV=1 启用弱默认值（切勿用于生产）。`,
  );
  process.exit(1);
}

export type Config = typeof config;
