import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

import type {
  DesktopAnnotatorState,
  DesktopBridge,
  DesktopBrowserCertificate,
  DesktopBrowserClearTarget,
  DesktopBrowserCommand,
  DesktopBrowserEvent,
  DesktopBrowserLoginResult,
  DesktopBrowserPrepared,
  DesktopBrowserRect,
  DesktopBrowserScope,
  DesktopCommand,
  DesktopDaemonState,
  DesktopExecutorCatalog,
  DesktopExecutorInbound,
  DesktopExecutorOutbound,
  DesktopExecutorSaveInput,
  DesktopExecutorSaveResult,
  DesktopExecutorSettings,
  DesktopExecutorTestResult,
  DesktopFocusTarget,
  DesktopLoginOptions,
  DesktopLoginProvider,
  DesktopNotification,
  DesktopScreenEvent,
  DesktopScreenSharingResult,
  DesktopUpdateState,
  DesktopWorkspaceFileResult,
} from "../shared/desktop-bridge";
import { SCREEN_PORT_MESSAGE } from "../shared/desktop-bridge";
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

/** A browser scope rebuilt as a plain object; main validates it field by field. */
function plainScope(scope: DesktopBrowserScope): { kind: string; id: string } {
  return { kind: String(scope?.kind), id: String(scope?.id) };
}

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
      notificationId: notification.notificationId,
      taskId: notification.taskId,
      title: String(notification.title),
      body: String(notification.body),
    });
  },
  setBadge(count: number) {
    ipcRenderer.send(IPC.setBadge, Number(count));
  },
  writeClipboard(text: string) {
    ipcRenderer.send(IPC.clipboardWrite, String(text));
  },
  showServerInfo() {
    ipcRenderer.send(IPC.showServerInfo);
  },
  onFocusNotification(listener) {
    return subscribe<DesktopNotification>(IPC.focusNotification, listener);
  },
  onFocusWorkspace(listener) {
    return subscribe<DesktopFocusTarget>(IPC.focusWorkspace, listener);
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
  getLoginOptions() {
    return ipcRenderer.invoke(IPC.loginOptions) as Promise<DesktopLoginOptions>;
  },
  startBrowserLogin(provider: DesktopLoginProvider) {
    return ipcRenderer.invoke(IPC.loginStart, String(provider)) as Promise<DesktopBrowserLoginResult>;
  },
  reopenBrowserLogin() {
    ipcRenderer.send(IPC.loginReopen);
  },
  cancelBrowserLogin() {
    ipcRenderer.send(IPC.loginCancel);
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
  daemonUpdatePtyd() {
    ipcRenderer.send(IPC.daemonUpdatePtyd);
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
  getExecutorCatalog() {
    return ipcRenderer.invoke(IPC.executorGetCatalog) as Promise<DesktopExecutorCatalog>;
  },
  saveExecutorSettings(input: DesktopExecutorSaveInput) {
    // Rebuilt field by field rather than forwarded: the renderer's object may carry anything, and
    // the main process re-validates anyway. `apiKey` is kept undefined when absent — an absent key
    // means "leave the stored one alone", an empty one means "clear it".
    return ipcRenderer.invoke(IPC.executorSave, {
      provider: String(input.provider),
      modelId: String(input.modelId),
      ...(input.apiKey === undefined ? {} : { apiKey: String(input.apiKey) }),
      customProviders: input.customProviders.map((provider) => ({
        id: String(provider.id),
        name: String(provider.name),
        baseUrl: String(provider.baseUrl),
        api: String(provider.api),
        models: provider.models.map((model) => ({ id: String(model.id), name: String(model.name) })),
        authHeader: provider.authHeader === true,
        keyless: provider.keyless === true,
        ...(provider.apiKey === undefined ? {} : { apiKey: String(provider.apiKey) }),
      })),
    }) as Promise<DesktopExecutorSaveResult>;
  },
  testExecutorConnection() {
    return ipcRenderer.invoke(IPC.executorTest) as Promise<DesktopExecutorTestResult>;
  },
  sendExecutorInbound(message: DesktopExecutorInbound) {
    ipcRenderer.send(IPC.executorInbound, message);
  },
  setExecutorChannel(daemonId: string, generation: number) {
    ipcRenderer.send(IPC.executorChannel, { daemonId: String(daemonId), generation: Number(generation) });
  },
  onExecutorOutbound(listener) {
    return subscribe<DesktopExecutorOutbound>(IPC.executorOutbound, listener);
  },
  // Built-in browser tabs (plan 20260924-desktop-browser-tab). Arguments are rebuilt as plain
  // values here; the main process validates them again.
  browserPrepare(scope: DesktopBrowserScope, daemonId: string) {
    return ipcRenderer.invoke(IPC.browserPrepare, { scope: plainScope(scope), daemonId: String(daemonId) }) as Promise<DesktopBrowserPrepared>;
  },
  browserNavigate(guestId: number, url: string) {
    ipcRenderer.send(IPC.browserNavigate, { guestId: Number(guestId), url: String(url) });
  },
  browserCommand(guestId: number, command: DesktopBrowserCommand) {
    ipcRenderer.send(IPC.browserCommand, { guestId: Number(guestId), command: String(command) });
  },
  browserCaptureVisible(guestId: number) {
    return ipcRenderer.invoke(IPC.browserCaptureVisible, { guestId: Number(guestId) }).then((ok) => ok === true);
  },
  browserFreeze(guestId: number) {
    return ipcRenderer.invoke(IPC.browserFreeze, { guestId: Number(guestId) }).then((value) => (typeof value === "string" ? value : null));
  },
  browserCaptureRegion(guestId: number, rect: DesktopBrowserRect) {
    return ipcRenderer
      .invoke(IPC.browserCaptureRegion, {
        guestId: Number(guestId),
        rect: { x: Number(rect.x), y: Number(rect.y), width: Number(rect.width), height: Number(rect.height) },
      })
      .then((ok) => ok === true);
  },
  browserReleaseFreeze(guestId: number) {
    ipcRenderer.send(IPC.browserReleaseFreeze, { guestId: Number(guestId) });
  },
  browserOpenDevTools(guestId: number, hostGuestId: number) {
    return ipcRenderer.invoke(IPC.browserOpenDevTools, { guestId: Number(guestId), hostGuestId: Number(hostGuestId) }).then((ok) => ok === true);
  },
  browserCloseDevTools(guestId: number) {
    ipcRenderer.send(IPC.browserCloseDevTools, { guestId: Number(guestId) });
  },
  browserClearData(scope: DesktopBrowserScope, target: DesktopBrowserClearTarget) {
    return ipcRenderer.invoke(IPC.browserClearData, { scope: plainScope(scope), target: String(target) }).then((ok) => ok === true);
  },
  browserCertificate(guestId: number, host: string) {
    return ipcRenderer.invoke(IPC.browserCertificate, { guestId: Number(guestId), host: String(host) }) as Promise<DesktopBrowserCertificate | null>;
  },
  browserTrustCertificate(guestId: number, host: string) {
    return ipcRenderer.invoke(IPC.browserTrustCertificate, { guestId: Number(guestId), host: String(host) }).then((ok) => ok === true);
  },
  browserTunnelFailure(guestId: number, url: string) {
    return ipcRenderer
      .invoke(IPC.browserTunnelFailure, { guestId: Number(guestId), url: String(url) })
      .then((reason) => (reason === "offline" || reason === "refused" || reason === "unsupported" ? reason : null));
  },
  onBrowserEvent(listener) {
    return subscribe<DesktopBrowserEvent>(IPC.browserEvent, listener);
  },
  browserAnnotatorSync(guestId: number, state: DesktopAnnotatorState) {
    // Rebuilt as plain data; main sanitizes every field again.
    ipcRenderer.send(IPC.browserAnnotatorSync, { guestId: Number(guestId), state: JSON.parse(JSON.stringify(state)) as unknown });
  },
  // Remote screen tabs (plan 20260929-remote-desktop).
  screenOpen(sessionId: string, daemonId: string) {
    return ipcRenderer.invoke(IPC.screenOpen, { sessionId: String(sessionId), daemonId: String(daemonId) }).then((ok) => ok === true);
  },
  screenSharingOpen(daemonId: string) {
    return ipcRenderer.invoke(IPC.screenSharingOpen, { daemonId: String(daemonId) }).then((result): DesktopScreenSharingResult => {
      if (result && typeof result === "object" && (result as { ok?: unknown }).ok === true) return { ok: true };
      const reason = (result as { reason?: unknown } | null)?.reason;
      return { ok: false, reason: reason === "refused" || reason === "unsupported" ? reason : "offline" };
    });
  },
  screenClose(sessionId: string) {
    ipcRenderer.send(IPC.screenClose, { sessionId: String(sessionId) });
  },
  screenFocus(focused: boolean) {
    ipcRenderer.send(IPC.screenFocus, focused === true);
  },
  screenImmersive(on: boolean) {
    ipcRenderer.send(IPC.screenImmersive, on === true);
  },
  onScreenEvent(listener) {
    return subscribe<DesktopScreenEvent>(IPC.screenEvent, listener);
  },
  revealWorkspaceFile(root: string, path: string) {
    return workspaceFileResult(ipcRenderer.invoke(IPC.workspaceFileReveal, String(root), String(path)));
  },
  openWorkspaceFile(root: string, path: string) {
    return workspaceFileResult(ipcRenderer.invoke(IPC.workspaceFileOpen, String(root), String(path)));
  },
};

/** Main answers `{ ok }` or `{ ok: false, error }`; anything else (a thrown handler) is a failure. */
function workspaceFileResult(reply: Promise<unknown>): Promise<DesktopWorkspaceFileResult> {
  return reply.then(
    (value) => {
      if (value && typeof value === "object" && (value as { ok?: unknown }).ok === true) return { ok: true } as const;
      const error = value && typeof value === "object" ? (value as { error?: unknown }).error : undefined;
      return { ok: false, error: typeof error === "string" && error ? error : "操作失败" } as const;
    },
    () => ({ ok: false, error: "操作失败" }) as const,
  );
}
// A session's MessagePort cannot cross the context bridge; the page receives it as a window message
// (Electron's documented port hand-off), keyed by session id.
ipcRenderer.on(IPC.screenPort, (event, sessionId: unknown) => {
  if (typeof sessionId !== "string" || event.ports.length === 0) return;
  window.postMessage({ type: SCREEN_PORT_MESSAGE, sessionId }, "*", event.ports);
});

contextBridge.exposeInMainWorld("cofluxDesktop", bridge);
