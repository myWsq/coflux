/**
 * @coflux/core —— 共享基建（结构化分级日志等）。
 *
 * 零依赖、极简。日志支持作用域(scope)、绑定字段(child) 以做关联（daemonId/sessionId/accountId）。
 * 环境变量：
 *   COFLUX_LOG_LEVEL = debug|info|warn|error（默认 info）
 *   COFLUX_LOG_JSON  = 1 输出 JSON 行（便于采集），否则人类可读
 */
export type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const envLevel = (process.env.COFLUX_LOG_LEVEL ?? "info").toLowerCase() as Level;
const threshold = ORDER[envLevel] ?? ORDER.info;
const asJson = process.env.COFLUX_LOG_JSON === "1" || process.env.COFLUX_LOG_JSON === "true";

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  /** 派生一个带额外绑定字段的子日志（用于关联） */
  child(fields: Record<string, unknown>): Logger;
}

function fmtFields(f: Record<string, unknown>): string {
  const keys = Object.keys(f);
  if (!keys.length) return "";
  return " " + keys.map((k) => `${k}=${typeof f[k] === "string" ? f[k] : JSON.stringify(f[k])}`).join(" ");
}

export function createLogger(scope: string, base: Record<string, unknown> = {}): Logger {
  const write = (level: Level, msg: string, fields?: Record<string, unknown>) => {
    if (ORDER[level] < threshold) return;
    const merged = fields ? { ...base, ...fields } : base;
    const sink = level === "error" || level === "warn" ? console.error : console.log;
    if (asJson) {
      sink(JSON.stringify({ t: new Date().toISOString(), level, scope, msg, ...merged }));
    } else {
      sink(`${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}${fmtFields(merged)}`);
    }
  };
  return {
    debug: (m, f) => write("debug", m, f),
    info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f),
    error: (m, f) => write("error", m, f),
    child: (fields) => createLogger(scope, { ...base, ...fields }),
  };
}
