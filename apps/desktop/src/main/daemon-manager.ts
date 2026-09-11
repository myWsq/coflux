import { execFile } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setInterval } from "node:timers";

import type { DesktopDaemonBusy, DesktopDaemonState } from "../shared/desktop-bridge";
import type { DaemonBundle } from "./daemon-bundle";
import { buildDaemonSettings, daemonServerUrl, daemonSettingsJson, parseCredentialsDaemonId, parseFdaStatus, parsePendingAuth, parseSupervisorVersion } from "./daemon-files";
import { LAUNCHD_LABEL, type DaemonHomePaths } from "./daemon-paths";
import { deriveDaemonState, type DaemonFacts } from "./daemon-state";
import { bundleRuntimeId, runtimeStatus, stageRuntime, startRuntime, stopRuntime, type RuntimeStatus } from "./desktop-runtime";

export type StopReason = "quit" | "logout" | "stop" | "restart" | "migrate";
export type DaemonCommands = {
  exec: (file: string, args: readonly string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
  openExternal: (url: string) => void;
  showItemInFolder: (path: string) => void;
};
export type DaemonManagerOptions = {
  paths: DaemonHomePaths;
  bundle: DaemonBundle | null;
  claudePluginDir: string | null;
  clientServerUrl: string;
  hostname: string;
  uid: number;
  platform: NodeJS.Platform;
  appPath: string;
  confirmStop: (reason: StopReason, count: number | null) => Promise<boolean>;
  commands: DaemonCommands;
  log: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };
};
export type DaemonManager = {
  getState: () => DesktopDaemonState;
  refresh: () => Promise<void>;
  onChange: (listener: (state: DesktopDaemonState) => void) => () => void;
  enroll: () => Promise<void>;
  restart: () => Promise<void>;
  stop: () => Promise<void>;
  remove: () => Promise<void>;
  stopForExit: (reason: "quit" | "logout") => Promise<boolean>;
  openFdaGuide: () => void;
  dismissError: () => void;
  dispose: () => void;
};
export function execCommand(file: string, args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => execFile(file, [...args], { encoding: "utf8", timeout: 30_000 }, (error, stdout, stderr) => {
    resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
  }));
}
function readText(path: string): string | null { try { return readFileSync(path, "utf8"); } catch { return null; } }

