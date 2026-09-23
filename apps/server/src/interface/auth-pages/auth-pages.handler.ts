/**
 * 三张浏览器页面的 handler（plan 107）。全部只做"取输入 → 交给 AuthPages → 原样返回 Response"：
 * 页面会话、csrf、限速与业务规则都在 auth-pages.ts（业务核心再经 Hub 共用方法），这里不含任何判断。
 * 来源地址来自 index.ts 覆盖写入的内部头（Raven 上下文拿不到 socket）。
 */
import { RavenContext, withSchema } from "@raven.js/core";
import { HubState } from "../../plugins/hub.plugin.js";
import { REMOTE_ADDRESS_HEADER } from "../../transport.js";
import type { PageRequest } from "../../auth-pages.js";
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
} from "./auth-pages.contract.js";

function pageRequest(): PageRequest {
  const { request } = RavenContext.getOrFailed();
  return { request, remoteAddress: request.headers.get(REMOTE_ADDRESS_HEADER) ?? "unknown" };
}

export const GetAuthorizePageHandler = withSchema(GetAuthorizePageContract.schemas, async () =>
  HubState.getOrFailed().authPages.authorizePage(pageRequest(), RavenContext.getOrFailed().params.token ?? ""),
);

export const PostAuthorizeLoginHandler = withSchema(PostAuthorizeLoginContract.schemas, async () =>
  HubState.getOrFailed().authPages.authorizeLogin(pageRequest(), RavenContext.getOrFailed().params.token ?? ""),
);

export const PostAuthorizeConfirmHandler = withSchema(PostAuthorizeConfirmContract.schemas, async () =>
  HubState.getOrFailed().authPages.authorizeConfirm(pageRequest(), RavenContext.getOrFailed().params.token ?? ""),
);

export const GetProxyAuthPageHandler = withSchema(GetProxyAuthPageContract.schemas, async () =>
  HubState.getOrFailed().authPages.proxyAuthPage(pageRequest(), RavenContext.getOrFailed().query.to),
);

export const PostProxyAuthLoginHandler = withSchema(PostProxyAuthLoginContract.schemas, async () =>
  HubState.getOrFailed().authPages.proxyAuthLogin(pageRequest()),
);

const param = (name: string) => RavenContext.getOrFailed().params[name] ?? "";

export const PostAuthorizeProviderHandler = withSchema(PostAuthorizeProviderContract.schemas, async () =>
  HubState.getOrFailed().authPages.authorizeProviderStart(pageRequest(), param("token"), param("provider")),
);

export const GetAuthorizeProviderReturnHandler = withSchema(GetAuthorizeProviderReturnContract.schemas, async () =>
  HubState.getOrFailed().authPages.authorizeProviderReturn(pageRequest(), param("token")),
);

export const PostProxyAuthProviderHandler = withSchema(PostProxyAuthProviderContract.schemas, async () =>
  HubState.getOrFailed().authPages.proxyProviderStart(pageRequest(), param("provider")),
);

export const GetProxyAuthProviderReturnHandler = withSchema(GetProxyAuthProviderReturnContract.schemas, async () =>
  HubState.getOrFailed().authPages.proxyProviderReturn(pageRequest(), RavenContext.getOrFailed().query.to),
);

export const GetNativeLoginPageHandler = withSchema(GetNativeLoginPageContract.schemas, async () =>
  HubState.getOrFailed().authPages.nativePage(pageRequest(), param("id")),
);

export const PostNativeLoginHandler = withSchema(PostNativeLoginContract.schemas, async () =>
  HubState.getOrFailed().authPages.nativeLogin(pageRequest(), param("id")),
);

export const PostNativeProviderHandler = withSchema(PostNativeProviderContract.schemas, async () =>
  HubState.getOrFailed().authPages.nativeProviderStart(pageRequest(), param("id"), param("provider")),
);

export const GetNativeProviderReturnHandler = withSchema(GetNativeProviderReturnContract.schemas, async () =>
  HubState.getOrFailed().authPages.nativeProviderReturn(pageRequest(), param("id")),
);

export const PostNativeConfirmHandler = withSchema(PostNativeConfirmContract.schemas, async () =>
  HubState.getOrFailed().authPages.nativeConfirm(pageRequest(), param("id")),
);

export const PostNativeDenyHandler = withSchema(PostNativeDenyContract.schemas, async () =>
  HubState.getOrFailed().authPages.nativeDeny(pageRequest(), param("id")),
);

export const GetLoginErrorPageHandler = withSchema(GetLoginErrorPageContract.schemas, async () =>
  HubState.getOrFailed().authPages.loginErrorPage(pageRequest()),
);
