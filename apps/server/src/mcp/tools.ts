/**
 * `/mcp` 的 tools：六个只读（plan 090）+ 八个写/等（plan 091）。每个请求 new 一个 McpServer 绑定
 * principal，tool 实现只拿 principal + 中心既有的账号读法（store / hub.daemonInfoList / routeTable）
 * 与 hub 的操作层（McpOperations：准入事务 + 中心发起的 prepared 执行 + 完成原语），不碰 Request、
 * 不碰 Raven 上下文。
 *
 * 归属规则：列表按 principal.accountId 过滤；带 id 的入参先查实体再比对 accountId，不属于当前
 * 账号与不存在一律回同一句错误（不泄漏存在性）。写 tools 的归属校验在操作层内做（同一句错误）。
 *
 * 写 tools 的三条纪律（描述里也写给 agent 看）：人类优先（用户正在接管的终端拒绝输入）、有界等待
 * （wait 上限 600s 但受宿主单请求超时约束——手动 `claude mcp add` 的宿主默认 60s、coflux 插件的
 * .mcp.json 放到 ≥ 600s；建/删操作 30s 到期回「已提交」）、能力门禁（目标设备的 daemon 不支持本片
 * 控制消息时立即回「需要升级」，不等待）。
 */
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TaskStatus, type AccountId, type DaemonId, type ProjectId, type Task, type TaskId, type Workspace, type WorkspaceId } from "@coflux/protocol";
import type { OAuthPrincipal } from "../oauth.js";
import type { Store } from "../store.js";
import type { ProxyRouteTable } from "../proxy.js";
import type { OperationOutcome, TerminalReadSource } from "../hub.js";
import { stripAnsi, tailLines } from "./text.js";

/** hub 的操作层（plan 091）：写 tools 只经这些方法触达中心，错误一律是可读文案。 */
export interface McpOperations {
  createWorkspaceForAccount(accountId: AccountId, input: { projectId: ProjectId; branch: string; createNew: boolean; name?: string }): Promise<OperationOutcome<Workspace>>;
  renameWorkspaceForAccount(accountId: AccountId, workspaceId: WorkspaceId, name: string): Promise<OperationOutcome<Workspace>>;
  removeWorkspaceForAccount(accountId: AccountId, workspaceId: WorkspaceId): Promise<OperationOutcome<{ workspaceId: WorkspaceId; removedTerminalIds: TaskId[] }>>;
  createTerminalForAccount(accountId: AccountId, input: { workspaceId: WorkspaceId; title: string; command: string }): Promise<OperationOutcome<Task>>;
  readTerminalForAccount(accountId: AccountId, terminalId: TaskId, maxBytes?: number): Promise<OperationOutcome<{ task: Task; data: Uint8Array; source: TerminalReadSource; capturedAt: number | null; title: string }>>;
  sendTerminalInputForAccount(accountId: AccountId, terminalId: TaskId, data: Uint8Array): Promise<OperationOutcome<{ bytes: number }>>;
  waitTerminalForAccount(accountId: AccountId, terminalId: TaskId, timeoutMs?: number): Promise<OperationOutcome<{ task: Task; exited: boolean; timedOut: boolean }>>;
  stopTerminalForAccount(accountId: AccountId, terminalId: TaskId): Promise<OperationOutcome<{ task: Task; exited: boolean }>>;
  removeTerminalForAccount(accountId: AccountId, terminalId: TaskId): Promise<OperationOutcome<TaskId>>;
}

