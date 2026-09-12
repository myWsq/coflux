import { randomBytes } from "node:crypto";
import { DEVICE_PROTOCOL_VERSION, DeviceScope, type DeviceTailcatConnect, type ServerToClientPayload, type ServerToDaemonPayload } from "@coflux/protocol";
import type { ClientConn, DaemonConn } from "./hub.js";
import { MAX_FRAME_ID_BYTES } from "@coflux/protocol";

type Region = { RegionID: number; RegionCode?: string; Nodes: { Name: string; RegionID: number; HostName: string; DERPPort?: number; InsecureForTests?: boolean }[] };
type Endpoint = { daemon: DaemonConn; key: string; address?: string; region: Region };
type Channel = { client: ClientConn; daemon: DaemonConn; key: string; proof: Uint8Array; expires: number; address: string; timer?: ReturnType<typeof setTimeout>; installed: boolean; opened: boolean; scopes: DeviceScope[] };
const sessionScopes = [DeviceScope.SESSION_READ, DeviceScope.SESSION_CONTROL];
const elevatedScopes = [DeviceScope.RPC, DeviceScope.LIFECYCLE];
const nodeKey = (value: string) => /^nodekey:[a-f0-9]{64}$/.test(value);

export function privateTailcatRegions(raw = process.env.COFLUX_DERP_REGIONS): Region[] {
  if (!raw) return [];
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) throw new Error("COFLUX_DERP_REGIONS must contain 1–8 private regions");
  const ids = new Set<number>();
  for (const r of value) {
    if (!r || !Number.isSafeInteger(r.RegionID) || r.RegionID <= 0 || ids.has(r.RegionID) || !Array.isArray(r.Nodes) || r.Nodes.length < 1 || r.Nodes.length > 8) throw new Error("Invalid private DERP region");
    ids.add(r.RegionID);
    for (const n of r.Nodes) {
      if (!n || n.RegionID !== r.RegionID || typeof n.Name !== "string" || !n.Name || typeof n.HostName !== "string" || !n.HostName || /[\s/\\]/.test(n.HostName) || (n.InsecureForTests && n.HostName !== "127.0.0.1" && n.HostName !== "::1")) throw new Error("Invalid private DERP node");
    }
  }
  return value as Region[];
}

/** The authenticated central socket owns each endpoint and each application grant. */
export class TailcatRendezvous {
  private endpoints = new Map<string, Endpoint>();
  private channels = new Map<string, Channel>();
  private closing = new Map<ClientConn, ReturnType<typeof setTimeout>>();
  private refreshed = new Map<string, number>();
  private regionCursor = new Map<string, number>();

  constructor(private readonly regions: Region[], private readonly getDaemon: (id: string) => DaemonConn | undefined,
    private readonly sendDaemon: (daemon: DaemonConn, payload: ServerToDaemonPayload) => boolean,
    private readonly sendClient: (client: ClientConn, payload: ServerToClientPayload) => void) {}

  identity(daemon: DaemonConn, key: string, version: number): void {
    if (version !== 1 || !nodeKey(key) || this.regions.length === 0) return;
    const id = daemon.info.daemonId;
    if (this.getDaemon(id) !== daemon) return;
    const previous = this.endpoints.get(id);
    // A helper restart rotates to the next configured region. This is explicit
    // endpoint replacement, not an assumption of upstream cross-region failover.
    const cursor = previous ? (this.regionCursor.get(id) ?? 0) + 1 : this.regionCursor.get(id) ?? 0;
    this.removeDaemon(id);
    this.regionCursor.set(id, cursor % this.regions.length);
    const region = this.regions[cursor % this.regions.length]!;
    this.endpoints.set(id, { daemon, key, region });
    this.sendDaemon(daemon, { case: "deviceTailcatConfigure", value: { regionJson: Buffer.from(JSON.stringify(region)), transportVersion: 1, accountId: daemon.accountId } });
  }

