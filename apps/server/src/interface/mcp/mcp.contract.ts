/**
 * `/mcp` 契约（plan 090，Streamable HTTP）。POST 承载 JSON-RPC；GET/DELETE 一并注册，让宿主
 * 探测 SSE/会话终止时拿到 MCP 规范的应答而非 Raven 404。schemas 留空：JSON-RPC 校验由 MCP SDK 做。
 */
import { defineContract } from "@raven.js/core/contract";

export const PostMcpContract = defineContract({
  method: "POST",
  path: "/mcp",
  schemas: {},
});

export const GetMcpContract = defineContract({
  method: "GET",
  path: "/mcp",
  schemas: {},
});

export const DeleteMcpContract = defineContract({
  method: "DELETE",
  path: "/mcp",
  schemas: {},
});
