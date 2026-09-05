/**
 * plan 090：中心托管 MCP 第一片——OAuth 2.1 授权服务器 + `/mcp` 端点 + 只读 tools。
 *
 * 黑盒：fetch 直接打 OAuth 与 MCP 端点（JSON-RPC over HTTP），确认页那一跳用测试 WS Client 发同款消息。
 * 覆盖：
 *   - 无 token 401 且 WWW-Authenticate 带可解析的 resource_metadata；PRM → AS 元数据可被宿主发现流程消费；
 *   - 完整授权码流程：DCR → authorize 302 → 登录确认 → 换 token → initialize / tools/list → 六个只读 tools 正向；
 *   - 负向：PKCE verifier 不符、授权码二次使用（并整链撤销）、refresh 轮换后旧 refresh 失效、
 *     非 loopback 且未注册的 redirect_uri、拒绝授权回调带 access_denied、坏 token 401。
 *
 * 注意 read_terminal 自 091 起优先经 daemon 读（用户手开的终端走 sessiond 快照，source=snapshot），
 * 设备离线才退回中心 checkpoint；这里仍先等观察端收到含 marker 的 sessionCheckpoint 再读，两条路径都稳。
 *
 * 端口：主栈 8866（refresh 复用宽限设 0，保住"重放即整链撤销"断言）；宽限正向用例另起只有 server 的 8868。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TaskStatus } from "@coflux/protocol";
import { startStack, startServer, mkRepo } from "./harness.mjs";
import { openRelayDevice, utf8 } from "./device-harness.mjs";
import {
  callTool,
  consent,
  consentClient,
  exchangeCode,
  mcpInitialize,
  mcpListTools,
  mcpRequest,
  obtainTokens,
  parseWwwAuthenticate,
  pkce,
  refreshTokens,
  registerClient,
  requestIdFromConsentUrl,
  startAuthorization,
  waitForSince,
} from "./oauth-harness.mjs";

const PORT = 8866;
const BASE = `http://127.0.0.1:${PORT}`;
const GRACE_PORT = 8868;
const GRACE_BASE = `http://127.0.0.1:${GRACE_PORT}`;
// 090 的六个只读 + 091 的八个写/等 tools（写 tools 的行为在 mcp-write-tools.test.mjs 验收）
const EXPECTED_TOOLS = [
  "list_devices", "list_projects", "list_workspaces", "list_terminals", "read_terminal", "list_ports",
  "create_workspace", "rename_workspace", "remove_workspace",
  "create_terminal", "send_terminal_input", "wait_terminal", "stop_terminal", "remove_terminal",
];

const HTTP_SERVER_SRC = `
const http = require("http");
const server = http.createServer((req, res) => { res.end("hello-from-pty"); });
server.listen(0, "127.0.0.1", () => { console.log("PORT=" + server.address().port); });
`;

let stack;
let repo;
/** daemon 导入时对仓库路径做了 realpath（macOS 的 /var → /private/var），比较一律用它。 */
let repoPath;
let device;
let consentWs;
let clientId;
let tokens;
let projectId;
let workspaceId;
let taskId;
let sessionId;

before(async () => {
  stack = await startStack({ port: PORT, serverEnv: { COFLUX_PUBLIC_URL: BASE, COFLUX_OAUTH_REFRESH_REUSE_GRACE_MS: "0" } });
  consentWs = await consentClient(stack);
});

after(async () => {
  consentWs?.close();
  device?.close();
  await stack?.stop();
  repo?.cleanup();
});

