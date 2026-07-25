import {
  DEVICE_PROTOCOL_VERSION,
  type LocalGatewayDescriptor,
  type LocalGatewayHello,
} from "@coflux/protocol";

const IDENTITY_KEY = "browser-profile";
const DATABASE_VERSION = 1;
const IDENTITY_STORE = "identity";
const GRANT_STORE = "grants";
const GATEWAY_DOMAIN = "coflux-local-gateway-v1";
const CLIENT_DOMAIN = "coflux-local-client-v1";

interface PersistedIdentity {
  version: 1;
  privateKey: CryptoKey;
  publicKeySec1: ArrayBuffer;
  createdAt: number;
}

interface PersistedGrant {
  daemonId: string;
  grantId: string;
  protocolVersion: number;
  port: number;
  gatewayPublicKeySec1: ArrayBuffer;
  updatedAt: number;
}

export interface BrowserIdentity {
  privateKey: CryptoKey;
  publicKeySec1: Uint8Array<ArrayBuffer>;
}

export interface CachedLocalGrant {
  daemonId: string;
  grantId: string;
  gateway: LocalGatewayDescriptor;
  updatedAt: number;
}

/**
 * browser profile identity 的唯一持久化入口。
 *
 * private CryptoKey 以 extractable=false 生成并由 IndexedDB structured clone 保存；代码从不
 * 导出 PKCS#8/JWK，也不把它放 localStorage。并发 tab 首次创建时用 object-store.add 的主键
 * 冲突裁决唯一 winner，loser 重新读取，避免两个 tab 各拿一把只存在于内存的 profile key。
 */
export class BrowserIdentityStore {
  private databasePromise: Promise<IDBDatabase> | undefined;
  private identityPromise: Promise<BrowserIdentity> | undefined;

  constructor(private readonly databaseName: string) {}

  async identity(): Promise<BrowserIdentity> {
    this.identityPromise ??= this.loadOrCreateIdentity();
    return this.identityPromise;
  }

  async grant(daemonId: string): Promise<CachedLocalGrant | undefined> {
    const database = await this.database();
    const record = await readRequest<PersistedGrant | undefined>(database.transaction(GRANT_STORE).objectStore(GRANT_STORE).get(daemonId));
    if (
      !record ||
      record.daemonId !== daemonId ||
      !record.grantId ||
      record.protocolVersion !== DEVICE_PROTOCOL_VERSION ||
      !Number.isInteger(record.port) ||
      record.port <= 0 ||
      record.port >= 65_536
    ) return undefined;
    const publicKeySec1 = new Uint8Array(record.gatewayPublicKeySec1.slice(0));
    if (publicKeySec1.byteLength !== 65 || publicKeySec1[0] !== 4) return undefined;
    return {
      daemonId,
      grantId: record.grantId,
      gateway: {
        $typeName: "coflux.v1.LocalGatewayDescriptor",
        protocolVersion: record.protocolVersion,
        port: record.port,
        publicKeySec1,
      },
      updatedAt: record.updatedAt,
    };
  }

  async saveGrant(daemonId: string, grantId: string, gateway: LocalGatewayDescriptor): Promise<CachedLocalGrant> {
    const publicKeySec1 = copyArrayBuffer(gateway.publicKeySec1);
    const record: PersistedGrant = {
      daemonId,
      grantId,
      protocolVersion: gateway.protocolVersion,
      port: gateway.port,
      gatewayPublicKeySec1: publicKeySec1,
      updatedAt: Date.now(),
    };
    const database = await this.database();
    const transaction = database.transaction(GRANT_STORE, "readwrite");
    transaction.objectStore(GRANT_STORE).put(record);
    await transactionDone(transaction);
    return {
      daemonId,
      grantId,
      gateway: {
        $typeName: "coflux.v1.LocalGatewayDescriptor",
        protocolVersion: record.protocolVersion,
        port: record.port,
        publicKeySec1: new Uint8Array(publicKeySec1.slice(0)),
      },
      updatedAt: record.updatedAt,
    };
  }

