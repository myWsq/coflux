import { RavenContext, withSchema } from "@raven.js/core";
import { HubState } from "../../plugins/hub.plugin.js";
import { REMOTE_ADDRESS_HEADER } from "../../transport.js";
import { ClientLoginContract } from "./client-login.contract.js";

export const ClientLoginHandler = withSchema(ClientLoginContract.schemas, async ({ body }) => {
  const request = RavenContext.getOrFailed().request;
  const result = await HubState.getOrFailed().loginClient(body.username, body.password, request.headers.get(REMOTE_ADDRESS_HEADER) ?? "unknown");
  return Response.json(result, { status: result.ok ? 200 : 401, headers: { "Cache-Control": "no-store" } });
});
