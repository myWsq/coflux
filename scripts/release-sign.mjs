#!/usr/bin/env node
// 发版签名 + 清单：对目录里每个 `coflux-worker-<target>` 产物做 ed25519 签名（WORKER_SIGNING_KEY），
// 写出 <name>.sig、SHA256SUMS、manifest.json（含每个 target 的 url/sha256/signature，供 server 下发升级用）。
//   用法: WORKER_SIGNING_KEY=<PKCS8 PEM> GITHUB_REPOSITORY=owner/repo node scripts/release-sign.mjs <dir> <version>
import crypto from "node:crypto";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
const version = process.argv[3];
const repo = process.env.GITHUB_REPOSITORY;
if (!dir || !version || !repo) {
  console.error("用法: WORKER_SIGNING_KEY=... GITHUB_REPOSITORY=owner/repo node scripts/release-sign.mjs <dir> <version>");
  process.exit(1);
}
const pem = process.env.WORKER_SIGNING_KEY;
if (!pem) {
  console.error("缺少 WORKER_SIGNING_KEY（PKCS8 PEM）");
  process.exit(1);
}
const key = crypto.createPrivateKey(pem);

const manifest = { version, worker: {} };
const sums = [];
let n = 0;
// 只取原始 worker 二进制（coflux-worker-<target>，target 不含点；排除 .sig/.tar.gz）
for (const name of readdirSync(dir)) {
  if (!name.startsWith("coflux-worker-") || name.includes(".")) continue;
  const target = name.slice("coflux-worker-".length);
  const data = readFileSync(join(dir, name));
  const sha256 = crypto.createHash("sha256").update(data).digest("hex");
  const signature = crypto.sign(null, data, key).toString("hex");
  writeFileSync(join(dir, `${name}.sig`), signature);
  sums.push(`${sha256}  ${name}`);
  manifest.worker[target] = {
    url: `https://github.com/${repo}/releases/download/${version}/${name}`,
    sha256,
    signature,
  };
  n++;
}
if (n === 0) {
  console.error("未找到 coflux-worker-<target> 产物");
  process.exit(1);
}
writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
writeFileSync(join(dir, "SHA256SUMS"), sums.join("\n") + "\n");
console.error(`已签名 ${n} 个 worker 产物，写出 manifest.json / SHA256SUMS`);
