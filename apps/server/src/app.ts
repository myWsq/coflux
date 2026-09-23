import { ClientLoginContract } from "./interface/client-login/client-login.contract.js";
import { ClientLoginHandler } from "./interface/client-login/client-login.handler.js";
import { ClientCommandContract } from "./interface/client-command/client-command.contract.js";
import { ClientCommandHandler } from "./interface/client-command/client-command.handler.js";
import { ClientExecutorSettingsContract } from "./interface/client-executor/client-executor.contract.js";
import { ClientExecutorSettingsHandler } from "./interface/client-executor/client-executor.handler.js";
import {
  ClientAuthConfigContract,
  ClientLoginExchangeContract,
  ClientLoginRequestContract,
} from "./interface/client-native-login/client-native-login.contract.js";
import {
  ClientAuthConfigHandler,
  ClientLoginExchangeHandler,
  ClientLoginRequestHandler,
} from "./interface/client-native-login/client-native-login.handler.js";
/**
 * 组合根（RavenJS runtime assembly）：创建 Raven app、注册基础设施插件与 HTTP 路由。
 * 不在此调用 ready() —— serve 入口（index.ts）决定何时就绪并负责传输层
 * （WS 升级、预览域反代分流、心跳、信号）。
 */
import { Raven, RavenContext, isRavenError, isValidationError, registerContractRoute } from "@raven.js/core";
import { AUTH_BASE_PATH } from "./identity.js";
import { storePlugin } from "./plugins/store.plugin.js";
import { hubPlugin } from "./plugins/hub.plugin.js";
import { GetHealthContract } from "./interface/get-health/get-health.contract.js";
import { GetHealthHandler } from "./interface/get-health/get-health.handler.js";
import {
  GetAuthorizePageContract,
  GetAuthorizeProviderReturnContract,
  GetLoginErrorPageContract,
  GetNativeLoginPageContract,
  GetNativeProviderReturnContract,
  GetProxyAuthPageContract,
  GetProxyAuthProviderReturnContract,
  PostAuthorizeConfirmContract,
  PostAuthorizeLoginContract,
  PostAuthorizeProviderContract,
  PostNativeConfirmContract,
  PostNativeDenyContract,
  PostNativeLoginContract,
  PostNativeProviderContract,
  PostProxyAuthLoginContract,
  PostProxyAuthProviderContract,
} from "./interface/auth-pages/auth-pages.contract.js";
import {
  GetAuthorizePageHandler,
  GetAuthorizeProviderReturnHandler,
  GetLoginErrorPageHandler,
  GetNativeLoginPageHandler,
  GetNativeProviderReturnHandler,
  GetProxyAuthPageHandler,
  GetProxyAuthProviderReturnHandler,
  PostAuthorizeConfirmHandler,
  PostAuthorizeLoginHandler,
  PostAuthorizeProviderHandler,
  PostNativeConfirmHandler,
  PostNativeDenyHandler,
  PostNativeLoginHandler,
  PostNativeProviderHandler,
  PostProxyAuthLoginHandler,
  PostProxyAuthProviderHandler,
} from "./interface/auth-pages/auth-pages.handler.js";
import { HubState } from "./plugins/hub.plugin.js";


export const app = new Raven();

// load 串行：hub 依赖 store 写入的 StoreState，注册顺序即依赖顺序。
app.register(storePlugin()).register(hubPlugin());

// Better Auth (plan 20260923) is served ahead of Raven routing, never as a Raven route: Raven parses the
// body of every matched route before its handler runs, which would hand Better Auth a consumed Request.
// Only the enabled providers' callbacks answer; see identity.ts.
app.onRequest((request) => {
  const { pathname } = new URL(request.url);
  if (pathname !== AUTH_BASE_PATH && !pathname.startsWith(`${AUTH_BASE_PATH}/`)) return undefined;
  return HubState.getOrFailed().identity.handle(request);
});

// 账号 CLI 的框架错误保持结构化响应。
app.onError((error) => {
  const pathname = RavenContext.get()?.url.pathname ?? "";
  if (pathname.startsWith("/api/client/")) {
    const status = isValidationError(error) || (isRavenError(error) && error.code === "ERR_BAD_REQUEST") ? 400 : error.message === "Not Found" ? 404 : 500;
    return Response.json({ ok: false, error: status === 400 ? "请求格式或协议版本不支持" : status === 404 ? "未知的端点" : "服务器内部错误" }, { status, headers: { "Cache-Control": "no-store" } });
  }
  return undefined;
});

registerContractRoute(app, GetHealthContract, GetHealthHandler);

// server 直出的浏览器页面：设备授权 / 端口预览门禁，纯 HTML 表单 PRG
registerContractRoute(app, GetAuthorizePageContract, GetAuthorizePageHandler);
registerContractRoute(app, PostAuthorizeLoginContract, PostAuthorizeLoginHandler);
registerContractRoute(app, PostAuthorizeConfirmContract, PostAuthorizeConfirmHandler);
registerContractRoute(app, GetProxyAuthPageContract, GetProxyAuthPageHandler);
registerContractRoute(app, PostProxyAuthLoginContract, PostProxyAuthLoginHandler);
registerContractRoute(app, PostAuthorizeProviderContract, PostAuthorizeProviderHandler);
registerContractRoute(app, GetAuthorizeProviderReturnContract, GetAuthorizeProviderReturnHandler);
registerContractRoute(app, PostProxyAuthProviderContract, PostProxyAuthProviderHandler);
registerContractRoute(app, GetProxyAuthProviderReturnContract, GetProxyAuthProviderReturnHandler);
// 原生登录页（桌面 / CLI 经浏览器登录，plan 20260923）
registerContractRoute(app, GetNativeLoginPageContract, GetNativeLoginPageHandler);
registerContractRoute(app, PostNativeLoginContract, PostNativeLoginHandler);
registerContractRoute(app, PostNativeProviderContract, PostNativeProviderHandler);
registerContractRoute(app, GetNativeProviderReturnContract, GetNativeProviderReturnHandler);
registerContractRoute(app, PostNativeConfirmContract, PostNativeConfirmHandler);
registerContractRoute(app, PostNativeDenyContract, PostNativeDenyHandler);
registerContractRoute(app, GetLoginErrorPageContract, GetLoginErrorPageHandler);

registerContractRoute(app, ClientLoginContract, ClientLoginHandler);
registerContractRoute(app, ClientAuthConfigContract, ClientAuthConfigHandler);
registerContractRoute(app, ClientLoginRequestContract, ClientLoginRequestHandler);
registerContractRoute(app, ClientLoginExchangeContract, ClientLoginExchangeHandler);
registerContractRoute(app, ClientCommandContract, ClientCommandHandler);
registerContractRoute(app, ClientExecutorSettingsContract, ClientExecutorSettingsHandler);