  async removeGrant(daemonId: string): Promise<void> {
    const database = await this.database();
    const transaction = database.transaction(GRANT_STORE, "readwrite");
    transaction.objectStore(GRANT_STORE).delete(daemonId);
    await transactionDone(transaction);
  }

  async clearGrants(): Promise<void> {
    const database = await this.database();
    const transaction = database.transaction(GRANT_STORE, "readwrite");
    transaction.objectStore(GRANT_STORE).clear();
    await transactionDone(transaction);
  }

  close(): void {
    void this.databasePromise?.then((database) => database.close());
    this.databasePromise = undefined;
    this.identityPromise = undefined;
  }

  private async loadOrCreateIdentity(): Promise<BrowserIdentity> {
    ensureCryptoSupport();
    const database = await this.database();
    const existing = await this.readIdentity(database);
    if (existing) return existing;

    const pair = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign", "verify"],
    );
    const publicKeySec1 = await crypto.subtle.exportKey("raw", pair.publicKey);
    if (publicKeySec1.byteLength !== 65 || new Uint8Array(publicKeySec1)[0] !== 4) {
      throw new Error("browser P-256 public key 不是 uncompressed SEC1");
    }
    const record: PersistedIdentity = {
      version: 1,
      privateKey: pair.privateKey,
      publicKeySec1,
      createdAt: Date.now(),
    };

    try {
      const transaction = database.transaction(IDENTITY_STORE, "readwrite");
      transaction.objectStore(IDENTITY_STORE).add(record, IDENTITY_KEY);
      await transactionDone(transaction);
    } catch (error) {
      // 另一 tab 可能刚赢得首次创建；只有主键冲突可按 winner 重读，其余（如浏览器拒绝
      // structured-clone non-extractable CryptoKey）必须关闭 direct，不能降级成明文私钥。
      if (!(error instanceof DOMException) || error.name !== "ConstraintError") throw error;
    }

    const persisted = await this.readIdentity(database);
    if (!persisted) throw new Error("browser profile identity 无法持久化");
    // 真正走一次签名，避免某些浏览器能 clone CryptoKey、恢复后却不能使用的假阳性。
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, persisted.privateKey, new Uint8Array([1]));
    return persisted;
  }

  private async readIdentity(database: IDBDatabase): Promise<BrowserIdentity | undefined> {
    const record = await readRequest<PersistedIdentity | undefined>(
      database.transaction(IDENTITY_STORE).objectStore(IDENTITY_STORE).get(IDENTITY_KEY),
    );
    if (
      !record ||
      record.version !== 1 ||
      record.privateKey?.type !== "private" ||
      record.privateKey.extractable ||
      record.privateKey.algorithm.name !== "ECDSA" ||
      !record.privateKey.usages.includes("sign") ||
      record.publicKeySec1.byteLength !== 65 ||
      new Uint8Array(record.publicKeySec1)[0] !== 4
    ) return undefined;
    return {
      privateKey: record.privateKey,
      publicKeySec1: new Uint8Array(record.publicKeySec1.slice(0)),
    };
  }

  private database(): Promise<IDBDatabase> {
    if (!globalThis.indexedDB) return Promise.reject(new Error("当前浏览器不支持 IndexedDB"));
    this.databasePromise ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(this.databaseName, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(IDENTITY_STORE)) database.createObjectStore(IDENTITY_STORE);
        if (!database.objectStoreNames.contains(GRANT_STORE)) database.createObjectStore(GRANT_STORE, { keyPath: "daemonId" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("打开 browser identity database 失败"));
      request.onblocked = () => reject(new Error("browser identity database 升级被其它页面阻塞"));
    });
    return this.databasePromise;
  }
}

