import assert from "node:assert/strict";
import { test } from "node:test";
import { createUpdateInstaller } from "./update-install";

test("重复安装合并；准备未完成时不能退出，准备拒绝后可以重试", async () => {
  let ready!: (value: boolean) => void;
  let installed = 0;
  let attempts = 0;
  const installer = createUpdateInstaller({ beforeInstall: () => { attempts++; return new Promise((resolve) => { ready = resolve; }); }, install: () => { installed++; }, onError: () => assert.fail("不应失败") });
  const first = installer.install();
  await installer.install();
  assert.equal(attempts, 1);
  assert.equal(installed, 0);
  ready(false);
  await first;
  const second = installer.install();
  ready(true);
  await second;
  await installer.install();
  assert.equal(installed, 1);
});

test("同步安装失败与异步更新错误恢复退出拦截；无安装时的下载错误不触发生命周期变化", async () => {
  let failures = 0;
  let installed = 0;
  const installer = createUpdateInstaller({ beforeInstall: async () => true, install: () => { if (++installed === 1) throw new Error("install failed"); }, onError: () => { failures++; } });
  installer.failed(new Error("download failed"));
  assert.equal(failures, 0);
  await installer.install();
  assert.equal(failures, 1);
  await installer.install();
  installer.failed(new Error("updater failed"));
  assert.equal(failures, 2);
  await installer.install();
  assert.equal(installed, 3);
});
