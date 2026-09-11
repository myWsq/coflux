import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";

import type {
  DesktopDaemonState,
  DesktopExecutorInbound,
  DesktopExecutorSettings,
  DesktopNotification,
  DesktopUpdateState,
} from "../shared/desktop-bridge";
import { IPC, type Bootstrap } from "../shared/ipc";
import {
  sanitizeBadgeCount,
  sanitizeExecutorApiKey,
  sanitizeExecutorInbound,
  sanitizeExecutorModel,
  sanitizeNotification,
  sanitizeSessionToken,
} from "./ipc-sanitize";
import { isTrustedRendererUrl } from "./ipc-trust";

export type TrustedSenders = { appOrigin: string; devRendererUrl?: string };

export type IpcActions = {
  bootstrap: () => Bootstrap;
  notify: (notification: DesktopNotification) => void;
  setBadge: (count: number) => void;
  /** 「服务器地址…」原生对话框（plan 110）：与原生菜单项同一个实现 */
  showServerInfo: () => void;
  checkForUpdates: () => void;
  installUpdate: () => void;
  getUpdateState: () => DesktopUpdateState;
  /** 会话 token（plan 106）：主进程 safeStorage 加密落盘；读不到一律空串 */
  getSessionToken: () => string;
  setSessionToken: (token: string) => void;
  clearSessionToken: () => void;
  /** 本机 daemon（plan 113）：一个状态对象 + 无参窄动词，载荷为空，来源校验即全部校验 */
  getDaemonState: () => DesktopDaemonState;
  daemonEnroll: () => void;
  daemonRestart: () => void;
  daemonStop: () => void;
  daemonRemove: () => void;
  daemonOpenFdaGuide: () => void;
  daemonDismissError: () => void;
  /** executor（plan 116）：渲染层只当信使，作业表与凭证都在主进程 */
  getExecutorSettings: () => DesktopExecutorSettings;
  setExecutorModel: (provider: string, modelId: string) => void;
  setExecutorApiKey: (apiKey: string) => void;
  executorInbound: (message: DesktopExecutorInbound) => void;
  /** 空串 = 本机 daemon 的 device 通道断了 */
  executorChannel: (daemonId: string) => void;
};

/** 每条 IPC 都先校验发送方 frame 来源；不可信一律忽略。 */
export function registerIpc(actions: IpcActions, trusted: TrustedSenders): void {
  const isTrusted = (event: IpcMainEvent | IpcMainInvokeEvent) => isTrustedRendererUrl(event.senderFrame?.url, trusted);

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

  ipcMain.on(IPC.executorSetModel, (event, payload: unknown) => {
    if (!isTrusted(event)) return;
    const model = sanitizeExecutorModel(payload);
    if (model) actions.setExecutorModel(model.provider, model.modelId);
  });

  ipcMain.on(IPC.executorSetApiKey, (event, payload: unknown) => {
    if (!isTrusted(event)) return;
    const key = sanitizeExecutorApiKey(payload);
    if (key !== null) actions.setExecutorApiKey(key);
  });

  ipcMain.on(IPC.executorInbound, (event, payload: unknown) => {
    if (!isTrusted(event)) return;
    const message = sanitizeExecutorInbound(payload);
    if (message) actions.executorInbound(message);
  });

  ipcMain.on(IPC.executorChannel, (event, payload: unknown) => {
    if (!isTrusted(event)) return;
    if (typeof payload === "string" && payload.length <= 128) actions.executorChannel(payload);
  });
}