test("无 token 调 /mcp → 401 且 WWW-Authenticate 带 resource_metadata；元数据链路可被发现", async () => {
  const anon = await mcpRequest(BASE, null, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "0" } });
  assert.equal(anon.status, 401);
  const challenge = parseWwwAuthenticate(anon.headers.get("www-authenticate"));
  assert.ok(challenge?.resource_metadata, "401 挑战带 resource_metadata");
  assert.ok(challenge.resource_metadata.startsWith(BASE), "resource_metadata 由 COFLUX_PUBLIC_URL 拼出");

  const prm = await (await fetch(challenge.resource_metadata)).json();
  assert.equal(prm.resource, `${BASE}/mcp`);
  assert.deepEqual(prm.authorization_servers, [BASE]);

  const as = await (await fetch(`${prm.authorization_servers[0]}/.well-known/oauth-authorization-server`)).json();
  assert.equal(as.issuer, BASE);
  assert.equal(as.authorization_endpoint, `${BASE}/oauth/authorize`);
  assert.equal(as.token_endpoint, `${BASE}/oauth/token`);
  assert.equal(as.registration_endpoint, `${BASE}/oauth/register`);
  assert.ok(as.code_challenge_methods_supported.includes("S256"));
  assert.ok(as.grant_types_supported.includes("refresh_token"));
  assert.ok(as.token_endpoint_auth_methods_supported.includes("none"));

  // 根路径形式的 PRM 也要在（宿主按资源 URL 推导时可能取它）
  const prmRoot = await (await fetch(`${BASE}/.well-known/oauth-protected-resource`)).json();
  assert.equal(prmRoot.resource, `${BASE}/mcp`);
});

test("完整授权码流程：DCR → authorize 302 → 登录确认 → 换 token", async () => {
  const reg = await registerClient(BASE, { client_name: "Claude Code (test)" });
  assert.equal(reg.status, 201);
  assert.ok(typeof reg.json.client_id === "string" && reg.json.client_id.length > 16);
  assert.equal(reg.json.token_endpoint_auth_method, "none");
  clientId = reg.json.client_id;

  const { verifier, challenge } = pkce();
  const redirectUri = "http://localhost:51234/callback"; // 注册的是 http://localhost/callback：loopback 任意端口/路径
  const auth = await startAuthorization(BASE, { clientId, redirectUri, challenge, state: "st-1", resource: `${BASE}/mcp` });
  assert.equal(auth.status, 302);
  assert.ok(auth.location.includes("/oauth/consent?request="), `302 落到 web 确认页：${auth.location}`);
  const requestId = requestIdFromConsentUrl(auth.location);

  const { info, result } = await consent(consentWs, requestId, true);
  assert.equal(info.ok, true);
  assert.equal(info.clientName, "Claude Code (test)");
  assert.equal(info.redirectHost, "localhost:51234");
  assert.equal(result.ok, true);
  const callback = new URL(result.redirectUrl);
  assert.ok(result.redirectUrl.startsWith("http://localhost:51234/callback?"), "跳回宿主的回调地址");
  assert.equal(callback.searchParams.get("state"), "st-1");
  assert.equal(callback.searchParams.get("iss"), BASE);
  const code = callback.searchParams.get("code");
  assert.ok(code);

  // 同一请求 id 二次查询：已被消费
  const again = await consent(consentWs, requestId, true);
  assert.equal(again.info.ok, false);

  const token = await exchangeCode(BASE, { code, clientId, verifier, redirectUri });
  assert.equal(token.status, 200, JSON.stringify(token.json));
  assert.equal(token.json.token_type, "Bearer");
  assert.ok(token.json.access_token.startsWith("cf_oat_"));
  assert.ok(token.json.refresh_token.startsWith("cf_ort_"));
  assert.ok(token.json.expires_in > 0);
  tokens = token.json;
});

test("initialize / tools/list：六个只读 + 八个写/等 tools 可见", async () => {
  const init = await mcpInitialize(BASE, tokens.access_token);
  assert.equal(init.status, 200, JSON.stringify(init.json));
  assert.equal(init.json.result.serverInfo.name, "coflux");
  assert.ok(init.json.result.capabilities.tools, "声明 tools 能力");

  const list = await mcpListTools(BASE, tokens.access_token);
  assert.equal(list.status, 200);
  const names = list.json.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, [...EXPECTED_TOOLS].sort());
  const readTerminal = list.json.result.tools.find((t) => t.name === "read_terminal");
  assert.ok(readTerminal.inputSchema.properties.terminalId, "read_terminal 入参含 terminalId");
  assert.ok(readTerminal.description.includes("2 秒"), "描述写明 checkpoint 延迟");
});

