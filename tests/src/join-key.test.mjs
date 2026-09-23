// One-time device join keys (plan 20260924-device-join-keys). Guards the semantics that stay invisible
// while using the product: a key that works twice, outlives its hour, survives 换一个, or lands a device
// in the wrong account. The happy and rejection paths also drive a real daemon, not only a raw socket.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { startStack, rawDaemon, spawnDaemon, killTree } from "./harness.mjs";

const PORT = 8830;
const ALICE = { email: "alice@join-key.test", password: "alice-join-key-password" };
const BOB = { email: "bob@join-key.test", password: "bob-join-key-password" };
// Many enrolls, logins and mints from 127.0.0.1 in one file: lift the per-IP / per-account budgets.
const SERVER_ENV = {
  COFLUX_ENROLL_RATE_LIMIT: "1000",
  COFLUX_LOGIN_RATE_LIMIT: "1000",
  COFLUX_JOIN_KEY_MINT_RATE_LIMIT: "1000",
};

let stack;
const clients = new Map();
const extraDaemons = [];
const extraHomes = [];
const rawSockets = [];

before(async () => {
  stack = await startStack({ port: PORT, users: [ALICE, BOB], serverEnv: SERVER_ENV });
  for (const user of [ALICE, BOB]) {
    const client = stack.makeClient();
    await client.authSubscribe(user.email, user.password);
    clients.set(user, client);
  }
});

after(async () => {
  for (const client of clients.values()) client.close();
  for (const socket of rawSockets) socket.close();
  for (const daemon of extraDaemons) killTree(daemon);
  await sleep(200);
  await stack?.stop();
  for (const home of extraHomes) rmSync(home, { recursive: true, force: true });
});

/** Mint a key as `client`; `replaces` is the key 换一个 supersedes. */
async function mint(client, replaces = "") {
  const requestId = randomUUID();
  client.send({ case: "deviceJoinKeyCreate", requestId, replaces });
  const reply = await client.waitFor((m) => m.case === "deviceJoinKeyCreated" && m.requestId === requestId, "join key minted");
  assert.equal(reply.error, "", `mint failed: ${reply.error}`);
  assert.match(reply.key, /^cf_join_[A-Za-z0-9_-]+$/);
  assert.ok(reply.expiresAt > Date.now(), "the key expires in the future");
  return reply.key;
}

/** Enroll a bare /daemon socket with `joinKey`; resolves with the server's first answer. */
async function enrollRaw(joinKey, name = `raw-${randomUUID().slice(0, 8)}`) {
  const daemon = rawDaemon(stack.port);
  rawSockets.push(daemon);
  await daemon.ready;
  daemon.send({ case: "daemonEnrollRequest", name, host: "join-key-host", platform: "linux", joinKey });
  const answer = await daemon.waitFor(
    (m) => ["daemonEnrolled", "daemonJoinKeyRejected", "daemonAuthorizePending", "daemonAuthError"].includes(m.case),
    "enroll answer",
  );
  return { daemon, answer };
}

async function expectRejected(joinKey) {
  const { daemon, answer } = await enrollRaw(joinKey);
  assert.equal(answer.case, "daemonJoinKeyRejected", `expected a rejection, got ${answer.case}`);
  assert.ok(answer.reason.length > 0, "the rejection carries a reason");
  // Rejected outright and closed: never a fallback link.
  const closed = await Promise.race([daemon.closed, sleep(5000).then(() => "timeout")]);
  assert.notEqual(closed, "timeout", "socket was not closed after the rejection");
  assert.ok(!daemon.log.some((m) => m.case === "daemonAuthorizePending"), "a rejected key never yields a link");
}

async function expectEnrolled(joinKey) {
  const { daemon, answer } = await enrollRaw(joinKey);
  assert.equal(answer.case, "daemonEnrolled", `expected enrollment, got ${answer.case}${answer.reason ? `: ${answer.reason}` : ""}`);
  assert.ok(answer.daemonId && answer.deviceToken, "enrollment carries the device credentials");
  daemon.close();
  return answer.daemonId;
}

/** Device ids in a fresh snapshot of `user`'s account. */
async function accountDevices(user) {
  const client = stack.makeClient();
  try {
    const snapshot = await client.authSubscribe(user.email, user.password);
    return snapshot.daemons.map((daemon) => daemon.daemonId);
  } finally {
    client.close();
  }
}

async function waitUntil(predicate, label, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (predicate()) return;
    await sleep(100);
  }
  throw new Error(`timeout waiting for ${label}`);
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

