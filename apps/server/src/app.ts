import { ClientLoginContract } from "./interface/client-login/client-login.contract.js";
import { ClientLoginHandler } from "./interface/client-login/client-login.handler.js";
import { ClientCommandContract } from "./interface/client-command/client-command.contract.js";
import { ClientCommandHandler } from "./interface/client-command/client-command.handler.js";
/**
 * 组合根（RavenJS runtime assembly）：创建 Raven app、注册基础设施插件与 HTTP 路由。
 * 不在此调用 ready() —— serve 入口（index.ts）决定何时就绪并负责传输层
 * （WS 升级、预览域反代分流、心跳、信号）。
 */
import { Raven, RavenContext, isRavenError, isValidationError, registerContractRoute } from "@raven.js/core";
import { storePlugin } from "./plugins/store.plugin.js";
import { hubPlugin } from "./plugins/hub.plugin.js";
import { GetHealthContract } from "./interface/get-health/get-health.contract.js";
import { GetHealthHandler } from "./interface/get-health/get-health.handler.js";
import {
  GetAuthorizePageContract,
  GetProxyAuthPageContract,
  PostAuthorizeConfirmContract,
  PostAuthorizeLoginContract,
  PostProxyAuthLoginContract,
} from "./interface/auth-pages/auth-pages.contract.js";
import {
  GetAuthorizePageHandler,
  GetProxyAuthPageHandler,
  PostAuthorizeConfirmHandler,
  PostAuthorizeLoginHandler,
  PostProxyAuthLoginHandler,
} from "./interface/auth-pages/auth-pages.handler.js";


export const app = new Raven();

// load 串行：hub 依赖 store 写入的 StoreState，注册顺序即依赖顺序。
app.register(storePlugin()).register(hubPlugin());

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

registerContractRoute(app, ClientLoginContract, ClientLoginHandler);
registerContractRoute(app, ClientCommandContract, ClientCommandHandler);
