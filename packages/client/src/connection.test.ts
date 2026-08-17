/// <reference types="node" />

import assert from "node:assert/strict";
import test from "node:test";

import { decodeClientToServer } from "@coflux/protocol";

import { createConnection, type ConnectionSocket, type ConnectionStatus } from "./connection";

// 连接生命周期全是定时器驱动的（退避重连），且分支多在"链路出状况"那一侧——真实 WS 与
// 真实时钟都复现不了。这里注入假时钟 + 假 socket，把时序断言钉死在毫秒上。

type Timer = ReturnType<typeof setTimeout>;

class FakeClock {
  current = 0;
  /** 退避带抖动：固定成 0.5 让延迟可预期（backoff/2 + 0.5*backoff/2 = 0.75*backoff）。 */
  randomValue = 0.5;
  private sequence = 0;
  private timers = new Map<number, { at: number; callback: () => void }>();

  random = (): number => this.randomValue;

  setTimeout = (callback: () => void, delayMs: number): Timer => {
    const id = ++this.sequence;
    this.timers.set(id, { at: this.current + Math.max(0, delayMs), callback });
    return id as unknown as Timer;
  };

  clearTimeout = (timer: Timer): void => {
    this.timers.delete(timer as unknown as number);
  };

  advance(ms: number): void {
    const target = this.current + ms;
    for (let guard = 0; guard < 10_000; guard += 1) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (!next) break;
      const [id, timer] = next;
      this.current = timer.at;
      this.timers.delete(id);
      timer.callback();
    }
    this.current = target;
  }

  get pending(): number {
    return this.timers.size;
  }
}

/** close() 只标记、不同步触发 onclose——真实 WebSocket 的 onclose 也是稍后才来。
 * 同步触发会制造现实中不存在的时序（connect() 里 `socket?.close()` 发生在 `socket = ws`
 * 之前，同步 onclose 会绕过 `socket !== ws` 守卫，凭空多出一次 disconnected + 重连排期）。 */
class FakeSocket implements ConnectionSocket {
  binaryType = "";
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  readonly sent: Uint8Array[] = [];
  closeCalls = 0;

  send(data: Uint8Array): void {
    this.sent.push(data);
  }

  close(): void {
    this.closeCalls += 1;
    this.readyState = 3;
  }

