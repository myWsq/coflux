#!/usr/bin/env node
/** 隔离 PTY 语料播放器：只读 cwd 下的 fixture，stage 间用单字节输入做 barrier。 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const fixture = JSON.parse(readFileSync(join(process.cwd(), ".coflux-terminal-fixture.json"), "utf8"));
if (fixture.schemaVersion !== 1 || !Array.isArray(fixture.stages)) process.exit(2);

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.resume();

function write(bytes) {
  return new Promise((resolve, reject) => {
    process.stdout.write(bytes, (error) => error ? reject(error) : resolve());
  });
}

function barrier() {
  return new Promise((resolve) => process.stdin.once("data", resolve));
}

for (const stage of fixture.stages) {
  await write(Buffer.from(stage.dataBase64, "base64"));
  await barrier();
}
await write(Buffer.from(fixture.tailBase64, "base64"));
await new Promise(() => {});