test("坏 token → 401 且 error=invalid_token", async () => {
  const bad = await mcpListTools(BASE, "cf_oat_definitely-not-a-token");
  assert.equal(bad.status, 401);
  const challenge = parseWwwAuthenticate(bad.headers.get("www-authenticate"));
  assert.equal(challenge.error, "invalid_token");
  assert.ok(challenge.resource_metadata);
});

test("造账号资产：设备在线、导入项目、开终端并留下输出", async () => {
  repo = mkRepo();
  repoPath = realpathSync(repo.dir);
  writeFileSync(join(repo.dir, "server-http.js"), HTTP_SERVER_SRC);
  device = await openRelayDevice(stack);
  const c = device.control;
  c.send({ case: "projectImport", daemonId: stack.daemonId, path: repo.dir });
  const created = await c.waitFor((m) => m.case === "workspaceCreated" && m.workspace.isMain, "main workspace", 20000);
  workspaceId = created.workspace.id;
  projectId = created.workspace.projectId;
  assert.ok(projectId);

  c.send({ case: "taskCreate", workspaceId, title: "mcp-read" });
  const idle = await c.waitFor((m) => m.case === "taskUpdated" && m.task.title === "mcp-read", "task idle");
  taskId = idle.task.id;
  c.send({ case: "taskStart", taskId, cols: 80, rows: 24 });
  const running = await c.waitFor(
    (m) => m.case === "taskUpdated" && m.task.id === taskId && m.task.status === TaskStatus.RUNNING && m.task.sessionId,
    "task running",
    15000,
  );
  sessionId = running.task.sessionId;
  await device.attach(sessionId);
  await device.input(sessionId, "echo MCP_READ_MARKER_42\r");
  // checkpoint 是 2 秒周期缓存：先等观察端看到含 marker 的 checkpoint，再让 tool 去读
  const observer = stack.makeClient();
  await observer.authSubscribe();
  await observer.waitFor(
    (m) => m.case === "sessionCheckpoint" && m.sessionId === sessionId && utf8(m.ansiSnapshot).includes("MCP_READ_MARKER_42"),
    "checkpoint with marker",
    15000,
  );
  observer.close();
});

test("list_devices：看到在线 daemon", async () => {
  const r = await callTool(BASE, tokens.access_token, "list_devices");
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok(!r.result.isError);
  const devices = r.result.structuredContent.devices;
  const mine = devices.find((d) => d.id === stack.daemonId);
  assert.ok(mine, "账号下有本栈的 daemon");
  assert.equal(mine.online, true);
  assert.equal(mine.name, "test-dev");
  assert.ok(mine.workerVersion.length > 0, "在线设备带 worker 版本");
  // content 文本与 structuredContent 同内容
  assert.deepEqual(JSON.parse(r.result.content[0].text).devices, devices);
});

test("list_projects：看到导入的仓库", async () => {
  const r = await callTool(BASE, tokens.access_token, "list_projects");
  assert.ok(!r.result.isError);
  const project = r.result.structuredContent.projects.find((p) => p.id === projectId);
  assert.ok(project);
  assert.equal(project.repoPath, repoPath);
  assert.equal(project.deviceId, stack.daemonId);
  assert.ok(project.defaultBranch);
});

