/**
 * Hub 插件（RavenJS runtime assembly）：装配领域协调器。
 * 依赖 StoreState（注册顺序在 store 插件之后，load 串行保证可读）；verifier 是 Hub 的内部
 * 依赖，随插件创建即可，不需要独立 state。
 */
import { defineAppState, definePlugin, type Raven, type StateSetter } from "@raven.js/core";
import { config } from "../config.js";
import { Hub } from "../hub.js";
import { SupabaseVerifier } from "../auth.js";
import { StoreState } from "./store.plugin.js";

export const HubState = defineAppState<Hub>({ name: "hub" });

export function hubPlugin() {
  return definePlugin({
    name: "hub",
    load(_app: Raven, set: StateSetter) {
      const store = StoreState.getOrFailed();
      // supabase 模式启用 JWKS 验签器；local 模式不需要（省去外部依赖）。
      const verifier = config.authProvider === "supabase" ? new SupabaseVerifier(config.supabaseUrl) : undefined;
      set(HubState, new Hub(store, verifier));
    },
  });
}
