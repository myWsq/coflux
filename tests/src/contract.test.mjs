import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { FsEntryKind } from "@coflux/protocol";
import { startStack, mkRepo } from "./harness.mjs";
import { openNativeDevice } from "./device-harness.mjs";

const PORT = 8826;
let stack;
let accountToken;
const repos = [];

before(async () => {
  stack = await startStack({ port: PORT });
  // 一次登录复用给本文件的账号操作（密码登录有来源限速，别一条用例一次）。
  const login = await fetch(`http://127.0.0.1:${PORT}/api/client/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ protocolVersion: 1, username: "admin", password: "admin" }),
  });
  const body = await login.json();
  assert.equal(body.ok, true, `账号登录失败：${body.error ?? login.status}`);
  accountToken = body.value.token;
});
after(async () => { await stack?.stop(); repos.forEach((r) => r.cleanup()); });

/** 一条账号操作（`/api/client/command`），原样回带 `{ ok, value | error }`。 */
async function accountCommand(command) {
  const response = await fetch(`http://127.0.0.1:${PORT}/api/client/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accountToken}` },
    body: JSON.stringify({ protocolVersion: 1, command }),
  });
  return await response.json();
}
/** `coflux device exec` 的中心入口。 */
function deviceExec(fields) {
  return accountCommand({ op: "device.exec", deviceId: stack.daemonId, ...fields });
}

// 在一个 workspace 里发请求并等回带（按 requestId 关联）的辅助
async function importWorkspace(device) {
  const c = device.control;
  const repo = mkRepo();
  repos.push(repo);
  // 放点文件供 fs 测试
  writeFileSync(join(repo.dir, "README.md"), "# hi\nhello world\n");
  mkdirSync(join(repo.dir, "src"), { recursive: true });
  writeFileSync(join(repo.dir, "src", "a.txt"), "AAA");
  c.send({ case: "projectImport", daemonId: stack.daemonId, path: repo.dir });
  const main = await c.waitFor((m) => m.case === "workspaceCreated" && m.workspace.isMain, "main ws");
  await device.waitWorkspaceReady(main.workspace.id);
  return main.workspace;
}

test("exec：在工作区里跑命令，结构化回带 stdout/exitCode", async () => {
  const device = await openNativeDevice(stack);
  const c = device.control;
  const ws = await importWorkspace(device);
  const r = await device.request("execRun", "execResult", {
    requestId: "e1",
    workspaceId: ws.id,
    command: "node",
    args: ["-e", "console.log('SUM', 6*7)"],
    env: {},
  });
  assert.equal(r.ok, true);
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, /SUM 42/);
  device.close();
});

test("exec：非零退出码被如实回带", async () => {
  const device = await openNativeDevice(stack);
  const c = device.control;
  const ws = await importWorkspace(device);
  const r = await device.request("execRun", "execResult", {
    requestId: "e2",
    workspaceId: ws.id,
    command: "node",
    args: ["-e", "process.exit(3)"],
    env: {},
  });
  assert.equal(r.exitCode, 3);
  device.close();
});

test("fs.list / fs.read：列目录、读文件（按 root 锚定）", async () => {
  const device = await openNativeDevice(stack);
  const c = device.control;
  const ws = await importWorkspace(device);
  const list = await device.request("fsList", "fsListed", {
    requestId: "l1",
    workspaceId: ws.id,
    path: "",
    browseHome: false,
  });
  assert.equal(list.ok, true);
  const names = list.entries.map((e) => e.name);
  assert.ok(names.includes("README.md"), "列出 README.md");
  assert.ok(names.includes("src"), "列出 src 目录");
  assert.equal(list.entries.find((e) => e.name === "src").kind, FsEntryKind.DIR);

  const read = await device.request("fsRead", "fsReadResult", { requestId: "r1", workspaceId: ws.id, path: "README.md" });
  assert.equal(read.ok, true);
  assert.match(read.content, /hello world/);
  device.close();
});

test("fs：路径穿越被拒（锚定在 root 内）", async () => {
  const device = await openNativeDevice(stack);
  const c = device.control;
  const ws = await importWorkspace(device);
  const read = await device.request("fsRead", "fsReadResult", {
    requestId: "r2",
    workspaceId: ws.id,
    path: "../../../../etc/passwd",
  });
  assert.equal(read.ok, false, "越界读取被拒");
  assert.match(read.error ?? "", /越界/);
  device.close();
});

