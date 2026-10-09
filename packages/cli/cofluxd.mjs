#!/usr/bin/env node
// cofluxd: installs, starts, stops and updates the Coflux service on a device. It runs for one
// command and never stays resident.
//
// The service is three Rust processes: ptyd owns every PTY and lives long; the launcher owns the
// runtime version pointer and rollback and rarely changes; the runtime is updated by the server.
// Three service backends start them:
// - launchd (macOS) and systemd user units (Linux with systemd booted): ptyd and the launcher each
//   get their own unit, so restarting the launcher leaves the terminals in ptyd.
// - self-managed (Linux without systemd: containers, WSL, OpenRC): `coflux-launcher watch` starts
//   and supervises both. `cofluxd up` runs it in the background; `cofluxd run` in the foreground.
import { parseArgs } from "node:util";
import { homedir, hostname, platform, arch } from "node:os";
import { join, dirname, basename } from "node:path";
import { createInterface } from "node:readline/promises";
import fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import dns from "node:dns/promises";
import net from "node:net";
import tls from "node:tls";
import crypto from "node:crypto";
import {
  MAX_RELEASE_ARTIFACT_BYTES,
  assertReleaseVersion,
  compareReleaseVersions,
  createReleasePublicKey,
  installNativeRelease,
  parseReleaseManifestEntry,
  verifyReleaseArtifact,
} from "./release-trust.mjs";
import { executorRuntime, plistXml, ptydPlistXml, ptydSystemdUnit, systemdUnit, watcherEnv } from "./service-unit.mjs";
import { bold, duration, error as printError, fail, info, step, success, table, warn } from "./output.mjs";

// The public server; self-hosted servers pass --server.
const DEFAULT_SERVER = "wss://api.coflux.yourantiandi.com/daemon";
// The public server's address before it moved to its ICP-registered name; a saved copy means the default.
const LEGACY_DEFAULT_SERVER = "wss://api.coflux.dev/daemon";

const REPO = "myWsq/coflux";
// Release downloads route by version, never by failure (plan 20260930-r2-download-mirror): the mirror
// (R2 at dl.coflux.dev) holds only the latest stable release and its `latest.json` pointer; every other
// version, and every prerelease, comes from the GitHub Releases archive. No mirror-then-GitHub fallback:
// a mirror outage must stay visible.
const RELEASE_MIRROR_BASE = (
  process.env.COFLUX_RELEASE_DOWNLOAD_BASE || "https://dl.coflux.dev/releases"
).replace(/\/+$/, "");
const RELEASE_ARCHIVE_BASE = (
  process.env.COFLUX_RELEASE_ARCHIVE_BASE || `https://github.com/${REPO}/releases/download`
).replace(/\/+$/, "");
const MAX_RELEASE_METADATA_BYTES = 1024 * 1024;
const HOME = process.env.COFLUX_HOME || join(homedir(), ".coflux");
const BIN_DIR = join(HOME, "bin");
const SETTINGS = join(HOME, "settings.json"); // serverUrl / deviceName / shell, read by the service; 0600
const LOG_FILE = join(HOME, "daemon.log");
const CRED = join(HOME, "credentials.json");
const PENDING_AUTH = join(HOME, "pending-auth.json"); // the authorization link the runtime writes
// One-time join key (plan 20260924-device-join-keys): `up --key` writes it, the runtime presents it once
// and deletes it on the server's answer, recording what happened in the outcome file (0600 each).
const JOIN_KEY = join(HOME, "join-key.json");
const JOIN_OUTCOME = join(HOME, "join-outcome.json");
const CONN_STATE = join(HOME, "conn-state.json"); // connection snapshot (crates/runtime/src/conn_state.rs)
const LOCAL_GATEWAY_STORE = join(HOME, "local-gateway.json"); // doctor reads its shape and counts only, never secrets
const FDA_STATUS = join(HOME, "fda-status"); // macOS only, written by the runtime (crates/runtime/src/fda.rs)
const LAUNCHER_BIN = join(BIN_DIR, "coflux-launcher");
const RUNTIME_BIN = join(BIN_DIR, "coflux-runtime");
const PTYD_BIN = join(BIN_DIR, "coflux-ptyd");
const CLI_BIN = join(BIN_DIR, "coflux");
const CLI_RELEASE_FLOOR = join(HOME, "cofluxd.release-floor");
const RUNTIME_RELEASE_FLOOR = join(HOME, "runtime.release-floor");
const IS_MAC = platform() === "darwin";
const IS_LINUX = platform() === "linux";
const PLIST = join(homedir(), "Library", "LaunchAgents", "com.coflux.daemon.plist");
const UNIT = join(homedir(), ".config", "systemd", "user", "coflux-daemon.service");
// ptyd runs as its own service (plan 20260918-ptyd-terminal-custody): one launchd plist runs one program,
// and systemd's default KillMode=control-group would take the whole cgroup down on `systemctl restart`.
// ptyd must sit outside the launcher's process group / cgroup for a restart to leave the terminals.
const PTYD_PLIST = join(homedir(), "Library", "LaunchAgents", "com.coflux.ptyd.plist");
const PTYD_UNIT = join(homedir(), ".config", "systemd", "user", "coflux-ptyd.service");
const DEFAULT_LOCAL_GATEWAY_PORT = 8788; // same as LOCAL_GATEWAY_PORT in the protocol packages

// Self-managed mode (`coflux-launcher watch`, crates/launcher/src/watch.rs).
const SERVICE_MODE_FILE = join(HOME, "service-mode"); // "self-managed" once `up` chose it on this device
const WATCH_SOCK = join(HOME, "watch.sock");
const WATCH_STATE = join(HOME, "watch.json");
/** Found inside a launcher binary that has `watch`; an older launcher would ignore the argument. */
const WATCH_PROTOCOL = "coflux-watch/1";
/** The watcher's exit code when another service already owns this home. */
const WATCH_EXIT_REFUSED = 3;

const SYSTEMD_NEXT = "Check that systemd user services work in this session (systemctl --user status), then try again.";
const LAUNCHD_NEXT = "See cofluxd logs, then try again.";

const die = (what, next = "Run cofluxd --help for usage.") => fail(what, next);
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", ...opts });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const messageOf = (error) => (error instanceof Error ? error.message : String(error));

/**
 * A launchctl / systemctl call whose failure must stop the command: `up` never reports success over a
 * service manager that refused. Calls that only clear whatever may be loaded use `run` instead.
 */
function runChecked(cmd, args, next) {
  const result = run(cmd, args);
  if (result.status === 0) return result;
  const detail = (result.stderr || result.stdout || "").trim().split("\n")[0] || (result.error ? result.error.message : `exit status ${result.status}`);
  die(`${cmd} ${args.join(" ")} failed: ${detail}`, next);
}

function rustTarget() {
  const p = platform(), a = arch();
  if (p === "darwin") return a === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  if (p === "linux") return a === "arm64" ? "aarch64-unknown-linux-musl" : "x86_64-unknown-linux-musl";
  die(`This platform is not supported: ${p}/${a}.`, "Coflux runs on macOS and Linux.");
}

/** `linux-x64`, `macos-arm64`: the platform as people name it. */
function platformLabel() {
  return `${IS_MAC ? "macos" : platform()}-${arch()}`;
}

/** `2.15.0` for the tag `v2.15.0`. */
const displayVersion = (tag) => String(tag).replace(/^v/, "");

function readSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS, "utf8")); } catch { return {}; }
}

function readPendingAuth() {
  try { return JSON.parse(fs.readFileSync(PENDING_AUTH, "utf8")); } catch { return null; }
}

function readJoinOutcome() {
  try { return JSON.parse(fs.readFileSync(JOIN_OUTCOME, "utf8")); } catch { return null; }
}

function readCredentialsSummary() {
  try {
    const c = JSON.parse(fs.readFileSync(CRED, "utf8"));
    return { serverUrl: typeof c.serverUrl === "string" ? c.serverUrl : "", daemonId: typeof c.daemonId === "string" ? c.daemonId : "" };
  } catch { return { serverUrl: "", daemonId: "" }; }
}

function readConnState() {
  try { return JSON.parse(fs.readFileSync(CONN_STATE, "utf8")); } catch { return null; }
}

/** The host people recognise in a server URL: `api.coflux.dev`. */
function serverHost(serverUrl) {
  try { return new URL(serverUrl).host || serverUrl; } catch { return serverUrl || "unknown server"; }
}

