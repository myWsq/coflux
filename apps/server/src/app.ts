/**
 * 组合根（RavenJS runtime assembly）：创建 Raven app、注册基础设施插件与 HTTP 路由。
 * 不在此调用 ready() —— serve 入口（index.ts）决定何时就绪并负责传输层
 * （WS 升级、预览域反代分流、心跳、信号）。
 */
import { Raven, RavenContext, isRavenError, registerContractRoute } from "@raven.js/core";
import { createLogger } from "@coflux/core";
import { storePlugin } from "./plugins/store.plugin.js";
import { hubPlugin } from "./plugins/hub.plugin.js";
import { GetHealthContract } from "./interface/get-health/get-health.contract.js";
import { GetHealthHandler } from "./interface/get-health/get-health.handler.js";
import {
  GetAuthorizationServerMetadataContract,
  GetOAuthAuthorizeContract,
  GetProtectedResourceMetadataContract,
  GetProtectedResourceMetadataMcpContract,
  PostOAuthRegisterContract,
  PostOAuthTokenContract,
} from "./interface/oauth/oauth.contract.js";
import {
  GetAuthorizationServerMetadataHandler,
  GetOAuthAuthorizeHandler,
  GetProtectedResourceMetadataHandler,
  GetProtectedResourceMetadataMcpHandler,
  PostOAuthRegisterHandler,
  PostOAuthTokenHandler,
} from "./interface/oauth/oauth.handler.js";
import { DeleteMcpContract, GetMcpContract, PostMcpContract } from "./interface/mcp/mcp.contract.js";
import { DeleteMcpHandler, GetMcpHandler, PostMcpHandler } from "./interface/mcp/mcp.handler.js";
import {
  GetAuthorizePageContract,
  GetOAuthConsentPageContract,
  GetProxyAuthPageContract,
  PostAuthorizeConfirmContract,
  PostAuthorizeLoginContract,
  PostOAuthConsentDecideContract,
  PostOAuthConsentLoginContract,
  PostProxyAuthLoginContract,
} from "./interface/auth-pages/auth-pages.contract.js";
import {
  GetAuthorizePageHandler,
  GetOAuthConsentPageHandler,
  GetProxyAuthPageHandler,
  PostAuthorizeConfirmHandler,
  PostAuthorizeLoginHandler,
  PostOAuthConsentDecideHandler,
  PostOAuthConsentLoginHandler,
  PostProxyAuthLoginHandler,
} from "./interface/auth-pages/auth-pages.handler.js";
import { oauthErrorResponse } from "./oauth.js";

const log = createLogger("server");

export const app = new Raven();

// load 串行：hub 依赖 store 写入的 StoreState，注册顺序即依赖顺序。
app.register(storePlugin()).register(hubPlugin());

// OAuth / MCP 路径上的框架级错误（畸形 JSON、未知子路径、意外异常）也必须是 OAuth 信封：
// Raven 默认的错误信封 OAuth 客户端与 MCP 宿主都读不懂。业务失败路径由 handler 自己构造
// Response，这里只兜框架自己抛出来的那几种。
app.onError((error) => {
  const pathname = RavenContext.get()?.url.pathname ?? "";
  // `/oauth/consent*` 是 server 直出的浏览器页面（plan 107），不是 OAuth 客户端读的端点，走 Raven 默认信封。
  if (pathname.startsWith("/oauth/consent")) return undefined;
  if (!(pathname.startsWith("/oauth/") || pathname === "/mcp" || pathname.startsWith("/.well-known/"))) return undefined;
  if (error.message === "Not Found") return oauthErrorResponse(404, "invalid_request", "未知的端点");
  if (isRavenError(error) && error.code === "ERR_BAD_REQUEST") return oauthErrorResponse(400, "invalid_request", "请求体不是合法 JSON");
  log.error("OAuth/MCP 路径未处理的错误", { pathname, err: error.stack ?? String(error) });
  return oauthErrorResponse(500, "server_error", "服务器内部错误");
});

registerContractRoute(app, GetHealthContract, GetHealthHandler);

// OAuth 2.1 授权服务器 + 受保护资源元数据（plan 090）
registerContractRoute(app, GetProtectedResourceMetadataContract, GetProtectedResourceMetadataHandler);
registerContractRoute(app, GetProtectedResourceMetadataMcpContract, GetProtectedResourceMetadataMcpHandler);
registerContractRoute(app, GetAuthorizationServerMetadataContract, GetAuthorizationServerMetadataHandler);
registerContractRoute(app, PostOAuthRegisterContract, PostOAuthRegisterHandler);
registerContractRoute(app, GetOAuthAuthorizeContract, GetOAuthAuthorizeHandler);
registerContractRoute(app, PostOAuthTokenContract, PostOAuthTokenHandler);

// 中心托管的远程 MCP（plan 090）：三个 method 并存，无状态 transport
registerContractRoute(app, PostMcpContract, PostMcpHandler);
registerContractRoute(app, GetMcpContract, GetMcpHandler);
registerContractRoute(app, DeleteMcpContract, DeleteMcpHandler);

// server 直出的三张浏览器页面（plan 107）：设备授权 / OAuth 同意 / 端口预览门禁，纯 HTML 表单 PRG
registerContractRoute(app, GetAuthorizePageContract, GetAuthorizePageHandler);
registerContractRoute(app, PostAuthorizeLoginContract, PostAuthorizeLoginHandler);
registerContractRoute(app, PostAuthorizeConfirmContract, PostAuthorizeConfirmHandler);
registerContractRoute(app, GetOAuthConsentPageContract, GetOAuthConsentPageHandler);
registerContractRoute(app, PostOAuthConsentLoginContract, PostOAuthConsentLoginHandler);
registerContractRoute(app, PostOAuthConsentDecideContract, PostOAuthConsentDecideHandler);
registerContractRoute(app, GetProxyAuthPageContract, GetProxyAuthPageHandler);
registerContractRoute(app, PostProxyAuthLoginContract, PostProxyAuthLoginHandler);
