import assert from "node:assert/strict";
import test from "node:test";

import { MAX_DEVICE_FRAME_BYTES, P2P_CHUNK_BYTES } from "@coflux/protocol";

import { P2pFrameAssembler, p2pFrameChunks } from "./p2p-framing";

test("chunks 与重组互逆：大帧跨多 chunk、尾随小帧同批弹出", () => {
  const big = new Uint8Array(300 * 1024).fill(0xab); // 超过 Chrome 单消息上限，必然跨 chunk
  const small = new TextEncoder().encode("tail");
  const wire = [...p2pFrameChunks(big), ...p2pFrameChunks(small)];
  assert.ok(wire.length > 2);
  assert.ok(wire.every((chunk) => chunk.byteLength <= P2P_CHUNK_BYTES));

  const assembler = new P2pFrameAssembler();
  const got = wire.flatMap((chunk) => assembler.push(chunk));
  assert.equal(got.length, 2);
  assert.deepEqual(got[0], big);
  assert.deepEqual(got[1], small);
});

test("一个 message 里粘连多帧全部弹出", () => {
  const wire = new Uint8Array([...p2pFrameChunks(new Uint8Array([1])).flatMap((c) => [...c]), ...p2pFrameChunks(new Uint8Array([2, 3])).flatMap((c) => [...c])]);
  const got = new P2pFrameAssembler().push(wire);
  assert.equal(got.length, 2);
  assert.deepEqual([...got[0]!], [1]);
  assert.deepEqual([...got[1]!], [2, 3]);
});

test("帧头跨 message 边界到达也能重组", () => {
  const frame = new Uint8Array([7, 8, 9]);
  const wire = p2pFrameChunks(frame)[0]!;
  const assembler = new P2pFrameAssembler();
  assert.equal(assembler.push(wire.subarray(0, 2)).length, 0); // 头只到一半
  const got = assembler.push(wire.subarray(2));
  assert.equal(got.length, 1);
  assert.deepEqual([...got[0]!], [7, 8, 9]);
});

test("零长与超限前缀是协议违规", () => {
  assert.throws(() => new P2pFrameAssembler().push(new Uint8Array([0, 0, 0, 0])));
  const oversized = new Uint8Array(4);
  new DataView(oversized.buffer).setUint32(0, MAX_DEVICE_FRAME_BYTES + 1);
  assert.throws(() => new P2pFrameAssembler().push(oversized));
});
