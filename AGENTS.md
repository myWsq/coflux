# AGENTS.md

Guidance for agents and contributors working in this repository.

## Language policy

- Write all project documentation in English, including this `AGENTS.md`, other contributor and agent instructions, READMEs, `docs/`, design documents, and implementation plans.
- Write release titles and release notes in English, both in the repository and on GitHub Releases.
- Write commit subjects and bodies in English. Preserve technical identifiers and attribution trailers.
- Write new or updated code comments in English.
- Preserve literal protocol values, commands, paths, and intentional localization or non-English test examples when documenting them.
- Conversation with the user follows their preferred language; the repository language policy does not require English conversation.

## What this project is

coflux runs a **daemon** on any node. The daemon hosts local PTYs, drives agents (Claude/Codex CLI), and connects outbound to a **central server**. The **client** (an Electron desktop app) connects to the server to reach any daemon. The model resembles Tailscale: account → device → project → workspace → task → session.

- `apps/server` (TS): account/device authentication, orchestration and routing, and Postgres persistence.
- `apps/desktop` (TS): **the only frontend and the default iteration target** (plan 106). It contains the Electron main process (`src/main`), sandboxed preload (`src/preload`), and React 19 / xterm renderer (`src/renderer`; the `@` alias points here). Desktop capabilities are exposed through the preload bridge, `window.cofluxDesktop` (types in `src/shared/desktop-bridge.ts`). The renderer assumes the bridge exists and has no browser fallback. The main process rewrites the WebSocket handshake Origin to `https://desktop.coflux.dev`; server/daemon validation remains strict. Session tokens are encrypted with safeStorage in userData; window bounds persist; main-process logs live at `~/Library/Logs/Coflux/main.log`. Desktop, CLI, and daemon components share `v*` release tags (signing, notarization, and GitHub Releases; update manifests are pushed to the `desktop-updates` branch). Admission uses the control-plane protocol version (plan 105), independently of production deployments. The live `app.coflux.dev` / `m.coflux.dev` sites are **frozen** builds from before the split (source at historical commit `ce7026b`), retained only as legacy workbenches. The server no longer generates links to them. Device authorization and port-preview access pages are served directly by `apps/server` (plan 107, `apps/server/src/auth-pages.ts`) under `COFLUX_PUBLIC_URL`. The native Swift `apps/macos` client also exists only in Git history.
- `packages/{protocol,core,client}` (TS): shared wire-protocol types, logging, and the protocol client/store. The client package has no React or Electron dependency and is the sole TS client source of truth. The `"web"` value in `ClientKind` remains part of the server contract for the frozen web client.
- `integrations/claude-plugin`: the Claude Code plugin **delivery directory** (hooks, skill, and manifest). The `myWsq/plugins` marketplace (maintained in `myWsq/plugins-builder`) publishes the entire directory pinned by commit SHA. After changes, bump `.claude-plugin/plugin.json` and update the SHA in the builder. The skill's sole source is `packages/cli/skills/coflux/SKILL.md`; synchronize it here with `node scripts/sync-claude-plugin.mjs`. CI verifies that both copies match.
- `packages/cli` and `crates/cli`: the unified CLI entry point for agents. Account login and operations across workspaces/devices use `/api/client/*`. The desktop-bundled CLI can reuse the app account through the local broker. MCP and its dedicated OAuth entry points have been removed.
- `crates/{protocol,supervisor,worker}` (Rust): the **Rust daemon core, with no Node runtime**.
  - `supervisor`: owns PTYs (portable-pty), scrollback, and backpressure; serves UDS; starts, manages, and restarts the worker; switches versions and rolls back during the observation period. Upgraded rarely.
  - `worker` (tokio): server WS connection, authentication and reconnection, git/exec/fs, and two-level resync. Upgraded frequently; hot upgrades replace the worker and its paired transport helper, leaving PTYs alive in the supervisor.
  - See [docs/architecture.md](docs/architecture.md), [docs/hot-upgrade-design.md](docs/hot-upgrade-design.md), and [docs/ROADMAP.md](docs/ROADMAP.md).
  - Before changing desktop UI, read [docs/design-guidelines.md](docs/design-guidelines.md), including the requirement to use the Tooltip component instead of native `title` tooltips.

- `transport/tailcat` (Go): the pinned Tailcat/Tailscale networking helper, built as `coflux-transport` with Go 1.27.1 and `CGO_ENABLED=0`. It is included with the worker in release artifacts, CLI installation, and Desktop bundles; end users need no Go toolchain. It owns no PTYs or business authority and communicates with its Rust worker or Electron-main owner through private inherited stdio. Tailcat is the default supported remote transport; configure self-hosted stock DERP regions on the server. The custom relay/WebRTC implementation is retired. CONTROL_PROTOCOL_VERSION is 2 while DEVICE_PROTOCOL_VERSION remains 1; obsolete remote peers require an upgrade. Swift/iOS retains loopback provider support and explicitly reports remote connections unavailable. See [docs/tailcat-transport.md](docs/tailcat-transport.md).

