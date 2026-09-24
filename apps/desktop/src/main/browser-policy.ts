/**
 * The built-in browser's rules on the main-process side (plan 20260924-desktop-browser-tab), as
 * pure functions: which `<webview>` may attach and as what, where a guest may navigate, which keys a
 * focused page hands to the app, zoom steps, download names, the trusted-certificate store and the
 * shape of every IPC payload. browser-host.ts applies them to Electron; nothing here imports it, so
 * all of it runs under plain Node in the unit tests.
 */

import { BROWSER_DEVTOOLS_PARTITION, BROWSER_PARTITION_PREFIX } from "../shared/browser-partitions";
import type {
  DesktopBrowserClearTarget,
  DesktopBrowserCommand,
  DesktopBrowserRect,
  DesktopCommand,
  DesktopDigit,
} from "../shared/desktop-bridge";

// ---------------------------------------------------------------------------------------------
// Partitions and the webview gate
// ---------------------------------------------------------------------------------------------

/** Workspace ids go into a partition name (and so a directory name): a conservative charset. */
export function isPartitionSafeId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

export function browserPartitionFor(workspaceId: string): string | null {
  return isPartitionSafeId(workspaceId) ? `${BROWSER_PARTITION_PREFIX}${workspaceId}` : null;
}

export function workspaceIdOfPartition(partition: string): string | null {
  if (!partition.startsWith(BROWSER_PARTITION_PREFIX)) return null;
  const id = partition.slice(BROWSER_PARTITION_PREFIX.length);
  return isPartitionSafeId(id) ? id : null;
}

export type WebviewAttachRequest = {
  /** `webPreferences.partition` as `will-attach-webview` hands it over. */
  preferencesPartition?: unknown;
  /** `params.partition`, the `<webview partition>` attribute. */
  paramsPartition?: unknown;
  /** `params.src`, the attach-time URL. */
  src?: unknown;
};

export type WebviewAttachDecision =
  | { ok: true; kind: "page"; partition: string; workspaceId: string }
  | { ok: true; kind: "devtools"; partition: string }
  | { ok: false; reason: string };

/**
 * `will-attach-webview`'s verdict. A page guest must name a browser partition main has already
 * prepared for this renderer; the DevTools host is the one other kind, recognised only by its own
 * fixed partition. Both must attach on `about:blank` — the real URL is loaded afterwards, through
 * main. The partition is read from both places it can arrive in, and they must agree.
 */
export function decideWebviewAttach(request: WebviewAttachRequest, isPrepared: (partition: string) => boolean): WebviewAttachDecision {
  const fromPreferences = typeof request.preferencesPartition === "string" && request.preferencesPartition ? request.preferencesPartition : undefined;
  const fromParams = typeof request.paramsPartition === "string" && request.paramsPartition ? request.paramsPartition : undefined;
  if (fromPreferences && fromParams && fromPreferences !== fromParams) return { ok: false, reason: "partition mismatch" };
  const partition = fromPreferences ?? fromParams;
  if (!partition) return { ok: false, reason: "no partition" };
  if (request.src !== "about:blank") return { ok: false, reason: "attach-time src must be about:blank" };
  if (partition === BROWSER_DEVTOOLS_PARTITION) return { ok: true, kind: "devtools", partition };
  const workspaceId = workspaceIdOfPartition(partition);
  if (!workspaceId) return { ok: false, reason: "not a browser partition" };
  if (!isPrepared(partition)) return { ok: false, reason: "partition not prepared" };
  return { ok: true, kind: "page", partition, workspaceId };
}

