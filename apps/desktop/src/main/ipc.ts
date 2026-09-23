import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";

import type {
  DesktopBrowserLoginResult,
  DesktopDaemonState,
  DesktopExecutorCatalog,
  DesktopExecutorInbound,
  DesktopExecutorSaveInput,
  DesktopExecutorSaveResult,
  DesktopExecutorSettings,
  DesktopExecutorTestResult,
  DesktopLoginOptions,
  DesktopLoginProvider,
  DesktopNotification,
  DesktopUpdateState,
} from "../shared/desktop-bridge";
import { IPC, type Bootstrap } from "../shared/ipc";
import {
  sanitizeBadgeCount,
  sanitizeClipboardText,
  sanitizeExecutorChannel,
  sanitizeExecutorInbound,
  sanitizeExecutorSave,
  sanitizeNotification,
  sanitizeSessionToken,
} from "./ipc-sanitize";
import { isTrustedRendererUrl } from "./ipc-trust";
import { isLoginProvider } from "./browser-login";

export type TrustedSenders = { appOrigin: string; devRendererUrl?: string };

export type IpcActions = {
  bootstrap: () => Bootstrap;
  connectLocal: () => Promise<void>;
  logoutLocal: () => Promise<boolean>;
  notify: (notification: DesktopNotification) => void;
  setBadge: (count: number) => void;
  /** 终端 OSC 52：渲染层解码好的文本写进系统剪贴板（只写不读） */
  writeClipboard: (text: string) => void;
  /** 「服务器地址…」原生对话框（plan 110）：与原生菜单项同一个实现 */
  showServerInfo: () => void;
  checkForUpdates: () => void;
  installUpdate: () => void;
  getUpdateState: () => DesktopUpdateState;
  /** 会话 token（plan 106）：主进程 safeStorage 加密落盘；读不到一律空串 */
  getSessionToken: () => string;
  setSessionToken: (token: string) => void;
  clearSessionToken: () => void;
  /** Browser sign-in (plan 20260923): the renderer asks, the main process does the whole flow. */
  getLoginOptions: () => Promise<DesktopLoginOptions>;
  startBrowserLogin: (provider: DesktopLoginProvider) => Promise<DesktopBrowserLoginResult>;
  reopenBrowserLogin: () => void;
  cancelBrowserLogin: () => void;
  /** 本机 daemon（plan 113）：一个状态对象 + 无参窄动词，载荷为空，来源校验即全部校验 */
  getDaemonState: () => DesktopDaemonState;
  daemonEnroll: () => void;
  daemonRestart: () => void;
  daemonStop: () => void;
  daemonRemove: () => void;
  daemonOpenFdaGuide: () => void;
  daemonDismissError: () => void;
  /** executor（plan 116 / 20260918）：渲染层只当信使与设置面，作业表与凭据都在主进程。
   * 凭据是单向的——保存时可以往里送，任何一条回程都不含凭据。 */
  getExecutorSettings: () => DesktopExecutorSettings;
  getExecutorCatalog: () => Promise<DesktopExecutorCatalog>;
  saveExecutorSettings: (input: DesktopExecutorSaveInput) => Promise<DesktopExecutorSaveResult>;
  testExecutorConnection: () => Promise<DesktopExecutorTestResult>;
  executorInbound: (message: DesktopExecutorInbound) => void;
  /** daemonId 空串 = 本机 daemon 的 device 通道断了；generation 标识这一次连接 */
  executorChannel: (daemonId: string, generation: number) => void;
};

