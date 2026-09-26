// Agent secret input (plan 20260926-agent-secret-input): the negatives nobody sees while using the
// product. A process outside every coflux terminal is refused on the kernel-attested secret socket
// for ask, value release and inject, even when it names a live session's pid in the request body;
// a value held by one terminal is shown as *** in what the center reads and caches (live read and
// checkpoint), including when it was echoed in a *different* terminal of the same workspace; another
// terminal cannot use it; and it is dropped when its terminal ends.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  create,
  DeviceEnvelopeSchema,
  DEVICE_PROTOCOL_VERSION,
  encodeDeviceEnvelope,
  SecretAnswerKind,
  SecretAnswerStatus,
} from "@coflux/protocol";
import { startStack, mkRepo, CLI_BIN } from "./harness.mjs";
import { openNativeDevice, utf8 } from "./device-harness.mjs";

const PORT = 8831;
const NAME = "BLACKBOX_SECRET";
// Distinctive enough that nothing else on a terminal screen contains it.
const VALUE = "sv-7c1f9e2ab04d";

let stack;
let accountToken;
let device;
let scratch;
const repos = [];

before(async () => {
  stack = await startStack({ port: PORT });
  const login = await fetch(`http://127.0.0.1:${PORT}/api/client/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ protocolVersion: 1, username: "admin", password: "admin" }),
  });
  const body = await login.json();
  assert.equal(body.ok, true, `account login failed: ${body.error ?? login.status}`);
  accountToken = body.value.token;
  device = await openNativeDevice(stack);
  scratch = mkdtempSync(join(tmpdir(), "coflux-secret-out-"));
});

after(async () => {
  device?.close();
  await stack?.stop();
  repos.forEach((repo) => repo.cleanup());
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

async function accountCommand(command) {
  const response = await fetch(`http://127.0.0.1:${PORT}/api/client/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accountToken}` },
    body: JSON.stringify({ protocolVersion: 1, command }),
  });
  return await response.json();
}

function socketPath() {
  return join(stack.home, "ipc", "secret.sock");
}

async function waitFor(check, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (last) return last;
    await sleep(150);
  }
  throw new Error(`timeout waiting for ${label}`);
}

/** One line-delimited JSON exchange on the secret socket, spoken without any application code. */
function exchange(request) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath());
    let buffer = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error("secret socket did not answer")), 10000);
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const end = buffer.indexOf("\n");
      if (end >= 0) finish(null, JSON.parse(buffer.slice(0, end)));
    });
    // The worker may refuse and close before our write lands; the reply is what matters.
    socket.on("error", (error) => {
      if (error.code !== "EPIPE" && error.code !== "ECONNRESET") finish(error);
    });
    socket.on("close", () => finish(new Error(`secret socket closed without a reply: ${buffer}`)));
  });
}

async function newTerminal(workspaceId, title) {
  const created = await accountCommand({ op: "terminal.new", workspaceId, title });
  assert.equal(created.ok, true, created.error);
  return created.value;
}

/** Type a command line into a terminal through the center (no desktop attach involved). */
async function typeLine(terminalId, text) {
  await waitFor(async () => {
    const sent = await accountCommand({ op: "terminal.send", terminalId, text, enter: true });
    return sent.ok;
  }, `terminal.send into ${terminalId}`);
}

/** Run `script` under /bin/sh in a terminal; stdout, stderr and the exit status land in files. */
async function runInTerminal(terminalId, label, script) {
  const base = join(scratch, label);
  await typeLine(terminalId, `sh -c '${script} > "${base}.out" 2> "${base}.err"; echo $? > "${base}.code"'`);
  const code = await waitFor(() => existsSync(`${base}.code`) && readFileSync(`${base}.code`, "utf8").trim(), `${label} to finish`, 30000);
  return {
    code: Number(code),
    out: readFileSync(`${base}.out`, "utf8"),
    err: readFileSync(`${base}.err`, "utf8"),
  };
}

let workspace;
let holder;
let other;
/** taskId → { sessionId, pid } from the device's own session catalog. */
const live = new Map();

test("setup: two terminals in one workspace and the secret socket up", async () => {
  const repo = mkRepo();
  repos.push(repo);
  device.control.send({ case: "projectImport", daemonId: stack.daemonId, path: repo.dir });
  const main = await device.control.waitFor((m) => m.case === "workspaceCreated" && m.workspace.isMain, "main workspace");
  workspace = main.workspace;
  await device.waitWorkspaceReady(workspace.id);
  holder = await newTerminal(workspace.id, "secret-holder");
  other = await newTerminal(workspace.id, "secret-other");
  await waitFor(async () => {
    const catalog = await device.catalog();
    for (const session of catalog.sessions) live.set(session.taskId, { sessionId: session.sessionId, pid: session.pid });
    return live.has(holder.id) && live.has(other.id);
  }, "both terminals running");
  await waitFor(() => existsSync(socketPath()), "the secret socket", 15000);
});

