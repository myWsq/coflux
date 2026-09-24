import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  app,
  clipboard,
  ipcMain,
  Menu,
  session,
  webContents as allWebContents,
  type Certificate,
  type DownloadItem,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
  type NativeImage,
  type Session,
  type WebContents,
  type WebPreferences,
} from "electron";

import { isLoopbackUrl } from "../shared/browser-loopback";
import { BROWSER_DEVTOOLS_PARTITION } from "../shared/browser-partitions";
import type {
  DesktopBrowserCertificate,
  DesktopBrowserClearTarget,
  DesktopBrowserCommand,
  DesktopBrowserEvent,
  DesktopBrowserMode,
  DesktopBrowserPrepared,
  DesktopCommand,
} from "../shared/desktop-bridge";
import { IPC } from "../shared/ipc";
import {
  browserPartitionFor,
  classifyGuestKey,
  cropRectInPixels,
  decideWebviewAttach,
  isAllowedDevToolsNavigation,
  isAllowedPageNavigation,
  isCertificateTrusted,
  isKeyDown,
  parseTrustedCertificates,
  sanitizeBrowserCommand,
  sanitizeCaptureRegion,
  sanitizeCertificateQuery,
  sanitizeClearData,
  sanitizeDevToolsOpen,
  sanitizeGuestPayload,
  sanitizeNavigate,
  sanitizePrepare,
  serializeTrustedCertificates,
  stepZoomFactor,
  uniqueDownloadName,
  withTrustedCertificate,
  withoutPartitionCertificates,
  type GuestKeyAction,
  type TrustedCertificates,
} from "./browser-policy";
import { isTrustedRendererUrl } from "./ipc-trust";

/**
 * The main-process half of the built-in browser tab (plan 20260924-desktop-browser-tab).
 *
 * The renderer embeds pages with `<webview>` and owns every piece of chrome around them. This module
 * owns what must not be the renderer's: the per-workspace session partitions (permissions, the
 * remote-workspace loopback block, certificates, downloads), the gate every `<webview>` passes before
 * it may attach, the hardening and event plumbing of every guest (popups, keys, focus, favicons,
 * navigation state, zoom), docked DevTools, screenshots and clearing data. The rules themselves are
 * pure and live in browser-policy.ts.
 *
 * Order, always: the renderer asks to **prepare** a workspace's partition; only then does it insert
 * a `<webview>` with that partition and `src="about:blank"`, which the gate admits; only once the
 * guest is attached does it ask main to **navigate**. Preparing is where the session is configured
 * (slice 2 installs its proxy there, which is async — the reason it is not done in the synchronous
 * `will-attach-webview`).
 */

/** Permissions a dev page may use without a prompt; everything else is refused. */
const ALLOWED_PERMISSIONS = new Set(["clipboard-sanitized-write", "fullscreen"]);
/** A favicon larger than this is not worth a `data:` URL on the bridge. */
const MAX_FAVICON_BYTES = 256 * 1024;
const FAVICON_TIMEOUT_MS = 5000;
/** How long preparing waits for the local daemon id before calling the workspace remote. */
const DEFAULT_LOCAL_DAEMON_WAIT_MS = 3000;
const CERTIFICATES_FILE = "browser-certificates.json";

type TrustedSenders = { appOrigin: string; devRendererUrl?: string };

export type BrowserHostOptions = {
  userDataPath: string;
  downloadsPath: () => string;
  /** This Mac's daemon id as main derives it (daemon-state.ts); null while unknown. */
  localDaemonId: () => string | null;
  onLocalDaemonChange: (listener: () => void) => () => void;
  sendToRenderer: (channel: string, payload: unknown) => void;
  /** Forwards an app shortcut typed inside a page (the menu's `DesktopCommand` channel). */
  sendCommand: (command: DesktopCommand) => void;
  /** Hands a URL to the system browser (http(s) only). */
  openExternal: (url: string) => void;
  log: (message: string, detail?: unknown) => void;
  localDaemonWaitMs?: number;
};