/** 每条 IPC 都先校验发送方 frame 来源；不可信一律忽略。 */
export function registerIpc(actions: IpcActions, trusted: TrustedSenders): void {
  const isTrusted = (event: IpcMainEvent | IpcMainInvokeEvent) => isTrustedRendererUrl(event.senderFrame?.url, trusted);

  ipcMain.handle(IPC.connectLocal, (event) => {
    if (!isTrusted(event)) throw new Error("untrusted sender");
    return actions.connectLocal();
  });
  ipcMain.handle(IPC.logoutLocal, (event) => {
    if (!isTrusted(event)) throw new Error("untrusted sender");
    return actions.logoutLocal();
  });
  ipcMain.on(IPC.bootstrap, (event) => {
    if (!isTrusted(event)) {
      event.returnValue = null;
      return;
    }
    event.returnValue = actions.bootstrap();
  });

  ipcMain.on(IPC.notify, (event, payload: unknown) => {
    if (!isTrusted(event)) return;
    const notification = sanitizeNotification(payload);
    if (notification) actions.notify(notification);
  });

  ipcMain.on(IPC.setBadge, (event, payload: unknown) => {
    if (!isTrusted(event)) return;
    const count = sanitizeBadgeCount(payload);
    if (count !== null) actions.setBadge(count);
  });

  ipcMain.on(IPC.clipboardWrite, (event, payload: unknown) => {
    if (!isTrusted(event)) return;
    const text = sanitizeClipboardText(payload);
    if (text !== null) actions.writeClipboard(text);
  });

  ipcMain.on(IPC.showServerInfo, (event) => {
    if (isTrusted(event)) actions.showServerInfo();
  });

  ipcMain.on(IPC.checkForUpdates, (event) => {
    if (isTrusted(event)) actions.checkForUpdates();
  });

  ipcMain.on(IPC.installUpdate, (event) => {
    if (isTrusted(event)) actions.installUpdate();
  });

  ipcMain.handle(IPC.getUpdateState, (event) => {
    if (!isTrusted(event)) throw new Error("untrusted sender");
    return actions.getUpdateState();
  });

  ipcMain.handle(IPC.getSessionToken, (event) => {
    if (!isTrusted(event)) throw new Error("untrusted sender");
    return actions.getSessionToken();
  });

  ipcMain.on(IPC.setSessionToken, (event, payload: unknown) => {
    if (!isTrusted(event)) return;
    const token = sanitizeSessionToken(payload);
    if (token !== null) actions.setSessionToken(token);
  });

  ipcMain.on(IPC.clearSessionToken, (event) => {
    if (isTrusted(event)) actions.clearSessionToken();
  });

  ipcMain.handle(IPC.loginOptions, (event) => {
    if (!isTrusted(event)) throw new Error("untrusted sender");
    return actions.getLoginOptions();
  });

  ipcMain.handle(IPC.loginStart, (event, payload: unknown) => {
    if (!isTrusted(event)) throw new Error("untrusted sender");
    if (!isLoginProvider(payload)) return Promise.resolve({ ok: false, reason: "failed", message: "不支持该登录方式" } satisfies DesktopBrowserLoginResult);
    return actions.startBrowserLogin(payload);
  });

  ipcMain.on(IPC.loginReopen, (event) => {
    if (isTrusted(event)) actions.reopenBrowserLogin();
  });

  ipcMain.on(IPC.loginCancel, (event) => {
    if (isTrusted(event)) actions.cancelBrowserLogin();
  });

  ipcMain.handle(IPC.daemonGetState, (event) => {
    if (!isTrusted(event)) throw new Error("untrusted sender");
    return actions.getDaemonState();
  });

  const daemonVerbs: [string, () => void][] = [
    [IPC.daemonEnroll, actions.daemonEnroll],
    [IPC.daemonRestart, actions.daemonRestart],
    [IPC.daemonStop, actions.daemonStop],
    [IPC.daemonRemove, actions.daemonRemove],
    [IPC.daemonOpenFdaGuide, actions.daemonOpenFdaGuide],
    [IPC.daemonDismissError, actions.daemonDismissError],
  ];
  for (const [channel, verb] of daemonVerbs) {
    ipcMain.on(channel, (event) => {
      if (isTrusted(event)) verb();
    });
  }

  ipcMain.handle(IPC.executorGetSettings, (event) => {
    if (!isTrusted(event)) throw new Error("untrusted sender");
    return actions.getExecutorSettings();
  });

  ipcMain.handle(IPC.executorGetCatalog, (event) => {
    if (!isTrusted(event)) throw new Error("untrusted sender");
    return actions.getExecutorCatalog();
  });

  ipcMain.handle(IPC.executorSave, (event, payload: unknown) => {
    if (!isTrusted(event)) throw new Error("untrusted sender");
    const input = sanitizeExecutorSave(payload);
    if (!input) return Promise.resolve({ ok: false, error: "保存请求的形状不对，已忽略" } satisfies DesktopExecutorSaveResult);
    return actions.saveExecutorSettings(input);
  });

  ipcMain.handle(IPC.executorTest, (event) => {
    if (!isTrusted(event)) throw new Error("untrusted sender");
    return actions.testExecutorConnection();
  });

  ipcMain.on(IPC.executorInbound, (event, payload: unknown) => {
    if (!isTrusted(event)) return;
    const message = sanitizeExecutorInbound(payload);
    if (message) actions.executorInbound(message);
  });

  ipcMain.on(IPC.executorChannel, (event, payload: unknown) => {
    if (!isTrusted(event)) return;
    const channel = sanitizeExecutorChannel(payload);
    if (channel) actions.executorChannel(channel.daemonId, channel.generation);
  });
}
