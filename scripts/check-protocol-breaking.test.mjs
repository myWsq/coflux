import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { assertBreakingResult, checkProtocolBreaking } from "./check-protocol-breaking.mjs";
const retired = JSON.parse(readFileSync(new URL("../proto/tailcat-retirement-allowlist.json", import.meta.url), "utf8"));
const diagnostic = value => ({ status: 100, stdout: JSON.stringify(value), stderr: "" });
test("only the exact reviewed FILE removals are exempt", () => {
  assert.equal(retired.length, 26);
  for (const entry of retired) {
    assert.doesNotThrow(() => assertBreakingResult(diagnostic(entry), true));
    for (const field of ["path", "type", "message"]) assert.throws(() => assertBreakingResult(diagnostic({ ...entry, [field]: entry[field] + "unrelated" }), true));
  }
});
test("unrelated message or field removal and type changes still fail", () => {
  for (const value of [
    { path: "coflux/v1/client.proto", type: "FIELD_NO_DELETE", message: 'Previously present field "1" with name "client_auth" on message "ClientToServer" was deleted.' },
    { path: "coflux/v1/device.proto", type: "MESSAGE_NO_DELETE", message: 'Previously present message "DeviceSessionAttach" was deleted from file.' },
    { path: "coflux/v1/client.proto", type: "FIELD_SAME_TYPE", message: 'Field "protocol_version" changed type from "uint32" to "string".' },
  ]) assert.throws(() => assertBreakingResult(diagnostic(value), true));
});
test("wire and JSON name/tag reuse are never exempt", () => {
  const invocations = [];
  assert.throws(() => checkProtocolBreaking("baseline", (_binary, args) => {
    invocations.push(args);
    return invocations.length === 1 ? diagnostic(retired[0]) : diagnostic({ ...retired[0], type: "RESERVED_MESSAGE_NO_DELETE", message: "Previously reserved field number or name was reused" });
  }));
  assert.equal(invocations.length, 2);
  assert.match(invocations[1].at(-1), /WIRE_JSON/);
  assert.throws(() => assertBreakingResult(diagnostic(retired[0]), false));
});
test("command failures and malformed diagnostics cannot be mistaken for exceptions", () => {
  for (const value of [
    { status: 100, stdout: "", stderr: "baseline unavailable" },
    { status: 1, stdout: "not json" }, { status: 100, stdout: "{}" },
    { status: null, signal: "SIGTERM" }, { status: 2, stdout: JSON.stringify(retired[0]) },
  ]) assert.throws(() => assertBreakingResult(value, true));
});
