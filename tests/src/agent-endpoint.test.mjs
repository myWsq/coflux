// Local agent endpoint hardening (plan 20260926-agent-endpoint-hardening): the negatives nobody sees
// while using the product. On the loopback TCP gateway, `/agent` and `/hook` refuse a foreign,
// missing or wrong-port Host and any Origin (`null` included) while a CLI-shaped request with a
// live in-tree pid still works. On the kernel-attested `ipc/agent.sock`, a caller outside every
// coflux terminal is refused even when its body names a live session's pid. Inside a test terminal,
// where the harness sets COFLUX_LOCAL_GATEWAY_PORT=0 so TCP is impossible, both the Rust CLI and
// the npm coflux.mjs still work: proof that both use the socket first.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { startStack, mkRepo, CLI_BIN } from "./harness.mjs";
import { openNativeDevice } from "./device-harness.mjs";

const PORT = 8827;
const ROOT = resolve(import.meta.dirname, "..", "..");
const NPM_CLI = join(ROOT, "packages", "cli", "coflux.mjs");
const TITLE = "endpoint-probe";

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
  scratch = mkdtempSync(join(tmpdir(), "coflux-endpoint-out-"));
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

function agentSocketPath() {
  return join(stack.home, "ipc", "agent.sock");
}

async function waitFor(check, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const last = await check();
    if (last) return last;
    await sleep(150);
  }
  throw new Error(`timeout waiting for ${label}`);
}

/**
 * One raw HTTP/1.1 POST with exactly the given header lines (so Host can be absent or foreign),
 * spoken without any application code. `target` is `{ host, port }` for TCP or a socket path.
 */
function rawPost(target, path, headerLines, body) {
  const payload = JSON.stringify(body);
  const head = [
    `POST ${path} HTTP/1.1`,
    ...headerLines,
    "content-type: application/json",
    `content-length: ${Buffer.byteLength(payload)}`,
    "connection: close",
  ].join("\r\n");
  return new Promise((resolvePost, reject) => {
    const socket = createConnection(target);
    const chunks = [];
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      const raw = Buffer.concat(chunks).toString("utf8");
      const end = raw.indexOf("\r\n\r\n");
      if (end < 0) return reject(error ?? new Error(`no HTTP response: ${JSON.stringify(raw)}`));
      const status = Number(raw.slice(0, end).split("\r\n")[0].split(" ")[1]);
      let json = null;
      try { json = JSON.parse(raw.slice(end + 4)); } catch { /* asserted by the caller */ }
      resolvePost({ status, json, raw });
    };
    const timer = setTimeout(() => finish(new Error("the endpoint did not answer")), 30000);
    socket.on("connect", () => socket.write(`${head}\r\n\r\n${payload}`));
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("error", (error) => finish(error));
    socket.on("close", () => finish());
  });
}

async function newTerminal(workspaceId, title) {
  const created = await accountCommand({ op: "terminal.new", workspaceId, title });
  assert.equal(created.ok, true, created.error);
  return created.value;
}

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

let terminal;
let livePid;
let gatewayPort;

test("setup: a terminal, its shell pid, the gateway port and the agent socket", async () => {
  const repo = mkRepo();
  repos.push(repo);
  device.control.send({ case: "projectImport", daemonId: stack.daemonId, path: repo.dir });
  const main = await device.control.waitFor((m) => m.case === "workspaceCreated" && m.workspace.isMain, "main workspace");
  await device.waitWorkspaceReady(main.workspace.id);
  terminal = await newTerminal(main.workspace.id, TITLE);
  livePid = await waitFor(async () => {
    const catalog = await device.catalog();
    return catalog.sessions.find((session) => session.taskId === terminal.id)?.pid;
  }, "the terminal running");
  gatewayPort = device.gateway?.port;
  assert.ok(gatewayPort, "the paired gateway port is known");
  await waitFor(() => existsSync(agentSocketPath()), "the agent socket", 15000);
});

const bodies = () => ({
  "/agent": { action: "terminal.list", pid: livePid, ppid: livePid, cwd: "" },
  "/hook": { agent: "claude", event: "Stop", pid: livePid, ppid: livePid },
});

test("TCP: a CLI-shaped request with an in-tree pid still works", async () => {
  const tcp = { host: "127.0.0.1", port: gatewayPort };
  for (const [path, body] of Object.entries(bodies())) {
    const reply = await rawPost(tcp, path, [`host: 127.0.0.1:${gatewayPort}`], body);
    assert.equal(reply.status, 200, `${path}: ${reply.raw}`);
    assert.equal(reply.json?.ok, true, `${path}: ${reply.raw}`);
  }
});

test("TCP: a foreign, missing or wrong-port Host and any Origin are refused with a readable 403", async () => {
  const tcp = { host: "127.0.0.1", port: gatewayPort };
  const valid = `host: 127.0.0.1:${gatewayPort}`;
  const cases = {
    "foreign Host (DNS rebinding)": [`host: attacker.example:${gatewayPort}`],
    "missing Host": [],
    "wrong-port Host": [`host: 127.0.0.1:${gatewayPort + 1}`],
    "Origin: http://x": [valid, "origin: http://x"],
    "Origin: null": [valid, "origin: null"],
  };
  for (const [path, body] of Object.entries(bodies())) {
    for (const [label, headers] of Object.entries(cases)) {
      const reply = await rawPost(tcp, path, headers, body);
      assert.equal(reply.status, 403, `${path} ${label}: ${reply.raw}`);
      assert.equal(reply.json?.ok, false, `${path} ${label}: ${reply.raw}`);
      assert.match(reply.json?.error ?? "", /^refused: /, `${path} ${label}: ${reply.raw}`);
    }
  }
});

test("socket: a caller outside every coflux terminal is refused even when its body names a live pid", async () => {
  const socket = agentSocketPath();
  for (const [path, body] of Object.entries(bodies())) {
    // The forged pid is the live terminal's own shell: it must change nothing.
    const forged = await rawPost(socket, path, ["host: localhost"], body);
    assert.notEqual(forged.status, 200, `${path} forged: ${forged.raw}`);
    assert.equal(forged.json?.ok, false, `${path} forged: ${forged.raw}`);
    const { pid: _pid, ppid: _ppid, ...bare } = body;
    const plain = await rawPost(socket, path, ["host: localhost"], bare);
    assert.notEqual(plain.status, 200, `${path} without pid: ${plain.raw}`);
    assert.equal(plain.json?.ok, false, `${path} without pid: ${plain.raw}`);
  }
});

test("inside a terminal with no usable TCP port, both CLIs work over the socket", async () => {
  const port = await runInTerminal(terminal.id, "port", `printf %s "$COFLUX_LOCAL_GATEWAY_PORT"`);
  assert.equal(port.out, "0", "the harness leaves the terminal no TCP gateway port to use");

  const rust = await runInTerminal(terminal.id, "rust-list", `"${CLI_BIN}" terminal list`);
  assert.equal(rust.code, 0, `Rust CLI failed: ${rust.err}`);
  assert.ok(rust.out.includes(TITLE), `Rust CLI output lacks the terminal: ${rust.out}`);

  const npm = await runInTerminal(terminal.id, "npm-list", `"${process.execPath}" "${NPM_CLI}" terminal list`);
  assert.equal(npm.code, 0, `npm CLI failed: ${npm.err}`);
  assert.ok(npm.out.includes(TITLE), `npm CLI output lacks the terminal: ${npm.out}`);
});
