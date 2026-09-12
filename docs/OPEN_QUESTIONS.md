# Open questions and decision log

This document tracks two categories: **(A) design choices made using best judgment**, open to confirmation or reversal, and **(B) product decisions that require the owner's input**, usually concerning the trust model or product form.

---

## A. Decisions made using best judgment (reversible)

| # | Decision | Rationale | Alternative |
|---|----------|-----------|-------------|
| A1 | ~~Built-in `node:sqlite` / Supabase Postgres~~ **Replaced by self-hosted Postgres in plans 059–063** (July 2026) | Own business data while retaining transactions, backups, and room to grow | — |
| A2 | PTY/VT/history/holder/sequence belong to **supervisor/sessiond** | Client, worker, and center disconnections do not affect sessions; attach returns the current snapshot | Server live mirror (removed) |
| A3 | Daemon resync with full device catalog/tombstone reconciliation | Server restarts can reattach known tasks; unknown live sessions remain orphans rather than receiving fabricated exits | sessionId alone (cannot reliably reconcile lifecycle) |
| A4 | Task states are `idle / running / exited`; `task.start` on an `exited` task **reruns** it with a new session | Simple and sufficient | Explicit restart semantics / retaining multiple runs |
| A5 | PTY and regular RPC share end-to-end **DeviceEnvelope** | Direct and relay paths share semantics; the center does not parse raw terminal data | Center-routed protobuf PTY (removed and reserved) |
| A6 | The production workbench and import/task interactions live in the Electron desktop client (`apps/desktop`) | Desktop is the only frontend and default iteration target; online web/mobile clients are frozen | `window.prompt` prototype and separately maintained web project (both removed) |
| A7 | Per-device daemon credentials and client account-session tokens | The server binds daemonId; accounts are isolated | One shared token (removed) |
| A8 | A single holder in sessiond with explicit takeover | One authority decides detach, epoch, and sequence | Server viewer/holder model (removed) |

---

## B. Decisions requiring owner input

> This section retains product and deployment decisions. Early shared-token, enrollment-key, and SQLite/Supabase candidates have been retired. Current security boundaries use per-device credentials, server-issued client-session tokens, account-ownership checks, and a single central instance.

### B1. Authentication and multitenancy — highest priority — ✅ Decided: Tailscale model

**Decision (2026-06-21)**: one user manages their own machines, with one daemon per machine logged into one account:

- **Account** is the isolation unit: one account for MVP, with room for multiple accounts in the model.
- **One-time browser authorization**: an unregistered daemon's authorization request is bound to its current WS connection and confirmed after user login.
- **Independent deviceToken per device**: issued after enrollment, persisted locally, and used to authenticate subsequent connections. This fixes impersonation issue #9 at its source: the server binds daemonId to device credentials instead of trusting a client-supplied ID.
- **User password and session token**: both `local` and `password` login modes issue expiring, revocable account-session tokens from the server.
- All resources within an account are mutually accessible, without finer ACLs; accounts are isolated from one another.
- See [auth-design.md](auth-design.md).

### B2. Workspace trust boundary — security-related — ✅ Decided: owner-controlled machines only

**Decision (2026-06-21)**: operate only on the owner's own machines. No path allowlist, sandbox, or container is required. Retain the existing behavior: the daemon checks only that the path is a directory.

### B3. What happens to running tasks when a daemon goes offline? — ✅ Decided

**Decision (2026-06-21)**: accept current behavior. If the daemon process dies completely, its PTYs are lost; recovery can restart the agent but cannot restore the same process. If only the network disconnects and processes remain alive, reconnection/resync restores access (verified). No additional PTY state persistence is needed.

### B4. Task-to-terminal cardinality — ✅ Decided

A workspace may contain multiple tasks/terminal tabs. Each task run corresponds to one live session; rerunning after exit creates a new session. This is implemented in the desktop client; online web/mobile clients remain frozen.

### B5. Agent integration (V2)

The transport works. For the next agent-integration step:

- Should starting a task automatically launch `claude`/`codex` with an initial prompt, allowing human takeover, or continue opening only a shell for manual launch?
- Should headless structured agent output be parsed for richer UI? This would introduce a hybrid PTY/structured channel.

### B6. Does the data plane need binary optimization? — ✅ Completed, then evolved to local-first (July 2026)

Terminals, holder state, input ACKs, and regular RPC use protobuf DeviceEnvelope with shared direct/relay semantics. The central relay forwards only opaque bytes. Legacy `pty.output/input/replay` and server-routed RPC have been removed, with their field numbers reserved. See [architecture.md](architecture.md).

### B7. Central-server deployment model — ✅ Decided (July 2026)

- One self-hosted instance (prod-jp), with business data in self-hosted Postgres. Authentication uses `local` or self-managed `password` mode; Supabase has been retired.
- TLS: the reverse proxy for `api.coflux.dev` terminates `wss://`. Since 2026-09-04, owo-jp-gw provides an additional ingress proxy; the center itself still binds only to loopback. See [deployment.md](deployment.md). A single instance is the agreed product model. Do not introduce Redis, leader election, or shared presence without a concrete requirement. Before moving to multiple instances, in-memory authorities such as pending authorizations, online daemons, and relay homes must become linearizable shared state; simply moving the existing Maps into a cache is insufficient.
