/**
 * Store 插件（RavenJS runtime assembly）：连接 Postgres 并完成启动引导。
 * Store 是 Raven 运行时该管生命周期的基础设施依赖，故上 AppState；领域模块（hub/proxy）
 * 与传输层仍以实例引用消费，不感知 Raven。
 */
import { defineAppState, definePlugin, type Raven, type StateSetter } from "@raven.js/core";
import { createLogger } from "@coflux/core";
import { config } from "../config.js";
import { Store } from "../store.js";
import { hashToken } from "../secrets.js";

const log = createLogger("server");

export const StoreState = defineAppState<Store>({ name: "store" });

export function storePlugin() {
  return definePlugin({
    name: "store",
    async load(_app: Raven, set: StateSetter) {
      const store = await Store.connect(config.databaseUrl);
      await bootstrap(store);
      set(StoreState, store);
    },
  });
}

async function bootstrap(store: Store) {
  // 以下三项（default 账号 seed / env 登记密钥 seed / credFingerprint 撤销）都是单账号 + env 口令的伴生物，
  // 仅 local 模式执行。supabase 模式下账号按 userId lazy 建、登记密钥走 UI 生成。
  if (config.authProvider === "local") {
    if (!(await store.getAccount(config.accountId))) {
      await store.createAccount({ id: config.accountId, name: "default", createdAt: Date.now() });
      log.info("created account", { accountId: config.accountId });
    }
    await store.upsertEnrollmentKey(hashToken(config.enrollKey), config.accountId, Date.now());
    // 不再 seed 静态登录令牌；web 用用户名+密码登录，登录时签发会话 token。

    // 凭证变更检测：用户名/密码改了（改 env 重启）就撤销全部已签发会话 token，
    // 让改密码能即时使已泄露/在用的旧 token 失效（token 与密码解耦存于表中，否则永久有效）。
    const credFingerprint = hashToken(`${config.username}\n${config.password}`);
    if ((await store.getMeta("credFingerprint")) !== credFingerprint) {
      await store.revokeAllClientTokens(config.accountId);
      await store.setMeta("credFingerprint", credFingerprint);
      log.info("credentials changed since last boot, revoked all client tokens");
    }
  }
  // 清理已撤销/过期的会话 token，防 client_tokens 表无界增长（两模式通用）。
  await store.pruneClientTokens(Date.now());

  log.info("bootstrap ready", { authProvider: config.authProvider });
}