function readLocalGatewaySummary() {
  let store;
  try { store = JSON.parse(fs.readFileSync(LOCAL_GATEWAY_STORE, "utf8")); }
  catch {
    return {
      ok: false,
      ready: false,
      // JSON.parse errors can quote the file on some Node versions; the store holds private keys and
      // diagnostics must never echo it.
      error: fs.existsSync(LOCAL_GATEWAY_STORE) ? "pairing data cannot be read" : "no pairing data yet",
    };
  }
  if (store?.version !== 1 || !Array.isArray(store.origins) || !Array.isArray(store.grants)) {
    return { ok: false, ready: false, error: "pairing data is not valid" };
  }
  const origins = store.origins.filter((origin) => typeof origin === "string" && origin.length > 0);
  const grants = store.grants.filter((grant) => grant && typeof grant.origin === "string" && grant.origin.length > 0);
  const origin = grants.find((grant) => origins.includes(grant.origin))?.origin || origins[0];
  const ready = grants.length > 0 && !!origin;
  return {
    ok: ready,
    ready,
    origin,
    detail: ready ? `${grants.length} paired browser${grants.length === 1 ? "" : "s"}` : undefined,
    error: ready ? undefined : "no paired browser yet",
  };
}

function localGatewayPort() {
  const raw = process.env.COFLUX_LOCAL_GATEWAY_PORT;
  if (raw === undefined || raw === "") return { ok: true, port: DEFAULT_LOCAL_GATEWAY_PORT };
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, error: `COFLUX_LOCAL_GATEWAY_PORT=${raw} is not a valid port` };
  }
  return { ok: true, port };
}

/** "granted" | "denied" | "unknown" | null (no file: the service has not written it yet). */
function readFdaStatus() {
  try { return fs.readFileSync(FDA_STATUS, "utf8").trim(); } catch { return null; }
}

function fileSha256(path) {
  try { return crypto.createHash("sha256").update(fs.readFileSync(path)).digest("hex"); } catch { return null; }
}

// macOS: a freshly written binary carries com.apple.provenance, and launchd's top-level spawn gets it
// killed by AMFI with OS_REASON_CODESIGNING, even when it is Developer ID signed and notarized
// (observed with v0.13.0 on 2026-07-25). An ad-hoc local re-sign makes it a local product. Remote
// artifacts must pass release statement verification before they get here; never re-sign anything else.
function resignMacBinaries(paths) {
  if (!IS_MAC) return;
  for (const p of paths) {
    const r = run("codesign", ["--force", "-s", "-", p]);
    if (r.status !== 0) {
      throw new Error(`could not re-sign ${basename(p)} for macOS`);
    }
  }
}