export type BrowserHost = {
  /** The main window's `will-attach-webview`: harden the guest's preferences, then admit or refuse it. */
  gateWebview: (event: { preventDefault: () => void }, webPreferences: WebPreferences, params: Record<string, string>) => void;
  /** The main window's `did-attach-webview`: install the guest's handlers. */
  adoptGuest: (guest: WebContents) => void;
  /**
   * ⌘R from the menu: reloads the focused page guest — or the page of a focused docked DevTools
   * host — and returns true. False when no browser guest is focused: the caller reloads the window.
   */
  reloadFocusedGuest: () => boolean;
  registerIpc: (trusted: TrustedSenders) => void;
  /** The renderer was rebuilt: every guest is gone with it, and so is what was prepared for it. */
  reset: () => void;
  dispose: () => void;
};

type ConfiguredPartition = {
  session: Session;
  workspaceId: string;
  daemonId: string;
  /** The mode last reported to the renderer; null before the first prepare. */
  announced: DesktopBrowserMode | null;
};

type Guest = {
  kind: "page" | "devtools";
  partition: string;
  contents: WebContents;
  faviconSeq: number;
};

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

function isWebUrl(url: string): boolean {
  return url !== "about:blank" && isAllowedPageNavigation(url);
}

export function createBrowserHost(options: BrowserHostOptions): BrowserHost {
  const certificatesPath = join(options.userDataPath, CERTIFICATES_FILE);
  const configured = new Map<string, ConfiguredPartition>();
  const prepared = new Set<string>();
  const guests = new Map<number, Guest>();
  /** Page guest id → its docked DevTools host's id. */
  const devtoolsHostOf = new Map<number, number>();
  const frozen = new Map<number, NativeImage>();
  /** Per partition, per host: the certificate the last failed verification was about. */
  const failures = new Map<string, Map<string, DesktopBrowserCertificate>>();
  const downloadsInFlight = new Set<string>();
  let devtoolsSessionReady = false;
  let trusted: TrustedCertificates = readTrusted();

  function readTrusted(): TrustedCertificates {
    try {
      return existsSync(certificatesPath) ? parseTrustedCertificates(readFileSync(certificatesPath, "utf8")) : {};
    } catch (error) {
      options.log("浏览器已信任证书读取失败，按未信任处理", String(error));
      return {};
    }
  }

  function writeTrusted(): void {
    try {
      mkdirSync(dirname(certificatesPath), { recursive: true });
      writeFileSync(certificatesPath, serializeTrustedCertificates(trusted), { mode: 0o600 });
    } catch (error) {
      options.log("浏览器已信任证书写盘失败", String(error));
    }
  }

  function send(event: DesktopBrowserEvent): void {
    options.sendToRenderer(IPC.browserEvent, event);
  }

  function modeOf(entry: ConfiguredPartition): DesktopBrowserMode {
    const local = options.localDaemonId();
    return local !== null && local !== "" && entry.daemonId === local ? "local" : "remote";
  }

  // A workspace prepared while the local daemon id was unknown was reported as remote; once main
  // learns the id, any partition whose meaning changed is reported again. The loopback block reads
  // the mode on every request, so it follows immediately.
  const stopWatchingDaemon = options.onLocalDaemonChange(() => {
    for (const entry of configured.values()) {
      if (entry.announced === null) continue;
      const mode = modeOf(entry);
      if (mode === entry.announced) continue;
      entry.announced = mode;
      send({ kind: "mode", workspaceId: entry.workspaceId, mode });
    }
  });

  function waitForLocalDaemonId(): Promise<void> {
    if (options.localDaemonId()) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        stop();
        resolve();
      };
      const timer = setTimeout(finish, options.localDaemonWaitMs ?? DEFAULT_LOCAL_DAEMON_WAIT_MS);
      const stop = options.onLocalDaemonChange(() => {
        if (options.localDaemonId()) finish();
      });
    });
  }

  function recordFailure(partition: string, host: string, certificate: Certificate, error: string): void {
    let byHost = failures.get(partition);
    if (!byHost) {
      byHost = new Map();
      failures.set(partition, byHost);
    }
    byHost.set(host.toLowerCase(), {
      host: host.toLowerCase(),
      error,
      fingerprint: certificate.fingerprint,
      subject: certificate.subjectName,
      issuer: certificate.issuerName,
      validExpiry: certificate.validExpiry,
    });
  }

  /**
   * Certificate trust per partition, for every connection of that partition — top-level loads,
   * subresources and WebSockets alike (an https dev server's HMR socket must not fail after the page
   * was trusted). A valid certificate keeps Chromium's verdict; a trusted host + fingerprint is
   * accepted; anything else keeps Chromium's verdict (a failure) and is remembered for the prompt.
   * Never auto-trusts.
   */
  function verifyProcFor(partition: string) {
    return (request: { hostname: string; certificate: Certificate; verificationResult: string; errorCode: number }, callback: (result: number) => void) => {
      if (request.errorCode === 0) {
        callback(-3);
        return;
      }
      if (isCertificateTrusted(trusted, partition, request.hostname, request.certificate.fingerprint)) {
        callback(0);
        return;
      }
      recordFailure(partition, request.hostname, request.certificate, request.verificationResult);
      callback(-3);
    };
  }

  function denyPermissions(ses: Session): void {
    ses.setPermissionRequestHandler((_contents, permission, callback) => callback(ALLOWED_PERMISSIONS.has(permission)));
    ses.setPermissionCheckHandler((_contents, permission) => ALLOWED_PERMISSIONS.has(permission));
    ses.setDevicePermissionHandler(() => false);
  }

  function handleDownload(item: DownloadItem): void {
    const folder = options.downloadsPath();
    const name = uniqueDownloadName(item.getFilename(), (candidate) => {
      const path = join(folder, candidate);
      return downloadsInFlight.has(path) || existsSync(path);
    });
    const path = join(folder, name);
    downloadsInFlight.add(path);
    item.setSavePath(path);
    item.once("done", (_event, state) => {
      downloadsInFlight.delete(path);
      send({ kind: "download", filename: name, state });
    });
  }

  /**
   * One-time configuration of a workspace partition. Deliberately nothing of the app's own session:
   * no Origin rewrite (guest pages must send their real Origin), no app permissions.
   */
  function configureSession(ses: Session, partition: string): void {
    denyPermissions(ses);
    // Slice 1: a remote workspace's `localhost` is another device, which this slice cannot reach —
    // refuse every loopback request of such a partition (navigations, subresources, fetch/XHR,
    // WebSockets, redirects) rather than silently showing this Mac's. The mode is read per request.
    ses.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
      const entry = configured.get(partition);
      const block = entry !== undefined && modeOf(entry) === "remote" && isLoopbackUrl(details.url);
      callback(block ? { cancel: true } : {});
    });
    ses.setCertificateVerifyProc(verifyProcFor(partition));
    ses.on("will-download", (_event, item) => handleDownload(item));
  }

  function devtoolsSession(): Session {
    const ses = session.fromPartition(BROWSER_DEVTOOLS_PARTITION);
    if (!devtoolsSessionReady) {
      devtoolsSessionReady = true;
      denyPermissions(ses);
    }
    return ses;
  }

  async function prepare(workspaceId: string, daemonId: string): Promise<DesktopBrowserPrepared> {
    const partition = browserPartitionFor(workspaceId);
    if (!partition) throw new Error("工作区标识无效");
    let entry = configured.get(partition);
    if (!entry) {
      const ses = session.fromPartition(partition);
      configureSession(ses, partition);
      entry = { session: ses, workspaceId, daemonId, announced: null };
      configured.set(partition, entry);
    } else {
      entry.daemonId = daemonId;
    }
    await waitForLocalDaemonId();
    const mode = modeOf(entry);
    entry.announced = mode;
    prepared.add(partition);
    return { partition, mode };
  }

  function sendHistory(guest: Guest): void {
    const contents = guest.contents;
    if (contents.isDestroyed()) return;
    send({
      kind: "history",
      guestId: contents.id,
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
      zoomFactor: contents.getZoomFactor(),
    });
  }

  function zoom(guest: Guest, direction: "in" | "out" | "reset"): void {
    const contents = guest.contents;
    if (contents.isDestroyed()) return;
    contents.setZoomFactor(stepZoomFactor(contents.getZoomFactor(), direction));
    sendHistory(guest);
  }

  async function fetchFavicon(guest: Guest, iconUrl: string | undefined): Promise<string | null> {
    if (!iconUrl) return null;
    if (iconUrl.startsWith("data:image/")) return iconUrl.length <= MAX_FAVICON_BYTES * 1.4 ? iconUrl : null;
    if (!isWebUrl(iconUrl)) return null;
    const entry = configured.get(guest.partition);
    if (entry && modeOf(entry) === "remote" && isLoopbackUrl(iconUrl)) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FAVICON_TIMEOUT_MS);
    try {
      // Through the page's own session: its cookies, its certificates, its loopback rules.
      const response = await guest.contents.session.fetch(iconUrl, { signal: controller.signal });
      if (!response.ok) return null;
      let type = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      if (!type.startsWith("image/")) {
        if (/\.ico(\?|#|$)/i.test(iconUrl)) type = "image/x-icon";
        else if (/\.png(\?|#|$)/i.test(iconUrl)) type = "image/png";
        else if (/\.svg(\?|#|$)/i.test(iconUrl)) type = "image/svg+xml";
        else return null;
      }
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength === 0 || buffer.byteLength > MAX_FAVICON_BYTES) return null;
      return `data:${type};base64,${Buffer.from(buffer).toString("base64")}`;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  function loadFavicon(guest: Guest, favicons: readonly string[]): void {
    const seq = ++guest.faviconSeq;
    const pageUrl = guest.contents.getURL();
    void fetchFavicon(guest, favicons[0]).then((dataUrl) => {
      if (guest.faviconSeq !== seq || guests.get(guest.contents.id) !== guest) return;
      send({ kind: "favicon", guestId: guest.contents.id, pageUrl, dataUrl });
    });
  }

  function pageOfDevTools(hostId: number): Guest | null {
    for (const [pageId, linkedHost] of devtoolsHostOf) {
      if (linkedHost === hostId) return guests.get(pageId) ?? null;
    }
    return null;
  }

  function dispatchKey(page: Guest, action: GuestKeyAction): void {
    if (action.kind === "command") options.sendCommand(action.command);
    else if (action.kind === "browser") send({ kind: "key", guestId: page.contents.id, action: action.action });
    else zoom(page, action.direction);
  }

  function showContextMenu(guest: Guest, params: Electron.ContextMenuParams): void {
    const contents = guest.contents;
    const items: MenuItemConstructorOptions[] = [];
    if (params.linkURL && isWebUrl(params.linkURL)) {
      const link = params.linkURL;
      items.push(
        { label: "在新标签页中打开链接", click: () => send({ kind: "popup", guestId: contents.id, url: link }) },
        { label: "在系统浏览器中打开链接", click: () => options.openExternal(link) },
        { label: "复制链接地址", click: () => clipboard.writeText(link) },
        { type: "separator" },
      );
    }
    if (params.isEditable) {
      items.push(
        { label: "剪切", enabled: params.editFlags.canCut, click: () => contents.cut() },
        { label: "复制", enabled: params.editFlags.canCopy, click: () => contents.copy() },
        { label: "粘贴", enabled: params.editFlags.canPaste, click: () => contents.paste() },
        { label: "全选", enabled: params.editFlags.canSelectAll, click: () => contents.selectAll() },
        { type: "separator" },
      );
    } else if (params.selectionText) {
      items.push({ label: "复制", click: () => contents.copy() }, { type: "separator" });
    }
    items.push(
      { label: "返回", enabled: contents.navigationHistory.canGoBack(), click: () => contents.navigationHistory.goBack() },
      { label: "前进", enabled: contents.navigationHistory.canGoForward(), click: () => contents.navigationHistory.goForward() },
      { label: "重新加载", click: () => contents.reload() },
      { type: "separator" },
      {
        label: "检查",
        click: () => {
          // Docked DevTools are opened by the renderer (it owns the host webview); once open, this inspects in place.
          if (devtoolsHostOf.has(contents.id)) contents.inspectElement(params.x, params.y);
          else send({ kind: "key", guestId: contents.id, action: "toggle-devtools" });
        },
      },
    );
    Menu.buildFromTemplate(items).popup();
  }

  function installPageGuest(guest: Guest): void {
    const contents = guest.contents;
    // Pop-ups become browser tabs beside the opener; no real window is ever created.
    contents.setWindowOpenHandler(({ url }) => {
      if (isWebUrl(url)) send({ kind: "popup", guestId: contents.id, url });
      return { action: "deny" };
    });
    // Page-initiated main-frame navigations and redirects: http(s) and about:blank only. Main-initiated
    // loads already went through `sanitizeNavigate`.
    contents.on("will-navigate", (details) => {
      if (!details.isMainFrame || isAllowedPageNavigation(details.url)) return;
      details.preventDefault();
      options.openExternal(details.url);
    });
    contents.on("will-redirect", (details) => {
      if (details.isMainFrame && !isAllowedPageNavigation(details.url)) details.preventDefault();
    });
    // App shortcuts and the tab's own keys; the page keeps everything else (see classifyGuestKey).
    contents.on("before-input-event", (event, input) => {
      const action = classifyGuestKey(input);
      if (!action) return;
      event.preventDefault();
      if (isKeyDown(input.type)) dispatchKey(guest, action);
    });
    // DOM events never cross from a guest to the embedder: focus is reported from here.
    contents.on("focus", () => send({ kind: "focus", guestId: contents.id }));
    contents.on("page-favicon-updated", (_event, favicons) => loadFavicon(guest, favicons));
    contents.on("did-navigate", () => sendHistory(guest));
    contents.on("did-navigate-in-page", (_event, _url, isMainFrame) => {
      if (isMainFrame) sendHistory(guest);
    });
    contents.on("did-finish-load", () => sendHistory(guest));
    contents.on("zoom-changed", (_event, direction) => zoom(guest, direction));
    contents.on("devtools-closed", () => {
      devtoolsHostOf.delete(contents.id);
      send({ kind: "devtools-closed", guestId: contents.id });
    });
    // A link clicked inside DevTools (a source URL, a docs link) opens as a browser tab too.
    contents.on("devtools-open-url", (_event, url) => {
      if (isWebUrl(url)) send({ kind: "popup", guestId: contents.id, url });
    });
    contents.on("context-menu", (_event, params) => showContextMenu(guest, params));
  }

  function installDevToolsHost(guest: Guest): void {
    const contents = guest.contents;
    contents.setWindowOpenHandler(({ url }) => {
      options.openExternal(url);
      return { action: "deny" };
    });
    contents.on("will-navigate", (details) => {
      if (!isAllowedDevToolsNavigation(details.url)) details.preventDefault();
    });
    contents.on("before-input-event", (event, input) => {
      const action = classifyGuestKey(input);
      // DevTools zooms itself; ⌘L means nothing to it.
      if (!action || action.kind === "zoom") return;
      const page = pageOfDevTools(contents.id);
      if (action.kind === "browser" && !page) return;
      event.preventDefault();
      if (!isKeyDown(input.type)) return;
      if (action.kind === "command") options.sendCommand(action.command);
      else if (page) dispatchKey(page, action);
    });
    contents.on("focus", () => {
      const page = pageOfDevTools(contents.id);
      if (page) send({ kind: "focus", guestId: page.contents.id });
    });
  }

  function forgetGuest(id: number): void {
    guests.delete(id);
    frozen.delete(id);
    devtoolsHostOf.delete(id);
    for (const [pageId, hostId] of devtoolsHostOf) {
      if (hostId === id) devtoolsHostOf.delete(pageId);
    }
  }

  function gateWebview(event: { preventDefault: () => void }, webPreferences: WebPreferences, params: Record<string, string>): void {
    // Hardening comes first and applies whatever the verdict: no preload at all, no Node, sandboxed,
    // isolated, same-origin policy on, no nested webviews.
    const preferences = webPreferences as WebPreferences & { preloadURL?: string };
    delete preferences.preload;
    delete preferences.preloadURL;
    delete params.preload;
    preferences.nodeIntegration = false;
    preferences.nodeIntegrationInSubFrames = false;
    preferences.nodeIntegrationInWorker = false;
    preferences.sandbox = true;
    preferences.contextIsolation = true;
    preferences.webSecurity = true;
    preferences.allowRunningInsecureContent = false;
    preferences.webviewTag = false;
    const decision = decideWebviewAttach(
      { preferencesPartition: preferences.partition, paramsPartition: params.partition, src: params.src },
      (partition) => prepared.has(partition),
    );
    if (!decision.ok) {
      options.log("拒绝挂载 webview", decision.reason);
      event.preventDefault();
      return;
    }
    if (decision.kind === "devtools") devtoolsSession();
    preferences.partition = decision.partition;
  }

  function adoptGuest(contents: WebContents): void {
    let guest: Guest | null = null;
    for (const [partition, entry] of configured) {
      if (entry.session === contents.session && prepared.has(partition)) {
        guest = { kind: "page", partition, contents, faviconSeq: 0 };
        break;
      }
    }
    if (!guest && devtoolsSessionReady && contents.session === devtoolsSession()) {
      guest = { kind: "devtools", partition: BROWSER_DEVTOOLS_PARTITION, contents, faviconSeq: 0 };
    }
    if (!guest) {
      // Cannot happen after the gate; refuse to keep an unrecognised guest alive rather than guess.
      options.log("未识别的 webview 已关闭");
      contents.close();
      return;
    }
    guests.set(contents.id, guest);
    contents.once("destroyed", () => forgetGuest(contents.id));
    if (guest.kind === "page") installPageGuest(guest);
    else installDevToolsHost(guest);
  }

  function reloadFocusedGuest(): boolean {
    const focused = allWebContents.getFocusedWebContents();
    if (!focused) return false;
    const guest = guests.get(focused.id);
    if (guest?.kind === "page") {
      focused.reload();
      return true;
    }
    if (guest?.kind === "devtools") {
      // Never the app from here: the inspected page, or nothing.
      pageOfDevTools(focused.id)?.contents.reload();
      return true;
    }
    // Some other guest (should not exist): do nothing rather than reload the app from inside it.
    return focused.getType() === "webview";
  }

  function command(guest: Guest, name: DesktopBrowserCommand): void {
    const contents = guest.contents;
    switch (name) {
      case "back":
        if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
        return;
      case "forward":
        if (contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
        return;
      case "reload":
        contents.reload();
        return;
      case "hard-reload":
        contents.reloadIgnoringCache();
        return;
      case "stop":
        contents.stop();
        return;
      case "zoom-in":
        zoom(guest, "in");
        return;
      case "zoom-out":
        zoom(guest, "out");
        return;
      case "zoom-reset":
        zoom(guest, "reset");
        return;
    }
  }

  async function clearData(workspaceId: string, target: DesktopBrowserClearTarget): Promise<boolean> {
    const partition = browserPartitionFor(workspaceId);
    if (!partition) return false;
    const entry = configured.get(partition);
    const ses = entry?.session ?? session.fromPartition(partition);
    if (target === "cookies") {
      await ses.clearStorageData({ storages: ["cookies"] });
      return true;
    }
    if (target === "cache") {
      await ses.clearCache();
      await ses.clearStorageData({ storages: ["cachestorage", "shadercache"] });
      return true;
    }
    trusted = withoutPartitionCertificates(trusted, partition);
    writeTrusted();
    failures.delete(partition);
    if (entry) {
      // A fresh verify proc and fresh connections, so an already accepted certificate is not reused.
      ses.setCertificateVerifyProc(verifyProcFor(partition));
      await ses.closeAllConnections();
    }
    return true;
  }

  async function trustCertificate(guest: Guest, host: string): Promise<boolean> {
    const failure = failures.get(guest.partition)?.get(host);
    const entry = configured.get(guest.partition);
    if (!failure || !entry) return false;
    trusted = withTrustedCertificate(trusted, guest.partition, host, failure.fingerprint);
    writeTrusted();
    // The network service caches verification results; re-installing the proc and dropping pooled
    // connections is what gives the retried load a fresh verification.
    entry.session.setCertificateVerifyProc(verifyProcFor(guest.partition));
    await entry.session.closeAllConnections();
    return true;
  }

  // Fallback for top-level loads whose failed verification Chromium served from its cache: a
  // certificate the user trusted for this partition is accepted here too. Anything that is not one
  // of our page guests keeps the default (refused).
  function onCertificateError(
    event: { preventDefault: () => void },
    contents: WebContents,
    url: string,
    error: string,
    certificate: Certificate,
    callback: (isTrusted: boolean) => void,
  ): void {
    const guest = guests.get(contents.id);
    const host = hostOf(url);
    if (!guest || guest.kind !== "page" || !host) return;
    if (isCertificateTrusted(trusted, guest.partition, host, certificate.fingerprint)) {
      event.preventDefault();
      callback(true);
      return;
    }
    recordFailure(guest.partition, host, certificate, error);
  }
  app.on("certificate-error", onCertificateError);

  function registerIpc(trustedSenders: TrustedSenders): void {
    const allowed = (event: IpcMainEvent | IpcMainInvokeEvent) => isTrustedRendererUrl(event.senderFrame?.url, trustedSenders);
    /** A page guest embedded by the very renderer that asks about it. */
    const pageGuest = (event: IpcMainEvent | IpcMainInvokeEvent, guestId: number): Guest | null => {
      const guest = guests.get(guestId);
      if (!guest || guest.kind !== "page" || guest.contents.isDestroyed()) return null;
      return guest.contents.hostWebContents?.id === event.sender.id ? guest : null;
    };

    ipcMain.handle(IPC.browserPrepare, (event, payload: unknown) => {
      if (!allowed(event)) throw new Error("untrusted sender");
      const input = sanitizePrepare(payload);
      if (!input) throw new Error("浏览器分区参数无效");
      return prepare(input.workspaceId, input.daemonId);
    });

    ipcMain.on(IPC.browserNavigate, (event, payload: unknown) => {
      if (!allowed(event)) return;
      const input = sanitizeNavigate(payload);
      const guest = input ? pageGuest(event, input.guestId) : null;
      if (!input || !guest) return;
      // A failed load rejects; the renderer learns about it from the webview's did-fail-load.
      guest.contents.loadURL(input.url).catch(() => undefined);
    });

    ipcMain.on(IPC.browserCommand, (event, payload: unknown) => {
      if (!allowed(event)) return;
      const input = sanitizeBrowserCommand(payload);
      const guest = input ? pageGuest(event, input.guestId) : null;
      if (input && guest) command(guest, input.command);
    });

    ipcMain.handle(IPC.browserCaptureVisible, async (event, payload: unknown) => {
      if (!allowed(event)) throw new Error("untrusted sender");
      const input = sanitizeGuestPayload(payload);
      const guest = input ? pageGuest(event, input.guestId) : null;
      if (!guest) return false;
      const image = await guest.contents.capturePage();
      if (image.isEmpty()) return false;
      clipboard.writeImage(image);
      return true;
    });

    ipcMain.handle(IPC.browserFreeze, async (event, payload: unknown) => {
      if (!allowed(event)) throw new Error("untrusted sender");
      const input = sanitizeGuestPayload(payload);
      const guest = input ? pageGuest(event, input.guestId) : null;
      if (!guest) return null;
      const image = await guest.contents.capturePage();
      if (image.isEmpty()) return null;
      frozen.set(guest.contents.id, image);
      return image.toDataURL();
    });

    ipcMain.handle(IPC.browserCaptureRegion, (event, payload: unknown) => {
      if (!allowed(event)) throw new Error("untrusted sender");
      const input = sanitizeCaptureRegion(payload);
      const guest = input ? pageGuest(event, input.guestId) : null;
      if (!input || !guest) return false;
      const image = frozen.get(guest.contents.id);
      frozen.delete(guest.contents.id);
      if (!image) return false;
      const crop = cropRectInPixels(input.rect, image.getSize());
      if (!crop) return false;
      clipboard.writeImage(image.crop(crop));
      return true;
    });

    ipcMain.on(IPC.browserReleaseFreeze, (event, payload: unknown) => {
      if (!allowed(event)) return;
      const input = sanitizeGuestPayload(payload);
      if (input && pageGuest(event, input.guestId)) frozen.delete(input.guestId);
    });

    ipcMain.handle(IPC.browserOpenDevTools, (event, payload: unknown) => {
      if (!allowed(event)) throw new Error("untrusted sender");
      const input = sanitizeDevToolsOpen(payload);
      const page = input ? pageGuest(event, input.guestId) : null;
      const host = input ? guests.get(input.hostGuestId) : undefined;
      if (!input || !page || !host || host.kind !== "devtools" || host.contents.isDestroyed()) return false;
      if (host.contents.hostWebContents?.id !== event.sender.id) return false;
      // A host serves exactly one page, once: it must still be on its initial about:blank.
      if (pageOfDevTools(host.contents.id)) return false;
      if (devtoolsHostOf.has(page.contents.id)) page.contents.closeDevTools();
      page.contents.setDevToolsWebContents(host.contents);
      page.contents.openDevTools();
      devtoolsHostOf.set(page.contents.id, host.contents.id);
      return true;
    });

    ipcMain.on(IPC.browserCloseDevTools, (event, payload: unknown) => {
      if (!allowed(event)) return;
      const input = sanitizeGuestPayload(payload);
      const page = input ? pageGuest(event, input.guestId) : null;
      if (!page) return;
      devtoolsHostOf.delete(page.contents.id);
      if (page.contents.isDevToolsOpened()) page.contents.closeDevTools();
    });

    ipcMain.handle(IPC.browserClearData, (event, payload: unknown) => {
      if (!allowed(event)) throw new Error("untrusted sender");
      const input = sanitizeClearData(payload);
      if (!input) return false;
      return clearData(input.workspaceId, input.target).catch((error: unknown) => {
        options.log("清除浏览器数据失败", String(error));
        return false;
      });
    });

    ipcMain.handle(IPC.browserCertificate, (event, payload: unknown) => {
      if (!allowed(event)) throw new Error("untrusted sender");
      const input = sanitizeCertificateQuery(payload);
      const guest = input ? pageGuest(event, input.guestId) : null;
      if (!input || !guest) return null;
      return failures.get(guest.partition)?.get(input.host) ?? null;
    });

    ipcMain.handle(IPC.browserTrustCertificate, (event, payload: unknown) => {
      if (!allowed(event)) throw new Error("untrusted sender");
      const input = sanitizeCertificateQuery(payload);
      const guest = input ? pageGuest(event, input.guestId) : null;
      if (!input || !guest) return false;
      return trustCertificate(guest, input.host).catch((error: unknown) => {
        options.log("信任证书失败", String(error));
        return false;
      });
    });
  }

  function reset(): void {
    // The guests died with the page; what was prepared was prepared for that page. Sessions stay
    // configured (their handlers read live state), and a new renderer prepares again before it
    // inserts any webview.
    prepared.clear();
    guests.clear();
    devtoolsHostOf.clear();
    frozen.clear();
  }

  function dispose(): void {
    stopWatchingDaemon();
    app.removeListener("certificate-error", onCertificateError);
    reset();
  }

  return { gateWebview, adoptGuest, reloadFocusedGuest, registerIpc, reset, dispose };
}
