import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { DeviceClient } from "./device-harness.mjs";
import { mkRepo, startStack } from "./harness.mjs";

const PORT = 8846;
let stack;
const repos = [];

before(async () => { stack = await startStack({ port: PORT }); });
after(async () => {
  await stack?.stop();
  for (const repo of repos) repo.cleanup();
});

async function importProject(device, repo, name) {
  device.control.send({ case: "projectImport", daemonId: stack.daemonId, path: repo.dir, name });
  device.executePrepared(await device.waitPrepared("projectValidate"));
  const project = await device.control.waitFor(
    (message) => message.case === "projectCreated" && message.project.name === name,
    `${name} project`,
  );
  const workspace = await device.control.waitFor(
    (message) => message.case === "workspaceCreated" && message.workspace.projectId === project.project.id && message.workspace.isMain,
    `${name} main workspace`,
  );
  return { project: project.project, workspace: workspace.workspace };
}

async function createWorktree(device, projectId, name, branch) {
  device.control.send({ case: "workspaceCreate", projectId, name, branch, createNew: true });
  device.executePrepared(await device.waitPrepared("worktreeAdd"));
  const created = await device.control.waitFor(
    (message) => message.case === "workspaceCreated" && message.workspace.projectId === projectId && message.workspace.branch === branch,
    `${branch} worktree`,
  );
  return created.workspace;
}

async function openElevatedDirect(device) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const lease = await device.requestLease();
    try {
      return await device.openDirect({ lease });
    } catch (error) {
      lastError = error;
      await sleep(50);
    }
  }
  throw lastError;
}

async function request(device, requestCase, responseCase, value, timeout = 10000) {
  const requestId = value.requestId ?? randomUUID();
  const from = device.mark();
  device.send(requestCase, { ...value, requestId });
  const result = await device.waitFor(
    (message) =>
      (message.case === responseCase && message.requestId === requestId) ||
      (message.case === "error" && message.requestId === requestId),
    `${requestCase} response`,
    timeout,
    from,
  );
  if (result.case === "error") throw new Error(`${result.code}: ${result.message}`);
  return result;
}

async function waitWorkspaceReady(device, workspaceId) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      return await request(device, "execRun", "execResult", {
        workspaceId,
        command: "/bin/sh",
        args: ["-c", "printf ready"],
        env: {},
      });
    } catch (error) {
      if (!String(error).includes("workspace_unknown")) throw error;
      await sleep(50);
    }
  }
  throw new Error("workspace list 没有同步到 worker");
}

function relayFrameCount(device) {
  return device.control.log.filter((message) => message.case === "deviceRelayFrame").length;
}

test("普通 Device RPC 在 direct/relay 等价，direct 热路径不产生中心 relay frame", async () => {
  const relayRepo = mkRepo();
  const directRepo = mkRepo();
  repos.push(relayRepo, directRepo);

  const device = await DeviceClient.pair(stack);
  await device.openRelay();
  const relayImport = await importProject(device, relayRepo, "relay-import");
  const relayWorktree = await createWorktree(device, relayImport.project.id, "relay-wt", "relay-wt");
  assert.equal(relayWorktree.branch, "relay-wt", "worktree prepared operation 可经 relay 完成");

  await openElevatedDirect(device);
  const directFramesBefore = relayFrameCount(device);
  const directImport = await importProject(device, directRepo, "direct-import");
  const directWorktree = await createWorktree(device, directImport.project.id, "direct-wt", "direct-wt");
  assert.equal(directWorktree.branch, "direct-wt", "project/worktree prepared operation 可经 direct 完成");
  await waitWorkspaceReady(device, directImport.workspace.id);

  const directExec = await request(device, "execRun", "execResult", {
    workspaceId: directImport.workspace.id,
    command: "/bin/sh",
    args: ["-c", "printf DEVICE_RPC"],
    env: {},
  });
  assert.equal(directExec.ok, true);
  assert.equal(directExec.stdout, "DEVICE_RPC");

  const directWrite = await request(device, "fsWrite", "fsWriteResult", {
    operationId: randomUUID(),
    workspaceId: directImport.workspace.id,
    path: "rpc.txt",
    data: new TextEncoder().encode("from-device-rpc"),
    temp: false,
  });
  assert.equal(directWrite.ok, true);
  const directRead = await request(device, "fsRead", "fsReadResult", {
    workspaceId: directImport.workspace.id,
    path: "rpc.txt",
  });
  assert.equal(directRead.content, "from-device-rpc");
  const directList = await request(device, "fsList", "fsListed", {
    workspaceId: directImport.workspace.id,
    path: "",
    browseHome: false,
  });
  assert.ok(directList.entries.some((entry) => entry.name === "rpc.txt"));
  const directPorts = await request(device, "portsRequest", "portsResult", {});

  const exactlyOncePath = join(directRepo.dir, "device-op-once.txt");
  const operationId = randomUUID();
  const operationRequestId = randomUUID();
  const operation = {
    requestId: operationRequestId,
    operationId,
    workspaceId: directImport.workspace.id,
    command: "/bin/sh",
    args: ["-c", `printf O >> '${exactlyOncePath}'`],
    env: {},
  };
  const directMutation = await request(device, "execRun", "execResult", operation);
  assert.equal(directMutation.ok, true);
  assert.equal(readFileSync(exactlyOncePath, "utf8"), "O");
  const directListAfterMutation = await request(device, "fsList", "fsListed", {
    workspaceId: directImport.workspace.id,
    path: "",
    browseHome: false,
  });

  await sleep(100);
  assert.equal(relayFrameCount(device), directFramesBefore, "direct terminal/RPC frame 不经过中心 relay");

  await device.openRelay();
  const relayExec = await request(device, "execRun", "execResult", {
    workspaceId: directImport.workspace.id,
    command: "/bin/sh",
    args: ["-c", "printf DEVICE_RPC"],
    env: {},
  });
  assert.deepEqual(
    { ok: relayExec.ok, exitCode: relayExec.exitCode, stdout: relayExec.stdout, stderr: relayExec.stderr },
    { ok: directExec.ok, exitCode: directExec.exitCode, stdout: directExec.stdout, stderr: directExec.stderr },
    "exec direct/relay 结果等价",
  );
  const relayRead = await request(device, "fsRead", "fsReadResult", {
    workspaceId: directImport.workspace.id,
    path: "rpc.txt",
  });
  assert.deepEqual({ ok: relayRead.ok, content: relayRead.content }, { ok: directRead.ok, content: directRead.content });
  const relayList = await request(device, "fsList", "fsListed", {
    workspaceId: directImport.workspace.id,
    path: "",
    browseHome: false,
  });
  assert.deepEqual(
    relayList.entries.map((entry) => [entry.name, entry.kind]).sort(),
    directListAfterMutation.entries.map((entry) => [entry.name, entry.kind]).sort(),
    "fs.list direct/relay 结果等价",
  );
  const relayPorts = await request(device, "portsRequest", "portsResult", {});
  assert.deepEqual(relayPorts.sessions, directPorts.sessions, "ports direct/relay 结果等价");

  const relayMutation = await request(device, "execRun", "execResult", operation);
  assert.equal(relayMutation.ok, true);
  assert.equal(readFileSync(exactlyOncePath, "utf8"), "O", "同 operationId 跨 direct/relay 重投只执行一次");

  device.close();
});
