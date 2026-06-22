#!/usr/bin/env node
// 生成 ed25519 发布签名密钥对（一次性，发布者本机跑）。
//   私钥（PKCS8 PEM）→ 设为 GitHub secret WORKER_SIGNING_KEY（CI 用它签 worker 产物）。
//   公钥（hex）     → 写入 crates/supervisor/release-pubkey.hex 并提交（supervisor 验签用；公钥非密）。
// supervisor 验签防"中心服务器被攻破→推恶意产物"；私钥只在 CI secret，绝不进仓库。
import crypto from "node:crypto";

const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const privPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString().trim();
const pubHex = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url").toString("hex");

console.log("=== 私钥（PKCS8 PEM）→ GitHub secret WORKER_SIGNING_KEY（整段，含 BEGIN/END） ===\n");
console.log(privPem);
console.log("\n=== 公钥（hex）→ 覆盖 crates/supervisor/release-pubkey.hex 并提交 ===\n");
console.log(pubHex);
