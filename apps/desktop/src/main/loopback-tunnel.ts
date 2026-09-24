import { Duplex } from "node:stream";
import {
  create,
  decodeDeviceEnvelope,
  DEVICE_PROTOCOL_VERSION,
  DeviceEnvelopeSchema,
  DeviceLoopbackFailure,
  encodeDeviceEnvelope,
  type DeviceEnvelopePayload,
} from "@coflux/protocol";

/**
 * The desktop end of the Device protocol's loopback tunnel (plan 20260924-remote-localhost-tunnel).
 *
 * One lane per remote device, owned by main (`NativeTailcatTransport.openOwned`, RPC scope), carries
 * every tunnel connection of every workspace on that device, multiplexed by connection id. Each
 * connection is a `Duplex` the browser proxy splices a Chromium socket onto.
 *
 * Flow control mirrors the worker (`crates/worker/src/device_loopback.rs`), counted in data frames:
 * - device → here: the worker keeps at most 8 unacknowledged frames per connection and 48 per lane.
 *   Every data frame is acknowledged exactly once — when it was handed on (pushed below the readable
 *   high-water mark, or later when the consumer drains), or immediately when its connection is gone
 *   here — because the worker returns lane credit only on acknowledgement.
 * - here → device: at most 8 unacknowledged frames per connection and 16 per lane; a write waits for
 *   credit, never drops. A connection closed here gives its outstanding credit back at once, and
 *   later acknowledgements for it are ignored.
 *
 * Lanes open lazily, back off exponentially after a failure (never one grant per TCP connection: the
 * centre allows 32 grant requests a second per connection), close after an idle minute, and are never
 * opened while the renderer reports the account offline — only the renderer sets that.
 */

/** Largest payload of one data frame, both directions. */
export const FRAME_BYTES = 64 * 1024;
/** Unacknowledged here→device data frames per connection. */
export const CONNECTION_WINDOW_FRAMES = 8;
/** Unacknowledged here→device data frames across the lane. */
export const LANE_WINDOW_FRAMES = 16;
/** Concurrent connections per lane (the worker's per-channel cap). */
export const LANE_CONNECTION_LIMIT = 64;
const OPEN_TIMEOUT_MS = 20_000;
const IDLE_CLOSE_MS = 60_000;
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 15_000;
/** A lane that stayed up this long before closing does not count towards backoff escalation. */
const STABLE_LANE_MS = 10_000;
/** Readable buffer before acknowledgements are held back (on top of the worker's 512 KiB window). */
const READABLE_HIGH_WATER_MARK = 256 * 1024;

/** Which failure page a failed tunnel open shows. */
export type TunnelFailureReason = "offline" | "refused" | "unsupported";

export class TunnelError extends Error {
  constructor(
    readonly reason: TunnelFailureReason,
    message: string,
  ) {
    super(message);
    this.name = "TunnelError";
  }
}

export type OwnedLane = { channelId: string; send(frame: Uint8Array): boolean; close(): void };

export type LaneOpener = {
  /** The renderer-owned online state of the transport; main never sets it. */
  online(): boolean;
  open(daemonId: string, handlers: { frame(bytes: Uint8Array): void; closed(): void }): Promise<OwnedLane>;
};

export type TunnelClock = {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

const systemClock: TunnelClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => {
    const timer = setTimeout(callback, ms);
    timer.unref?.();
    return timer;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

type LaneErrorClass = "unsupported" | "lane-error" | "request-error";

/**
 * A worker that predates the tunnel decodes its payloads as an empty oneof and answers exactly
 * `DeviceError{code:"empty_payload"}` without a request id. Nothing else means "too old": other
 * request-id-less errors on this lane (`scope_denied`, `unsupported_payload`, `invalid_request_id`)
 * are bugs or grant problems.
 */
export function classifyLaneError(error: { requestId?: string; code: string }): LaneErrorClass {
  if (error.requestId !== undefined) return "request-error";
  return error.code === "empty_payload" ? "unsupported" : "lane-error";
}

export function failureReasonOf(reason: DeviceLoopbackFailure): TunnelFailureReason {
  return reason === DeviceLoopbackFailure.REFUSED ? "refused" : "offline";
}

/** Backoff before the n-th consecutive failure's retry (n ≥ 1). */
export function backoffDelay(failures: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1));
}

