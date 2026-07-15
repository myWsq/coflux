/**
 * 健康检查契约。schemas 留空：无入参；响应含动态统计字段（hub.stats()），由 handler
 * 直接构造 Response，不为此引入 schema 运行时依赖。
 */
import { defineContract } from "@raven.js/core/contract";

export const GetHealthContract = defineContract({
  method: "GET",
  path: "/health",
  schemas: {},
});
