/** token 生成与哈希。服务器只持久化 hash，从不存明文；按 hash 索引查找，比较的是 sha256 摘要不泄露原值。 */
import { randomBytes, createHash } from "node:crypto";

export function genToken(prefix: string): string {
  return `${prefix}_${randomBytes(24).toString("base64url")}`;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
