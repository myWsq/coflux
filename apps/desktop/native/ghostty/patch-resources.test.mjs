import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { patchResources } from "./patch-resources.mjs";

function checkout(source, run) {
  const root = mkdtempSync(join(tmpdir(), "coflux-resource-patch-"));
  const path = join(root, ".build/checkouts/libghostty-spm/Sources/GhosttyTerminal/Configuration/GhosttyRuntimeResources.swift");
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, source);
    chmodSync(path, 0o444);
    run(root, path);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("只读 checkout 可打补丁、恢复权限且第二次不写文件", () => {
  checkout("public enum GhosttyRuntimeResources {\nBundle.module.url\nBundle.module.url\n}", (root, path) => {
    patchResources(root);
    const patched = readFileSync(path, "utf8");
    assert.ok(patched.includes("private static var cofluxResourceBundle"));
    assert.equal(patched.split("cofluxResourceBundle.url").length, 3);
    assert.equal(statSync(path).mode & 0o777, 0o444);
    const modified = statSync(path, { bigint: true }).mtimeNs;
    patchResources(root);
    assert.equal(readFileSync(path, "utf8"), patched);
    assert.equal(statSync(path, { bigint: true }).mtimeNs, modified);
    assert.equal(statSync(path).mode & 0o777, 0o444);
  });
});

test("源码形状变化硬失败且不改变内容或权限", () => {
  checkout("public enum GhosttyRuntimeResources {\nBundle.module.url\n}", (root, path) => {
    const original = readFileSync(path, "utf8");
    assert.throws(() => patchResources(root), /资源入口发生变化/);
    assert.equal(readFileSync(path, "utf8"), original);
    assert.equal(statSync(path).mode & 0o777, 0o444);
  });
});
