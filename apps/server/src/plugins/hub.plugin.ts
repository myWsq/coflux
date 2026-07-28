/**
 * Hub 插件（RavenJS runtime assembly）：装配领域协调器。
 * 依赖 StoreState（注册顺序在 store 插件之后，load 串行保证可读）。
 */
import { defineAppState, definePlugin, type Raven, type StateSetter } from "@raven.js/core";
import { Hub } from "../hub.js";
import { StoreState } from "./store.plugin.js";

export const HubState = defineAppState<Hub>({ name: "hub" });

export function hubPlugin() {
  return definePlugin({
    name: "hub",
    load(_app: Raven, set: StateSetter) {
      const store = StoreState.getOrFailed();
      set(HubState, new Hub(store));
    },
  });
}