test("list_workspaces：全量与按项目筛", async () => {
  const all = await callTool(BASE, tokens.access_token, "list_workspaces");
  assert.ok(!all.result.isError);
  const main = all.result.structuredContent.workspaces.find((w) => w.id === workspaceId);
  assert.ok(main);
  assert.equal(main.isMain, true);
  assert.equal(main.projectId, projectId);
  assert.equal(main.path, repoPath);
  assert.equal(typeof main.additions, "number");

  const filtered = await callTool(BASE, tokens.access_token, "list_workspaces", { projectId });
  assert.ok(!filtered.result.isError);
  assert.deepEqual(filtered.result.structuredContent.workspaces.map((w) => w.id), [workspaceId]);

  const missing = await callTool(BASE, tokens.access_token, "list_workspaces", { projectId: "no-such-project" });
  assert.equal(missing.result.isError, true);
  assert.ok(missing.result.content[0].text.includes("不存在或不属于当前账号"));
});

test("list_terminals：全量与按工作区筛", async () => {
  const all = await callTool(BASE, tokens.access_token, "list_terminals");
  assert.ok(!all.result.isError);
  const mine = all.result.structuredContent.terminals.find((t) => t.id === taskId);
  assert.ok(mine);
  assert.equal(mine.workspaceId, workspaceId);
  assert.equal(mine.title, "mcp-read");
  assert.equal(mine.status, "running");
  assert.equal(mine.exitCode, null);

  const filtered = await callTool(BASE, tokens.access_token, "list_terminals", { workspaceId });
  assert.ok(filtered.result.structuredContent.terminals.some((t) => t.id === taskId));
});

test("read_terminal：去 ANSI 的纯文本尾 N 行", async () => {
  const r = await callTool(BASE, tokens.access_token, "read_terminal", { terminalId: taskId });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok(!r.result.isError, JSON.stringify(r.result));
  const out = r.result.structuredContent;
  assert.equal(out.terminalId, taskId);
  assert.equal(out.status, "running");
  assert.equal(out.snapshotAvailable, true);
  assert.ok(out.capturedAt > 0);
  assert.ok(["snapshot", "checkpoint"].includes(out.source), `用户手开的终端来源是 snapshot（在线）或 checkpoint：${out.source}`);
  assert.ok(out.text.includes("MCP_READ_MARKER_42"), `终端文本含 marker：${JSON.stringify(out.text)}`);
  // eslint-disable-next-line no-control-regex
  assert.ok(!/\x1b/.test(out.text), "已去 ANSI");
  assert.ok(!out.text.endsWith("\n"), "尾部空行已去");

  const short = await callTool(BASE, tokens.access_token, "read_terminal", { terminalId: taskId, lines: 1 });
  assert.equal(short.result.structuredContent.text.split("\n").length, 1);

  const missing = await callTool(BASE, tokens.access_token, "read_terminal", { terminalId: "no-such-terminal" });
  assert.equal(missing.result.isError, true);
});

test("list_ports：终端里起的监听端口带预览 URL", async () => {
  const c = device.control;
  const since = c.log.length;
  await device.input(sessionId, "node server-http.js\r");
  const updated = await waitForSince(c, since, (m) => m.case === "portsUpdated" && m.taskId === taskId && m.ports.length > 0, "ports.updated", 15000);
  const port = updated.ports[0].port;

  const all = await callTool(BASE, tokens.access_token, "list_ports");
  assert.ok(!all.result.isError);
  const entry = all.result.structuredContent.ports.find((p) => p.terminalId === taskId && p.port === port);
  assert.ok(entry, "list_ports 看到终端里起的端口");
  assert.ok(entry.url.startsWith("http"), "带预览 URL");
  assert.equal(entry.workspaceId, workspaceId);
  assert.equal(entry.deviceId, stack.daemonId);

  const filtered = await callTool(BASE, tokens.access_token, "list_ports", { workspaceId });
  assert.ok(filtered.result.structuredContent.ports.some((p) => p.port === port));
  const missing = await callTool(BASE, tokens.access_token, "list_ports", { workspaceId: "no-such-workspace" });
  assert.equal(missing.result.isError, true);
});

