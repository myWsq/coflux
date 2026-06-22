import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  c.send({ type: "project.import", daemonId: stack.daemonId, path: repo.dir });
  const main = await c.waitFor((m) => m.type === "workspace.created" && m.workspace.isMain, "main ws");
  return main.workspace;
}

test("exec：在工作区里跑命令，结构化回带 stdout/exitCode", async () => {
  const c = stack.makeClient();
  await c.authSubscribe();
  const ws = await importWorkspace(c);
  c.send({ type: "client.exec", requestId: "e1", workspaceId: ws.id, command: "node", args: ["-e", "console.log('SUM', 6*7)"] });
  const r = await c.waitFor((m) => m.type === "exec.result" && m.requestId === "e1", "exec.result");
  assert.equal(r.ok, true);
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, /SUM 42/);
  c.close();
});

test("exec：非零退出码被如实回带", async () => {
  const c = stack.makeClient();
  await c.authSubscribe();
  const ws = await importWorkspace(c);
  c.send({ type: "client.exec", requestId: "e2", workspaceId: ws.id, command: "node", args: ["-e", "process.exit(3)"] });
  const r = await c.waitFor((m) => m.type === "exec.result" && m.requestId === "e2", "exec.result");
  assert.equal(r.exitCode, 3);
  c.close();
});

test("fs.list / fs.read：列目录、读文件（按 root 锚定）", async () => {
  const c = stack.makeClient();
  await c.authSubscribe();
  const ws = await importWorkspace(c);
  c.send({ type: "client.fs.list", requestId: "l1", workspaceId: ws.id, path: "" });
  const list = await c.waitFor((m) => m.type === "fs.listed" && m.requestId === "l1", "fs.listed");
  assert.equal(list.ok, true);
  const names = list.entries.map((e) => e.name);
  assert.ok(names.includes("README.md"), "列出 README.md");
  assert.ok(names.includes("src"), "列出 src 目录");
  assert.equal(list.entries.find((e) => e.name === "src").type, "dir");

  c.send({ type: "client.fs.read", requestId: "r1", workspaceId: ws.id, path: "README.md" });
  const read = await c.waitFor((m) => m.type === "fs.read.result" && m.requestId === "r1", "fs.read.result");
  assert.equal(read.ok, true);
  assert.match(read.content, /hello world/);
  c.close();
});

test("fs：路径穿越被拒（锚定在 root 内）", async () => {
  const c = stack.makeClient();
  await c.authSubscribe();
  const ws = await importWorkspace(c);
  c.send({ type: "client.fs.read", requestId: "r2", workspaceId: ws.id, path: "../../../../etc/passwd" });
  const read = await c.waitFor((m) => m.type === "fs.read.result" && m.requestId === "r2", "fs.read.result");
  assert.equal(read.ok, false, "越界读取被拒");
  assert.match(read.error ?? "", /越界/);
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
  c.send({ type: "project.import", daemonId: stack.daemonId, path: repo.dir });
  const main = await c.waitFor((m) => m.type === "workspace.created" && m.workspace.isMain, "main");
  c.send({ type: "client.fs.read", requestId: "sl", workspaceId: main.workspace.id, path: "link.txt" });
  const read = await c.waitFor((m) => m.type === "fs.read.result" && m.requestId === "sl", "fs.read.result");
  assert.equal(read.ok, false, "指向 root 外的符号链接被拒");
  rmSync(outside, { recursive: true, force: true });
  c.close();
});