`cofluxd` is the headless device-host entry point, responsible only for installation, connectivity, and daemon lifecycle. `coflux` provides account and local/remote business operations. The npm `cofluxd` package ships both entry points. Desktop bundles the Rust `coflux` binary and adds it to terminal PATH. Neither entry point forwards legacy commands.

## Common commands

```sh
pnpm install                       # TS dependencies
pnpm -C tests test                 # Black-box core (~1 min): wire contract, signing/trust chain, hot-upgrade rollback
cargo test -p coflux-protocol      # Rust unit tests: frame codec and serde wire format
pnpm build:daemon                 # Build release daemon binaries and paired native helper
node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit   # Server type checking
pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test && pnpm -C apps/desktop build   # Desktop types, tests, and build
pnpm -C apps/desktop dev / pack                     # Develop against local port 8787 / package an unsigned .app for smoke testing
pnpm dev:pg                                         # Dedicated local Postgres: compose, 127.0.0.1:5432
pnpm dev:server / dev:desktop / dev:daemon          # Start each component; pnpm dev runs server and desktop concurrently
node packages/cli/cofluxd.mjs up --server ... --bin-dir target/release   # Install/start the daemon; users run npm i -g cofluxd && cofluxd up
git tag v1.2.3 && git push origin v1.2.3            # Release: cross-compile, sign worker, publish GitHub Release; see docs/RELEASING.md
```

### Local development pitfalls

- **Local Postgres**: `pnpm dev:pg` starts a dedicated instance (`compose.yaml`, `127.0.0.1:5432`). Both `pnpm dev:server` and black-box tests default to `postgres://postgres:postgres@127.0.0.1:5432/postgres`; setting `DATABASE_URL` / `COFLUX_TEST_PG_URL` is unnecessary. Do not use leftover local Supabase containers (54322 / pooled port 5432).
- **Desktop dev opens but never connects: port 8787 is not running.** The `pnpm dev:desktop` main process gives the renderer `ws://localhost:8787/client` directly, without the Vite proxy; renderer HMR uses 5274. The page loads without the dev server, but WS cannot connect. Check that `curl localhost:8787/health` returns 200. Dev userData uses `Coflux-dev`, separate from the installed app's tokens and window position.

CI/releases: `.github/workflows/ci.yml` gates pushes and PRs; `release.yml` publishes desktop and daemon components together for `v*` tags, then publishes npm packages at the same version; `desktop-release.yml` is called only by the unified workflow and handles signed, notarized desktop builds. Worker artifacts use ed25519 signatures verified by the supervisor. Key configuration is documented in [docs/RELEASING.md](docs/RELEASING.md).

For production infrastructure (three machines, domain routing, deployment and rollback commands, and known pitfalls), see [docs/deployment.md](docs/deployment.md). **Read it before touching production.** Domains under coflux.dev mix proxied and DNS-only Cloudflare records, and Caddy on two machines also serves other projects.

Prerequisites: Node 22+ (server and test tooling), pnpm, and Rust stable (`rustup`). Building the bundled transport helper also requires Go 1.27.1.

## Change discipline

- **Protocol changes**: update both `crates/protocol` (Rust source of truth used by the daemon) and `packages/protocol` (TS, used by server/web). Keep wire formats identical: internally tagged `type`, camelCase, and binary data-plane frames. Black-box tests detect behavioral drift.
- **Before committing**: the relevant `tsc --noEmit` and a zero-warning `cargo build`. Run `pnpm -C tests test` (about a minute) when you touched the wire protocol, release signing, or the hot-upgrade path — the three things it still covers. Everything else is accepted by hand.
- End commit messages with a `Co-Authored-By: Claude ...` trailer.

## Test harness

**This is a single-maintainer project and acceptance is manual.** On 2026-09-13 the black-box suite was cut from 59 files to the three areas where a silent break would not show up while using the product; CI was cut to match. Everything else — UI, terminals, workspaces, agent integration, transport — is accepted by using it.

What is still automated, and why:

| kept | why it cannot be caught by hand |
| --- | --- |
| `contract.test.mjs` | the exec/fs wire contract between the Rust daemon and the TS server: drift is silent until something misbehaves much later |
| `signed-upgrade.test.mjs`, `release-sign.test.mjs`, `cli-release-trust.test.mjs` | ed25519 artifact verification and the npm trust chain: the negative cases (tampered artifact, wrong signature, cross-target, anti-rollback) cannot be exercised by using the product |
| `worker-upgrade.test.mjs` | hot-upgrade probation and rollback, including the pseudo-healthy cases that must never commit: a broken rollback bricks a remote daemon |

Plus the cheap compile-level gates that stay in CI: protocol lint/breaking/generated-artifact consistency, `tsc --noEmit`, desktop typecheck/build, Rust unit tests and a zero-warning build.

**Do not grow this back by habit.** A new test belongs here only if a break would stay invisible while using the product. If you would notice it the first time you open the app, do not write a test for it. The deleted files remain in Git history (before `chore: trim the test suite and CI to a single-maintainer workflow`) if a specific one is ever wanted back.

