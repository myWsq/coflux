import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

import type { DesktopBridge, DesktopCommand, DesktopNotification, DesktopUpdateState } from "../shared/desktop-bridge";
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
};

contextBridge.exposeInMainWorld("cofluxDesktop", bridge);
