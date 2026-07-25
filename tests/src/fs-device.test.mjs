// 设备浏览模式（plan 012 导入向导）：Device fsList 的 browseHome=true 从 HOME 起步。
// 独立 stack + 受控 HOME（临时目录），断言不依赖真机 home 内容。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsEntryKind } from "@coflux/protocol";
import { startStack } from "./harness.mjs";
import { openRelayDevice } from "./device-harness.mjs";

const PORT = 8832;
let stack;
let fakeHome;
let homeReal;

before(async () => {
  fakeHome = mkdtempSync(join(tmpdir(), "coflux-fake-home-"));
  homeReal = realpathSync(fakeHome);
  mkdirSync(join(fakeHome, "Workspace", "proj-a"), { recursive: true });
  mkdirSync(join(fakeHome, "Workspace", "proj-b"), { recursive: true });
  mkdirSync(join(fakeHome, ".hidden-dir"), { recursive: true });
  writeFileSync(join(fakeHome, "notes.txt"), "not a dir");
  stack = await startStack({ port: PORT, daemonEnv: { HOME: fakeHome } });
});
after(async () => {
  await stack?.stop();
  rmSync(fakeHome, { recursive: true, force: true });
});

test("设备模式默认 ~：列 HOME，并回传绝对 path", async () => {
  const device = await openRelayDevice(stack);

  const root = await device.request("fsList", "fsListed", { requestId: "d1", workspaceId: "", path: "~", browseHome: true });
  assert.equal(root.ok, true);
  assert.equal(root.path, homeReal, "FsListed.path 为 HOME 绝对路径");
  const rootNames = root.entries.map((e) => e.name);
  assert.ok(rootNames.includes("Workspace"), "列出 Workspace 目录");
  assert.ok(rootNames.includes(".hidden-dir"), "协议层不过滤隐藏目录（过滤是 UI 决策）");
  assert.equal(root.entries.find((e) => e.name === "Workspace").kind, FsEntryKind.DIR);
  assert.equal(root.entries.find((e) => e.name === "notes.txt").kind, FsEntryKind.FILE);

  const workspaceAbs = join(homeReal, "Workspace");
  const sub = await device.request("fsList", "fsListed", { requestId: "d2", workspaceId: "", path: workspaceAbs, browseHome: true });
  assert.equal(sub.ok, true);
  assert.equal(sub.path, workspaceAbs, "子目录回传绝对路径");
  assert.deepEqual(sub.entries.map((e) => e.name).sort(), ["proj-a", "proj-b"]);
  device.close();
});

test("设备 HOME 浏览不能上钻到 /（Device authority 固定根）", async () => {
  const device = await openRelayDevice(stack);
  const r = await device.request("fsList", "fsListed", { requestId: "d3", workspaceId: "", path: "/", browseHome: true });
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /越界|root/i);
  device.close();
});

test("HOME 浏览不接受 workspaceId（Device channel 已绑定 daemon）", async () => {
  const device = await openRelayDevice(stack);
  const r = await device.request("fsList", "fsListed", {
    requestId: "d4",
    workspaceId: "00000000-0000-0000-0000-000000000000",
    path: "~",
    browseHome: true,
  }, { allowError: true });
  assert.equal(r.case, "error");
  assert.match(r.message ?? "", /workspaceId.*必须为空/);
  device.close();
});

test("workspace 模式不回归：省略 daemonId 仍按 worktree 锚定", async () => {
  const device = await openRelayDevice(stack);
  const c = device.control;
  // fakeHome 里造一个 git 仓库导入，验证 workspace 模式照旧
  const repoDir = join(fakeHome, "Workspace", "proj-a");
  writeFileSync(join(repoDir, "README.md"), "# a\n");
  const { execFileSync } = await import("node:child_process");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repoDir });
  execFileSync("git", ["add", "."], { cwd: repoDir });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: repoDir });

  c.send({ case: "projectImport", daemonId: stack.daemonId, path: repoDir });
  const main = await c.waitFor((m) => m.case === "workspaceCreated" && m.workspace.isMain, "main ws");
  await device.waitWorkspaceReady(main.workspace.id);
  const r = await device.request("fsList", "fsListed", {
    requestId: "d5",
    workspaceId: main.workspace.id,
    path: "",
    browseHome: false,
  });
  assert.equal(r.ok, true);
  assert.ok(r.entries.map((e) => e.name).includes("README.md"), "锚定在 worktree 而非 home");
  device.close();
});
