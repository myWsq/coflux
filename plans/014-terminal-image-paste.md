# Plan 014: Web terminal clipboard image - upload the image to the remote worktree and inject the path to the agent

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 6bd4caf..HEAD -- proto/ apps/server/src/hub.ts apps/server/src/config.ts crates/worker/src/ apps/web/src/`

## Status

- Priority: P2
- Effort: M
- Risk: MED
- Depends on: none
- Category: feature
- Execution: subagent sonnet
- Planned at: `6bd4caf`, 2026-07-19

## Requirement

The web terminal connects to Claude Code / Codex CLI on a remote daemon. Local-terminal ⌘V image paste relies on the CLI reading the local OS clipboard, which cannot work remotely: the browser and CLI run on different machines. Enable browser image paste by relaying image bytes to the task worktree’s `.coflux/pastes/` directory, then injecting the saved path as PTY text. Claude Code / Codex recognizes the image path in the prompt and reads the file.

Correctness criteria:

- Preserve native xterm **text** paste; intercept only image/* clipboard items.
- Write image bytes unchanged when within the limit; compress only oversized images.
- Upload/inject only with `active && controlState === "owned" && sessionId`, the same gate as typed input (`terminal-pane.tsx:136-138`). Without ownership, do neither and show an in-terminal notice.
- Report upload failures/timeouts through `TerminalController.writeSystem` (`terminal-pane.tsx:127`).
- Anchor remote writes to the worktree root and prevent path escape, matching fsRead security.

## Decisions & tradeoffs

- **Storage location (revised 2026-07-19 with informed user override): use the remote system temporary directory**, `std::env::temp_dir()/coflux-pastes/`, resolved through the API rather than hard-coded `/tmp`. Add a protocol `temp` flag. In temp mode, accept only a single filename segment and return an absolute path. The initial worktree `.coflux/pastes/` plus `*` .gitignore implementation was rejected by the user. The revised tradeoff accepts possible permission prompts for reads outside cwd in exchange for leaving the repository untouched. Retain the root-anchored fs.write primitive unchanged for compatibility. Evidence: fs relay root is always `ws.path` (`apps/server/src/hub.ts:888-899`).
- **Compress oversized images in the browser; do not raise server limits.** The web budget is 3.5MB, leaving envelope space below the 4MB maxPayload. If exceeded, re-encode via canvas: keep resolution while decreasing JPEG quality from 0.9 in steps, then halve dimensions repeatedly if still too large. Reducing quality before resolution best preserves screenshot text. Send in-budget images byte-for-byte. The user rejected both a 16MB limit and simply rejecting oversized images. Evidence: `COFLUX_MAX_PAYLOAD` defaults to 4MB (`apps/server/src/config.ts:81`). The executor may tune the ladder while preserving quality-before-resolution ordering.
- **Add `ClientFsWrite` (client.proto) → `FsWrite` (daemon.proto), with `FsWriteResult` replies.** Follow fsRead routing: client fields `request_id/workspace_id/path/data(bytes)`; server `workspaceForClient` ownership checks; `pendingRelays` correlation; rewritten `request_id`; daemon root `ws.path`. Rejected: base64 through `ClientExec`, because ExecRun has no stdin and platform argv limits cannot accommodate megabyte images. Evidence: the three relay templates in `apps/server/src/hub.ts:853-899` and `proto/coflux/v1/daemon.proto:206-216`.
- **After upload, call `terminal.paste(" <path with surrounding spaces> ")`.** xterm selects bracketed-paste framing according to remote ESC[200~/201~ mode and sends through `onData` → existing `sendInput`, preserving active/owned gating. Hand-assembling ESC sequences in `sendInput` would bypass that gate and require independently tracking mode 2004. Evidence: `terminal-pane.tsx:136-138`, `store.ts:111-112`.
- **Add `pendingFsWrites` using the existing request map pattern.** Follow `pendingFsLists`/`pendingExecs`, including rejecting and clearing requests on disconnection (`apps/web/src/client/store.ts:66-100,346-356`).
- **Clean opportunistically:** each worker write to the pastes directory removes files with mtime older than seven days. A resident timer is unjustified for infrequent cleanup.
- **Name files `paste-<epoch milliseconds>-<short random>.<MIME-derived suffix: png/jpg/gif/webp>`.** The original path convention has the web generate `.coflux/pastes/<name>`. Do not intercept non-image/* paste.

## Direction

Data flow: capture paste on the xterm textarea → find image/* → read Blob → canvas-compress if over budget → `clientFsWrite` → server ownership check/relay → worker write/reply → web `fsWriteResult` → `terminal.paste(" <absolute or relative path> ")` → PTY.

The original direction uses a saved worktree-relative path such as `.coflux/pastes/paste-xxx.png`, with the agent’s cwd at the worktree root. The worker returns the final path; the web must not invent it independently.

### Milestone 1: Protocol message pair and generation

Add ClientFsWrite, FsWrite, and FsWriteResult to both proto files, including replies in daemon→server and server→client envelopes. Run `cd proto && buf generate`; TS/Rust generated code compiles without manual edits. Validation: `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` and `cargo build -p coflux-worker` → exit 0 with zero warnings.

### Milestone 2: Worker writes and server relay

The worker handles FsWrite, creates `.coflux/pastes/` and its `*` .gitignore, writes bytes, cleans files older than seven days, prevents traversal, and reports errors. Add the hub.ts `clientFsWrite` branch with ownership/online checks, pendingRelays, and timeout handling. Validation: `pnpm -C tests test` passes, including byte-for-byte upload verification, rejection of `..` escape, and rejection of another account’s workspace.

### Milestone 3: Browser interception, compression, and injection

Intercept image paste in terminal-pane without affecting text paste. Add store `sendFsWrite` and its pending map, canvas compression, successful `terminal.paste`, and failure `writeSystem`. Without ownership, show a notice and do not upload. Validation: `node_modules/.bin/tsc -b apps/web/tsconfig.json` → exit 0.

## Landmines

- **`safe_resolve` returns None for nonexistent targets** because it canonicalizes the target itself (`crates/worker/src/ops.rs:63-74`). New files require resolving/creating the **parent directory** first: canonicalize the existing worktree root, append segments, and verify containment. Reject `/` and `..` in the filename segment.
- **Add replies to both oneof envelopes:** `DaemonToServer.payload` and `ServerToClient.payload` have different next available tags (`daemon.proto:80-103`, `client.proto:259-283`). Follow fsReadResult; omitting either hop leaves a reply the server cannot forward.
- **AGENTS.md is stale:** it still says SQLite, but plan 002 migrated to Postgres. Local black-box tests require `COFLUX_TEST_PG_URL` at direct port **54322**; 5432 is Supavisor and reports a tenant error.
- **Test files own exclusive ports.** Choose an unused port for a new `tests/src/*.test.mjs` file, following the AGENTS.md harness section.
- **The worker has no explicit WS message-size override:** `connect_async` at `crates/worker/src/main.rs:413` uses tungstenite’s 64MiB default, which already accepts 4MB messages. Do not raise it without need.

## Scope

In scope:
- `proto/coflux/v1/client.proto`, `proto/coflux/v1/daemon.proto` and buf-generated artifacts (`packages/protocol/src/gen/`, `crates/protocol/src/gen/`, `proto/gen/swift/`)
- `apps/server/src/hub.ts` (new case; if constant is required, `apps/server/src/config.ts`)
- `crates/worker/src/main.rs`, `crates/worker/src/ops.rs`
- `apps/web/src/client/store.ts`, `apps/web/src/components/workbench/terminal-pane.tsx`, `apps/web/src/components/workbench/workspace-terminal.tsx` (pass workspaceId and other wiring)

- `tests/src/` (new black-box test case)

Out of scope:
- Drag and drop file upload, general file (non-image) upload - the same pipeline can be reused later, but this plan does not do it.

- `COFLUX_MAX_PAYLOAD` default value adjustment - the user has rejected the limit increase.

- `crates/supervisor`, `packages/cli` — the data plane is not modified by them.

- Server-side persistence - pictures are not entered into the DB and no metadata is retained.

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| server type check | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| web type checking | `node_modules/.bin/tsc -b apps/web/tsconfig.json` | exit 0 |
| daemon build | `cargo build -p coflux-supervisor -p coflux-worker` | exit 0, zero warnings |
| Rust unit test | `cargo test -p coflux-protocol` | exit 0 |
| Black-box integration | `COFLUX_TEST_PG_URL=postgres://postgres:postgres@127.0.0.1:54322/postgres pnpm -C tests test` | exit 0 |
| proto generation | `cd proto && buf generate` (requires network to pull remote plug-in) | generated-code diff only new information |
| Manual image paste (acceptance) | After the dev three ends are connected, the web terminal ⌘V image paste, the agent receives the path readable image | Manual confirmation |

## Done criteria

- [ ] All listed commands pass.
- [ ] web terminal ⌘V picture: Place `.coflux/pastes/` as it is within the limit, and inject PTY into the path; the text pasting behavior remains unchanged.

- [ ] Over-budget images are uploaded successfully after being compressed within the limit (you can manually verify the large image or test the compression function in a unit test).

- [ ] Out-of-bounds paths/non-owned workspace/daemon offline/non-owned. The four types of failed paths have clear errors and no silence.

- [ ] Black-box testing covers upload consistency and out-of-bounds rejection, and the assertions are meaningful.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.
- `buf generate` cannot be run (network/plug-in is unreachable) and the product cannot be reproduced using the existing methods of the repository.

## Maintenance notes

- Image paste uses remote `temp_dir()/coflux-pastes/` after the 2026-07-19 revision, so the agent reads an absolute path outside cwd. If CLI permission prompts become frequent friction, guide users to allow rules or consider the worktree fallback. The root-anchored write primitive remains; fallback changes only the web entry and temp flag.
- General file upload and drag/drop can reuse FsWrite with a new web entry point.
- The 3.5MB compression budget is coupled to server `COFLUX_MAX_PAYLOAD` default 4MB. Keep them synchronized if maxPayload changes.
