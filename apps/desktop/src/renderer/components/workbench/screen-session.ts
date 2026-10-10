/**
 * One remote screen session in the renderer (plan 20260929-remote-desktop).
 *
 * Main owns the session's two device lanes and hands this class a MessagePort (screen-host.ts);
 * everything above the bytes is here: the DeviceEnvelope encode/decode, the open / attach /
 * resize / pause / resume / close protocol, credit-based video flow control, H.264 decoding with
 * WebCodecs into a canvas, input by physical key code, the locally drawn cursor, clipboard relay
 * and the product states the view renders. The remote session id is stable for the tab's life,
 * so lanes that close (a central disconnect, ⌘R) are reopened and the same session reattached —
 * the remote virtual display and window arrangement survive it. No React in here: the view
 * subscribes to `state` and hands over the canvas and the input events.
 */
import {
  create,
  decodeDeviceEnvelope,
  DEVICE_PROTOCOL_VERSION,
  DeviceEnvelopeSchema,
  encodeDeviceEnvelope,
  SCREEN_VIDEO_CREDIT_DIRECT_BYTES,
  SCREEN_VIDEO_CREDIT_RELAY_BYTES,
  ScreenPointerAction,
  ScreenSessionPhase,
  ScreenVideoCodec,
  type DeviceEnvelopePayload,
  type ScreenSessionStatus,
} from "@coflux/protocol";

import type { DesktopBridge, DesktopScreenLane, DesktopScreenLaneKind, DesktopScreenPortMessage, DesktopScreenPortRequest } from "@/desktop-bridge";
import { SCREEN_PORT_MESSAGE } from "@/desktop-bridge";
import type { ScreenResolution } from "@/components/workbench/screen-resolution";

/** What the tab shows; see `ScreenView` for the copy of each. */
export type ScreenPhase =
  /** No lanes yet, or waiting to reopen them. */
  | "connecting"
  /** Lanes are up; the open is in flight or the remote is creating its display. */
  | "starting"
  | "streaming"
  /** Background tab: the stream is paused, the session kept. */
  | "paused"
  /** Screen Recording missing on the remote: no picture. */
  | "no-permission"
  /** The remote login session is locked. */
  | "locked"
  /** Another client took the session over (「已被其它客户端接管」). */
  | "detached"
  /** The device is offline or unreachable. */
  | "offline"
  /** The device's worker predates the screen protocol, or has no helper. */
  | "unsupported"
  /** The remote refused or failed the open; `error` says why. */
  | "error"
  /** Closed for good (the tab was closed). */
  | "closed";

export type ScreenPermissions = { screenRecording: boolean; accessibility: boolean };

export type ScreenDisplay = { widthPoints: number; heightPoints: number; scale: number; widthPixels: number; heightPixels: number };

export type ScreenCursorState = { x: number; y: number; visible: boolean; shapeUrl: string | null; hotspotX: number; hotspotY: number; widthPoints: number; heightPoints: number };

export type ScreenSessionState = {
  phase: ScreenPhase;
  /** Diagnostic text for `error`, also carried along other phases when the remote reported one. */
  error: string | null;
  permissions: ScreenPermissions | null;
  locked: boolean;
  display: ScreenDisplay | null;
  cursor: ScreenCursorState;
  /** Frames drawn since the session opened; the view uses it to know a picture exists. */
  framesDrawn: number;
  /** The resolution choice: a fixed size in points, or `null` to follow the tab's size. */
  resolution: ScreenResolution;
};

export type ScreenSessionOptions = {
  sessionId: string;
  daemonId: string;
  desktop: DesktopBridge;
  /** Whether the device is online at the center; offline devices are not dialled. */
  deviceOnline: () => boolean;
  /** "relay" lowers the starting video credit; anything else is treated as direct. */
  transportMode: () => string;
  /**
   * The first open is a user action (a 屏幕 tab just opened, 「打开屏幕」): it takes the session over
   * from any other client. Automatic opens — a restored tab after restart, a reconnect after a lane
   * closed, a resume — never take over; a tab that was taken over only reconnects through 「重新接管」.
   */
  takeOverOnOpen: boolean;
  /** The resolution choice the session starts with (the device's remembered one). */
  resolution: ScreenResolution;
};

const MODIFIER_SHIFT = 1;
const MODIFIER_CONTROL = 2;
const MODIFIER_OPTION = 4;
const MODIFIER_COMMAND = 8;
const MODIFIER_CAPS_LOCK = 16;

