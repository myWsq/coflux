import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsEntryKind } from "@coflux/protocol";
import { startStack, mkRepo } from "./harness.mjs";

const PORT = 8826;
let stack;
const repos = [];

before(async () => { stack = await startStack({ port: PORT }); });
after(async () => { await stack?.stop(); repos.forEach((r) => r.cleanup()); });

// 在一个 workspace 里发请求并等回带（按 requestId 关联）的辅助
async function importWorkspace(c) {
  const repo = mkRepo();
  repos.push(repo);
  // 放点文件供 fs 测试
  writeFileSync(join(repo.dir, "README.md"), "# hi\nhello world\n");
  mkdirSync(join(repo.dir, "src"), { recursive: true });
  writeFileSync(join(repo.dir, "src", "a.txt"), "AAA");
  c.send({ case: "projectImport", daemonId: stack.daemonId, path: repo.dir });
  const main = await c.waitFor((m) => m.case === "workspaceCreated" && m.workspace.isMain, "main ws");
  return main.workspace;
}

test("exec：在工作区里跑命令，结构化回带 stdout/exitCode", async () => {
  const c = stack.makeClient();
  await c.authSubscribe();
  const ws = await importWorkspace(c);
  c.send({ case: "clientExec", requestId: "e1", workspaceId: ws.id, command: "node", args: ["-e", "console.log('SUM', 6*7)"] });
  const r = await c.waitFor((m) => m.case === "execResult" && m.requestId === "e1", "exec.result");
  assert.equal(r.ok, true);
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, /SUM 42/);
  c.close();
});

test("exec：非零退出码被如实回带", async () => {
  const c = stack.makeClient();
  await c.authSubscribe();
  const ws = await importWorkspace(c);
  c.send({ case: "clientExec", requestId: "e2", workspaceId: ws.id, command: "node", args: ["-e", "process.exit(3)"] });
  const r = await c.waitFor((m) => m.case === "execResult" && m.requestId === "e2", "exec.result");
  assert.equal(r.exitCode, 3);
  c.close();
});

test("fs.list / fs.read：列目录、读文件（按 root 锚定）", async () => {
  const c = stack.makeClient();
  await c.authSubscribe();
  const ws = await importWorkspace(c);
  c.send({ case: "clientFsList", requestId: "l1", workspaceId: ws.id, path: "" });
  const list = await c.waitFor((m) => m.case === "fsListed" && m.requestId === "l1", "fs.listed");
  assert.equal(list.ok, true);
  const names = list.entries.map((e) => e.name);
  assert.ok(names.includes("README.md"), "列出 README.md");
  assert.ok(names.includes("src"), "列出 src 目录");
  assert.equal(list.entries.find((e) => e.name === "src").kind, FsEntryKind.DIR);

  c.send({ case: "clientFsRead", requestId: "r1", workspaceId: ws.id, path: "README.md" });
  const read = await c.waitFor((m) => m.case === "fsReadResult" && m.requestId === "r1", "fs.read.result");
  assert.equal(read.ok, true);
  assert.match(read.content, /hello world/);
  c.close();
});

test("fs：路径穿越被拒（锚定在 root 内）", async () => {
  const c = stack.makeClient();
  await c.authSubscribe();
  const ws = await importWorkspace(c);
  c.send({ case: "clientFsRead", requestId: "r2", workspaceId: ws.id, path: "../../../../etc/passwd" });
  const read = await c.waitFor((m) => m.case === "fsReadResult" && m.requestId === "r2", "fs.read.result");
  assert.equal(read.ok, false, "越界读取被拒");
  assert.match(read.error ?? "", /越界/);
  c.close();
});

test("fs.write：root 锚定通用原语——上传字节原样落盘，内容一致且自带 .gitignore", async () => {
  const c = stack.makeClient();
  await c.authSubscribe();
  const ws = await importWorkspace(c);
  const content = "fake-image-bytes-\x01\x02\x03-payload";
  c.send({ case: "clientFsWrite", requestId: "w1", workspaceId: ws.id, path: ".coflux/pastes/paste-test.png", data: content });
  const r = await c.waitFor((m) => m.case === "fsWriteResult" && m.requestId === "w1", "fs.write.result");
  assert.equal(r.ok, true);
  assert.equal(r.path, ".coflux/pastes/paste-test.png");
  const written = readFileSync(join(ws.path, ".coflux", "pastes", "paste-test.png"), "utf8");
  assert.equal(written, content, "落盘字节与上传字节一致（不重编码）");
  const gitignore = readFileSync(join(ws.path, ".coflux", "pastes", ".gitignore"), "utf8");
  assert.equal(gitignore, "*\n", "pastes 目录自我 .gitignore");
  c.close();
});

