#!/usr/bin/env node
/**
 * 管理员建号（COFLUX_AUTH=password 模式，见 plans/059）。
 *
 * password 模式没有注册端点——建号只走这条命令行；能登录成功即视为管理员亲手建的用户，
 * 登录时 server 侧 lazy provision 个人账号（见 apps/server/src/hub.ts resolveAccountForUser）。
 *
 * 用法：
 *   DATABASE_URL=postgres://... node --import tsx scripts/create-user.mjs \
 *     --email a@b.com --password secret [--id <uuid>]
 *
 * 幂等：邮箱已存在则只更新口令哈希（保留原 id/created_at），不新建第二条记录。
 * --id：显式指定 user UUID，仅在邮箱首次创建时生效——生产迁移（见 plans/063）用旧 Supabase
 * user UUID 建号，使既有 memberships.user_id 数据无缝复用；邮箱已存在时忽略 --id（打印警告）。
 */
import { randomUUID } from "node:crypto";
import { Store } from "../apps/server/src/store.ts";
import { hashPassword } from "../apps/server/src/auth.ts";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--email") out.email = argv[++i];
    else if (a === "--password") out.password = argv[++i];
    else if (a === "--id") out.id = argv[++i];
  }
  return out;
}

const { email: rawEmail, password, id } = parseArgs(process.argv.slice(2));
if (!rawEmail || !password) {
  console.error("用法：node --import tsx scripts/create-user.mjs --email <email> --password <password> [--id <uuid>]");
  process.exit(2);
}
const email = rawEmail.trim().toLowerCase();
const databaseUrl = process.env.DATABASE_URL || "postgres://postgres:postgres@127.0.0.1:5432/postgres";

const store = await Store.connect(databaseUrl);
try {
  const existing = await store.getUserByEmail(email);
  if (existing && id && existing.id !== id) {
    console.warn(`[create-user] 邮箱 ${email} 已存在（id=${existing.id}），忽略传入的 --id ${id}`);
  }
  const passwordHash = await hashPassword(password);
  const user = await store.upsertUser({
    id: existing?.id ?? id ?? randomUUID(),
    email,
    passwordHash,
    createdAt: existing?.createdAt ?? Date.now(),
  });
  console.log(`[create-user] ${existing ? "更新" : "创建"}用户 id=${user.id} email=${user.email}`);
} finally {
  await store.close();
}
