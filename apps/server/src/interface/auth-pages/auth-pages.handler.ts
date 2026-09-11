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
  GetOAuthConsentPageContract,
  GetProxyAuthPageContract,
  PostAuthorizeConfirmContract,
  PostAuthorizeLoginContract,
  PostOAuthConsentDecideContract,
  PostOAuthConsentLoginContract,
  PostProxyAuthLoginContract,
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

export const GetOAuthConsentPageHandler = withSchema(GetOAuthConsentPageContract.schemas, async () =>
  HubState.getOrFailed().authPages.consentPage(pageRequest(), RavenContext.getOrFailed().query.request),
);

export const PostOAuthConsentLoginHandler = withSchema(PostOAuthConsentLoginContract.schemas, async () =>
  HubState.getOrFailed().authPages.consentLogin(pageRequest()),
);

export const PostOAuthConsentDecideHandler = withSchema(PostOAuthConsentDecideContract.schemas, async () =>
  HubState.getOrFailed().authPages.consentDecide(pageRequest()),
);

export const GetProxyAuthPageHandler = withSchema(GetProxyAuthPageContract.schemas, async () =>
  HubState.getOrFailed().authPages.proxyAuthPage(pageRequest(), RavenContext.getOrFailed().query.to),
);

export const PostProxyAuthLoginHandler = withSchema(PostProxyAuthLoginContract.schemas, async () =>
  HubState.getOrFailed().authPages.proxyAuthLogin(pageRequest()),
);
