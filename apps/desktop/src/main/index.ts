import { NativeTailcatTransport } from "./tailcat-transport";
import { registerTailcatIpc } from "./tailcat-ipc";
import { startClientBroker } from "./client-broker";
import { createHash } from "node:crypto";
import { createDesktopAccount } from "./desktop-account";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { app, dialog, Menu, protocol, safeStorage, session, shell, type BrowserWindow } from "electron";

import { IPC } from "../shared/ipc";
import { APP_ORIGIN, APP_SCHEME, APP_URL, registerAppProtocol } from "./app-protocol";
import { locateClaudePluginDir, locateDaemonBundle, resolveDaemonBundleDir } from "./daemon-bundle";
import { createDaemonManager, execCommand, type DaemonManager } from "./daemon-manager";
import { daemonHomePaths } from "./daemon-paths";
import { registerIpc } from "./ipc";
import { log } from "./log";
import { buildAppMenu } from "./menu";
import { setDockBadge, showWorkspaceNotification } from "./notifications";
import { DESKTOP_ORIGIN, rewriteHandshakeHeaders } from "./origin";
import { createExecutorConfigStore } from "./executor-config";
import { createExecutorHost, type ExecutorHost } from "./executor-host";
import { readSettingsFile, resolveServerUrl } from "./settings";
import { createTokenStore } from "./token-store";
import { createUpdater } from "./updater";
import { createMainWindow } from "./window";

// scheme 特权只能在 ready 之前注册一次：standard（有 host、相对路径可解析）+ secure（安全上下文，
// IndexedDB/crypto.subtle 可用）+ fetch/流式/代码缓存。不 bypassCSP——CSP 由响应头自己带。
protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true } },
]);

// electron-vite dev 注入；打包运行时为空 → 一律走 coflux-app://app/
const devRendererUrl = process.env.ELECTRON_RENDERER_URL;
const trusted = { appOrigin: APP_ORIGIN, devRendererUrl };

// 未打包（electron-vite dev / preview、本机 pack 之外的直接启动）与安装版不共用 userData：token、IndexedDB
// 身份与 loopback grant 互不可见，本机联调不污染日常使用的安装版。必须在 requestSingleInstanceLock 之前设置
// （单实例锁文件就在 userData 里），否则 dev 与安装版还会互相抢锁。
if (process.env.COFLUX_DESKTOP_USER_DATA) {
  app.setPath("userData", resolve(process.env.COFLUX_DESKTOP_USER_DATA));
} else if (!app.isPackaged) app.setPath("userData", `${app.getPath("userData")}-dev`);

// electron-vite 惯例：preload / 渲染层产物按主进程模块的相对位置找（out/main → out/preload、out/renderer）。
// 不用 app 的 appPath：`electron out/main/index.js` 直接启动时它指向 out/main，会多拼一层；
// 相对主模块的路径在 asar 内、electron-vite dev/preview、直接启动三种方式下都成立。
const PRELOAD_PATH = fileURLToPath(new URL("../preload/index.cjs", import.meta.url));
const RENDERER_ROOT = fileURLToPath(new URL("../renderer/", import.meta.url));

let mainWindow: BrowserWindow | null = null;
let quitting = false;
let daemonManager: DaemonManager | null = null;
let localConnect: Promise<void> | null = null;
// Executor: the quit path has to reach the host, so it lives at module scope.
let executorHost: ExecutorHost | null = null;

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function sendToRenderer(channel: string, payload: unknown): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(channel, payload);
}

// userData 下的三份文件：settings.json 是用户手编的配置；session-token.bin 是 safeStorage 加密的会话 token；
// window-state.json 是窗口 bounds（plan 106）。后两份由 app 自己维护，不与 settings.json 混放。
const settingsPath = () => join(app.getPath("userData"), "settings.json");
const tokenPath = () => join(app.getPath("userData"), "session-token.bin");
const windowStatePath = () => join(app.getPath("userData"), "window-state.json");
// executor（plan 116）：非敏感项与 API key 分两个文件，后者同样 safeStorage 加密。
const executorSettingsPath = () => join(app.getPath("userData"), "executor.json");
const executorKeyPath = () => join(app.getPath("userData"), "executor-key.bin");

function currentServerUrl(): string {
  return resolveServerUrl({
    argv: process.argv,
    env: process.env,
    fileServerUrl: readSettingsFile(settingsPath()).serverUrl,
    packaged: app.isPackaged,
  });
}