  /* ---- 测试驱动 ---- */
  emitOpen(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  emitClose(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  emitBinary(bytes: Uint8Array): void {
    this.onmessage?.({ data: new Uint8Array(bytes).buffer });
  }

  emitRaw(data: unknown): void {
    this.onmessage?.({ data });
  }
}

function harness(options: { credential?: () => { token: string } | null } = {}) {
  const clock = new FakeClock();
  const sockets: FakeSocket[] = [];
  const statuses: ConnectionStatus[] = [];
  const messages: string[] = [];
  const connection = createConnection({
    url: "wss://example.test/client",
    buildId: "testbuild",
    onStatus: (status) => statuses.push(status),
    onMessage: (payload) => messages.push(payload.case ?? "(none)"),
    reconnectCredential: options.credential ?? (() => ({ token: "tok" })),
    clock,
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });
  return { clock, sockets, statuses, messages, connection };
}

const authOf = (socket: FakeSocket) => decodeClientToServer(socket.sent[0]!)?.payload;

test("connect 后 onopen 即发认证包，并进入 connected", () => {
  const h = harness();
  h.connection.connect({ token: "tok-1" });
  assert.equal(h.sockets.length, 1);
  assert.equal(h.sockets[0]!.binaryType, "arraybuffer");
  assert.deepEqual(h.statuses, ["connecting"]);

  h.sockets[0]!.emitOpen();
  assert.deepEqual(h.statuses, ["connecting", "connected"]);
  const auth = authOf(h.sockets[0]!);
  assert.equal(auth?.case, "clientAuth");
  assert.equal((auth?.value as { clientToken?: string }).clientToken, "tok-1");
  assert.equal((auth?.value as { clientVersion?: string }).clientVersion, "testbuild");
});

test("用户名密码凭据走同一条认证路径", () => {
  const h = harness();
  h.connection.connect({ username: "u", password: "p" });
  h.sockets[0]!.emitOpen();
  const auth = authOf(h.sockets[0]!);
  assert.equal(auth?.case, "clientAuth");
  assert.equal((auth?.value as { username?: string }).username, "u");
  assert.equal((auth?.value as { password?: string }).password, "p");
});

test("onclose 触发退避重连，且退避随失败次数递增", () => {
  const h = harness();
  h.connection.connect({ token: "tok" });
  h.sockets[0]!.emitOpen();
  h.sockets[0]!.emitClose();
  assert.deepEqual(h.statuses, ["connecting", "connected", "disconnected"]);

  // 第一次退避 = 1000/2 + 0.5*1000/2 = 750ms
  h.clock.advance(749);
  assert.equal(h.sockets.length, 1, "退避未到不得重连");
  h.clock.advance(1);
  assert.equal(h.sockets.length, 2, "退避到点应重连");

  // 第二次退避 = 2000*0.75 = 1500ms
  h.sockets[1]!.emitOpen();
  h.sockets[1]!.emitClose();
  h.clock.advance(1499);
  assert.equal(h.sockets.length, 2, "第二次退避应更久");
  h.clock.advance(1);
  assert.equal(h.sockets.length, 3);
});

test("resetBackoff 后退避回到起点", () => {
  const h = harness();
  h.connection.connect({ token: "tok" });
  h.sockets[0]!.emitOpen();
  h.sockets[0]!.emitClose();
  h.clock.advance(750);
  h.sockets[1]!.emitOpen();
  h.connection.resetBackoff();
  h.sockets[1]!.emitClose();

  h.clock.advance(749);
  assert.equal(h.sockets.length, 2);
  h.clock.advance(1);
  assert.equal(h.sockets.length, 3, "重置后应回到 ~750ms 的首档退避");
});

test("stop() 之后不再重连，且关闭当前 socket", () => {
  const h = harness();
  h.connection.connect({ token: "tok" });
  h.sockets[0]!.emitOpen();
  h.connection.stop();
  assert.equal(h.sockets[0]!.closeCalls, 1);

  h.sockets[0]!.emitClose();
  h.clock.advance(60_000);
  assert.equal(h.sockets.length, 1, "stop 后任何时长都不该再建连接");
});

test("reconnectCredential 返回 null 时不重连（已登出/认证失败）", () => {
  const h = harness({ credential: () => null });
  h.connection.connect({ token: "tok" });
  h.sockets[0]!.emitOpen();
  h.sockets[0]!.emitClose();
  h.clock.advance(60_000);
  assert.equal(h.sockets.length, 1);
  assert.equal(h.clock.pending, 0, "不该留下悬挂的重连定时器");
});

test("只处理二进制帧，文本帧与畸形字节一律忽略", () => {
  const h = harness();
  h.connection.connect({ token: "tok" });
  h.sockets[0]!.emitOpen();

  h.sockets[0]!.emitRaw("text frame");
  assert.deepEqual(h.messages, [], "文本帧不进 onMessage");

  h.sockets[0]!.emitBinary(new Uint8Array([0xff, 0xff, 0xff]));
  assert.deepEqual(h.messages, [], "解不出的字节被丢弃且不抛");
});

test("被替换的旧 socket 事件不再影响新连接", () => {
  const h = harness();
  h.connection.connect({ token: "tok" });
  const first = h.sockets[0]!;
  first.emitOpen();

  h.connection.connect({ token: "tok" }); // 显式重连：旧 socket 被 close 并换新
  assert.equal(h.sockets.length, 2);
  assert.equal(first.closeCalls, 1, "换新连接前必须关旧的，否则服务端留幽灵连接");

  const before = h.statuses.length;
  first.emitClose(); // 旧 socket 迟到的 onclose
  assert.equal(h.statuses.length, before, "旧 socket 的 onclose 不该改变状态");
  h.clock.advance(60_000);
  assert.equal(h.sockets.length, 2, "旧 socket 的 onclose 不该触发重连");
});