async function fetchBounded(url, maxBytes, label) {
  const res = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status}`);
  const declaredLength = Number(res.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(`${label} is larger than allowed`);
  }
  if (!res.body) throw new Error(`${label} came back empty`);
  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    const bytes = Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > maxBytes) {
      await res.body.cancel().catch(() => {});
      throw new Error(`${label} is larger than allowed`);
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total);
}

function loadReleasePublicKey() {
  const publicKeyHex = process.env.COFLUX_WORKER_PUBKEY ||
    fs.readFileSync(new URL("./release-pubkey.hex", import.meta.url), "utf8");
  return createReleasePublicKey(publicKeyHex);
}

const FLOOR_NEXT = "Reinstall Coflux on this device: cofluxd uninstall --purge, then cofluxd up.";

function readReleaseFloor(path, label) {
  let metadata;
  try { metadata = fs.lstatSync(path); }
  catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw new Error(`The local version record ${label} cannot be read.`);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0 || metadata.size > 128) {
    throw new Error(`The local version record ${label} is not a small regular file.`);
  }
  let value;
  try { value = fs.readFileSync(path, "utf8").trim(); }
  catch { throw new Error(`The local version record ${label} cannot be read.`); }
  try { assertReleaseVersion(value); }
  catch { throw new Error(`The local version record ${label} is corrupted.`); }
  return value;
}

function currentReleaseFloor() {
  const floors = [
    readReleaseFloor(CLI_RELEASE_FLOOR, "cofluxd.release-floor"),
    readReleaseFloor(RUNTIME_RELEASE_FLOOR, "runtime.release-floor"),
  ].filter(Boolean);
  return floors.reduce((highest, candidate) => {
    if (!highest) return candidate;
    const order = compareReleaseVersions(candidate, highest);
    if (order === 0 && candidate !== highest) {
      throw new Error(`The local version records disagree: ${highest} and ${candidate}.`);
    }
    return order > 0 ? candidate : highest;
  }, undefined);
}

function persistCliReleaseFloor(version) {
  const temp = join(HOME, `.cofluxd.release-floor.${process.pid}.${crypto.randomBytes(8).toString("hex")}`);
  let file;
  try {
    file = fs.openSync(temp, "wx", 0o600);
    fs.writeFileSync(file, `${version}\n`);
    fs.fsyncSync(file);
    fs.closeSync(file);
    file = undefined;
    fs.renameSync(temp, CLI_RELEASE_FLOOR);
    const homeDir = fs.openSync(HOME, "r");
    try { fs.fsyncSync(homeDir); }
    finally { fs.closeSync(homeDir); }
  } finally {
    if (file !== undefined) {
      try { fs.closeSync(file); } catch {}
    }
    try { fs.rmSync(temp, { force: true }); } catch {}
  }
}

// The latest stable tag named by the mirror's `latest.json`, or null when it cannot be read or is invalid.
async function readMirrorLatestTag() {
  try {
    const body = await fetchBounded(
      `${RELEASE_MIRROR_BASE}/latest.json`,
      MAX_RELEASE_METADATA_BYTES,
      "latest.json",
    );
    const tag = JSON.parse(body.toString("utf8"))?.version;
    if (typeof tag !== "string") return null;
    assertReleaseVersion(tag);
    return tag;
  } catch {
    return null;
  }
}

/**
 * Put the binaries in place. Returns the version installed: a release tag, or "local build".
 *
 * skipIfPresent: `up` and `run` are idempotent. When the binaries exist and no --version was given they
 * are not downloaded again, so running `up` twice never upgrades by surprise (plan 035). `update`,
 * --bin-dir and an explicit --version are not affected.
 */
async function ensureBinaries({ version, binDir, skipIfPresent }) {
  fs.mkdirSync(BIN_DIR, { recursive: true });
  if (binDir) {
    const localArtifacts = ["coflux-launcher", "coflux-runtime", "coflux-ptyd", ...(fs.existsSync(join(binDir, "coflux")) ? ["coflux"] : []), ...(fs.existsSync(join(binDir, "coflux-transport")) ? ["coflux-transport"] : [])].map((name) => ({
      name,
      path: join(binDir, name),
    }));
    for (const artifact of localArtifacts) {
      if (!fs.existsSync(artifact.path)) {
        die(`Missing local build: ${artifact.path}`, "Build it first, for example with cargo build --release.");
      }
    }
    const stageDir = fs.mkdtempSync(join(BIN_DIR, ".coflux-local-install-"));
    let localFailure;
    try {
      const staged = [];
      for (const artifact of localArtifacts) {
        const destination = join(BIN_DIR, artifact.name);
        const source = join(stageDir, artifact.name);
        fs.copyFileSync(artifact.path, source);
        fs.chmodSync(source, 0o755);
        staged.push({ source, destination });
      }
      resignMacBinaries(staged.map(({ source }) => source));
      if (localArtifacts.some(artifact => artifact.name === "coflux-transport")) {
        const source = join(stageDir, "TRANSPORT-NOTICES.txt");
        fs.copyFileSync(join(binDir, "TRANSPORT-NOTICES.txt"), source);
        staged.push({ source, destination: join(BIN_DIR, "TRANSPORT-NOTICES.txt") });
      }
      installNativeRelease(staged);
    } catch (error) {
      localFailure = error;
    } finally {
      fs.rmSync(stageDir, { recursive: true, force: true });
    }
    if (localFailure) {
      die(`Could not install the local build: ${messageOf(localFailure)}`, "Check the files in --bin-dir, then try again.");
    }
    success(`Using the local build in ${binDir}`);
    return "local build";
  }
  if (skipIfPresent && !version && fs.existsSync(LAUNCHER_BIN) && fs.existsSync(RUNTIME_BIN) && fs.existsSync(PTYD_BIN)) {
    success("Using the installed Coflux. To upgrade, run cofluxd update.");
    return null;
  }
  const target = rustTarget();
  let releaseVersion;
  let releaseBase;
  if (!version || version === "latest") {
    const tag = await readMirrorLatestTag();
    if (!tag) {
      die(
        `Cannot read the latest version from ${RELEASE_MIRROR_BASE}/latest.json.`,
        "Pass a version to install it from GitHub Releases: --version vX.Y.Z",
      );
    }
    releaseVersion = tag;
    releaseBase = RELEASE_MIRROR_BASE;
  } else {
    releaseVersion = version;
    // Only the tag the mirror's pointer names lives on the mirror; any other version (older, newer or a
    // prerelease), and any version asked for while the pointer is unreadable, comes from the archive.
    releaseBase = (await readMirrorLatestTag()) === releaseVersion ? RELEASE_MIRROR_BASE : RELEASE_ARCHIVE_BASE;
  }
  try {
    assertReleaseVersion(releaseVersion);
  } catch (error) {
    die(messageOf(error), "Pass a release tag such as --version v2.15.0, or --version latest.");
  }
  let releaseFloor;
  try {
    releaseFloor = currentReleaseFloor();
    const floorOrder = releaseFloor
      ? compareReleaseVersions(releaseVersion, releaseFloor)
      : 1;
    if (floorOrder < 0 || (floorOrder === 0 && releaseVersion !== releaseFloor)) {
      throw Object.assign(
        new Error(`Release ${releaseVersion} is not newer than the version this device already trusts (${releaseFloor}); refusing a downgrade or replay.`),
        { next: "Install a newer release, or run cofluxd update for the latest one." },
      );
    }
  } catch (error) {
    die(messageOf(error), error?.next || FLOOR_NEXT);
  }

  const base = `${releaseBase}/${releaseVersion}`;
  const stageDir = fs.mkdtempSync(join(BIN_DIR, ".coflux-release-install-"));
  const download = step(`Downloading Coflux ${displayVersion(releaseVersion)} (${platformLabel()})`);
  let failure;
  try {
    const manifestBytes = await fetchBounded(
      `${base}/manifest.json`,
      MAX_RELEASE_METADATA_BYTES,
      "release manifest",
    );
    let manifest;
    try {
      manifest = JSON.parse(manifestBytes.toString("utf8"));
    } catch {
      throw new Error("the release manifest is not valid JSON");
    }
    const publicKey = loadReleasePublicKey();
    const staged = [];
    for (const component of ["launcher", "runtime", ...(manifest.cli ? ["cli"] : []), ...(manifest.transport ? ["transport"] : []), ...(manifest.ptyd ? ["ptyd"] : [])]) {
      const entry = parseReleaseManifestEntry(manifest, component, releaseVersion, target);
      const artifactName = `coflux-${component}-${target}`;
      const data = await fetchBounded(
        `${base}/${artifactName}`,
        Math.min(entry.size, MAX_RELEASE_ARTIFACT_BYTES),
        artifactName,
      );
      verifyReleaseArtifact({ component, version: releaseVersion, entry, data, publicKey });
      const source = join(stageDir, component === "cli" ? "coflux" : `coflux-${component}`);
      fs.writeFileSync(source, data, { mode: 0o755 });
      fs.chmodSync(source, 0o755);
      staged.push({
        source,
        destination: component === "cli" ? CLI_BIN : component === "launcher" ? LAUNCHER_BIN : component === "transport" ? join(BIN_DIR, "coflux-transport") : component === "ptyd" ? PTYD_BIN : RUNTIME_BIN,
      });
    }
    // Every remote artifact verified against the same release root before any local transform / replacement.
    resignMacBinaries(staged.map(({ source }) => source));
    if (manifest.transport) {
      const source = join(stageDir, "TRANSPORT-NOTICES.txt");
      const notices = await fetchBounded(`${base}/coflux-transport-NOTICES-${target}.txt`, 2 * 1024 * 1024, "native transport notices");
      if (notices.length === 0) throw new Error("Native transport notices are empty");
      fs.writeFileSync(source, notices, { mode: 0o644 });
      staged.push({ source, destination: join(BIN_DIR, "TRANSPORT-NOTICES.txt") });
    }
    // The floor is committed before the binaries: a crash in between leaves at worst old binaries with
    // a higher floor. Re-running the same version is still allowed; no older valid release can slip in.
    if (!releaseFloor || compareReleaseVersions(releaseVersion, releaseFloor) > 0) {
      persistCliReleaseFloor(releaseVersion);
    }
    installNativeRelease(staged);
  } catch (error) {
    failure = error;
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true });
  }
  if (failure) {
    download.failed();
    die(
      `Could not install Coflux ${displayVersion(releaseVersion)} from ${base}: ${messageOf(failure)}`,
      "Nothing on this device was changed. Check your network, then try again.",
    );
  }
  download.done();
  success("Signature verified");
  return releaseVersion;
}

// settings.json, read by the service directly.
function applyConfig({ serverUrl, deviceName, shell }) {
  fs.mkdirSync(HOME, { recursive: true });
  fs.chmodSync(HOME, 0o700);
  const settings = { serverUrl, deviceName };
  if (shell) settings.shell = shell;
  fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
  return settings;
}

/**
 * The executor runtime recorded for the service, worked out once per command. See
 * `service-unit.mjs`: null simply means this installation does not host an executor.
 */
function executorUnitRuntime() {
  const runtime = executorRuntime();
  if (!runtime) warn("This installation cannot run the executor.", "Reinstall cofluxd to add it, or use Coflux.app on this machine.");
  return runtime;
}

/** The four service files: paths and text (`cofluxd service-files` prints them as they are). */
function serviceFiles(executor = executorRuntime()) {
  return {
    launchd: {
      launcher: { path: PLIST, text: plistXml({ launcherBin: LAUNCHER_BIN, home: HOME, logFile: LOG_FILE, executor }) },
      ptyd: { path: PTYD_PLIST, text: ptydPlistXml({ ptydBin: PTYD_BIN, home: HOME, logFile: LOG_FILE }) },
    },
    systemd: {
      launcher: { path: UNIT, text: systemdUnit({ launcherBin: LAUNCHER_BIN, home: HOME, executor }) },
      ptyd: { path: PTYD_UNIT, text: ptydSystemdUnit({ ptydBin: PTYD_BIN, home: HOME }) },
    },
  };
}

/* ------------------------------ service modes ------------------------------ */

/** sd_booted(): systemd is PID 1. A `systemctl` binary alone proves nothing in a container. */
function systemdBooted() {
  return fs.existsSync("/run/systemd/system");
}

function readServiceMode() {
  try { return fs.readFileSync(SERVICE_MODE_FILE, "utf8").trim(); } catch { return ""; }
}

function writeServiceMode() {
  fs.writeFileSync(SERVICE_MODE_FILE, "self-managed\n", { mode: 0o600 });
}

function clearServiceMode() {
  try { fs.rmSync(SERVICE_MODE_FILE, { force: true }); } catch { /* */ }
}

/** The backend this device runs under: recorded once `up` chose self-managed, never re-detected. */
function serviceMode() {
  if (IS_MAC) return "launchd";
  if (!IS_LINUX) die("Coflux runs only on macOS and Linux.", "Use a macOS or Linux machine.");
  if (readServiceMode() === "self-managed") return "self-managed";
  return systemdBooted() ? "systemd" : "self-managed";
}

/** One request to the running watcher; null when no watcher answers. */
function watchRequest(op, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const socket = net.createConnection(WATCH_SOCK);
    let text = "";
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setEncoding("utf8");
    socket.setTimeout(timeoutMs, () => finish(null));
    socket.on("error", () => finish(null));
    socket.on("connect", () => socket.write(JSON.stringify({ op }) + "\n"));
    socket.on("data", (chunk) => {
      text += chunk;
      const end = text.indexOf("\n");
      if (end < 0) return;
      try { finish(JSON.parse(text.slice(0, end))); } catch { finish(null); }
    });
    socket.on("end", () => finish(null));
  });
}

/** A launcher from before `watch` ignores its arguments and would start next to nothing. */
function launcherSupportsWatch() {
  try { return fs.readFileSync(LAUNCHER_BIN).includes(WATCH_PROTOCOL); } catch { return false; }
}

function requireWatchSupport() {
  if (!launcherSupportsWatch()) {
    die("The installed Coflux is too old to run without systemd.", "Run cofluxd update, then try again.");
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}

/** The executable name of a process, to make sure a recorded pid still is that process. */
function processName(pid) {
  try { return basename(fs.readlinkSync(`/proc/${pid}/exe`)).replace(/ \(deleted\)$/, ""); } catch { /* not Linux */ }
  const result = run("ps", ["-p", String(pid), "-o", "comm="]);
  return result.status === 0 ? basename(result.stdout.trim()) : "";
}

async function waitGone(pid, ms) {
  const deadline = Date.now() + ms;
  while (pidAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await sleep(100);
  }
  return true;
}

/**
 * No watcher answers, but a killed one may have left its children running (they live in their own
 * sessions). Stop them in the watcher's order: the launcher first, then ptyd alone.
 */
async function stopLeftovers() {
  let state;
  try { state = JSON.parse(fs.readFileSync(WATCH_STATE, "utf8")); } catch { return; }
  const launcher = Number(state?.launcherPid);
  if (pidAlive(launcher) && processName(launcher).startsWith("coflux-launcher")) {
    try { process.kill(launcher, "SIGTERM"); } catch { /* already gone */ }
    if (!(await waitGone(launcher, 10_000))) {
      try { process.kill(-launcher, "SIGKILL"); } catch { /* */ }
    }
  }
  const ptyd = Number(state?.ptydPid);
  if (pidAlive(ptyd) && processName(ptyd).startsWith("coflux-ptyd")) {
    try { process.kill(ptyd, "SIGTERM"); } catch { /* already gone */ }
    if (!(await waitGone(ptyd, 15_000))) {
      try { process.kill(ptyd, "SIGKILL"); } catch { /* */ }
    }
  }
  try { fs.rmSync(WATCH_STATE, { force: true }); } catch { /* */ }
}

/** Start the self-managed service in the background and wait until it runs. */
async function startSelfManaged(executor) {
  requireWatchSupport();
  fs.mkdirSync(HOME, { recursive: true });
  const logFd = fs.openSync(LOG_FILE, "a", 0o600);
  let exited = null;
  try {
    // A new session, no stdin, output to daemon.log: logging out of SSH must not take it down.
    const child = spawn(LAUNCHER_BIN, ["watch"], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: watcherEnv(process.env, { home: HOME, executor }),
    });
    child.once("error", (error) => { exited = { error }; });
    child.once("exit", (code, signal) => { exited = { code, signal }; });
    child.unref();
  } finally {
    fs.closeSync(logFd);
  }
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (exited) break;
    const status = await watchRequest("status", 1000);
    if (status?.ok && status.launcher?.running) return;
    await sleep(200);
  }
  if (exited?.code === WATCH_EXIT_REFUSED) {
    die("Coflux is already running on this device under another service.", "Stop it first with cofluxd down. If the Coflux app runs on this machine, quit it.");
  }
  die(exited ? "The service exited while starting." : "The service did not start in time.", "See what went wrong with cofluxd logs.");
}

/** Stop the self-managed service: the watcher if one answers, else whatever a killed one left. */
async function stopSelfManaged() {
  const reply = await watchRequest("stop", 60_000);
  if (reply) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && (await watchRequest("status", 500))) await sleep(200);
    return;
  }
  await stopLeftovers();
}

function installService(mode, start, executor) {
  const files = serviceFiles(executor);
  if (mode === "launchd") {
    fs.mkdirSync(dirname(PLIST), { recursive: true });
    fs.writeFileSync(PTYD_PLIST, files.launchd.ptyd.text);
    fs.writeFileSync(PLIST, files.launchd.launcher.text);
    if (start) {
      // ptyd first: a runtime that cannot reach it exits, and a KeepAlive retry is wasted work.
      run("launchctl", ["unload", PLIST]);
      run("launchctl", ["unload", PTYD_PLIST]);
      runChecked("launchctl", ["load", PTYD_PLIST], LAUNCHD_NEXT);
      runChecked("launchctl", ["load", PLIST], LAUNCHD_NEXT);
    }
  } else if (mode === "systemd") {
    fs.mkdirSync(dirname(UNIT), { recursive: true });
    fs.writeFileSync(PTYD_UNIT, files.systemd.ptyd.text);
    fs.writeFileSync(UNIT, files.systemd.launcher.text);
    if (start) {
      runChecked("systemctl", ["--user", "daemon-reload"], SYSTEMD_NEXT);
      runChecked("systemctl", ["--user", "enable", "--now", "coflux-ptyd.service"], SYSTEMD_NEXT);
      runChecked("systemctl", ["--user", "enable", "--now", "coflux-daemon.service"], SYSTEMD_NEXT);
    }
  }
}

/** Restart the launcher (and its runtime) only: the terminals stay in ptyd. Starts ptyd if it is not running. */
async function restartService(mode, executor) {
  if (mode === "launchd") {
    run("launchctl", ["load", PTYD_PLIST]); // already loaded is fine
    run("launchctl", ["unload", PLIST]);
    runChecked("launchctl", ["load", PLIST], LAUNCHD_NEXT);
  } else if (mode === "systemd") {
    runChecked("systemctl", ["--user", "daemon-reload"], SYSTEMD_NEXT);
    runChecked("systemctl", ["--user", "enable", "--now", "coflux-ptyd.service"], SYSTEMD_NEXT);
    runChecked("systemctl", ["--user", "restart", "coflux-daemon.service"], SYSTEMD_NEXT);
  } else {
    const reply = await watchRequest("restart", 60_000);
    if (reply?.ok) return;
    if (reply) die(`The service could not restart: ${reply.error || "unknown reason"}`, "See what went wrong with cofluxd logs.");
    await startSelfManaged(executor);
  }
}

/** Restart both, ptyd included (a ptyd update): this ends every terminal on the device. */
async function restartAllServices(mode, executor) {
  if (mode === "self-managed") {
    const status = await watchRequest("status");
    if (status?.mode === "foreground") {
      // `cofluxd run` owns its watcher; it restarts everything in place.
      const reply = await watchRequest("restart-all", 120_000);
      if (!reply?.ok) die(`The service could not restart: ${reply?.error || "no answer"}`, "See what went wrong with cofluxd logs.");
      return;
    }
    await stopSelfManaged();
    await startSelfManaged(executor);
    return;
  }
  stopService(mode);
  if (mode === "launchd") {
    runChecked("launchctl", ["load", PTYD_PLIST], LAUNCHD_NEXT);
    runChecked("launchctl", ["load", PLIST], LAUNCHD_NEXT);
  } else if (mode === "systemd") {
    runChecked("systemctl", ["--user", "start", "coflux-ptyd.service"], SYSTEMD_NEXT);
    runChecked("systemctl", ["--user", "start", "coflux-daemon.service"], SYSTEMD_NEXT);
  }
}

/**
 * Stop the launcher and ptyd together (terminals end). `strict` (down / uninstall) fails on a systemctl
 * that could not stop the units; a unit that is not loaded (exit 5) is already stopped.
 */
function stopService(mode, { strict = false } = {}) {
  if (mode === "launchd") {
    run("launchctl", ["unload", PLIST]);
    run("launchctl", ["unload", PTYD_PLIST]);
  } else if (mode === "systemd") {
    for (const unit of ["coflux-daemon.service", "coflux-ptyd.service"]) {
      const result = run("systemctl", ["--user", "stop", unit]);
      if (strict && result.status !== 0 && result.status !== 5) {
        const detail = (result.stderr || "").trim().split("\n")[0] || (result.error ? result.error.message : `exit status ${result.status}`);
        die(`systemctl --user stop ${unit} failed: ${detail}`, SYSTEMD_NEXT);
      }
    }
  }
}

/* --------------------------- authorization and join --------------------------- */

const ADD_DEVICE_NEXT = "Copy the full command from Add Device in Coflux.";

/** `✓ Device "name" connected to host`. */
function deviceConnected(deviceName, serverUrl) {
  success(`Device "${deviceName}" connected to ${serverHost(serverUrl)}`);
}

/** Minutes until a pending link expires, or null. */
function minutesLeft(pending) {
  return Number.isFinite(pending?.expiresAt) ? Math.max(1, Math.round((pending.expiresAt - Date.now()) / 60000)) : null;
}

function printAuthorizationLink(pending) {
  const mins = minutesLeft(pending);
  info("");
  info("To add this device to your account, open:");
  info("");
  info(`    ${bold(pending.url)}`);
  info("");
  info(`Waiting for authorization...${mins ? ` (expires in ${mins}m)` : ""}`);
}

// Poll pending-auth.json (the link) and credentials.json (registered). The CLI never speaks the
// protocol: it only reads files; the service renews an expired link on its own.
async function waitForAuthorization({ deviceName, serverUrl }) {
  const maxWaitMs = 11 * 60 * 1000; // only how long we wait in the foreground; the service keeps going
  const start = Date.now();
  let printedUrl = null;
  let warned = false;
  while (Date.now() - start < maxWaitMs) {
    if (fs.existsSync(CRED)) {
      deviceConnected(deviceName, serverUrl);
      return;
    }
    const pending = readPendingAuth();
    if (pending?.url && pending.url !== printedUrl) {
      printedUrl = pending.url;
      printAuthorizationLink(pending);
    }
    if (!printedUrl && !warned && Date.now() - start > 20_000) {
      warned = true;
      warn(`The device has not reached ${serverHost(serverUrl)} yet.`, "It keeps trying. Check it with cofluxd status, or see cofluxd logs.");
    }
    await sleep(1000);
  }
  // Links expire and are renewed: never point at "the link above", it may be dead by now.
  info("");
  info("Still waiting. The service keeps running and renews the link; run cofluxd status to see the current one.");
}

/**
 * `cofluxd up --key` (plan 20260924-device-join-keys): join the account with a one-time key minted in
 * Coflux's Add Device dialog. Never prints a link and never enters the 11-minute link wait.
 *
 * Order matters: stop the service before the key file exists, so a runtime still running from the
 * link era can never pick it up in a renewal and then be killed mid-answer; starting it again is the
 * restart that makes the new runtime read it. The CLI learns the result only from
 * `credentials.json` and the outcome file the runtime writes.
 */
async function joinWithKey({ mode, serverUrl, deviceName, key, executor }) {
  if (mode === "self-managed") {
    requireWatchSupport();
    await stopSelfManaged();
  } else {
    stopService(mode);
  }
  // The runtime clears pending-auth.json only at connection end, not on SIGTERM: a stale one would
  // read as "too old for keys" below.
  for (const file of [JOIN_OUTCOME, PENDING_AUTH]) { try { fs.rmSync(file, { force: true }); } catch { /* */ } }
  fs.writeFileSync(JOIN_KEY, JSON.stringify({ key }) + "\n", { mode: 0o600 });
  fs.chmodSync(JOIN_KEY, 0o600);
  await startService(mode, executor);
  const joining = step("Joining your account");
  const maxWaitMs = 2 * 60 * 1000;
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const outcome = readJoinOutcome();
    if (fs.existsSync(CRED) || outcome?.status === "joined") {
      joining.done();
      deviceConnected(deviceName, serverUrl);
      return;
    }
    if (outcome?.status === "rejected") {
      joining.failed();
      die(`The join key was rejected: ${outcome.reason || "it is invalid, expired or already used"}`, "Copy a new command from Add Device in Coflux and run it.");
    }
    if (outcome?.status === "unsupported") {
      joining.failed();
      die("This server does not support join keys yet.", "Update the server, or run cofluxd up without --key to authorize in the browser.");
    }
    if (fs.existsSync(JOIN_KEY) && fs.existsSync(PENDING_AUTH)) {
      // The service enrolled without reading the key: its binary predates join keys (up keeps existing
      // binaries). Drop the key so a later runtime never presents it behind the user's back.
      try { fs.rmSync(JOIN_KEY, { force: true }); } catch { /* */ }
      joining.failed();
      die("The installed Coflux is too old for join keys.", "Run cofluxd update, then copy a new command from Add Device in Coflux.");
    }
    await sleep(500);
  }
  joining.failed();
  die("Timed out waiting to join your account.", "The service keeps trying. Check it with cofluxd status, and see cofluxd logs for the reason.");
}

/* ------------------------------ commands ------------------------------ */

/** The backend `up` installs: launchd, systemd when it is booted, otherwise self-managed. */
async function upMode() {
  if (IS_MAC) {
    return (await watchRequest("status")) ? "self-managed" : "launchd";
  }
  if (!IS_LINUX) die("Coflux runs only on macOS and Linux.", "Use a macOS or Linux machine.");
  if (await watchRequest("status")) return "self-managed";
  if (systemdBooted()) {
    clearServiceMode();
    return "systemd";
  }
  return "self-managed";
}

/** Start (or, for a running self-managed service, restart) the service. */
async function startService(mode, executor) {
  if (mode === "self-managed") {
    writeServiceMode();
    if (await watchRequest("status")) {
      await restartService(mode, executor);
    } else {
      await startSelfManaged(executor);
    }
  } else {
    installService(mode, true, executor);
  }
  success("Service started");
  if (mode === "self-managed") {
    warn("This service does not start on boot.", "In a container, use cofluxd run as the entry point instead.");
  }
}

function validateKey(raw) {
  const key = raw.trim();
  if (!/^cf_join_[A-Za-z0-9_-]+$/.test(key)) die("Invalid join key.", ADD_DEVICE_NEXT);
  return key;
}

/** Settings for up / run: flags first, then the saved settings, then defaults. */
function resolveSettings(v) {
  const s = readSettings();
  return {
    serverUrl: currentServer(v.server || s.serverUrl || DEFAULT_SERVER),
    deviceName: v.name || s.deviceName || hostname(),
    shell: v.shell || s.shell,
  };
}

function currentServer(serverUrl) {
  return serverUrl === LEGACY_DEFAULT_SERVER ? DEFAULT_SERVER : serverUrl;
}

function noticeServer(serverUrl) {
  // A saved non-default server stays in effect; say so, so a leftover staging URL cannot connect silently.
  if (serverUrl !== DEFAULT_SERVER) warn(`Using the server ${serverUrl}`);
}

async function cmdUp(v) {
  const settings = resolveSettings(v);
  let key;
  if (v.key !== undefined) {
    key = validateKey(v.key);
    if (v["no-start"]) die("--key cannot be used with --no-start.", "The key is used once, when the service starts. Drop --no-start.");
    if (fs.existsSync(CRED)) {
      // Already registered: a key would never be presented, so change nothing at all.
      const c = readCredentialsSummary();
      success(`This device is already in your account on ${serverHost(c.serverUrl || settings.serverUrl)}. Nothing was changed.`);
      return;
    }
  }
  await ensureBinaries({ version: v.version, binDir: v["bin-dir"], skipIfPresent: true });
  applyConfig(settings);
  noticeServer(settings.serverUrl);
  const mode = await upMode();
  const executor = executorUnitRuntime();
  if (key) {
    await joinWithKey({ mode, ...settings, key, executor });
    return;
  }
  if (v["no-start"]) {
    if (mode === "self-managed") writeServiceMode();
    else installService(mode, false, executor);
    success("Installed without starting. Start it with cofluxd up.");
    return;
  }
  await startService(mode, executor);
  if (!fs.existsSync(CRED)) {
    await waitForAuthorization(settings);
  } else {
    info("");
    await cmdStatus();
  }
  if (IS_MAC && readFdaStatus() !== "granted") {
    warn("Full Disk Access is not granted. Terminals can hang on macOS permission prompts.", "Run cofluxd fda to grant it.");
  }
}

/**
 * `cofluxd run`: the self-managed service in the foreground, for containers and other supervisors.
 * Node only forwards signals and mirrors the exit code; `coflux-launcher watch --foreground` does
 * the supervising. Logs go to stdout/stderr. A rejected join key is reported and the service keeps
 * running, so a restart policy cannot loop on a spent key.
 */
async function cmdRun(v) {
  if (!IS_LINUX && !IS_MAC) die("Coflux runs only on macOS and Linux.", "Use a macOS or Linux machine.");
  if (v["no-start"]) die("--no-start does not apply to cofluxd run.", "Use cofluxd up --no-start to install without starting.");
  const settings = resolveSettings(v);
  const key = v.key !== undefined ? validateKey(v.key) : undefined;
  // Two launchers for one home would fight over launcher.sock: refuse while anything else owns it.
  const otherOwner = (await watchRequest("status"))
    || (IS_MAC && serviceRunningInfo("launchd").running)
    || (IS_LINUX && systemdBooted() && serviceRunningInfo("systemd").running);
  if (otherOwner) die("Coflux is already running on this device.", "Stop it first with cofluxd down, then run cofluxd run again.");
  await ensureBinaries({ version: v.version, binDir: v["bin-dir"], skipIfPresent: true });
  requireWatchSupport();
  applyConfig(settings);
  noticeServer(settings.serverUrl);
  if (key) {
    if (fs.existsSync(CRED)) {
      success("This device is already in your account. The join key was not used.");
    } else {
      for (const file of [JOIN_OUTCOME, PENDING_AUTH]) { try { fs.rmSync(file, { force: true }); } catch { /* */ } }
      fs.writeFileSync(JOIN_KEY, JSON.stringify({ key }) + "\n", { mode: 0o600 });
      fs.chmodSync(JOIN_KEY, 0o600);
    }
  }
  const executor = executorRuntime();
  const child = spawn(LAUNCHER_BIN, ["watch", "--foreground"], {
    stdio: ["ignore", "inherit", "inherit"],
    env: watcherEnv(process.env, { home: HOME, executor }),
  });
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(signal, () => { try { child.kill(signal); } catch { /* */ } });
  }

  // Report the authorization link, the join outcome and the first connection in the same output.
  let printedUrl = null;
  let reportedJoin = false;
  let connected = fs.existsSync(CRED);
  const monitor = setInterval(() => {
    if (!connected && fs.existsSync(CRED)) {
      connected = true;
      deviceConnected(settings.deviceName, settings.serverUrl);
      return;
    }
    if (connected) return;
    const outcome = readJoinOutcome();
    if (!reportedJoin && outcome?.status === "rejected") {
      reportedJoin = true;
      printError(`The join key was rejected: ${outcome.reason || "it is invalid, expired or already used"}`, "Copy a new command from Add Device in Coflux. The service keeps running.");
    } else if (!reportedJoin && outcome?.status === "unsupported") {
      reportedJoin = true;
      printError("This server does not support join keys yet.", "Update the server, or authorize this device with the link printed below.");
    }
    const pending = readPendingAuth();
    if (pending?.url && pending.url !== printedUrl) {
      printedUrl = pending.url;
      printAuthorizationLink(pending);
    }
  }, 1000);

  child.once("error", (error) => {
    clearInterval(monitor);
    die(`Could not start the service: ${error.message}`, "Run cofluxd update, then try again.");
  });
  child.once("exit", (code, signal) => {
    clearInterval(monitor);
    if (code === WATCH_EXIT_REFUSED) {
      printError("Coflux is already running on this device under another service.", "Stop it first with cofluxd down. If the Coflux app runs on this machine, quit it.");
    } else if (code !== 0) {
      printError("The service stopped.", "See the output above for the reason. Terminals that were open are closed.");
    }
    process.exit(code ?? (signal ? 1 : 0));
  });
}

async function cmdDown() {
  const mode = (await watchRequest("status")) ? "self-managed" : serviceMode();
  const stopping = step("Stopping the service");
  if (mode === "self-managed") await stopSelfManaged();
  else stopService(mode, { strict: true });
  stopping.done();
}

// Only the launcher, ptyd and the coflux command need this (plan 20261002-runtime-launcher-merge): the
// server updates the runtime itself. The runtime refreshed here is the fallback the launcher runs
// when its store holds nothing better.
//
// update never restarts (decided 2026-07-25): replacing files on disk does not affect running
// processes. Interruptions happen only on an explicit `cofluxd restart` (terminals stay) or
// `cofluxd restart --ptyd` (terminals end).
async function cmdUpdate(v) {
  if (!fs.existsSync(SETTINGS)) die("Coflux is not installed on this device.", "Run cofluxd up first.");
  const version = v.version || "latest";
  const before = {
    launcher: fileSha256(LAUNCHER_BIN),
    ptyd: fileSha256(PTYD_BIN),
    runtime: fileSha256(RUNTIME_BIN),
    cli: fileSha256(CLI_BIN),
  };
  const installed = await ensureBinaries({ version, binDir: v["bin-dir"] });
  const label = installed === "local build" ? "the local build" : displayVersion(installed);
  const launcherChanged = before.launcher !== fileSha256(LAUNCHER_BIN);
  const ptydChanged = before.ptyd !== fileSha256(PTYD_BIN);
  const runtimeChanged = before.runtime !== fileSha256(RUNTIME_BIN);
  const cliChanged = before.cli !== fileSha256(CLI_BIN);
  if (!launcherChanged && !ptydChanged && !runtimeChanged && !cliChanged) {
    success(`Already up to date (${label})`);
    return;
  }
  success(`Updated to ${label}`);
  if (launcherChanged) info("Run cofluxd restart to apply it. Terminals stay open.");
  if (ptydChanged) {
    warn("Part of this update takes effect only after a full restart, which closes all terminals.", "Run cofluxd restart --ptyd when that is convenient.");
  }
  if (!launcherChanged && !ptydChanged) info("No restart needed.");
}

// Apply a new launcher (or just restart the service): the terminals stay in ptyd. `--ptyd` restarts
// ptyd as well (only a ptyd update needs it), and that ends every terminal on the device.
async function cmdRestart(v) {
  if (!fs.existsSync(SETTINGS)) die("Coflux is not installed on this device.", "Run cofluxd up first.");
  const mode = (await watchRequest("status")) ? "self-managed" : serviceMode();
  const executor = executorRuntime();
  // Keep the unit files in step with the templates (the first restart after an upgrade may still find
  // units from an older layout); written only, started below.
  if (mode !== "self-managed") installService(mode, false, executor);
  if (v.ptyd) {
    warn("This closes all terminals on this device.");
    const restarting = step("Restarting the service and its terminals");
    await restartAllServices(mode, executor);
    restarting.done();
  } else {
    const restarting = step("Restarting the service");
    await restartService(mode, executor);
    restarting.done();
    info("Terminals stayed open.");
  }
}

/** Hidden: the four service files (launchd x 2, systemd x 2) as JSON on stdout. */
function cmdServiceFiles() {
  console.log(JSON.stringify(serviceFiles(), null, 2));
}

// launchd / systemd service state, shared by status and doctor. On macOS only the PID in
// `launchctl list` counts: a registered label is not a live process (a launcher killed with
// OS_REASON_CODESIGNING keeps its label; observed 2026-07-25).
function serviceRunningInfo(mode) {
  if (mode === "launchd") {
    const out = run("launchctl", ["list", "com.coflux.daemon"]);
    const registered = out.status === 0;
    const running = registered && /"PID"\s*=\s*\d+/.test(out.stdout || "");
    return { running, label: running ? "running" : registered ? "not running (see cofluxd logs)" : "stopped" };
  }
  if (mode === "systemd") {
    const active = (run("systemctl", ["--user", "is-active", "coflux-daemon.service"]).stdout || "").trim();
    const label = active === "active" ? "running"
      : active === "activating" || active === "reloading" ? "starting"
        : active === "failed" ? "failed (see cofluxd logs)"
          : "stopped";
    return { running: active === "active", label };
  }
  return { running: false, label: "stopped" };
}

/** The service state under whichever backend runs it, plus the terminal count when known. */
async function serviceState() {
  const watcher = await watchRequest("status");
  if (watcher?.ok) {
    const launcherUp = !!watcher.launcher?.running;
    const label = !launcherUp ? "starting"
      : watcher.mode === "foreground" ? "running (cofluxd run, no autostart)" : "running (self-managed, no autostart)";
    return { running: launcherUp, label, terminals: Number.isInteger(watcher.terminals) ? watcher.terminals : undefined };
  }
  const mode = serviceMode();
  if (mode === "self-managed") return { running: false, label: "stopped" };
  return serviceRunningInfo(mode);
}

const CONNECTION_LABEL = { connecting: "connecting", connected: "connected", reconnecting: "reconnecting" };

async function cmdStatus() {
  const s = readSettings();
  const { running, label, terminals } = await serviceState();
  const registered = fs.existsSync(CRED);
  let connection;
  if (registered) {
    // conn-state.json is a snapshot the runtime wrote while alive: with the service down it is stale and
    // must not read as online.
    if (running) {
      const conn = readConnState();
      const state = CONNECTION_LABEL[conn?.state];
      if (state) {
        connection = state === "connected" && Number.isFinite(conn.since) ? `connected for ${duration(Date.now() - conn.since)}` : state;
      } else {
        connection = "unknown";
      }
    } else {
      connection = "offline";
    }
  } else {
    const pending = readPendingAuth();
    if (pending?.url) {
      const mins = Number.isFinite(pending.expiresAt) ? Math.max(0, Math.round((pending.expiresAt - Date.now()) / 60000)) : null;
      connection = `waiting for authorization${mins !== null ? ` (expires in ${mins}m)` : ""}\n${pending.url}`;
    } else {
      connection = "not added to an account yet";
    }
  }
  const rows = [
    ["Device", s.deviceName || hostname()],
    ["Server", s.serverUrl ? serverHost(s.serverUrl) : "not configured"],
    ["Service", label],
    ["Connection", connection],
    ["Terminals", terminals === undefined ? undefined : `${terminals} open`],
  ];
  if (IS_MAC) {
    const fda = readFdaStatus();
    rows.push(["Disk access", fda === "granted" ? "granted" : fda === "denied" ? "not granted; run cofluxd fda" : "unknown; run cofluxd fda"]);
  }
  table(rows);
}

/* ------------------------------ doctor ------------------------------ */
// Transport-level probes only: no coflux protocol message is parsed, so the CLI stays protocol-free.
// The server WebSocket is closed right after the upgrade; the loopback probe only checks that a stored
// Origin gets a 101 and never sends a browser key or grant.
const DOCTOR_TIMEOUT_MS = 5000;

function parseServerUrl(serverUrl) {
  const u = new URL(serverUrl);
  const useTls = u.protocol === "wss:";
  if (!useTls && u.protocol !== "ws:") throw new Error(`unsupported scheme ${u.protocol}; use ws:// or wss://`);
  const port = u.port ? Number(u.port) : (useTls ? 443 : 80);
  const path = u.pathname || "/";
  return { host: u.hostname, port, path, useTls };
}

