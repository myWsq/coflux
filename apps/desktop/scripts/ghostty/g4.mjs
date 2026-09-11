import assert from "node:assert/strict";
import { addon, createSurface, delay } from "./native-driver.mjs";
const surface = await createSurface();
const keys = [[17, "create-terminal"], [13, "close-terminal"], [45, "create-workspace"], [18, "tab:0"], [19, "tab:1"], [20, "tab:2"], [21, "tab:3"], [23, "tab:4"], [22, "tab:5"], [26, "tab:6"], [28, "tab:7"], [25, "tab:8"]];
try {
  addon.setAccess(surface.id, true, 1); addon.setFocus(surface.id, true);
  let timestamp = 1;
  for (const [code, expected] of keys) {
    surface.events.length = 0;
    addon.testCommandKey(surface.id, code, timestamp++);
    await delay(30);
    const commands = surface.events.filter((event) => event.kind === 7).map((event) => event.bytes.toString());
    assert.deepEqual(commands, [expected]);
    assert.equal(surface.events.filter((event) => event.kind === 2).length, 0);
  }
  console.log(JSON.stringify({ gate: "G4", keys: keys.length, actionsPerKey: 1, remoteByteCallbacks: 0, remaining: "实际菜单、IME 与 Electron first responder 人工验收" }));
} finally { await surface.destroy(); }
