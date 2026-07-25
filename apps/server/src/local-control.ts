/**
 * loopback gateway 的中心控制面：只持 browser public key/grant 元数据与短 lease。
 * browser private key 永远不进入本模块、协议或数据库。
 */
import { ECDH, randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import {
  create,
  DEVICE_PROTOCOL_VERSION,
  DeviceScope,
  LocalBrowserGrantSchema,
  OnlineDeviceLeaseSchema,
  type AccountId,
  type DaemonId,
  type LocalBrowserGrant,
  type LocalGatewayDescriptor,
  type LocalGrantAck,
  type LocalLeaseRequest,
  type LocalPairRequest,
  type LocalUnpairRequest,
  type ServerToClientPayload,
  type ServerToDaemonPayload,
} from "@coflux/protocol";
import { config } from "./config.js";
import {
  Store,
  type LocalGrantControlAction,
  type LocalGrantRecord,
  type LocalGrantState,
} from "./store.js";

interface ControlClient {
  ws: WebSocket;
  accountId: AccountId | null;
  tokenHash?: string;
  origin?: string;
}

interface ControlDaemon {
  ws: WebSocket;
  accountId: AccountId;
  info: { daemonId: DaemonId };
}

interface PendingGrantControl<C extends ControlClient> {
  requestId: string;
  grantId: string;
  daemonId: DaemonId;
  action: LocalGrantControlAction;
  client?: C;
  clientRequestId?: string;
  deadline: number;
  timer: ReturnType<typeof setTimeout>;
}

type GatewayData = Pick<LocalGatewayDescriptor, "protocolVersion" | "port" | "publicKeySec1">;

const MAX_ID_BYTES = 256;
const MAX_GRANTS_PER_DAEMON = 256;
const MAX_RETAINED_GRANTS_PER_DAEMON = 1024;
const MAX_ACTIVE_LEASES_PER_DAEMON = 1024;
const CONTROL_RETRY_MS = 1_000;

export class LocalControlPlane<C extends ControlClient, D extends ControlDaemon> {
  private pending = new Map<string, PendingGrantControl<C>>();

  constructor(
    private readonly store: Store,
    private readonly daemonForId: (daemonId: DaemonId) => D | undefined,
    private readonly sendDaemon: (daemon: D, payload: ServerToDaemonPayload) => void,
    private readonly sendClient: (client: C, payload: ServerToClientPayload) => void,
  ) {}

  async announce(daemon: D, gateway: LocalGatewayDescriptor | undefined): Promise<void> {
    if (!gateway || !validGateway(gateway)) return;
    await this.store.upsertLocalGateway(daemon.accountId, daemon.info.daemonId, gateway, Date.now());
    await this.configureOrigins(daemon.info.daemonId);
  }

  /** daemon 每次认证后重装 durable control state；online lease 刻意不恢复。 */
  async restoreDaemon(daemon: D): Promise<void> {
    const now = Date.now();
    await Promise.all([this.store.pruneLocalControlState(now), this.store.revokeLocalLeasesForDaemon(daemon.info.daemonId)]);
    await this.configureOrigins(daemon.info.daemonId);
    for (const grant of await this.store.listLocalGrantsByDaemon(daemon.info.daemonId)) {
      const waiter = [...this.pending.values()].find((pending) => pending.grantId === grant.grantId);
      if (grant.state === "pending_revoke") {
        await this.dispatchGrantControl(grant, "revoke");
      } else if (grant.state === "revoked") {
        await this.dispatchGrantControl(grant, "sync_revoke");
      } else if (grant.state === "active") {
        await this.dispatchGrantControl(grant, "sync_install", waiter?.client, waiter?.clientRequestId);
      } else {
        await this.dispatchGrantControl(grant, "install", waiter?.client, waiter?.clientRequestId);
      }
    }
  }

  async pair(client: C, request: LocalPairRequest): Promise<void> {
    const accountId = client.accountId;
    if (!accountId || !validId(request.requestId) || !validId(request.daemonId)) {
      return void this.pairError(client, request.requestId, "pair request 无效");
    }
    if (!client.origin || request.origin !== client.origin || !validOrigin(request.origin)) {
      return void this.pairError(client, request.requestId, "Origin 与已认证 WebSocket 不匹配");
    }
    if (!validP256PublicKey(request.browserPublicKeySec1)) {
      return void this.pairError(client, request.requestId, "browser public key 无效");
    }

    const device = await this.store.getDevice(request.daemonId);
    if (!device || device.revoked || device.accountId !== accountId) {
      return void this.pairError(client, request.requestId, "设备不存在或不属于本账号");
    }
    const gateway = await this.store.getLocalGateway(request.daemonId);
    if (!gateway || gateway.accountId !== accountId || gateway.protocolVersion !== DEVICE_PROTOCOL_VERSION) {
      return void this.pairError(client, request.requestId, "daemon 尚未上报可用 local gateway");
    }

    const byRequest = await this.store.getLocalGrantByPairRequest(accountId, request.requestId);
    if (byRequest) {
      if (!samePair(byRequest, request)) return void this.pairError(client, request.requestId, "requestId 已被不同 pair payload 使用");
      return void (await this.resumePair(client, request.requestId, byRequest, gateway));
    }

    const matching = await this.store.findMatchingLocalGrant(accountId, request.daemonId, request.origin, request.browserPublicKeySec1);
    if (matching) return void (await this.resumePair(client, request.requestId, matching, gateway));

    await this.store.pruneLocalControlState(Date.now());
    if ((await this.store.countLiveLocalGrants(accountId, request.daemonId)) >= MAX_GRANTS_PER_DAEMON) {
      return void this.pairError(client, request.requestId, "该 daemon 的 browser grant 已达上限");
    }
    if ((await this.store.countRetainedLocalGrants(accountId, request.daemonId)) >= MAX_RETAINED_GRANTS_PER_DAEMON) {
      return void this.pairError(client, request.requestId, "该 daemon 的 grant 撤销记录已达上限，请稍后重试");
    }
    if (!this.daemonForId(request.daemonId)) return void this.pairError(client, request.requestId, "daemon 不在线，无法安装新 grant");

    const now = Date.now();
    const grant = create(LocalBrowserGrantSchema, {
      grantId: randomUUID(),
      accountId,
      daemonId: request.daemonId,
      origin: request.origin,
      publicKeySec1: request.browserPublicKeySec1,
      offlineScopes: [DeviceScope.SESSION_READ, DeviceScope.SESSION_CONTROL],
      createdAt: now,
    });
    const created = await this.store.createLocalGrant(grant, client.tokenHash ?? null, request.requestId);
    if (!created) {
      const raced = await this.store.getLocalGrantByPairRequest(accountId, request.requestId);
      if (!raced || !samePair(raced, request)) return void this.pairError(client, request.requestId, "pair request 冲突");
      return void (await this.resumePair(client, request.requestId, raced, gateway));
    }
    await this.configureOrigins(request.daemonId);
    await this.dispatchGrantControl(created, "install", client, request.requestId);
  }

  async lease(client: C, request: LocalLeaseRequest): Promise<void> {
    const fail = (error: string) =>
      this.sendClient(client, { case: "localLeaseResult", value: { requestId: request.requestId, ok: false, error } });
    const accountId = client.accountId;
    if (!accountId || !validId(request.requestId) || !validId(request.daemonId) || !validId(request.grantId)) return void fail("lease request 无效");
    const daemon = this.daemonForId(request.daemonId);
    if (!daemon || daemon.accountId !== accountId) return void fail("daemon 不在线或不属于本账号");
    let grant = await this.store.getLocalGrant(request.grantId);
    if (!grant || grant.accountId !== accountId || grant.daemonId !== request.daemonId || grant.state !== "active") {
      return void fail("grant 不存在、未安装或已撤销");
    }
    if (client.tokenHash && grant.clientTokenHash !== client.tokenHash) {
      grant = await this.store.bindLocalGrantToClientToken(grant.grantId, accountId, client.tokenHash);
      if (!grant) return void fail("grant 已撤销");
    }

    const now = Date.now();
    await this.store.pruneLocalControlState(now);
    if ((await this.store.countActiveLocalLeases(accountId, request.daemonId, now)) >= MAX_ACTIVE_LEASES_PER_DAEMON) {
      return void fail("daemon online lease 数已达上限");
    }
    const lease = create(OnlineDeviceLeaseSchema, {
      leaseId: randomUUID(),
      grantId: grant.grantId,
      accountId,
      daemonId: grant.daemonId,
      scopes: [DeviceScope.RPC, DeviceScope.LIFECYCLE],
      expiresAt: now + config.localLeaseTtlMs,
    });
    await this.store.createLocalLease(lease, client.tokenHash ?? null, now);
    this.sendDaemon(daemon, { case: "localLeaseInstall", value: { lease } });
    this.sendClient(client, { case: "localLeaseResult", value: { requestId: request.requestId, ok: true, lease } });
  }

  async unpair(client: C, request: LocalUnpairRequest): Promise<void> {
    const fail = (error: string) =>
      this.sendClient(client, { case: "localUnpairResult", value: { requestId: request.requestId, ok: false, error } });
    const accountId = client.accountId;
    if (!accountId || !validId(request.requestId) || !validId(request.daemonId) || !validId(request.grantId)) return void fail("unpair request 无效");
    const grant = await this.store.getLocalGrant(request.grantId);
    if (!grant || grant.accountId !== accountId || grant.daemonId !== request.daemonId) return void fail("grant 不存在或不属于本账号");
    if (grant.state !== "revoked") await this.revokeGrant(grant);
    this.sendClient(client, { case: "localUnpairResult", value: { requestId: request.requestId, ok: true } });
  }

  async grantAck(daemon: D, ack: LocalGrantAck): Promise<void> {
    const pending = this.pending.get(ack.requestId);
    const updated = await this.store.applyLocalGrantAck(
      ack.requestId,
      ack.grantId,
      daemon.info.daemonId,
      ack.ok,
      ack.error ?? null,
      Date.now(),
    );
    if (!updated || updated.daemonId !== daemon.info.daemonId || updated.accountId !== daemon.accountId) return;
    if (pending) this.clearPending(pending.requestId);
    await this.configureOrigins(updated.daemonId);

    if (pending?.client && pending.clientRequestId && (pending.action === "install" || pending.action === "sync_install")) {
      if (!ack.ok) return void this.pairError(pending.client, pending.clientRequestId, ack.error ?? "daemon 拒绝安装 grant");
      const gateway = await this.store.getLocalGateway(updated.daemonId);
      if (!gateway || gateway.accountId !== updated.accountId) return void this.pairError(pending.client, pending.clientRequestId, "gateway descriptor 已失效");
      this.pairOk(pending.client, pending.clientRequestId, updated.grantId, gateway);
    }
  }

  async logout(client: C): Promise<void> {
    if (!client.accountId || !client.tokenHash) return;
    for (const grant of await this.store.listLocalGrantsByClientToken(client.accountId, client.tokenHash)) await this.revokeGrant(grant);
  }

  async revokeDevice(daemonId: DaemonId): Promise<void> {
    const grants = await this.store.listLocalGrantsByDaemon(daemonId);
    const daemon = this.daemonForId(daemonId);
    if (daemon) this.sendDaemon(daemon, { case: "localGatewayConfigure", value: { origins: [] } });
    for (const grant of grants) if (grant.state !== "revoked") await this.revokeGrant(grant, false);
    await this.store.revokeLocalLeasesForDaemon(daemonId);
  }

  async daemonDisconnected(daemonId: DaemonId): Promise<void> {
    await this.store.revokeLocalLeasesForDaemon(daemonId);
    for (const pending of [...this.pending.values()]) {
      if (pending.daemonId !== daemonId) continue;
      if (pending.client && pending.clientRequestId) this.pairError(pending.client, pending.clientRequestId, "daemon 掉线，grant 将在重连后继续安装");
      this.clearPending(pending.requestId);
    }
  }

  shutdown(): void {
    for (const pending of this.pending.values()) clearTimeout(pending.timer);
    this.pending.clear();
  }

  private async resumePair(client: C, clientRequestId: string, grant: LocalGrantRecord, gateway: GatewayData): Promise<void> {
    if (client.accountId && client.tokenHash && grant.clientTokenHash !== client.tokenHash) {
      const rebound = await this.store.bindLocalGrantToClientToken(grant.grantId, client.accountId, client.tokenHash);
      if (!rebound) return void this.pairError(client, clientRequestId, "grant 已撤销");
      grant = rebound;
    }
    if (grant.state === "active") return void this.pairOk(client, clientRequestId, grant.grantId, gateway);
    if (grant.state === "pending_revoke" || grant.state === "revoked") return void this.pairError(client, clientRequestId, "grant 已撤销");
    if (!this.daemonForId(grant.daemonId)) return void this.pairError(client, clientRequestId, "daemon 不在线，grant 将在重连后安装");
    await this.dispatchGrantControl(grant, "install", client, clientRequestId);
  }

  private async revokeGrant(grant: LocalGrantRecord, reconfigure = true): Promise<void> {
    await this.store.revokeLocalLeasesForGrant(grant.grantId);
    const daemon = this.daemonForId(grant.daemonId);
    if (daemon) {
      await this.dispatchGrantControl(grant, "revoke");
    } else {
      await this.store.beginLocalGrantControl(grant.grantId, "pending_revoke", randomUUID(), "revoke", Date.now());
    }
    if (reconfigure) await this.configureOrigins(grant.daemonId);
  }

  private async dispatchGrantControl(
    grant: LocalGrantRecord,
    action: LocalGrantControlAction,
    client?: C,
    clientRequestId?: string,
  ): Promise<void> {
    const daemon = this.daemonForId(grant.daemonId);
    if (!daemon) return;
    const displaced = [...this.pending.values()].find((pending) => pending.grantId === grant.grantId);
    if (
      displaced?.client &&
      displaced.clientRequestId &&
      (displaced.client !== client || displaced.clientRequestId !== clientRequestId)
    ) {
      this.pairError(displaced.client, displaced.clientRequestId, "grant 安装已由另一连接接续，请重试");
    }
    this.clearPendingForGrant(grant.grantId);
    const requestId = randomUUID();
    const state = stateDuringControl(grant.state, action);
    const updated = await this.store.beginLocalGrantControl(grant.grantId, state, requestId, action, Date.now());
    if (!updated) return;
    const pending: PendingGrantControl<C> = {
      requestId,
      grantId: grant.grantId,
      daemonId: grant.daemonId,
      action,
      client,
      clientRequestId,
      deadline: Date.now() + config.pendingTimeoutMs,
      timer: setTimeout(() => void this.retryControl(requestId), CONTROL_RETRY_MS),
    };
    pending.timer.unref?.();
    this.pending.set(requestId, pending);
    this.sendGrantControl(daemon, updated, requestId, action);
  }

  private async retryControl(requestId: string): Promise<void> {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    const grant = await this.store.getLocalGrant(pending.grantId);
    if (!grant || grant.controlRequestId !== requestId) return void this.clearPending(requestId);
    if (Date.now() >= pending.deadline) {
      if (pending.client && pending.clientRequestId) this.pairError(pending.client, pending.clientRequestId, "daemon grant 安装确认超时，可安全重试");
      this.clearPending(requestId);
      return;
    }
    const daemon = this.daemonForId(pending.daemonId);
    if (!daemon) return void this.clearPending(requestId);
    this.sendGrantControl(daemon, grant, requestId, pending.action);
    pending.timer = setTimeout(() => void this.retryControl(requestId), CONTROL_RETRY_MS);
    pending.timer.unref?.();
  }

  private sendGrantControl(daemon: D, grant: LocalGrantRecord, requestId: string, action: LocalGrantControlAction): void {
    if (action === "revoke" || action === "sync_revoke") {
      this.sendDaemon(daemon, { case: "localGrantRevoke", value: { requestId, grantId: grant.grantId } });
      return;
    }
    this.sendDaemon(daemon, { case: "localGrantInstall", value: { requestId, grant: recordToGrant(grant) } });
  }

  private async configureOrigins(daemonId: DaemonId): Promise<void> {
    const daemon = this.daemonForId(daemonId);
    if (!daemon) return;
    const grants = await this.store.listLocalGrantsByDaemon(daemonId);
    const origins = [...new Set(grants.filter((grant) => !["pending_revoke", "revoked"].includes(grant.state)).map((grant) => grant.origin))].sort();
    this.sendDaemon(daemon, { case: "localGatewayConfigure", value: { origins } });
  }

  private pairOk(client: C, requestId: string, grantId: string, gateway: GatewayData): void {
    this.sendClient(client, { case: "localPairResult", value: { requestId, ok: true, grantId, gateway } });
  }

  private pairError(client: C, requestId: string, error: string): void {
    this.sendClient(client, { case: "localPairResult", value: { requestId, ok: false, error } });
  }

  private clearPending(requestId: string): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(requestId);
  }

  private clearPendingForGrant(grantId: string): void {
    for (const pending of [...this.pending.values()]) if (pending.grantId === grantId) this.clearPending(pending.requestId);
  }
}

