/**
 * OAuth 2.1 授权服务器契约（plan 090）。schemas 全部留空：这些端点的输入/输出形状由 OAuth /
 * RFC 9728 / RFC 8414 / RFC 7591 规定，错误必须是 OAuth 信封而非 Raven 校验错误，故 handler
 * 自己解析并直接构造 Response。
 */
import { defineContract } from "@raven.js/core/contract";

/** RFC 9728 受保护资源元数据：根路径与 `/mcp` 路径后缀两种形式都提供，宿主按 401 挑战里的
 * resource_metadata 取后者，按资源 URL 推导时也可能取前者。 */
export const GetProtectedResourceMetadataContract = defineContract({
  method: "GET",
  path: "/.well-known/oauth-protected-resource",
  schemas: {},
});

export const GetProtectedResourceMetadataMcpContract = defineContract({
  method: "GET",
  path: "/.well-known/oauth-protected-resource/mcp",
  schemas: {},
});

/** RFC 8414 授权服务器元数据。 */
export const GetAuthorizationServerMetadataContract = defineContract({
  method: "GET",
  path: "/.well-known/oauth-authorization-server",
  schemas: {},
});

/** RFC 7591 动态客户端注册（公共客户端）。 */
export const PostOAuthRegisterContract = defineContract({
  method: "POST",
  path: "/oauth/register",
  schemas: {},
});

/** 授权端点：302 到 web 确认页。 */
export const GetOAuthAuthorizeContract = defineContract({
  method: "GET",
  path: "/oauth/authorize",
  schemas: {},
});

/** token 端点：authorization_code + PKCE / refresh_token 轮换。 */
export const PostOAuthTokenContract = defineContract({
  method: "POST",
  path: "/oauth/token",
  schemas: {},
});
