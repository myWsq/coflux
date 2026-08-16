/**
 * 独立 Device 协议黑盒客户端。
 *
 * 这里只依赖 protobuf 真相源、WebCrypto 与真实 WebSocket，不 import packages/client、worker
 * 或 server 实现。它故意重新实现 P-256 transcript、loopback 握手和 opaque relay，避免集成测试
 * 与被测路由共享状态机或认证 helper。
 */
import { randomUUID, webcrypto } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { WebSocket } from "ws";
import {
  create,
  DeviceEnvelopeSchema,
  DEVICE_PROTOCOL_VERSION,
  decodeDeviceEnvelope,
  encodeDeviceEnvelope,
} from "@coflux/protocol";

const cryptoApi = globalThis.crypto ?? webcrypto;
const encoder = new TextEncoder();
const GATEWAY_DOMAIN = "coflux-local-gateway-v1";
const CLIENT_DOMAIN = "coflux-local-client-v1";

function toUint8(value) {
  if (value instanceof Uint8Array) return value;
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function bytesEqual(left, right) {
  if (left.byteLength !== right.byteLength) return false;
  let different = 0;
  for (let index = 0; index < left.byteLength; index += 1) different |= left[index] ^ right[index];
  return different === 0;
}

function u32(value) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return bytes;
}

function u64(value) {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, value, false);
  return bytes;
}

function transcript(domain, fields) {
  const domainBytes = encoder.encode(domain);
  const size = domainBytes.byteLength + 1 + fields.reduce((total, field) => total + 4 + field.byteLength, 0);
  const output = new Uint8Array(size);
  const view = new DataView(output.buffer);
  let offset = 0;
  output.set(domainBytes, offset);
  offset += domainBytes.byteLength;
  output[offset++] = 0;
  for (const field of fields) {
    view.setUint32(offset, field.byteLength, false);
    offset += 4;
    output.set(field, offset);
    offset += field.byteLength;
  }
  return output;
}

function gatewayTranscript(hello) {
  return transcript(GATEWAY_DOMAIN, [
    u32(hello.protocolVersion),
    encoder.encode(hello.daemonId),
    encoder.encode(hello.origin),
    hello.nonce,
  ]);
}

function clientTranscript(hello, grantId, browserPublicKey, clientInstanceId, generation, leaseId) {
  return transcript(CLIENT_DOMAIN, [
    u32(hello.protocolVersion),
    encoder.encode(hello.daemonId),
    encoder.encode(hello.origin),
    hello.nonce,
    hello.gatewayPublicKeySec1,
    encoder.encode(grantId),
    browserPublicKey,
    encoder.encode(clientInstanceId),
    u64(generation),
    encoder.encode(leaseId ?? ""),
  ]);
}

function flattenEnvelope(envelope, transport) {
  if (!envelope?.payload?.case) return null;
  const { $typeName, ...value } = envelope.payload.value;
  return {
    case: envelope.payload.case,
    ...value,
    channelId: envelope.channelId,
    protocolVersion: envelope.protocolVersion,
    transport,
  };
}

class EnvelopeInbox {
  constructor(socket) {
    this.socket = socket;
    this.log = [];
    this.waiters = [];
    this.listeners = new Set();
    this.ready = new Promise((resolve, reject) => {
      const opened = () => {
        socket.off("error", failed);
        resolve();
      };
      const failed = (error) => {
        socket.off("open", opened);
        reject(error);
      };
      socket.once("open", opened);
      socket.once("error", failed);
    });
    this.closed = new Promise((resolve) => socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() })));
    socket.on("message", (data, isBinary) => {
      if (!isBinary) return;
      const envelope = decodeDeviceEnvelope(toUint8(data));
      if (!envelope) return;
      this.log.push(envelope);
      this.waiters = this.waiters.filter((waiter) => !waiter.try(envelope));
      for (const listener of this.listeners) listener(envelope);
    });
  }

  waitFor(predicate, label = "DeviceEnvelope", timeout = 10000) {
    const hit = this.log.find(predicate);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), timeout);
      this.waiters.push({
        try: (envelope) => predicate(envelope) ? (clearTimeout(timer), resolve(envelope), true) : false,
      });
    });
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/**
 * 建立并持有一个 browser logical client。默认 origin 与测试 server 同源；grant/key 只在内存中。
 */
