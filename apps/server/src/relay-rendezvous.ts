/**
 * 独立 relay 的 rendezvous 支撑（plan 043）。
 *
 * relay 数据面已从中心剥离：server 只在 channel 建立时做归属校验，然后给 client/daemon
 * 两端各签一张短时单次 ed25519 token 并拼出完整 relay URL；数据帧走两端与 relay 之间的
 * 专属 WS，不再经过本进程。这里因此没有任何 channel 状态——只有校验、签名与限速。
 *
 * token 线格式：`base64url(claimsJSON) + "." + base64url(signature)`；签名覆盖
 * `"coflux-relay-token-v1" + 0x00 + claimsJSON bytes`（domain 分离，同 local gateway
 * 签名惯例）。relay 侧（crates/relay）持公钥验签，claims 见下方 RelayTokenClaims。
 */
import crypto from "crypto";
import { MAX_FRAME_ID_BYTES } from "@coflux/protocol";

const TOKEN_DOMAIN = Buffer.from("coflux-relay-token-v1", "utf8");
const TOKEN_VERSION = 1;
/** 每条 client 连接的 rendezvous 限速：正常重连/切换远低于此；防的是失控循环。 */
const MAX_RENDEZVOUS_PER_SECOND = 32;
/** raw ed25519 seed → PKCS8 DER 的固定前缀（RFC 8410 结构，Ed25519 OID）。 */
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export interface RelayTokenClaims {
  v: number;
  channelId: string;
  role: "client" | "daemon";
  /** Unix epoch ms（与 proto 各时间戳同单位）。 */
  exp: number;
}

export class RelayTokenSigner {
  private readonly privateKey: crypto.KeyObject;
  /** hex 裸 32B 公钥；经 `COFLUX_RELAY_PUBKEY` 注入 relay 进程（同 worker 验签公钥的惯例）。 */
  readonly publicKeyHex: string;

  constructor(seedHex: string) {
    const seed = Buffer.from(seedHex.trim(), "hex");
    if (seed.length !== 32) throw new Error("relay signing seed 必须是 hex 裸 32 bytes");
    this.privateKey = crypto.createPrivateKey({
      key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
      format: "der",
      type: "pkcs8",
    });
    const jwk = crypto.createPublicKey(this.privateKey).export({ format: "jwk" });
    this.publicKeyHex = Buffer.from(jwk.x!, "base64url").toString("hex");
  }

  sign(channelId: string, role: "client" | "daemon", ttlMs: number): string {
    const claims: RelayTokenClaims = { v: TOKEN_VERSION, channelId, role, exp: Date.now() + ttlMs };
    const payload = Buffer.from(JSON.stringify(claims), "utf8");
    const signature = crypto.sign(null, Buffer.concat([TOKEN_DOMAIN, Buffer.from([0]), payload]), this.privateKey);
    return `${payload.toString("base64url")}.${signature.toString("base64url")}`;
  }
}

/** 拼出某一端的完整拨号 URL；base 形如 `ws://127.0.0.1:8790` 或 `wss://relay.example`。 */
export function buildRelayPipeUrl(base: string, token: string): string {
  return `${base.replace(/\/+$/, "")}/v1/pipe?token=${token}`;
}

/** 一条 channel 的两端必须落在同一节点：优先 daemon 当前 home；尚未上报或 id 已失效时
 * 回退静态清单首项。节点列表为空表示中心没有可用 relay。 */
export function selectRelayNode<T extends { id: string }>(nodes: readonly T[], homeRelayId?: string): T | undefined {
  return (homeRelayId ? nodes.find((node) => node.id === homeRelayId) : undefined) ?? nodes[0];
}

/** 按需拨号（deviceRelayDial）自 v0.13.0 起才被 worker 认识；更老的 worker 收到该 payload 会
 * 静默丢弃，client 于是连上 relay 干等到配对超时——现场表现为"设备在线但怎么都连不上"，
 * 且 server/relay 两侧都只留下一句超时。这里在 rendezvous 前把它拦成一句人话。
 * 非 vX.Y.Z 形态（builtin / 本地 cargo 产物）一律放行：dev 构建不受此门限制。 */
const MIN_RELAY_DIAL_VERSION = [0, 13, 0];
export function supportsRelayDial(workerVersion: string): boolean {
  return atLeastVersion(workerVersion, MIN_RELAY_DIAL_VERSION);
}

/** P2P 信令（deviceP2pDial/ChannelGrant，plan 076）自 v0.26.0 起才被 worker 认识；
 * 同 relay 门：老 worker 静默丢弃未知 payload，client 只会干等到超时后回落 relay。 */
const MIN_P2P_DIAL_VERSION = [0, 26, 0];
export function supportsP2pDial(workerVersion: string): boolean {
  return atLeastVersion(workerVersion, MIN_P2P_DIAL_VERSION);
}

/** 非 vX.Y.Z 形态（builtin / 本地 cargo 产物）一律放行：dev 构建不受版本门限制。 */
function atLeastVersion(workerVersion: string, min: readonly number[]): boolean {
  const parsed = /^v?(\d+)\.(\d+)\.(\d+)/.exec(workerVersion.trim());
  if (!parsed) return true;
  for (let i = 0; i < 3; i++) {
    const got = Number(parsed[i + 1]);
    if (got !== min[i]) return got > min[i];
  }
  return true;
}

/** 与旧 DeviceRelayRouter 相同的 id 校验语义（长度、控制字符、保留前缀在调用方另查）。 */
export function validRelayId(value: string): boolean {
  return value.length > 0 && Buffer.byteLength(value, "utf8") <= MAX_FRAME_ID_BYTES && ![...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
}

interface RateWindow {
  startedAt: number;
  count: number;
}

const rateWindows = new WeakMap<object, RateWindow>();

/** 按连接对象记的简单每秒滑窗；连接关闭随 GC 消失，无需清理钩子。 */
export function allowRendezvous(connection: object): boolean {
  const now = Date.now();
  let window = rateWindows.get(connection);
  if (!window || now - window.startedAt >= 1000) {
    window = { startedAt: now, count: 0 };
    rateWindows.set(connection, window);
  }
  window.count += 1;
  return window.count <= MAX_RENDEZVOUS_PER_SECOND;
}
