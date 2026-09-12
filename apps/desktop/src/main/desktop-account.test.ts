import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createDesktopAccount, accountControl } from "./desktop-account";

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "coflux-account-"));
  let stored = "";
  let writable = true;
  const store = { read: () => stored, write: (value: string) => { if (!writable) return false; stored = value; return true; }, clear: () => { stored = ""; return true; } };
  return { home, store, failWrites: () => { writable = false; }, dispose: () => rmSync(home, { recursive: true, force: true }) };
}

test("账号保存失败不在内存中完成切换，未确认归属不删除旧安装凭据", async () => {
  const f = fixture();
  try {
    const path = join(f.home, "credentials.json");
    writeFileSync(path, JSON.stringify({ daemonId: "local", deviceToken: "device-secret" }));
    const account = createDesktopAccount(f.home, "ws://unused", f.store, async () => ({ accountId: "owner", daemonIds: ["local"] }));
    f.failWrites();
    await assert.rejects(account.connect("session"), /无法安全保存/);
    assert.equal(account.accountId(), null);
    assert.throws(() => account.logout("session"), /无法安全保存/);
    assert.equal(account.hasPending(), false);
    assert.match(readFileSync(path, "utf8"), /device-secret/);
  } finally { f.dispose(); }
});

test("旧安装归属其他账号时拒绝接入；退出当前客户端不清除旧设备", async () => {
  const f = fixture();
  try {
    const path = join(f.home, "credentials.json");
    writeFileSync(path, JSON.stringify({ daemonId: "other" }));
    const account = createDesktopAccount(f.home, "ws://unused", f.store, async () => ({ accountId: "new", daemonIds: [] }));
    await assert.rejects(account.connect("session"), /其他账号/);
    account.logout("session");
    assert.match(readFileSync(path, "utf8"), /other/);
  } finally { f.dispose(); }
});

test("离线退出保留持久清理记录，重启后重试只删除本机终端并撤销旧 token", async () => {
  const f = fixture();
  try {
    let online = true;
    const calls: unknown[] = [];
    const control: typeof accountControl = async (_url, token, cleanup) => {
      if (!online) throw new Error("offline");
      if (cleanup) calls.push({ token, ...cleanup });
      return { accountId: "owner", daemonIds: ["local"] };
    };
    const account = createDesktopAccount(f.home, "ws://unused", f.store, control);
    await account.connect("old-session");
    writeFileSync(join(f.home, "credentials.json"), JSON.stringify({ daemonId: "local" }));
    online = false;
    account.logout("old-session");
    await assert.rejects(account.drain(), /offline/);
    const restored = createDesktopAccount(f.home, "ws://unused", f.store, control);
    assert.equal(restored.hasPending(), true);
    online = true;
    await Promise.all([restored.drain(), restored.drain()]);
    assert.deepEqual(calls, [{ token: "old-session", accountId: "owner", daemonId: "local", revoke: true }]);
    assert.equal(restored.hasPending(), false);
  } finally { f.dispose(); }
});


test("account control rejects obsolete server versions before subscription or cleanup", async () => {
  const { WebSocketServer } = await import("ws");
  const { create, decodeClientToServer, encodeServerToClient, ServerToClientSchema } = await import("@coflux/protocol");
  for (const version of [0, 1, 2, 3]) {
    const server = new WebSocketServer({ port: 0 });
    await new Promise<void>(resolve => server.once("listening", resolve));
    const received: string[] = [];
    server.on("connection", socket => {
      socket.on("message", bytes => {
        const message = decodeClientToServer(new Uint8Array(bytes as Buffer));
        if (!message?.payload.case) return;
        received.push(message.payload.case);
        if (message.payload.case === "clientAuth") socket.send(encodeServerToClient(create(ServerToClientSchema, { payload: { case: "authOk", value: { accountId: "owner", controlProtocolVersion: version } } })));
        if (message.payload.case === "clientSubscribe") socket.send(encodeServerToClient(create(ServerToClientSchema, { payload: { case: "stateSnapshot", value: {} } })));
      });
    });
    try {
      const address = server.address(); assert(address && typeof address !== "string");
      const result = accountControl(`ws://127.0.0.1:${address.port}`, "session");
      if (version < 2) {
        await assert.rejects(result, /服务器需要升级/);
        assert.deepEqual(received, ["clientAuth"]);
      } else {
        assert.equal((await result).accountId, "owner");
        assert.deepEqual(received, ["clientAuth", "clientSubscribe"]);
      }
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  }
});
