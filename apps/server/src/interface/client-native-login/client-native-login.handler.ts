import { RavenContext, withSchema } from "@raven.js/core";
import { config } from "../../config.js";
import { HubState } from "../../plugins/hub.plugin.js";
import { REMOTE_ADDRESS_HEADER } from "../../transport.js";
import { ClientAuthConfigContract, ClientLoginExchangeContract, ClientLoginRequestContract } from "./client-native-login.contract.js";

const reply = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });

function remoteAddress(): string {
  return RavenContext.getOrFailed().request.headers.get(REMOTE_ADDRESS_HEADER) ?? "unknown";
}

export const ClientAuthConfigHandler = withSchema(ClientAuthConfigContract.schemas, async () =>
  reply({ ok: true, value: { mode: config.authProvider, providers: HubState.getOrFailed().enabledProviders() } }),
);

export const ClientLoginRequestHandler = withSchema(ClientLoginRequestContract.schemas, async ({ body }) => {
  const hub = HubState.getOrFailed();
  if (!hub.allowNativeLogin(remoteAddress())) return reply({ ok: false, error: "登录尝试过于频繁，请稍后重试" }, 429);
  if (body.redirect === "loopback" && body.port === undefined) return reply({ ok: false, error: "登录请求无效" }, 400);
  const result = hub.registerNativeLogin({
    clientKind: body.clientKind,
    host: body.host,
    redirect: body.redirect === "loopback" ? { kind: "loopback", port: body.port! } : { kind: "paste" },
    codeChallenge: body.codeChallenge,
    state: body.state,
  });
  return reply(result, result.ok ? 200 : 400);
});

export const ClientLoginExchangeHandler = withSchema(ClientLoginExchangeContract.schemas, async ({ body }) => {
  const hub = HubState.getOrFailed();
  if (!hub.allowNativeLogin(remoteAddress())) return reply({ ok: false, error: "登录尝试过于频繁，请稍后重试" }, 429);
  const result = await hub.exchangeNativeLogin(body.code, body.codeVerifier);
  return reply(result, result.ok ? 200 : 401);
});
