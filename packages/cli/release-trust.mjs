import crypto from "node:crypto";
import { Buffer } from "node:buffer";
import fs from "node:fs";

export const WORKER_RELEASE_STATEMENT_DOMAIN = Buffer.from(
  "coflux-worker-release-v1\0",
  "utf8",
);
export const SUPERVISOR_RELEASE_STATEMENT_DOMAIN = Buffer.from(
  "coflux-supervisor-release-v1\0",
  "utf8",
);

const STRICT_RELEASE_VERSION = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const SHA256_HEX = /^[0-9a-f]{64}$/i;
const ED25519_SIGNATURE_HEX = /^[0-9a-f]{128}$/i;
const ED25519_PUBLIC_KEY_HEX = /^[0-9a-f]{64}$/i;
export const MAX_RELEASE_ARTIFACT_BYTES = 128 * 1024 * 1024;

function parseReleaseVersion(version) {
  const match = typeof version === "string" ? STRICT_RELEASE_VERSION.exec(version) : null;
  if (!match) throw new Error(`release version 不是带 v 前缀的严格 SemVer: ${JSON.stringify(version)}`);
  const prerelease = match[4]
    ? match[4].split(".").map((identifier) => {
      if (/^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith("0")) {
        throw new Error(`release version 的数字 prerelease 标识符含前导 0: ${JSON.stringify(version)}`);
      }
      return /^\d+$/.test(identifier)
        ? { numeric: true, value: BigInt(identifier) }
        : { numeric: false, value: identifier };
    })
    : [];
  return {
    raw: version,
    core: [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])],
    prerelease,
  };
}

/** 与 Rust semver crate 一致的 release tag 子集：必须带 v，数字标识符禁止前导 0。 */
export function assertReleaseVersion(version) {
  parseReleaseVersion(version);
  return version;
}

/** SemVer precedence；build metadata 不参与比较。 */
export function compareReleaseVersions(leftVersion, rightVersion) {
  const left = parseReleaseVersion(leftVersion);
  const right = parseReleaseVersion(rightVersion);
  for (let index = 0; index < 3; index += 1) {
    if (left.core[index] < right.core[index]) return -1;
    if (left.core[index] > right.core[index]) return 1;
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    if (left.prerelease.length === right.prerelease.length) return 0;
    return left.prerelease.length === 0 ? 1 : -1;
  }
  const common = Math.min(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < common; index += 1) {
    const a = left.prerelease[index];
    const b = right.prerelease[index];
    if (a.numeric && b.numeric) {
      if (a.value < b.value) return -1;
      if (a.value > b.value) return 1;
    } else if (a.numeric !== b.numeric) {
      return a.numeric ? -1 : 1;
    } else {
      if (a.value < b.value) return -1;
      if (a.value > b.value) return 1;
    }
  }
  return Math.sign(left.prerelease.length - right.prerelease.length);
}

function lenPrefixed(value) {
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(bytes.length);
  return [length, bytes];
}

function artifactReleaseStatement(domain, { version, target, sha256, size }) {
  assertReleaseVersion(version);
  if (typeof target !== "string" || !target || Buffer.byteLength(target) > 128) {
    throw new Error("release target 非法");
  }
  if (typeof sha256 !== "string" || !SHA256_HEX.test(sha256)) {
    throw new Error("release sha256 必须是 32 字节 hex");
  }
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_RELEASE_ARTIFACT_BYTES) {
    throw new Error("release size 必须是有效且有界的正整数");
  }
  const sizeBytes = Buffer.allocUnsafe(8);
  sizeBytes.writeBigUInt64BE(BigInt(size));
  return Buffer.concat([
    domain,
    ...lenPrefixed(version),
    ...lenPrefixed(target),
    Buffer.from(sha256, "hex"),
    sizeBytes,
  ]);
}

/** worker 热升级沿用的 v1 transcript；不得改变 domain 或字段顺序。 */
export function workerReleaseStatement(metadata) {
  return artifactReleaseStatement(WORKER_RELEASE_STATEMENT_DOMAIN, metadata);
}

/** supervisor 安装专用 transcript；独立 domain 防止合法 worker 签名被横向移植。 */
export function supervisorReleaseStatement(metadata) {
  return artifactReleaseStatement(SUPERVISOR_RELEASE_STATEMENT_DOMAIN, metadata);
}

export function createReleasePublicKey(publicKeyHex) {
  const normalized = typeof publicKeyHex === "string" ? publicKeyHex.trim() : "";
  if (!ED25519_PUBLIC_KEY_HEX.test(normalized)) {
    throw new Error("发布公钥必须是 32 字节 hex");
  }
  return crypto.createPublicKey({
    format: "jwk",
    key: {
      kty: "OKP",
      crv: "Ed25519",
      x: Buffer.from(normalized, "hex").toString("base64url"),
    },
  });
}

