import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CLI = resolve(import.meta.dirname, "..", "..", "packages", "cli", "cofluxd.mjs");
const TEST_ORIGIN = "https://doctor-test.coflux.invalid";

async function listen(server) {
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  return server.address().port;
}

async function close(server) {
  await new Promise((resolveClose) => server.close(resolveClose));
}

async function upgradeServer({ path, origin, reject = false }) {
  const server = net.createServer((socket) => {
    let request = "";
    socket.on("data", (chunk) => {
      request += chunk.toString("latin1");
      if (!request.includes("\r\n\r\n")) return;
      const pathOk = request.startsWith(`GET ${path} HTTP/1.1\r\n`);
      const originOk = !origin || request.includes(`\r\nOrigin: ${origin}\r\n`);
      if (reject || !pathOk || !originOk) {
        socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
      } else {
        socket.end(
          "HTTP/1.1 101 Switching Protocols\r\n" +
          "Connection: Upgrade\r\n" +
          "Upgrade: websocket\r\n\r\n",
        );
      }
    });
  });
  return { server, port: await listen(server) };
}

async function unusedPort() {
  const server = net.createServer();
  const port = await listen(server);
  await close(server);
  return port;
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function fakeServiceCommands(home) {
  const bin = join(home, "fake-bin");
  mkdirSync(bin);
  const launchctl = join(bin, "launchctl");
  const systemctl = join(bin, "systemctl");
  writeFileSync(launchctl, "#!/bin/sh\nexit 0\n");
  writeFileSync(systemctl, "#!/bin/sh\nif [ \"$2\" = \"is-active\" ]; then echo active; fi\nexit 0\n");
  chmodSync(launchctl, 0o755);
  chmodSync(systemctl, 0o755);
  return bin;
}

function makeHome(serverPort, { grant = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), "coflux-doctor-test-"));
  writeJson(join(home, "settings.json"), { serverUrl: `ws://127.0.0.1:${serverPort}/daemon`, deviceName: "doctor-test" });
  writeJson(join(home, "credentials.json"), { daemonId: "daemon-test", deviceToken: "不应输出的凭证" });
  writeJson(join(home, "conn-state.json"), { state: "connected", since: Date.now(), lastAuthed: Date.now() });
  if (grant) {
    writeJson(join(home, "local-gateway.json"), {
      version: 1,
      privateKey: "不应输出的私钥",
      origins: [TEST_ORIGIN],
      grants: [{ grantId: "不应输出的 grant id", origin: TEST_ORIGIN }],
    });
  }
  return { home, fakeBin: fakeServiceCommands(home) };
}

async function runDoctor(home, fakeBin, gatewayPort) {
  const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, "doctor"], {
    env: {
      ...process.env,
      COFLUX_HOME: home,
      COFLUX_LOCAL_GATEWAY_PORT: String(gatewayPort),
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    },
    timeout: 15000,
    maxBuffer: 1024 * 1024,
  });
  assert.equal(stderr, "");
  return stdout;
}

test("cofluxd doctor：独立显示中心、gateway bind、grant 与 loopback，且不泄露 store 内容", async () => {
  const center = await upgradeServer({ path: "/daemon" });
  const gateway = await upgradeServer({ path: "/device", origin: TEST_ORIGIN });
  const fixture = makeHome(center.port);
  try {
    const output = await runDoctor(fixture.home, fixture.fakeBin, gateway.port);
    assert.match(output, /中心网络/);
    assert.match(output, /✓ DNS 解析/);
    assert.match(output, /✓ WS 升级握手/);
    assert.match(output, /本地直连/);
    assert.match(output, /✓ Gateway bind/);
    assert.match(output, /✓ 本地 grant/);
    assert.match(output, /✓ Loopback WS（主机侧）/);
    assert.match(output, /✓ 本地直连与中心 relay 均可用/);
    assert.doesNotMatch(output, /不应输出的私钥|不应输出的 grant id|不应输出的凭证/);
  } finally {
    await close(gateway.server);
    await close(center.server);
    rmSync(fixture.home, { recursive: true, force: true });
  }
});

test("cofluxd doctor：本地失败只标直连降级，中心 relay 与 daemon 状态保持独立", async () => {
  const center = await upgradeServer({ path: "/daemon" });
  const wrongGateway = await upgradeServer({ path: "/device", reject: true });
  const fixture = makeHome(center.port, { grant: false });
  try {
    const output = await runDoctor(fixture.home, fixture.fakeBin, wrongGateway.port);
    assert.match(output, /✓ Gateway bind/);
    assert.match(output, /⚠ 本地 grant/);
    assert.match(output, /⚠ Loopback WS（主机侧）/);
    assert.match(output, /⚠ 直连降级：中心 relay 仍可用，daemon 不是离线/);
    assert.doesNotMatch(output, /daemon (?:已)?离线/);
  } finally {
    await close(wrongGateway.server);
    await close(center.server);
    rmSync(fixture.home, { recursive: true, force: true });
  }
});

test("cofluxd doctor：中心真不可达时仍报告本地直连可用与冷启动边界", async () => {
  const centerPort = await unusedPort();
  const gateway = await upgradeServer({ path: "/device", origin: TEST_ORIGIN });
  const fixture = makeHome(centerPort);
  try {
    const output = await runDoctor(fixture.home, fixture.fakeBin, gateway.port);
    assert.match(output, /✗ TCP 连接/);
    assert.match(output, /✓ Gateway bind/);
    assert.match(output, /✓ 本地 grant/);
    assert.match(output, /✓ Loopback WS（主机侧）/);
    assert.match(output, /⚠ 中心不可达，但本地直连可用/);
    assert.match(output, /刷新\/冷启动不保证/);
  } finally {
    await close(gateway.server);
    rmSync(fixture.home, { recursive: true, force: true });
  }
});
