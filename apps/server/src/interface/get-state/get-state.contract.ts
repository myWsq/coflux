/**
 * 账号全量状态快照（只读）。响应即 proto StateSnapshot 的 protojson 投影
 * （与 WS stateSnapshot 同源，见 get-state.handler.ts），故不另写响应 schema。
 * 认证：Authorization: Bearer <clientToken>（api-auth 插件统一拦截 /api/*）。
 */
import { defineContract } from "@raven.js/core/contract";

export const GetStateContract = defineContract({
  method: "GET",
  path: "/api/state",
  schemas: {},
});
