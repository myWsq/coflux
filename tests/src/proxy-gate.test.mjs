/** ProxyGate 的纯内存资源边界测试；不经 hub，直接锁定 code/session 各自的满额语义。 */
import { test } from "node:test";
import assert from "node:assert/strict";

// proxy.ts 会读取 server config；单测显式使用开发配置，避免依赖调用机器上的生产秘密。
process.env.COFLUX_DEV = "1";
const { ProxyGate } = await import("../../apps/server/src/proxy.ts");

test("ProxyGate 授权 code 达硬上限后撤销最早项，消费会立即释放名额", () => {
  const gate = new ProxyGate(2, 8);
  const first = gate.issueAuthCode("account-first");
  const second = gate.issueAuthCode("account-second");
  const third = gate.issueAuthCode("account-third");

  assert.equal(gate.consumeAuthCode(first), undefined, "满额后最早 code 应被确定性撤销");
  assert.deepEqual(gate.consumeAuthCode(second), { accountId: "account-second" });
  assert.deepEqual(gate.consumeAuthCode(third), { accountId: "account-third" });
  assert.equal(gate.consumeAuthCode(second), undefined, "code 仍必须保持一次性");

  const replacement = gate.issueAuthCode("account-replacement");
  assert.deepEqual(gate.consumeAuthCode(replacement), { accountId: "account-replacement" });
});

test("ProxyGate session 达硬上限后拒绝新建且不淘汰仍有效项", () => {
  const gate = new ProxyGate(8, 2);
  const first = gate.createSession("account-first");
  const second = gate.createSession("account-second");
  const third = gate.createSession("account-third");

  assert.equal(third, undefined, "满额后新 session 应 fail closed");
  assert.deepEqual(gate.checkSession(first), { accountId: "account-first" });
  assert.deepEqual(gate.checkSession(second), { accountId: "account-second" });
});

test("ProxyGate 拒绝零值、负数和非安全整数容量", () => {
  for (const [codes, sessions] of [
    [0, 1],
    [1, 0],
    [-1, 1],
    [1, Number.MAX_SAFE_INTEGER + 1],
  ]) {
    assert.throws(() => new ProxyGate(codes, sessions), /容量必须是正安全整数/);
  }
});