/** A second real daemon (supervisor + worker) in its own home, holding `joinKey` in the key file. */
function spawnKeyedDaemon(joinKey, name) {
  const home = mkdtempSync(join(tmpdir(), "coflux-join-key-home-"));
  extraHomes.push(home);
  writeFileSync(join(home, "join-key.json"), JSON.stringify({ key: joinKey }) + "\n", { mode: 0o600 });
  const daemon = spawnDaemon({ ...stack.daemonEnv, COFLUX_HOME: home, COFLUX_DEVICE_NAME: name });
  extraDaemons.push(daemon);
  return { home, daemon };
}

test("a minted key enrolls into the minting account, and only once", async () => {
  const key = await mint(clients.get(ALICE));
  const daemonId = await expectEnrolled(key);
  assert.ok((await accountDevices(ALICE)).includes(daemonId), "the device joined the minting account");
  assert.ok(!(await accountDevices(BOB)).includes(daemonId), "the device is not in any other account");
  await expectRejected(key);
});

test("换一个 revokes the replaced key at once; the replacement works", async () => {
  const alice = clients.get(ALICE);
  const first = await mint(alice);
  const second = await mint(alice, first);
  await expectRejected(first);
  const daemonId = await expectEnrolled(second);
  assert.ok((await accountDevices(ALICE)).includes(daemonId));
});

test("a key minted by one account never yields a device in another", async () => {
  const aliceKey = await mint(clients.get(ALICE));
  // Bob naming Alice's key as the one he replaces must not revoke it.
  const bobKey = await mint(clients.get(BOB), aliceKey);

  const bobDevice = await expectEnrolled(bobKey);
  assert.ok((await accountDevices(BOB)).includes(bobDevice), "Bob's key enrolls into Bob's account");
  assert.ok(!(await accountDevices(ALICE)).includes(bobDevice), "Bob's key never enrolls into Alice's account");

  const aliceDevice = await expectEnrolled(aliceKey);
  assert.ok((await accountDevices(ALICE)).includes(aliceDevice), "Alice's key survived Bob's replace and enrolls into Alice's account");
  assert.ok(!(await accountDevices(BOB)).includes(aliceDevice));
});

test("a real daemon joins with the key file, and the key file is gone", async () => {
  const key = await mint(clients.get(ALICE));
  const { home } = spawnKeyedDaemon(key, "join-key-real");
  const credPath = join(home, "credentials.json");
  await waitUntil(() => existsSync(credPath), "credentials.json");
  await waitUntil(() => !existsSync(join(home, "join-key.json")), "the key file to be deleted");
  assert.equal(readJson(join(home, "join-outcome.json"))?.status, "joined");
  assert.ok(!existsSync(join(home, "pending-auth.json")), "a key enroll never goes through a link");
  const credentials = readJson(credPath);
  assert.ok(credentials?.daemonId, "credentials carry the device id");
  assert.ok((await accountDevices(ALICE)).includes(credentials.daemonId), "the real daemon joined the minting account");
});

test("a real daemon with a spent key records the rejection and keeps running", async () => {
  const key = await mint(clients.get(ALICE));
  await expectEnrolled(key); // spend it
  const { home, daemon } = spawnKeyedDaemon(key, "join-key-rejected");
  const outcomePath = join(home, "join-outcome.json");
  await waitUntil(() => readJson(outcomePath)?.status === "rejected", "a rejected outcome");
  assert.ok(readJson(outcomePath).reason, "the outcome carries the server's reason");
  assert.ok(!existsSync(join(home, "join-key.json")), "the key file is deleted on rejection");
  assert.ok(!existsSync(join(home, "credentials.json")), "no credentials from a spent key");
  const workerPid = readFileSync(join(home, "worker.pid"), "utf8").trim();

  // The worker does not exit: its next connection enrolls without a key, i.e. falls back to a link.
  await waitUntil(() => existsSync(join(home, "pending-auth.json")), "the keyless re-enroll");
  assert.doesNotThrow(() => process.kill(-daemon.pid, 0), "the daemon process group is still alive");
  assert.equal(readFileSync(join(home, "worker.pid"), "utf8").trim(), workerPid, "the same worker kept running");
  assert.ok(!existsSync(join(home, "join-key.json")), "the key is never presented again");
});

test("an expired key is rejected", async () => {
  // A short TTL only for a second, sequential stack on the same port: the cases above stay untimed.
  for (const client of clients.values()) client.close();
  clients.clear();
  for (const daemon of extraDaemons.splice(0)) killTree(daemon);
  await stack.stop();
  stack = null;
  stack = await startStack({ port: PORT, serverEnv: { ...SERVER_ENV, COFLUX_JOIN_KEY_TTL_MS: "1500" } });
  const admin = stack.makeClient();
  clients.set({ email: stack.username }, admin);
  await admin.authSubscribe(stack.username, stack.password);
  const key = await mint(admin);
  await sleep(2500);
  await expectRejected(key);
});
