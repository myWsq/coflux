/**
 * 口令哈希（password 模式，多账号邮箱+密码认证，见 plans/059）。
 *
 * 用 node:crypto scrypt（stdlib，无额外依赖）+ 随机 salt + timingSafeEqual 定时比较。
 * 存储格式自描述："scrypt:<saltHex>:<hashHex>"，前缀留作未来升级哈希参数时的判别位
 * （旧格式哈希仍可校验，新格式哈希并行存在）。
 */
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);
const KEY_LEN = 64;

/** 生成新哈希（建号/改密码用）。 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = (await scryptAsync(password, salt, KEY_LEN)) as Buffer;
  return `scrypt:${salt.toString("hex")}:${derived.toString("hex")}`;
}

/** 校验口令是否匹配已存哈希；格式不识别/派生失败一律返回 false（不抛出，调用方按认证失败处理）。 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split(":");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const [, saltHex, hashHex] = parts;
  try {
    const salt = Buffer.from(saltHex, "hex");
    const expected = Buffer.from(hashHex, "hex");
    const derived = (await scryptAsync(password, salt, expected.length)) as Buffer;
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}
