/**
 * 按需拨号的版本门（plan 043 善后）。
 *
 * 背景：v0.13.0 把 client↔daemon 数据面切成"server 让 daemon 自己拨 relay"。老 worker 不认识
 * deviceRelayDial，收到即丢弃 → client 连上 relay 干等到配对超时，两侧日志都只剩一句超时，
 * 现场表现为"设备显示在线但怎么都连不上"（2026-07-25 生产事故）。supportsRelayDial 把这个
 * 沉默提前拦成 deviceRelayGrant{ok:false, error}。
 *
 * 门的语义只有两条，本文件锁死：
 *   1. 能解析出 vX.Y.Z 的，严格按 0.13.0 为界；
 *   2. 解析不出的（builtin / 本地 cargo 产物 / 空）一律放行——dev 构建不受此门限制，
 *      否则本机开发和所有黑盒测试（模拟 daemon 从不上报真版本号）会被这道门全部挡死。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { supportsRelayDial, validRelayId } from "../../apps/server/src/relay-rendezvous.ts";

describe("supportsRelayDial", () => {
  test("低于 v0.13.0 一律拦下", () => {
    for (const v of ["v0.12.0", "v0.12.9", "v0.1.0", "0.12.0", "v0.0.1"]) {
      assert.equal(supportsRelayDial(v), false, `${v} 应被拦下`);
    }
  });

  test("v0.13.0 及以上放行", () => {
    for (const v of ["v0.13.0", "v0.13.1", "v0.14.0", "v1.0.0", "0.13.0", "v0.13.0-rc1", " v0.13.0 "]) {
      assert.equal(supportsRelayDial(v), true, `${v} 应放行`);
    }
  });

  test("非版本号形态放行（dev 构建不被这道门挡死）", () => {
    for (const v of ["builtin", "", "dev", "test", "unknown"]) {
      assert.equal(supportsRelayDial(v), true, `${v} 应放行`);
    }
  });

  test("按段比较而非字典序（v0.9.0 < v0.13.0）", () => {
    assert.equal(supportsRelayDial("v0.9.0"), false);
    assert.equal(supportsRelayDial("v0.130.0"), true);
  });
});

describe("validRelayId", () => {
  test("按 UTF-8 字节将内部 frame ID 限在 255 字节", () => {
    assert.equal(validRelayId("a".repeat(255)), true);
    assert.equal(validRelayId("a".repeat(256)), false);
    assert.equal(validRelayId("界".repeat(85)), true);
    assert.equal(validRelayId("界".repeat(86)), false);
  });
});
