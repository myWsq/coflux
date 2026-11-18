import assert from "node:assert/strict";
import { test } from "node:test";

import { devLogin, devLoginPlan } from "./dev-login";

test("only an unpackaged build pointed at a loopback server signs in by itself", () => {
  const local = { packaged: false, serverUrl: "ws://localhost:8787/client", env: {} };
  assert.deepEqual(devLoginPlan(local), { url: "http://localhost:8787/api/client/login", username: "admin", password: "admin" });
  assert.deepEqual(devLoginPlan({ ...local, serverUrl: "wss://127.0.0.1:9443/client", env: { COFLUX_USERNAME: "me", COFLUX_PASSWORD: "pw" } }), {
    url: "https://127.0.0.1:9443/api/client/login",
    username: "me",
    password: "pw",
  });

  assert.equal(devLoginPlan({ ...local, packaged: true }), null);
  assert.equal(devLoginPlan({ ...local, env: { COFLUX_DESKTOP_DEV_LOGIN: "0" } }), null);
  for (const serverUrl of ["wss://api.coflux.dev/client", "ws://192.168.1.10:8787/client", "ws://localhost.example.com/client", "http://localhost:8787/client", "nonsense"]) {
    assert.equal(devLoginPlan({ ...local, serverUrl }), null, serverUrl);
  }
});

test("a login returns the token; any failure is reported and yields null", async () => {
  const plan = { url: "http://localhost:8787/api/client/login", username: "admin", password: "admin" };
  const failures: string[] = [];
  const reply = (body: unknown) => async (url: string, init: { body: string }) => {
    assert.equal(url, plan.url);
    assert.deepEqual(JSON.parse(init.body), { protocolVersion: 1, username: "admin", password: "admin" });
    return { json: async () => body };
  };
  assert.equal(await devLogin(plan, reply({ ok: true, value: { token: "ck_sess_x" } }), (reason) => failures.push(reason)), "ck_sess_x");
  assert.equal(await devLogin(plan, reply({ ok: false, error: "bad credentials" }), (reason) => failures.push(reason)), null);
  assert.equal(await devLogin(plan, reply({ ok: true, value: {} }), (reason) => failures.push(reason)), null);
  assert.equal(await devLogin(plan, async () => { throw new Error("ECONNREFUSED"); }, (reason) => failures.push(reason)), null);
  assert.deepEqual(failures, ["bad credentials", "the server did not return a session", "ECONNREFUSED"]);
});
