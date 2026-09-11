import assert from "node:assert/strict";
import { test } from "node:test";
import { GhosttyGenerations, GhosttyQueue } from "./ghostty-queue";
import { GhosttySender } from "../shared/ghostty-sender";
import type { GhosttyEvent, GhosttyMessage, GhosttyOperation } from "../shared/ghostty";

const key = { surfaceId: "tab", generation: 2 };
function message(sequence: number, text: string, replace = false): GhosttyMessage {
  return { ...key, sequence, operation: { kind: "output", bytes: new TextEncoder().encode(text), replace, replay: replace } };
}
function harness(quota = 100) {
  const executed: GhosttyOperation[] = [];
  const completions: Array<(error?: string) => void> = [];
  const events: GhosttyEvent[] = [];
  const queue = new GhosttyQueue(key, (op, complete) => { executed.push(op); completions.push(complete); }, (event) => events.push(event), quota);
  return { queue, executed, completions, events };
}

test("旧 generation 的消息不消费，旧 create 不能使 surface 复活", () => {
  const h = harness();
  h.queue.receive({ ...message(1, "old"), generation: 1 });
  h.queue.receive({ ...message(1, "future"), generation: 3 });
  assert.equal(h.executed.length, 0);
  h.queue.receive(message(1, "current"));
  assert.equal(h.executed.length, 1);
  const generations = new GhosttyGenerations();
  assert.equal(generations.advance(key), true);
  assert.equal(generations.advance({ ...key, generation: 1 }), false);
  assert.equal(generations.advance(key), false);
  assert.equal(generations.advance({ ...key, generation: 3 }), true);
});

test("replace/replay 与 delta 在同一队列，解析结束才启动下一块及释放额度", () => {
  const h = harness();
  h.queue.receive(message(1, "old"));
  h.queue.receive(message(2, "snapshot", true));
  h.queue.receive(message(3, "delta"));
  assert.equal(h.queue.queuedBytes, 16);
  assert.equal(h.executed.length, 1);
  assert.equal(h.events.length, 0);
  h.completions[0]!();
  assert.equal(h.queue.queuedBytes, 13);
  assert.deepEqual(h.executed[1], message(2, "snapshot", true).operation);
  h.completions[1]!();
  assert.deepEqual(h.executed[2], message(3, "delta").operation);
  h.completions[2]!();
  assert.equal(h.queue.queuedBytes, 0);
  assert.deepEqual(h.events.map((event) => event.kind === "ack" ? event.sequence : -1), [1, 2, 3]);
});

test("超额立即停消费，每个 generation 只请求一次完整恢复", () => {
  const h = harness(6);
  h.queue.receive(message(1, "1234"));
  h.queue.receive(message(2, "5678"));
  h.queue.receive(message(3, "90"));
  h.queue.recover("再次失败");
  assert.equal(h.executed.length, 1);
  assert.equal(h.queue.recovering, true);
  assert.equal(h.events.filter((event) => event.kind === "resume").length, 1);
  h.completions[0]!();
  assert.equal(h.queue.queuedBytes, 0);
  assert.equal(h.events.filter((event) => event.kind === "ack").length, 0);
});

test("destroy 后的解析回调被忽略，不能启动排队输出", () => {
  const h = harness();
  h.queue.receive(message(1, "first"));
  h.queue.receive(message(2, "last"));
  h.queue.destroy(); h.completions[0]!();
  h.queue.receive(message(3, "late"));
  assert.equal(h.executed.length, 1);
  assert.equal(h.events.length, 0);
  assert.equal(h.queue.queuedBytes, 0);
});

test("帧操作确认前不解析 resize 后第一块；重复 completion 只确认一次", () => {
  const h = harness();
  h.queue.receive({ ...key, sequence: 1, operation: { kind: "frame", rect: { x: 0, y: 0, width: 400, height: 300, dpr: 2 } } });
  h.queue.receive(message(2, "new columns"));
  assert.equal(h.executed.length, 1);
  h.completions[0]!(); h.completions[0]!();
  assert.equal(h.executed.length, 2);
  assert.equal(h.events.length, 1);
});

test("缺号请求恢复，重复已接收序号无副作用", () => {
  const h = harness();
  h.queue.receive(message(1, "one"));
  h.queue.receive(message(1, "duplicate"));
  h.queue.receive(message(3, "gap"));
  assert.equal(h.executed.length, 1);
  assert.equal(h.events[0]?.kind, "resume");
});

test("发送侧合并、确认及超额恢复不依赖原生层", () => {
  const batches: GhosttyMessage[][] = []; const resumes: string[] = [];
  const sender = new GhosttySender(key, (batch) => batches.push(batch), (reason) => resumes.push(reason), 8);
  sender.output(new Uint8Array([1, 2]), true);
  sender.output(new Uint8Array([3, 4]));
  assert.equal(batches.length, 0);
  sender.flush();
  assert.equal(batches[0]?.length, 2);
  sender.ack({ ...key, generation: 1, kind: "ack", sequence: 1, bytes: 2, queuedBytes: 2, peakBytes: 4 });
  assert.equal(sender.queuedBytes, 4);
  sender.ack({ ...key, kind: "ack", sequence: 1, bytes: 2, queuedBytes: 2, peakBytes: 4 });
  sender.ack({ ...key, kind: "ack", sequence: 1, bytes: 2, queuedBytes: 2, peakBytes: 4 });
  assert.equal(sender.queuedBytes, 2);
  assert.equal(sender.output(new Uint8Array(7)), false);
  assert.equal(sender.output(new Uint8Array(1)), false);
  assert.equal(resumes.length, 1);
  assert.equal(batches.at(-1)?.[0]?.operation.kind, "recover");
  sender.destroy();
});

test("短时合并自动发送，但发送不释放解析额度", async () => {
  const batches: GhosttyMessage[][] = [];
  const sender = new GhosttySender(key, (batch) => batches.push(batch), () => assert.fail("不应恢复"));
  sender.output(new Uint8Array([1])); sender.output(new Uint8Array([2]));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(batches.length, 1);
  assert.equal(batches[0]?.length, 2);
  assert.equal(sender.queuedBytes, 2);
  sender.destroy();
});