test("fs.write：'..' 越界路径被拒", async () => {
  const c = stack.makeClient();
  await c.authSubscribe();
  const ws = await importWorkspace(c);
  c.send({ case: "clientFsWrite", requestId: "w2", workspaceId: ws.id, path: "../escaped.png", data: "x" });
  const r = await c.waitFor((m) => m.case === "fsWriteResult" && m.requestId === "w2", "fs.write.result");
  assert.equal(r.ok, false, "越界写入被拒");
  c.close();
});

test("fs.write：非归属（不存在的）workspace 被拒", async () => {
  const c = stack.makeClient();
  await c.authSubscribe();
  c.send({ case: "clientFsWrite", requestId: "w3", workspaceId: "00000000-0000-0000-0000-000000000000", path: ".coflux/pastes/x.png", data: "x" });
  const r = await c.waitFor((m) => m.case === "fsWriteResult" && m.requestId === "w3", "fs.write.result");
  assert.equal(r.ok, false, "非归属 workspace 被拒");
  assert.match(r.error ?? "", /不存在|不属于本账号/);
  c.close();
});

test("fs.write：temp 模式——终端贴图落 daemon 侧系统临时目录，回带绝对路径", async () => {
  const c = stack.makeClient();
  await c.authSubscribe();
  const ws = await importWorkspace(c);
  const content = "fake-image-bytes-\x01\x02\x03-payload";
  c.send({ case: "clientFsWrite", requestId: "w4", workspaceId: ws.id, path: "paste-temp-test.png", data: content, temp: true });
  const r = await c.waitFor((m) => m.case === "fsWriteResult" && m.requestId === "w4", "fs.write.result");
  assert.equal(r.ok, true);
  assert.ok(r.path?.includes("coflux-pastes"), "回带路径落在 coflux-pastes 临时子目录");
  assert.ok(r.path?.startsWith("/"), "temp 模式回带绝对路径");
  const written = readFileSync(r.path, "utf8");
  assert.equal(written, content, "temp 模式落盘字节与上传字节一致");
  c.close();
});

test("fs.write：temp 模式下多段路径 / 越界文件名被拒", async () => {
  const c = stack.makeClient();
  await c.authSubscribe();
  const ws = await importWorkspace(c);
  c.send({ case: "clientFsWrite", requestId: "w5", workspaceId: ws.id, path: "../escaped.png", data: "x", temp: true });
  const r1 = await c.waitFor((m) => m.case === "fsWriteResult" && m.requestId === "w5", "fs.write.result");
  assert.equal(r1.ok, false, "temp 模式下 '..' 被拒");

  c.send({ case: "clientFsWrite", requestId: "w6", workspaceId: ws.id, path: "a/b.png", data: "x", temp: true });
  const r2 = await c.waitFor((m) => m.case === "fsWriteResult" && m.requestId === "w6", "fs.write.result");
  assert.equal(r2.ok, false, "temp 模式下多段路径被拒（仅允许单段文件名）");
  c.close();
});

test("fs：root 内指向 root 外的符号链接被拒（realpath 锚定）", async () => {
  const c = stack.makeClient();
  await c.authSubscribe();
  const repo = mkRepo();
  repos.push(repo);
  const outside = mkdtempSync(join(tmpdir(), "coflux-outside-"));
  writeFileSync(join(outside, "secret.txt"), "SECRET-OUTSIDE");
  symlinkSync(join(outside, "secret.txt"), join(repo.dir, "link.txt"));
  c.send({ case: "projectImport", daemonId: stack.daemonId, path: repo.dir });
  const main = await c.waitFor((m) => m.case === "workspaceCreated" && m.workspace.isMain, "main");
  c.send({ case: "clientFsRead", requestId: "sl", workspaceId: main.workspace.id, path: "link.txt" });
  const read = await c.waitFor((m) => m.case === "fsReadResult" && m.requestId === "sl", "fs.read.result");
  assert.equal(read.ok, false, "指向 root 外的符号链接被拒");
  rmSync(outside, { recursive: true, force: true });
  c.close();
});
