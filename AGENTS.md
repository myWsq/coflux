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
- `integrations/claude-plugin`: the Claude Code plugin **delivery directory** (hooks, skills, and manifest). The `myWsq/plugins` marketplace (maintained in `myWsq/plugins-builder`) publishes the entire directory pinned by commit SHA. After changes, bump `.claude-plugin/plugin.json` and update the SHA in the builder. The skills' sole source is the `packages/cli/skills/` tree (`coflux`, `coflux-secret`); mirror it here with `node scripts/sync-claude-plugin.mjs`. CI verifies that the plugin's `skills/` tree matches it file for file. The `coflux` skill is a short `SKILL.md` plus `references/<topic>.md` files linked one level deep; the binary embeds each of them (`SKILL_REFERENCES` in `crates/cli/src/integration.rs`) so they are installed under `agent-integrations/<hash>/skills/`, and a unit test pins that list to the links in `SKILL.md` — adding a reference file means adding a row there and to `apps/desktop/test/config.test.ts`.
- `packages/cli` and `crates/cli`: the unified CLI entry point for agents. Account login and operations across workspaces/devices use `/api/client/*`. The desktop-bundled CLI can reuse the app account through the local broker. MCP and its dedicated OAuth entry points have been removed.
- `crates/{protocol,ptyd,launcher,runtime}` (Rust): the **Rust daemon core, with no Node runtime** (plan 20261002-runtime-launcher-merge).
  - `ptyd`: owns every PTY (openpty, read loop into a per-session ring, input, resize, waitpid) behind a v1 UDS protocol with a capability handshake. Near-zero change rate; a change to it is the one update that ends terminals.
  - `launcher`: a small, rarely changing process that owns the runtime version pointer and the remote release floor, spawns the runtime, decides probation/commit from its own checks (nonce echo, ptyd's session list, gateway connect), rolls back a crash-looping or pseudo-healthy candidate, falls back to the builtin runtime and serves `runtime.sock` / `runtime.lock`. Started by the desktop app or the `cofluxd`-generated service; nothing else changes versions.
  - `runtime` (tokio): sessiond (VT/history/holder/sequence authority, PTY environment, shell integration), the server WS connection, authentication and reconnection, git/exec/fs, local gateway, native channels, executor host, and release download/verification. The unit that gets updated: the centre pushes every release into launcher daemons; a swap rebuilds sessiond from ptyd with a brief pause.
  - See [docs/architecture.md](docs/architecture.md), [docs/hot-upgrade-design.md](docs/hot-upgrade-design.md), and [docs/ROADMAP.md](docs/ROADMAP.md).
  - Before changing desktop UI, read [docs/design-guidelines.md](docs/design-guidelines.md), including the requirement to use the Tooltip component instead of native `title` tooltips.

- `transport/tailcat` (Go): the pinned Tailcat/Tailscale networking helper, built as `coflux-transport` with Go 1.27.1 and `CGO_ENABLED=0`. It is included with the runtime in release artifacts, CLI installation, and Desktop bundles; end users need no Go toolchain. It owns no PTYs or business authority and communicates with its Rust runtime or Electron-main owner through private inherited stdio. Tailcat is the default supported remote transport; configure self-hosted stock DERP regions on the server. The custom relay/WebRTC implementation is retired. CONTROL_PROTOCOL_VERSION is 2 while DEVICE_PROTOCOL_VERSION remains 1; obsolete remote peers require an upgrade. Swift/iOS keeps its loopback provider boundary and additionally reaches remote devices through the same client protocol: `cmd/coflux-transport-ios` builds `internal/backend` with `CGO_ENABLED=1` as an iOS c-archive (`node scripts/build-ios-transport.mjs`, artifact gitignored, not covered by CI). See [docs/tailcat-transport.md](docs/tailcat-transport.md).

`cofluxd` is the headless device-host entry point, responsible only for installation, connectivity, and daemon lifecycle. `coflux` provides account and local/remote business operations. The npm `cofluxd` package ships both entry points. Desktop bundles the Rust `coflux` binary and adds it to terminal PATH. Neither entry point forwards legacy commands.

## iOS app (`apps/ios`): designed for iPhone Duo only

`apps/ios` is a native Swift app for the maintainer's own use, and the maintainer's only iPhone is an iPhone Duo. Design, build, and accept every iOS change for iPhone Duo. Other iPhones get basic compatibility only: layouts must not break there, but nothing is designed, polished, or checked for them, and no code path exists only for them.

- **Three forms, each a first-class layout.** Design and accept all three; none is a scaled copy of another.
  - *Outer display, closed* (466×678 pt, compact width): the system draws the status bar, toolbar, and tab bar as a vertical rail on the trailing edge, with the camera at the top trailing corner. App content owns the full height to the left of the rail.
  - *Inner display, open wide* (about 890×626 pt, regular × regular, the natural open orientation): the fold runs vertically through the middle. Use a split layout; the sidebar keeps horizontal bars and the detail column gets the vertical rail. In the half-open book pose the sidebar takes the leading half.
  - *Inner display, open tall* (about 626×890 pt): bars are horizontal at the top and the fold runs horizontally. Half-open, this is the laptop pose: terminal above the fold, input below it.
- **System containers and toolbars only.** Use `NavigationStack`, `NavigationSplitView`, `TabView`, and `.toolbar` items that carry both an icon and a title. Only system bars move to the vertical rail; hand-drawn headers, floating buttons, or title capsules do not, so do not build them. Group items with semantic placements, and use `visibilityPriority` and the overflow menu when space runs out.
- **Lay out from the container, not the device.** Derive layout from the container's size and size classes, never from `UIScreen` bounds, the interface idiom, the orientation, or fixed iPhone dimensions.
- **Respect reserved regions.** Read the fold and camera regions with `reservedRegions` and keep content and controls out of them; use `ArrangementView` for pose-dependent layouts.
- **The terminal changes size.** Moving between displays or poses changes the terminal's rows and columns, so resize the PTY with the existing debounce. The fixed-size "slide the terminal up" model holds only within one display.
- **Dark only**, with colours from the desktop tokens (`apps/ios/Coflux/Views/Theme.swift`).
- **Tooling**: target iOS 27.1, the iPhone Duo minimum (the project still declares 26.0 until the redesign raises it), and build with Xcode 27 or newer (older Xcode versions do not extend content under the status bar and camera). Check layouts in the iPhone Duo simulator, which needs the iOS 27.1 simulator runtime, and accept them on the device. Reference: [Preparing your app for iPhone Duo](https://developer.apple.com/documentation/technologyoverviews/preparing-your-app-for-iphone-duo).

## Common commands

```sh
pnpm install                       # TS dependencies
pnpm -C tests test                 # Black-box core (~1 min): wire contract, signing/trust chain, hot-upgrade rollback
cargo test -p coflux-protocol      # Rust unit tests: frame codec and serde wire format
pnpm build:daemon                 # Build release daemon binaries and paired native helper
node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit   # Server type checking
pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test && pnpm -C apps/desktop build   # Desktop types, tests, and build
pnpm dev:desktop:prod                               # Desktop against production: the default for human acceptance; one preview per worktree, see the desktop-preview skill
pnpm -C apps/desktop dev / pack                     # Develop against local port 8787 / package an unsigned .app for smoke testing
pnpm dev:pg                                         # Dedicated local Postgres: compose, 127.0.0.1:5432
pnpm dev:server / dev:desktop / dev:daemon          # Start each component; pnpm dev runs server and desktop concurrently
node packages/cli/cofluxd.mjs up --server ... --bin-dir target/release   # Install/start the daemon; users run npm i -g cofluxd && cofluxd up
git tag v1.2.3 && git push origin v1.2.3            # Release: cross-compile, sign every component, publish GitHub Release; see docs/RELEASING.md
```

### Local development pitfalls

- **Local Postgres**: `pnpm dev:pg` starts a dedicated instance (`compose.yaml`, `127.0.0.1:5432`). Both `pnpm dev:server` and black-box tests default to `postgres://postgres:postgres@127.0.0.1:5432/postgres`; setting `DATABASE_URL` / `COFLUX_TEST_PG_URL` is unnecessary. Do not use leftover local Supabase containers (54322 / pooled port 5432).
- **Desktop dev opens but never connects: port 8787 is not running.** The `pnpm dev:desktop` main process gives the renderer `ws://localhost:8787/client` directly, without the Vite proxy. The page loads without the dev server, but WS cannot connect. Check that `curl localhost:8787/health` returns 200.
- **Running the desktop dev client is the [desktop-preview skill](.agents/skills/desktop-preview/SKILL.md).** It is the single source of truth for starting a preview, running several branch previews side by side (one per worktree, each with its own profile, HMR port and instance label), identifying and stopping them, and what must never be touched — the installed app's runtime, port 8788, a daemon staged into a dev build.
- **Do not start the local stack merely to look at the desktop app.** For human acceptance of a UI change, run `pnpm dev:desktop:prod`: the real account already has the workspaces and live terminals the reviewer needs, and no server, daemon or enrollment is involved. The local stack is for protocol work and for states production cannot produce. [docs/desktop-acceptance.md](docs/desktop-acceptance.md) is the acceptance handover: which setup, what it cannot reach, and what to tell the reviewer.

CI/releases: `.github/workflows/ci.yml` gates pushes and PRs; `release.yml` publishes desktop and daemon components together for `v*` tags, then publishes npm packages at the same version; `desktop-release.yml` is called only by the unified workflow and handles signed, notarized desktop builds. Runtime artifacts use ed25519 release statements verified by the runtime before it asks the launcher to switch. Key configuration is documented in [docs/RELEASING.md](docs/RELEASING.md).

For production infrastructure (three machines, domain routing, deployment and rollback commands, and known pitfalls), see [docs/deployment.md](docs/deployment.md). **Read it before touching production.** Domains under coflux.dev mix proxied and DNS-only Cloudflare records, and Caddy on two machines also serves other projects.

Prerequisites: Node 22+ (server and test tooling), pnpm, Rust stable (`rustup`), and Zig 0.17.x (the runtime's VT engine, libghostty-vt, is compiled from Ghostty's source during the cargo build, which also needs `git` and network on first build). Building the bundled transport helper also requires Go 1.27.1.

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
| `worker-upgrade.test.mjs` | the launcher's probation and rollback, including the pseudo-healthy cases that must never commit (silent, wrong nonce, sessions not taken over, gateway not listening): a broken rollback bricks a remote daemon |

Plus the cheap compile-level gates that stay in CI: protocol lint/breaking/generated-artifact consistency, `tsc --noEmit`, desktop typecheck/build, Rust unit tests and a zero-warning build.

**Do not grow this back by habit.** A new test belongs here only if a break would stay invisible while using the product. If you would notice it the first time you open the app, do not write a test for it. The deleted files remain in Git history (before `chore: trim the test suite and CI to a single-maintainer workflow`) if a specific one is ever wanted back.

The retained files are **deliberately black-box**: they drive real processes over the WebSocket wire protocol and never import application internals, which is why the same suite survived the TS-to-Rust daemon rewrite unchanged.

### Structure and philosophy

- Location: `tests/src/` (`harness.mjs`, `device-harness.mjs`, `derp-harness.mjs`, `tailcat-harness.mjs`, and five `*.test.mjs` files). `node --test` runs **files** concurrently (four by default; `COFLUX_TEST_CONCURRENCY=1` enables serial troubleshooting; CI uses two). Tests within each file run sequentially; the whole suite is about a minute. Run one file with `node --import tsx --test tests/src/<x>.test.mjs`. Each file owns an exclusive port — check the existing ones with `grep -h "PORT = " tests/src/*.test.mjs | sort`. Ports are hardcoded, so **two suites cannot run on one machine at the same time**: a second run steals the ports and fails as a timeout that looks like a code bug.
- **Black-box**: tests drive **real processes through the WebSocket wire protocol**, never application internals, so they survive refactoring and language rewrites. The PTY frame codec in `harness.mjs` is **intentionally inline pure JS**, importing no application code, to remain independent of the system under test.
- `startStack()` launches an independent **TS server (tsx), Rust ptyd and Rust launcher**, which spawns the Rust runtime. It waits for the daemon to come online before returning control handles. `Client` is a test WS client with `waitFor`; `mkRepo()` creates temporary Git repositories.
- Default daemon binaries: `target/debug/coflux-{ptyd,launcher,runtime}` (built by `pretest`). Override them with `COFLUX_PTYD_BIN` / `COFLUX_LAUNCHER_BIN` / `COFLUX_RUNTIME_BIN`.

### Isolation: keep the local environment clean

Each stack supplies its own isolation and cleans up afterward, **without touching the real environment**:

- **Temporary HOME**: `COFLUX_HOME` points to an `mkdtemp` directory. Device credentials, `runtime.pid`, downloads, and other files stay there, never in the real `~/.coflux`.
- **Temporary database and ports**: each stack creates a dedicated temporary database in local test Postgres, forcibly disconnects clients, and drops it on shutdown. Each test file also owns an exclusive port (`const PORT` near the top of each `*.test.mjs`); choose an unused port for new tests.
- **Spawn binaries directly; never run the installer**: the harness starts ptyd and the launcher directly and **never runs `cofluxd` or installs services**. It writes no system directories, registers no systemd/launchd jobs, and leaves real services untouched.
- **Process-group cleanup**: the daemon starts with `detached` in its own process group. `stop()` uses `kill(-pid)` to terminate the launcher's group (launcher and runtime) and ptyd's group (ptyd and PTY children), then deletes temporary directories.
- Debugging: `COFLUX_TEST_DEBUG=1` forwards server/daemon stdio to the terminal.

### Signature and remote-download acceptance tests

Implemented in `tests/src/signed-upgrade.test.mjs`. For hot upgrades involving remote downloads and ed25519 verification, **negative cases are first-class**: tampered artifacts (statement signature or SHA-256 mismatch, a worker-domain statement over identical metadata) must be rejected while the launcher retains the current version. Local isolation works as follows:

- **Network**: tests start a temporary HTTP server on `127.0.0.1` (Node `http`, random port) to serve artifacts. `worker.upgrade.url` points to it. No external network is used.
- **Keys**: each test generates a temporary ed25519 key pair with Node `crypto`, held in memory/temporary storage. The runtime receives the public key **through an environment variable**, `COFLUX_WORKER_PUBKEY`, overriding the production placeholder key baked into the binary.
  - *Why environment injection does not weaken artifact validation*: signing separates permission to publish runtime binaries from the download source and central server. A remote party cannot set the local environment; the test override represents a local administrator choosing a different trust root. This does not turn a compromised central server into an attacker without RCE: the center can already orchestrate existing exec/session capabilities.
  - Cross-language interoperability: ed25519 and SHA-256 are standards. Node `crypto` (raw 32-byte public key and 64-byte signature) interoperates with Rust `ed25519-dalek` / `sha2`.
- **Filesystem/services**: downloads stay under temporary `COFLUX_HOME/runtimes/`. No service manager is involved, so the system remains untouched.

## Docker: stronger isolation and reproducibility

Temporary-directory isolation is sufficient for everyday work. For **no host interaction from the test stack** or a **reproducible environment** (CI/acceptance), run the entire stack—server, Rust daemon, tests, and temporary artifact HTTP server—inside a container:

```sh
docker build -t coflux-test .                 # Build test image: Node 22, Rust, pnpm, and source
docker run --rm coflux-test                    # Default CMD: pnpm -C tests test; full suite inside the container
docker run --rm coflux-test cargo test -p coflux-protocol   # Other commands also work
```

The container's loopback network, temporary directories, and processes are isolated from the host filesystem, network, and processes. Source is copied into the image rather than bind-mounted, so the host checkout receives no writes to `target/` or `node_modules/`. Rebuild after changing source; toolchain and dependency layers are cached.