export async function verifyGatewayHello(
  hello: LocalGatewayHello,
  expected: { daemonId: string; origin: string; gateway: LocalGatewayDescriptor },
): Promise<boolean> {
  if (
    hello.protocolVersion !== DEVICE_PROTOCOL_VERSION ||
    hello.daemonId !== expected.daemonId ||
    hello.origin !== expected.origin ||
    hello.nonce.byteLength !== 32 ||
    hello.signatureP1363.byteLength !== 64 ||
    !bytesEqual(hello.gatewayPublicKeySec1, expected.gateway.publicKeySec1)
  ) return false;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      copyArrayBuffer(hello.gatewayPublicKeySec1),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    return crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      copyArrayBuffer(hello.signatureP1363),
      gatewayTranscript(hello.protocolVersion, hello.daemonId, hello.origin, hello.nonce),
    );
  } catch {
    return false;
  }
}

export async function signLocalClientTranscript(
  identity: BrowserIdentity,
  fields: {
    daemonId: string;
    origin: string;
    nonce: Uint8Array;
    gatewayPublicKeySec1: Uint8Array;
    grantId: string;
    clientInstanceId: string;
    transportGeneration: bigint;
    leaseId?: string;
  },
): Promise<Uint8Array<ArrayBuffer>> {
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    identity.privateKey,
    clientTranscript(
      DEVICE_PROTOCOL_VERSION,
      fields.daemonId,
      fields.origin,
      fields.nonce,
      fields.gatewayPublicKeySec1,
      fields.grantId,
      identity.publicKeySec1,
      fields.clientInstanceId,
      fields.transportGeneration,
      fields.leaseId,
    ),
  );
  if (signature.byteLength !== 64) throw new Error("browser ECDSA signature 不是 IEEE-P1363 r||s");
  return new Uint8Array(signature);
}

export function gatewayTranscript(protocolVersion: number, daemonId: string, origin: string, nonce: Uint8Array): Uint8Array<ArrayBuffer> {
  return transcript(GATEWAY_DOMAIN, [u32(protocolVersion), utf8(daemonId), utf8(origin), nonce]);
}

export function clientTranscript(
  protocolVersion: number,
  daemonId: string,
  origin: string,
  nonce: Uint8Array,
  gatewayPublicKeySec1: Uint8Array,
  grantId: string,
  browserPublicKeySec1: Uint8Array,
  clientInstanceId: string,
  transportGeneration: bigint,
  leaseId?: string,
): Uint8Array<ArrayBuffer> {
  return transcript(CLIENT_DOMAIN, [
    u32(protocolVersion),
    utf8(daemonId),
    utf8(origin),
    nonce,
    gatewayPublicKeySec1,
    utf8(grantId),
    browserPublicKeySec1,
    utf8(clientInstanceId),
    u64(transportGeneration),
    utf8(leaseId ?? ""),
  ]);
}

function transcript(domain: string, fields: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const domainBytes = utf8(domain);
  const size = domainBytes.byteLength + 1 + fields.reduce((total, field) => total + 4 + field.byteLength, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  output.set(domainBytes, offset);
  offset += domainBytes.byteLength;
  output[offset++] = 0;
  for (const field of fields) {
    new DataView(output.buffer).setUint32(offset, field.byteLength, false);
    offset += 4;
    output.set(field, offset);
    offset += field.byteLength;
  }
  return output;
}

function u32(value: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return bytes;
}

function u64(value: bigint): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, value, false);
  return bytes;
}

function utf8(value: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(value);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let different = 0;
  for (let index = 0; index < left.byteLength; index += 1) different |= left[index]! ^ right[index]!;
  return different === 0;
}

function copyArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function ensureCryptoSupport(): void {
  if (!globalThis.crypto?.subtle) throw new Error("当前浏览器不支持 WebCrypto");
}

function readRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request 失败"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction 失败"));
    transaction.onabort = () => reject(transaction.error ?? new DOMException("IndexedDB transaction aborted", "AbortError"));
  });
}
