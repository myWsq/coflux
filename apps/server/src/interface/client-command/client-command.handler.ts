import { RavenContext, withSchema } from "@raven.js/core";
import { HubState } from "../../plugins/hub.plugin.js";
import { StoreState } from "../../plugins/store.plugin.js";
import { hashToken } from "../../secrets.js";
import { stripAnsi, tailLines } from "../../terminal-text.js";
import { buildPreviewUrl } from "../../proxy.js";
import { ClientCommandContract } from "./client-command.contract.js";
import { entityRef, resolveEntityHandle, type EntityKind } from "./entity-handle.js";

/** Every entity this endpoint returns carries its handle as `ref`, alongside — never instead of — the
 * id field it already had: ids stay canonical, `ref` is the paste-recognisable form of the same thing. */
const terminalRef = <T extends { id: string }>(task: T) => ({ ...task, ref: entityRef("terminal", task.id) });
const workspaceRef = <T extends { id: string }>(workspace: T) => ({ ...workspace, ref: entityRef("workspace", workspace.id) });
/** Decorate the entity a successful outcome carries; a failed one passes through untouched. */
const carrying = <T, R>(outcome: { ok: true; value: T } | { ok: false; error: string }, decorate: (value: T) => R) =>
  outcome.ok ? { ok: true as const, value: decorate(outcome.value) } : outcome;

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

  // Handles are normalised into real ids here, at the interface boundary, and the parsed command object
  // itself is rewritten: the whole object is forwarded downstream, so resolving into a local would leave
  // the handle in what the hub receives. Nothing below this point ever sees a handle. Resolution only
  // runs now that the account is known, and each lookup is bound to that account.
  const resolveHandle = (kind: EntityKind, value: string) =>
    resolveEntityHandle(kind, value, (k, prefix, limit) => store.listIdsByPrefix(k, accountId, prefix, limit));
  const normalise = async (): Promise<{ ok: true } | { ok: false; error: string }> => {
    switch (command.op) {
      case "workspace.new": {
        const resolved = await resolveHandle("project", command.projectId);
        if (!resolved.ok) return resolved;
        command.projectId = resolved.value;
        return { ok: true };
      }
      case "workspace.rename":
      case "workspace.remove":
      case "terminal.new": {
        const resolved = await resolveHandle("workspace", command.workspaceId);
        if (!resolved.ok) return resolved;
        command.workspaceId = resolved.value;
        return { ok: true };
      }
      case "terminal.run":
      case "terminal.read":
      case "terminal.send":
      case "terminal.wait":
      case "terminal.stop":
      case "terminal.remove": {
        const resolved = await resolveHandle("terminal", command.terminalId);
        if (!resolved.ok) return resolved;
        command.terminalId = resolved.value;
        return { ok: true };
      }
      case "device.exec": {
        const resolved = await resolveHandle("device", command.deviceId);
        if (!resolved.ok) return resolved;
        command.deviceId = resolved.value;
        return { ok: true };
      }
      default:
        return { ok: true };
    }
  };
  const normalised = await normalise();
  if (!normalised.ok) return reply(normalised);

  switch (command.op) {
    case "snapshot": {
      const [devices, projects, workspaces, terminals] = await Promise.all([
        hub.daemonInfoList(accountId), store.listProjects(accountId), store.listWorkspaces(accountId), store.listTasks(accountId),
      ]);
      const workspaceByTask = new Map(terminals.map((task) => [task.id, task.workspaceId]));
      const ports = hub.routeTable.listForAccount(accountId).map((route) => ({ ...route, workspaceId: workspaceByTask.get(route.taskId), url: buildPreviewUrl(route.shortId) }));
      // Live terminals carry their shell's command state (busy / last exit) from the latest checkpoint.
      const decorated = terminals.map((task) => ({ ...task, ...(task.sessionId ? hub.terminalCommandState(task.sessionId) ?? {} : {}) }));
      return reply({
        ok: true,
        value: {
          accountId,
          devices: devices.map((device) => ({ ...device, ref: entityRef("device", device.daemonId) })),
          projects: projects.map((project) => ({ ...project, ref: entityRef("project", project.id) })),
          workspaces: workspaces.map(workspaceRef),
          terminals: decorated.map((task) => ({ ...task, ref: entityRef("terminal", task.id) })),
          ports,
        },
      });
    }
    case "logout":
      await hub.revokeClientSession(accountId, tokenHash);
      return reply({ ok: true, value: null });
    case "workspace.new": return reply(carrying(await hub.createWorkspaceForAccount(accountId, command), workspaceRef));
    case "workspace.rename": return reply(carrying(await hub.renameWorkspaceForAccount(accountId, command.workspaceId, command.name), workspaceRef));
    case "workspace.remove": return reply(carrying(
      await hub.removeWorkspaceForAccount(accountId, command.workspaceId),
      (value) => ({ ...value, ref: entityRef("workspace", value.workspaceId), removedTerminalRefs: value.removedTerminalIds.map((id) => entityRef("terminal", id)) }),
    ));
    case "terminal.new": return reply(carrying(await hub.createTerminalForAccount(accountId, command), terminalRef));
    case "terminal.run": return reply(carrying(
      await hub.runTerminalCommandForAccount(accountId, command.terminalId, command.command),
      (value) => ({ ...value, ref: entityRef("terminal", value.terminalId) }),
    ));
    case "terminal.read": {
      const result = await hub.readTerminalForAccount(accountId, command.terminalId);
      if (!result.ok) return reply(result);
      const { data, task, ...value } = result.value;
      return reply({ ok: true, value: { task: terminalRef(task), ...value, text: tailLines(stripAnsi(Buffer.from(data).toString("utf8")), command.lines) } });
    }
    case "terminal.send": return reply(await hub.sendTerminalInputForAccount(accountId, command.terminalId, Buffer.from(command.text + (command.enter ? "\r" : ""))));
    case "terminal.wait": return reply(carrying(
      await hub.waitTerminalForAccount(accountId, command.terminalId, command.timeout * 1000),
      (value) => ({ ...value, task: terminalRef(value.task) }),
    ));
    case "terminal.stop": return reply(carrying(
      await hub.stopTerminalForAccount(accountId, command.terminalId),
      (value) => ({ ...value, task: terminalRef(value.task) }),
    ));
    case "terminal.remove": return reply(await hub.removeTerminalForAccount(accountId, command.terminalId));
    case "device.exec": return reply(carrying(
      await hub.execOnDeviceForAccount(accountId, { deviceId: command.deviceId, command: command.command, cwd: command.cwd, timeoutMs: command.timeout * 1000 }),
      (value) => ({ ...value, ref: entityRef("device", value.deviceId) }),
    ));
  }
});
