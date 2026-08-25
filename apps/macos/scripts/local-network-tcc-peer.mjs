#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { createServer } from "node:net";

const PROTOCOL_VERSION = "coflux-local-network-tcc-peer-v1";
const MAX_LINE_BYTES = 65_536;

function parseArguments(argv) {
  const options = { host: "0.0.0.0", port: 0 };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--host") options.host = argv[++index];
    else if (argument === "--port") options.port = Number(argv[++index]);
    else if (argument === "--help") options.help = true;
    else throw new Error(`未知参数：${argument}`);
  }
  if (options.help) return options;
  if (typeof options.host !== "string" || options.host.length === 0) throw new Error("--host 不能为空");
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535) {
    throw new Error("--port 必须是 0–65535；0 表示自动分配");
  }
  return options;
}

function usage() {
  return [
    "在第二台、同一物理 Wi-Fi/Ethernet LAN 的受控 Mac 上运行：",
    "  node apps/macos/scripts/local-network-tcc-peer.mjs --host 0.0.0.0 --port 0",
    "",
    "把 sentinel 中的 port 与这台 Mac 的非 loopback LAN IP 交给 acceptance 脚本。",
    "本服务只回显协议版本、run ID 与随机 nonce，不接触 Coflux 凭据或生产数据。",
  ].join("\n");
}

function validRequest(value) {
  return value
    && value.protocolVersion === PROTOCOL_VERSION
    && typeof value.runID === "string"
    && value.runID.length >= 8
    && typeof value.nonce === "string"
    && value.nonce.length >= 24;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const peerID = `peer-${randomUUID()}`;
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.setTimeout(30_000);
    let buffer = Buffer.alloc(0);
    const fail = () => socket.destroy();
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_LINE_BYTES) {
        fail();
        return;
      }
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      let request;
      try {
        request = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
      } catch {
        fail();
        return;
      }
      if (!validRequest(request)) {
        fail();
        return;
      }
      const response = {
        protocolVersion: PROTOCOL_VERSION,
        runID: request.runID,
        nonce: request.nonce,
        peerID,
      };
      socket.end(`${JSON.stringify(response)}\n`);
    });
    socket.on("timeout", fail);
    socket.on("error", () => undefined);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(options.port, options.host, resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("无法读取 peer listen address");
  console.log(`COFLUX_TCC_PEER ${JSON.stringify({
    protocolVersion: PROTOCOL_VERSION,
    peerID,
    listenHost: options.host,
    port: address.port,
    pid: process.pid,
  })}`);

  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    for (const socket of sockets) socket.destroy();
    server.close(() => process.exit(0));
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

main().catch((error) => {
  console.error(error?.stack ?? error);
  process.exitCode = 1;
});
