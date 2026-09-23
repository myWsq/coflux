import assert from "node:assert/strict";
import { test } from "node:test";

import type { DesktopDaemonState } from "@/desktop-bridge";
import {
  advanceBaselineTracker,
  desktopDownloadUrl,
  headlessAgentPrompt,
  joinKeyMinutesLeft,
  manualInstallCommand,
  newDevices,
  showThisMacRow,
  startBaselineTracker,
} from "./add-device-view";

const KEY = "cf_join_Ab3-x_Yz09";

test("download URL is pinned to the running app's version", () => {
  assert.equal(desktopDownloadUrl("2.4.0"), "https://github.com/myWsq/coflux/releases/download/v2.4.0/coflux-2.4.0-arm64.dmg");
});

test("manual command carries --server with the daemon URL and the join key", () => {
  const url = "wss://self.example/prefix/daemon";
  assert.equal(manualInstallCommand(url, KEY), `npm i -g cofluxd && cofluxd up --server ${url} --key ${KEY}`);
});

test("agent prompt: runs the one keyed command and confirms with cofluxd status", () => {
  const url = "wss://self.example/prefix/daemon";
  const prompt = headlessAgentPrompt(url, KEY);
  assert.ok(prompt.includes(`cofluxd up --server ${url} --key ${KEY}`));
  for (const phrase of ["Node.js 20", "npm i -g cofluxd", "cofluxd status"]) {
    assert.ok(prompt.includes(phrase), `prompt should mention ${phrase}`);
  }
});

test("agent prompt: short, and never sends anyone back to a link", () => {
  const prompt = headlessAgentPrompt("wss://api.coflux.dev/daemon", KEY);
  assert.ok(prompt.split("\n").length <= 7, "prompt should stay a handful of lines");
  for (const phrase of ["/authorize/", "link", "链接", "paste", "添加设备"]) {
    assert.ok(!prompt.toLowerCase().includes(phrase.toLowerCase()), `prompt should not mention ${phrase}`);
  }
});

test("join key countdown: whole minutes rounded up, zero once expired", () => {
  const now = 1_000_000;
  assert.equal(joinKeyMinutesLeft(now + 60 * 60_000, now), 60);
  assert.equal(joinKeyMinutesLeft(now + 59 * 60_000 + 1, now), 60);
  assert.equal(joinKeyMinutesLeft(now + 30_000, now), 1);
  assert.equal(joinKeyMinutesLeft(now, now), 0);
  assert.equal(joinKeyMinutesLeft(now - 1, now), 0);
});

const A = { daemonId: "a", name: "alpha" };
const B = { daemonId: "b", name: "beta" };
const C = { daemonId: "c", name: "gamma" };

test("baseline not yet taken → nothing is new", () => {
  const tracker = startBaselineTracker("disconnected", [], false);
  assert.equal(tracker.baseline, null);
  assert.deepEqual(newDevices(tracker.baseline, [A, B]), []);
  assert.deepEqual(newDevices(null, [A]), []);
});

test("opened while connected: the current list is the baseline and only unseen ids are new", () => {
  const tracker = startBaselineTracker("connected", [A, B], true);
  assert.deepEqual(newDevices(tracker.baseline, [A, B]), []);
  assert.deepEqual(newDevices(tracker.baseline, [A, { ...B, online: false }, C]), [C]);
  // Once taken, the baseline is never replaced.
  assert.equal(advanceBaselineTracker(tracker, "connected", [A, B, C]), tracker);
});

test("opened before the first live snapshot: the status flip alone does not take the baseline", () => {
  const stale: { daemonId: string; name: string }[] = [];
  let tracker = startBaselineTracker("connecting", stale, false);
  tracker = advanceBaselineTracker(tracker, "connected", stale);
  assert.equal(tracker.baseline, null);
  // Same list reference again (e.g. an unrelated store update) → still waiting.
  tracker = advanceBaselineTracker(tracker, "connected", stale);
  assert.equal(tracker.baseline, null);
  assert.deepEqual(newDevices(tracker.baseline, [A, B]), []);
  // The snapshot assigns a fresh array: that is the baseline, none of its devices are new.
  const snapshot = [A, B];
  tracker = advanceBaselineTracker(tracker, "connected", snapshot);
  assert.deepEqual(newDevices(tracker.baseline, snapshot), []);
  assert.deepEqual(newDevices(tracker.baseline, [A, B, C]), [C]);
});

test("opened while connected but before any list arrived: the empty list is not the baseline", () => {
  const empty: { daemonId: string; name: string }[] = [];
  let tracker = startBaselineTracker("connected", empty, false);
  assert.equal(tracker.baseline, null);
  assert.deepEqual(newDevices(tracker.baseline, [A, B]), []);
  tracker = advanceBaselineTracker(tracker, "connected", empty);
  assert.equal(tracker.baseline, null);
  // The first snapshot becomes the baseline: the devices it brings are not "new".
  const snapshot = [A, B];
  tracker = advanceBaselineTracker(tracker, "connected", snapshot);
  assert.deepEqual(newDevices(tracker.baseline, snapshot), []);
  assert.deepEqual(newDevices(tracker.baseline, [A, B, C]), [C]);
});

test("dropping out of connected before the snapshot restarts the wait", () => {
  const cached = [A];
  let tracker = startBaselineTracker("disconnected", cached, true);
  tracker = advanceBaselineTracker(tracker, "connected", cached);
  tracker = advanceBaselineTracker(tracker, "disconnected", cached);
  assert.equal(tracker.daemonsAtConnect, null);
  tracker = advanceBaselineTracker(tracker, "connected", cached);
  assert.equal(tracker.baseline, null);
  tracker = advanceBaselineTracker(tracker, "connected", [A, B]);
  assert.deepEqual(newDevices(tracker.baseline, [A, B]), []);
});

const NOT_INSTALLED: DesktopDaemonState = { status: "not-installed", bundled: true, installed: false, running: false, registered: false, fda: "unknown", binDir: "/Users/alice/.coflux/bin" };

test("this-Mac row: only a bundled build whose daemon is not installed", () => {
  assert.equal(showThisMacRow(NOT_INSTALLED), true);
  assert.equal(showThisMacRow({ ...NOT_INSTALLED, bundled: false }), false);
  assert.equal(showThisMacRow({ ...NOT_INSTALLED, status: "stopped", installed: true }), false);
  assert.equal(showThisMacRow({ ...NOT_INSTALLED, status: "pending-auth", installed: true, running: true }), false);
  assert.equal(showThisMacRow({ ...NOT_INSTALLED, status: "running", installed: true, running: true, registered: true }), false);
  assert.equal(showThisMacRow(null), false);
});