async function timed(fn) {
  const t0 = Date.now();
  try { return { ok: true, ms: Date.now() - t0, ...(await fn()) }; }
  catch (e) { return { ok: false, ms: Date.now() - t0, error: e?.message || String(e) }; }
}

function probeDns(host) {
  return timed(async () => {
    const addrs = await dns.lookup(host, { all: true });
    return { detail: addrs.map((a) => a.address).join(", ") };
  });
}

function probeTcp(host, port) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const socket = net.connect({ host, port, timeout: DOCTOR_TIMEOUT_MS });
    const done = (ok, extra) => { socket.destroy(); resolve({ ok, ms: Date.now() - t0, ...extra }); };
    socket.once("connect", () => done(true, {}));
    socket.once("timeout", () => done(false, { error: `timed out after ${DOCTOR_TIMEOUT_MS}ms` }));
    socket.once("error", (e) => done(false, { error: e.message }));
  });
}

function probeTls(host, port) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const socket = tls.connect({ host, port, servername: host, timeout: DOCTOR_TIMEOUT_MS }, () => {
      const detail = socket.authorized ? socket.getProtocol() : `${socket.getProtocol()}, certificate not verified: ${socket.authorizationError}`;
      socket.destroy();
      resolve({ ok: true, ms: Date.now() - t0, detail });
    });
    socket.once("timeout", () => { socket.destroy(); resolve({ ok: false, ms: Date.now() - t0, error: `handshake timed out after ${DOCTOR_TIMEOUT_MS}ms` }); });
    socket.once("error", (e) => resolve({ ok: false, ms: Date.now() - t0, error: e.message }));
  });
}