function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * 从 schema 2 manifest 取指定 component/target。额外顶层字段允许滚动扩展；
 * 但参与信任裁决的 version/target/size/hash/signature 全部严格校验。
 */
export function parseReleaseManifestEntry(manifest, component, version, target) {
  assertReleaseVersion(version);
  if (component !== "worker" && component !== "supervisor") {
    throw new Error(`未知 release component: ${JSON.stringify(component)}`);
  }
  if (!isRecord(manifest) || manifest.schemaVersion !== 2 || manifest.version !== version) {
    throw new Error("release manifest schema/version 与请求不一致");
  }
  const entries = manifest[component];
  const entry = isRecord(entries) ? entries[target] : undefined;
  if (!isRecord(entry) || entry.target !== target) {
    throw new Error(`release manifest 缺少匹配的 ${component}/${target}`);
  }
  if (
    typeof entry.sha256 !== "string" ||
    !SHA256_HEX.test(entry.sha256) ||
    !Number.isSafeInteger(entry.size) ||
    entry.size <= 0 ||
    entry.size > MAX_RELEASE_ARTIFACT_BYTES ||
    typeof entry.releaseSignature !== "string" ||
    !ED25519_SIGNATURE_HEX.test(entry.releaseSignature)
  ) {
    throw new Error(`release manifest 的 ${component}/${target} 元数据非法`);
  }
  if (
    component === "worker" &&
    (typeof entry.signature !== "string" || !ED25519_SIGNATURE_HEX.test(entry.signature))
  ) {
    throw new Error(`release manifest 的 worker/${target} 缺少 legacy 签名`);
  }
  return {
    target,
    sha256: entry.sha256.toLowerCase(),
    size: entry.size,
    signature: component === "worker" ? entry.signature.toLowerCase() : undefined,
    releaseSignature: entry.releaseSignature.toLowerCase(),
  };
}

/** 校验实际 bytes 与 manifest 元数据、raw worker 签名及 component-separated release 签名。 */
export function verifyReleaseArtifact({ component, version, entry, data, publicKey }) {
  if (!Buffer.isBuffer(data)) throw new Error("release 产物必须是 Buffer");
  if (data.byteLength !== entry.size) {
    throw new Error(`${component} 产物大小不匹配：期望 ${entry.size}，实际 ${data.byteLength}`);
  }
  const sha256 = crypto.createHash("sha256").update(data).digest("hex");
  if (sha256 !== entry.sha256) {
    throw new Error(`${component} 产物 sha256 不匹配`);
  }
  if (
    component === "worker" &&
    !crypto.verify(null, data, publicKey, Buffer.from(entry.signature, "hex"))
  ) {
    throw new Error("worker 产物 legacy Ed25519 签名无效");
  }
  const metadata = { version, target: entry.target, sha256, size: data.byteLength };
  const statement = component === "worker"
    ? workerReleaseStatement(metadata)
    : supervisorReleaseStatement(metadata);
  if (!crypto.verify(null, statement, publicKey, Buffer.from(entry.releaseSignature, "hex"))) {
    throw new Error(`${component} 产物 release Ed25519 签名无效`);
  }
}

/**
 * 两个已验证/本地显式信任的暂存文件一起进入替换阶段；任一 rename 失败都会恢复旧 pair。
 * 单文件 rename 是原子的，pair 级失败用同文件系统内备份回滚，绝不把“只更新一半”当成功。
 */
export function installStagedPair(staged) {
  if (
    !Array.isArray(staged) ||
    staged.length !== 2 ||
    staged.some(({ source, destination }) =>
      typeof source !== "string" || !source || typeof destination !== "string" || !destination)
  ) {
    throw new Error("daemon 安装必须提供两个合法的暂存文件");
  }
  const installed = [];
  const backups = [];
  try {
    for (const { source, destination } of staged) {
      const backup = `${source}.previous`;
      if (fs.existsSync(destination)) {
        fs.renameSync(destination, backup);
        backups.push({ backup, destination });
      }
      fs.renameSync(source, destination);
      installed.push(destination);
    }
  } catch (error) {
    for (const destination of installed.reverse()) {
      try { fs.rmSync(destination, { force: true }); } catch {}
    }
    const restoreFailures = [];
    for (const { backup, destination } of backups.reverse()) {
      try { fs.renameSync(backup, destination); }
      catch (restoreError) { restoreFailures.push(restoreError); }
    }
    if (restoreFailures.length > 0) {
      throw new AggregateError([error, ...restoreFailures], "daemon 二进制替换失败且旧版本恢复不完整");
    }
    throw error;
  }
}
