import assert from "node:assert/strict";
import { test } from "node:test";

import { ACCOUNT_IDENTITY_PLACEHOLDER, accountIdentity, resolveAccountFooter, serverHostLabel } from "./account-footer-view";

test("登录身份：email 取 @ 前部分做头像 initials；空身份退回占位且走默认头像", () => {
  const known = accountIdentity("wsq@example.com");
  assert.equal(known.label, "wsq@example.com");
  assert.equal(known.avatarName, "wsq");
  assert.equal(known.isPlaceholder, false);

  // local 模式回的是用户名，没有 @
  const localMode = accountIdentity("admin");
  assert.equal(localMode.label, "admin");
  assert.equal(localMode.avatarName, "admin");

  for (const empty of ["", "   "]) {
    const unknown = accountIdentity(empty);
    assert.equal(unknown.label, ACCOUNT_IDENTITY_PLACEHOLDER, "身份未知不得留白");
    assert.equal(unknown.avatarName, undefined, "没有 name 时 Avatar 走默认人形图标");
    assert.equal(unknown.isPlaceholder, true);
  }
});

test("服务器 host：从 /client WS 地址取 host（含非默认端口）；解析不了就原样显示", () => {
  assert.equal(serverHostLabel("wss://api.coflux.dev/client"), "api.coflux.dev");
  assert.equal(serverHostLabel("ws://localhost:8787/client"), "localhost:8787");
  assert.equal(serverHostLabel("不是地址"), "不是地址");
});

test("只有 downloaded 才把齿轮换成「更新」按钮，其余状态脚部静默", () => {
  for (const status of ["idle", "checking", "available", "downloading", "not-available", "error"] as const) {
    const view = resolveAccountFooter({ status, version: "0.1.6" }, "0.1.5");
    assert.equal(view.tail, "gear", status);
    assert.equal(view.installHint, "", `${status} 不该有更新按钮提示`);
  }
  const downloaded = resolveAccountFooter({ status: "downloaded", version: "0.1.6" }, "0.1.5");
  assert.equal(downloaded.tail, "install");
  assert.match(downloaded.installHint, /0\.1\.6/);
});

test("菜单项：进行中禁用并带进度，可点时动作分别是 check / install", () => {
  const idle = resolveAccountFooter({ status: "idle" }, "0.1.5").updateItem;
  assert.deepEqual(idle, { label: "检查更新", isDisabled: false, action: "check", detail: "" });

  assert.equal(resolveAccountFooter({ status: "checking" }, "0.1.5").updateItem.isDisabled, true);

  const available = resolveAccountFooter({ status: "available", version: "0.1.6" }, "0.1.5").updateItem;
  assert.equal(available.isDisabled, true);
  assert.match(available.label, /0\.1\.6/);

  const downloading = resolveAccountFooter({ status: "downloading", version: "0.1.6", percent: 42 }, "0.1.5").updateItem;
  assert.equal(downloading.isDisabled, true);
  assert.match(downloading.label, /42%/);

  const downloaded = resolveAccountFooter({ status: "downloaded", version: "0.1.6" }, "0.1.5").updateItem;
  assert.equal(downloaded.isDisabled, false);
  assert.equal(downloaded.action, "install");
  assert.match(downloaded.label, /0\.1\.6/);

  // 「已是最新」比的是当前 app 版本，不是 update.version
  const missing = resolveAccountFooter({ status: "not-available" }, "0.1.5").updateItem;
  assert.equal(missing.action, "check");
  assert.match(missing.label, /0\.1\.5/);

  // 开发版点检查会立刻拿到这条：原因进副文案，动作仍是可重试的 check
  const failed = resolveAccountFooter({ status: "error", message: "开发版不检查更新" }, "0.1.5").updateItem;
  assert.equal(failed.isDisabled, false);
  assert.equal(failed.action, "check");
  assert.equal(failed.detail, "开发版不检查更新");
});

test("版本缺失时不留「v」半截文案", () => {
  assert.equal(resolveAccountFooter({ status: "downloaded" }, "0.1.5").updateItem.label, "重启并更新");
  assert.equal(resolveAccountFooter({ status: "downloaded" }, "0.1.5").installHint, "新版本已下载，点击重启并更新");
  assert.equal(resolveAccountFooter({ status: "available" }, "0.1.5").updateItem.label, "正在下载…");
});