test("fs.write：root 锚定通用原语——上传字节原样落盘，内容一致且自带 .gitignore", async () => {
  const device = await openNativeDevice(stack);
  const c = device.control;
  const ws = await importWorkspace(device);
  const content = "fake-image-bytes-\x01\x02\x03-payload";
  const r = await device.request("fsWrite", "fsWriteResult", {
    requestId: "w1",
    operationId: randomUUID(),
    workspaceId: ws.id,
    path: ".coflux/pastes/paste-test.png",
    data: new TextEncoder().encode(content),
    temp: false,
  });
  assert.equal(r.ok, true);
  assert.equal(r.path, ".coflux/pastes/paste-test.png");
  const written = readFileSync(join(ws.path, ".coflux", "pastes", "paste-test.png"), "utf8");
  assert.equal(written, content, "落盘字节与上传字节一致（不重编码）");
  const gitignore = readFileSync(join(ws.path, ".coflux", "pastes", ".gitignore"), "utf8");
  assert.equal(gitignore, "*\n", "pastes 目录自我 .gitignore");
  device.close();
});

test("fs.write：'..' 越界路径被拒", async () => {
  const device = await openNativeDevice(stack);
  const c = device.control;
  const ws = await importWorkspace(device);
  const r = await device.request("fsWrite", "fsWriteResult", {
    requestId: "w2",
    operationId: randomUUID(),
    workspaceId: ws.id,
    path: "../escaped.png",
    data: new TextEncoder().encode("x"),
    temp: false,
  });
  assert.equal(r.ok, false, "越界写入被拒");
  device.close();
});

test("fs.write：非归属（不存在的）workspace 被拒", async () => {
  const device = await openNativeDevice(stack);
  const c = device.control;
  const r = await device.request("fsWrite", "fsWriteResult", {
    requestId: "w3",
    operationId: randomUUID(),
    workspaceId: "00000000-0000-0000-0000-000000000000",
    path: ".coflux/pastes/x.png",
    data: new TextEncoder().encode("x"),
    temp: false,
  }, { allowError: true });
  assert.equal(r.case, "error", "非归属 workspace 被 Device authority 拒绝");
  assert.match(r.message ?? "", /不属于|清单/);
  device.close();
});

test("fs.write：temp 模式——终端贴图落 daemon 侧系统临时目录，回带绝对路径", async () => {
  const device = await openNativeDevice(stack);
  const c = device.control;
  const ws = await importWorkspace(device);
  const content = "fake-image-bytes-\x01\x02\x03-payload";
  const r = await device.request("fsWrite", "fsWriteResult", {
    requestId: "w4",
    operationId: randomUUID(),
    workspaceId: ws.id,
    path: "paste-temp-test.png",
    data: new TextEncoder().encode(content),
    temp: true,
  });
  assert.equal(r.ok, true);
  assert.ok(r.path?.includes("coflux-pastes"), "回带路径落在 coflux-pastes 临时子目录");
  assert.ok(r.path?.startsWith("/"), "temp 模式回带绝对路径");
  const written = readFileSync(r.path, "utf8");
  assert.equal(written, content, "temp 模式落盘字节与上传字节一致");
  device.close();
});

test("fs.write：temp 模式下多段路径 / 越界文件名被拒", async () => {
  const device = await openNativeDevice(stack);
  const c = device.control;
  const ws = await importWorkspace(device);
  const r1 = await device.request("fsWrite", "fsWriteResult", {
    requestId: "w5",
    operationId: randomUUID(),
    workspaceId: ws.id,
    path: "../escaped.png",
    data: new TextEncoder().encode("x"),
    temp: true,
  });
  assert.equal(r1.ok, false, "temp 模式下 '..' 被拒");

  const r2 = await device.request("fsWrite", "fsWriteResult", {
    requestId: "w6",
    operationId: randomUUID(),
    workspaceId: ws.id,
    path: "a/b.png",
    data: new TextEncoder().encode("x"),
    temp: true,
  });
  assert.equal(r2.ok, false, "temp 模式下多段路径被拒（仅允许单段文件名）");
  device.close();
});