  endpoint(daemon: DaemonConn, key: string, address: string, version: number): void {
    const endpoint = this.endpoints.get(daemon.info.daemonId);
    if (!endpoint || endpoint.daemon !== daemon || endpoint.key !== key || version !== 1 || !address || address.length > 32768) return;
    endpoint.address = address;
  }

  connect(client: ClientConn, request: DeviceTailcatConnect): void {
    const fail = (error: string) => this.sendClient(client, { case: "deviceTailcatResult", value: { channelId: request.channelId, ok: false, proofKey: new Uint8Array(), expiresAt: 0n, scopes: [], error } });
    const daemon = this.getDaemon(request.daemonId);
    const endpoint = this.endpoints.get(request.daemonId);
    if (!client.accountId || this.closing.has(client) || !daemon || daemon.accountId !== client.accountId || endpoint?.daemon !== daemon || !endpoint.address) return fail("设备尚未提供原生远程连接");
    if (!validNativeId(request.channelId) || request.channelId.startsWith("__coflux-") || !validNativeId(request.clientInstanceId) || request.transportGeneration <= 0n || request.protocolVersion !== DEVICE_PROTOCOL_VERSION || !nodeKey(request.nodePublicKey) || ![...sessionScopes,...elevatedScopes].includes(request.scope)) return fail("远程连接参数无效");
    if (!allowRendezvous(client) || this.channels.size >= 4096 || this.channels.has(request.channelId)) return fail("远程连接请求过多");
    const proof = randomBytes(32), expires = Date.now() + 30_000;
    const scopes=sessionScopes.includes(request.scope)?sessionScopes:elevatedScopes;
    const entry: Channel = { client, daemon, key: request.nodePublicKey, proof, expires, address: endpoint.address, installed: false, opened:false, scopes };
    this.channels.set(request.channelId, entry);
    entry.timer = setTimeout(() => { this.removeChannel(request.channelId); fail("远程连接授权超时"); }, 30_000);
    entry.timer.unref?.();
    if (!this.sendDaemon(daemon, { case: "deviceTailcatGrant", value: { channelId: request.channelId, accountId: client.accountId, daemonId: request.daemonId,
      clientInstanceId: request.clientInstanceId, transportGeneration: request.transportGeneration, scopes, expiresAt: BigInt(expires), proofKey: proof, nodePublicKey: request.nodePublicKey, protocolVersion: DEVICE_PROTOCOL_VERSION } })) {
      this.removeChannel(request.channelId); fail("设备连接已中断");
    }
  }

  installed(daemon: DaemonConn, channel: string, ok: boolean): void {
    const entry = this.channels.get(channel);
    if (!entry || entry.daemon !== daemon || entry.installed) return;
    if (!ok || entry.expires <= Date.now() || this.closing.has(entry.client)) { this.removeChannel(channel); this.sendClient(entry.client, { case: "deviceTailcatResult", value: { channelId: channel, ok: false, proofKey: new Uint8Array(), expiresAt: 0n, scopes: [], error: "设备拒绝远程连接授权" } }); return; }
    entry.installed = true;
    this.sendClient(entry.client, { case: "deviceTailcatResult", value: { channelId: channel, ok: true, address: entry.address, proofKey: entry.proof, expiresAt: BigInt(entry.expires), scopes:entry.scopes } });
    // This copy is no longer needed after delivering the one-time proof key.
    entry.proof = new Uint8Array(); entry.address = "";
  }

  opened(daemon:DaemonConn,id:string):void{const entry=this.channels.get(id);if(!entry || entry.daemon!==daemon || !entry.installed || entry.expires<=Date.now() || this.closing.has(entry.client)){if(entry?.daemon===daemon)this.removeChannel(id);return;}entry.opened=true;clearTimeout(entry.timer);entry.timer=undefined;}
  control(client:ClientConn,online:boolean,hard:boolean):void{if(hard){this.closeClient(client,true);return;}if(online){clearTimeout(this.closing.get(client));this.closing.delete(client);}else this.closeClient(client);}