type PendingWrite = { chunk: Buffer; offset: number; callback: (error?: Error | null) => void };

/** One tunnel connection: bytes to and from one loopback port of the device. */
export class TunnelSocket extends Duplex {
  /** Here→device frames not yet acknowledged. */
  outstanding = 0;
  /** Device→here frames received but not yet acknowledged (held back by readable backpressure). */
  private unacked = 0;
  private pendingWrite: PendingWrite | undefined;
  private phase: "opening" | "open" | "closed" = "opening";
  private remoteEnded = false;
  private pendingOpen: { resolve(socket: TunnelSocket): void; reject(error: Error): void; timer: unknown } | undefined;

  constructor(
    private readonly lane: DeviceLane,
    readonly id: number,
  ) {
    super({ allowHalfOpen: false, readableHighWaterMark: READABLE_HIGH_WATER_MARK });
  }

  /** @internal Resolves once the device answers the open. */
  awaitOpen(resolve: (socket: TunnelSocket) => void, reject: (error: Error) => void, timer: unknown): void {
    this.pendingOpen = { resolve, reject, timer };
  }

  get isOpening(): boolean {
    return this.phase === "opening";
  }

  /** @internal */
  opened(): void {
    if (this.phase !== "opening") return;
    this.phase = "open";
    const pending = this.pendingOpen;
    this.pendingOpen = undefined;
    if (pending) {
      this.lane.clock.clearTimeout(pending.timer);
      pending.resolve(this);
    }
  }

