import { execFile } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { dirname, join } from "node:path";
import { clearInterval, clearTimeout, setInterval, setTimeout } from "node:timers";

import type { DesktopDaemonBusy, DesktopDaemonState } from "../shared/desktop-bridge";
import type { DaemonBundle } from "./daemon-bundle";
import {
  buildDaemonSettings,
  daemonServerUrl,
  daemonSettingsJson,
  launchAgentPlist,
  parseCredentialsDaemonId,
  parseFdaStatus,
  parsePendingAuth,
  parseSupervisorVersion,
  shouldRewritePlist,
} from "./daemon-files";
import { DAEMON_BINARIES, LAUNCHD_LABEL, type DaemonBinaryName, type DaemonHomePaths } from "./daemon-paths";
import { deriveDaemonState, type DaemonFacts } from "./daemon-state";

/**
 * 本机 daemon 管理的薄适配层（plan 113）：判定 / 文本 / 版本比较都在纯模块里，这里只碰 fs、
 * `launchctl`、`codesign`、`fs.watch` 与两个 shell 动作（经注入，Electron 由 index.ts 接）。
 *
 * 刷新机制：~/.coflux 目录 fs.watch（pending-auth / credentials / fda-status / supervisor-version 的
 * 变化 300ms 内合并、只读文件，不查 launchctl）+ 30s 低频轮询与每个动作前后的 launchctl 查询。
 * 日志只记事件，绝不写 pending-auth.json / credentials.json 的内容。
 */

export type DaemonCommands = {
  /** 外部命令：只用于 /bin/launchctl 与 /usr/bin/codesign；退出码非 0 不抛，由调用方判 */
  exec: (file: string, args: readonly string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
  openExternal: (url: string) => void;
  showItemInFolder: (path: string) => void;
};

export type DaemonManagerOptions = {
  paths: DaemonHomePaths;
  /** null = 本构建不带 daemon：只能看状态，接入 / 换新不可用 */
  bundle: DaemonBundle | null;
  /**
   * 内置 coflux 插件目录的绝对路径（plan 115），经 plist 的 COFLUX_CLAUDE_PLUGIN_DIR 注入给 supervisor；
   * null = 本构建不带插件，plist 就不写这个键。这里只当字符串搬运，不解析、不落盘。
   */
  claudePluginDir: string | null;
  /** app 的 /client 地址；写 settings.json 时换成 /daemon */
  clientServerUrl: string;
  hostname: string;
  /** launchctl print gui/<uid>/… 用的用户 id */
  uid: number;
  /** 非 macOS 不做 ad-hoc 重签、不查 launchctl（app 只出 arm64 mac，这里只为 dev 安全） */
  platform: NodeJS.Platform;
  commands: DaemonCommands;
  log: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };
};

export type DaemonManager = {
  getState: () => DesktopDaemonState;
  /** 全量刷新（含 launchctl）；渲染层 getDaemonState 时顺带触发一次 */
  refresh: () => Promise<void>;
  onChange: (listener: (state: DesktopDaemonState) => void) => () => void;
  enroll: () => Promise<void>;
  restart: () => Promise<void>;
  stop: () => Promise<void>;
  remove: () => Promise<void>;
  openFdaGuide: () => void;
  dismissError: () => void;
  dispose: () => void;
};

const WATCH_DEBOUNCE_MS = 300;
const POLL_INTERVAL_MS = 30_000;
/** 动作后的补查：launchctl load 之后进程起来、写文件都要一点时间 */
const FOLLOW_UP_DELAYS_MS = [1_500, 5_000];
const FDA_SETTINGS_URL = "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles";

