import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startStack, mkRepo } from "./harness.mjs";
import { openRelayDevice } from "./device-harness.mjs";

const PORT = 8860;
let stack;
const repos = [];

before(async () => { stack = await startStack({ port: PORT }); });
after(async () => { await stack?.stop(); repos.forEach((r) => r.cleanup()); });

test("项目重命名：改名后双客户端广播可见且落库持久", async () => {
  const repo = mkRepo();
  repos.push(repo);
  const device = await openRelayDevice(stack);
  const c1 = device.control;
  c1.send({ case: "projectImport", daemonId: stack.daemonId, path: repo.dir });
  const proj = await c1.waitFor((m) => m.case === "projectCreated", "project.created");
  const projectId = proj.project.id;

  // 另一个客户端也订阅，用来验证广播
  const c2 = stack.makeClient();
  await c2.authSubscribe();

  // 带首尾空白发送，顺带断言服务端 trim
  const newName = "重命名后的项目";
  c1.send({ case: "projectSetName", projectId, name: `  ${newName}  ` });

  const u1 = await c1.waitFor(
    (m) => m.case === "projectCreated" && m.project.id === projectId && m.project.name === newName,
    "c1: projectCreated with new name"
  );
  assert.equal(u1.project.name, newName, "c1 看到新名且已 trim");
  const u2 = await c2.waitFor(
    (m) => m.case === "projectCreated" && m.project.id === projectId && m.project.name === newName,
    "c2: projectCreated with new name"
  );
  assert.equal(u2.project.name, newName, "c2 也看到新名");

  // 落库持久：新客户端的快照里就是新名
  const c3 = stack.makeClient();
  const snap = await c3.authSubscribe();
  assert.equal(snap.projects.find((p) => p.id === projectId)?.name, newName, "快照里是新名");

  c2.close();
  c3.close();
});

test("项目重命名：空名（trim 后为空）被拒绝，不落库不下发", async () => {
  const c = stack.makeClient();
  const snap = await c.authSubscribe();
  const project = snap.projects[0];
  assert.ok(project, "已有项目（上一用例导入）");

  c.send({ case: "projectSetName", projectId: project.id, name: "   " });

  // 归属不符/空名都是静默 return（hub 惯例无错误回包），只能等一拍后断言无广播
  await new Promise((resolve) => setTimeout(resolve, 300));
  const updates = c.log.filter((m) => m.case === "projectCreated" && m.project.id === project.id);
  assert.equal(updates.length, 0, "空名不应产生 projectCreated 广播");

  // 名字未被改动
  const c2 = stack.makeClient();
  const snap2 = await c2.authSubscribe();
  assert.equal(snap2.projects.find((p) => p.id === project.id)?.name, project.name, "落库名未变");

  c.close();
  c2.close();
});
