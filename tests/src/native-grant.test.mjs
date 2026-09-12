// Independent proof-handshake attacks against the real native worker listener.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHmac } from "node:crypto";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { create, DeviceEnvelopeSchema, DEVICE_PROTOCOL_VERSION, encodeDeviceEnvelope, decodeDeviceEnvelope } from "@coflux/protocol";
import { startStack } from "./harness.mjs";
import { TailcatTestHelper } from "./tailcat-harness.mjs";
const PORT = 8853;
let stack, control, helper, nextStream = 0;
before(async () => {
  stack = await startStack({ port: PORT }); control = stack.makeClient(); await control.authSubscribe();
  helper = new TailcatTestHelper(process.env.COFLUX_TRANSPORT_BIN || resolve(import.meta.dirname, "../../target/debug/coflux-transport"));
  stack.nativeHelpers.add(helper); await helper.request("hello", { version: 1 });
});
after(async () => { control?.close(); await stack?.stop(); });
async function grant() {
  const connection = randomUUID(), clientInstanceId = randomUUID();
  const { publicKey } = await helper.request("prepare", { connection });
  for (let attempt = 0; attempt < 100; attempt++) {
    const channelId = randomUUID();
    control.send({ case: "deviceTailcatConnect", daemonId: stack.daemonId, channelId, clientInstanceId,
      transportGeneration: 1n, protocolVersion: DEVICE_PROTOCOL_VERSION, nodePublicKey: publicKey, scope: 2 });
    const result = await control.waitFor(m => m.case === "deviceTailcatResult" && m.channelId === channelId, "native grant");
    if (result.ok) return { ...result, connection };
    await sleep(100);
  }
  throw new Error("native grant unavailable");
}
async function dial(value, channelId = value.channelId) {
  const stream = ++nextStream;
  await helper.request("open", { connection: value.connection, stream, address: value.address });
  helper.send(stream, Buffer.from(JSON.stringify({ channelId })));
  return stream;
}
const frame = stream => helper.wait(f => f.kind === 2 && f.stream === stream);
const closed = stream => helper.wait(f => f.event?.op === "closed" && f.stream === stream, 8000);
function proof(value, nonce) {
  const length = Buffer.alloc(4); length.writeUInt32BE(Buffer.byteLength(value.channelId));
  return createHmac("sha256", value.proofKey).update("coflux-tailcat-channel-v1\0").update(length).update(value.channelId).update(nonce).digest();
}
async function dispose(value) { control.send({ case: "deviceTailcatClose", channelId: value.channelId }); await helper.request("drop", { connection: value.connection }); }
test("unknown channel and forged proof cannot authorize native traffic", async () => {
  const value = await grant();
  try {
    await closed(await dial(value, randomUUID()));
    const stream = await dial(value); const nonce = (await frame(stream)).payload;
    assert.equal(nonce.length, 32); helper.send(stream, Buffer.alloc(32, 0xa5)); await closed(stream);
  } finally { await dispose(value); }
});
test("pending grant expires after its actual TTL", { timeout: 45000 }, async () => {
  const value = await grant();
  try {
    await sleep(Math.max(0, Number(value.expiresAt) - Date.now()) + 150);
    // Revocation can remove the peer before dialing; either bounded dial denial
    // or an immediately closed stream must prevent application authorization.
    let stream;
    try { stream = await dial(value); } catch (error) { assert.match(error.message, /open rejected/); return; }
    await closed(stream);
  } finally { await dispose(value); }
});
test("grant is single use while live and after close; original channel remains usable", async () => {
  const value = await grant();
  try {
    const stream = await dial(value); const nonce = (await frame(stream)).payload;
    helper.send(stream, proof(value, nonce)); assert.equal((await frame(stream)).payload.toString(), "ok");
    await closed(await dial(value));
    const requestId = randomUUID();
    helper.send(stream, encodeDeviceEnvelope(create(DeviceEnvelopeSchema, { protocolVersion: DEVICE_PROTOCOL_VERSION,
      channelId: value.channelId, payload: { case: "sessionCatalogRequest", value: { requestId } } })));
    const response = decodeDeviceEnvelope((await frame(stream)).payload);
    assert.equal(response.payload.case, "sessionCatalog"); assert.equal(response.payload.value.requestId, requestId);
    await helper.request("close", { stream });
    await closed(await dial(value));
  } finally { await dispose(value); }
});
