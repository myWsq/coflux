#!/usr/bin/env node
// Build the pinned, CGO-free native helper and its compiled dependency notices.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [target, destination] = process.argv.slice(2);
const platforms = {
  "aarch64-apple-darwin": ["darwin", "arm64"],
  "x86_64-apple-darwin": ["darwin", "amd64"],
  "aarch64-unknown-linux-musl": ["linux", "arm64"],
  "x86_64-unknown-linux-musl": ["linux", "amd64"],
};
if (!platforms[target] || !destination) throw new Error("Usage: node scripts/build-transport.mjs <Rust release target> <output directory>");
const directory = resolve(destination), cwd = resolve(root, "transport/tailcat");
const [GOOS, GOARCH] = platforms[target];
const env = { ...process.env, GOOS, GOARCH, CGO_ENABLED: "0", GOTOOLCHAIN: "go1.27.1" };
const version = process.env.COFLUX_RELEASE_VERSION || "dev";
if (!/^(dev|v[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?)$/.test(version)) throw new Error("Invalid native release version");
mkdirSync(directory, { recursive: true });
execFileSync("go", ["build", "-mod=readonly", "-trimpath", "-ldflags", `-s -w -X main.releaseVersion=${version}`, "-o", resolve(directory, "coflux-transport"), "./cmd/coflux-transport"], { cwd, env, stdio: "inherit" });
const records = execFileSync("go", ["list", "-mod=readonly", "-deps", "-f", "{{with .Module}}{{.Path}}\t{{.Version}}\t{{.Dir}}{{end}}", "./cmd/coflux-transport"], { cwd, env, encoding: "utf8" });
const modules = [...new Set(records.trim().split("\n").filter(Boolean))].sort();
const notices = [`Coflux native transport third-party notices\nTarget: ${target}\nRelease: ${version}\nToolchain: Go 1.27.1\n`];
for (const record of modules) {
  const [name, revision, moduleDir] = record.split("\t");
  if (name === "github.com/myWsq/coflux/transport/tailcat") continue;
  const files = readdirSync(moduleDir).filter(name => /^(LICENSE|COPYING|NOTICE|COPYRIGHT)(\..*)?$/i.test(name)).sort();
  if (!files.some(name => /^(LICENSE|COPYING)/i.test(name))) throw new Error(`Missing license for compiled module ${name}@${revision}`);
  notices.push(`\n===== ${name}@${revision} =====\n`);
  for (const file of files) notices.push(`\n--- ${file} ---\n${readFileSync(resolve(moduleDir, file), "utf8")}\n`);
}
const goroot = execFileSync("go", ["env", "GOROOT"], { cwd, env, encoding: "utf8" }).trim();
notices.push(`\n===== Go toolchain / standard library =====\n${readFileSync(resolve(goroot, "LICENSE"), "utf8")}\n`);
writeFileSync(resolve(directory, "TRANSPORT-NOTICES.txt"), notices.join(""));
writeFileSync(resolve(directory, "TRANSPORT-MODULES.txt"), modules.map(record => record.split("\t").slice(0, 2).join("\t")).join("\n") + "\n");
