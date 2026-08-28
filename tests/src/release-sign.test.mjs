import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  supervisorReleaseStatement,
  workerReleaseStatement,
} from "../../scripts/release-statement.mjs";
import {
  MAX_RELEASE_ARTIFACT_BYTES,
  compareReleaseVersions,
  createReleasePublicKey,
  installStagedPair,
  parseReleaseManifestEntry,
  verifyReleaseArtifact,
} from "../../packages/cli/release-trust.mjs";

const ROOT = resolve(import.meta.dirname, "..", "..");

test("release-sign 为 worker/supervisor 产生相互隔离且绑定元数据的 release statement", () => {
  const dir = mkdtempSync(join(tmpdir(), "coflux-release-sign-"));
  try {
    const target = "aarch64-unknown-linux-musl";
    const workerName = `coflux-worker-${target}`;
    const supervisorName = `coflux-supervisor-${target}`;
    const workerArtifact = Buffer.from("deterministic worker artifact\n", "utf8");
    const supervisorArtifact = Buffer.from("deterministic supervisor artifact\n", "utf8");
    writeFileSync(join(dir, workerName), workerArtifact);
    writeFileSync(join(dir, supervisorName), supervisorArtifact);
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const pem = privateKey.export({ format: "pem", type: "pkcs8" });

    execFileSync(process.execPath, [join(ROOT, "scripts/release-sign.mjs"), dir, "v2.3.4-rc.1"], {
      cwd: ROOT,
      env: {
        ...process.env,
        GITHUB_REPOSITORY: "acme/coflux",
        WORKER_SIGNING_KEY: pem,
      },
      stdio: "pipe",
    });

    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    const entry = manifest.worker[target];
    const supervisorEntry = manifest.supervisor[target];
    assert.equal(manifest.schemaVersion, 2);
    assert.equal(manifest.version, "v2.3.4-rc.1");
    assert.equal(entry.target, target);
    assert.equal(entry.size, workerArtifact.byteLength);
    assert.equal(entry.sha256, crypto.createHash("sha256").update(workerArtifact).digest("hex"));
    assert.equal(entry.signature, readFileSync(join(dir, `${workerName}.sig`), "utf8"));
    assert.equal(entry.releaseSignature, readFileSync(join(dir, `${workerName}.release.sig`), "utf8"));
    assert.equal(crypto.verify(null, workerArtifact, publicKey, Buffer.from(entry.signature, "hex")), true);

    assert.equal(supervisorEntry.target, target);
    assert.equal(supervisorEntry.size, supervisorArtifact.byteLength);
    assert.equal(
      supervisorEntry.sha256,
      crypto.createHash("sha256").update(supervisorArtifact).digest("hex"),
    );
    assert.equal(
      supervisorEntry.releaseSignature,
      readFileSync(join(dir, `${supervisorName}.release.sig`), "utf8"),
    );

    const statement = workerReleaseStatement({
      version: manifest.version,
      target: entry.target,
      sha256: entry.sha256,
      size: entry.size,
    });
    const releaseSignature = Buffer.from(entry.releaseSignature, "hex");
    assert.equal(crypto.verify(null, statement, publicKey, releaseSignature), true);
    const supervisorSignature = Buffer.from(supervisorEntry.releaseSignature, "hex");
    assert.equal(
      crypto.verify(
        null,
        supervisorReleaseStatement({
          version: manifest.version,
          target,
          sha256: supervisorEntry.sha256,
          size: supervisorEntry.size,
        }),
        publicKey,
        supervisorSignature,
      ),
      true,
    );

    // component domain 是信任边界：即使把 metadata 调成 worker 的值，也不能把 worker
    // release signature 横向移植为 supervisor 签名。
    assert.equal(
      crypto.verify(
        null,
        supervisorReleaseStatement({
          version: manifest.version,
          target,
          sha256: entry.sha256,
          size: entry.size,
        }),
        publicKey,
        releaseSignature,
      ),
      false,
    );

    for (const mutated of [
      { version: "v2.3.5", target, sha256: entry.sha256, size: entry.size },
      { version: manifest.version, target: "x86_64-unknown-linux-musl", sha256: entry.sha256, size: entry.size },
      { version: manifest.version, target, sha256: "00".repeat(32), size: entry.size },
      { version: manifest.version, target, sha256: entry.sha256, size: entry.size + 1 },
    ]) {
      assert.equal(
        crypto.verify(null, workerReleaseStatement(mutated), publicKey, releaseSignature),
        false,
        `篡改字段应破坏签名: ${JSON.stringify(mutated)}`,
      );
    }

    assert.throws(
      () => workerReleaseStatement({ version: "v2.3.4-01", target, sha256: entry.sha256, size: entry.size }),
      /前导 0/,
      "数字 prerelease 标识符必须与 Rust strict SemVer 一致",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("release-sign 缺少同 target supervisor 时 fail closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "coflux-release-sign-incomplete-"));
  try {
    writeFileSync(join(dir, "coflux-worker-x86_64-unknown-linux-musl"), "worker");
    const { privateKey } = crypto.generateKeyPairSync("ed25519");
    assert.throws(
      () => execFileSync(
        process.execPath,
        [join(ROOT, "scripts/release-sign.mjs"), dir, "v1.0.0"],
        {
          cwd: ROOT,
          env: {
            ...process.env,
            GITHUB_REPOSITORY: "acme/coflux",
            WORKER_SIGNING_KEY: privateKey.export({ format: "pem", type: "pkcs8" }),
          },
          stdio: "pipe",
        },
      ),
      (error) => error?.status === 1 && /target 集合不完整/.test(error?.stderr?.toString() ?? ""),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cofluxd 内置发布公钥与 supervisor 编译期公钥一致", () => {
  const supervisorKey = readFileSync(join(ROOT, "crates/supervisor/release-pubkey.hex"), "utf8").trim();
  const cliKey = readFileSync(join(ROOT, "packages/cli/release-pubkey.hex"), "utf8").trim();
  assert.equal(cliKey, supervisorKey);
  assert.match(cliKey, /^[0-9a-f]{64}$/);
});

test("cofluxd verifier 直接拒绝 bytes/hash/size/version/target/缺字段与跨 component 移植", () => {
  const version = "v3.4.5";
  const target = "x86_64-unknown-linux-musl";
  const data = Buffer.from("verified worker bytes", "utf8");
  const sha256 = crypto.createHash("sha256").update(data).digest("hex");
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyHex = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url").toString("hex");
  const verifierKey = createReleasePublicKey(publicKeyHex);
  const metadata = { version, target, sha256, size: data.byteLength };
  const workerEntry = {
    target,
    sha256,
    size: data.byteLength,
    signature: crypto.sign(null, data, privateKey).toString("hex"),
    releaseSignature: crypto.sign(null, workerReleaseStatement(metadata), privateKey).toString("hex"),
  };
  const manifest = {
    schemaVersion: 2,
    version,
    worker: { [target]: workerEntry },
    supervisor: {
      [target]: {
        target,
        sha256,
        size: data.byteLength,
        releaseSignature: crypto.sign(
          null,
          supervisorReleaseStatement(metadata),
          privateKey,
        ).toString("hex"),
      },
    },
  };

  const parsed = parseReleaseManifestEntry(manifest, "worker", version, target);
  assert.doesNotThrow(() => verifyReleaseArtifact({
    component: "worker",
    version,
    entry: parsed,
    data,
    publicKey: verifierKey,
  }));

  const tampered = Buffer.from(data);
  tampered[0] ^= 1;
  assert.throws(
    () => verifyReleaseArtifact({ component: "worker", version, entry: parsed, data: tampered, publicKey: verifierKey }),
    /sha256 不匹配/,
  );
  assert.throws(
    () => verifyReleaseArtifact({
      component: "worker",
      version,
      entry: { ...parsed, size: parsed.size + 1 },
      data,
      publicKey: verifierKey,
    }),
    /大小不匹配/,
  );
  assert.throws(
    () => verifyReleaseArtifact({
      component: "worker",
      version,
      entry: { ...parsed, sha256: "00".repeat(32) },
      data,
      publicKey: verifierKey,
    }),
    /sha256 不匹配/,
  );
  assert.throws(() => parseReleaseManifestEntry({ ...manifest, version: "v3.4.4" }, "worker", version, target), /schema\/version/);
  assert.throws(
    () => parseReleaseManifestEntry({
      ...manifest,
      worker: { [target]: { ...workerEntry, target: "aarch64-unknown-linux-musl" } },
    }, "worker", version, target),
    /缺少匹配/,
  );
  for (const field of ["sha256", "size", "signature", "releaseSignature"]) {
    const incomplete = { ...workerEntry };
    delete incomplete[field];
    assert.throws(
      () => parseReleaseManifestEntry({ ...manifest, worker: { [target]: incomplete } }, "worker", version, target),
      /元数据非法|缺少 legacy/,
      `缺少 ${field} 必须拒绝`,
    );
  }
  assert.throws(
    () => parseReleaseManifestEntry({
      ...manifest,
      worker: { [target]: { ...workerEntry, size: MAX_RELEASE_ARTIFACT_BYTES + 1 } },
    }, "worker", version, target),
    /元数据非法/,
  );

  const transplantedSupervisor = {
    target,
    sha256,
    size: data.byteLength,
    releaseSignature: crypto.sign(null, workerReleaseStatement(metadata), privateKey).toString("hex"),
  };
  assert.throws(
    () => verifyReleaseArtifact({
      component: "supervisor",
      version,
      entry: transplantedSupervisor,
      data,
      publicKey: verifierKey,
    }),
    /release Ed25519 签名无效/,
  );
});

test("release SemVer floor 比较拒绝降级与同 precedence 的另一 build 身份", () => {
  assert.equal(compareReleaseVersions("v2.0.0", "v1.9.9"), 1);
  assert.equal(compareReleaseVersions("v2.0.0-rc.2", "v2.0.0-rc.10"), -1);
  assert.equal(compareReleaseVersions("v2.0.0", "v2.0.0-rc.10"), 1);
  assert.equal(compareReleaseVersions("v2.0.0+build.2", "v2.0.0+build.1"), 0);
});

test("staged pair 第二项替换失败时恢复第一项旧版本", () => {
  const dir = mkdtempSync(join(tmpdir(), "coflux-install-rollback-"));
  try {
    const oldSupervisor = join(dir, "coflux-supervisor");
    const oldWorker = join(dir, "coflux-worker");
    const stagedSupervisor = join(dir, "new-supervisor");
    const missingWorker = join(dir, "missing-worker");
    writeFileSync(oldSupervisor, "old supervisor");
    writeFileSync(oldWorker, "old worker");
    writeFileSync(stagedSupervisor, "new supervisor");
    assert.throws(() => installStagedPair([
      { source: stagedSupervisor, destination: oldSupervisor },
      { source: missingWorker, destination: oldWorker },
    ]));
    assert.equal(readFileSync(oldSupervisor, "utf8"), "old supervisor");
    assert.equal(readFileSync(oldWorker, "utf8"), "old worker");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
