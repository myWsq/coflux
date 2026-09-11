import { readFileSync } from "node:fs";

/**
 * 服务器地址（plan 103）：桌面下没有 location.host 可推导，地址由 app 侧给出。优先级：
 * 命令行 `--server=<ws(s) url>` > 环境变量 COFLUX_SERVER_URL > userData/settings.json 的 serverUrl >
 * 默认值（打包版 wss://api.coflux.dev/client；dev ws://localhost:8787/client）。非法值跳过、落到下一级。
 */
export const DEFAULT_SERVER_URL = "wss://api.coflux.dev/client";
export const DEV_SERVER_URL = "ws://localhost:8787/client";

export type ServerUrlInput = {
  argv: readonly string[];
  env: Record<string, string | undefined>;
  /** settings.json 里的 serverUrl（文件缺失/坏掉传 undefined） */
  fileServerUrl?: string;
  packaged: boolean;
};

export function isValidServerUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "ws:" || parsed.protocol === "wss:";
  } catch {
    return false;
  }
}

export function resolveServerUrl(input: ServerUrlInput): string {
  const fromArgv = input.argv.find((arg) => arg.startsWith("--server="))?.slice("--server=".length);
  const candidates = [fromArgv, input.env.COFLUX_SERVER_URL, input.fileServerUrl];
  for (const candidate of candidates) if (isValidServerUrl(candidate)) return candidate;
  return input.packaged ? DEFAULT_SERVER_URL : DEV_SERVER_URL;
}

export type DesktopSettings = { serverUrl?: string };

/** userData/settings.json：只认 serverUrl 一个键；文件不存在或不是 JSON 对象一律当空。 */
export function readSettingsFile(path: string): DesktopSettings {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object") return {};
    const serverUrl = (parsed as { serverUrl?: unknown }).serverUrl;
    return typeof serverUrl === "string" ? { serverUrl } : {};
  } catch {
    return {};
  }
}
