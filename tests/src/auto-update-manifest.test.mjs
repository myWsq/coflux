import { test } from "node:test";
import assert from "node:assert/strict";

// auto-update.ts 只需读取 config；测试显式进入开发配置，避免依赖调用者机器上的生产秘密。
process.env.COFLUX_DEV = "1";
const { parseManifestWorkers } = await import("../../apps/server/src/auto-update.ts");

const TARGET = "aarch64-apple-darwin";
const LEGACY_SIGNATURE = "11".repeat(64);

function validManifest(version = "v1.2.3") {
  return {
    schemaVersion: 2,
    version,
    worker: {
      [TARGET]: {
        url: "https://example.invalid/coflux-worker",
        target: TARGET,
        sha256: "00".repeat(32),
        size: 42,
        signature: LEGACY_SIGNATURE,
        releaseSignature: "22".repeat(64),
      },
    },
  };
}

function withoutWorkerField(field) {
  const manifest = validManifest();
  delete manifest.worker[TARGET][field];
  return manifest;
}

test("auto-update manifest v2 保留旧 supervisor 所需的 legacy signature", () => {
  const workers = parseManifestWorkers(validManifest(), "v1.2.3");
  assert.equal(workers?.[TARGET]?.signature, LEGACY_SIGNATURE);
});

test("auto-update 拒绝非规范数字 prerelease、schema 漂移、字段缺失与版本不一致", () => {
  const cases = [
    ["数字 prerelease 前导零", validManifest("v1.2.3-01"), "v1.2.3-01"],
    ["分段数字 prerelease 前导零", validManifest("v1.2.3-rc.01"), "v1.2.3-rc.01"],
    ["缺少 schemaVersion", { ...validManifest(), schemaVersion: undefined }, "v1.2.3"],
    ["旧 schemaVersion", { ...validManifest(), schemaVersion: 1 }, "v1.2.3"],
    ["缺少下载 URL", withoutWorkerField("url"), "v1.2.3"],
    ["缺少 target", withoutWorkerField("target"), "v1.2.3"],
    ["缺少 sha256", withoutWorkerField("sha256"), "v1.2.3"],
    ["缺少 artifact size", withoutWorkerField("size"), "v1.2.3"],
    ["缺少 legacy signature", withoutWorkerField("signature"), "v1.2.3"],
    ["缺少 releaseSignature", withoutWorkerField("releaseSignature"), "v1.2.3"],
    ["manifest version 与 release tag 不一致", validManifest("v1.2.4"), "v1.2.3"],
  ];

  for (const [name, manifest, tag] of cases) {
    assert.equal(parseManifestWorkers(manifest, tag), undefined, name);
  }
});
