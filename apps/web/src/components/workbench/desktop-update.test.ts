import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveOutdatedPrompt } from "./desktop-update";

test("版本被拒 → 标题恒为「需要更新」，不是断线也不是登录失败", () => {
  for (const status of ["idle", "checking", "available", "downloading", "downloaded", "not-available", "error"] as const) {
    assert.equal(resolveOutdatedPrompt({ status }).title, "需要更新", status);
  }
});

test("检查/下载中只显示进度，没有按钮", () => {
  assert.deepEqual(resolveOutdatedPrompt({ status: "idle" }).action, null);
  assert.equal(resolveOutdatedPrompt({ status: "checking" }).busy, true);
  const downloading = resolveOutdatedPrompt({ status: "downloading", version: "0.2.0", percent: 57 });
  assert.equal(downloading.busy, true);
  assert.match(downloading.description, /0\.2\.0/);
  assert.match(downloading.description, /57%/);
  assert.equal(downloading.action, null);
});

test("下载完成 → 「重启并更新」；没有新版本 / 出错 → 可重新检查并带原因", () => {
  const downloaded = resolveOutdatedPrompt({ status: "downloaded", version: "0.2.0" });
  assert.deepEqual(downloaded.action, { label: "重启并更新", kind: "install" });
  assert.equal(downloaded.busy, false);

  const missing = resolveOutdatedPrompt({ status: "not-available" });
  assert.equal(missing.action?.kind, "check");

  const failed = resolveOutdatedPrompt({ status: "error", message: "ENOTFOUND" });
  assert.equal(failed.action?.kind, "check");
  assert.match(failed.description, /ENOTFOUND/);
});
