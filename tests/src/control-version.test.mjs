// Removed remote transports require control protocol v2; newer compatible peers remain admissible.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer } from "./harness.mjs";
const PORT = 8855;
let server;
before(async () => { server = await startServer({ port: PORT, env: { COFLUX_USERNAME: "admin", COFLUX_PASSWORD: "admin" } }); });
after(async () => { await server?.stop(); });
test("clients below the control floor are rejected and compatible newer clients authenticate", async () => {
  for (const version of [0, 1, 2, 3]) {
    const client = server.makeClient();
    try {
      await client.ready; client.send({ case: "clientAuth", username: "admin", password: "admin", controlProtocolVersion: version });
      const result = await client.waitFor(m => ["authOk", "clientOutdated"].includes(m.case), "version admission");
      assert.equal(result.case, version < 2 ? "clientOutdated" : "authOk");
      if (version >= 2) assert.equal(result.controlProtocolVersion, 2);
    } finally { client.close(); }
  }
});
test("obsolete daemon authentication and enrollment fail before authority is issued", async () => {
  for (const version of [0, 1]) for (const operation of ["daemonAuth", "daemonEnrollRequest"]) {
    const daemon = server.rawDaemon();
    try {
      await daemon.ready;
      daemon.send({ case: operation, name: "obsolete", host: "test", platform: "test", daemonId: "untrusted", token: "untrusted", controlProtocolVersion: version });
      const result = await daemon.waitFor(m => m.case === "daemonAuthError", "obsolete daemon rejection");
      assert.match(result.message, /control protocol requires an update/);
    } finally { daemon.close(); }
  }
});