/** Reopen backoff after a lane closes while the tab is visible. */
const REOPEN_MIN_MS = 1000;
const REOPEN_MAX_MS = 15_000;
const RESIZE_DEBOUNCE_MS = 150;
const OPEN_TIMEOUT_MS = 20_000;

const INITIAL_CURSOR: ScreenCursorState = { x: 0, y: 0, visible: false, shapeUrl: null, hotspotX: 0, hotspotY: 0, widthPoints: 0, heightPoints: 0 };

/** DOM modifier state → the wire's ScreenModifier bits. */
// Method syntax on purpose: React's typed `getModifierState(key: ModifierKey)` is only assignable to a bivariant method.
export function modifierBits(event: { shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean; getModifierState?(key: string): boolean }): number {
  let bits = 0;
  if (event.shiftKey) bits |= MODIFIER_SHIFT;
  if (event.ctrlKey) bits |= MODIFIER_CONTROL;
  if (event.altKey) bits |= MODIFIER_OPTION;
  if (event.metaKey) bits |= MODIFIER_COMMAND;
  if (event.getModifierState?.("CapsLock")) bits |= MODIFIER_CAPS_LOCK;
  return bits;
}

/**
 * The size the remote display should have for a tab of `width`×`height` CSS px at `devicePixelRatio`
 * (a fixed resolution choice passes its points as `width`×`height`).
 */
export function displayRequest(width: number, height: number, devicePixelRatio: number): { widthPoints: number; heightPoints: number; scale: number } {
  return { widthPoints: Math.max(1, Math.round(width)), heightPoints: Math.max(1, Math.round(height)), scale: devicePixelRatio >= 1.5 ? 2 : 1 };
}

/** The initial video credit for a transport mode (see device.proto). */
export function initialCreditFor(mode: string): number {
  return mode === "relay" || mode === "remote" ? SCREEN_VIDEO_CREDIT_RELAY_BYTES : SCREEN_VIDEO_CREDIT_DIRECT_BYTES;
}

type Lanes = { control: DesktopScreenLane; video: DesktopScreenLane };
type DisplaySize = { widthPoints: number; heightPoints: number; scale: number };

export class ScreenSession {
  readonly sessionId: string;
  readonly daemonId: string;
  private readonly desktop: DesktopBridge;
  private readonly options: ScreenSessionOptions;
  private port: MessagePort | null = null;
  private lanes: Lanes | null = null;
  private laneUp: Record<DesktopScreenLaneKind, boolean> = { control: false, video: false };
  private opened = false;
  private holderEpoch = 0n;
  private visible = false;
  private closed = false;
  private disposed = false;
  /** The tab's last reported size in CSS px and its devicePixelRatio. */
  private tabArea: { width: number; height: number; devicePixelRatio: number } | null = null;
  /** What the remote display should be: the tab's size, or the fixed choice at the local scale. */
  private wantedSize: DisplaySize | null = null;
  /** What the remote was last asked for (the open's size, then each resize). */
  private appliedSize: DisplaySize | null = null;
  /** The size the open in flight carries; the applied size once it succeeds. */
  private openSize: DisplaySize | null = null;
  private resizeSeq = 0n;
  private resizeTimer: number | undefined;
  private reopenTimer: number | undefined;
  private reopenDelay = REOPEN_MIN_MS;
  private openTimer: number | undefined;
  private openRequest = 0;
  private forceNext = false;
  private canvas: HTMLCanvasElement | null = null;
  private context: CanvasRenderingContext2D | null = null;
  private decoder: VideoDecoder | null = null;
  private decoderSize: { width: number; height: number } | null = null;
  private needKeyframe = true;
  private partial: { seq: bigint; keyframe: boolean; chunks: Uint8Array[]; bytes: number; count: number } | null = null;
  /** Keys (by physical code) and mouse buttons the remote was told are down; released together on focus loss. */
  private heldKeys = new Set<string>();
  private heldButtons = new Set<number>();
  private lastPointer = { x: 0, y: 0 };
  private pendingCredit = 0;
  private creditTimer: number | undefined;
  private shapeUrl: string | null = null;
  private windowListener: ((event: MessageEvent) => void) | null = null;
  private readonly listeners = new Set<() => void>();
  state: ScreenSessionState;

