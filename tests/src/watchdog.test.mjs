import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { spawnDaemon, killTree } from "./harness.mjs";

// plan 033：半死连接自愈。事故场景是"对端完全沉默"——公司网络黑洞式丢包，TCP 连接停在
// ESTABLISHED，此后再无一个字节往返（无 RST/FIN，send 也不报错）。真实网络没法在测试里
// 造出这种黑洞，但可以造一个"完成一次 WS 握手后彻底不再读/写"的裸 TCP server 来精确模拟
// worker 视角下的同一现象：本测试不用 @coflux/protocol、不起真实 coflux server，纯 node:net。
const WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function startSilentWsServer() {
  const sockets = [];
  let connections = 0;
  const server = createServer((sock) => {
    connections++;
    sockets.push(sock);
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const headerEnd = buf.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      sock.off("data", onData); // 握手完成后彻底不再读——这就是"黑洞"：worker 发的探活 ping 有去无回
      const head = buf.subarray(0, headerEnd).toString("utf8");
      const m = /Sec-WebSocket-Key:\s*(\S+)/i.exec(head);
      if (!m) { sock.destroy(); return; }
      const accept = createHash("sha1").update(m[1] + WS_MAGIC).digest("base64");
      sock.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      // 握手后：不再读、不再写，连接停在 TCP ESTABLISHED，模拟静默丢包的黑洞网络。
    };
    sock.on("data", onData);
    sock.on("error", () => {}); // worker 单方面断开时的 ECONNRESET 之类噪音，不关心
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        connections: () => connections,
        port: server.address().port,
        close: () => new Promise((r) => { sockets.forEach((s) => s.destroy()); server.close(() => r()); }),
      });
    });
  });
}

test("半死连接自愈：idle watchdog 在阈值+宽限内放弃黑洞连接并重连", async () => {
  const fake = await startSilentWsServer();
  const home = mkdtempSync(join(tmpdir(), "coflux-test-watchdog-"));
  const daemon = spawnDaemon({
    ...process.env,
    COFLUX_SERVER: `ws://127.0.0.1:${fake.port}/daemon`,
    COFLUX_HOME: home,
    COFLUX_DEVICE_NAME: "watchdog-test",
    // 秒级阈值：测试要在合理时限内驱动到 watchdog 路径（crates/worker/src/main.rs env_u64 覆盖）。
    COFLUX_IDLE_PING_MS: "400",
    COFLUX_IDLE_GRACE_MS: "400",
    COFLUX_CONNECT_TIMEOUT_MS: "5000",
  });
  try {
    // 首次 WS 握手完成（worker 连上这条注定黑洞的连接）
    for (let i = 0; i < 100 && fake.connections() < 1; i++) await sleep(100);
    assert.equal(fake.connections(), 1, "worker 完成了首次握手（此后这条连接彻底沉默）");

    // idle(400ms) + grace(400ms) 后 worker 应判定连接已死、断开、backoff 后发起第二次连接——
    // 而不是永久挂在 stream.next() 上。
    let sawSecondConn = false;
    for (let i = 0; i < 150 && !sawSecondConn; i++) {
      await sleep(100);
      sawSecondConn = fake.connections() >= 2;
    }
    assert.ok(sawSecondConn, "半死连接被 watchdog 判死后，worker 主动断开并发起了重连（未永久挂死）");
  } finally {
    killTree(daemon);
    await fake.close();
    rmSync(home, { recursive: true, force: true });
  }
});
