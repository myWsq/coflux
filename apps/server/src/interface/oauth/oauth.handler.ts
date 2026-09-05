/**
 * OAuth 2.1 端点 handler（plan 090）。全部只做"取输入 → 交给 OAuthService → 原样返回 Response"：
 * 业务规则（redirect_uri 校验、PKCE、轮换）都在 oauth.ts，这里不含任何判断。
 * 所有失败路径由 service 构造 OAuth 错误 Response，不 throw（Raven 错误信封 OAuth 客户端读不懂）。
 */
import { RavenContext, withSchema } from "@raven.js/core";
import { HubState } from "../../plugins/hub.plugin.js";
import { oauthErrorResponse } from "../../oauth.js";
import {
  GetAuthorizationServerMetadataContract,
  GetOAuthAuthorizeContract,
  GetProtectedResourceMetadataContract,
  GetProtectedResourceMetadataMcpContract,
  PostOAuthRegisterContract,
  PostOAuthTokenContract,
} from "./oauth.contract.js";

function metadataResponse(body: Record<string, unknown>): Response {
  // 元数据可短暂缓存；允许跨域读取（浏览器内的 MCP inspector 之类会直接 fetch 它）。
  return Response.json(body, { headers: { "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*" } });
}

export const GetProtectedResourceMetadataHandler = withSchema(GetProtectedResourceMetadataContract.schemas, async () =>
  metadataResponse(HubState.getOrFailed().oauth.protectedResourceMetadata()),
);

export const GetProtectedResourceMetadataMcpHandler = withSchema(GetProtectedResourceMetadataMcpContract.schemas, async () =>
  metadataResponse(HubState.getOrFailed().oauth.protectedResourceMetadata()),
);

export const GetAuthorizationServerMetadataHandler = withSchema(GetAuthorizationServerMetadataContract.schemas, async () =>
  metadataResponse(HubState.getOrFailed().oauth.authorizationServerMetadata()),
);

/** Raven 对 application/json 请求已预解析 body（ctx.body）；非 JSON content-type 时 body 为 undefined，
 * 由 service 按"不是 JSON 对象"拒绝。 */
export const PostOAuthRegisterHandler = withSchema(PostOAuthRegisterContract.schemas, async (ctx) =>
  HubState.getOrFailed().oauth.registerClient(ctx.body),
);

export const GetOAuthAuthorizeHandler = withSchema(GetOAuthAuthorizeContract.schemas, async () =>
  HubState.getOrFailed().oauth.beginAuthorization(RavenContext.getOrFailed().url.searchParams),
);

/** token 端点按 RFC 6749 收 application/x-www-form-urlencoded（Raven 不碰这种 body，handler 自己读）；
 * 少数客户端发 JSON，也一并接受（Raven 已预解析到 ctx.body）。 */
export const PostOAuthTokenHandler = withSchema(PostOAuthTokenContract.schemas, async (ctx) => {
  const request = RavenContext.getOrFailed().request;
  const contentType = request.headers.get("content-type") ?? "";
  const params = new URLSearchParams();
  if (contentType.includes("application/json")) {
    if (!ctx.body || typeof ctx.body !== "object" || Array.isArray(ctx.body)) {
      return oauthErrorResponse(400, "invalid_request", "请求体必须是 JSON 对象或表单");
    }
    for (const [key, value] of Object.entries(ctx.body as Record<string, unknown>)) {
      if (typeof value === "string") params.set(key, value);
    }
  } else {
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return oauthErrorResponse(400, "invalid_request", "请求体必须是 application/x-www-form-urlencoded 表单");
    }
    for (const [key, value] of form.entries()) {
      if (typeof value === "string") params.set(key, value);
    }
  }
  return HubState.getOrFailed().oauth.exchangeToken(params);
});
