import assert from "node:assert/strict";
import { test } from "node:test";

import { INITIAL_UPDATE_STATE, reduceUpdateState } from "./update-state";

test("检查 → 发现 → 下载进度 → 下载完成", () => {
  let state = reduceUpdateState(INITIAL_UPDATE_STATE, { type: "checking" });
  assert.deepEqual(state, { status: "checking" });
  state = reduceUpdateState(state, { type: "available", version: "0.2.0" });
  assert.deepEqual(state, { status: "available", version: "0.2.0" });
  state = reduceUpdateState(state, { type: "progress", percent: 42.6 });
  assert.deepEqual(state, { status: "downloading", version: "0.2.0", percent: 43 });
  state = reduceUpdateState(state, { type: "downloaded", version: "0.2.0" });
  assert.deepEqual(state, { status: "downloaded", version: "0.2.0" });
});

test("没有新版本与出错都是可重试的终态，带原因", () => {
  assert.deepEqual(reduceUpdateState({ status: "checking" }, { type: "not-available" }), { status: "not-available" });
  assert.deepEqual(reduceUpdateState({ status: "checking" }, { type: "error", message: "ENOTFOUND" }), { status: "error", message: "ENOTFOUND" });
});

test("已下载完成是终态：周期复查不会把它退回 checking / not-available；出错或新版本才改变", () => {
  const downloaded = { status: "downloaded" as const, version: "0.2.0" };
  assert.equal(reduceUpdateState(downloaded, { type: "checking" }), downloaded);
  assert.equal(reduceUpdateState(downloaded, { type: "not-available" }), downloaded);
  assert.equal(reduceUpdateState(downloaded, { type: "progress", percent: 10 }), downloaded);
  assert.deepEqual(reduceUpdateState(downloaded, { type: "error", message: "x" }), { status: "error", message: "x" });
  assert.deepEqual(reduceUpdateState(downloaded, { type: "available", version: "0.3.0" }), { status: "available", version: "0.3.0" });
});

test("进度封在 0-100 并取整", () => {
  assert.equal(reduceUpdateState({ status: "available", version: "1" }, { type: "progress", percent: -3 }).percent, 0);
  assert.equal(reduceUpdateState({ status: "available", version: "1" }, { type: "progress", percent: 120 }).percent, 100);
});
