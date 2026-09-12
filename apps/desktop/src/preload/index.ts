import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

import type {
  DesktopBridge,
  DesktopCommand,
  DesktopDaemonState,
  DesktopExecutorInbound,
  DesktopExecutorOutbound,
  DesktopExecutorSettings,
  DesktopNotification,
  DesktopUpdateState,
} from "../shared/desktop-bridge";
import type { NativeEvent, NativeTransportBridge } from "../shared/native-transport";
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

let nativeSendingBytes = 0;
let nativeSendingRecords = 0;
const nativeSending = new Map<string, number>();
const nativeListeners = new Set<(event: NativeEvent) => void>();
const nativeTransport: NativeTransportBridge | undefined = boot.tailcat ? {
  open: (request) => ipcRenderer.invoke(IPC.tailcatOpen, request),
  send(handle, frame) {
    const pending = nativeSending.get(handle) ?? 0;
    if (!(frame instanceof Uint8Array) || frame.byteLength === 0 || frame.byteLength > 30 * 1024 * 1024 || frame.byteLength + pending > 32 * 1024 * 1024 || frame.byteLength + nativeSendingBytes > 128 * 1024 * 1024 || nativeSendingRecords >= 1024) return false;
    const bytes = frame.byteLength; nativeSending.set(handle, pending + bytes); nativeSendingBytes += bytes; nativeSendingRecords++;
    void ipcRenderer.invoke(IPC.tailcatSend, handle, frame).then((ok) => { if (!ok) { ipcRenderer.send(IPC.tailcatClose, handle); for (const listener of nativeListeners) listener({ kind: "closed", handle }); } }).catch(() => { for (const listener of nativeListeners) listener({ kind: "closed", handle }); }).finally(() => { nativeSending.set(handle, (nativeSending.get(handle) ?? bytes) - bytes); if (!nativeSending.get(handle)) nativeSending.delete(handle); nativeSendingBytes -= bytes; nativeSendingRecords--; });
    return true;
  },
  close: (handle) => ipcRenderer.send(IPC.tailcatClose, handle),
  control: (online, hard) => ipcRenderer.send(IPC.tailcatControl, online, hard),
  onEvent(listener) { nativeListeners.add(listener); return () => nativeListeners.delete(listener); },
} : undefined;
if (nativeTransport) ipcRenderer.on(IPC.tailcatEvent, (_event, event: NativeEvent) => {
  try { for (const listener of nativeListeners) listener(event); }
  finally { if (event.kind === "frame") ipcRenderer.send(IPC.tailcatAck, event.handle, event.frame.byteLength); }
});

const bridge: DesktopBridge = {
  nativeTransport,
  connectLocal: () => ipcRenderer.invoke(IPC.connectLocal),
  logoutLocal: () => ipcRenderer.invoke(IPC.logoutLocal),
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
  getExecutorSettings() {
    return ipcRenderer.invoke(IPC.executorGetSettings) as Promise<DesktopExecutorSettings>;
  },
  onExecutorSettings(listener) {
    return subscribe<DesktopExecutorSettings>(IPC.executorSettings, listener);
  },
  setExecutorModel(provider: string, modelId: string) {
    ipcRenderer.send(IPC.executorSetModel, { provider: String(provider), modelId: String(modelId) });
  },
  setExecutorApiKey(apiKey: string) {
    ipcRenderer.send(IPC.executorSetApiKey, String(apiKey));
  },
  sendExecutorInbound(message: DesktopExecutorInbound) {
    ipcRenderer.send(IPC.executorInbound, message);
  },
  setExecutorChannel(daemonId: string) {
    ipcRenderer.send(IPC.executorChannel, String(daemonId));
  },
  onExecutorOutbound(listener) {
    return subscribe<DesktopExecutorOutbound>(IPC.executorOutbound, listener);
  },
};

contextBridge.exposeInMainWorld("cofluxDesktop", bridge);