/** tool 层需要的中心读法：hub 暴露设备在线态、端口路由表与操作层，其余走 store。 */
export interface McpToolDeps {
  store: Store;
  listDaemons: (accountId: AccountId) => Promise<DaemonInfoLike[]>;
  routeTable: Pick<ProxyRouteTable, "listForAccount" | "portsForTask">;
  buildPreviewUrl: (shortId: string) => string;
  ops: McpOperations;
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
/** wait_terminal 的默认/上限秒数：与 hub 的 TERMINAL_WAIT_* 一致（plan 094 上限 600s）。真正的天花板是宿主的
 * 单请求超时：手动 `claude mcp add` 的宿主默认 60s，coflux 插件的 .mcp.json 把 timeout 放到 ≥ 600s——描述里写明让
 * agent 自己权衡。 */
const WAIT_DEFAULT_SECONDS = 30;
const WAIT_MAX_SECONDS = 600;
/** 「需要升级」错误的含义写进每个写 tool 的描述，agent 才知道该让用户升级而不是重试。 */
const UPGRADE_NOTE = "目标设备的 daemon 不支持本操作时立即返回「该设备的 daemon 需要升级」——让用户在该设备上跑 `cofluxd update && cofluxd restart`，不要重试。";

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

const TerminalReadSourceSchema = z.enum(["log", "snapshot", "checkpoint", "none"]);

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
        "读取某个终端的输出纯文本（已去 ANSI，默认最后 200 行，最多 2000 行）以及状态/退出码。来源（source）按优先级：log = 该终端是 create_terminal 开的命令终端，读的是设备上的完整命令日志尾部（秒级命令的输出也在，退出后仍可读）；snapshot = 设备上会话的当前画面；checkpoint = 设备离线或不支持时退回中心缓存的最近快照（最多约 2 秒延迟、只有一屏）；none = 什么都没有（刚创建还没输出）。",
      inputSchema: {
        terminalId: z.string().describe("终端 id（list_terminals / create_terminal 的 id）"),
        lines: z.number().int().min(1).max(MAX_READ_LINES).optional().describe(`返回最后多少行，默认 ${DEFAULT_READ_LINES}`),
      },
      outputSchema: {
        terminalId: z.string(),
        status: TerminalStatusSchema,
        exitCode: z.number().nullable(),
        title: z.string(),
        text: z.string(),
        source: TerminalReadSourceSchema,
        snapshotAvailable: z.boolean(),
        capturedAt: z.number().nullable(),
      },
      annotations: readOnly,
    },
    async ({ terminalId, lines }) => {
      const read = await deps.ops.readTerminalForAccount(accountId, terminalId);
      if (!read.ok) return fail(read.error);
      const n = lines ?? DEFAULT_READ_LINES;
      const { task, data, source, capturedAt, title } = read.value;
      const text = data.byteLength ? tailLines(stripAnsi(Buffer.from(data).toString("utf8")), n) : "";
      return ok({
        terminalId: task.id,
        status: taskStatusName(task.status),
        exitCode: task.exitCode ?? null,
        title,
        text,
        source,
        snapshotAvailable: source !== "none",
        capturedAt,
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

  /* ==================== 写 / 等 tools（plan 091） ==================== */
  const mutating = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;
  const destructive = { readOnlyHint: false, destructiveHint: true, openWorldHint: false } as const;

  server.registerTool(
    "create_workspace",
    {
      title: "创建工作区（git worktree）",
      description:
        `在某个项目下新建一个 git worktree 工作区：给定分支名（可选新建分支），设备会真的在磁盘上 \`git worktree add\`，web 侧栏同步出现。适合「开一个隔离的工作区跑子任务」。设备离线时明确报错。最多等 30 秒，到期返回「已提交」并附 workspaceId，稍后用 list_workspaces 查。${UPGRADE_NOTE}`,
      inputSchema: {
        projectId: z.string().describe("项目 id（list_projects 的 id）"),
        branch: z.string().describe("分支名；createNew=false 时必须已存在，true 时新建"),
        createNew: z.boolean().optional().describe("是否新建该分支（默认 false）"),
        name: z.string().optional().describe("工作区名称（纯展示，默认同分支名）"),
      },
      outputSchema: { workspace: WorkspaceSchema },
      annotations: mutating,
    },
    async ({ projectId, branch, createNew, name }) => {
      const result = await deps.ops.createWorkspaceForAccount(accountId, { projectId, branch, createNew: createNew ?? false, name });
      if (!result.ok) return fail(result.error);
      return ok({ workspace: workspaceView(result.value) });
    },
  );

  server.registerTool(
    "rename_workspace",
    {
      title: "重命名工作区",
      description: "改工作区名称（纯中心记录，不动磁盘/分支）；主工作区也可改。空名回落为分支名。",
      inputSchema: {
        workspaceId: z.string().describe("工作区 id（list_workspaces 的 id）"),
        name: z.string().describe("新名称"),
      },
      outputSchema: { workspace: WorkspaceSchema },
      annotations: mutating,
    },
    async ({ workspaceId, name }) => {
      const result = await deps.ops.renameWorkspaceForAccount(accountId, workspaceId, name);
      if (!result.ok) return fail(result.error);
      return ok({ workspace: workspaceView(result.value) });
    },
  );

  server.registerTool(
    "remove_workspace",
    {
      title: "删除工作区",
      description:
        `删除一个 worktree 工作区：先关掉其下所有终端会话，再在设备上 \`git worktree remove --force\` 并删除记录（未提交的改动会丢）。主工作区不可删（要删就删整个项目）；无仓库的目录工作区只删记录。最多等 30 秒。${UPGRADE_NOTE}`,
      inputSchema: { workspaceId: z.string().describe("工作区 id（list_workspaces 的 id）") },
      outputSchema: { workspaceId: z.string(), removedTerminalIds: z.array(z.string()) },
      annotations: destructive,
    },
    async ({ workspaceId }) => {
      const result = await deps.ops.removeWorkspaceForAccount(accountId, workspaceId);
      if (!result.ok) return fail(result.error);
      return ok(result.value);
    },
  );

  server.registerTool(
    "create_terminal",
    {
      title: "开终端跑一条命令",
      description:
        `在某个工作区目录下开一个真实终端（web 侧栏可见、用户可随时接管）跑一条命令：命令在登录 shell 里执行，跑完终端退出并带退出码；输出同时落设备上的命令日志，用 read_terminal 读（source=log）。想跑交互式程序也可以（例如 \`claude\`），之后用 send_terminal_input 输入、wait_terminal 等退出。受每工作区活跃终端上限约束（含用户手开的），超限时先 stop_terminal 一些。最多等 30 秒启动回执，到期返回「已提交」并附 terminalId。${UPGRADE_NOTE}`,
      inputSchema: {
        workspaceId: z.string().describe("工作区 id（list_workspaces / create_workspace 的 id）"),
        command: z.string().describe("要执行的命令（交给登录 shell 的 -lc，可含管道/多条）"),
        title: z.string().optional().describe("终端标题（侧栏展示，默认取命令首行）"),
      },
      outputSchema: { terminal: TerminalSchema },
      annotations: mutating,
    },
    async ({ workspaceId, command, title }) => {
      const result = await deps.ops.createTerminalForAccount(accountId, { workspaceId, title: title ?? "", command });
      if (!result.ok) return fail(result.error);
      return ok({ terminal: terminalView(result.value) });
    },
  );

  server.registerTool(
    "send_terminal_input",
    {
      title: "往终端输入",
      description:
        `往正在运行的终端写一段文本（可选追加回车），经设备上会话的正门写入 PTY。人类优先：用户正在接管（attach）该终端时会被拒，错误里写明「用户正在接管」——此时把交互留给用户，不要重试。终端已退出/尚未就绪时明确报错。回执超时表示写入结果未知：先 read_terminal 看看再决定是否重发。先 read 再 send 是好习惯。${UPGRADE_NOTE}`,
      inputSchema: {
        terminalId: z.string().describe("终端 id"),
        text: z.string().describe("要写入的文本"),
        enter: z.boolean().optional().describe("是否在末尾追加回车（默认 true）"),
      },
      outputSchema: { terminalId: z.string(), bytes: z.number() },
      annotations: mutating,
    },
    async ({ terminalId, text, enter }) => {
      const data = Buffer.from(enter === false ? text : `${text}\r`, "utf8");
      const result = await deps.ops.sendTerminalInputForAccount(accountId, terminalId, new Uint8Array(data));
      if (!result.ok) return fail(result.error);
      return ok({ terminalId, bytes: result.value.bytes });
    },
  );

  server.registerTool(
    "wait_terminal",
    {
      title: "等终端退出",
      description:
        `阻塞等某个终端退出并返回退出码。有上限：timeoutSeconds 默认 ${WAIT_DEFAULT_SECONDS}、最大 ${WAIT_MAX_SECONDS}；到期返回当前状态（exited=false、timedOut=true），不是错误——需要更久就再调一次。注意宿主的单请求超时是真正的天花板：手动 \`claude mcp add\` 的 Claude Code 默认 60 秒，此时 timeoutSeconds 别超过 50；经 coflux 插件接入的宿主 timeout 已放宽到 600 秒以上。`,
      inputSchema: {
        terminalId: z.string().describe("终端 id"),
        timeoutSeconds: z.number().min(1).max(WAIT_MAX_SECONDS).optional().describe(`最多等多少秒，默认 ${WAIT_DEFAULT_SECONDS}，上限 ${WAIT_MAX_SECONDS}`),
      },
      outputSchema: { terminal: TerminalSchema, exited: z.boolean(), timedOut: z.boolean(), exitCode: z.number().nullable() },
      annotations: readOnly,
    },
    async ({ terminalId, timeoutSeconds }) => {
      const result = await deps.ops.waitTerminalForAccount(accountId, terminalId, timeoutSeconds === undefined ? undefined : timeoutSeconds * 1000);
      if (!result.ok) return fail(result.error);
      const { task, exited, timedOut } = result.value;
      return ok({ terminal: terminalView(task), exited, timedOut, exitCode: exited ? task.exitCode ?? null : null });
    },
  );

  server.registerTool(
    "stop_terminal",
    {
      title: "停止终端",
      description: "结束终端会话（等价 web 上的停止：关闭 PTY，命令被终止）。返回时会话已退出（exited=true）或已在退出中（exited=false，稍后 wait_terminal）。已退出的终端直接返回。",
      inputSchema: { terminalId: z.string().describe("终端 id") },
      outputSchema: { terminal: TerminalSchema, exited: z.boolean() },
      annotations: destructive,
    },
    async ({ terminalId }) => {
      const result = await deps.ops.stopTerminalForAccount(accountId, terminalId);
      if (!result.ok) return fail(result.error);
      return ok({ terminal: terminalView(result.value.task), exited: result.value.exited });
    },
  );

  server.registerTool(
    "remove_terminal",
    {
      title: "删除终端记录",
      description: "删除终端记录（含中心缓存的快照）。仍在运行的终端必须先 stop_terminal，否则明确报错。",
      inputSchema: { terminalId: z.string().describe("终端 id") },
      outputSchema: { terminalId: z.string() },
      annotations: destructive,
    },
    async ({ terminalId }) => {
      const result = await deps.ops.removeTerminalForAccount(accountId, terminalId);
      if (!result.ok) return fail(result.error);
      return ok({ terminalId: result.value });
    },
  );

  return server;
}