test("fs：root 内指向 root 外的符号链接被拒（realpath 锚定）", async () => {
  const device = await openNativeDevice(stack);
  const c = device.control;
  const repo = mkRepo();
  repos.push(repo);
  const outside = mkdtempSync(join(tmpdir(), "coflux-outside-"));
  writeFileSync(join(outside, "secret.txt"), "SECRET-OUTSIDE");
  symlinkSync(join(outside, "secret.txt"), join(repo.dir, "link.txt"));
  c.send({ case: "projectImport", daemonId: stack.daemonId, path: repo.dir });
  const main = await c.waitFor((m) => m.case === "workspaceCreated" && m.workspace.isMain, "main");
  await device.waitWorkspaceReady(main.workspace.id);
  const read = await device.request("fsRead", "fsReadResult", { requestId: "sl", workspaceId: main.workspace.id, path: "link.txt" });
  assert.equal(read.ok, false, "指向 root 外的符号链接被拒");
  rmSync(outside, { recursive: true, force: true });
  device.close();
});

// ===== device exec：中心发起的一次性跨设备执行（不是终端）=====
// 与上面那组 exec 用例相反方向：上面是 browser→daemon 的本地 DeviceEnvelope 通道，这里是
// 账号 API→中心→daemon 的 ServerAgentRequest 通道。两条通道的协议契约都只能靠本文件盯住。

test("device exec：命令交给远端 sh -c，stdout/exitCode 结构化回带", async () => {
  const r = await deviceExec({ command: "cd /tmp && pwd && printf 'SUM %s\\n' $((6*7))" });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.value.exitCode, 0);
  // `cd … && …` 只有经 shell 才跑得通；直接 execve 会以「cd 不是可执行文件」失败。
  assert.match(r.value.stdout, /\/tmp/);
  assert.match(r.value.stdout, /SUM 42/);
  assert.equal(r.value.stderr, "");
});

test("device exec：cwd 缺省为 daemon 用户的 HOME，~ 前缀被展开", async () => {
  const home = await deviceExec({ command: "pwd" });
  assert.equal(home.ok, true, home.error);
  assert.equal(home.value.exitCode, 0);
  assert.ok(home.value.cwd.startsWith("/"), `回带绝对 cwd：${home.value.cwd}`);
  assert.equal(home.value.stdout.trim(), home.value.cwd);

  const tilde = await deviceExec({ command: "pwd", cwd: "~" });
  assert.equal(tilde.ok, true, tilde.error);
  assert.equal(tilde.value.cwd, home.value.cwd, "~ 与缺省指向同一个 HOME");
});

test("device exec：两条流分开，非零退出码如实回带", async () => {
  const r = await deviceExec({ command: "echo out; echo err 1>&2; exit 3" });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.value.exitCode, 3);
  assert.equal(r.value.stdout.trim(), "out");
  assert.equal(r.value.stderr.trim(), "err", "stderr 不被混进 stdout");
});

test("device exec：cwd 不存在 / 不是目录 / 不是绝对路径，各回一句可读的话", async () => {
  const missing = await deviceExec({ command: "pwd", cwd: "/definitely-not-here-coflux-exec" });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /不存在/);

  const notDir = await deviceExec({ command: "pwd", cwd: "/etc/hosts" });
  assert.equal(notDir.ok, false);
  assert.match(notDir.error, /不是目录/);

  const relative = await deviceExec({ command: "pwd", cwd: "logs" });
  assert.equal(relative.ok, false);
  assert.match(relative.error, /绝对路径/);
});

test("device exec：超时是确定的失败（远端进程被杀），不是静默截断", async () => {
  const r = await deviceExec({ command: "sleep 30", timeout: 1 });
  assert.equal(r.ok, false);
  assert.match(r.error, /超时/);
});

test("device exec：不是终端——跑完之后账号快照里没有多出任何 task", async () => {
  const before = await accountCommand({ op: "snapshot" });
  assert.equal(before.ok, true, before.error);
  const r = await deviceExec({ command: "true" });
  assert.equal(r.ok, true, r.error);
  const after = await accountCommand({ op: "snapshot" });
  assert.equal(after.ok, true, after.error);
  assert.equal(after.value.terminals.length, before.value.terminals.length, "exec 不产生 task 记录");
});