/** Where a page guest's main frame may go: http(s), and about:blank. */
export function isAllowedPageNavigation(url: string): boolean {
  if (url === "about:blank") return true;
  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/** Where the DevTools host may go: the DevTools frontend itself. */
export function isAllowedDevToolsNavigation(url: string): boolean {
  if (url === "about:blank") return true;
  try {
    return new URL(url).protocol === "devtools:";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// Keys a focused page hands to the app
// ---------------------------------------------------------------------------------------------

export type GuestKeyInput = { type: string; code: string; meta: boolean; control: boolean; alt: boolean; shift: boolean };

export type GuestKeyAction =
  | { kind: "command"; command: DesktopCommand }
  | { kind: "browser"; action: "focus-address" | "toggle-devtools" }
  | { kind: "zoom"; direction: "in" | "out" | "reset" };

const DIGITS: readonly DesktopDigit[] = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];

function digitOf(code: string): DesktopDigit | null {
  if (!code.startsWith("Digit")) return null;
  const digit = code.slice("Digit".length);
  return (DIGITS as readonly string[]).includes(digit) ? (digit as DesktopDigit) : null;
}

/**
 * Keys typed into a guest never reach the renderer's window listeners, so the app's page shortcuts —
 * the ones the native menu only displays (`registerAccelerator: false`, menu.ts) — are taken here and
 * forwarded; the browser's own keys (⌘L, ⌥⌘I, zoom) too. The modifier sets are exact, as in
 * use-global-shortcuts.ts. Everything else stays with the page: ⌘C/⌘V/⌘A/⌘F/⌘Z, typing, arrows,
 * Tab — and ⌘R, which the menu dispatches to the focused surface when the page leaves it unhandled.
 */
export function classifyGuestKey(input: GuestKeyInput): GuestKeyAction | null {
  if (!input.meta || input.control) return null;
  const bare = !input.shift && !input.alt;
  const withShift = input.shift && !input.alt;
  const withAlt = input.alt && !input.shift;
  const code = input.code;
  const isBackslash = code === "Backslash" || code === "IntlBackslash";

  if (bare) {
    const digit = digitOf(code);
    if (digit) return { kind: "command", command: `focus-group-${digit}` as const };
    if (isBackslash) return { kind: "command", command: "split-right" };
    switch (code) {
      case "Comma":
        return { kind: "command", command: "open-settings" };
      case "KeyP":
        return { kind: "command", command: "toggle-palette" };
      case "KeyT":
        return { kind: "command", command: "create-terminal" };
      case "KeyW":
        return { kind: "command", command: "close-terminal" };
      case "KeyN":
        return { kind: "command", command: "create-workspace" };
      case "BracketLeft":
        return { kind: "command", command: "previous-tab" };
      case "BracketRight":
        return { kind: "command", command: "next-tab" };
      case "Slash":
        return { kind: "command", command: "toggle-help" };
      case "KeyL":
        return { kind: "browser", action: "focus-address" };
      case "Equal":
      case "NumpadAdd":
        return { kind: "zoom", direction: "in" };
      case "Minus":
      case "NumpadSubtract":
        return { kind: "zoom", direction: "out" };
      case "Digit0":
      case "Numpad0":
        return { kind: "zoom", direction: "reset" };
      default:
        return null;
    }
  }

  if (withShift) {
    if (isBackslash) return { kind: "command", command: "split-down" };
    // ⌘+ on a US layout is ⌘⇧=.
    if (code === "Equal") return { kind: "zoom", direction: "in" };
    return null;
  }

  if (withAlt) {
    const digit = digitOf(code);
    if (digit) return { kind: "command", command: `select-tab-${digit}` as const };
    switch (code) {
      case "ArrowLeft":
        return { kind: "command", command: "focus-group-left" };
      case "ArrowRight":
        return { kind: "command", command: "focus-group-right" };
      case "ArrowUp":
        return { kind: "command", command: "focus-group-up" };
      case "ArrowDown":
        return { kind: "command", command: "focus-group-down" };
      case "KeyI":
        return { kind: "browser", action: "toggle-devtools" };
      default:
        return null;
    }
  }
  return null;
}

/** `before-input-event` reports both halves of a key press; actions fire on the down half only. */
export function isKeyDown(type: string): boolean {
  return type !== "keyUp";
}

// ---------------------------------------------------------------------------------------------
// Zoom
// ---------------------------------------------------------------------------------------------

/** Chromium's own zoom ladder. */
export const ZOOM_FACTORS: readonly number[] = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];

export function stepZoomFactor(current: number, direction: "in" | "out" | "reset"): number {
  if (direction === "reset" || !Number.isFinite(current)) return 1;
  if (direction === "in") return ZOOM_FACTORS.find((factor) => factor > current + 0.001) ?? ZOOM_FACTORS[ZOOM_FACTORS.length - 1]!;
  return [...ZOOM_FACTORS].reverse().find((factor) => factor < current - 0.001) ?? ZOOM_FACTORS[0]!;
}

// ---------------------------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------------------------

/** A server-suggested file name made safe to join onto the Downloads folder. */
export function sanitizeDownloadName(name: string): string {
  const cleaned = name
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/[/\\:]/g, "_")
    .replace(/^[.\s]+/, "")
    .trim()
    .slice(0, 200);
  return cleaned || "download";
}