function stateDuringControl(state: LocalGrantState, action: LocalGrantControlAction): LocalGrantState {
  if (action === "revoke") return "pending_revoke";
  if (action === "sync_revoke") return state === "revoked" ? "revoked" : "pending_revoke";
  if (action === "sync_install" && state === "active") return "active";
  return "pending_install";
}

function recordToGrant(record: LocalGrantRecord): LocalBrowserGrant {
  return create(LocalBrowserGrantSchema, {
    grantId: record.grantId,
    accountId: record.accountId,
    daemonId: record.daemonId,
    origin: record.origin,
    publicKeySec1: record.publicKeySec1,
    offlineScopes: record.offlineScopes,
    createdAt: record.createdAt,
  });
}

function samePair(grant: LocalGrantRecord, request: LocalPairRequest): boolean {
  return grant.daemonId === request.daemonId && grant.origin === request.origin && bytesEqual(grant.publicKeySec1, request.browserPublicKeySec1);
}

function validGateway(gateway: LocalGatewayDescriptor): boolean {
  return gateway.protocolVersion === DEVICE_PROTOCOL_VERSION && Number.isInteger(gateway.port) && gateway.port > 0 && gateway.port < 65536 && validP256PublicKey(gateway.publicKeySec1);
}

function validP256PublicKey(bytes: Uint8Array): boolean {
  if (bytes.byteLength !== 65 || bytes[0] !== 4) return false;
  try {
    ECDH.convertKey(bytes, "prime256v1", undefined, undefined, "uncompressed");
    return true;
  } catch {
    return false;
  }
}

function validOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.origin === origin && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

function validId(value: string): boolean {
  return value.length > 0 && Buffer.byteLength(value, "utf8") <= MAX_ID_BYTES && ![...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && a.every((byte, index) => byte === b[index]);
}