export class DeviceClient {
  static async pair(stack, options = {}) {
    const client = new DeviceClient(stack, options);
    await client.initialize();
    return client;
  }

  constructor(stack, options) {
    this.stack = stack;
    this.port = stack.port;
    this.daemonId = options.daemonId ?? stack.daemonId;
    this.origin = options.origin ?? `http://127.0.0.1:${stack.port}`;
    this.clientInstanceId = options.clientInstanceId ?? randomUUID();
    this.username = options.username ?? stack.username;
    this.password = options.password ?? stack.password;
    this.control = options.control ?? stack.makeClient({ origin: this.origin });
    this.identity = options.identity;
    this.grantId = options.grantId;
    this.gateway = options.gateway;
    this.generation = options.generation ?? 0n;
    // plan 043：relay 数据面走独立 WS，中心控制 WS 上不再可见。direct 热路径的
    // "零 relay 帧"断言改为观测这两个跨 transport 累计计数。
    this.relayFramesSent = 0;
    this.relayEnvelopesReceived = 0;
    this.transport = null;
    this.log = [];
    this.waiters = [];
    this.handledPrepared = new Set();
    this.sessionControls = new Map();
    this.preparedAutoUnsubscribe = null;
  }

  async initialize() {
    if (!this.identity) {
      const pair = await cryptoApi.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
      const publicKeySec1 = new Uint8Array(await cryptoApi.subtle.exportKey("raw", pair.publicKey));
      if (publicKeySec1.byteLength !== 65 || publicKeySec1[0] !== 4) throw new Error("P-256 public key 不是 uncompressed SEC1");
      this.identity = { privateKey: pair.privateKey, publicKeySec1 };
    }
    await this.control.authSubscribe(this.username, this.password);
    await this.refreshPair();
  }

  /** 使用同一 key/grant 另起 logical client，供 holder takeover 黑盒测试。 */
  async fork(options = {}) {
    return DeviceClient.pair(this.stack, {
      identity: this.identity,
      clientInstanceId: options.clientInstanceId ?? randomUUID(),
      origin: this.origin,
      username: this.username,
      password: this.password,
      generation: options.generation ?? 0n,
    });
  }

  async refreshPair(timeout = 15000) {
    const deadline = Date.now() + timeout;
    let lastError = "daemon 尚未上报 gateway";
    while (Date.now() < deadline) {
      const requestId = randomUUID();
      this.control.send({
        case: "localPairRequest",
        requestId,
        daemonId: this.daemonId,
        origin: this.origin,
        browserPublicKeySec1: this.identity.publicKeySec1,
      });
      const result = await this.control.waitFor(
        (message) => message.case === "localPairResult" && message.requestId === requestId,
        "localPairResult",
        Math.min(10000, Math.max(1, deadline - Date.now())),
      );
      if (result.ok && result.grantId && result.gateway) {
        this.grantId = result.grantId;
        this.gateway = result.gateway;
        return result;
      }
      lastError = result.error ?? "local pair failed";
      if (!lastError.includes("gateway") && !lastError.includes("尚未上报")) throw new Error(lastError);
      await sleep(100);
    }
    throw new Error(lastError);
  }

  async requestLease() {
    const requestId = randomUUID();
    this.control.send({ case: "localLeaseRequest", requestId, daemonId: this.daemonId, grantId: this.grantId });
    const result = await this.control.waitFor(
      (message) => message.case === "localLeaseResult" && message.requestId === requestId,
      "localLeaseResult",
    );
    if (!result.ok || !result.lease) throw new Error(result.error ?? "local lease failed");
    return result.lease;
  }

  nextGeneration() {
    this.generation += 1n;
    return this.generation;
  }

