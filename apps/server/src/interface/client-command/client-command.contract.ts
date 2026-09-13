import { defineContract } from "@raven.js/core/contract";
import { z } from "zod";

const id = z.string().min(1).max(256);
const target = { terminalId: id };
const operations = z.discriminatedUnion("op", [
  z.object({ op: z.literal("snapshot") }).strict(),
  z.object({ op: z.literal("logout") }).strict(),
  z.object({ op: z.literal("workspace.new"), projectId: id, branch: z.string().min(1).max(1024), createNew: z.boolean().default(true), name: z.string().max(1024).optional() }).strict(),
  z.object({ op: z.literal("workspace.rename"), workspaceId: id, name: z.string().max(1024) }).strict(),
  z.object({ op: z.literal("workspace.remove"), workspaceId: id }).strict(),
  z.object({ op: z.literal("terminal.new"), workspaceId: id, title: z.string().max(1024).default(""), command: z.string().max(65536).default("") }).strict(),
  z.object({ op: z.literal("terminal.run"), ...target, command: z.string().min(1).max(65536) }).strict(),
  z.object({ op: z.literal("terminal.read"), ...target, lines: z.number().int().min(1).max(2000).default(200) }).strict(),
  z.object({ op: z.literal("terminal.send"), ...target, text: z.string().max(65536), enter: z.boolean().default(false) }).strict(),
  z.object({ op: z.literal("terminal.wait"), ...target, timeout: z.number().min(0).max(600).default(30) }).strict(),
  z.object({ op: z.literal("terminal.stop"), ...target }).strict(),
  z.object({ op: z.literal("terminal.remove"), ...target }).strict(),
  // `device.exec`: one-shot execution on a device, ssh semantics. `cwd` is the only addressing —
  // there is deliberately no workspaceId here (that would pull workspace semantics back into a
  // device-level primitive); empty cwd = the daemon user's HOME. Timeout is in seconds.
  z.object({ op: z.literal("device.exec"), deviceId: id, command: z.string().min(1).max(65536), cwd: z.string().max(4096).default(""), timeout: z.number().int().min(1).max(600).default(60) }).strict(),
]);
export const ClientCommandContract = defineContract({
  method: "POST", path: "/api/client/command",
  schemas: { body: z.object({ protocolVersion: z.literal(1), command: operations }).strict() },
});
