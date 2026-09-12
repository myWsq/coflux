# Plan 007: Port-forwarding integration acceptance: black-box end-to-end tests and documentation

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 451f113..HEAD -- tests/src docs README.md`

## Status

- Priority: P2
- Effort: M
- Risk: LOW
- Depends on: plans/005-port-forward-daemon.md, plans/006-port-forward-server-web.md
- Category: tests
- Execution: subagent sonnet
- Planned at: `451f113`, 2026-07-10

## Requirement

Prove end-to-end port forwarding with black-box integration tests across a real Rust daemon and TS server, and document the new capability. Follow the repository’s testing philosophy: acceptance tests survive cross-language rewrites (`AGENTS.md`, `tests/src/harness.mjs`).

Required behavior (new test file, such as `tests/src/proxy.test.mjs`, exclusive port):

1. **Detection/reporting:** start an HTTP server in a task PTY, for example using `node -e`, bind to 127.0.0.1:0, and print the port. Within seconds, the client receives `ports.updated` with that port and preview URL. Stopping the task broadcasts an empty set. Ports outside the PTY process tree, such as listeners in the test process, never appear.
2. **Access control:** a cookie-free proxy request receives 302 to web authorization. Exchange WS `proxy.issueAuth` for a callback URL, request it, assert Set-Cookie and 302 to the original path, then request with the cookie and receive 200 plus the proxied response. Reject forged cookies and second-account cookies when Supabase/dual-account setup is available; otherwise use a forged token. Reject external redirects such as `https://evil.com/` in `proxy.issueAuth`.
3. **Transparent forwarding:** start a WebSocket echo server inside the PTY. A ws test client supplying Host and cookie headers must complete the upgrade and echo round trip, proving support for HMR-style traffic.
4. **Lifecycle:** killing or disconnecting the daemon fails active proxy requests and broadcasts route removal. If the daemon reconnects while the service survives, it reports the port again and the preview works; shortId may change.

Update `docs/architecture.md` with kind=4 data frames, ports/proxy messages, reverse proxying, and access control. Add `COFLUX_PROXY_HOST` to the README environment table and replace outdated SQLite descriptions, including §5 Data Model, with Postgres descriptions matching the code.

## Decisions & tradeoffs

- **Use the existing black-box harness for acceptance; add no unit-test framework.** This preserves cross-language testing. Evidence: `tests/src/harness.mjs` starts the Rust daemon by default (`AGENTS.md:47-50`).
- **Connect directly to the server port with a supplied Host header.** `Host: <shortId>.p.localhost` selects the route using plan 006’s development default. Tests require no DNS or certificates; configuring real domains would violate self-contained testing.
- **Start PTY services with a Node one-liner.** Node is already required by the test environment. Bind port 0 and parse the allocated port from PTY output to avoid conflicts with per-file exclusive ports. Evidence: `const PORT` in each `tests/src` file (`AGENTS.md:57`).
- **cookie/302 assertion uses native fetch(redirect: "manual")**: node ≥18 comes with it, no new dependencies.

## Landmines

- To run the black-box on this machine, `COFLUX_TEST_PG_URL` must point to the 54322 direct port; 5432 is the supavisor reporting tenant error (repository external fact, memory item local-test-postgres).
- Detection runs about every 2s. Use the harness’s polling/wait helpers rather than fixed sleeps.
- PTY output contains ANSI escapes, and control sequences must be tolerated when parsing port numbers (refer to the existing test parsing scrollback practices).
- Supply cookies through the ws client’s `options.headers` for echo tests. tests already depends on `ws`; if absent, adding it as a devDependency is in scope.

## Scope

In scope:
- `tests/src/**`
- `docs/architecture.md`, `README.md`
- `tests/package.json` (test dependencies only)

Out of scope:
- `apps/**`, `crates/**`, `packages/**` —  Function code; if defects are found, stop and report the defect to the orchestrator for the owning plan (005 or 006), rather than patching it in this plan.

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Full black-box suite (acceptance) | `COFLUX_TEST_PG_URL=postgres://postgres:postgres@127.0.0.1:54322/postgres pnpm -C tests test` | exit 0, all new and old use cases are green |
| Rust unit test | `cargo test -p coflux-protocol -p coflux-worker` | exit 0 |
| TS type check | `pnpm exec tsc --noEmit -p apps/server && pnpm exec tsc --noEmit -p apps/web` | exit 0 |
| Linux full set (optional) | `docker build -t coflux-test . && docker run --rm coflux-test` | exit 0 (verify /proc detection path) |

## Done criteria

- [ ] All listed commands pass.
- [ ] Requirements 1–4 each have at least one test that asserts the behavior explicitly.
- [ ] Ports of non-PTY child processes are not reported with explicit assertions (regression coverage for the security boundary).
- [ ] The document update is completed, and the sqlite obsolete expression has been revised.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md`  status is updated.

## STOP conditions

- The test exposed the functional defects of 005/006 (repair the attributed function plan, this plan does not change the function code).
- A validation command fails twice after one reasonable fix.
- The outcome requires out-of-scope files.

## Maintenance notes

The Linux /proc path cannot run on macOS; the complete Docker suite is its only automated validation surface. Future CI should include docker run. See plan 006 Maintenance notes for production prerequisites.
