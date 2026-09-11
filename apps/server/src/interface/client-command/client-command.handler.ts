import { RavenContext, withSchema } from "@raven.js/core";
import { HubState } from "../../plugins/hub.plugin.js";
import { StoreState } from "../../plugins/store.plugin.js";
import { hashToken } from "../../secrets.js";
import { stripAnsi, tailLines } from "../../terminal-text.js";
import { buildPreviewUrl } from "../../proxy.js";
import { ClientCommandContract } from "./client-command.contract.js";

/** CLI 与其他账号客户端的薄适配。副作用、归属与人类优先规则全部复用 Hub。 */
export const ClientCommandHandler = withSchema(ClientCommandContract.schemas, async ({ body }) => {
  const store = StoreState.getOrFailed();
  const hub = HubState.getOrFailed();
  const bearer = RavenContext.getOrFailed().request.headers.get("authorization") ?? "";
  const token = /^Bearer (\S{1,4096})$/.exec(bearer)?.[1];
  const tokenHash = token ? hashToken(token) : "";
  const accountId = tokenHash ? await store.accountForClientToken(tokenHash, Date.now()) : undefined;
  const reply = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
  if (!accountId) return reply({ ok: false, error: "请先登录 Coflux" }, 401);
  const command = body.command;
  switch (command.op) {
    case "snapshot": {
      const [devices, projects, workspaces, terminals] = await Promise.all([
        hub.daemonInfoList(accountId), store.listProjects(accountId), store.listWorkspaces(accountId), store.listTasks(accountId),
      ]);
      const workspaceByTask = new Map(terminals.map((task) => [task.id, task.workspaceId]));
      const ports = hub.routeTable.listForAccount(accountId).map((route) => ({ ...route, workspaceId: workspaceByTask.get(route.taskId), url: buildPreviewUrl(route.shortId) }));
      return reply({ ok: true, value: { accountId, devices, projects, workspaces, terminals, ports } });
    }
    case "logout":
      await hub.revokeClientSession(accountId, tokenHash);
      return reply({ ok: true, value: null });
    case "workspace.new": return reply(await hub.createWorkspaceForAccount(accountId, command));
    case "workspace.rename": return reply(await hub.renameWorkspaceForAccount(accountId, command.workspaceId, command.name));
    case "workspace.remove": return reply(await hub.removeWorkspaceForAccount(accountId, command.workspaceId));
    case "terminal.new": return reply(await hub.createTerminalForAccount(accountId, command));
    case "terminal.read": {
      const result = await hub.readTerminalForAccount(accountId, command.terminalId);
      if (!result.ok) return reply(result);
      const { data, ...value } = result.value;
      return reply({ ok: true, value: { ...value, text: tailLines(stripAnsi(Buffer.from(data).toString("utf8")), command.lines) } });
    }
    case "terminal.send": return reply(await hub.sendTerminalInputForAccount(accountId, command.terminalId, Buffer.from(command.text + (command.enter ? "\r" : ""))));
    case "terminal.wait": return reply(await hub.waitTerminalForAccount(accountId, command.terminalId, command.timeout * 1000));
    case "terminal.stop": return reply(await hub.stopTerminalForAccount(accountId, command.terminalId));
    case "terminal.remove": return reply(await hub.removeTerminalForAccount(accountId, command.terminalId));
  }
});
