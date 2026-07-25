/**
 * Device opaque relay。
 *
 * server 只在 open 时把已认证 client 绑定到同账号 daemon，随后按 channelId 原样搬运
 * DeviceEnvelope bytes。这里刻意不导入 decodeDeviceEnvelope，也没有任何 terminal/exec/fs
 * oneof 分支；业务权限和 exactly-once 语义全部在 worker/sessiond 的 Device endpoint。
 */
import type { WebSocket } from "ws";
import {
  DEVICE_PROTOCOL_VERSION,
  MAX_DEVICE_FRAME_BYTES,
  DeviceScope,
  type AccountId,
  type DaemonId,
  type DeviceRelayClientOpen,
  type DeviceRelayClose,
  type DeviceRelayFrame,
  type ServerToClientPayload,
  type ServerToDaemonPayload,
} from "@coflux/protocol";

interface RelayClient {
  ws: WebSocket;
  accountId: AccountId | null;
}

interface RelayDaemon {
  ws: WebSocket;
  accountId: AccountId;
  info: { daemonId: DaemonId };
}

interface RateWindow {
  startedAt: number;
  frames: number;
  bytes: number;
}

interface RelayChannel<C extends RelayClient, D extends RelayDaemon> {
  channelId: string;
  accountId: AccountId;
  daemonId: DaemonId;
  client: C;
  daemon: D;
  clientRate: RateWindow;
  daemonRate: RateWindow;
}

const MAX_ID_BYTES = 256;
const MAX_CHANNELS_PER_CLIENT = 64;
const MAX_CHANNELS_PER_DAEMON = 1024;
const MAX_CHANNELS_TOTAL = 10_000;
const MAX_FRAMES_PER_SECOND = 2048;
const MAX_BYTES_PER_SECOND = 128 * 1024 * 1024;

export class DeviceRelayRouter<C extends RelayClient, D extends RelayDaemon> {
  private channels = new Map<string, RelayChannel<C, D>>();

  constructor(
    private readonly daemonForId: (daemonId: DaemonId) => D | undefined,
    private readonly sendDaemon: (daemon: D, payload: ServerToDaemonPayload) => void,
    private readonly sendClient: (client: C, payload: ServerToClientPayload) => void,
    private readonly bufferedAmountLimit: number,
  ) {}

  open(client: C, request: DeviceRelayClientOpen): void {
    const fail = (error: string) =>
      this.sendClient(client, { case: "deviceRelayStatus", value: { channelId: request.channelId, ok: false, error } });

    if (!client.accountId) return void fail("client 未认证");
    if (
      request.protocolVersion !== DEVICE_PROTOCOL_VERSION ||
      !validId(request.daemonId) ||
      !validId(request.channelId) ||
      request.channelId.startsWith("__coflux-") ||
      !validId(request.clientInstanceId) ||
      request.transportGeneration <= 0n
    ) {
      return void fail("relay channel/principal/version 无效");
    }
    if (this.channels.has(request.channelId)) return void fail("relay channelId 已存在");
    if (this.channels.size >= MAX_CHANNELS_TOTAL) return void fail("server relay channel 数已达上限");

    const daemon = this.daemonForId(request.daemonId);
    if (!daemon || daemon.accountId !== client.accountId) return void fail("daemon 不在线或不属于本账号");
    if (this.countByClient(client) >= MAX_CHANNELS_PER_CLIENT) return void fail("本连接 relay channel 数已达上限");
    if (this.countByDaemon(request.daemonId) >= MAX_CHANNELS_PER_DAEMON) return void fail("daemon relay channel 数已达上限");

    const channel: RelayChannel<C, D> = {
      channelId: request.channelId,
      accountId: client.accountId,
      daemonId: request.daemonId,
      client,
      daemon,
      clientRate: freshRateWindow(),
      daemonRate: freshRateWindow(),
    };
    this.channels.set(channel.channelId, channel);
    this.sendDaemon(daemon, {
      case: "deviceRelayOpen",
      value: {
        channelId: channel.channelId,
        accountId: channel.accountId,
        clientInstanceId: request.clientInstanceId,
        transportGeneration: request.transportGeneration,
        scopes: [DeviceScope.SESSION_READ, DeviceScope.SESSION_CONTROL, DeviceScope.RPC, DeviceScope.LIFECYCLE],
        protocolVersion: DEVICE_PROTOCOL_VERSION,
      },
    });
    this.sendClient(client, { case: "deviceRelayStatus", value: { channelId: channel.channelId, ok: true } });
  }

