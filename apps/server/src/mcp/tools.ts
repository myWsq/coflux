/**
 * `/mcp` 的六个只读 tools（plan 090）。每个请求 new 一个 McpServer 绑定 principal，tool 实现
 * 只拿 principal + 中心既有的账号读法（store / hub.daemonInfoList / routeTable），不碰 Request、
 * 不碰 Raven 上下文——091 会在同一边界上加写 tools 与"完成原语"。
 *
 * 归属规则：列表按 principal.accountId 过滤；带 id 的入参先查实体再比对 accountId，不属于当前
 * 账号与不存在一律回同一句错误（不泄漏存在性）。
 */
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TaskStatus, type AccountId, type DaemonId, type Task, type Workspace } from "@coflux/protocol";
import type { OAuthPrincipal } from "../oauth.js";
import type { Store } from "../store.js";
import type { ProxyRouteTable } from "../proxy.js";
import { stripAnsi, tailLines } from "./text.js";

/** tool 层需要的中心读法：hub 只暴露这两样（设备在线态 + 端口路由表），其余走 store。 */
export interface McpToolDeps {
  store: Store;
  listDaemons: (accountId: AccountId) => Promise<DaemonInfoLike[]>;
  routeTable: Pick<ProxyRouteTable, "listForAccount" | "portsForTask">;
  buildPreviewUrl: (shortId: string) => string;
}

export interface DaemonInfoLike {
  daemonId: DaemonId;
  name: string;
  host: string;
  platform: string;
  online: boolean;
  workerVersion: string;
  supervisorVersion: string;
}

const DEFAULT_READ_LINES = 200;
const MAX_READ_LINES = 2000;
const NOT_FOUND = "不存在或不属于当前账号";

const DeviceSchema = z.object({
  id: z.string(),
  name: z.string(),
  host: z.string(),
  platform: z.string(),
  online: z.boolean(),
  workerVersion: z.string(),
  supervisorVersion: z.string(),
});
const ProjectSchema = z.object({
  id: z.string(),
  deviceId: z.string(),
  name: z.string(),
  repoPath: z.string(),
  defaultBranch: z.string(),
  createdAt: z.number(),
});
const WorkspaceSchema = z.object({
  id: z.string(),
  projectId: z.string().nullable(),
  deviceId: z.string(),
  name: z.string(),
  path: z.string(),
  branch: z.string(),
  isMain: z.boolean(),
  additions: z.number(),
  deletions: z.number(),
  createdAt: z.number(),
});
const TerminalStatusSchema = z.enum(["idle", "running", "exited"]);
const TerminalSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  projectId: z.string().nullable(),
  deviceId: z.string(),
  title: z.string(),
  status: TerminalStatusSchema,
  exitCode: z.number().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
const PortSchema = z.object({
  port: z.number(),
  url: z.string(),
  terminalId: z.string(),
  workspaceId: z.string(),
  deviceId: z.string(),
});

function taskStatusName(status: TaskStatus): z.infer<typeof TerminalStatusSchema> {
  switch (status) {
    case TaskStatus.RUNNING:
      return "running";
    case TaskStatus.EXITED:
      return "exited";
    default:
      return "idle";
  }
}

function workspaceView(w: Workspace) {
  return {
    id: w.id,
    projectId: w.projectId || null,
    deviceId: w.daemonId,
    name: w.name,
    path: w.path,
    branch: w.branch,
    isMain: w.isMain,
    additions: w.additions,
    deletions: w.deletions,
    createdAt: w.createdAt,
  };
}

