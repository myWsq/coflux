#!/usr/bin/env node
// Build native transport tools for local development and the real-process suite.
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
const architecture = { arm64: "aarch64", x64: "x86_64" }[process.arch];
const platform = { darwin: "apple-darwin", linux: "unknown-linux-musl" }[process.platform];
if (!architecture || !platform) throw new Error("Native transport development requires supported macOS or Linux architecture");
execFileSync(process.execPath, [resolve(root, "scripts/build-transport.mjs"), `${architecture}-${platform}`, resolve(root, "target/debug")], { cwd: root, stdio: "inherit" });
execFileSync("go", ["build", "-mod=readonly", "-o", resolve(root, "target/debug/coflux-test-derper"), "tailscale.com/cmd/derper"], { cwd: resolve(root, "transport/tailcat"), env: { ...process.env, GOTOOLCHAIN: "go1.27.1", CGO_ENABLED: "0" }, stdio: "inherit" });

execFileSync("go", ["build", "-mod=readonly", "-o", resolve(root, "target/debug/coflux-test-admission"), "./cmd/coflux-test-admission"], { cwd: resolve(root, "transport/tailcat"), env: { ...process.env, GOTOOLCHAIN: "go1.27.1", CGO_ENABLED: "0" }, stdio: "inherit" });
