#!/usr/bin/env node
// TestFlight distribution for a build that release.sh already uploaded: wait for App Store
// Connect to finish processing, write What to Test, hand the build to the beta groups, and
// submit it for beta review when an external group is involved. Every step is idempotent, so
// rerunning it after a failure is safe.
//
// Credentials: the ES256 private key lives in ~/.appstoreconnect/private_keys/AuthKey_<kid>.p8
// (the same key release.sh documents). The issuer id is not a secret the key carries, so it is
// read from ASC_ISSUER_ID or ~/.appstoreconnect/issuer_id. Both are per-machine, never in Git.
import { sign as cryptoSign, createPrivateKey } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const API = "https://api.appstoreconnect.apple.com";
const BUNDLE_ID = "dev.coflux.Coflux";
const PRIVATE_KEYS_DIR = path.join(homedir(), ".appstoreconnect", "private_keys");
const ISSUER_FILE = path.join(homedir(), ".appstoreconnect", "issuer_id");
// App Store Connect takes 10-30 minutes to process a build; give it an hour before giving up.
const PROCESSING_TIMEOUT_MS = 60 * 60 * 1000;
const POLL_INTERVAL_MS = 60 * 1000;
const WHATS_NEW_LIMIT = 4000;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { build: null, whatsNew: null, groups: null, submitReview: true, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inline] = argv[i].split(/=(.*)/s);
    const value = () => (inline !== undefined ? inline : argv[++i]);
    if (flag === "--build") args.build = value();
    else if (flag === "--whats-new") args.whatsNew = value();
    else if (flag === "--whats-new-file") args.whatsNew = readFileSync(value(), "utf8");
    else if (flag === "--groups") args.groups = value().split(",").map(name => name.trim()).filter(Boolean);
    else if (flag === "--no-review") args.submitReview = false;
    else if (flag === "--dry-run") args.dryRun = true;
    else fail(`unknown argument: ${flag}`);
  }
  return args;
}

function loadCredentials() {
  const issuerId = process.env.ASC_ISSUER_ID?.trim() || (existsSync(ISSUER_FILE) ? readFileSync(ISSUER_FILE, "utf8").trim() : "");
  if (!issuerId) {
    fail(
      `App Store Connect issuer id missing.\n` +
        `Copy it from App Store Connect > Users and Access > Integrations > App Store Connect API\n` +
        `(the "Issuer ID" above the key table, a UUID), then either:\n` +
        `  echo <issuer-id> > ${ISSUER_FILE}\n` +
        `or export ASC_ISSUER_ID before running this script.`,
    );
  }
  let keyId = process.env.ASC_KEY_ID?.trim() || "";
  if (!keyId) {
    const keys = existsSync(PRIVATE_KEYS_DIR)
      ? readdirSync(PRIVATE_KEYS_DIR).filter(name => /^AuthKey_.+\.p8$/.test(name))
      : [];
    if (keys.length !== 1) {
      fail(
        keys.length === 0
          ? `no AuthKey_*.p8 found in ${PRIVATE_KEYS_DIR}`
          : `several keys in ${PRIVATE_KEYS_DIR}; set ASC_KEY_ID to pick one: ${keys.join(", ")}`,
      );
    }
    keyId = keys[0].replace(/^AuthKey_|\.p8$/g, "");
  }
  const keyPath = path.join(PRIVATE_KEYS_DIR, `AuthKey_${keyId}.p8`);
  if (!existsSync(keyPath)) fail(`private key not found: ${keyPath}`);
  return { issuerId, keyId, privateKey: createPrivateKey(readFileSync(keyPath, "utf8")) };
}

const b64url = input => Buffer.from(input).toString("base64url");

function mintToken({ issuerId, keyId, privateKey }) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const header = { alg: "ES256", kid: keyId, typ: "JWT" };
  // 20 minutes is the maximum App Store Connect accepts; a long poll re-mints instead.
  const payload = { iss: issuerId, iat: issuedAt, exp: issuedAt + 19 * 60, aud: "appstoreconnect-v1" };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  // JWS wants the raw r||s pair, not the DER sequence Node signs by default.
  const signature = cryptoSign("sha256", Buffer.from(signingInput), { key: privateKey, dsaEncoding: "ieee-p1363" });
  return `${signingInput}.${signature.toString("base64url")}`;
}

class Asc {
  constructor(credentials) {
    this.credentials = credentials;
    this.token = null;
    this.tokenMintedAt = 0;
  }