  constructor(options: ScreenSessionOptions) {
    this.sessionId = options.sessionId;
    this.daemonId = options.daemonId;
    this.desktop = options.desktop;
    this.options = options;
    this.forceNext = options.takeOverOnOpen;
    this.state = { phase: "connecting", error: null, permissions: null, locked: false, display: null, cursor: INITIAL_CURSOR, framesDrawn: 0, resolution: options.resolution };
    this.wantedSize = this.sizeWanted();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private update(patch: Partial<ScreenSessionState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  // ---------------------------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------------------------

  /** The tab became visible or hidden. Visible connects (once) and resumes; hidden pauses. */
  setVisible(visible: boolean) {
    if (this.disposed || this.closed) return;
    this.visible = visible;
    if (visible) {
      // A taken-over tab stays as it is until 「重新接管」.
      if (this.state.phase === "detached") return;
      if (!this.port) void this.connect();
      else if (!this.lanes && !this.reopenTimer) this.requestReopen(0);
      else if (this.opened) {
        this.sendControl({ case: "screenSessionResume", value: { sessionId: this.sessionId, holderEpoch: this.holderEpoch } });
        this.needKeyframe = true;
        this.sendVideo({ case: "screenKeyframeRequest", value: { sessionId: this.sessionId } });
        this.post({ type: "clipboard-watch", on: true });
        if (this.state.phase === "paused") this.update({ phase: "streaming" });
      }
    } else if (this.opened) {
      this.releaseAll();
      this.sendControl({ case: "screenSessionPause", value: { sessionId: this.sessionId, holderEpoch: this.holderEpoch } });
      this.post({ type: "clipboard-watch", on: false });
      if (this.state.phase === "streaming") this.update({ phase: "paused" });
    }
  }

  /**
   * The tab's size in CSS px changed; the remote display follows (debounced). On a fixed resolution
   * only a change of the local scale reaches the remote; the picture just scales.
   */
  setSize(width: number, height: number, devicePixelRatio: number) {
    if (this.disposed || this.closed) return;
    this.tabArea = { width, height, devicePixelRatio };
    this.wantedSize = this.sizeWanted();
    window.clearTimeout(this.resizeTimer);
    this.resizeTimer = window.setTimeout(() => this.applySize(), RESIZE_DEBOUNCE_MS);
  }

  /** The user picked a resolution: the remote follows at once, without reconnecting. */
  setResolution(resolution: ScreenResolution) {
    if (this.disposed || this.closed) return;
    this.update({ resolution });
    this.wantedSize = this.sizeWanted();
    window.clearTimeout(this.resizeTimer);
    this.applySize();
  }

  private sizeWanted(): DisplaySize | null {
    const resolution = this.state.resolution;
    const devicePixelRatio = this.tabArea?.devicePixelRatio ?? window.devicePixelRatio;
    if (resolution) return displayRequest(resolution.widthPoints, resolution.heightPoints, devicePixelRatio);
    return this.tabArea ? displayRequest(this.tabArea.width, this.tabArea.height, devicePixelRatio) : null;
  }

  private applySize() {
    const wanted = this.wantedSize;
    if (!wanted || !this.opened) return;
    const applied = this.appliedSize;
    if (applied && applied.widthPoints === wanted.widthPoints && applied.heightPoints === wanted.heightPoints && applied.scale === wanted.scale) return;
    this.appliedSize = wanted;
    this.resizeSeq += 1n;
    this.sendControl({ case: "screenSessionResize", value: { sessionId: this.sessionId, holderEpoch: this.holderEpoch, resizeSeq: this.resizeSeq, ...wanted } });
    this.needKeyframe = true;
  }

  /** 「重新接管」: the one way back from `detached` — reopen with force. */
  takeOver() {
    if (this.disposed || this.closed) return;
    this.forceNext = true;
    this.update({ phase: "connecting", error: null });
    if (this.lanes && this.laneUp.control) this.sendOpen();
    else if (!this.port) void this.connect();
    else this.requestReopen(0);
  }

  /** Retry after an error or an offline device (never after a takeover: that is 「重新接管」's). */
  retry() {
    if (this.disposed || this.closed || this.state.phase === "detached") return;
    this.update({ phase: "connecting", error: null });
    if (!this.port) void this.connect();
    else this.requestReopen(0);
  }

  /**
   * Release on the remote everything this client pressed and has not released: every held key
   * (modifiers last) and mouse button. Called when the picture loses focus, the window deactivates,
   * the tab is hidden, and the session detaches or ends, so ⌘ pressed before a ⌘Tab the local OS ate
   * never stays down over there.
   */
  releaseAll() {
    if (!this.opened || !this.laneUp.control) {
      this.heldKeys.clear();
      this.heldButtons.clear();
      return;
    }
    const keys = [...this.heldKeys].sort((left, right) => Number(isModifierCode(left)) - Number(isModifierCode(right)));
    this.heldKeys.clear();
    for (const code of keys) {
      this.sendControl({ case: "screenInput", value: { sessionId: this.sessionId, holderEpoch: this.holderEpoch, event: { case: "key", value: { code, down: false, modifiers: 0, repeat: false } } } });
    }
    const buttons = [...this.heldButtons];
    this.heldButtons.clear();
    for (const button of buttons) {
      this.sendControl({ case: "screenInput", value: { sessionId: this.sessionId, holderEpoch: this.holderEpoch, event: { case: "pointer", value: { action: ScreenPointerAction.UP, x: this.lastPointer.x, y: this.lastPointer.y, button, modifiers: 0, clickCount: 1 } } } });
    }
  }

  /**
   * Immersive mode entered or left: lets the remote display follow the new size at once (a no-op on
   * a fixed resolution, whose wanted size the tab's size does not change).
   */
  flushSize() {
    window.clearTimeout(this.resizeTimer);
    this.applySize();
  }

  /** The tab was closed: end the remote session (the virtual display goes away), then let go. */
  close() {
    if (this.closed) return;
    this.releaseAll();
    this.closed = true;
    if (this.opened && this.laneUp.control) {
      this.sendControl({ case: "screenSessionClose", value: { requestId: `close-${Date.now()}`, sessionId: this.sessionId, holderEpoch: this.holderEpoch } });
    }
    this.update({ phase: "closed" });
    // Give the close a moment on the wire before the lanes go.
    window.setTimeout(() => this.dispose(), 300);
  }

  /** Let go of everything local without ending the remote session (app reload, unmount). */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    window.clearTimeout(this.resizeTimer);
    window.clearTimeout(this.reopenTimer);
    window.clearTimeout(this.openTimer);
    window.clearTimeout(this.creditTimer);
    if (this.windowListener) window.removeEventListener("message", this.windowListener);
    this.windowListener = null;
    this.desktop.screenClose(this.sessionId);
    this.port?.close();
    this.port = null;
    this.lanes = null;
    this.closeDecoder();
    if (this.shapeUrl) URL.revokeObjectURL(this.shapeUrl);
    this.shapeUrl = null;
    this.listeners.clear();
  }

  private async connect() {
    if (this.port || this.disposed) return;
    this.update({ phase: "connecting", error: null });
    const portPromise = new Promise<MessagePort | null>((resolve) => {
      const listener = (event: MessageEvent) => {
        const data = event.data as { type?: unknown; sessionId?: unknown } | null;
        if (!data || data.type !== SCREEN_PORT_MESSAGE || data.sessionId !== this.sessionId || event.ports.length === 0) return;
        window.removeEventListener("message", listener);
        this.windowListener = null;
        resolve(event.ports[0]!);
      };
      this.windowListener = listener;
      window.addEventListener("message", listener);
      window.setTimeout(() => {
        if (this.windowListener === listener) {
          window.removeEventListener("message", listener);
          this.windowListener = null;
          resolve(null);
        }
      }, 5000);
    });
    const ok = await this.desktop.screenOpen(this.sessionId, this.daemonId);
    if (!ok) {
      this.update({ phase: "unsupported", error: "这个构建没有内置远程连接，无法打开屏幕" });
      return;
    }
    const port = await portPromise;
    if (this.disposed) {
      port?.close();
      return;
    }
    if (!port) {
      this.update({ phase: "error", error: "主进程没有交出会话端口" });
      return;
    }
    this.port = port;
    port.onmessage = (event) => this.onPortMessage(event.data as DesktopScreenPortMessage);
    port.start();
  }

  // No transfer list, ever: on Electron 44.3.0 an `ArrayBuffer` transferred to `MessagePortMain`
  // arrives in main as null, so every frame was silently dropped. Bytes go by structured clone, each
  // in a buffer of exactly its own size (`exactBuffer`), never a view's larger backing store.
  private post(request: DesktopScreenPortRequest) {
    if (!this.port) return;
    this.port.postMessage(request);
  }

  private requestReopen(delay: number) {
    window.clearTimeout(this.reopenTimer);
    this.reopenTimer = window.setTimeout(() => {
      this.reopenTimer = undefined;
      if (this.disposed || this.closed || !this.visible) return;
      // Only 「重新接管」 (takeOver, which arms forceNext) reconnects a taken-over tab.
      if (this.state.phase === "detached" && !this.forceNext) return;
      if (!this.options.deviceOnline()) {
        this.update({ phase: "offline", error: null });
        this.requestReopen(REOPEN_MAX_MS);
        return;
      }
      this.update({ phase: "connecting", error: null });
      this.post({ type: "reopen" });
    }, delay);
  }

  // ---------------------------------------------------------------------------------------------
  // Port messages from main
  // ---------------------------------------------------------------------------------------------

  private onPortMessage(message: DesktopScreenPortMessage) {
    if (this.disposed) return;
    switch (message.type) {
      case "lanes":
        this.lanes = { control: message.control, video: message.video };
        this.laneUp = { control: true, video: true };
        this.reopenDelay = REOPEN_MIN_MS;
        this.opened = false;
        this.sendOpen();
        return;
      case "lanes-failed":
        this.lanes = null;
        this.laneUp = { control: false, video: false };
        if (message.message === "offline" || !this.options.deviceOnline()) this.update({ phase: "offline", error: null });
        else this.update({ phase: "connecting", error: message.message });
        this.requestReopen(this.reopenDelay);
        this.reopenDelay = Math.min(REOPEN_MAX_MS, this.reopenDelay * 2);
        return;
      case "frame":
        this.onLaneFrame(message.lane, new Uint8Array(message.data));
        return;
      case "closed":
        this.laneUp[message.lane] = false;
        if (this.state.phase === "closed" || this.closed) return;
        // Both lanes go together in every real case (a central disconnect, a reset); one lost alone
        // still means the pair is reopened, since the session binds the video lane to the holder.
        this.lanes = null;
        this.laneUp = { control: false, video: false };
        this.opened = false;
        this.heldKeys.clear();
        this.heldButtons.clear();
        this.closeDecoder();
        if (this.state.phase === "detached") return;
        if (this.visible) {
          this.update({ phase: this.options.deviceOnline() ? "connecting" : "offline" });
          this.requestReopen(this.reopenDelay);
          this.reopenDelay = Math.min(REOPEN_MAX_MS, this.reopenDelay * 2);
        }
        return;
      case "clipboard":
        if (!this.opened || !this.laneUp.control) return;
        if (typeof message.text === "string") {
          this.sendControl({ case: "screenClipboardSet", value: { sessionId: this.sessionId, holderEpoch: this.holderEpoch, content: { content: { case: "text", value: message.text } } } });
        } else if (message.png) {
          this.sendControl({ case: "screenClipboardSet", value: { sessionId: this.sessionId, holderEpoch: this.holderEpoch, content: { content: { case: "png", value: new Uint8Array(message.png) } } } });
        }
        return;
      default:
        return;
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Sending
  // ---------------------------------------------------------------------------------------------

  private send(lane: DesktopScreenLaneKind, payload: DeviceEnvelopePayload): boolean {
    const lanes = this.lanes;
    if (!lanes || !this.laneUp[lane] || !this.port) return false;
    const bytes = encodeDeviceEnvelope(create(DeviceEnvelopeSchema, { protocolVersion: DEVICE_PROTOCOL_VERSION, channelId: lanes[lane].channelId, payload }));
    this.post({ type: "send", lane, data: exactBuffer(bytes) });
    return true;
  }

  private sendControl(payload: DeviceEnvelopePayload): boolean {
    return this.send("control", payload);
  }

  private sendVideo(payload: DeviceEnvelopePayload): boolean {
    return this.send("video", payload);
  }

  private sendOpen() {
    const lanes = this.lanes;
    if (!lanes) return;
    const size = this.wantedSize ?? { widthPoints: 1280, heightPoints: 800, scale: 2 };
    this.openSize = size;
    const requestId = `open-${++this.openRequest}`;
    const force = this.forceNext;
    this.forceNext = false;
    this.update({ phase: "starting", error: null });
    this.sendControl({
      case: "screenSessionOpen",
      value: {
        requestId,
        sessionId: this.sessionId,
        clientInstanceId: lanes.control.clientInstanceId,
        transportGeneration: BigInt(lanes.control.generation),
        force,
        ...size,
        codecs: [ScreenVideoCodec.H264],
      },
    });
    window.clearTimeout(this.openTimer);
    this.openTimer = window.setTimeout(() => {
      if (this.opened || this.disposed || this.closed) return;
      this.update({ phase: "error", error: "远程设备没有响应打开请求" });
    }, OPEN_TIMEOUT_MS);
  }

  private attachVideo() {
    const credit = initialCreditFor(this.options.transportMode());
    this.needKeyframe = true;
    this.partial = null;
    this.pendingCredit = 0;
    this.sendVideo({ case: "screenVideoAttach", value: { sessionId: this.sessionId, holderEpoch: this.holderEpoch, creditBytes: BigInt(credit) } });
  }

  // ---------------------------------------------------------------------------------------------
  // Input
  // ---------------------------------------------------------------------------------------------

  private get controllable(): boolean {
    return this.opened && this.laneUp.control && this.state.phase === "streaming" && (this.state.permissions?.accessibility ?? false);
  }

  sendKey(code: string, down: boolean, modifiers: number, repeat = false) {
    if (!this.controllable || !code) return;
    if (down) this.heldKeys.add(code);
    else this.heldKeys.delete(code);
    this.sendControl({ case: "screenInput", value: { sessionId: this.sessionId, holderEpoch: this.holderEpoch, event: { case: "key", value: { code, down, modifiers, repeat: down && repeat } } } });
  }

  sendPointer(action: "move" | "down" | "up", x: number, y: number, button: number, modifiers: number, clickCount: number) {
    if (!this.controllable) return;
    this.lastPointer = { x, y };
    if (action === "down") this.heldButtons.add(button);
    else if (action === "up") this.heldButtons.delete(button);
    const wire = action === "down" ? ScreenPointerAction.DOWN : action === "up" ? ScreenPointerAction.UP : ScreenPointerAction.MOVE;
    this.sendControl({ case: "screenInput", value: { sessionId: this.sessionId, holderEpoch: this.holderEpoch, event: { case: "pointer", value: { action: wire, x, y, button, modifiers, clickCount } } } });
  }

  sendScroll(x: number, y: number, deltaX: number, deltaY: number, modifiers: number, precise: boolean) {
    if (!this.controllable) return;
    this.sendControl({ case: "screenInput", value: { sessionId: this.sessionId, holderEpoch: this.holderEpoch, event: { case: "scroll", value: { x, y, deltaX, deltaY, modifiers, precise } } } });
  }

  // ---------------------------------------------------------------------------------------------
  // Lane frames
  // ---------------------------------------------------------------------------------------------

  private onLaneFrame(lane: DesktopScreenLaneKind, bytes: Uint8Array) {
    const envelope = decodeDeviceEnvelope(bytes);
    if (!envelope || !envelope.payload) return;
    const payload = envelope.payload;
    switch (payload.case) {
      case "screenSessionOpened": {
        const opened = payload.value;
        if (opened.sessionId !== this.sessionId) return;
        window.clearTimeout(this.openTimer);
        if (!opened.ok) {
          const code = opened.code;
          if (code === "held") this.update({ phase: "detached", error: opened.error ?? null, ...this.statusPatch(opened.status) });
          else if (code === "no_helper") this.update({ phase: "unsupported", error: opened.error ?? null });
          else this.update({ phase: "error", error: opened.error || `打开失败（${code}）`, ...this.statusPatch(opened.status) });
          return;
        }
        this.opened = true;
        this.holderEpoch = opened.holderEpoch;
        this.appliedSize = this.openSize;
        this.update({ ...this.statusPatch(opened.status), phase: this.phaseFrom(opened.status), error: null, framesDrawn: 0 });
        this.attachVideo();
        if (!this.visible) this.sendControl({ case: "screenSessionPause", value: { sessionId: this.sessionId, holderEpoch: this.holderEpoch } });
        else this.post({ type: "clipboard-watch", on: true });
        // The size may have changed while the open was in flight.
        this.applySize();
        return;
      }
      case "screenSessionState": {
        if (payload.value.sessionId !== this.sessionId || !this.opened) return;
        const status = payload.value.status;
        this.update({ ...this.statusPatch(status), phase: this.phaseFrom(status) });
        return;
      }
      case "screenVideoAttached":
        if (!payload.value.ok) this.update({ phase: "error", error: payload.value.error || "视频通道未能绑定" });
        return;
      case "screenVideoFrame":
        this.onVideoFrame(payload.value);
        return;
      case "screenCursor": {
        const cursor = payload.value;
        if (cursor.sessionId !== this.sessionId) return;
        let shapeUrl = this.state.cursor.shapeUrl;
        let hotspotX = this.state.cursor.hotspotX;
        let hotspotY = this.state.cursor.hotspotY;
        let widthPoints = this.state.cursor.widthPoints;
        let heightPoints = this.state.cursor.heightPoints;
        if (cursor.shape && cursor.shape.png.length > 0) {
          if (this.shapeUrl) URL.revokeObjectURL(this.shapeUrl);
          this.shapeUrl = URL.createObjectURL(new Blob([cursor.shape.png as BlobPart], { type: "image/png" }));
          shapeUrl = this.shapeUrl;
          hotspotX = cursor.shape.hotspotX;
          hotspotY = cursor.shape.hotspotY;
          widthPoints = cursor.shape.widthPoints;
          heightPoints = cursor.shape.heightPoints;
        }
        this.update({ cursor: { x: cursor.x, y: cursor.y, visible: cursor.visible, shapeUrl, hotspotX, hotspotY, widthPoints, heightPoints } });
        return;
      }
      case "screenClipboardChanged": {
        const content = payload.value.content?.content;
        if (!content) return;
        if (content.case === "text") this.post({ type: "clipboard-set", text: content.value });
        else if (content.case === "png") this.post({ type: "clipboard-set", png: exactBuffer(content.value) });
        return;
      }
      case "screenSessionDetached":
        if (payload.value.sessionId !== this.sessionId) return;
        // The new holder owns the input now; what this client held is released by the helper.
        this.heldKeys.clear();
        this.heldButtons.clear();
        this.opened = false;
        this.closeDecoder();
        this.update({ phase: "detached", error: payload.value.reason ?? null });
        return;
      case "screenSessionEnded":
        if (payload.value.sessionId !== this.sessionId) return;
        this.heldKeys.clear();
        this.heldButtons.clear();
        this.opened = false;
        this.closeDecoder();
        if (this.closed) return;
        // The helper went away or the grace expired: reopen (a new display) when visible.
        this.update({ phase: "connecting", error: payload.value.reason });
        if (this.visible) this.requestReopen(this.reopenDelay);
        return;
      case "screenSessionClosed":
        return;
      case "error": {
        const error = payload.value;
        if (error.code === "empty_payload" && error.requestId === undefined) {
          this.update({ phase: "unsupported", error: "这台设备的 daemon 版本过旧，不支持屏幕" });
          return;
        }
        if (error.code === "screen_unavailable") {
          this.update({ phase: "unsupported", error: error.message });
          return;
        }
        if (error.code === "scope_denied" || error.code === "principal_mismatch") {
          this.update({ phase: "error", error: error.message });
          return;
        }
        if (lane === "control" && this.state.phase === "starting") this.update({ phase: "error", error: `${error.code}: ${error.message}` });
        return;
      }
      default:
        return;
    }
  }

  private statusPatch(status: ScreenSessionStatus | undefined): Partial<ScreenSessionState> {
    if (!status) return {};
    const permissions = status.permissions ? { screenRecording: status.permissions.screenRecording, accessibility: status.permissions.accessibility } : this.state.permissions;
    const display = status.display
      ? { widthPoints: status.display.widthPoints, heightPoints: status.display.heightPoints, scale: status.display.scale, widthPixels: status.display.widthPixels, heightPixels: status.display.heightPixels }
      : this.state.display;
    return { permissions, display, locked: status.locked, error: status.error ?? null };
  }

  private phaseFrom(status: ScreenSessionStatus | undefined): ScreenPhase {
    if (!status) return "starting";
    switch (status.phase) {
      case ScreenSessionPhase.NO_PERMISSION:
        return "no-permission";
      case ScreenSessionPhase.LOCKED:
        return "locked";
      case ScreenSessionPhase.PAUSED:
        return this.visible ? "streaming" : "paused";
      case ScreenSessionPhase.STREAMING:
        return "streaming";
      default:
        return "starting";
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Video
  // ---------------------------------------------------------------------------------------------

  /** The canvas the picture is drawn into; null detaches. */
  attachCanvas(canvas: HTMLCanvasElement | null) {
    this.canvas = canvas;
    this.context = canvas ? canvas.getContext("2d", { alpha: false }) : null;
    if (canvas && this.opened) {
      this.needKeyframe = true;
      this.sendVideo({ case: "screenKeyframeRequest", value: { sessionId: this.sessionId } });
    }
  }

  private onVideoFrame(frame: { sessionId: string; frameSeq: bigint; keyframe: boolean; widthPixels: number; heightPixels: number; codec: ScreenVideoCodec; data: Uint8Array; last: boolean; chunkIndex: number; chunkCount: number }) {
    if (frame.sessionId !== this.sessionId) return;
    // Credit is returned for every chunk received, decoded or not.
    this.returnCredit(frame.data.byteLength);
    if (frame.codec !== ScreenVideoCodec.H264 && frame.codec !== ScreenVideoCodec.UNSPECIFIED) return;
    if (this.partial && this.partial.seq !== frame.frameSeq) {
      // The previous frame never completed: it is lost, ask for a keyframe.
      this.partial = null;
      this.requestKeyframe();
    }
    // A hole inside a frame (a chunk missing or out of order) is never decoded around: the frame is
    // dropped and the stream resyncs on a keyframe. chunk_count 0 is a helper without numbering.
    const numbered = frame.chunkCount > 0;
    if (!this.partial) {
      if (numbered && frame.chunkIndex !== 0) {
        this.requestKeyframe();
        return;
      }
      this.partial = { seq: frame.frameSeq, keyframe: frame.keyframe, chunks: [], bytes: 0, count: frame.chunkCount };
    } else if (numbered && (frame.chunkIndex !== this.partial.chunks.length || frame.chunkCount !== this.partial.count)) {
      this.partial = null;
      this.requestKeyframe();
      return;
    }
    this.partial.chunks.push(frame.data);
    this.partial.bytes += frame.data.byteLength;
    const complete = numbered ? this.partial.chunks.length === this.partial.count : frame.last;
    if (!complete) return;
    const whole = this.partial;
    this.partial = null;
    if (this.needKeyframe && !whole.keyframe) {
      this.requestKeyframe();
      return;
    }
    const data = whole.chunks.length === 1 ? whole.chunks[0]! : concat(whole.chunks, whole.bytes);
    this.decode(data, whole.keyframe, frame.widthPixels, frame.heightPixels, Number(frame.frameSeq));
  }

  private requestKeyframe() {
    this.needKeyframe = true;
    this.sendVideo({ case: "screenKeyframeRequest", value: { sessionId: this.sessionId } });
  }

  private returnCredit(bytes: number) {
    this.pendingCredit += bytes;
    // Batched so a burst of small chunks does not cost a message each; nothing waits more than a frame.
    if (this.creditTimer !== undefined) return;
    this.creditTimer = window.setTimeout(() => {
      this.creditTimer = undefined;
      const credit = this.pendingCredit;
      this.pendingCredit = 0;
      if (credit > 0) this.sendVideo({ case: "screenVideoCredit", value: { sessionId: this.sessionId, bytes: BigInt(credit) } });
    }, 16);
  }

  private ensureDecoder(width: number, height: number): VideoDecoder | null {
    if (typeof VideoDecoder === "undefined") {
      this.update({ phase: "error", error: "这个构建的渲染层没有 WebCodecs 解码器" });
      return null;
    }
    if (this.decoder && this.decoder.state !== "closed" && this.decoderSize?.width === width && this.decoderSize.height === height) return this.decoder;
    this.closeDecoder();
    const decoder = new VideoDecoder({
      output: (videoFrame) => this.draw(videoFrame),
      error: () => {
        // A broken reference chain: start over from a keyframe.
        this.closeDecoder();
        this.requestKeyframe();
      },
    });
    // Annex B with in-band parameter sets: no `description`, the stream configures itself.
    decoder.configure({ codec: "avc1.64001f", codedWidth: width, codedHeight: height, optimizeForLatency: true, hardwareAcceleration: "prefer-hardware" });
    this.decoder = decoder;
    this.decoderSize = { width, height };
    return decoder;
  }

  private closeDecoder() {
    const decoder = this.decoder;
    this.decoder = null;
    this.decoderSize = null;
    this.partial = null;
    this.needKeyframe = true;
    if (decoder && decoder.state !== "closed") {
      try { decoder.close(); } catch { /* already closed */ }
    }
  }

  private decode(data: Uint8Array, keyframe: boolean, width: number, height: number, seq: number) {
    const decoder = this.ensureDecoder(width, height);
    if (!decoder) return;
    try {
      decoder.decode(new EncodedVideoChunk({ type: keyframe ? "key" : "delta", timestamp: seq * 1000, data: data as BufferSource }));
      this.needKeyframe = false;
    } catch {
      this.closeDecoder();
      this.requestKeyframe();
    }
  }

  private draw(frame: VideoFrame) {
    const canvas = this.canvas;
    const context = this.context;
    if (!canvas || !context || this.disposed) {
      frame.close();
      return;
    }
    const width = frame.displayWidth;
    const height = frame.displayHeight;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    context.drawImage(frame, 0, 0, width, height);
    frame.close();
    this.state.framesDrawn += 1;
    if (this.state.framesDrawn === 1) this.update({ framesDrawn: 1 });
  }
}

function isModifierCode(code: string): boolean {
  return code === "MetaLeft" || code === "MetaRight" || code === "ControlLeft" || code === "ControlRight" || code === "AltLeft" || code === "AltRight" || code === "ShiftLeft" || code === "ShiftRight" || code === "CapsLock" || code === "Fn";
}

/**
 * The view's bytes in an `ArrayBuffer` of exactly their size, for the port to main: an encoder's
 * output may be a view on a larger buffer, and cloning `.buffer` would send its whole backing store.
 */
function exactBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer) return bytes.buffer;
  return bytes.slice().buffer as ArrayBuffer;
}

function concat(chunks: Uint8Array[], bytes: number): Uint8Array {
  const out = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