/** 「服务器地址…」：显示当前地址与改法；按需生成 settings.json 让用户直接编辑。 */
async function showServerInfo(serverUrl: string): Promise<void> {
  const path = settingsPath();
  const { response } = await dialog.showMessageBox({
    type: "info",
    message: "服务器地址",
    detail: `${serverUrl}\n\n改为自托管中心：编辑 ${path} 的 serverUrl（重启生效），或用 --server=wss://…/client、环境变量 COFLUX_SERVER_URL 启动。`,
    buttons: ["好", "打开设置文件"],
    defaultId: 0,
    cancelId: 0,
  });
  if (response !== 1) return;
  if (!existsSync(path)) {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ serverUrl }, null, 2)}\n`);
  }
  shell.showItemInFolder(path);
}

/** 两条 WebSocket 握手（中心 /client、loopback /device）的 Origin 改写；判定见 origin.ts。 */
function installOriginRewrite(): void {
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ["<all_urls>"] }, (details, callback) => {
    const headers = rewriteHandshakeHeaders(
      { url: details.url, resourceType: details.resourceType, requestHeaders: details.requestHeaders },
      devRendererUrl,
    );
    callback(headers ? { requestHeaders: headers } : {});
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showMainWindow);

  let exitInFlight = false;
  app.on("before-quit", (event) => {
    // Executor teardown belongs to the *second*, committed pass only. The first pass still has to
    // ask the user, and they may cancel it; killing running jobs there would be unrecoverable.
    // This pass is also the common exit for the updater (`beforeInstall` sets `quitting` itself),
    // so it is the only place that covers quit-and-install. Running jobs must reach a definite
    // terminal state here: "the app closed, so the job stopped" is accepted, silence is not —
    // the CLI on the other end would poll forever.
    if (quitting || !daemonManager) {
      daemonManager?.dispose();
      executorHost?.stopRuns({ kind: "app-exit" });
      return;
    }
    event.preventDefault();
    if (exitInFlight) return;
    exitInFlight = true;
    void daemonManager.stopForExit("quit").then((confirmed) => {
      if (confirmed) { quitting = true; app.quit(); }
    }).catch((error) => {
      void dialog.showMessageBox({ type: "error", message: "未能退出 Coflux", detail: String(error), buttons: ["好"] });
    }).finally(() => { exitInFlight = false; });
  });

  app.on("activate", () => {
    // Dock 点击：窗口只是隐藏时恢复（close 只隐藏，不销毁）
    showMainWindow();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  void app.whenReady().then(() => {
    log.info("启动", { version: app.getVersion(), packaged: app.isPackaged, electron: process.versions.electron, userData: app.getPath("userData") });
    registerAppProtocol(RENDERER_ROOT);
    installOriginRewrite();

    // 渲染层不需要任何浏览器权限：通知走主进程 Notification，不经 Web Notification API；
    // 只放行全屏与剪贴板写入（用户手势）。其余（摄像头/麦克风/地理位置/...）一律拒绝。
    const allowedPermissions = new Set(["fullscreen", "clipboard-sanitized-write"]);
    session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => callback(allowedPermissions.has(permission)));
    session.defaultSession.setPermissionCheckHandler((_contents, permission) => allowedPermissions.has(permission));

    const serverUrl = currentServerUrl();
    log.info("服务器地址", serverUrl);

    // 会话 token（plan 106）：safeStorage 加密落 userData/session-token.bin；失败态归一为未登录（见 token-store.ts）。
    const tokenStore = createTokenStore({
      filePath: tokenPath(),
      codec: safeStorage,
      onError: (stage, error) => log.warn(`会话 token ${stage} 失败，按未登录处理`, error),
    });
    if (!safeStorage.isEncryptionAvailable()) log.warn("safeStorage 加密不可用：会话 token 不落盘，每次启动需重新登录");

    // executor（plan 116）：配置 + 作业表 + runner 全在主进程；渲染层只当 device 通道的信使。
    const executorConfig = createExecutorConfigStore({
      settingsPath: executorSettingsPath(),
      keyPath: executorKeyPath(),
      codec: safeStorage,
      onError: (stage, error) => log.warn(`executor 配置 ${stage} 失败`, error),
    });
    const executor = createExecutorHost({
      config: executorConfig,
      runnerPath: join(__dirname, "executor-runner.js"),
      sendToRenderer,
      log: (message) => log.info(message),
    });
    executorHost = executor;

    // 自动更新：generic provider 读仓库 desktop-updates 分支的 latest-mac.yml；状态变化广播给渲染层，
    // 版本准入被拒的状态页据此显示「需要更新」。quitAndInstall 前把 quitting 置位，close 钩子才放行关窗。
    const updater = createUpdater({
      enabled: app.isPackaged,
      beforeInstall: async () => {
        if (exitInFlight) return false;
        exitInFlight = true;
        // 等正在接入的操作收敛，避免应用退出后才启动新的本机实例。
        if (localConnect) await localConnect;
        await daemonManager?.refresh();
        if (daemonManager?.getState().error) { exitInFlight = false; return false; }
        quitting = true;
        return true;
      },
      onInstallError: () => { quitting = false; exitInFlight = false; },
    });
    updater.onChange((state) => sendToRenderer(IPC.updateState, state));

    // 本机 daemon（plan 113）：内置三件在 Resources/daemon（dev 实例是仓库内 build/daemon，同 stage 脚本落位），
    // 找不到时通过状态提示。开发实例使用独立目录；打包实例尊重 COFLUX_HOME，便于隔离验收。
    // 应用直接启动托管内核，只有迁移旧安装时才处理 LaunchAgent。
    const daemonBundleDir = resolveDaemonBundleDir({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath() });
    const daemonBundle = locateDaemonBundle(daemonBundleDir);
    log.info("内置 daemon", daemonBundle ? { dir: daemonBundle.dir, version: daemonBundle.version } : { dir: daemonBundleDir, bundled: false });
    // 内置 coflux 插件（plan 115）：与三件同在资源目录下，经子进程环境 COFLUX_CLAUDE_PLUGIN_DIR 注入给
    // supervisor，coflux 终端里的 claude 由 supervisor 的 shell 集成翻成 --plugin-dir 自动带上；不带就什么都不注入。
    const claudePluginDir = locateClaudePluginDir(daemonBundleDir);
    log.info("内置 coflux 插件", claudePluginDir ? { dir: claudePluginDir } : { bundled: false });
    const localPaths = daemonHomePaths(app.isPackaged && !process.env.COFLUX_HOME ? homedir() : app.getPath("userData"), app.isPackaged ? process.env : { ...process.env, COFLUX_HOME: join(app.getPath("userData"), "runtime") });
    mkdirSync(localPaths.home, { recursive: true, mode: 0o700 });
    const accountKey = createHash("sha256").update(serverUrl).digest("hex").slice(0, 16);
    const localAccount = createDesktopAccount(localPaths.home, serverUrl, createTokenStore({
      filePath: join(app.getPath("userData"), `desktop-account-${accountKey}.bin`), codec: safeStorage,
      onError: (stage) => log.warn("本机账号安全存储失败", { stage }),
    }));
    const daemon = createDaemonManager({
      paths: localPaths,
      bundle: daemonBundle,
      claudePluginDir,
      clientServerUrl: serverUrl,
      hostname: hostname(),
      uid: process.getuid?.() ?? 0,
      platform: process.platform,
      appPath: resolve(process.execPath, "../../.."),
      confirmStop: async (reason, count) => {
        const label = reason === "logout" ? "退出登录" : reason === "quit" ? "退出 Coflux" : reason === "restart" ? "重新启动本机终端" : reason === "migrate" ? "切换到 Coflux 应用管理" : "停止本机终端";
        const result = await dialog.showMessageBox({ type: "warning", message: `${label}？`,
          detail: count === null ? "切换会结束旧版本在这台 Mac 上的全部终端。项目文件不受影响。" : `这将结束本机 ${count} 个正在运行的终端及其中的程序。其他设备上的任务不受影响。`,
          buttons: ["取消", label], defaultId: 0, cancelId: 0,
        });
        return result.response === 1;
      },
      // Executor runs end exactly when the user confirms a local-runtime stop — quit, logout, and
      // the panel's stop / remove. A dismissed dialog, a restart, and a dropped device channel all
      // leave them running; `executorCancelReason` owns that whole decision.
      onStopOutcome: (reason, confirmed) => executorHost?.stopRuns({ kind: "runtime-stop", reason, confirmed }),
      commands: {
        exec: execCommand,
        openExternal: (url) => void shell.openExternal(url),
        showItemInFolder: (path) => shell.showItemInFolder(path),
      },
      log,
    });
    daemonManager = daemon;
    daemon.onChange((state) => sendToRenderer(IPC.daemonState, state));
    async function connectLocal(): Promise<void> {
      if (exitInFlight || quitting) return;
      if (localConnect) return localConnect;
      localConnect = (async () => {
        try {
          const token = tokenStore.read();
          if (!token) throw new Error("请先登录 Coflux");
          await localAccount.connect(token);
          if (exitInFlight || quitting) return;
          await daemon.enroll();
        } catch (error) {
          log.warn("本机接入失败", String(error));
          await dialog.showMessageBox({ type: "error", message: "本机暂未接入", detail: String(error), buttons: ["好"] });
        } finally { localConnect = null; }
      })();
      return localConnect;
    }
    // Logout clears account state only. `executor.json` and `executor-key.bin` are global app
    // configuration — the provider and model the user picked once, not something an account owns —
    // so they deliberately survive: signing back in must not mean configuring the executor again.
    // Running executor jobs do end here, through the confirmed `logout` stop (see `onStopOutcome`).
    async function logoutLocal(): Promise<boolean> {
      if (exitInFlight || quitting) return false;
      exitInFlight = true;
      try {
        if (localConnect) await localConnect;
        if (!await daemon.stopForExit("logout")) return false;
        nativeTransport?.setControl(false, true);
        localAccount.logout(tokenStore.read());
        if (!tokenStore.clear()) throw new Error("无法清除本机登录凭据，请重试退出登录");
        // 本机已停止且 outbox 已持久化；断网不会阻止退出登录。
        void localAccount.drain().catch(() => log.info("退出登录的云端清理将在联网后重试"));
        return true;
      } catch (error) {
        await dialog.showMessageBox({ type: "error", message: "未能完成退出登录", detail: String(error), buttons: ["好"] });
        return false;
      } finally { exitInFlight = false; }
    }
    const closeClientBroker = startClientBroker(localPaths.home, serverUrl, () =>
      !exitInFlight && !quitting && localAccount.accountId() ? tokenStore.read() : "",
    );
    app.once("will-quit", closeClientBroker);
    const cleanupTimer = setInterval(() => {
      if (!localConnect && !exitInFlight && localAccount.hasPending()) void localAccount.drain().catch(() => undefined);
    }, 30000);
    cleanupTimer.unref();


    const tailcatEnabled = !!daemonBundle;
    const nativeTransport = tailcatEnabled ? new NativeTailcatTransport(join(daemonBundle!.dir, "coflux-transport"), serverUrl, tokenStore.read, (event) => sendToRenderer(IPC.tailcatEvent, event), app.getVersion()) : undefined;
    if(nativeTransport) registerTailcatIpc(nativeTransport, trusted);
    app.once("will-quit", () => nativeTransport?.setControl(false, true));

    registerIpc(
      {
        connectLocal,
        logoutLocal,
        bootstrap: () => ({ tailcat: tailcatEnabled, platform: process.platform, version: app.getVersion(), serverUrl, origin: DESKTOP_ORIGIN }),
        // 点通知：把窗口带到前台并让渲染层选中该工作区
        notify: (notification) =>
          showWorkspaceNotification(notification, (workspaceId) => {
            showMainWindow();
            sendToRenderer(IPC.focusWorkspace, workspaceId);
          }),
        setBadge: setDockBadge,
        // 侧栏账号菜单的「服务器地址…」（plan 110）：与原生菜单项走同一个对话框
        showServerInfo: () => void showServerInfo(serverUrl),
        checkForUpdates: updater.checkForUpdates,
        installUpdate: updater.installUpdate,
        getUpdateState: updater.getState,
        getSessionToken: tokenStore.read,
        setSessionToken: (token) => {
          if(token !== tokenStore.read())nativeTransport?.setControl(false,true);
          tokenStore.write(token);
        },
        clearSessionToken: () => { nativeTransport?.setControl(false, true); tokenStore.clear(); },
        // 渲染层主动拉取（账号菜单挂载时）顺带触发一次含 launchctl 的全量刷新：用户驱动、低频
        getDaemonState: () => {
          void daemon.refresh();
          return daemon.getState();
        },
        daemonEnroll: () => void connectLocal(),
        daemonRestart: () => void daemon.restart(),
        daemonStop: () => void daemon.stop(),
        daemonRemove: () => void daemon.remove(),
        daemonOpenFdaGuide: daemon.openFdaGuide,
        daemonDismissError: daemon.dismissError,
        getExecutorSettings: executor.getSettings,
        setExecutorModel: executor.setModel,
        setExecutorApiKey: executor.setApiKey,
        executorInbound: executor.inbound,
        executorChannel: executor.setChannel,
      },
      trusted,
    );

    Menu.setApplicationMenu(
      buildAppMenu({
        sendCommand: (command) => {
          showMainWindow();
          sendToRenderer(IPC.command, command);
        },
        checkForUpdates: () => {
          showMainWindow();
          updater.checkForUpdates();
        },
      }),
    );

    mainWindow = createMainWindow({
      preloadPath: PRELOAD_PATH,
      url: devRendererUrl ?? APP_URL,
      trusted,
      isQuitting: () => quitting,
      windowStatePath: windowStatePath(),
      onStateError: (error) => log.warn("窗口位置写盘失败", error),
    });
  });
}