/** 桌面拥有生命周期，托管实例可跨更新存活。旧 LaunchAgent 仅用于有确认的迁移。 */
export function createDaemonManager(options: DaemonManagerOptions): DaemonManager {
  const { paths, bundle, commands, log } = options;
  const desiredId = bundle ? bundleRuntimeId(bundle) : null;
  const marker = join(paths.home, "desktop-runtime");
  const listeners = new Set<(state: DesktopDaemonState) => void>();
  let runtime: RuntimeStatus | null = null;
  let busy: DesktopDaemonBusy | undefined;
  let error: DaemonFacts["error"];
  let disposed = false;
  let action: Promise<void> | null = null;
  let state = derive();

  function derive(): DesktopDaemonState {
    const registered = existsSync(paths.credentials);
    const installed = existsSync(marker);
    const facts: DaemonFacts = {
      bundle: bundle ? { version: bundle.version } : null,
      installationExists: installed, supervisorExists: installed, workerExists: installed,
      registered, daemonId: registered ? parseCredentialsDaemonId(readText(paths.credentials)) : null,
      pendingAuth: registered ? null : parsePendingAuth(readText(paths.pendingAuth)),
      running: runtime !== null,
      fda: parseFdaStatus(readText(paths.fdaStatus)),
      runningVersion: runtime?.version ?? parseSupervisorVersion(readText(paths.supervisorVersion)),
      binDir: paths.binDir,
      updateReadyOverride: !!(runtime && desiredId && runtime.runtimeId !== desiredId),
      ...(busy ? { busy } : {}), ...(error ? { error } : {}),
    };
    return { ...deriveDaemonState(facts), runningTerminals: runtime?.sessions.length ?? 0,
      legacyInstallation: !installed && existsSync(paths.plist) };
  }
  function emit(): void { if (!disposed) { state = derive(); for (const listener of listeners) listener(state); } }
  async function refresh(): Promise<void> {
    try { runtime = await runtimeStatus(paths.home); }
    catch (failure) { error = { action: "start", message: failure instanceof Error ? failure.message : String(failure) }; }
    emit();
  }
  async function run(kind: DesktopDaemonBusy, body: () => Promise<void>): Promise<void> {
    if (action) return action;
    busy = kind;
    error = undefined;
    emit();
    action = (async () => {
      try { await body(); }
      catch (failure) {
        error = { action: kind, message: failure instanceof Error ? failure.message : String(failure) };
        log.warn("本机操作失败", { action: kind, message: error.message });
      } finally { busy = undefined; await refresh(); action = null; }
    })();
    return action;
  }
  async function migrateLegacy(): Promise<boolean> {
    if (!existsSync(paths.plist)) return true;
    // 不自动接管系统服务：用户必须知道迁移会结束其终端。
    if (!await options.confirmStop("migrate", null)) return false;
    if (options.platform === "darwin") {
      const found = await commands.exec("/bin/launchctl", ["print", `gui/${options.uid}/${LAUNCHD_LABEL}`]);
      if (found.code === 0) {
        const stopped = await commands.exec("/bin/launchctl", ["unload", paths.plist]);
        if (stopped.code !== 0) throw new Error("旧版本仍在运行，已取消切换，请稍后重试");
      }
    }
    rmSync(paths.plist, { force: true });
    return true;
  }
  function installCli(): void {
    if (!bundle) return;
    mkdirSync(paths.binDir, { recursive: true });
    const temporary = `${paths.cliBin}.staged-${process.pid}`;
    try {
      copyFileSync(join(bundle.dir, "cofluxd"), temporary);
      chmodSync(temporary, 0o755);
      renameSync(temporary, paths.cliBin);
    } finally { rmSync(temporary, { force: true }); }
  }
  async function start(): Promise<void> {
    // 先验证真实运行实例，不因版本变化杀掉它或重写它使用的插件/CLI。
    runtime = await runtimeStatus(paths.home);
    if (runtime) { installCli(); return; }
    if (!bundle || !desiredId) throw new Error("此安装包不完整，请重新安装 Coflux");
    if (!await migrateLegacy()) return;
    mkdirSync(paths.home, { recursive: true, mode: 0o700 });
    chmodSync(paths.home, 0o700);
    let previous: unknown;
    try { previous = JSON.parse(readText(paths.settings) ?? "null"); } catch { previous = null; }
    writeFileSync(paths.settings, daemonSettingsJson(buildDaemonSettings(previous, {
      serverUrl: daemonServerUrl(options.clientServerUrl), hostname: options.hostname,
    })), { mode: 0o600 });
    const directory = stageRuntime(paths.home, bundle, desiredId);
    installCli();
    writeFileSync(marker, `${desiredId}\n`, { mode: 0o600 });
    runtime = await startRuntime(paths.home, directory, desiredId, paths.logFile);
  }
  async function stopConfirmed(reason: StopReason): Promise<boolean> {
    runtime = await runtimeStatus(paths.home);
    if (!runtime) return true;
    if (runtime.sessions.length && !await options.confirmStop(reason, runtime.sessions.length)) return false;
    await stopRuntime(paths.home, runtime);
    runtime = null;
    emit();
    return true;
  }
  const poll = setInterval(() => { if (!action) void refresh(); }, 1500);
  poll.unref();
  void refresh();
  return {
    getState: () => state, refresh,
    onChange: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    enroll: () => run("start", start),
    restart: () => run("restart", async () => { if (await stopConfirmed("restart")) await start(); }),
    stop: () => run("stop", async () => { await stopConfirmed("stop"); }),
    remove: () => run("remove", async () => { if (await stopConfirmed("stop")) rmSync(marker, { force: true }); }),
    stopForExit: async (reason) => {
      if (action) await action;
      return stopConfirmed(reason);
    },
    openFdaGuide: () => {
      commands.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles");
      commands.showItemInFolder(options.appPath);
    },
    dismissError: () => { error = undefined; emit(); },
    dispose: () => { disposed = true; clearInterval(poll); listeners.clear(); },
  };
}