test("负向：PKCE verifier 不符被拒", async () => {
  const { challenge } = pkce();
  const redirectUri = "http://127.0.0.1:40001/cb";
  const auth = await startAuthorization(BASE, { clientId, redirectUri, challenge, state: "pk" });
  assert.equal(auth.status, 302);
  const { result } = await consent(consentWs, requestIdFromConsentUrl(auth.location), true);
  const code = new URL(result.redirectUrl).searchParams.get("code");
  const wrong = await exchangeCode(BASE, { code, clientId, verifier: pkce().verifier, redirectUri });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.json.error, "invalid_grant");
});

test("负向：授权码二次使用被拒，且首次签出的 token 整链作废", async () => {
  const { verifier, challenge } = pkce();
  const redirectUri = "http://127.0.0.1:40002/cb";
  const auth = await startAuthorization(BASE, { clientId, redirectUri, challenge });
  const { result } = await consent(consentWs, requestIdFromConsentUrl(auth.location), true);
  const code = new URL(result.redirectUrl).searchParams.get("code");
  const first = await exchangeCode(BASE, { code, clientId, verifier, redirectUri });
  assert.equal(first.status, 200);
  const okBefore = await mcpListTools(BASE, first.json.access_token);
  assert.equal(okBefore.status, 200);

  const second = await exchangeCode(BASE, { code, clientId, verifier, redirectUri });
  assert.equal(second.status, 400);
  assert.equal(second.json.error, "invalid_grant");
  const revoked = await mcpListTools(BASE, first.json.access_token);
  assert.equal(revoked.status, 401, "重放后首次签出的 access 也失效");
});

test("负向：refresh 轮换后旧 refresh 被拒（宽限 0：重放即整链撤销），新 access 可用", async () => {
  const rotated = await refreshTokens(BASE, { refreshToken: tokens.refresh_token, clientId });
  assert.equal(rotated.status, 200, JSON.stringify(rotated.json));
  assert.notEqual(rotated.json.access_token, tokens.access_token);
  assert.notEqual(rotated.json.refresh_token, tokens.refresh_token);
  const fresh = await mcpListTools(BASE, rotated.json.access_token);
  assert.equal(fresh.status, 200);

  const replay = await refreshTokens(BASE, { refreshToken: tokens.refresh_token, clientId });
  assert.equal(replay.status, 400);
  assert.equal(replay.json.error, "invalid_grant");
  // 旧 refresh 重放 = 泄露信号：整链撤销，轮换出来的新 token 也一并作废
  const chained = await mcpListTools(BASE, rotated.json.access_token);
  assert.equal(chained.status, 401);

  // 换 client_id 不匹配也拒
  const other = await registerClient(BASE);
  const stolen = await obtainTokens(BASE, consentWs, { clientId });
  const mismatch = await refreshTokens(BASE, { refreshToken: stolen.refresh_token, clientId: other.json.client_id });
  assert.equal(mismatch.status, 400);
  assert.equal(mismatch.json.error, "invalid_grant");
  tokens = stolen;
});

