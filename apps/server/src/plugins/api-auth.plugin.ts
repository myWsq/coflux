/**
 * /api/* 只读接口的认证插件：校验 `Authorization: Bearer <clientToken>`。
 * token 与 WS clientAuth 的会话 token 同一张表、同一套 sha256 校验（accountForClientToken），
 * 不新立凭证体系。hooks 一经注册全局生效，故在钩子内按路径前缀限定（仅拦 /api/*）。
 */
import { defineRequestState, definePlugin, HeadersState, RavenContext, type Raven, type StateSetter } from "@raven.js/core";
import type { AccountId } from "@coflux/protocol";
import { hashToken } from "../secrets.js";
import { StoreState } from "./store.plugin.js";

export const CurrentAccount = defineRequestState<AccountId>({ name: "current-account" });

export function apiAuthPlugin() {
  return definePlugin({
    name: "api-auth",
    load(app: Raven, set: StateSetter) {
      app.beforeHandle(async () => {
        const ctx = RavenContext.getOrFailed();
        if (!ctx.url.pathname.startsWith("/api/")) return;
        const m = /^Bearer (.+)$/.exec(HeadersState.getOrFailed()["authorization"] ?? "");
        const accountId = m ? await StoreState.getOrFailed().accountForClientToken(hashToken(m[1]), Date.now()) : undefined;
        if (!accountId) return Response.json({ error: "unauthorized" }, { status: 401 });
        set(CurrentAccount, accountId);
      });
    },
  });
}
