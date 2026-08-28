#!/usr/bin/env node
// 生成 ed25519 发布签名密钥对（一次性，发布者本机跑）。
//   私钥（PKCS8 PEM）→ 设为 release-signing environment secret WORKER_SIGNING_KEY。
//   公钥（hex）     → 同步写入 supervisor 与 cofluxd 的 release-pubkey.hex（公钥非密）。
// supervisor 验签把二进制发布权限与中心/下载源权限分离；私钥只在 CI secret，绝不进仓库。
import crypto from "node:crypto";

const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const privPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString().trim();
const pubHex = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url").toString("hex");

console.log("=== 私钥（PKCS8 PEM）→ release-signing environment secret WORKER_SIGNING_KEY（整段，含 BEGIN/END） ===\n");
console.log(privPem);
console.log("\n=== 公钥（hex）→ 同步覆盖 crates/supervisor/release-pubkey.hex 与 packages/cli/release-pubkey.hex ===\n");
console.log(pubHex);