// One minimal HTTP/1.1 Upgrade request; only whether a 101 comes back matters. No WebSocket frames.
function probeWsUpgrade({ host, port, path, useTls, origin }) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const key = crypto.randomBytes(16).toString("base64");
    const hostHeader = host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
    const originHeader = origin ? `Origin: ${origin}\r\n` : "";
    const req = `GET ${path} HTTP/1.1\r\nHost: ${hostHeader}\r\n${originHeader}Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key}\r\n\r\n`;
    let settled = false;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      resolve({ ms: Date.now() - t0, ...r });
    };
    const onOpen = (socket) => {
      let buf = "";
      const timer = setTimeout(() => { socket.destroy(); finish({ ok: false, error: `no upgrade response after ${DOCTOR_TIMEOUT_MS}ms` }); }, DOCTOR_TIMEOUT_MS);
      socket.on("data", (chunk) => {
        buf += chunk.toString("latin1");
        if (!buf.includes("\r\n\r\n")) return;
        clearTimeout(timer);
        const statusLine = buf.split("\r\n")[0];
        socket.destroy();
        const ok = /^HTTP\/1\.\d 101\b/.test(statusLine);
        finish(ok ? { ok, detail: statusLine } : { ok, error: `expected 101 Switching Protocols, got: ${statusLine}` });
      });
      socket.once("error", (e) => { clearTimeout(timer); finish({ ok: false, error: e.message }); });
      socket.write(req);
    };
    const socket = useTls
      ? tls.connect({ host, port, servername: host, timeout: DOCTOR_TIMEOUT_MS })
      : net.connect({ host, port, timeout: DOCTOR_TIMEOUT_MS });
    socket.once(useTls ? "secureConnect" : "connect", () => onOpen(socket));
    socket.once("timeout", () => { socket.destroy(); finish({ ok: false, error: `timed out after ${DOCTOR_TIMEOUT_MS}ms` }); });
    socket.once("error", (e) => finish({ ok: false, error: e.message }));
  });
}

