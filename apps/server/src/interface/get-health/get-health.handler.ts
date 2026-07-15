import { withSchema } from "@raven.js/core";
import { GetHealthContract } from "./get-health.contract.js";
import { StoreState } from "../../plugins/store.plugin.js";
import { HubState } from "../../plugins/hub.plugin.js";

// 模块加载时刻 ≈ 进程启动时刻，够 uptime 语义用
const startedAt = Date.now();

export const GetHealthHandler = withSchema(GetHealthContract.schemas, async () => {
  const ok = await StoreState.getOrFailed().ping();
  return Response.json({ ok, uptimeMs: Date.now() - startedAt, ...HubState.getOrFailed().stats() });
});
