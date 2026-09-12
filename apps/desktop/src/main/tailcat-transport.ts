import { createHmac, randomUUID } from "node:crypto";
import WebSocket from "ws";
import { create, ClientToServerSchema, encodeClientToServer, decodeServerToClient, CONTROL_PROTOCOL_VERSION, DEVICE_PROTOCOL_VERSION, DeviceScope, type ClientToServerPayload, type DeviceTailcatResult } from "@coflux/protocol";
import { TailcatHelper } from "./tailcat-helper";

import type { NativeOpen, NativeEvent } from "../shared/native-transport";
type Lane = { id: string; stream: number; daemon: string; connection: string; scope: number; incoming: number; records: number[]; live: boolean; closed: boolean; probe?: ReturnType<typeof setInterval> };
type GrantWaiter = { resolve(value: DeviceTailcatResult): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
const MAX_BYTES = 32 * 1024 * 1024;

/** Secrets and the grant control socket stay in main. Renderer handles only
 * scoped channel IDs and opaque DeviceEnvelope bytes. */
export class NativeTailcatTransport {
  private helper?: TailcatHelper;
  private control?: WebSocket;
  private starting?: Promise<void>;
  private lanes = new Map<string, Lane>();
  private grants = new Map<string, GrantWaiter>();
  private devices = new Map<string, { key: string; users: number; connection: string; ready: Promise<void> }>();
  private controlAuthed = false;
  private heartbeat?: ReturnType<typeof setInterval>;
  private reconnect?: ReturnType<typeof setTimeout>;
  private retry = 0;
  private incomingBytes = 0;
  private incomingRecords = 0;
  private nextStream = 1;
  private opening = new Set<string>();
  private cancelled = new Set<string>();
  private epoch = 0;
  private online = false;
  private grace?: ReturnType<typeof setTimeout>;

  constructor(private readonly helperPath: string, private readonly serverUrl: string, private readonly token: () => string, private readonly emit: (event: NativeEvent) => void, private readonly appVersion = "dev") {}

  private sendControl(payload: ClientToServerPayload): void {
    if (this.control?.readyState !== WebSocket.OPEN) throw new Error("账号连接未就绪");
    this.control.send(encodeClientToServer(create(ClientToServerSchema, { payload })));
  }
  private async ensure(): Promise<void> {
    if (this.starting) return this.starting;
    if (this.helper && this.controlAuthed && this.control?.readyState === WebSocket.OPEN) return;
    const epoch = this.epoch;
    let attempt: Promise<void>;
    attempt = (async () => {
      const token = this.token(); if (!token || !this.online) throw new Error("请先连接账号");
      if (!this.helper) {
        const helper = new TailcatHelper(this.helperPath, () => { if (this.helper === helper) this.close(); });
        this.helper = helper;
        const hello = await helper.request("hello", { version: 1 });
        if (hello.version !== 1) { helper.close(); throw new Error("原生网络组件版本不兼容"); }
      }
      if (epoch !== this.epoch || !this.online) throw new Error("连接已取消");
      const url = new URL(this.serverUrl); url.protocol = url.protocol.startsWith("https") || url.protocol === "wss:" ? "wss:" : "ws:"; url.pathname = "/client"; url.search = "";
      await new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(url, { origin: "https://desktop.coflux.dev", maxPayload: 1024 * 1024 }); this.control = socket;
        let authed = false, pongAt = Date.now();
        const timeout = setTimeout(() => { socket.terminate(); reject(new Error("账号连接超时")); }, 10_000);
        socket.on("open", () => {
          if (epoch !== this.epoch || this.control !== socket) { socket.terminate(); return; }
          this.sendControl({ case: "clientAuth", value: { clientToken: token, clientKind: "desktop", controlProtocolVersion: CONTROL_PROTOCOL_VERSION, clientVersion: this.appVersion } });
        });
        socket.on("pong", () => { pongAt = Date.now(); });
        socket.on("message", (bytes: WebSocket.RawData) => {
          if (epoch !== this.epoch || this.control !== socket) return;
          const message = decodeServerToClient(new Uint8Array(bytes as Buffer));
          if (!message) { socket.terminate(); return; }
          if (message.payload.case === "authOk") {
            authed = true; this.controlAuthed = true; this.retry = 0; clearTimeout(timeout);
            if (this.online) { clearTimeout(this.grace); this.grace = undefined; }
            clearInterval(this.heartbeat);
            this.heartbeat = setInterval(() => { if (Date.now() - pongAt > 30_000) socket.terminate(); else if (socket.readyState === WebSocket.OPEN) socket.ping(); }, 15_000); this.heartbeat.unref(); resolve();
          }
          if (message.payload.case === "authError" || message.payload.case === "clientOutdated") { clearTimeout(timeout); this.online = false; reject(new Error("账号授权已失效")); this.close(); }
          // The enclosing socket/epoch check rejects messages from an obsolete
          // account connection; each attempt also owns a unique channel ID.
          if (message.payload.case === "deviceTailcatClosed") this.closeLane(message.payload.value.channelId);
          if (message.payload.case === "deviceTailcatResult") { const result = message.payload.value; const pending = this.grants.get(result.channelId); if (pending) { this.grants.delete(result.channelId); clearTimeout(pending.timer); result.ok ? pending.resolve(result) : pending.reject(new Error(result.error || "远程授权失败")); } }
        });
        socket.on("error", () => { clearTimeout(timeout); reject(new Error("账号连接失败")); });
        socket.on("close", () => {
          clearTimeout(timeout); if (!authed) reject(new Error("账号连接中断"));
          if (epoch !== this.epoch || this.control !== socket) return;
          this.control = undefined; this.controlAuthed = false; clearInterval(this.heartbeat); this.pauseLanes();
          if (this.online && !this.reconnect) { this.reconnect = setTimeout(() => { this.reconnect = undefined; if (epoch === this.epoch && this.online) void this.ensure().catch(() => undefined); }, Math.min(5000, 350 * 2 ** Math.min(this.retry++, 4))); this.reconnect.unref(); }
        });
      });
      if (this.epoch !== epoch || !this.online) throw new Error("连接已取消");
    })().finally(() => { if (this.starting === attempt) this.starting = undefined; });
    this.starting = attempt;
    return attempt;
  }

  async open(request: NativeOpen): Promise<{ handle: string; channelId: string; scopes: number[] }> {
    if (!this.online || !request.daemonId || !request.clientInstanceId || !/^\d{1,20}$/.test(request.generation) || BigInt(request.generation) <= 0n || ![1, 2, 3, 4].includes(request.scope)) throw new Error("远程连接参数无效");
    if (this.opening.size>=256 || this.opening.has(request.requestId) || this.lanes.has(request.requestId)) throw new Error("远程连接请求过多");
    this.opening.add(request.requestId);
    try { return await this.openScoped(request); } finally { this.opening.delete(request.requestId); this.cancelled.delete(request.requestId); }
  }
  private async openScoped(request: NativeOpen): Promise<{ handle: string; channelId: string; scopes: number[] }> {
    try { await this.ensure(); } catch(error){this.opening.delete(request.requestId);this.cancelled.delete(request.requestId);throw error;}
    if(this.cancelled.delete(request.requestId)){this.opening.delete(request.requestId);throw new Error("连接已取消");}
    const helper = this.helper!; const epoch = this.epoch;
    if (this.lanes.size >= 256 || this.nextStream >= 0x80000000) throw new Error("远程连接数已达上限");
    let device = this.devices.get(request.daemonId);
    if (!device) {
      if (this.devices.size >= 16) throw new Error("同时连接的设备过多");
      const connection = randomUUID();
      const created = { key: "", users: 0, connection, ready: Promise.resolve() };
      created.ready = helper.request("prepare", { connection }).then((result) => { if (typeof result.publicKey !== "string") throw new Error("远程设备身份无效"); created.key = result.publicKey; });
      this.devices.set(request.daemonId, created); device = created;
    }
    const id = request.requestId, stream = this.nextStream++, lane: Lane = { id, stream, daemon: request.daemonId, connection: device.connection, scope: request.scope, incoming: 0, records: [], live: false, closed: false };
    device.users++; this.lanes.set(id, lane);
    try {
      await device.ready; if (lane.closed || epoch !== this.epoch) throw new Error("连接已取消");
      const grant = await new Promise<DeviceTailcatResult>((resolve, reject) => {
        const timer = setTimeout(() => { this.grants.delete(id); reject(new Error("远程授权超时")); }, 30_000);
        this.grants.set(id, { resolve, reject, timer });
        try { this.sendControl({ case: "deviceTailcatConnect", value: { daemonId: request.daemonId, channelId: id, clientInstanceId: request.clientInstanceId, transportGeneration: BigInt(request.generation), protocolVersion: DEVICE_PROTOCOL_VERSION, nodePublicKey: device!.key, scope: request.scope } }); } catch (error) { clearTimeout(timer); this.grants.delete(id); reject(error); }
      });
      if (!grant.address || grant.proofKey.length !== 32 || Number(grant.expiresAt) <= Date.now() || epoch !== this.epoch || lane.closed || !this.online) throw new Error("远程授权已过期");
      let authenticated = false;
      let expectingAcceptance = false;
      let receive: ((bytes: Uint8Array) => void) | undefined;
      let rejectReceive: ((error: Error) => void) | undefined;
      const wait = () => { const promise = new Promise<Uint8Array>((resolve, reject) => { const timeout = setTimeout(() => { receive = undefined; reject(new Error("远程身份验证超时")); }, 5000); receive = (bytes) => { clearTimeout(timeout); receive = undefined; rejectReceive = undefined; resolve(bytes); }; rejectReceive = (error) => { clearTimeout(timeout); receive = undefined; rejectReceive = undefined; reject(error); }; }); void promise.catch(() => undefined); return promise; };
      helper.watch(stream, {
        frame: (frame) => {
          if (!authenticated) { if (receive) { if (expectingAcceptance && Buffer.from(frame).toString() === "ok") authenticated = true; receive(frame); } else this.closeLane(id); return; }
          if (frame.length > MAX_BYTES - lane.incoming || frame.length > 128 * 1024 * 1024 - this.incomingBytes || lane.records.length >= 256 || this.incomingRecords >= 1024) { this.closeLane(id); return; }
          lane.incoming += frame.length; lane.records.push(frame.length); this.incomingBytes += frame.length; this.incomingRecords++; this.emit({ kind: "frame", handle: id, frame });
        },
        close: () => { rejectReceive?.(new Error("远程连接中断")); this.closeLane(id); },
      });
      try { await helper.request("open", { connection: lane.connection, stream, address: grant.address }); } catch (error) {
        if (!lane.closed && !this.cancelled.has(id) && epoch === this.epoch && this.online && this.controlAuthed) { try { this.sendControl({ case: "deviceTailcatFailed", value: { channelId: id } }); } catch { /* Recovery requires live central authority. */ } }
        throw error;
      }
      const noncePromise = wait(); if (!helper.send(stream, Buffer.from(JSON.stringify({ channelId: id })))) rejectReceive?.(new Error("远程连接发送失败"));
      const nonce = await noncePromise; if (nonce.length !== 32) throw new Error("远程身份挑战无效");
      const length = Buffer.alloc(4); length.writeUInt32BE(Buffer.byteLength(id));
      const proof = createHmac("sha256", grant.proofKey).update("coflux-tailcat-channel-v1\0").update(length).update(id).update(nonce).digest();
      expectingAcceptance = true;
      const acceptedPromise = wait(); if (!helper.send(stream, proof)) rejectReceive?.(new Error("远程身份验证发送失败"));
      const accepted = await acceptedPromise; grant.proofKey.fill(0);
      if (Buffer.from(accepted).toString() !== "ok" || lane.closed || epoch !== this.epoch) throw new Error("远程身份验证失败");
      authenticated = true; lane.live = true;
      const probe = () => void helper.request("probe", { connection: lane.connection }).then((result) => { if (result.path && !lane.closed) this.emit({ kind: "path", handle: id, mode: result.path.mode, rttMs: result.path.latencyMs }); }).catch(() => undefined);
      probe(); lane.probe = setInterval(probe, 15_000); lane.probe.unref();
      return { handle: id, channelId: id, scopes: grant.scopes };
    } catch (error) { this.closeLane(id); throw error; } finally { this.opening.delete(id); this.cancelled.delete(id); }
  }

  send(handle: string, frame: Uint8Array): boolean { const lane = this.lanes.get(handle); return !!lane && lane.live && !lane.closed && (!!(this.online && this.controlAuthed) || [DeviceScope.SESSION_READ, DeviceScope.SESSION_CONTROL].includes(lane.scope)) && !!this.helper?.send(lane.stream, frame); }
  acknowledge(handle: string, bytes: number): void { const lane = this.lanes.get(handle); if (lane && lane.records[0] === bytes) { lane.records.shift(); lane.incoming -= bytes; this.incomingBytes -= bytes; this.incomingRecords--; } }

  closeLane(id: string): void {
    const lane = this.lanes.get(id); if (!lane || lane.closed) { if(this.opening.has(id))this.cancelled.add(id);return; } lane.closed = true; this.lanes.delete(id); clearInterval(lane.probe); this.incomingBytes -= lane.incoming; this.incomingRecords -= lane.records.length; lane.incoming = 0; lane.records = [];
    const pending = this.grants.get(id); if (pending) { clearTimeout(pending.timer); pending.reject(new Error("连接已取消")); this.grants.delete(id); }
    this.helper?.closeStream(lane.stream); try { this.sendControl({ case: "deviceTailcatClose", value: { channelId: id } }); } catch { /* The central grace timer revokes unreachable channels. */ }
    const device = this.devices.get(lane.daemon); if (device?.connection === lane.connection && --device.users === 0) { this.devices.delete(lane.daemon); const owner=this.helper, epoch=this.epoch; void owner?.request("drop", { connection: lane.connection }).catch(() => {if(this.helper===owner && this.epoch===epoch)this.close();}); }
    this.emit({ kind: "closed", handle: id });
  }
  private pauseLanes(): void {
    for (const id of this.opening) this.cancelled.add(id);
    for (const lane of [...this.lanes.values()]) if (!lane.live || ![DeviceScope.SESSION_READ, DeviceScope.SESSION_CONTROL].includes(lane.scope)) this.closeLane(lane.id);
    if (!this.grace) { this.grace = setTimeout(() => { this.grace = undefined; this.close(); }, 15_000); this.grace.unref(); }
  }
  setControl(online: boolean, hard: boolean): void {
    const changed = this.online !== online; this.online = online;
    try { this.sendControl({ case: "deviceTailcatControl", value: { online, hardRevoke: hard } }); } catch { /* Local enforcement still applies. */ }
    if (hard) { this.close(); return; }
    if (online && this.controlAuthed) { clearTimeout(this.grace); this.grace = undefined; }
    else if (!online && changed) this.pauseLanes();
  }
  close(): void {
    this.epoch++; for(const id of this.opening)this.cancelled.add(id); clearTimeout(this.grace); this.grace = undefined; clearTimeout(this.reconnect); this.reconnect = undefined; clearInterval(this.heartbeat); this.controlAuthed = false;
    const helper = this.helper; this.helper = undefined; const control = this.control; this.control = undefined;
    for (const id of [...this.lanes.keys()]) this.closeLane(id); this.devices.clear(); control?.close(); helper?.close();
  }
}