test("refresh 复用宽限：并发轮换时旧 refresh 在宽限内再换到新 token，旧链不撤", async () => {
  // 同机两个宿主进程共用一份 token 的场景：宽限设得很长，不靠 sleep 卡时间窗
  const server = await startServer({
    port: GRACE_PORT,
    env: { COFLUX_PASSWORD: "admin", COFLUX_PUBLIC_URL: GRACE_BASE, COFLUX_OAUTH_REFRESH_REUSE_GRACE_MS: "600000" },
  });
  let ws;
  try {
    ws = await consentClient(server);
    const first = await obtainTokens(GRACE_BASE, ws);
    const second = await refreshTokens(GRACE_BASE, { refreshToken: first.refresh_token, clientId: first.clientId });
    assert.equal(second.status, 200, JSON.stringify(second.json));
    // 另一个进程拿着同一个（刚被轮换掉的）refresh 再来换
    const reused = await refreshTokens(GRACE_BASE, { refreshToken: first.refresh_token, clientId: first.clientId });
    assert.equal(reused.status, 200, `宽限内复用应拿到新 token：${JSON.stringify(reused.json)}`);
    assert.notEqual(reused.json.access_token, second.json.access_token);
    assert.notEqual(reused.json.refresh_token, second.json.refresh_token);
    // 两边的 access 都能用：没有整链撤销
    assert.equal((await mcpListTools(GRACE_BASE, second.json.access_token)).status, 200, "第一次轮换出的 access 未被撤");
    assert.equal((await mcpListTools(GRACE_BASE, reused.json.access_token)).status, 200, "宽限内复用签出的 access 可用");
    // 各自拿到的新 refresh 也都能继续轮换
    const third = await refreshTokens(GRACE_BASE, { refreshToken: second.json.refresh_token, clientId: first.clientId });
    assert.equal(third.status, 200, JSON.stringify(third.json));
    const fourth = await refreshTokens(GRACE_BASE, { refreshToken: reused.json.refresh_token, clientId: first.clientId });
    assert.equal(fourth.status, 200, JSON.stringify(fourth.json));
    // 换 client_id 仍拒，宽限不放松客户端绑定
    const other = await registerClient(GRACE_BASE);
    const mismatch = await refreshTokens(GRACE_BASE, { refreshToken: first.refresh_token, clientId: other.json.client_id });
    assert.equal(mismatch.status, 400);
    assert.equal(mismatch.json.error, "invalid_grant");
  } finally {
    ws?.close();
    await server.stop();
  }
});

test("负向：非 loopback 且未注册的 redirect_uri 直接 400，不跳转", async () => {
  const { challenge } = pkce();
  const evil = await startAuthorization(BASE, { clientId, redirectUri: "https://evil.example/cb", challenge });
  assert.equal(evil.status, 400);
  assert.equal(evil.json.error, "invalid_request");
  const unknown = await startAuthorization(BASE, { clientId: "cf_oc_nope", redirectUri: "http://localhost/cb", challenge });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.json.error, "invalid_client");
  // 注册时非 loopback 的 http 回调也拒
  const badReg = await registerClient(BASE, { redirect_uris: ["http://example.com/cb"] });
  assert.equal(badReg.status, 400);
  assert.equal(badReg.json.error, "invalid_redirect_uri");
  // 缺 PKCE：redirect_uri 合法，按规范带 error 跳回宿主
  const noPkce = await startAuthorization(BASE, { clientId, redirectUri: "http://localhost:1/cb", challenge: undefined, method: undefined, state: "np" });
  assert.equal(noPkce.status, 302);
  const back = new URL(noPkce.location);
  assert.equal(back.searchParams.get("error"), "invalid_request");
  assert.equal(back.searchParams.get("state"), "np");
});

test("负向：拒绝授权 → 回调带 error=access_denied 与原 state", async () => {
  const { challenge } = pkce();
  const auth = await startAuthorization(BASE, { clientId, redirectUri: "http://localhost:40003/cb", challenge, state: "deny-1" });
  const { info, result } = await consent(consentWs, requestIdFromConsentUrl(auth.location), false);
  assert.equal(info.ok, true);
  assert.equal(result.ok, true);
  const back = new URL(result.redirectUrl);
  assert.equal(back.origin + back.pathname, "http://localhost:40003/cb");
  assert.equal(back.searchParams.get("error"), "access_denied");
  assert.equal(back.searchParams.get("state"), "deny-1");
  assert.equal(back.searchParams.get("code"), null);
});

test("GET /mcp 无状态回 405，未知 OAuth 子路径回 OAuth 信封", async () => {
  const get = await fetch(`${BASE}/mcp`, { headers: { accept: "text/event-stream", authorization: `Bearer ${tokens.access_token}` } });
  assert.equal(get.status, 405);
  const unknown = await fetch(`${BASE}/oauth/nope`);
  assert.equal(unknown.status, 404);
  const body = await unknown.json();
  assert.equal(body.error, "invalid_request");
  const badJson = await fetch(`${BASE}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" });
  assert.equal(badJson.status, 400);
  assert.equal((await badJson.json()).error, "invalid_request");
});