  authorization() {
    // Re-mint well inside the 20-minute ceiling so a slow poll never sends an expired token.
    if (!this.token || Date.now() - this.tokenMintedAt > 15 * 60 * 1000) {
      this.token = mintToken(this.credentials);
      this.tokenMintedAt = Date.now();
    }
    return `Bearer ${this.token}`;
  }

  async request(method, endpoint, body) {
    const response = await fetch(endpoint.startsWith("http") ? endpoint : `${API}${endpoint}`, {
      method,
      headers: {
        authorization: this.authorization(),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : null;
    if (!response.ok) {
      const detail = payload?.errors?.map(error => `${error.title}: ${error.detail}`).join("; ") ?? text;
      const error = new Error(`${method} ${endpoint} -> ${response.status} ${detail}`);
      error.status = response.status;
      error.errors = payload?.errors ?? [];
      throw error;
    }
    return payload;
  }

  get = (endpoint) => this.request("GET", endpoint);
  post = (endpoint, body) => this.request("POST", endpoint, body);
  patch = (endpoint, body) => this.request("PATCH", endpoint, body);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function resolveApp(asc) {
  const apps = await asc.get(`/v1/apps?filter[bundleId]=${encodeURIComponent(BUNDLE_ID)}&limit=1`);
  const app = apps.data[0];
  if (!app) fail(`no app with bundle id ${BUNDLE_ID} is visible to this API key`);
  return app;
}

// The build shows up minutes after the upload and only becomes distributable at VALID.
async function awaitProcessedBuild(asc, appId, buildNumber) {
  const deadline = Date.now() + PROCESSING_TIMEOUT_MS;
  let lastState = null;
  for (;;) {
    const query = `/v1/builds?filter[app]=${appId}&filter[version]=${encodeURIComponent(buildNumber)}&limit=1`;
    const build = (await asc.get(query)).data[0];
    const state = build?.attributes?.processingState ?? "NOT_UPLOADED_YET";
    if (state !== lastState) {
      console.log(`    build ${buildNumber}: ${state}`);
      lastState = state;
    }
    if (state === "VALID") return build;
    if (state === "FAILED" || state === "INVALID") fail(`build ${buildNumber} finished processing as ${state}`);
    if (Date.now() > deadline) fail(`build ${buildNumber} still ${state} after ${PROCESSING_TIMEOUT_MS / 60000} minutes`);
    await sleep(POLL_INTERVAL_MS);
  }
}

// Default release notes: every commit touching the iOS app or its Swift client since the
// previously uploaded build went up. The upload timestamp comes from App Store Connect, so this
// needs no bookkeeping of its own.
function defaultWhatsNew(sinceIso) {
  const args = ["log", "--format=%s", "--no-merges"];
  if (sinceIso) args.push(`--since=${sinceIso}`);
  else args.push("-20");
  args.push("--", "apps/ios", "packages/swift-client", "scripts/build-ios-transport.mjs");
  const subjects = execFileSync("git", args, { encoding: "utf8", cwd: path.resolve(import.meta.dirname, "../..") })
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean);
  if (subjects.length === 0) return "Maintenance build: no iOS-facing changes since the previous build.";
  return subjects.map(subject => `- ${subject}`).join("\n").slice(0, WHATS_NEW_LIMIT);
}

async function previousUploadDate(asc, appId, currentBuildId) {
  const builds = await asc.get(`/v1/builds?filter[app]=${appId}&sort=-uploadedDate&limit=5`);
  const previous = builds.data.find(build => build.id !== currentBuildId && build.attributes?.uploadedDate);
  return previous?.attributes?.uploadedDate ?? null;
}

async function writeWhatsNew(asc, buildId, whatsNew, dryRun) {
  const existing = await asc.get(`/v1/builds/${buildId}/betaBuildLocalizations?limit=50`);
  if (dryRun) {
    const current = existing.data.map(l => `${l.attributes.locale}: ${JSON.stringify(l.attributes.whatsNew)}`);
    console.log(`    what to test (current): ${current.join(" | ") || "(no localization yet)"}`);
    console.log(`    what to test (would write): ${JSON.stringify(whatsNew)}`);
    return;
  }
  if (existing.data.length === 0) {
    await asc.post("/v1/betaBuildLocalizations", {
      data: {
        type: "betaBuildLocalizations",
        attributes: { locale: "en-US", whatsNew },
        relationships: { build: { data: { type: "builds", id: buildId } } },
      },
    });
    console.log("    what to test: created en-US");
    return;
  }
  for (const localization of existing.data) {
    await asc.patch(`/v1/betaBuildLocalizations/${localization.id}`, {
      data: { type: "betaBuildLocalizations", id: localization.id, attributes: { whatsNew } },
    });
  }
  console.log(`    what to test: updated ${existing.data.map(l => l.attributes.locale).join(", ")}`);
}

async function resolveGroups(asc, appId, wanted) {
  const groups = (await asc.get(`/v1/betaGroups?filter[app]=${appId}&limit=200`)).data;
  if (!wanted) return groups;
  const byName = new Map(groups.map(group => [group.attributes.name, group]));
  const missing = wanted.filter(name => !byName.has(name));
  if (missing.length > 0) {
    fail(`beta group(s) not found: ${missing.join(", ")}\navailable: ${groups.map(g => g.attributes.name).join(", ") || "(none)"}`);
  }
  return wanted.map(name => byName.get(name));
}

// Internal groups see every build the moment it finishes processing and App Store Connect
// rejects assigning one explicitly ("Cannot add internal group to a build"), so only external
// groups are ever linked here.
async function addToGroups(asc, buildId, groups, dryRun) {
  const internal = groups.filter(group => group.attributes.isInternalGroup);
  const external = groups.filter(group => !group.attributes.isInternalGroup);
  for (const group of internal) console.log(`    beta group ${group.attributes.name} [internal]: automatic, nothing to do`);
  if (external.length === 0) {
    console.log("    beta groups: no external group to link");
    return;
  }
  for (const group of external) {
    // A build's betaGroups relationship refuses GET_RELATED, so ask the builds collection
    // whether this group already carries the build.
    const linked = await asc.get(`/v1/builds?filter[id]=${buildId}&filter[betaGroups]=${group.id}&limit=1`);
    if (linked.data.length > 0) {
      console.log(`    beta group ${group.attributes.name} [external]: already linked`);
      continue;
    }
    if (dryRun) {
      console.log(`    beta group ${group.attributes.name} [external]: would add`);
      continue;
    }
    await asc.post(`/v1/builds/${buildId}/relationships/betaGroups`, {
      data: [{ type: "betaGroups", id: group.id }],
    });
    console.log(`    beta group ${group.attributes.name} [external]: added`);
  }
}

// External testers only receive a build after Apple approves it; internal groups never need this.
async function submitForBetaReview(asc, buildId, groups, dryRun) {
  if (!groups.some(group => !group.attributes.isInternalGroup)) {
    console.log("    beta review: not needed, every group is internal");
    return;
  }
  // Ask first: a build already in review answers a second submission with 422
  // INVALID_QC_STATE (seen 2026-11-10), not only with the 409 handled below.
  const submission = await asc.get(`/v1/builds/${buildId}/betaAppReviewSubmission`).catch(() => null);
  const state = submission?.data?.attributes?.betaReviewState;
  if (state) {
    console.log(`    beta review: already ${state}`);
    return;
  }
  if (dryRun) {
    console.log("    beta review: would submit (an external group is in the list)");
    return;
  }
  try {
    await asc.post("/v1/betaAppReviewSubmissions", {
      data: {
        type: "betaAppReviewSubmissions",
        relationships: { build: { data: { type: "builds", id: buildId } } },
      },
    });
    console.log("    beta review: submitted");
  } catch (error) {
    // A build already waiting in review, or already approved, answers with a conflict.
    if (error.status === 409) {
      console.log("    beta review: already submitted");
      return;
    }
    throw error;
  }
}

const args = parseArgs(process.argv.slice(2));
if (!args.build) fail("usage: testflight-distribute.mjs --build <build-number> [--whats-new <text>] [--groups A,B] [--no-review] [--dry-run]");

const asc = new Asc(loadCredentials());
const app = await resolveApp(asc);
console.log(`==> app ${app.attributes.name} (${app.id})`);

console.log(`==> wait for App Store Connect to process build ${args.build}`);
const build = await awaitProcessedBuild(asc, app.id, args.build);

const whatsNew = (args.whatsNew ?? defaultWhatsNew(await previousUploadDate(asc, app.id, build.id))).trim().slice(0, WHATS_NEW_LIMIT);
await writeWhatsNew(asc, build.id, whatsNew, args.dryRun);

const groups = await resolveGroups(asc, app.id, args.groups);
// Review first: App Store Connect answers linking a build that was never submitted for beta
// review to an external group with a misleading 404 "no resource of type 'builds'" (2026-11-10).
if (args.submitReview) await submitForBetaReview(asc, build.id, groups, args.dryRun);
await addToGroups(asc, build.id, groups, args.dryRun);

console.log(args.dryRun ? `==> dry run only, nothing was changed` : `==> build ${args.build} is live on TestFlight`);