/** `name.ext`, else `name (1).ext`, `name (2).ext`, … — never an existing (or reserved) file. */
export function uniqueDownloadName(name: string, isTaken: (candidate: string) => boolean): string {
  const safe = sanitizeDownloadName(name);
  if (!isTaken(safe)) return safe;
  const dot = safe.lastIndexOf(".");
  const stem = dot > 0 ? safe.slice(0, dot) : safe;
  const extension = dot > 0 ? safe.slice(dot) : "";
  for (let index = 1; index < 10_000; index++) {
    const candidate = `${stem} (${index})${extension}`;
    if (!isTaken(candidate)) return candidate;
  }
  return `${stem} (${Date.now()})${extension}`;
}

// ---------------------------------------------------------------------------------------------
// Trusted certificates
// ---------------------------------------------------------------------------------------------

export type TrustedCertificate = { host: string; fingerprint: string };
export type TrustedCertificates = Readonly<Record<string, readonly TrustedCertificate[]>>;

const MAX_TRUSTED_PER_PARTITION = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeHost(host: string): string {
  return host.trim().toLowerCase();
}

/** The stored trust decisions; a missing or corrupt file trusts nothing. */
export function parseTrustedCertificates(raw: string | null): Record<string, TrustedCertificate[]> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.partitions)) return {};
  const result: Record<string, TrustedCertificate[]> = {};
  for (const [partition, entries] of Object.entries(parsed.partitions)) {
    if (!workspaceIdOfPartition(partition) || !Array.isArray(entries)) continue;
    const list: TrustedCertificate[] = [];
    for (const entry of entries) {
      if (list.length >= MAX_TRUSTED_PER_PARTITION) break;
      if (!isRecord(entry) || typeof entry.host !== "string" || typeof entry.fingerprint !== "string") continue;
      if (!entry.host || !entry.fingerprint) continue;
      list.push({ host: normalizeHost(entry.host), fingerprint: entry.fingerprint });
    }
    if (list.length > 0) result[partition] = list;
  }
  return result;
}

export function serializeTrustedCertificates(store: TrustedCertificates): string {
  return `${JSON.stringify({ version: 1, partitions: store }, null, 2)}\n`;
}

export function isCertificateTrusted(store: TrustedCertificates, partition: string, host: string, fingerprint: string): boolean {
  const wanted = normalizeHost(host);
  return (store[partition] ?? []).some((entry) => entry.host === wanted && entry.fingerprint === fingerprint);
}

export function withTrustedCertificate(store: TrustedCertificates, partition: string, host: string, fingerprint: string): TrustedCertificates {
  if (!fingerprint || isCertificateTrusted(store, partition, host, fingerprint)) return store;
  const list = [...(store[partition] ?? []), { host: normalizeHost(host), fingerprint }].slice(-MAX_TRUSTED_PER_PARTITION);
  return { ...store, [partition]: list };
}

export function withoutPartitionCertificates(store: TrustedCertificates, partition: string): TrustedCertificates {
  if (!(partition in store)) return store;
  const next: Record<string, readonly TrustedCertificate[]> = { ...store };
  delete next[partition];
  return next;
}

// ---------------------------------------------------------------------------------------------
// IPC payloads (every handler also checks the sender first)
// ---------------------------------------------------------------------------------------------

export function sanitizeGuestId(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value < 2 ** 31 ? value : null;
}

function guestIdOf(payload: unknown): number | null {
  return isRecord(payload) ? sanitizeGuestId(payload.guestId) : null;
}

export function sanitizeGuestPayload(payload: unknown): { guestId: number } | null {
  const guestId = guestIdOf(payload);
  return guestId === null ? null : { guestId };
}

