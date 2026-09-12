import assert from "node:assert/strict";
import test from "node:test";
import { create, DeviceTailcatConnectSchema, DeviceScope, DEVICE_PROTOCOL_VERSION } from "@coflux/protocol";
import type { ClientConn, DaemonConn } from "./hub.js";
import { privateTailcatRegions, TailcatRendezvous } from "./tailcat-rendezvous.js";

const serverKey = `nodekey:${"1".repeat(64)}`, clientKey = `nodekey:${"2".repeat(64)}`;
function fixture() {
  const daemon = { accountId: "account", info: { daemonId: "device" } } as DaemonConn;
  const client = { accountId: "account", tokenHash: "session" } as ClientConn;
  const sent: { case: string; value: any }[] = [];
  const coordinator = new TailcatRendezvous(privateTailcatRegions(JSON.stringify([{ RegionID: 901, Nodes: [{ Name: "a", RegionID: 901, HostName: "relay.example" }] }])),
    (id) => id === "device" ? daemon : undefined, (_, payload) => { sent.push(payload as any); return true; }, (_, payload) => { sent.push(payload as any); });
  coordinator.identity(daemon, serverKey, 1); coordinator.endpoint(daemon, serverKey, "secret-address", 1);
  const request = (channel = "channel", scope = DeviceScope.SESSION_CONTROL) => create(DeviceTailcatConnectSchema, { daemonId: "device", channelId: channel, clientInstanceId: "logical-client", transportGeneration: 1n, protocolVersion: DEVICE_PROTOCOL_VERSION, nodePublicKey: clientKey, scope });
  return { daemon, client, sent, coordinator, request };
}
test("Tailcat refuses cross-account grants and does not admit their node", () => {
  const f = fixture(); try { f.coordinator.connect({ ...f.client, accountId: "other" }, f.request()); assert.equal(f.coordinator.admitted(clientKey), false); assert.equal(f.sent.at(-1)?.value.ok, false); } finally { f.coordinator.shutdown(); }
});
test("Tailcat grants bind the logical identity and are delivered only after worker installation", () => {
  const f = fixture(); try {
    f.coordinator.connect(f.client, f.request()); const grant = f.sent.at(-1)!;
    assert.equal(grant.case, "deviceTailcatGrant"); assert.equal(grant.value.clientInstanceId, "logical-client"); assert.equal(grant.value.daemonId, "device"); assert.equal(grant.value.proofKey.length, 32);
    f.coordinator.installed(f.daemon, "channel", true); assert.equal(f.sent.at(-1)?.case, "deviceTailcatResult"); assert.equal(f.sent.at(-1)?.value.address, "secret-address");
    f.coordinator.closeChannel({ ...f.client }, "channel"); assert.equal(f.coordinator.admitted(clientKey), true);
    f.coordinator.closeChannel(f.client, "channel"); assert.equal(f.coordinator.admitted(clientKey), false);
  } finally { f.coordinator.shutdown(); }
});
test("Control outage immediately revokes pending/elevated grants and retains only opened session lanes", () => {
  const f = fixture(); try {
    f.coordinator.connect(f.client, f.request("session")); f.coordinator.installed(f.daemon, "session", true); f.coordinator.opened(f.daemon, "session");
    f.coordinator.connect(f.client, f.request("elevated", DeviceScope.RPC)); f.coordinator.installed(f.daemon, "elevated", true); f.coordinator.opened(f.daemon, "elevated");
    f.coordinator.connect(f.client, f.request("pending"));
    f.coordinator.closeClient(f.client);
    const revoked = f.sent.filter((event) => event.case === "deviceTailcatRevoke").flatMap((event) => event.value.channelIds);
    assert.deepEqual(f.sent.filter(event => event.case === "deviceTailcatClosed").map(event => event.value.channelId).sort(), ["elevated", "pending"]);
    assert.deepEqual(revoked.sort(), ["elevated", "pending"]); assert.equal(f.coordinator.admitted(clientKey), true);
    f.coordinator.revokeToken("account", "session"); assert.equal(f.coordinator.admitted(clientKey), false);
  } finally { f.coordinator.shutdown(); }
});
test("Replacing a helper identity invalidates old endpoint and authorization", () => {
  const f = fixture(); try { f.coordinator.connect(f.client, f.request()); f.coordinator.identity(f.daemon, `nodekey:${"3".repeat(64)}`, 1); assert.equal(f.coordinator.admitted(serverKey), false); assert.equal(f.coordinator.admitted(clientKey), false); f.coordinator.installed(f.daemon, "channel", true); assert.notEqual(f.sent.at(-1)?.case, "deviceTailcatResult"); } finally { f.coordinator.shutdown(); }
});


test("worker rejection immediately settles the requesting client", () => {
  const f = fixture(); try {
    f.coordinator.connect(f.client, f.request()); f.coordinator.installed(f.daemon, "channel", false);
    assert.equal(f.sent.at(-1)?.case, "deviceTailcatResult"); assert.equal(f.sent.at(-1)?.value.ok, false);
    assert.equal(f.coordinator.admitted(clientKey), false);
  } finally { f.coordinator.shutdown(); }
});
test("failed dial requests only an owned pending channel's worker health check", () => {
  const f = fixture(); try {
    f.coordinator.connect(f.client, f.request()); f.coordinator.installed(f.daemon, "channel", true);
    const before = f.sent.length;
    f.coordinator.failed({ ...f.client }, "channel"); assert.equal(f.sent.length, before);
    f.coordinator.failed(f.client, "channel");
    assert.equal(f.sent.at(-1)?.case, "deviceTailcatConfigure"); assert.equal(f.sent.at(-1)?.value.refreshOnly, true);
    f.coordinator.connect(f.client, f.request("live")); f.coordinator.installed(f.daemon, "live", true); f.coordinator.opened(f.daemon, "live");
    const live = f.sent.length; f.coordinator.failed(f.client, "live"); assert.equal(f.sent.length, live);
  } finally { f.coordinator.shutdown(); }
});


test("helper replacement notifies the owner to dispose the obsolete native lane", () => {
  const f = fixture(); try {
    f.coordinator.connect(f.client, f.request("obsolete"));
    f.coordinator.installed(f.daemon, "obsolete", true);
    f.coordinator.opened(f.daemon, "obsolete");
    f.coordinator.identity(f.daemon, `nodekey:${"3".repeat(64)}`, 1);
    assert.deepEqual(f.sent.filter(event => event.case === "deviceTailcatClosed").map(event => event.value.channelId), ["obsolete"]);
    f.coordinator.endpoint(f.daemon, `nodekey:${"3".repeat(64)}`, "new-address", 1);
    f.coordinator.connect(f.client, f.request("replacement"));
    f.coordinator.closeChannel(f.client, "obsolete");
    assert.equal(f.coordinator.admitted(clientKey), true, "a stale close cannot revoke the replacement grant");
  } finally { f.coordinator.shutdown(); }
});
