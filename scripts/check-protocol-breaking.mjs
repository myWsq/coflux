#!/usr/bin/env node
// Keep FILE compatibility strict except for the explicitly retired transport symbols.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const root = resolve(import.meta.dirname, "..");
const exceptions = JSON.parse(readFileSync(resolve(root, "proto/tailcat-retirement-allowlist.json"), "utf8"));
const signature = ({ path, type, message }) => JSON.stringify([path, type, message]);
const allowed = new Set(exceptions.map(signature));
export function assertBreakingResult(result, permitRetirement) {
  if (result.error || result.signal || result.status === null) throw result.error || new Error("buf breaking did not complete");
  const output = result.stdout?.trim() || "";
  if (result.status === 0) {
    if (output) throw new Error(`Unexpected successful buf output: ${output}`);
    return;
  }
  if (![1, 100].includes(result.status) || !output) throw new Error(`buf command failed (${result.status}): ${result.stderr || "missing diagnostics"}`);
  const diagnostics = output.split("\n").map(line => {
    let value; try { value = JSON.parse(line); } catch { throw new Error(`Malformed buf diagnostic: ${line}`); }
    if (!value || ![value.path, value.type, value.message].every(part => typeof part === "string" && part.length)) throw new Error("Incomplete buf diagnostic");
    return value;
  });
  const rejected = diagnostics.filter(value => !permitRetirement || !allowed.has(signature(value)));
  if (rejected.length) throw new Error(rejected.map(value => `${value.path}: ${value.type}: ${value.message}`).join("\n"));
}
export function checkProtocolBreaking(against, run = spawnSync) {
  if (!against) throw new Error("Usage: node scripts/check-protocol-breaking.mjs <buf baseline>");
  const options = { cwd: resolve(root, "proto"), encoding: "utf8", maxBuffer: 8 * 1024 * 1024 };
  assertBreakingResult(run("buf", ["breaking", "--against", against, "--error-format=json"], options), true);
  // Reserved tags AND field names remain mandatory. No retirement exception
  // applies to wire or JSON compatibility, including tag/name reuse.
  const config = JSON.stringify({ version: "v2", modules: [{ path: "." }], breaking: { use: ["WIRE_JSON"] } });
  assertBreakingResult(run("buf", ["breaking", "--against", against, "--error-format=json", "--config", config], options), false);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { checkProtocolBreaking(process.argv[2]); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