The retained files are **deliberately black-box**: they drive real processes over the WebSocket wire protocol and never import application internals, which is why the same suite survived the TS-to-Rust daemon rewrite unchanged.

### Structure and philosophy

- Location: `tests/src/` (`harness.mjs`, `device-harness.mjs`, `derp-harness.mjs`, `tailcat-harness.mjs`, and five `*.test.mjs` files). `node --test` runs **files** concurrently (four by default; `COFLUX_TEST_CONCURRENCY=1` enables serial troubleshooting; CI uses two). Tests within each file run sequentially; the whole suite is about a minute. Run one file with `node --import tsx --test tests/src/<x>.test.mjs`. Each file owns an exclusive port — check the existing ones with `grep -h "PORT = " tests/src/*.test.mjs | sort`. Ports are hardcoded, so **two suites cannot run on one machine at the same time**: a second run steals the ports and fails as a timeout that looks like a code bug.
- **Black-box**: tests drive **real processes through the WebSocket wire protocol**, never application internals, so they survive refactoring and language rewrites. The PTY frame codec in `harness.mjs` is **intentionally inline pure JS**, importing no application code, to remain independent of the system under test.
- `startStack()` launches an independent **TS server (tsx) and Rust supervisor daemon**, which spawns the Rust worker. It waits for the daemon to come online before returning control handles. `Client` is a test WS client with `waitFor`; `mkRepo()` creates temporary Git repositories.
- Default daemon binaries: `target/debug/coflux-{supervisor,worker}` (built by `pretest`). Override them with `COFLUX_SUPERVISOR_BIN` / `COFLUX_WORKER_BIN`.

### Isolation: keep the local environment clean

Each stack supplies its own isolation and cleans up afterward, **without touching the real environment**:

- **Temporary HOME**: `COFLUX_HOME` points to an `mkdtemp` directory. Device credentials, `worker.pid`, downloads, and other files stay there, never in the real `~/.coflux`.
- **Temporary database and ports**: each stack creates a dedicated temporary database in local test Postgres, forcibly disconnects clients, and drops it on shutdown. Each test file also owns an exclusive port (`const PORT` near the top of each `*.test.mjs`); choose an unused port for new tests.
- **Spawn binaries directly; never run the installer**: the harness starts the supervisor directly and **never runs `cofluxd` or installs services**. It writes no system directories, registers no systemd/launchd jobs, and leaves real services untouched.
- **Process-group cleanup**: the daemon starts with `detached` in its own process group. `stop()` uses `kill(-pid)` to terminate the entire group (supervisor, worker, and PTY children), then deletes temporary directories.
- Debugging: `COFLUX_TEST_DEBUG=1` forwards server/daemon stdio to the terminal.

### Signature and remote-download acceptance tests

Implemented in `tests/src/signed-upgrade.test.mjs`. For hot upgrades involving remote downloads and ed25519 verification, **negative cases are first-class**: tampered artifacts (signature or SHA-256 mismatch) must be rejected while the supervisor retains the current version. Local isolation works as follows:

- **Network**: tests start a temporary HTTP server on `127.0.0.1` (Node `http`, random port) to serve artifacts. `worker.upgrade.url` points to it. No external network is used.
- **Keys**: each test generates a temporary ed25519 key pair with Node `crypto`, held in memory/temporary storage. The supervisor receives the public key **through an environment variable**, `COFLUX_WORKER_PUBKEY`, overriding the production placeholder key baked into the binary.
  - *Why environment injection does not weaken artifact validation*: signing separates permission to publish worker binaries from the download source and central server. A remote party cannot set the local environment; the test override represents a local administrator choosing a different trust root. This does not turn a compromised central server into an attacker without RCE: the center can already orchestrate existing exec/session capabilities.
  - Cross-language interoperability: ed25519 and SHA-256 are standards. Node `crypto` (raw 32-byte public key and 64-byte signature) interoperates with Rust `ed25519-dalek` / `sha2`.
- **Filesystem/services**: downloads stay under temporary `COFLUX_HOME/workers/`. No launcher runs, so the system remains untouched.

## Docker: stronger isolation and reproducibility

Temporary-directory isolation is sufficient for everyday work. For **no host interaction from the test stack** or a **reproducible environment** (CI/acceptance), run the entire stack—server, Rust daemon, tests, and temporary artifact HTTP server—inside a container:

```sh
docker build -t coflux-test .                 # Build test image: Node 22, Rust, pnpm, and source
docker run --rm coflux-test                    # Default CMD: pnpm -C tests test; full suite inside the container
docker run --rm coflux-test cargo test -p coflux-protocol   # Other commands also work
```

The container's loopback network, temporary directories, and processes are isolated from the host filesystem, network, and processes. Source is copied into the image rather than bind-mounted, so the host checkout receives no writes to `target/` or `node_modules/`. Rebuild after changing source; toolchain and dependency layers are cached.