  /** @internal The open failed, timed out, or the lane went away before it was answered. */
  failOpen(error: TunnelError, notifyDevice: boolean): void {
    if (this.phase !== "opening") return;
    this.phase = "closed";
    const pending = this.pendingOpen;
    this.pendingOpen = undefined;
    this.lane.forget(this);
    if (notifyDevice) this.lane.sendClose(this.id);
    if (pending) {
      this.lane.clock.clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  /** @internal A data frame from the device. */
  deliver(data: Uint8Array): void {
    if (this.phase !== "open" || this.remoteEnded) {
      this.lane.sendAck(this.id, 1);
      return;
    }
    if (this.push(Buffer.from(data.buffer, data.byteOffset, data.byteLength))) this.lane.sendAck(this.id, 1);
    else this.unacked++;
  }

  override _read(): void {
    this.flushAcks();
  }

  private flushAcks(): void {
    if (this.unacked === 0) return;
    const frames = this.unacked;
    this.unacked = 0;
    this.lane.sendAck(this.id, frames);
  }

  /** @internal The device closed the connection: everything it sent is already here. */
  remoteClose(): void {
    if (this.phase === "opening") {
      this.failOpen(new TunnelError("offline", "设备关闭了连接"), false);
      return;
    }
    if (this.phase === "closed" || this.remoteEnded) return;
    this.remoteEnded = true;
    // The frames still buffered will never be read by the device's credit logic otherwise.
    this.flushAcks();
    this.lane.forget(this);
    const pending = this.pendingWrite;
    this.pendingWrite = undefined;
    pending?.callback();
    this.push(null);
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (this.phase !== "open" || this.remoteEnded) {
      // Nobody on the device side reads this any more.
      callback();
      return;
    }
    this.pendingWrite = { chunk, offset: 0, callback };
    this.flush();
  }

  /** @internal Sends as much of the pending write as credit allows; completes it when all is sent. */
  flush(): void {
    const pending = this.pendingWrite;
    if (!pending || this.phase !== "open") return;
    while (pending.offset < pending.chunk.length) {
      if (this.outstanding >= CONNECTION_WINDOW_FRAMES) return;
      if (!this.lane.takeCredit(this)) return;
      const end = Math.min(pending.offset + FRAME_BYTES, pending.chunk.length);
      this.outstanding++;
      if (!this.lane.sendData(this.id, pending.chunk.subarray(pending.offset, end))) return;
      pending.offset = end;
    }
    if (this.pendingWrite === pending) this.pendingWrite = undefined;
    pending.callback();
  }

  override _final(callback: (error?: Error | null) => void): void {
    if (this.phase === "open" && !this.remoteEnded) {
      // Chromium closed its side: the device may close too. Full close, like the worker's.
      this.phase = "closed";
      this.flushAcks();
      this.lane.sendClose(this.id);
      this.lane.forget(this);
      this.push(null);
    }
    callback();
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    if (this.phase === "opening") this.failOpen(new TunnelError("offline", "连接已取消"), true);
    else if (this.phase === "open") {
      this.phase = "closed";
      this.flushAcks();
      if (!this.remoteEnded) this.lane.sendClose(this.id);
      this.lane.forget(this);
    }
    this.pendingWrite = undefined;
    callback(error);
  }
}

/** One remote device's lane and its connections. */
export class DeviceLane {
  private lane: OwnedLane | undefined;
  private opening: Promise<OwnedLane> | undefined;
  /** Bumped whenever the lane is abandoned, so callbacks of an old lane are ignored. */
  private generation = 0;
  private openedAt = 0;
  private readonly connections = new Map<number, TunnelSocket>();
  private nextId = 1;
  /** Here→device frames in flight across the lane. */
  private outstanding = 0;
  /** Connections waiting for lane credit, in order. */
  private waiting: TunnelSocket[] = [];
  private unsupported = false;
  private failures = 0;
  private retryAt = 0;
  private idleTimer: unknown;

  constructor(
    readonly daemonId: string,
    private readonly opener: LaneOpener,
    private readonly log: (message: string, detail?: unknown) => void,
    readonly clock: TunnelClock,
  ) {}

  async connect(port: number): Promise<TunnelSocket> {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TunnelError("offline", "端口无效");
    if (!this.opener.online()) throw new TunnelError("offline", "账号未连接");
    await this.ensure();
    if (this.unsupported) throw new TunnelError("unsupported", "设备的 coflux 版本过旧");
    if (!this.lane) throw new TunnelError("offline", "设备连接已中断");
    if (this.connections.size >= LANE_CONNECTION_LIMIT) throw new TunnelError("offline", "到该设备的连接过多");
    if (this.nextId > 0xffffffff) {
      this.fail("连接编号已用尽");
      throw new TunnelError("offline", "设备连接已中断");
    }
    const socket = new TunnelSocket(this, this.nextId++);
    this.connections.set(socket.id, socket);
    this.stopIdleTimer();
    const opened = new Promise<TunnelSocket>((resolve, reject) => {
      const timer = this.clock.setTimeout(() => socket.failOpen(new TunnelError("offline", "设备响应超时"), true), OPEN_TIMEOUT_MS);
      socket.awaitOpen(resolve, reject, timer);
    });
    if (!this.sendPayload({ case: "loopbackOpen", value: { connectionId: socket.id, port } })) {
      socket.failOpen(new TunnelError("offline", "设备连接已中断"), false);
    }
    return opened;
  }

  private async ensure(): Promise<void> {
    if (this.lane) return;
    if (!this.opening) {
      if (this.clock.now() < this.retryAt) throw new TunnelError("offline", "设备暂时无法连接");
      const generation = ++this.generation;
      this.opening = this.opener
        .open(this.daemonId, {
          frame: (bytes) => {
            if (generation === this.generation) this.onFrame(bytes);
          },
          closed: () => {
            // A close during the open is the open's own failure, handled below.
            if (generation === this.generation && this.lane) this.onClosed();
          },
        })
        .then(
          (lane) => {
            if (generation !== this.generation) {
              lane.close();
              throw new TunnelError("offline", "连接已取消");
            }
            this.lane = lane;
            this.opening = undefined;
            this.openedAt = this.clock.now();
            this.unsupported = false;
            return lane;
          },
          (error: unknown) => {
            if (generation === this.generation) {
              this.opening = undefined;
              this.noteFailure(undefined);
              this.log("远程设备的浏览器通道打开失败", error instanceof Error ? error.message : String(error));
            }
            throw new TunnelError("offline", "设备离线或无法连接");
          },
        );
    }
    await this.opening;
  }

  private noteFailure(uptime: number | undefined): void {
    this.failures = uptime !== undefined && uptime >= STABLE_LANE_MS ? 1 : this.failures + 1;
    this.retryAt = this.clock.now() + backoffDelay(this.failures);
  }

  /** The transport closed the lane (reset, central disconnect, helper death, worker replacement). */
  private onClosed(): void {
    const uptime = this.clock.now() - this.openedAt;
    this.abandon("设备连接已中断");
    this.noteFailure(uptime);
  }

  /** Drops the lane and every connection on it; the next connect opens a new lane. */
  private abandon(message: string): void {
    const lane = this.lane;
    this.generation++;
    this.lane = undefined;
    this.opening = undefined;
    this.unsupported = false;
    this.stopIdleTimer();
    lane?.close();
    const error = new TunnelError("offline", message);
    for (const socket of [...this.connections.values()]) {
      // Open connections end with a plain close, never an 'error' event: whoever holds them sees
      // the close, and nobody can be left without an error listener.
      if (socket.isOpening) socket.failOpen(error, false);
      else if (!socket.destroyed) socket.destroy();
    }
    this.connections.clear();
    this.waiting = [];
    this.outstanding = 0;
  }

  /** Fatal for the lane: a frame could not be handed to the transport, or the device spoke nonsense. */
  private fail(message: string): void {
    const uptime = this.clock.now() - this.openedAt;
    this.log("远程设备的浏览器通道已关闭", message);
    this.abandon("设备连接已中断");
    this.noteFailure(uptime);
  }

  /** Closes the lane for good (app quit, account change). */
  dispose(): void {
    this.abandon("连接已关闭");
    this.failures = 0;
    this.retryAt = 0;
  }

  private stopIdleTimer(): void {
    if (this.idleTimer === undefined) return;
    this.clock.clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private startIdleTimer(): void {
    if (this.idleTimer !== undefined || !this.lane) return;
    this.idleTimer = this.clock.setTimeout(() => {
      this.idleTimer = undefined;
      if (this.connections.size > 0 || !this.lane) return;
      // Deliberate: no backoff, and the unsupported flag goes with the lane (a worker upgrade is
      // picked up by the next open).
      this.abandon("连接已关闭");
      this.failures = 0;
      this.retryAt = 0;
    }, IDLE_CLOSE_MS);
  }

  private sendPayload(payload: DeviceEnvelopePayload): boolean {
    const lane = this.lane;
    if (!lane) return false;
    const frame = encodeDeviceEnvelope(create(DeviceEnvelopeSchema, { protocolVersion: DEVICE_PROTOCOL_VERSION, channelId: lane.channelId, payload }));
    if (lane.send(frame)) return true;
    // The helper's stdin backlog is over budget or the lane is gone: fatal for the lane.
    this.fail("发送失败");
    return false;
  }

  /** @internal */
  sendAck(connectionId: number, frames: number): void {
    if (frames > 0) this.sendPayload({ case: "loopbackAck", value: { connectionId, frames } });
  }

  /** @internal */
  sendClose(connectionId: number): void {
    this.sendPayload({ case: "loopbackClose", value: { connectionId } });
  }

  /** @internal */
  sendData(connectionId: number, data: Uint8Array): boolean {
    return this.sendPayload({ case: "loopbackData", value: { connectionId, data } });
  }

  /** @internal Takes one frame of lane credit, or queues the connection until some returns. */
  takeCredit(socket: TunnelSocket): boolean {
    if (this.outstanding < LANE_WINDOW_FRAMES) {
      this.outstanding++;
      return true;
    }
    if (!this.waiting.includes(socket)) this.waiting.push(socket);
    return false;
  }

  /** @internal The connection is closed here: give its credit back, stop tracking it. */
  forget(socket: TunnelSocket): void {
    if (this.connections.get(socket.id) === socket) this.connections.delete(socket.id);
    this.outstanding = Math.max(0, this.outstanding - socket.outstanding);
    socket.outstanding = 0;
    this.waiting = this.waiting.filter((waiting) => waiting !== socket);
    this.pumpWaiting();
    if (this.connections.size === 0) this.startIdleTimer();
  }

  private pumpWaiting(): void {
    while (this.waiting.length > 0 && this.outstanding < LANE_WINDOW_FRAMES) {
      this.waiting.shift()!.flush();
    }
  }

  private onFrame(bytes: Uint8Array): void {
    const envelope = decodeDeviceEnvelope(bytes);
    if (!envelope) {
      this.fail("设备帧无法解码");
      return;
    }
    const payload = envelope.payload;
    switch (payload.case) {
      case "loopbackOpened": {
        const socket = this.connections.get(payload.value.connectionId);
        if (!socket) return;
        this.failures = 0;
        socket.opened();
        return;
      }
      case "loopbackFailed": {
        const socket = this.connections.get(payload.value.connectionId);
        socket?.failOpen(new TunnelError(failureReasonOf(payload.value.reason), payload.value.message || "设备无法打开连接"), false);
        return;
      }
      case "loopbackData": {
        const socket = this.connections.get(payload.value.connectionId);
        // Gone here already: acknowledge anyway, the device's lane credit depends on it.
        if (socket) socket.deliver(payload.value.data);
        else this.sendAck(payload.value.connectionId, 1);
        return;
      }
      case "loopbackAck": {
        const socket = this.connections.get(payload.value.connectionId);
        // A connection closed here already returned its credit.
        if (!socket) return;
        const frames = Math.min(payload.value.frames, socket.outstanding);
        socket.outstanding -= frames;
        this.outstanding = Math.max(0, this.outstanding - frames);
        socket.flush();
        this.pumpWaiting();
        return;
      }
      case "loopbackClose":
        this.connections.get(payload.value.connectionId)?.remoteClose();
        return;
      case "error": {
        const kind = classifyLaneError(payload.value);
        if (kind === "request-error") {
          this.log("远程设备的浏览器通道收到请求错误", payload.value.code);
          return;
        }
        const unsupported = kind === "unsupported";
        if (unsupported) {
          // Until this lane closes: the next lane (e.g. after a worker upgrade) asks again.
          this.unsupported = true;
          this.failures = 0;
        } else {
          this.log("远程设备的浏览器通道出错", `${payload.value.code}: ${payload.value.message}`);
        }
        const error = unsupported
          ? new TunnelError("unsupported", "设备的 coflux 版本过旧")
          : new TunnelError("offline", `设备拒绝了连接（${payload.value.code}）`);
        // The error names no connection: every open still waiting for an answer is affected.
        for (const socket of [...this.connections.values()]) {
          if (socket.isOpening) socket.failOpen(error, false);
        }
        return;
      }
      default:
        return;
    }
  }

  /** @internal Test and diagnostics view. */
  get stats(): { connections: number; outstanding: number; waiting: number; open: boolean; unsupported: boolean; retryAt: number } {
    return { connections: this.connections.size, outstanding: this.outstanding, waiting: this.waiting.length, open: !!this.lane, unsupported: this.unsupported, retryAt: this.retryAt };
  }
}

/** Every remote device's lane, keyed by daemon id. */
export class LoopbackTunnels {
  private readonly lanes = new Map<string, DeviceLane>();

  constructor(
    private readonly opener: LaneOpener,
    private readonly log: (message: string, detail?: unknown) => void,
    private readonly clock: TunnelClock = systemClock,
  ) {}

  /** A connection to `port` on the device's loopback; rejects with a `TunnelError`. */
  connect(daemonId: string, port: number): Promise<TunnelSocket> {
    return this.lane(daemonId).connect(port);
  }

  lane(daemonId: string): DeviceLane {
    let lane = this.lanes.get(daemonId);
    if (!lane) {
      lane = new DeviceLane(daemonId, this.opener, this.log, this.clock);
      this.lanes.set(daemonId, lane);
    }
    return lane;
  }

  dispose(): void {
    for (const lane of this.lanes.values()) lane.dispose();
    this.lanes.clear();
  }
}