  async openDirect(options = {}) {
    if (!this.gateway || !this.grantId) throw new Error("DeviceClient 尚未 pair");
    const generation = options.generation ?? this.nextGeneration();
    if (generation > this.generation) this.generation = generation;
    const socket = new WebSocket(`ws://127.0.0.1:${this.gateway.port}/device`, { origin: this.origin });
    const inbox = new EnvelopeInbox(socket);
    await inbox.ready;
    const gatewayEnvelope = await inbox.waitFor(
      (envelope) => envelope.payload.case === "localGatewayHello",
      "LocalGatewayHello",
    );
    const hello = gatewayEnvelope.payload.value;
    if (
      gatewayEnvelope.protocolVersion !== DEVICE_PROTOCOL_VERSION ||
      gatewayEnvelope.channelId !== "" ||
      hello.protocolVersion !== DEVICE_PROTOCOL_VERSION ||
      hello.daemonId !== this.daemonId ||
      hello.origin !== this.origin ||
      hello.nonce.byteLength !== 32 ||
      hello.signatureP1363.byteLength !== 64 ||
      !bytesEqual(hello.gatewayPublicKeySec1, this.gateway.publicKeySec1)
    ) {
      socket.terminate();
      throw new Error("loopback gateway hello 与已配对 descriptor 不匹配");
    }
    const gatewayKey = await cryptoApi.subtle.importKey(
      "raw",
      hello.gatewayPublicKeySec1,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const gatewayVerified = await cryptoApi.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      gatewayKey,
      hello.signatureP1363,
      gatewayTranscript(hello),
    );
    if (!gatewayVerified) {
      socket.terminate();
      throw new Error("loopback gateway P-256 signature 无效");
    }

    const leaseId = options.lease?.leaseId;
    const signature = new Uint8Array(await cryptoApi.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      this.identity.privateKey,
      clientTranscript(hello, this.grantId, this.identity.publicKeySec1, this.clientInstanceId, generation, leaseId),
    ));
    if (signature.byteLength !== 64) throw new Error("browser ECDSA signature 不是 IEEE-P1363");
    socket.send(encodeDeviceEnvelope(create(DeviceEnvelopeSchema, {
      protocolVersion: DEVICE_PROTOCOL_VERSION,
      channelId: "",
      payload: {
        case: "localClientHello",
        value: {
          protocolVersion: DEVICE_PROTOCOL_VERSION,
          grantId: this.grantId,
          browserPublicKeySec1: this.identity.publicKeySec1,
          clientInstanceId: this.clientInstanceId,
          transportGeneration: generation,
          leaseId,
          gatewayNonce: hello.nonce,
          signatureP1363: signature,
        },
      },
    })));
    const authEnvelope = await inbox.waitFor((envelope) => envelope.payload.case === "localAuthResult", "LocalAuthResult");
    const auth = authEnvelope.payload.value;
    if (!auth.ok || !auth.channelId) {
      socket.terminate();
      throw new Error(`${auth.errorCode}: ${auth.error ?? "loopback auth failed"}`);
    }