/** One probe row: `  ✓ Name        12ms  detail`. `soft` failures are warnings, not errors. */
function printProbe(name, r, { soft = false } = {}) {
  const mark = r.ok ? "✓" : soft ? "!" : "✗";
  const elapsed = Number.isFinite(r.ms) ? `${r.ms}ms` : "";
  const msg = r.ok ? (r.detail || "") : (r.error || "");
  info(`  ${mark} ${name.padEnd(28)} ${elapsed.padStart(6)}  ${msg}`.trimEnd());
}

async function probeServer(target) {
  const { host, port, useTls } = target;
  const dnsR = await probeDns(host);
  printProbe("DNS lookup", dnsR);
  if (!dnsR.ok) return { ok: false, reason: "DNS lookup failed.", next: "Check your network and DNS settings." };

  const tcpR = await probeTcp(host, port);
  printProbe(`TCP connection (${host}:${port})`, tcpR);
  if (!tcpR.ok) return { ok: false, reason: "DNS works, but the TCP connection failed.", next: "A firewall or proxy may block it, or the port is closed." };

  if (useTls) {
    const tlsR = await probeTls(host, port);
    printProbe("TLS handshake", tlsR);
    if (!tlsR.ok) {
      return { ok: false, reason: "TCP works, but the TLS handshake failed.", next: "A corporate proxy, a wrong system clock or the server's certificate may be the cause." };
    }
  }

  const wsR = await probeWsUpgrade(target);
  printProbe("WebSocket upgrade", wsR);
  if (!wsR.ok) {
    return { ok: false, reason: "The network works, but the WebSocket upgrade was refused.", next: "A reverse proxy may not forward the Upgrade header, or the path is wrong." };
  }
  return { ok: true };
}