  failed(client: ClientConn, id: string): void {
    const entry = this.channels.get(id);
    if (!entry || entry.client !== client || !entry.installed || entry.opened || this.closing.has(client)) return;
    const daemonId = entry.daemon.info.daemonId, endpoint = this.endpoints.get(daemonId);
    if (!endpoint || endpoint.daemon !== entry.daemon || this.getDaemon(daemonId) !== entry.daemon) return;
    this.removeChannel(id);
    if (Date.now() - (this.refreshed.get(daemonId) ?? 0) < 10_000) return;
    this.refreshed.set(daemonId, Date.now());
    // A failed client dial requests a worker-side reachability check.
    // A healthy region does not rotate because one client lost its network.
    this.sendDaemon(entry.daemon, { case: "deviceTailcatConfigure", value: { regionJson: Buffer.from(JSON.stringify(endpoint.region)), transportVersion: 1, accountId: entry.daemon.accountId, refreshOnly: true } });
  }
  closeChannel(client: ClientConn, id: string): void { if (this.channels.get(id)?.client === client) this.removeChannel(id); }
  private removeChannel(id: string): void {
    const entry = this.channels.get(id); if (!entry) return;
    this.channels.delete(id); clearTimeout(entry.timer);
    this.sendClient(entry.client, { case: "deviceTailcatClosed", value: { channelId: id } });
    this.sendDaemon(entry.daemon, { case: "deviceTailcatRevoke", value: { channelIds: [id] } });
  }
  removeDaemon(id: string): void {
    this.endpoints.delete(id);
    for (const [channel, value] of this.channels) if (value.daemon.info.daemonId === id) this.removeChannel(channel);
  }
  closeClient(client: ClientConn, immediate = false): void {
    for(const [id,entry] of this.channels) if(entry.client===client && (!entry.opened || entry.scopes.some(scope=>elevatedScopes.includes(scope)))) this.removeChannel(id);
    if (!immediate && !this.closing.has(client)) {
      const timer = setTimeout(() => this.closeClient(client, true), 15_000); timer.unref?.(); this.closing.set(client, timer); return;
    }
    if (!immediate) return;
    clearTimeout(this.closing.get(client)); this.closing.delete(client);
    for (const [channel, value] of this.channels) if (value.client === client) this.removeChannel(channel);
  }
  revokeToken(account: string, tokenHash: string): void {
    for (const value of this.channels.values()) if (value.client.accountId === account && value.client.tokenHash === tokenHash) this.closeClient(value.client, true);
  }
  admitted(publicKey: string): boolean {
    if (!nodeKey(publicKey)) return false;
    for (const endpoint of this.endpoints.values()) if (endpoint.key === publicKey && this.getDaemon(endpoint.daemon.info.daemonId) === endpoint.daemon) return true;
    for (const entry of this.channels.values()) if (entry.key === publicKey && this.getDaemon(entry.daemon.info.daemonId) === entry.daemon) return true;
    return false;
  }
  shutdown(): void { for (const id of [...this.channels.keys()]) this.removeChannel(id); for (const timer of this.closing.values()) clearTimeout(timer); this.closing.clear(); this.endpoints.clear(); }
}


function validNativeId(value: string): boolean {
  return value.length > 0 && Buffer.byteLength(value, "utf8") <= MAX_FRAME_ID_BYTES && ![...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
}
const rendezvousWindows = new WeakMap<object, { startedAt: number; count: number }>();
function allowRendezvous(connection: object): boolean {
  const now = Date.now();
  let window = rendezvousWindows.get(connection);
  if (!window || now - window.startedAt >= 1000) { window = { startedAt: now, count: 0 }; rendezvousWindows.set(connection, window); }
  return ++window.count <= 32;
}
