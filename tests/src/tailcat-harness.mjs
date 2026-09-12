// Independent binary IPC client: no production helper/controller imports.
import { spawn } from "node:child_process";
export class TailcatTestHelper {
  constructor(binary) {
    this.child = spawn(binary, [], { stdio: ["pipe", "pipe", "ignore"] });
    this.listeners = new Map(); this.next = 1; this.pending = new Map(); this.frames = []; this.waiters = []; this.buffer = Buffer.alloc(0);
    this.child.stdin.on("error", () => {});
    this.child.stdout.on("data", bytes => {
      this.buffer = Buffer.concat([this.buffer, bytes]);
      while (this.buffer.length >= 9) {
        const size = this.buffer.readUInt32BE();
        if (size <= 5 || size > 30 * 1024 * 1024 + 5) { this.child.kill(); return; }
        if (this.buffer.length < size + 4) return;
        const kind = this.buffer[4], stream = this.buffer.readUInt32BE(5), payload = Buffer.from(this.buffer.subarray(9, size + 4));
        this.buffer = this.buffer.subarray(size + 4);
        const event = kind === 1 ? JSON.parse(payload) : undefined;
        const pending = event?.id && this.pending.get(event.id);
        if (pending) { this.pending.delete(event.id); pending(event); continue; }
        const frame = { kind, stream: event?.stream ?? stream, payload, event };
        if (kind === 2 && this.listeners.has(stream)) { this.listeners.get(stream)(payload); continue; }
        const index = this.waiters.findIndex(w => w.match(frame));
        if (index >= 0) this.waiters.splice(index, 1)[0].resolve(frame); else this.frames.push(frame);
      }
    });
  }
  subscribe(stream, listener) { this.listeners.set(stream, listener); return () => this.listeners.delete(stream); }
  send(stream, bytes) { this.write(2, stream, bytes); }
  write(kind, stream, bytes) { const header = Buffer.alloc(9); header.writeUInt32BE(bytes.length + 5); header[4] = kind; header.writeUInt32BE(stream, 5); this.child.stdin.write(header); this.child.stdin.write(bytes); }
  request(op, fields = {}) {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${op} timed out`)); }, 25_000);
      this.pending.set(id, event => { clearTimeout(timer); event.ok ? resolve(event) : reject(new Error(`${op} rejected`)); });
      this.write(1, 0, Buffer.from(JSON.stringify({ id, op, ...fields })));
    });
  }
  wait(match, timeout = 15_000, signal) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    const index = this.frames.findIndex(match);
    if (index >= 0) return Promise.resolve(this.frames.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); this.waiters = this.waiters.filter(w => w !== waiter); };
      const waiter = { match, resolve: frame => { cleanup(); resolve(frame); } };
      const abort = () => { cleanup(); reject(signal.reason); };
      const timer = setTimeout(() => { cleanup(); reject(new Error("native frame timeout")); }, timeout);
      signal?.addEventListener("abort", abort, { once: true });
      this.waiters.push(waiter);
    });
  }

  async stop() {
    if (this.child.exitCode !== null) return;
    this.child.stdin.end();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.child.kill("SIGKILL"); reject(new Error("helper survived owner EOF")); }, 3000);
      this.child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }
}

// Uses the independent Device protocol driver, never production routing code.
export async function openNativeTestDevice(stack, helper, options = {}) {
  const { randomUUID, createHmac } = await import("node:crypto");
  const { setTimeout: sleep } = await import("node:timers/promises");
  const { DEVICE_PROTOCOL_VERSION, decodeDeviceEnvelope } = await import("@coflux/protocol");
  const { DeviceClient } = await import("./device-harness.mjs");
  const control = options.control;
  const clientInstanceId = options.clientInstanceId || "native-fault-client";
  const scope = options.scope || 2, generation = options.generation || 1n;
  const deadline = Date.now() + (options.timeout || 30_000);
  let last;
  while (Date.now() < deadline) {
    const connection = randomUUID(), channelId = randomUUID();
    const stream = helper.testStream = (helper.testStream || 100) + 1;
    const cancellation = new AbortController();
    let rejectCancelled, resolveGrant, rejectGrant, grantTimer, disposal;
    let unsubscribeControl = () => {}, unsubscribeData = () => {};
    const cancelled = new Promise((_, reject) => { rejectCancelled = reject; });
    const granted = new Promise((resolve, reject) => { resolveGrant = resolve; rejectGrant = reject; });
    void cancelled.catch(() => {}); void granted.catch(() => {});
    const checkLive = () => { if (cancellation.signal.aborted) throw cancellation.signal.reason; };
    const step = operation => { checkLive(); return Promise.race([operation(), cancelled]); };
    const dispose = () => {
      if (!disposal) {
        const reason = new Error(`native channel ${channelId} was closed`);
        cancellation.abort(reason); rejectCancelled(reason); rejectGrant(reason);
        clearTimeout(grantTimer); unsubscribeControl(); unsubscribeData();
        disposal = helper.request("close", { stream }).then(() => helper.request("drop", { connection }));
        void disposal.catch(() => {});
      }
      return disposal;
    };
    // Subscribe before requesting authority: a grant may be revoked while the
    // helper is still dialing or waiting for the worker nonce, not only once live.
    unsubscribeControl = control.subscribe(message => {
      if (message.channelId !== channelId) return;
      if (message.case === "deviceTailcatResult") { clearTimeout(grantTimer); resolveGrant(message); }
      if (message.case === "deviceTailcatClosed" && options.followControlRevocation !== false) void dispose();
    });
    try {
      const { publicKey } = await step(() => helper.request("prepare", { connection }));
      checkLive();
      grantTimer = setTimeout(() => rejectGrant(new Error("native fault grant timed out")), 10_000);
      control.send({ case: "deviceTailcatConnect", daemonId: stack.daemonId, channelId, clientInstanceId, transportGeneration: generation, protocolVersion: DEVICE_PROTOCOL_VERSION, nodePublicKey: publicKey, scope });
      const grant = await step(() => granted);
      if (!grant.ok) throw new Error(grant.error);
      await step(() => helper.request("open", { connection, stream, address: grant.address }));
      checkLive(); helper.send(stream, Buffer.from(JSON.stringify({ channelId })));
      const nonce = (await helper.wait(f => f.kind === 2 && f.stream === stream, 15_000, cancellation.signal)).payload;
      if (nonce.length !== 32) throw new Error("invalid worker nonce");
      const length = Buffer.alloc(4); length.writeUInt32BE(Buffer.byteLength(channelId));
      checkLive(); helper.send(stream, createHmac("sha256", grant.proofKey).update("coflux-tailcat-channel-v1\0").update(length).update(channelId).update(nonce).digest());
      if ((await helper.wait(f => f.kind === 2 && f.stream === stream, 15_000, cancellation.signal)).payload.toString() !== "ok") throw new Error("invalid worker acceptance");
      checkLive();
      const device = new DeviceClient(stack, { control, clientInstanceId });
      unsubscribeData = helper.subscribe(stream, bytes => { const envelope = decodeDeviceEnvelope(bytes); if (envelope) device.receive(envelope, "tailcat", channelId); });
      device.replaceTransport({ channelId, generation, send: bytes => { if (cancellation.signal.aborted) return false; helper.send(stream, bytes); return true; }, unsubscribe: unsubscribeData, close: () => { void dispose(); } });
      return Object.assign(device, { nativeStream: stream, nativeConnection: connection, nativeChannelId: channelId, disposeNative: dispose });
    } catch (error) {
      last = error; control.send({ case: "deviceTailcatClose", channelId });
      await dispose(); await sleep(100);
    }
  }
  throw last || new Error("native connection timed out");
}