function terminalView(t: Task) {
  return {
    id: t.id,
    workspaceId: t.workspaceId,
    projectId: t.projectId || null,
    deviceId: t.daemonId,
    title: t.title,
    status: taskStatusName(t.status),
    exitCode: t.exitCode ?? null,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

/** tool 的成功应答：结构化结果 + 同内容的 JSON 文本（老宿主只读 content）。 */
function ok<T extends Record<string, unknown>>(structuredContent: T) {
  return { content: [{ type: "text" as const, text: JSON.stringify(structuredContent, null, 2) }], structuredContent };
}

function fail(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true as const };
}

export function createCofluxMcpServer(principal: OAuthPrincipal, deps: McpToolDeps): McpServer {
  const server = new McpServer({ name: "coflux", version: "0.1.0" });
  const accountId = principal.accountId;
  const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;

  server.registerTool(
    "list_devices",
    {
      title: "列出设备",
      description: "列出当前账号下登记的设备（跑着 coflux daemon 的机器）：id、名称、主机名、平台、是否在线、worker/supervisor 版本。离线设备版本为空串。",
      inputSchema: {},
      outputSchema: { devices: z.array(DeviceSchema) },
      annotations: readOnly,
    },
    async () => {
      const devices = (await deps.listDaemons(accountId)).map((d) => ({
        id: d.daemonId,
        name: d.name,
        host: d.host,
        platform: d.platform,
        online: d.online,
        workerVersion: d.workerVersion,
        supervisorVersion: d.supervisorVersion,
      }));
      return ok({ devices });
    },
  );

  server.registerTool(
    "list_projects",
    {
      title: "列出项目",
      description: "列出当前账号下导入的项目（git 仓库）：id、所在设备 id、名称、仓库路径、默认分支。",
      inputSchema: {},
      outputSchema: { projects: z.array(ProjectSchema) },
      annotations: readOnly,
    },
    async () => {
      const projects = (await deps.store.listProjects(accountId)).map((p) => ({
        id: p.id,
        deviceId: p.daemonId,
        name: p.name,
        repoPath: p.repoPath,
        defaultBranch: p.defaultBranch,
        createdAt: p.createdAt,
      }));
      return ok({ projects });
    },
  );

  server.registerTool(
    "list_workspaces",
    {
      title: "列出工作区",
      description:
        "列出当前账号下的工作区（主工作区 = 仓库本身，其余是 git worktree；projectId 为 null 的是无仓库的目录工作区）：id、项目、设备、名称、路径、分支、是否主工作区、相对默认分支的 diff 增删行数。可按 projectId 筛选。",
      inputSchema: { projectId: z.string().optional().describe("只列某个项目下的工作区（list_projects 的 id）") },
      outputSchema: { workspaces: z.array(WorkspaceSchema) },
      annotations: readOnly,
    },
    async ({ projectId }) => {
      if (projectId !== undefined) {
        const project = await deps.store.getProject(projectId);
        if (!project || project.accountId !== accountId) return fail(`项目 ${projectId} ${NOT_FOUND}`);
        const workspaces = (await deps.store.listWorkspacesByProject(projectId)).filter((w) => w.accountId === accountId).map(workspaceView);
        return ok({ workspaces });
      }
      const workspaces = (await deps.store.listWorkspaces(accountId)).map(workspaceView);
      return ok({ workspaces });
    },
  );

  server.registerTool(
    "list_terminals",
    {
      title: "列出终端",
      description: "列出当前账号下的终端（coflux 里的任务，每个对应一个 PTY 会话）：id、工作区、标题、状态（idle/running/exited）、退出码、创建时间。可按 workspaceId 筛选。",
      inputSchema: { workspaceId: z.string().optional().describe("只列某个工作区下的终端（list_workspaces 的 id）") },
      outputSchema: { terminals: z.array(TerminalSchema) },
      annotations: readOnly,
    },
    async ({ workspaceId }) => {
      if (workspaceId !== undefined) {
        const workspace = await deps.store.getWorkspace(workspaceId);
        if (!workspace || workspace.accountId !== accountId) return fail(`工作区 ${workspaceId} ${NOT_FOUND}`);
        const terminals = (await deps.store.listTasksByWorkspace(workspaceId)).filter((t) => t.accountId === accountId).map(terminalView);
        return ok({ terminals });
      }
      const terminals = (await deps.store.listTasks(accountId)).map(terminalView);
      return ok({ terminals });
    },
  );

  server.registerTool(
    "read_terminal",
    {
      title: "读取终端内容",
      description:
        "读取某个终端当前画面的纯文本（已去 ANSI，默认最后 200 行，最多 2000 行）以及状态/退出码。内容来自中心缓存的会话快照，最多约 2 秒延迟；刚创建或刚开始跑的终端可能还没有快照（text 为空、snapshotAvailable=false）。",
      inputSchema: {
        terminalId: z.string().describe("终端 id（list_terminals 的 id）"),
        lines: z.number().int().min(1).max(MAX_READ_LINES).optional().describe(`返回最后多少行，默认 ${DEFAULT_READ_LINES}`),
      },
      outputSchema: {
        terminalId: z.string(),
        status: TerminalStatusSchema,
        exitCode: z.number().nullable(),
        title: z.string(),
        text: z.string(),
        snapshotAvailable: z.boolean(),
        capturedAt: z.number().nullable(),
      },
      annotations: readOnly,
    },
    async ({ terminalId, lines }) => {
      const task = await deps.store.getTask(terminalId);
      if (!task || task.accountId !== accountId) return fail(`终端 ${terminalId} ${NOT_FOUND}`);
      const checkpoint = await deps.store.getSessionCheckpointByTask(task.id);
      const n = lines ?? DEFAULT_READ_LINES;
      const text = checkpoint ? tailLines(stripAnsi(Buffer.from(checkpoint.ansiSnapshot).toString("utf8")), n) : "";
      return ok({
        terminalId: task.id,
        status: taskStatusName(task.status),
        exitCode: task.exitCode ?? null,
        title: checkpoint?.title || task.title,
        text,
        snapshotAvailable: !!checkpoint,
        capturedAt: checkpoint ? checkpoint.capturedAt : null,
      });
    },
  );

  server.registerTool(
    "list_ports",
    {
      title: "列出监听端口",
      description: "列出当前账号下终端里检测到的监听端口及可直接在浏览器打开的预览 URL（经 coflux 端口转发）。可按 workspaceId 筛选。",
      inputSchema: { workspaceId: z.string().optional().describe("只列某个工作区下终端的端口（list_workspaces 的 id）") },
      outputSchema: { ports: z.array(PortSchema) },
      annotations: readOnly,
    },
    async ({ workspaceId }) => {
      let tasks: Task[];
      if (workspaceId !== undefined) {
        const workspace = await deps.store.getWorkspace(workspaceId);
        if (!workspace || workspace.accountId !== accountId) return fail(`工作区 ${workspaceId} ${NOT_FOUND}`);
        tasks = (await deps.store.listTasksByWorkspace(workspaceId)).filter((t) => t.accountId === accountId);
      } else {
        tasks = await deps.store.listTasks(accountId);
      }
      const byTask = new Map(tasks.map((t) => [t.id, t] as const));
      const ports = deps.routeTable
        .listForAccount(accountId)
        .filter((route) => byTask.has(route.taskId))
        .map((route) => {
          const task = byTask.get(route.taskId)!;
          return { port: route.port, url: deps.buildPreviewUrl(route.shortId), terminalId: task.id, workspaceId: task.workspaceId, deviceId: task.daemonId };
        })
        .sort((a, b) => a.terminalId.localeCompare(b.terminalId) || a.port - b.port);
      return ok({ ports });
    },
  );

  return server;
}
