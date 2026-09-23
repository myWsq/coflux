import assert from "node:assert/strict";
import { test } from "node:test";

import type { DesktopDaemonState } from "@/desktop-bridge";
import {
  advanceBaselineTracker,
  desktopDownloadUrl,
  headlessAgentPrompt,
  manualInstallCommand,
  newDevices,
  parseAuthorizeInput,
  showThisMacRow,
  startBaselineTracker,
} from "./add-device-view";

const TOKEN = "cf_authz_Ab3-x_Yz09";

function accepted(input: string): string {
  const result = parseAuthorizeInput(input);
  assert.equal(result.ok, true, `expected ${JSON.stringify(input)} to be accepted`);
  return result.ok ? result.token : "";
}

function rejected(input: string): string {
  const result = parseAuthorizeInput(input);
  assert.equal(result.ok, false, `expected ${JSON.stringify(input)} to be rejected`);
  const error = result.ok ? "" : result.error;
  assert.ok(error.length > 0);
  return error;
}

test("paste: the full authorization link yields its token", () => {
  assert.equal(accepted(`https://api.coflux.dev/authorize/${TOKEN}`), TOKEN);
});

test("paste: a trailing slash, query or fragment on the link is ignored", () => {
  assert.equal(accepted(`https://api.coflux.dev/authorize/${TOKEN}/`), TOKEN);
  assert.equal(accepted(`https://api.coflux.dev/authorize/${TOKEN}?from=cli`), TOKEN);
  assert.equal(accepted(`https://api.coflux.dev/authorize/${TOKEN}#x`), TOKEN);
  assert.equal(accepted(`https://self.example/prefix/authorize/${TOKEN}`), TOKEN);
});

test("paste: a bare token is accepted", () => {
  assert.equal(accepted(TOKEN), TOKEN);
});

test("paste: surrounding whitespace is trimmed on links and bare tokens", () => {
  assert.equal(accepted(`  https://api.coflux.dev/authorize/${TOKEN}\n`), TOKEN);
  assert.equal(accepted(`\t${TOKEN}  `), TOKEN);
});

test("paste: a URL without /authorize/ is rejected", () => {
  rejected("https://api.coflux.dev/other/cf_authz_abc");
  rejected("https://api.coflux.dev/authorize/");
  rejected("https://github.com/myWsq/coflux");
});

test("paste: a link whose token lacks the cf_authz_ shape is rejected", () => {
  rejected("https://api.coflux.dev/authorize/abc.DEF-123");
  rejected("https://api.coflux.dev/authorize/cf_authz_a%2Fb");
  rejected("https://api.coflux.dev/authorize/cf_authz_");
});

test("paste: free text and empty input are rejected", () => {
  rejected("");
  rejected("   ");
  rejected("please authorize my device");
  rejected("cf_authz_has space");
  rejected("tok");
});

test("download URL is pinned to the running app's version", () => {
  assert.equal(desktopDownloadUrl("2.4.0"), "https://github.com/myWsq/coflux/releases/download/v2.4.0/coflux-2.4.0-arm64.dmg");
});

test("manual command and prompt always pass --server with the daemon URL", () => {
  const url = "wss://self.example/prefix/daemon";
  assert.equal(manualInstallCommand(url), `npm i -g cofluxd && cofluxd up --server ${url}`);
  const prompt = headlessAgentPrompt(url);
  assert.ok(prompt.includes(`cofluxd up --server ${url}`));
  for (const phrase of ["Node.js 20", "npm config get prefix", "cofluxd status", "/authorize/", "loginctl enable-linger", "sudo", "non-zero exit", "添加设备"]) {
    assert.ok(prompt.includes(phrase), `prompt should mention ${phrase}`);
  }
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