async function probeLocalDirect() {
  const portResult = localGatewayPort();
  if (!portResult.ok) {
    printProbe("Local port", { ok: false, error: portResult.error }, { soft: true });
    printProbe("Local connection", { ok: false, error: "local port unknown; not checked" }, { soft: true });
    printProbe("Browser pairing", readLocalGatewaySummary(), { soft: true });
    return { ready: false };
  }

  const bind = await probeTcp("127.0.0.1", portResult.port);
  printProbe(`Local port (127.0.0.1:${portResult.port})`, bind, { soft: true });
  const grant = readLocalGatewaySummary();
  printProbe("Browser pairing", grant, { soft: true });

  let loopback;
  if (!bind.ok) {
    loopback = { ok: false, error: "local port not listening; skipped" };
  } else {
    loopback = await probeWsUpgrade({
      host: "127.0.0.1",
      port: portResult.port,
      path: "/device",
      useTls: false,
      // Without a stored Origin still send a valid one: a 403 tells "reachable but not paired" apart.
      origin: grant.origin || "http://127.0.0.1",
    });
  }
  printProbe("Local connection", loopback, { soft: true });
  return { ready: bind.ok && grant.ready && loopback.ok };
}

async function cmdDoctor() {
  const s = readSettings();
  const serverUrl = s.serverUrl || DEFAULT_SERVER;
  info(`Server  ${serverUrl}`);
  let server;
  try {
    server = await probeServer(parseServerUrl(serverUrl));
  } catch (error) {
    printProbe("Server URL", { ok: false, ms: 0, error: error.message });
    server = { ok: false, reason: "The server URL is not valid.", next: "Fix it with cofluxd up --server <url>." };
  }

  info("");
  info("Local access");
  const direct = await probeLocalDirect();

  info("");
  const { running, label } = await serviceState();
  const registered = fs.existsSync(CRED);
  // Three states, because "no snapshot" is not "not connected": an older runtime does not write one.
  let connState = "unknown";
  let connection = running ? "unknown" : "not checked; the service is not running";
  if (running) {
    const conn = readConnState();
    if (CONNECTION_LABEL[conn?.state]) {
      connection = CONNECTION_LABEL[conn.state];
      connState = conn.state === "connected" ? "connected" : "not-connected";
    }
  }
  table([
    ["Service", label],
    ["Account", registered ? "added" : "not added yet"],
    ["Connection", connection],
    ...(IS_MAC ? [["Disk access", readFdaStatus() === "granted" ? "granted" : "not granted; run cofluxd fda"]] : []),
  ]);
  info("");

  const relayReady = server.ok && running && connState === "connected";
  if (direct.ready && relayReady) {
    success("The server connection and direct local access both work.");
  } else if (!direct.ready && relayReady) {
    warn("Direct local access is degraded, but the server connection works: the device is online.", "Check the local access items above.");
  } else if (direct.ready && !server.ok) {
    warn("The server is unreachable, but direct local access works.", "Pages already open keep working; reloading them may not.");
  } else if (direct.ready) {
    warn("Direct local access works. The server is reachable, but the device has not confirmed its connection.", "Check again in a moment with cofluxd status, or see cofluxd logs.");
  } else if (server.ok) {
    warn("Direct local access is degraded, and the device has not confirmed its server connection.", "This does not mean the device is offline. See cofluxd logs.");
  } else {
    printError(`${server.reason} Direct local access is degraded too.`, server.next);
  }
}