test("a process outside every coflux terminal is refused for ask, release and inject", async () => {
  const livePid = live.get(holder.id)?.pid;
  assert.ok(livePid, "the holder terminal's shell pid is known");

  const requests = [
    { op: "ask", name: NAME, reason: "outside", timeoutMs: 5000 },
    { op: "release", names: [NAME] },
    { op: "inject", name: NAME, file: ".env", cwd: workspace.path },
    // The body's pid is never identity: naming a live session's shell changes nothing.
    { op: "ask", name: NAME, reason: "forged", timeoutMs: 5000, pid: livePid, ppid: livePid },
    { op: "release", names: [NAME], pid: livePid },
    { op: "inject", name: NAME, file: ".env", cwd: workspace.path, pid: livePid },
  ];
  for (const request of requests) {
    const reply = await exchange(request);
    assert.equal(reply.ok, false, `${request.op} from outside must be refused`);
    assert.equal(reply.code, "not_in_session", `${request.op}: ${reply.error}`);
  }
  assert.equal(existsSync(join(workspace.path, ".env")), false, "nothing was written");
  // An outside ask never reaches a desktop.
  assert.equal(
    device.control.log.some((m) => m.case === "secretRequestsUpdated" && m.requests.length > 0),
    false,
    "a refused ask raised no request card",
  );
});

test("a provided value is redacted from the center's live read and checkpoint of another terminal", async () => {
  // The agent in the holder terminal asks; the answer comes from a desktop that never attached it.
  const askDone = runInTerminal(holder.id, "ask", `"${CLI_BIN}" secret ask ${NAME} --reason blackbox --timeout 60`);
  const update = await device.control.waitFor(
    (m) => m.case === "secretRequestsUpdated" && m.requests.some((request) => request.name === NAME),
    "the pending request snapshot",
    20000,
  );
  const pending = update.requests.find((request) => request.name === NAME);
  assert.equal(pending.taskId, holder.id);
  assert.equal(JSON.stringify(update).includes(VALUE), false, "the snapshot carries no value");

  const sessionLane = device.transport.lanes.find((lane) => lane.scope === 2);
  assert.ok(sessionLane, "a SESSION_CONTROL lane");
  const from = device.mark();
  device.sendFrame(encodeDeviceEnvelope(create(DeviceEnvelopeSchema, {
    protocolVersion: DEVICE_PROTOCOL_VERSION,
    channelId: sessionLane.device.nativeChannelId,
    payload: { case: "secretAnswer", value: { requestId: pending.requestId, kind: SecretAnswerKind.PROVIDE, value: VALUE } },
  })));
  const ack = await device.waitFor(
    (m) => m.case === "secretAnswerAck" && m.requestId === pending.requestId,
    "the answer acknowledgement",
    10000,
    from,
  );
  assert.equal(ack.status, SecretAnswerStatus.ACCEPTED);
  const asked = await askDone;
  assert.equal(asked.out, "provided\n");
  assert.equal(asked.code, 0);
  await device.control.waitFor(
    (m) => m.case === "secretRequestsUpdated" && m.requests.every((request) => request.requestId !== pending.requestId),
    "the request leaving the pending set",
  );

  // The value is echoed in the *other* terminal, whose own value set is empty.
  await typeLine(other.id, `echo ${VALUE}`);
  const read = await waitFor(async () => {
    const result = await accountCommand({ op: "terminal.read", terminalId: other.id, lines: 50 });
    return result.ok && result.value.text.includes("***") ? result.value : null;
  }, "a redacted center read");
  assert.equal(read.text.includes(VALUE), false, `the center read leaked the value: ${read.text}`);

  await device.control.waitFor(
    (m) => m.case === "sessionCheckpoint" && m.sessionId === live.get(other.id).sessionId && utf8(m.ansiSnapshot).includes("***"),
    "a redacted checkpoint of the other terminal",
    15000,
  );
  for (const message of device.control.log) {
    if (message.case !== "sessionCheckpoint") continue;
    assert.equal(utf8(message.ansiSnapshot).includes(VALUE), false, "no checkpoint carries the value");
  }
});

test("another terminal cannot use the value, and it ends with its terminal", async () => {
  const foreign = await runInTerminal(other.id, "foreign", `"${CLI_BIN}" secret exec ${NAME} -- /bin/echo leaked`);
  assert.notEqual(foreign.code, 0);
  assert.match(foreign.err, /not provided/);
  assert.equal(foreign.out, "", "the command never ran");

  const stopped = await accountCommand({ op: "terminal.stop", terminalId: holder.id });
  assert.equal(stopped.ok, true, stopped.error);
  // With the holder gone the value is no longer held anywhere, so it is no longer redacted: the
  // other terminal's scrollback shows the raw echo again.
  await waitFor(async () => {
    const result = await accountCommand({ op: "terminal.read", terminalId: other.id, lines: 50 });
    return result.ok && result.value.text.includes(VALUE);
  }, "the value to be dropped with its terminal", 20000);
  const reply = await exchange({ op: "release", names: [NAME] });
  assert.equal(reply.ok, false);
});