export function execCommand(file: string, args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(file, [...args], { encoding: "utf8", timeout: 30_000 }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code as number) : 1) : 0;
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createDaemonManager(options: DaemonManagerOptions): DaemonManager {
  const { paths, bundle, commands, log } = options;
  const isMac = options.platform === "darwin";
  const listeners = new Set<(state: DesktopDaemonState) => void>();
  let running = false;
  let busy: DesktopDaemonBusy | undefined;
  let error: DaemonFacts["error"];
  let state = derive();
  let watcher: FSWatcher | null = null;
  let watchTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  function readFacts(): DaemonFacts {
    const facts: DaemonFacts = {
      bundle: bundle ? { version: bundle.version } : null,
      plistExists: existsSync(paths.plist),
      supervisorExists: existsSync(paths.supervisorBin),
      workerExists: existsSync(paths.workerBin),
      registered: existsSync(paths.credentials),
      daemonId: null,
      pendingAuth: null,
      running,
      fda: parseFdaStatus(readText(paths.fdaStatus)),
      runningVersion: parseSupervisorVersion(readText(paths.supervisorVersion)),
      binDir: paths.binDir,
    };
    if (facts.registered) facts.daemonId = parseCredentialsDaemonId(readText(paths.credentials));
    else facts.pendingAuth = parsePendingAuth(readText(paths.pendingAuth));
    if (busy) facts.busy = busy;
    if (error) facts.error = error;
    return facts;
  }

  function derive(): DesktopDaemonState {
    return deriveDaemonState(readFacts());
  }

  function emit(): void {
    state = derive();
    for (const listener of listeners) listener(state);
    ensureWatcher();
  }

  /** ~/.coflux 可能还不存在（干净机器）：存在时才挂 watcher，之后每次 emit 再试一次 */
  function ensureWatcher(): void {
    if (watcher || disposed || !existsSync(paths.home)) return;
    try {
      watcher = watch(paths.home, { persistent: false }, () => {
        if (watchTimer) return;
        watchTimer = setTimeout(() => {
          watchTimer = null;
          // 上次 launchctl 还说没在跑、但目录里有动静（pending-auth / fda-status 刚落盘）：多半是刚起来，
          // 顺带查一次 pid，别让进度页等到 30s 轮询才推进；其余情况只读文件
          if (!running && existsSync(paths.plist)) void refresh();
          else emit();
        }, WATCH_DEBOUNCE_MS);
      });
      watcher.on("error", (watchError) => {
        log.warn("daemon 目录监视中断，退回轮询", errorMessage(watchError));
        watcher?.close();
        watcher = null;
      });
    } catch (watchError) {
      log.warn("daemon 目录监视失败，退回轮询", errorMessage(watchError));
      watcher = null;
    }
  }

  /** launchd 判活：label 登记 ≠ 进程存活，必须看 pid（cofluxd 2026-07-25 踩过的坑） */
  async function queryRunning(): Promise<boolean> {
    if (!isMac) return false;
    const result = await commands.exec("/bin/launchctl", ["print", `gui/${options.uid}/${LAUNCHD_LABEL}`]);
    return result.code === 0 && /^\s*pid = \d+/m.test(result.stdout);
  }

  async function refresh(): Promise<void> {
    running = await queryRunning();
    if (!disposed) emit();
  }

  function scheduleFollowUps(): void {
    for (const delay of FOLLOW_UP_DELAYS_MS) setTimeout(() => void refresh(), delay).unref();
  }

  async function resignAdHoc(path: string): Promise<void> {
    if (!isMac) return;
    // 新落盘二进制带 provenance，launchd 顶层 spawn 被 AMFI 静默 SIGKILL；ad-hoc 重签使其成为「本机产物」
    const result = await commands.exec("/usr/bin/codesign", ["--force", "-s", "-", path]);
    if (result.code !== 0) throw new Error(`codesign 重签失败：${result.stderr.trim() || `退出码 ${result.code}`}`);
  }

  /** 三件先落同目录临时文件、重签、再 rename 原子替换 */
  async function installBinaries(): Promise<void> {
    if (!bundle) throw new Error("本构建不带内置 daemon");
    mkdirSync(paths.home, { recursive: true, mode: 0o700 });
    chmodSync(paths.home, 0o700);
    mkdirSync(paths.binDir, { recursive: true });
    for (const name of DAEMON_BINARIES) {
      const target = join(paths.binDir, name);
      const staged = join(paths.binDir, `.${name}.staged-${process.pid}`);
      try {
        copyFileSync(join(bundle.dir, name), staged);
        chmodSync(staged, 0o755);
        await resignAdHoc(staged);
        renameSync(staged, target);
      } catch (installError) {
        rmSync(staged, { force: true });
        throw new Error(`${name as DaemonBinaryName} 落盘失败：${errorMessage(installError)}`);
      }
    }
  }

  function writeSettings(): void {
    let existing: unknown = null;
    const raw = readText(paths.settings);
    if (raw) {
      try {
        existing = JSON.parse(raw);
      } catch {
        existing = null;
      }
    }
    const settings = buildDaemonSettings(existing, { serverUrl: daemonServerUrl(options.clientServerUrl), hostname: options.hostname });
    writeFileSync(paths.settings, daemonSettingsJson(settings), { mode: 0o600 });
    chmodSync(paths.settings, 0o600);
  }

  function renderPlist(): string {
    return launchAgentPlist(paths, { claudePluginDir: options.claudePluginDir });
  }

  function writePlist(): void {
    mkdirSync(dirname(paths.plist), { recursive: true });
    writeFileSync(paths.plist, renderPlist());
  }

  /**
   * 启动期 plist 同步（plan 115）：已接入的机器上，磁盘内容与当前 app 渲染出的不同就**只重写文件**——
   * npm 接入的机器、旧版 app 写的没有 COFLUX_CLAUDE_PLUGIN_DIR、app 换了位置都走这条。
   * 不碰 launchctl（reload 会结束本机所有终端），新值在下一次 supervisor 启动时生效；
   * 未接入的机器（plist 不存在）不凭空创建。失败只记日志，不影响状态。
   */
  function syncPlistOnStart(): void {
    try {
      if (!shouldRewritePlist(readText(paths.plist), renderPlist())) return;
      writePlist();
      log.info("LaunchAgent plist 已按当前 app 重写，下次 daemon 启动生效（不自动重启）");
    } catch (syncError) {
      log.warn("LaunchAgent plist 重写失败，沿用磁盘上的旧内容", errorMessage(syncError));
    }
  }

  async function launchctl(action: "load" | "unload"): Promise<{ code: number; stderr: string }> {
    if (!isMac) return { code: 1, stderr: "仅 macOS 支持 launchd" };
    const result = await commands.exec("/bin/launchctl", [action, paths.plist]);
    return { code: result.code, stderr: result.stderr };
  }

  async function startService(): Promise<void> {
    await launchctl("unload"); // 已登记的旧实例先卸掉，失败忽略（本来就没加载）
    const loaded = await launchctl("load");
    if (loaded.code !== 0) throw new Error(`launchctl load 失败：${loaded.stderr.trim() || `退出码 ${loaded.code}`}`);
  }

  /** 串行执行一个动作：busy 期间其余动作忽略；失败落 error，成功清 error */
  async function runAction(action: DesktopDaemonBusy, body: () => Promise<void>): Promise<void> {
    if (busy) return;
    busy = action;
    error = undefined;
    emit();
    try {
      await body();
      log.info(`daemon ${action} 完成`);
    } catch (actionError) {
      const message = errorMessage(actionError);
      log.warn(`daemon ${action} 失败`, message);
      // enroll 中途会把 busy 换成 start：错误归到当时正在做的那一步
      error = { action: busy ?? action, message };
    } finally {
      busy = undefined;
    }
    await refresh();
    scheduleFollowUps();
  }

  async function enroll(): Promise<void> {
    if (!bundle) {
      error = { action: "install", message: "本构建不带内置 daemon，无法接入" };
      emit();
      return;
    }
    await runAction("install", async () => {
      await installBinaries();
      writeSettings();
      writePlist();
      // 第二步换 busy 标签让进度页能分别显示两步；同一串行段内不经 runAction 的门禁
      busy = "start";
      emit();
      await startService();
    });
  }

  async function restart(): Promise<void> {
    await runAction("restart", async () => {
      if (!state.installed) throw new Error("尚未接入");
      // 用户点了「重启」才换二进制：内置更新时先替换三件再 unload/load，从不在 app 启动时预先替换
      if (bundle && state.status === "update-ready") await installBinaries();
      await startService();
    });
  }

  async function stop(): Promise<void> {
    await runAction("stop", async () => {
      if (!state.installed) throw new Error("尚未接入");
      const result = await launchctl("unload");
      if (result.code !== 0) throw new Error(`launchctl unload 失败：${result.stderr.trim() || `退出码 ${result.code}`}`);
    });
  }

  /** cofluxd uninstall 无 --purge：unload、删 plist、删三件，保留 ~/.coflux 里的凭证 / 配置 / 日志 */
  async function remove(): Promise<void> {
    await runAction("remove", async () => {
      await launchctl("unload");
      rmSync(paths.plist, { force: true });
      for (const name of DAEMON_BINARIES) rmSync(join(paths.binDir, name), { force: true });
    });
  }

  function openFdaGuide(): void {
    // macOS 不允许程序自动弹 FDA 授权窗：跳系统设置面板 + Finder 定位 supervisor 二进制（cofluxd fda 同法）
    commands.openExternal(FDA_SETTINGS_URL);
    commands.showItemInFolder(paths.supervisorBin);
  }

  function dismissError(): void {
    if (!error) return;
    error = undefined;
    emit();
  }

  syncPlistOnStart();
  const poll = setInterval(() => void refresh(), POLL_INTERVAL_MS);
  poll.unref();
  void refresh();

  return {
    getState: () => state,
    refresh,
    onChange: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    enroll,
    restart,
    stop,
    remove,
    openFdaGuide,
    dismissError,
    dispose: () => {
      disposed = true;
      clearInterval(poll);
      if (watchTimer) clearTimeout(watchTimer);
      watcher?.close();
      watcher = null;
    },
  };
}
