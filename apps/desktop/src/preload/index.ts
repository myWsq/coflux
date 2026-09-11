import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

import type { DesktopBridge, DesktopCommand, DesktopDaemonState, DesktopNotification, DesktopUpdateState } from "../shared/desktop-bridge";
import { IPC, type Bootstrap } from "../shared/ipc";

// 桥接对象的类型真相源在 ../shared/desktop-bridge.ts，这里只实现它。
// sandbox preload：只能是 CommonJS、只有 electron 的 contextBridge/ipcRenderer 可用，没有 Node 能力可泄露。

const boot = ipcRenderer.sendSync(IPC.bootstrap) as Bootstrap;

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, payload: T) => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

const bridge: DesktopBridge = {
  terminalMetrics: {
    enabled: boot.terminalMetricsEnabled === true,
    sample: (requestId) => ipcRenderer.send(IPC.terminalMetricsRequest, requestId),
    onSample: (listener) => subscribe(IPC.terminalMetricsSample, listener),
  },
  ghostty: {
    enabled: boot.ghosttyEnabled === true,
    create: (request) => ipcRenderer.invoke(IPC.ghosttyCreate, request),
    destroy: (key) => ipcRenderer.invoke(IPC.ghosttyDestroy, key),
    send: (messages) => ipcRenderer.send(IPC.ghosttySend, messages),
    onEvent: (listener) => subscribe(IPC.ghosttyEvent, listener),
  },
  platform: boot.platform,
  version: boot.version,
  serverUrl: boot.serverUrl,
  origin: boot.origin,
  notify(notification: DesktopNotification) {
    ipcRenderer.send(IPC.notify, {
      workspaceId: String(notification.workspaceId),
      title: String(notification.title),
      body: String(notification.body),
    });
  },
  setBadge(count: number) {
    ipcRenderer.send(IPC.setBadge, Number(count));
  },
  showServerInfo() {
    ipcRenderer.send(IPC.showServerInfo);
  },
  onFocusWorkspace(listener) {
    return subscribe<string>(IPC.focusWorkspace, listener);
  },
  onCommand(listener) {
    return subscribe<DesktopCommand>(IPC.command, listener);
  },
  checkForUpdates() {
    ipcRenderer.send(IPC.checkForUpdates);
  },
  installUpdate() {
    ipcRenderer.send(IPC.installUpdate);
  },
  getUpdateState() {
    return ipcRenderer.invoke(IPC.getUpdateState) as Promise<DesktopUpdateState>;
  },
  onUpdateState(listener) {
    return subscribe<DesktopUpdateState>(IPC.updateState, listener);
  },
  getSessionToken() {
    return (ipcRenderer.invoke(IPC.getSessionToken) as Promise<unknown>).then((token) => (typeof token === "string" ? token : ""));
  },
  setSessionToken(token: string) {
    ipcRenderer.send(IPC.setSessionToken, String(token));
  },
  clearSessionToken() {
    ipcRenderer.send(IPC.clearSessionToken);
  },
  getDaemonState() {
    return ipcRenderer.invoke(IPC.daemonGetState) as Promise<DesktopDaemonState>;
  },
  onDaemonState(listener) {
    return subscribe<DesktopDaemonState>(IPC.daemonState, listener);
  },
  daemonEnroll() {
    ipcRenderer.send(IPC.daemonEnroll);
  },
  daemonRestart() {
    ipcRenderer.send(IPC.daemonRestart);
  },
  daemonStop() {
    ipcRenderer.send(IPC.daemonStop);
  },
  daemonRemove() {
    ipcRenderer.send(IPC.daemonRemove);
  },
  daemonOpenFdaGuide() {
    ipcRenderer.send(IPC.daemonOpenFdaGuide);
  },
  daemonDismissError() {
    ipcRenderer.send(IPC.daemonDismissError);
  },
};

contextBridge.exposeInMainWorld("cofluxDesktop", bridge);