    const transport = {
      kind: "direct",
      channelId: auth.channelId,
      generation,
      scopes: auth.scopes,
      socket,
      inbox,
      unsubscribe: inbox.subscribe((envelope) => this.receive(envelope, "direct", auth.channelId)),
      send: (frame) => {
        if (socket.readyState !== WebSocket.OPEN) return false;
        socket.send(frame);
        return true;
      },
      close: (terminate = false) => terminate ? socket.terminate() : socket.close(),
    };
    this.replaceTransport(transport);
    return transport;
  }

  /** plan 043：relay = 中心 rendezvous（拿签好 token 的 relay URL）+ 拨 channel 专属 WS，
   * 帧是原始 DeviceEnvelope bytes，不再经中心控制 WS。 */
  async openRelay(options = {}) {
    const generation = options.generation ?? this.nextGeneration();
    if (generation > this.generation) this.generation = generation;
    const channelId = options.channelId ?? `relay-${randomUUID()}`;
    this.control.send({
      case: "deviceRelayConnect",
      daemonId: this.daemonId,
      channelId,
      clientInstanceId: this.clientInstanceId,
      transportGeneration: generation,
      protocolVersion: DEVICE_PROTOCOL_VERSION,
    });
    const grant = await this.control.waitFor(
      (message) => message.case === "deviceRelayGrant" && message.channelId === channelId,
      "deviceRelayGrant",
    );
    if (!grant.ok || !grant.relayUrl) throw new Error(grant.error ?? "relay rendezvous failed");
    const relayUrl = options.mutateRelayUrl ? options.mutateRelayUrl(grant.relayUrl) : grant.relayUrl;
    const socket = new WebSocket(relayUrl);
    const inbox = new EnvelopeInbox(socket);
    await inbox.ready;
    const transport = {
      kind: "relay",
      channelId,
      generation,
      scopes: [],
      closed: false,
      socket,
      inbox,
      unsubscribe: inbox.subscribe((envelope) => {
        this.relayEnvelopesReceived += 1;
        this.receive(envelope, "relay", channelId);
      }),
      send: (frame) => {
        if (transport.closed || socket.readyState !== WebSocket.OPEN) return false;
        this.relayFramesSent += 1;
        socket.send(frame);
        return true;
      },
      close: (terminate = false) => {
        transport.closed = true;
        terminate ? socket.terminate() : socket.close();
      },
    };
    this.replaceTransport(transport);
    return transport;
  }

  /** plan 076：P2P = 中心信令（offer/answer + 逐 channel 授权）+ werift RTCPeerConnection
   * + DataChannel 分片流。werift 与 worker 的 webrtc-rs 是两个独立 WebRTC 实现，跨栈互通
   * 本身就是被测面；分帧格式（4B BE 前缀 + ≤16KiB chunk）有意内联，不与被测两端共享代码。 */
  async openP2p(options = {}) {
    const { RTCPeerConnection } = await import("werift");
    const generation = options.generation ?? this.nextGeneration();
    if (generation > this.generation) this.generation = generation;
    const connectionId = options.connectionId ?? `p2p-${randomUUID()}`;
    const channelId = options.channelId ?? `p2p-${randomUUID()}`;
    const pc = new RTCPeerConnection({});
    const dc = pc.createDataChannel(channelId);
    await pc.setLocalDescription(await pc.createOffer());
    // vanilla ICE：等 gathering 完成再送 offer；超时兜底——同机 host candidate 早已在 SDP 里。
    await new Promise((resolve) => {
      if (pc.iceGatheringState === "complete") return resolve(undefined);
      const timer = setTimeout(resolve, 3000);
      pc.iceGatheringStateChange.subscribe((state) => {
        if (state === "complete") {
          clearTimeout(timer);
          resolve(undefined);
        }
      });
    });
    // 任何建立阶段失败都必须关 pc：泄漏的 werift socket 会让测试进程永不退出。
    try {
      this.control.send({
        case: "deviceP2pOffer",
        daemonId: options.daemonId ?? this.daemonId,
        connectionId,
        clientInstanceId: this.clientInstanceId,
        sdp: pc.localDescription.sdp,
        protocolVersion: DEVICE_PROTOCOL_VERSION,
      });
      const answer = await this.control.waitFor(
        (message) => message.case === "deviceP2pAnswer" && message.connectionId === connectionId,
        "deviceP2pAnswer",
        20000,
      );
      if (!answer.ok || !answer.sdp) {
        const error = new Error(answer.error ?? "p2p offer rejected");
        error.rejected = true;
        throw error;
      }
      await pc.setRemoteDescription({ type: "answer", sdp: answer.sdp });
      this.control.send({
        case: "deviceP2pChannelOpen",
        daemonId: options.daemonId ?? this.daemonId,
        connectionId,
        channelId,
        clientInstanceId: this.clientInstanceId,
        transportGeneration: generation,
        protocolVersion: DEVICE_PROTOCOL_VERSION,
      });
      const granted = await this.control.waitFor(
        (message) => message.case === "deviceP2pChannelResult" && message.channelId === channelId,
        "deviceP2pChannelResult",
      );
      if (!granted.ok) throw new Error(granted.error ?? "p2p channel denied");
      await new Promise((resolve, reject) => {
        if (dc.readyState === "open") return resolve(undefined);
        const timer = setTimeout(() => reject(new Error("p2p DataChannel open timeout")), 15000);
        dc.stateChanged.subscribe((state) => {
          if (state === "open") {
            clearTimeout(timer);
            resolve(undefined);
          } else if (state === "closed") {
            clearTimeout(timer);
            reject(new Error("p2p DataChannel closed during open"));
          }
        });
      });
    } catch (error) {
      await pc.close();
      throw error;
    }
    const assembler = new P2pAssembler();
    const transport = {
      kind: "p2p",
      channelId,
      generation,
      scopes: [],
      closed: false,
      pc,
      dc,
      send: (frame) => {
        if (transport.closed || dc.readyState !== "open") return false;
        for (const chunk of p2pEncodeChunks(frame)) dc.send(Buffer.from(chunk));
        return true;
      },
      close: () => {
        if (transport.closed) return;
        transport.closed = true;
        try { dc.close(); } catch { /* ignore */ }
        void pc.close();
      },
    };
    dc.onMessage.subscribe((data) => {
      const bytes = typeof data === "string" ? new TextEncoder().encode(data) : toUint8(data);
      for (const frameBytes of assembler.push(bytes)) {
        const envelope = decodeDeviceEnvelope(frameBytes);
        if (envelope) this.receive(envelope, "p2p", channelId);
      }
    });
    this.replaceTransport(transport);
    return transport;
  }

  replaceTransport(next) {
    const previous = this.transport;
    this.transport = next;
    if (previous && previous !== next) {
      previous.unsubscribe?.();
      previous.close();
    }
  }

  receive(envelope, kind, expectedChannelId) {
    if (envelope.protocolVersion !== DEVICE_PROTOCOL_VERSION || envelope.channelId !== expectedChannelId) return;
    const message = flattenEnvelope(envelope, kind);
    if (!message) return;
    this.log.push(message);
    this.waiters = this.waiters.filter((waiter) => !waiter.try(message));
  }

  mark() {
    return this.log.length;
  }

  waitFor(predicate, label = "Device response", timeout = 10000, from = 0) {
    const hit = this.log.slice(from).find(predicate);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), timeout);
      this.waiters.push({
        try: (message) => predicate(message) ? (clearTimeout(timer), resolve(message), true) : false,
      });
    });
  }

  send(caseName, value) {
    if (!this.transport) throw new Error("Device transport 尚未打开");
    const frame = encodeDeviceEnvelope(create(DeviceEnvelopeSchema, {
      protocolVersion: DEVICE_PROTOCOL_VERSION,
      channelId: this.transport.channelId,
      payload: { case: caseName, value },
    }));
    if (!this.transport.send(frame)) throw new Error("Device transport send failed");
    return frame;
  }

  sendFrame(frame) {
    if (!this.transport?.send(frame)) throw new Error("Device transport send failed");
  }

  async request(requestCase, responseCase, value = {}, options = {}) {
    const requestId = value.requestId ?? randomUUID();
    const from = this.mark();
    this.send(requestCase, { ...value, requestId });
    const result = await this.waitFor(
      (message) =>
        (message.case === responseCase && message.requestId === requestId) ||
        (message.case === "error" && message.requestId === requestId),
      `${requestCase} response`,
      options.timeout ?? 10000,
      from,
    );
    if (result.case === "error" && !options.allowError) throw new Error(`${result.code}: ${result.message}`);
    return result;
  }

  async waitWorkspaceReady(workspaceId, timeout = 5000) {
    const deadline = Date.now() + timeout;
    let lastError;
    while (Date.now() < deadline) {
      try {
        return await this.request("execRun", "execResult", {
          workspaceId,
          command: "/bin/sh",
          args: ["-c", "printf ready"],
          env: {},
        });
      } catch (error) {
        lastError = error;
        if (!String(error).includes("workspace_unknown")) throw error;
        await sleep(50);
      }
    }
    throw lastError ?? new Error(`workspace ${workspaceId} 未同步到 worker`);
  }

  async waitPrepared(payloadCase, timeout = 10000) {
    const operation = await this.control.waitFor((message) => {
      if (message.case !== "preparedDeviceOperation" || this.handledPrepared.has(message.operationId)) return false;
      const envelope = decodeDeviceEnvelope(message.frame);
      return envelope?.channelId === "" && envelope.payload.case === payloadCase;
    }, `prepared ${payloadCase}`, timeout);
    this.handledPrepared.add(operation.operationId);
    return operation;
  }

  executePrepared(operation) {
    if (!this.transport) throw new Error("Device transport 尚未打开");
    const template = decodeDeviceEnvelope(operation.frame);
    if (
      !template ||
      template.protocolVersion !== DEVICE_PROTOCOL_VERSION ||
      template.channelId !== "" ||
      !template.payload.case
    ) throw new Error("prepared DeviceEnvelope 畸形");
    const bound = encodeDeviceEnvelope(create(DeviceEnvelopeSchema, {
      protocolVersion: template.protocolVersion,
      channelId: this.transport.channelId,
      payload: template.payload,
    }));
    this.sendFrame(bound);
    return template.payload;
  }

  /** 旧 control-plane 黑盒用例的迁移适配：中心只 prepare，实际 effect 自动经当前 Device transport 执行。 */
  enablePreparedAutoExecution() {
    if (this.preparedAutoUnsubscribe) return;
    this.preparedAutoUnsubscribe = this.control.subscribe((message) => {
      if (message.case !== "preparedDeviceOperation" || this.handledPrepared.has(message.operationId)) return;
      this.handledPrepared.add(message.operationId);
      try {
        this.executePrepared(message);
      } catch (error) {
        this.handledPrepared.delete(message.operationId);
        queueMicrotask(() => { throw error; });
      }
    });
  }

  async catalog() {
    const requestId = randomUUID();
    const from = this.mark();
    this.send("sessionCatalogRequest", { requestId });
    return this.waitFor((message) => message.case === "sessionCatalog" && message.requestId === requestId, "sessionCatalog", 10000, from);
  }

  async attach(sessionId, options = {}) {
    const requestId = options.requestId ?? randomUUID();
    const from = this.mark();
    this.send("sessionAttach", {
      requestId,
      sessionId,
      clientInstanceId: this.clientInstanceId,
      transportGeneration: this.transport.generation,
      cols: options.cols ?? 80,
      rows: options.rows ?? 24,
      resumeFromSeq: options.resumeFromSeq,
    });
    const attached = await this.waitFor(
      (message) => message.case === "sessionAttached" && message.requestId === requestId,
      "sessionAttached",
      options.timeout ?? 10000,
      from,
    );
    this.sessionControls.set(sessionId, {
      holderEpoch: attached.holderEpoch,
      inputSeq: options.inputSeq ?? this.sessionControls.get(sessionId)?.inputSeq ?? 0n,
      resizeSeq: options.resizeSeq ?? this.sessionControls.get(sessionId)?.resizeSeq ?? 0n,
    });
    return attached;
  }

  async input(sessionId, data, options = {}) {
    const control = this.sessionControls.get(sessionId);
    if (!control) throw new Error(`session ${sessionId} 尚未 attach`);
    const inputSeq = options.inputSeq ?? control.inputSeq + 1n;
    const requestId = options.requestId ?? randomUUID();
    const from = this.mark();
    this.send("ptyInput", {
      requestId,
      sessionId,
      holderEpoch: options.holderEpoch ?? control.holderEpoch,
      inputSeq,
      data: typeof data === "string" ? encoder.encode(data) : data,
    });
    const ack = await this.waitFor(
      (message) => message.case === "ptyInputAck" && message.sessionId === sessionId && message.appliedThroughSeq >= inputSeq,
      "ptyInputAck",
      options.timeout ?? 10000,
      from,
    );
    if (inputSeq > control.inputSeq) control.inputSeq = inputSeq;
    return ack;
  }

  async resize(sessionId, cols, rows, options = {}) {
    const control = this.sessionControls.get(sessionId);
    if (!control) throw new Error(`session ${sessionId} 尚未 attach`);
    const resizeSeq = options.resizeSeq ?? control.resizeSeq + 1n;
    this.send("ptyResize", {
      requestId: options.requestId ?? randomUUID(),
      sessionId,
      holderEpoch: options.holderEpoch ?? control.holderEpoch,
      resizeSeq,
      cols,
      rows,
    });
    if (resizeSeq > control.resizeSeq) control.resizeSeq = resizeSeq;
  }

  async stopSession(sessionId, options = {}) {
    const control = this.sessionControls.get(sessionId);
    if (!control) throw new Error(`session ${sessionId} 尚未 attach`);
    const requestId = options.requestId ?? randomUUID();
    const operationId = options.operationId ?? randomUUID();
    const from = this.mark();
    this.send("sessionStop", {
      requestId,
      operationId,
      sessionId,
      holderEpoch: options.holderEpoch ?? control.holderEpoch,
    });
    return this.waitFor(
      (message) => message.case === "operationAck" && message.requestId === requestId && message.operationId === operationId,
      "session stop ack",
      options.timeout ?? 10000,
      from,
    );
  }

  closeTransport(terminate = false) {
    const transport = this.transport;
    this.transport = null;
    transport?.unsubscribe?.();
    transport?.close(terminate);
  }

  close() {
    this.preparedAutoUnsubscribe?.();
    this.preparedAutoUnsubscribe = null;
    this.closeTransport();
    this.control.close();
    for (const waiter of this.waiters) waiter.reject?.(new Error("DeviceClient closed"));
    this.waiters = [];
  }
}

