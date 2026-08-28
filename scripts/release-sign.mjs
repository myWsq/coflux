#!/usr/bin/env node
// 发版签名 + 清单：对目录里的 daemon 产物产生：
//   1) <name>.sig：对原始二进制的 legacy 签名，供已部署旧 supervisor 滚动兼容；
//   2) worker/supervisor 各自 domain-separated 的 <name>.release.sig，绑定
//      component/version/target/sha256/size，供热升级与 cofluxd 安装验真。
// manifest.json 保留原 worker 字段并新增 supervisor；老 server/supervisor 忽略新增字段。
//   用法: WORKER_SIGNING_KEY=<PKCS8 PEM> GITHUB_REPOSITORY=owner/repo node scripts/release-sign.mjs <dir> <version>
import crypto from "node:crypto";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  assertReleaseVersion,
  supervisorReleaseStatement,
  workerReleaseStatement,
} from "./release-statement.mjs";

const dir = process.argv[2];
const version = process.argv[3];
const repo = process.env.GITHUB_REPOSITORY;
if (!dir || !version || !repo) {
  console.error("用法: WORKER_SIGNING_KEY=... GITHUB_REPOSITORY=owner/repo node scripts/release-sign.mjs <dir> <version>");
  process.exit(1);
}
const pem = process.env.WORKER_SIGNING_KEY;
if (!pem) {
  console.error("缺少 WORKER_SIGNING_KEY（PKCS8 PEM）—— 发版前先配好签名密钥（见 docs/RELEASING.md）");
  process.exit(1);
}
const key = crypto.createPrivateKey(pem);
assertReleaseVersion(version);

const manifest = { schemaVersion: 2, version, worker: {}, supervisor: {} };
const sums = [];
const targetsByComponent = { worker: new Set(), supervisor: new Set() };
// 只取原始 worker 二进制（coflux-worker-<target>，target 不含点；排除 .sig/.tar.gz）
for (const name of readdirSync(dir)) {
  if (!name.startsWith("coflux-worker-") || name.includes(".")) continue;
  const target = name.slice("coflux-worker-".length);
  const data = readFileSync(join(dir, name));
  const sha256 = crypto.createHash("sha256").update(data).digest("hex");
  const size = data.byteLength;
  const signature = crypto.sign(null, data, key).toString("hex");
  const releaseSignature = crypto.sign(
    null,
    workerReleaseStatement({ version, target, sha256, size }),
    key,
  ).toString("hex");
  writeFileSync(join(dir, `${name}.sig`), signature);
  writeFileSync(join(dir, `${name}.release.sig`), releaseSignature);
  sums.push(`${sha256}  ${name}`);
  manifest.worker[target] = {
    url: `https://github.com/${repo}/releases/download/${version}/${name}`,
    target,
    sha256,
    size,
    signature,
    releaseSignature,
  };
  targetsByComponent.worker.add(target);
}

// cofluxd 首次安装/显式 update 会直接执行 supervisor，因此它必须有独立 domain 的
// release statement，不能复用 worker 签名（否则合法 worker 可被改名移植）。
for (const name of readdirSync(dir)) {
  if (!name.startsWith("coflux-supervisor-") || name.includes(".")) continue;
  const target = name.slice("coflux-supervisor-".length);
  const data = readFileSync(join(dir, name));
  const sha256 = crypto.createHash("sha256").update(data).digest("hex");
  const size = data.byteLength;
  const releaseSignature = crypto.sign(
    null,
    supervisorReleaseStatement({ version, target, sha256, size }),
    key,
  ).toString("hex");
  writeFileSync(join(dir, `${name}.release.sig`), releaseSignature);
  sums.push(`${sha256}  ${name}`);
  manifest.supervisor[target] = {
    url: `https://github.com/${repo}/releases/download/${version}/${name}`,
    target,
    sha256,
    size,
    releaseSignature,
  };
  targetsByComponent.supervisor.add(target);
}

const workerTargets = [...targetsByComponent.worker].sort();
const supervisorTargets = [...targetsByComponent.supervisor].sort();
if (
  workerTargets.length === 0 ||
  supervisorTargets.length === 0 ||
  workerTargets.join("\n") !== supervisorTargets.join("\n")
) {
  console.error(
    `worker/supervisor target 集合不完整：worker=${workerTargets.join(",") || "<空>"}；` +
    `supervisor=${supervisorTargets.join(",") || "<空>"}`,
  );
  process.exit(1);
}
// relay 产物（plan 043，仅 linux 矩阵）：不签名（人工 ssh 部署，不走自动下载验签），但进 SHA256SUMS 供部署校验。
for (const name of readdirSync(dir)) {
  if (!name.startsWith("coflux-relay-") || name.includes(".")) continue;
  const sha256 = crypto.createHash("sha256").update(readFileSync(join(dir, name))).digest("hex");
  sums.push(`${sha256}  ${name}`);
}
writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
writeFileSync(join(dir, "SHA256SUMS"), sums.join("\n") + "\n");
console.error(
  `已签名 ${workerTargets.length} 组 worker/supervisor 产物，写出 manifest.json / SHA256SUMS`,
);
