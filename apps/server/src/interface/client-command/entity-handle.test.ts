import assert from "node:assert/strict";
import test from "node:test";
import { entityRef, parseEntityHandle, resolveEntityHandle, type EntityKind, type HandleResolution } from "./entity-handle.js";

/** Assert the resolution failed and hand back the sentence the user would read. */
function refusal(resolution: HandleResolution): string {
  assert.equal(resolution.ok, false, "expected the handle to be refused");
  return resolution.ok ? "" : resolution.error;
}

/** A stub candidate lookup: it records how it was called and answers with the ids given to it, so the
 * three failure kinds can be exercised without a database. Ambiguity in particular is unreachable from
 * the wire — ids are random UUIDv4 and the shortest legal handle carries 4 hex characters, so two
 * entities of one kind sharing a prefix is a one-in-65536 accident that no black-box test can stage. */
function lookupOf(ids: string[]) {
  const calls: { kind: EntityKind; prefix: string; limit: number }[] = [];
  return {
    calls,
    lookup: async (kind: EntityKind, prefix: string, limit: number) => {
      calls.push({ kind, prefix, limit });
      return ids.filter((id) => id.startsWith(prefix)).slice(0, limit);
    },
  };
}

test("handles are generated as the kind plus the id's first 8 lowercase hex characters", () => {
  assert.equal(entityRef("device", "B6767697-60B2-4700-A304-1404BF03C675"), "coflux:device:b6767697");
  assert.equal(entityRef("workspace", "3f2a1b7c-0000-4000-8000-000000000000"), "coflux:workspace:3f2a1b7c");
  assert.equal(entityRef("project", "7a83f21e-0000-4000-8000-000000000000"), "coflux:project:7a83f21e");
  assert.equal(entityRef("terminal", "9e21c4d0-0000-4000-8000-000000000000"), "coflux:terminal:9e21c4d0");
});

test("parsing is case-insensitive and refuses anything that is not kind + 4..32 hex", () => {
  assert.deepEqual(parseEntityHandle("  COFLUX:Device:B6767697 "), { kind: "device", prefix: "b6767697" });
  assert.deepEqual(parseEntityHandle("coflux:terminal:9e21"), { kind: "terminal", prefix: "9e21" });
  assert.equal(parseEntityHandle("coflux:session:b6767697"), undefined, "PTY sessions have no handle");
  assert.equal(parseEntityHandle("coflux:device:b67"), undefined, "shorter than 4 hex");
  assert.equal(parseEntityHandle("coflux:device:b6767697-60b2"), undefined, "a UUID's dashes are not hex");
  assert.equal(parseEntityHandle("b6767697-60b2-4700-a304-1404bf03c675"), undefined, "a bare UUID is not a handle");
});

test("a string that is not a handle passes through untouched and costs no lookup", async () => {
  const stub = lookupOf(["b6767697-60b2-4700-a304-1404bf03c675"]);
  const resolved = await resolveEntityHandle("device", "b6767697-60b2-4700-a304-1404bf03c675", stub.lookup);
  assert.deepEqual(resolved, { ok: true, value: "b6767697-60b2-4700-a304-1404bf03c675" });
  assert.equal(stub.calls.length, 0, "real ids never reach the database twice");
});

test("a handle resolves to the one account entity whose id starts with it", async () => {
  const stub = lookupOf(["b6767697-60b2-4700-a304-1404bf03c675", "3f2a1b7c-0000-4000-8000-000000000000"]);
  const resolved = await resolveEntityHandle("device", "coflux:device:B6767697", stub.lookup);
  assert.deepEqual(resolved, { ok: true, value: "b6767697-60b2-4700-a304-1404bf03c675" });
  assert.deepEqual(stub.calls, [{ kind: "device", prefix: "b6767697", limit: 2 }], "bounded query, kind-scoped");
});

test("a handle of the wrong kind is refused from the token alone, naming both kinds", async () => {
  const stub = lookupOf(["3f2a1b7c-0000-4000-8000-000000000000"]);
  const error = refusal(await resolveEntityHandle("device", "coflux:workspace:3f2a1b7c", stub.lookup));
  assert.match(error, /工作区标识/);
  assert.match(error, /设备/);
  assert.equal(stub.calls.length, 0, "never probes another kind's table");
});

test("a handle with no match in this account is unknown, not silently adjacent", async () => {
  const stub = lookupOf(["b6767697-60b2-4700-a304-1404bf03c675"]);
  const error = refusal(await resolveEntityHandle("terminal", "coflux:terminal:deadbeef", stub.lookup));
  assert.match(error, /没有对应的终端/);
});

test("a prefix matching more than one entity is ambiguous and asks for the full UUID", async () => {
  const stub = lookupOf(["deadbeef-0000-4000-8000-000000000001", "deadbeef-0000-4000-8000-000000000002"]);
  const error = refusal(await resolveEntityHandle("terminal", "coflux:terminal:deadbeef", stub.lookup));
  assert.match(error, /同时匹配到多个终端/);
  assert.match(error, /完整 UUID/);
  assert.equal(stub.calls[0].limit, 2, "two rows are enough to call it ambiguous");
});