  fromClient(client: C, message: DeviceRelayFrame): void {
    const channel = this.channels.get(message.channelId);
    if (!channel || channel.client !== client || channel.accountId !== client.accountId) return;
    if (!validFrame(message.frame) || !allowRate(channel.clientRate, message.frame.byteLength)) {
      this.drop(channel, true, true, "relay client frame 超限");
      return;
    }
    if (channel.daemon.ws.readyState !== channel.daemon.ws.OPEN || channel.daemon.ws.bufferedAmount > this.bufferedAmountLimit) {
      this.drop(channel, true, true, "daemon relay transport 不可用");
      return;
    }
    this.sendDaemon(channel.daemon, { case: "deviceRelayFrame", value: message });
  }

  fromDaemon(daemon: D, message: DeviceRelayFrame): void {
    const channel = this.channels.get(message.channelId);
    if (!channel || channel.daemon !== daemon || channel.daemonId !== daemon.info.daemonId) return;
    if (!validFrame(message.frame) || !allowRate(channel.daemonRate, message.frame.byteLength)) {
      this.drop(channel, true, true, "relay daemon frame 超限");
      return;
    }
    if (channel.client.ws.readyState !== channel.client.ws.OPEN || channel.client.ws.bufferedAmount > this.bufferedAmountLimit) {
      this.drop(channel, true, true, "client relay transport 不可用");
      return;
    }
    this.sendClient(channel.client, { case: "deviceRelayFrame", value: message });
  }

  closeFromClient(client: C, message: DeviceRelayClose): void {
    const channel = this.channels.get(message.channelId);
    if (!channel || channel.client !== client) return;
    this.drop(channel, false, true, message.reason ?? "client closed relay channel");
  }

  closeFromDaemon(daemon: D, message: DeviceRelayClose): void {
    const channel = this.channels.get(message.channelId);
    if (!channel || channel.daemon !== daemon) return;
    this.drop(channel, true, false, message.reason ?? "daemon closed relay channel");
  }

  closeByClient(client: C): void {
    for (const channel of [...this.channels.values()]) {
      if (channel.client === client) this.drop(channel, false, true, "client connection closed");
    }
  }

  closeByDaemon(daemonId: DaemonId): void {
    for (const channel of [...this.channels.values()]) {
      if (channel.daemonId === daemonId) this.drop(channel, true, false, "daemon connection closed");
    }
  }

  shutdown(): void {
    for (const channel of [...this.channels.values()]) this.drop(channel, false, false, "server shutting down");
  }

  private drop(channel: RelayChannel<C, D>, notifyClient: boolean, notifyDaemon: boolean, reason: string): void {
    if (!this.channels.delete(channel.channelId)) return;
    const value = { channelId: channel.channelId, reason };
    if (notifyClient) this.sendClient(channel.client, { case: "deviceRelayClose", value });
    if (notifyDaemon) this.sendDaemon(channel.daemon, { case: "deviceRelayClose", value });
  }

  private countByClient(client: C): number {
    let count = 0;
    for (const channel of this.channels.values()) if (channel.client === client) count += 1;
    return count;
  }

  private countByDaemon(daemonId: DaemonId): number {
    let count = 0;
    for (const channel of this.channels.values()) if (channel.daemonId === daemonId) count += 1;
    return count;
  }
}

function validId(value: string): boolean {
  return value.length > 0 && Buffer.byteLength(value, "utf8") <= MAX_ID_BYTES && ![...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
}

function validFrame(frame: Uint8Array): boolean {
  return frame.byteLength > 0 && frame.byteLength <= MAX_DEVICE_FRAME_BYTES;
}

function freshRateWindow(): RateWindow {
  return { startedAt: Date.now(), frames: 0, bytes: 0 };
}

function allowRate(window: RateWindow, bytes: number): boolean {
  const now = Date.now();
  if (now - window.startedAt >= 1000) {
    window.startedAt = now;
    window.frames = 0;
    window.bytes = 0;
  }
  window.frames += 1;
  window.bytes += bytes;
  return window.frames <= MAX_FRAMES_PER_SECOND && window.bytes <= MAX_BYTES_PER_SECOND;
}