export function sanitizePrepare(payload: unknown): { workspaceId: string; daemonId: string } | null {
  if (!isRecord(payload) || !isPartitionSafeId(payload.workspaceId)) return null;
  const daemonId = payload.daemonId;
  if (typeof daemonId !== "string" || daemonId.length > 255 || /[\x00-\x1f\x7f]/.test(daemonId)) return null;
  return { workspaceId: payload.workspaceId, daemonId };
}

export function sanitizeNavigate(payload: unknown): { guestId: number; url: string } | null {
  const guestId = guestIdOf(payload);
  if (guestId === null || !isRecord(payload) || typeof payload.url !== "string" || payload.url.length > 8192) return null;
  return isAllowedPageNavigation(payload.url) ? { guestId, url: payload.url } : null;
}

const BROWSER_COMMANDS: readonly DesktopBrowserCommand[] = ["back", "forward", "reload", "hard-reload", "stop", "zoom-in", "zoom-out", "zoom-reset"];

export function sanitizeBrowserCommand(payload: unknown): { guestId: number; command: DesktopBrowserCommand } | null {
  const guestId = guestIdOf(payload);
  if (guestId === null || !isRecord(payload)) return null;
  const command = payload.command;
  return typeof command === "string" && (BROWSER_COMMANDS as readonly string[]).includes(command)
    ? { guestId, command: command as DesktopBrowserCommand }
    : null;
}

function fraction(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

export function sanitizeCaptureRegion(payload: unknown): { guestId: number; rect: DesktopBrowserRect } | null {
  const guestId = guestIdOf(payload);
  if (guestId === null || !isRecord(payload) || !isRecord(payload.rect)) return null;
  const x = fraction(payload.rect.x);
  const y = fraction(payload.rect.y);
  const width = fraction(payload.rect.width);
  const height = fraction(payload.rect.height);
  if (x === null || y === null || width === null || height === null || width <= 0 || height <= 0) return null;
  if (x + width > 1.0001 || y + height > 1.0001) return null;
  return { guestId, rect: { x, y, width, height } };
}

/** A fractional rectangle in the pixels of an image of `size`, clamped inside it; null when empty. */
export function cropRectInPixels(rect: DesktopBrowserRect, size: { width: number; height: number }): { x: number; y: number; width: number; height: number } | null {
  const x = Math.max(0, Math.min(size.width, Math.round(rect.x * size.width)));
  const y = Math.max(0, Math.min(size.height, Math.round(rect.y * size.height)));
  const right = Math.max(x, Math.min(size.width, Math.round((rect.x + rect.width) * size.width)));
  const bottom = Math.max(y, Math.min(size.height, Math.round((rect.y + rect.height) * size.height)));
  const width = right - x;
  const height = bottom - y;
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}

export function sanitizeDevToolsOpen(payload: unknown): { guestId: number; hostGuestId: number } | null {
  const guestId = guestIdOf(payload);
  if (guestId === null || !isRecord(payload)) return null;
  const hostGuestId = sanitizeGuestId(payload.hostGuestId);
  return hostGuestId === null || hostGuestId === guestId ? null : { guestId, hostGuestId };
}

const CLEAR_TARGETS: readonly DesktopBrowserClearTarget[] = ["cookies", "cache", "certificates"];

export function sanitizeClearData(payload: unknown): { workspaceId: string; target: DesktopBrowserClearTarget } | null {
  if (!isRecord(payload) || !isPartitionSafeId(payload.workspaceId)) return null;
  const target = payload.target;
  return typeof target === "string" && (CLEAR_TARGETS as readonly string[]).includes(target)
    ? { workspaceId: payload.workspaceId, target: target as DesktopBrowserClearTarget }
    : null;
}

export function sanitizeCertificateQuery(payload: unknown): { guestId: number; host: string } | null {
  const guestId = guestIdOf(payload);
  if (guestId === null || !isRecord(payload)) return null;
  const host = payload.host;
  if (typeof host !== "string" || host.length === 0 || host.length > 255 || !/^[A-Za-z0-9.\-[\]:]+$/.test(host)) return null;
  return { guestId, host: normalizeHost(host) };
}
