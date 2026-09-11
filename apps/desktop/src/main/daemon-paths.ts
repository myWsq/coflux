import { join } from "node:path";

/**
 * 本机 daemon 的路径常量（plan 113）：与 npm 版 cofluxd（packages/cli/cofluxd.mjs 顶部常量）逐字同构，
 * 两边写出的文件可互换——npm 装过的机器被 app 识别为「已接入」并直接接管，反之亦然。
 * 纯函数、无 Electron 依赖；scripts/stage-daemon.mjs 与 electron-builder.yml 里的同名字面量由 test/config.test.ts 守住一致。
 */

/** 内置三件在 Contents/Resources 下的子目录名（electron-builder.yml extraResources 的 to） */
export const DAEMON_RESOURCE_DIR = "daemon";
/** 内置与落盘的三个二进制文件名 */
export const DAEMON_BINARIES = ["coflux-supervisor", "coflux-worker", "cofluxd"] as const;
export type DaemonBinaryName = (typeof DAEMON_BINARIES)[number];
/** 与三件同目录的版本戳 sidecar（CI 写 v0.0.0-desktop.<桌面版本>；本机 pack 缺失落 dev） */
export const DAEMON_VERSION_FILE = "VERSION";
/** launchd 服务 label（plist 的 Label，`launchctl print gui/<uid>/<label>`） */
export const LAUNCHD_LABEL = "com.coflux.daemon";

export type DaemonHomePaths = {
  /** COFLUX_HOME（默认 ~/.coflux） */
  home: string;
  binDir: string;
  supervisorBin: string;
  workerBin: string;
  cliBin: string;
  /** 用户配置（serverUrl / deviceName / shell），0600 */
  settings: string;
  /** launchd 的 StandardOut/ErrPath，与 cofluxd 同一个文件 */
  logFile: string;
  /** 设备凭证（daemonId / deviceToken），0600；存在 = 已登记 */
  credentials: string;
  /** worker 落盘的待授权链接（url 含一次性 token），0600 */
  pendingAuth: string;
  /** supervisor 启动时探测的完全磁盘访问结果：granted / denied / unknown */
  fdaStatus: string;
  /** supervisor 启动时写的自身版本原文（plan 112） */
  supervisorVersion: string;
  /** ~/Library/LaunchAgents/com.coflux.daemon.plist（不随 COFLUX_HOME 走，与 cofluxd 一致） */
  plist: string;
};

/** COFLUX_HOME 若设了就尊重它（cofluxd 同法），否则 ~/.coflux。 */
export function resolveCofluxHome(env: Record<string, string | undefined>, homeDir: string): string {
  const fromEnv = env.COFLUX_HOME?.trim();
  return fromEnv ? fromEnv : join(homeDir, ".coflux");
}

export function daemonHomePaths(homeDir: string, env: Record<string, string | undefined>): DaemonHomePaths {
  const home = resolveCofluxHome(env, homeDir);
  const binDir = join(home, "bin");
  return {
    home,
    binDir,
    supervisorBin: join(binDir, "coflux-supervisor"),
    workerBin: join(binDir, "coflux-worker"),
    cliBin: join(binDir, "cofluxd"),
    settings: join(home, "settings.json"),
    logFile: join(home, "daemon.log"),
    credentials: join(home, "credentials.json"),
    pendingAuth: join(home, "pending-auth.json"),
    fdaStatus: join(home, "fda-status"),
    supervisorVersion: join(home, "supervisor-version"),
    plist: join(homeDir, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`),
  };
}
