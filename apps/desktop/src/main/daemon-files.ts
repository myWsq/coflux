import type { DesktopDaemonFda } from "../shared/desktop-bridge";
import { LAUNCHD_LABEL, type DaemonHomePaths } from "./daemon-paths";

/**
 * ~/.coflux 与 LaunchAgent 的文本生成与解析（plan 113）。纯函数，无 Electron / fs 依赖；
 * 生成的文本与 npm 版 cofluxd（packages/cli/cofluxd.mjs 的 plistXml / applyConfig）逐字同构。
 * 解析函数只从文件内容里取所需字段，绝不把 pending-auth.json / credentials.json 的原文往外传。
 */

/** LaunchAgent plist：等价于 cofluxd.mjs 的 plistXml()。 */
export function launchAgentPlist(paths: DaemonHomePaths): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${paths.supervisorBin}</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>COFLUX_HOME</key><string>${paths.home}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${paths.logFile}</string>
  <key>StandardErrorPath</key><string>${paths.logFile}</string>
</dict>
</plist>
`;
}

/**
 * daemon 的服务器地址跟随 app：/client 端点换成 /daemon（wss://api.coflux.dev/client → wss://api.coflux.dev/daemon）。
 * 路径不是 /client 结尾时直接落 /daemon。
 */
export function daemonServerUrl(clientServerUrl: string): string {
  const url = new URL(clientServerUrl);
  url.pathname = url.pathname.endsWith("/client") ? `${url.pathname.slice(0, -"/client".length)}/daemon` : "/daemon";
  url.search = "";
  url.hash = "";
  return url.toString();
}

export type DaemonSettings = { serverUrl: string; deviceName: string; shell?: string };

/**
 * settings.json 内容：照 applyConfig——serverUrl 跟随 app，deviceName 沿用已有值否则 hostname，
 * shell 只在已有配置里有时保留。existing 是旧文件解析结果（缺失 / 坏掉传 null）。
 */
export function buildDaemonSettings(existing: unknown, input: { serverUrl: string; hostname: string }): DaemonSettings {
  const previous = existing && typeof existing === "object" ? (existing as Record<string, unknown>) : {};
  const deviceName = typeof previous.deviceName === "string" && previous.deviceName.trim() ? previous.deviceName : input.hostname;
  const settings: DaemonSettings = { serverUrl: input.serverUrl, deviceName };
  if (typeof previous.shell === "string" && previous.shell) settings.shell = previous.shell;
  return settings;
}

export function daemonSettingsJson(settings: DaemonSettings): string {
  return `${JSON.stringify(settings, null, 2)}\n`;
}

export type PendingAuth = { token: string; expiresAt?: number };

/** 从 `<publicUrl>/authorize/<token>` 取 token（server 用 encodeURIComponent 编过）。 */
export function authorizeTokenFromUrl(url: string): string | null {
  try {
    const match = /\/authorize\/([^/?#]+)\/?$/.exec(new URL(url).pathname);
    if (!match) return null;
    const token = decodeURIComponent(match[1]);
    return token ? token : null;
  } catch {
    return null;
  }
}

/** pending-auth.json（worker 落盘：{ url, expiresAt }）→ token；形状不对或 url 不是授权链接返回 null。 */
export function parsePendingAuth(text: string | null): PendingAuth | null {
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") return null;
    const { url, expiresAt } = parsed as Record<string, unknown>;
    if (typeof url !== "string") return null;
    const token = authorizeTokenFromUrl(url);
    if (!token) return null;
    return typeof expiresAt === "number" && Number.isFinite(expiresAt) ? { token, expiresAt } : { token };
  } catch {
    return null;
  }
}

/** credentials.json → 只取 daemonId；deviceToken 绝不离开这个函数。 */
export function parseCredentialsDaemonId(text: string | null): string | null {
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") return null;
    const daemonId = (parsed as Record<string, unknown>).daemonId;
    return typeof daemonId === "string" && daemonId ? daemonId : null;
  } catch {
    return null;
  }
}

/** fda-status 纯文本：granted / denied，其余（含缺失、乱值）一律 unknown。 */
export function parseFdaStatus(text: string | null): DesktopDaemonFda {
  const value = text?.trim();
  return value === "granted" || value === "denied" ? value : "unknown";
}

/** supervisor-version：原文去掉首尾空白；缺失 / 空 → null。 */
export function parseSupervisorVersion(text: string | null): string | null {
  const value = text?.trim();
  return value ? value : null;
}