async function cmdLogs(v) {
  const watcher = await watchRequest("status");
  if (IS_MAC || watcher || serviceMode() === "self-managed") {
    if (!fs.existsSync(LOG_FILE)) die("There is no log yet.", "Start the service with cofluxd up.");
    run("tail", v.follow ? ["-f", LOG_FILE] : ["-n", "100", LOG_FILE], { stdio: "inherit" });
  } else if (IS_LINUX) {
    run("journalctl", ["--user", "-u", "coflux-daemon.service", ...(v.follow ? ["-f"] : ["-n", "100"])], { stdio: "inherit" });
  }
}

// Full Disk Access (FDA): macOS never lets a program open the FDA prompt itself, by design. The best
// this can do is detect, open System Settings and guide. The grant goes to the launcher binary: the
// runtime and agents are its children, and TCC attributes them to the launchd job's responsible process.
async function cmdFda() {
  if (!IS_MAC) die("cofluxd fda is only for macOS.", "Linux needs no extra permission.");
  info("Grant Full Disk Access to Coflux");
  info("");
  info("macOS asks you to add the program yourself. In System Settings, open");
  info("Privacy & Security > Full Disk Access, then drag in this file and turn it on:");
  info("");
  info(`    ${bold(LAUNCHER_BIN)}`);
  info("");
  info("Opening System Settings and showing the file in Finder...");
  run("open", ["x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"]);
  run("open", ["-R", LAUNCHER_BIN]);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    await rl.question("Press Enter once it is added and turned on... ");
  } finally {
    rl.close();
  }
  // The grant only applies to processes started after it.
  await restartService("launchd", executorRuntime());
  success("Service restarted. Check the result with cofluxd status in a moment.");
}

async function cmdUninstall(v) {
  const watcher = await watchRequest("status");
  const mode = watcher ? "self-managed" : serviceMode();
  if (mode === "self-managed") await stopSelfManaged();
  else stopService(mode, { strict: true });
  for (const file of IS_MAC ? [PLIST, PTYD_PLIST] : [UNIT, PTYD_UNIT]) {
    try { fs.rmSync(file); } catch { /* */ }
  }
  if (IS_LINUX && systemdBooted()) run("systemctl", ["--user", "daemon-reload"]);
  clearServiceMode();
  if (v.purge) {
    try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* */ }
    success(`Removed Coflux and everything in ${HOME}`);
  } else {
    success("Service removed");
    info(`Binaries, settings and credentials stay in ${HOME}. Run cofluxd uninstall --purge to remove them too.`);
  }
}

const HELP = `Run this machine as a Coflux device: install, start, stop and update its service.

Usage:
  cofluxd <command> [flags]

Commands:
  up                Install and start the service, then add this device to your account
  run               Run the service in the foreground, as a container's entry point
  status            Show the device, its service and its connection
  doctor            Check the connection to the server and local access
  update            Download the latest version; restart afterwards to apply it
  restart           Restart the service; terminals stay open
  restart --ptyd    Restart everything; closes all terminals on this device
  fda               Grant Full Disk Access (macOS only)
  logs [-f]         Show the service log
  down              Stop the service; closes all terminals
  uninstall         Remove the service

With no command, cofluxd runs up on a new device and status on a configured one.

Flags for up and run:
  --server <url>        Server to connect to (default ${DEFAULT_SERVER})
  --name <name>         Device name (default: the hostname)
  --shell <path>        Shell for new terminals
  --key <key>           One-time join key from Add Device in Coflux, valid for 1 hour
  --no-start            Install without starting (up only)

Flags for up, run and update:
  --version <tag>       Version to install, such as v2.15.0, or latest. up and run keep the
                        installed version; update installs the latest.
  --bin-dir <dir>       Install from a local build instead of downloading

Other flags:
  --purge               With uninstall: also remove binaries, settings and credentials
  -f, --follow          With logs: keep printing new lines
  -h, --help            Show this help

Settings are kept in ~/.coflux/settings.json; run cofluxd up again after editing it.

On Linux without systemd, cofluxd runs the service itself. It does not start on boot; in a
container, use cofluxd run as the entry point. For sign-in and terminals, use coflux.`;

/** parseArgs errors, first sentence only (the same wording as coflux). */
function argumentError(error) {
  const first = String(error?.message ?? error).split(". ")[0];
  const missing = /^Option '(.+)' argument missing/.exec(first);
  if (missing) return `Option '${missing[1]}' needs a value`;
  const unexpected = /^Option '(.+)' does not take an argument/.exec(first);
  if (unexpected) return `Option '${unexpected[1]}' does not take a value`;
  return first;
}

let parsedArgs;
try {
  parsedArgs = parseArgs({
    allowPositionals: true,
    options: {
      server: { type: "string" }, name: { type: "string" }, shell: { type: "string" }, key: { type: "string" },
      version: { type: "string" }, "bin-dir": { type: "string" },
      "no-start": { type: "boolean", default: false }, purge: { type: "boolean", default: false },
      ptyd: { type: "boolean", default: false },
      follow: { type: "boolean", short: "f", default: false }, help: { type: "boolean", short: "h", default: false },
    },
  });
} catch (error) {
  die(argumentError(error));
}
const { values, positionals } = parsedArgs;
const cmd = positionals[0] || (fs.existsSync(SETTINGS) ? "status" : "up");
if (values.help || cmd === "help") { console.log(HELP); process.exit(0); }
const handlers = { up: cmdUp, run: cmdRun, update: cmdUpdate, restart: cmdRestart, down: cmdDown, status: cmdStatus, doctor: cmdDoctor, fda: cmdFda, logs: cmdLogs, uninstall: cmdUninstall, "service-files": cmdServiceFiles };
const handler = handlers[cmd];
if (!handler) die(`Unknown command: ${cmd}`, "Run cofluxd --help to see the commands. For sign-in and terminals, use coflux.");
await handler(values);
