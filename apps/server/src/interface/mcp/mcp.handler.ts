/**
 * `/mcp` handler（plan 090）：bearer → principal → 每请求 new 一个 McpServer + 无状态 transport。
 *
 * - 无/坏 token 回 401 且 `WWW-Authenticate: Bearer resource_metadata="…"`，宿主据此发现 AS 并授权/刷新。
 * - Raven 对 application/json 请求已把 body 读掉（ctx.body 即解析结果），必须以 parsedBody 交给
 *   SDK，SDK 不能再 request.json()。
 * - 无状态（sessionIdGenerator: undefined）+ JSON 应答模式：每个 POST 自包含，响应即 JSON，
 *   不留 SSE 流与 keepalive 定时器；GET（服务端主动推送流）在无状态模式下无意义，按规范回 405。
 * - 错误一律构造 Response 返回，不 throw。
 */
import { RavenContext, withSchema } from "@raven.js/core";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createLogger } from "@coflux/core";
import { HubState } from "../../plugins/hub.plugin.js";
import { StoreState } from "../../plugins/store.plugin.js";
import { buildPreviewUrl } from "../../proxy.js";
import { createCofluxMcpServer } from "../../mcp/tools.js";
import type { OAuthPrincipal } from "../../oauth.js";
import { DeleteMcpContract, GetMcpContract, PostMcpContract } from "./mcp.contract.js";

const log = createLogger("server");

async function authenticate(): Promise<{ principal: OAuthPrincipal } | { response: Response }> {
  const hub = HubState.getOrFailed();
  const request = RavenContext.getOrFailed().request;
  const result = await hub.oauth.authenticate(request.headers.get("authorization"));
  if (!result.principal) return { response: hub.oauth.challenge(result.error === "invalid" ? "invalid" : undefined) };
  return { principal: result.principal };
}

async function dispatch(principal: OAuthPrincipal, parsedBody: unknown): Promise<Response> {
  const hub = HubState.getOrFailed();
  const store = StoreState.getOrFailed();
  const request = RavenContext.getOrFailed().request;
  const server = createCofluxMcpServer(principal, {
    store,
    listDaemons: (accountId) => hub.daemonInfoList(accountId),
    routeTable: hub.routeTable,
    buildPreviewUrl,
    // 写 tools 的操作层（plan 091）：Hub 结构化实现了 McpOperations 的方法集
    ops: hub,
  });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  try {
    await server.connect(transport);
    return await transport.handleRequest(request, {
      parsedBody,
      authInfo: {
        token: "", // 明文 token 不再往下传：tool 层只认 principal
        clientId: principal.clientId,
        scopes: principal.scope ? principal.scope.split(" ").filter(Boolean) : [],
        expiresAt: Math.floor(principal.expiresAt / 1000),
        extra: { accountId: principal.accountId, userId: principal.userId },
      },
    });
  } catch (error) {
    log.error("mcp 请求处理失败", { err: error instanceof Error ? error.stack : String(error) });
    return Response.json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null }, { status: 500 });
  } finally {
    // JSON 应答模式下响应已成形，关掉 transport/server 释放本次请求的资源。
    await transport.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}

export const PostMcpHandler = withSchema(PostMcpContract.schemas, async (ctx) => {
  const auth = await authenticate();
  if ("response" in auth) return auth.response;
  const request = RavenContext.getOrFailed().request;
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return Response.json(
      { jsonrpc: "2.0", error: { code: -32000, message: "Unsupported Media Type: Content-Type must be application/json" }, id: null },
      { status: 415 },
    );
  }
  return dispatch(auth.principal, ctx.body);
});

export const GetMcpHandler = withSchema(GetMcpContract.schemas, async () => {
  const auth = await authenticate();
  if ("response" in auth) return auth.response;
  // 无状态 transport 没有服务端主动推送的流；MCP 规范允许对 GET 回 405。
  return Response.json(
    { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed: 本服务器无状态，不提供 SSE 推送流" }, id: null },
    { status: 405, headers: { Allow: "POST, DELETE" } },
  );
});

export const DeleteMcpHandler = withSchema(DeleteMcpContract.schemas, async () => {
  const auth = await authenticate();
  if ("response" in auth) return auth.response;
  return dispatch(auth.principal, undefined);
});
