import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, dialog, Menu, protocol, safeStorage, session, shell, type BrowserWindow } from "electron";

import { IPC } from "../shared/ipc";
import { APP_ORIGIN, APP_SCHEME, APP_URL, registerAppProtocol } from "./app-protocol";
import { locateDaemonBundle, resolveDaemonBundleDir } from "./daemon-bundle";
import { createDaemonManager, execCommand, type DaemonManager } from "./daemon-manager";
import { daemonHomePaths } from "./daemon-paths";
import { registerIpc } from "./ipc";
import { registerGhosttyIpc, routeGhosttyClipboard } from "./ghostty-ipc";
import { log } from "./log";
import { buildAppMenu } from "./menu";
import { setDockBadge, showWorkspaceNotification } from "./notifications";
import { DESKTOP_ORIGIN, rewriteHandshakeHeaders } from "./origin";
import { readSettingsFile, resolveServerUrl } from "./settings";
import { createTokenStore } from "./token-store";
import { registerTerminalMetrics } from "./terminal-metrics";
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
const ghosttyEnabled = process.env.COFLUX_GHOSTTY === "1" && process.platform === "darwin" && process.arch === "arm64";

// 未打包（electron-vite dev / preview、本机 pack 之外的直接启动）与安装版不共用 userData：token、IndexedDB
// 身份与 loopback grant 互不可见，本机联调不污染日常使用的安装版。必须在 requestSingleInstanceLock 之前设置
// （单实例锁文件就在 userData 里），否则 dev 与安装版还会互相抢锁。
if (!app.isPackaged) app.setPath("userData", `${app.getPath("userData")}-dev`);

// electron-vite 惯例：preload / 渲染层产物按主进程模块的相对位置找（out/main → out/preload、out/renderer）。
// 不用 app 的 appPath：`electron out/main/index.js` 直接启动时它指向 out/main，会多拼一层；
// 相对主模块的路径在 asar 内、electron-vite dev/preview、直接启动三种方式下都成立。
const PRELOAD_PATH = fileURLToPath(new URL("../preload/index.cjs", import.meta.url));
const RENDERER_ROOT = fileURLToPath(new URL("../renderer/", import.meta.url));

let mainWindow: BrowserWindow | null = null;
let quitting = false;
let daemonManager: DaemonManager | null = null;

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

  app.on("before-quit", () => {
    quitting = true;
    daemonManager?.dispose();
    log.info("退出");
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

    // 自动更新：generic provider 读仓库 desktop-updates 分支的 latest-mac.yml；状态变化广播给渲染层，
    // 版本准入被拒的状态页据此显示「需要更新」。quitAndInstall 前把 quitting 置位，close 钩子才放行关窗。
    const updater = createUpdater({
      enabled: app.isPackaged,
      beforeInstall: () => {
        quitting = true;
      },
    });
    updater.onChange((state) => sendToRenderer(IPC.updateState, state));

    // 本机 daemon（plan 113）：内置三件在 Resources/daemon（dev 实例是仓库内 build/daemon，同 stage 脚本落位），
    // 找不到时状态对象表达「本构建不带 daemon」而不崩。~/.coflux 与 LaunchAgent 全机唯一——dev 实例接管的
    // 是同一个真实 daemon，尊重 COFLUX_HOME 让开发者能指到别处。判定 / 文本 / 版本比较全在纯模块，这里只接
    // launchctl / codesign / shell 两跳。
    const daemonBundleDir = resolveDaemonBundleDir({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath() });
    const daemonBundle = locateDaemonBundle(daemonBundleDir);
    log.info("内置 daemon", daemonBundle ? { dir: daemonBundle.dir, version: daemonBundle.version } : { dir: daemonBundleDir, bundled: false });
    const daemon = createDaemonManager({
      paths: daemonHomePaths(homedir(), process.env),
      bundle: daemonBundle,
      clientServerUrl: serverUrl,
      hostname: hostname(),
      uid: process.getuid?.() ?? 0,
      platform: process.platform,
      commands: {
        exec: execCommand,
        openExternal: (url) => void shell.openExternal(url),
        showItemInFolder: (path) => shell.showItemInFolder(path),
      },
      log,
    });
    daemonManager = daemon;
    daemon.onChange((state) => sendToRenderer(IPC.daemonState, state));

    const terminalMetricsEnabled = process.env.COFLUX_TERMINAL_METRICS === "1";
    registerTerminalMetrics(terminalMetricsEnabled, trusted);
    registerGhosttyIpc(ghosttyEnabled, trusted);
    registerIpc(
      {
        bootstrap: () => ({ platform: process.platform, version: app.getVersion(), serverUrl, origin: DESKTOP_ORIGIN, ghosttyEnabled, terminalMetricsEnabled }),
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
          tokenStore.write(token);
        },
        clearSessionToken: tokenStore.clear,
        // 渲染层主动拉取（账号菜单挂载时）顺带触发一次含 launchctl 的全量刷新：用户驱动、低频
        getDaemonState: () => {
          void daemon.refresh();
          return daemon.getState();
        },
        daemonEnroll: () => void daemon.enroll(),
        daemonRestart: () => void daemon.restart(),
        daemonStop: () => void daemon.stop(),
        daemonRemove: () => void daemon.remove(),
        daemonOpenFdaGuide: daemon.openFdaGuide,
        daemonDismissError: daemon.dismissError,
      },
      trusted,
    );

    Menu.setApplicationMenu(
      buildAppMenu({
        ghosttyClipboard: ghosttyEnabled ? routeGhosttyClipboard : undefined,
        sendCommand: (command) => {
          showMainWindow();
          sendToRenderer(IPC.command, command);
        },
        showServerInfo: () => void showServerInfo(serverUrl),
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