/** 建立 relay Device，并自动执行中心下发的 prepared lifecycle operation。 */
export async function openRelayDevice(stack, options = {}) {
  const device = await DeviceClient.pair(stack, options);
  await device.openRelay();
  device.enablePreparedAutoExecution();
  return device;
}

/** 建立 P2P Device（plan 076）。pair 只用来等 daemon 就绪，P2P 本身不依赖 loopback grant。 */
export async function openP2pDevice(stack, options = {}) {
  const device = await DeviceClient.pair(stack, options);
  await device.openP2p();
  device.enablePreparedAutoExecution();
  return device;
}

// ===== P2P 分片流（plan 076，有意内联：4B BE 帧长前缀 + ≤16KiB chunk）=====

const P2P_CHUNK_BYTES = 16 * 1024;

function p2pEncodeChunks(frame) {
  const stream = new Uint8Array(4 + frame.byteLength);
  new DataView(stream.buffer).setUint32(0, frame.byteLength);
  stream.set(frame, 4);
  const chunks = [];
  for (let offset = 0; offset < stream.byteLength; offset += P2P_CHUNK_BYTES) {
    chunks.push(stream.subarray(offset, Math.min(offset + P2P_CHUNK_BYTES, stream.byteLength)));
  }
  return chunks;
}

class P2pAssembler {
  constructor() {
    this.buf = new Uint8Array(0);
  }

  push(bytes) {
    const merged = new Uint8Array(this.buf.byteLength + bytes.byteLength);
    merged.set(this.buf, 0);
    merged.set(bytes, this.buf.byteLength);
    this.buf = merged;
    const frames = [];
    for (;;) {
      if (this.buf.byteLength < 4) return frames;
      const declared = new DataView(this.buf.buffer, this.buf.byteOffset, 4).getUint32(0);
      if (declared === 0) throw new Error("p2p 帧长前缀违规");
      if (this.buf.byteLength < 4 + declared) return frames;
      frames.push(this.buf.slice(4, 4 + declared));
      this.buf = this.buf.slice(4 + declared);
    }
  }
}

export function utf8(bytes) {
  return new TextDecoder().decode(bytes);
}
