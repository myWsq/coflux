# Plan 20261030-sessiond-libghostty-vt: sessiond keeps full-fidelity terminal state on libghostty-vt

> Three parts for three readers. The Record says why and stays true after the
> code moves on. The Execution brief is the only part a delegated executor
> receives. Verification is the orchestrator's. At close, `dev:execute-plan`
> appends an Outcome and updates `wiki/plans/README.md`.
>
> Drift check: `git diff --stat 32d8ede1..HEAD -- crates/runtime/src/sessiond.rs crates/runtime/src/sessions.rs crates/runtime/src/agent_ctl.rs crates/runtime/src/main.rs crates/runtime/Cargo.toml Cargo.toml Cargo.lock vendor/vt100 .gitattributes proto/coflux/v1/device.proto Cross.toml Dockerfile .github/workflows AGENTS.md docs/RELEASING.md apps/desktop/src/renderer/components/workbench/terminal-pane.tsx`

## Status

- Priority: P2
- Effort: L
- Risk: HIGH (replaces the VT engine behind every live terminal's reattach snapshot and checkpoint; adds a Zig-built native library to every runtime build)
- Depends on: none
- Category: refactor
- Execution: subagent(opus) — departure check in `dev:explore`
- Stop after: implementation — departure check (plan audit)
- Plan review: audit — ran 2026-10-30 (fable); ten findings folded in, none rejected
- Workspace: isolated — planned from the main worktree, moved to `.claude/worktrees/20261030-sessiond-libghostty-vt` on `dev/20261030-sessiond-libghostty-vt`
- Planned at: `32d8ede1`, 2026-10-30

## Record

### Requirement

sessiond (inside `coflux-runtime`) keeps the authoritative screen and history of every terminal and turns it into the canonical ANSI snapshot that a reattaching client replays, that the runtime writes into ptyd checkpoints to survive a runtime swap, that the center stores as a terminal checkpoint, and that `coflux terminal read` returns. Today that state lives in a vendored `vt100` 0.16.2, which models only part of what programs draw:

- Cell style is bold, dim, italic, underline and inverse only (`vendor/vt100/src/attrs.rs:17-22`). Strikethrough, underline styles and colours, blink, invisible and OSC 8 hyperlinks vanish on reattach.
- Restorable modes are application cursor/keypad, bracketed paste and mouse (`Screen::input_mode_formatted`). Scroll regions, Kitty keyboard flags, modifyOtherKeys, tab stops and other program-set state are lost, so a TUI that negotiated them behaves differently after a reattach until it redraws or renegotiates.
- History costs 32 bytes per cell (`crates/runtime/src/sessiond.rs:11-17`): with the default 5,000 logical lines (`crates/runtime/src/main.rs:90`) and the 4× physical-row allowance, a full 120-column session holds about 77 MB.
- vt100 cannot reflow, so sessiond reimplements resize by re-rendering and replaying a snapshot (`sessiond.rs:712-760`, `1946-1984`), and it renders snapshots by hand (`sessiond.rs:1986-2085`).

When this is done, sessiond's terminal model is libghostty-vt (Ghostty's terminal core, Rust bindings `libghostty-vt` from `uzaaft/libghostty-rs`): a reattach reproduces full style, links, scroll region and program-set modes; history memory for the same limit is no higher than today's; vt100, its vendored copy and the hand-written render/reflow code are gone. Everything outside sessiond — the wire protocol, the checkpoint blob, the desktop/iOS/server consumers — is unchanged.

Not part of this: grapheme clustering. The desktop renderer is xterm.js with Unicode 11 per-code-point widths (`apps/desktop/src/renderer/components/workbench/terminal-pane.tsx:365`) and iOS renders with SwiftTerm (`apps/ios/Coflux/Views/TerminalHostView.swift:3`). A daemon that clustered emoji sequences into one cell would place the cursor differently from every client, so sessiond keeps per-code-point widths and clustering waits until a client renderer changes.

An adjacent wrong solution: upgrading vt100 to 0.18 (released 2026-10-18/19). It fixes oddly-sized-terminal bugs and adds a scroll-off callback but adds neither the missing attributes, the missing modes, reflow, nor a compact cell.

### Decisions & tradeoffs

- **D1 Goal is snapshot fidelity plus memory; widths stay per code point.** Done means: full SGR (including strikethrough, underline style and colour), OSC 8 links, scroll region and program-set modes including Kitty keyboard flags survive snapshot → replay; history memory at the same logical-line limit is at or below vt100's; per-code-point widths match the clients' at least as well as vt100 does, with one accepted exception — Ghostty counts each regional indicator as 2 cells where xterm.js and vt100 count 1, so a flag in a reattached snapshot shifts the rest of its line by two columns until the program redraws (live output is unaffected; accepted by the user at the gate, see D8); DEC mode 2027 (grapheme clustering) never takes effect in sessiond, even when a program sets it. Rejected: clustering graphemes in sessiond and both clients at once — a much larger cross-client change with live/snapshot parity risk. Rejected: an engine swap that keeps today's snapshot content — pays the migration without the benefit. Based on: Discussion log Q1; `terminal-pane.tsx:365`; `TerminalHostView.swift:3`; `vendor/vt100/src/attrs.rs:17-22`.
- **D2 The wire and checkpoint contracts do not change.** The snapshot remains an ANSI byte stream consumed as today by xterm.js, SwiftTerm, the server's checkpoint store (`apps/server/src/store.ts:1345`) and `coflux terminal read` (`crates/runtime/src/agent_ctl.rs:370-392`). The checkpoint blob layout, its header fields and `CHECKPOINT_FORMAT_VERSION` (`sessiond.rs:840-939`) stay as they are, and a checkpoint taken while the alternate screen is active still carries the primary-screen snapshot in `normal_before_alt`, because a vt100 runtime restoring it after a launcher rollback falls back to a blank primary without it (`sessiond.rs:694-700`). The snapshot emits only sequences those clients interpret and that describe the program's state — full SGR, OSC 8, cursor position, visibility and shape (the formatter emits no DECSCUSR, so the shape is appended from the terminal's cursor state), scroll region, non-default modes, modifyOtherKeys and Kitty keyboard state, tab stops, charsets; soft-wrapped rows are emitted as one unwrapped logical line so clients reflow them, and trailing styled cells are kept. It never emits state that overrides a client's own configuration (OSC 4 palette, default foreground/background/cursor colours, OSC 7 working directory). Rejected: a structured snapshot or new checkpoint version — needs protocol, client and server changes for no gain the ANSI form cannot carry. Based on: `sessiond.rs:840-939`, `694-700`, `1992-1994` (today's renderer keeps wrapped rows joined); consumers listed above; `libghostty_vt::fmt::FormatterOptions` (`with_unwrap`, `with_trim`, `with_keyboard`, `with_tabstops`, …). `(revised on plan audit)`
- **D3 Each session's libghostty terminal is owned by one dedicated thread.** `TerminalState` stays `Send` and keeps its public API; internally it holds a handle to a thread that alone constructs and owns the libghostty objects, and requests reach that thread in submission order so a snapshot or checkpoint reflects exactly the output sequence at which it was requested. Feeding output never waits for an answer from that thread; it may block only when the thread's backlog of unprocessed output exceeds a fixed byte bound, which is the same backpressure today's synchronous parse applies to the PTY reader. Rejected: `unsafe impl Send` around the libghostty terminal inside the existing `Arc<Mutex<Session>>` — the bindings declare every type `!Send + !Sync` because the C API may use thread-local state. Rejected: one VT thread shared by all sessions — one large snapshot or replay would stall every other session's output. Rejected: an unbounded backlog — a flood of output would grow memory without limit. Based on: `crates/runtime/src/sessions.rs:802` (`type SessionHandle = Arc<Mutex<Session>>`), reached from the output path (`sessions.rs:1514`), device attach (`2287`, `2370`), the checkpoint loop (`1678`) and recovery (`1778-1864`); `libghostty_vt` crate docs ("All types are `!Send + !Sync`"). `(revised on plan audit)`
- **D4 sessiond's own byte scanner owns every per-feed side effect; the alternate screen is handled with the terminal.** Title (OSC 0/2), secret-checked OSC 133 marks, DA1 detection, mode-2027 detection (D9) and the "between sequences" checkpoint boundary are computed by the scanner on the feeding thread, synchronously with `feed`. Where a sequence starts and ends follows libghostty's parser (CSI with at most 24 parameters and 4 intermediates, a CSI reaching the limit dropped whole; a colon separator aborting any CSI other than SGR; OSC payload 0x20–0xFF ended by BEL or ESC `\`; CAN/SUB aborting). What counts as a DA1 query keeps today's xterm.js semantics — no intermediates, final `c`, every parameter zero — even though libghostty itself treats any `CSI Ps c` as primary device attributes. Alternate-screen bookkeeping moves to the terminal's thread, so the scanner no longer tracks 1049/47 boundaries. Rejected: reading title and marks back from the terminal thread — every feed would wait on it (D3), and the bindings' OSC 133 callback does not expose the per-session secret parameter. Rejected: libghostty's device-attributes callback as the DA1 authority — sessiond would start answering `CSI 5 c`, which xterm.js ignores. Based on: `sessiond.rs:41-60`, `119-122`, `328-380`, `19-21`; Ghostty `src/terminal/Parser.zig` (`MAX_PARAMS = 24`, `MAX_INTERMEDIATE = 4`, colon handling), `parse_table.zig` (OSC/CAN/SUB), `stream.zig` (primary DA dispatch without a parameter check). `(revised on plan audit)`
- **D5 libghostty never answers the PTY and keeps no image payloads.** No reply produced by libghostty (device attributes, DSR, DECRQM, XTVERSION, size reports, colour-scheme reports, clipboard) is ever written to the PTY or surfaced to a client; sessiond's existing DA1 policy (answer only when no client receives the raw bytes, through the ordered input writer) remains the only writer. Kitty graphics and other APC payloads are capped to effectively zero retained bytes, because the C library parses and stores them regardless of the Rust feature set and a headless daemon has no use for them. Rejected: letting libghostty answer queries — clients already answer them from the raw stream, and checkpoint replays would answer stale queries. Based on: `sessiond.rs:27-33`, `SessionState::feed` (`sessiond.rs:1204-1245`); plan `20261023-terminal-da1-reply`; `libghostty-vt-sys` `build.rs` (no Kitty flag passed to `zig build`); `Terminal::set_apc_max_bytes`. `(revised on plan audit)`
- **D6 Hard switch, no runtime flag or second engine.** The new runtime uses libghostty only. The safety net is the launcher's probation and crash-loop rollback together with D2's mutually readable checkpoints. Rejected: keeping vt100 behind a flag — doubles the scanner semantics, tests and snapshot paths for a single maintainer, and a fallback nobody runs rots. Based on: AGENTS.md (launcher rolls back crash-looping or pseudo-healthy candidates); D2.
- **D7 The build is pinned and the same everywhere.** `libghostty-vt` is a git dependency on `https://github.com/uzaaft/libghostty-rs` at commit `9ede35b8ea94a55ed3608408d67e102883129f1e` (2026-10-24; it pins Ghostty commit `521cf2c5…` and requires Zig 0.17.x), linked statically, default features off, built for the portable baseline CPU. Zig 0.17.x is pinned in every environment that builds the runtime: CI, all four release targets (both Linux musl targets built through `cross` in Docker, both macOS targets), the desktop release build, the Docker test image and the documented prerequisites. Rejected: crates.io `libghostty-vt` 0.2.2 — it requires Zig 0.15.x (its README; its pinned Ghostty commit enforces the exact Zig minor), pins a July Ghostty snapshot, and the next published release carries breaking API changes already on `master`. Rejected: a version range — the binding is pre-1.0. Rejected: prebuilt third-party static libraries — an unaudited binary in the release trust chain. Based on: `.github/workflows/release.yml:133-167`, `.github/workflows/ci.yml:186-206`, `.github/workflows/desktop-release.yml:53`, `Dockerfile`, `Cross.toml`, `AGENTS.md:62`; `libghostty-rs` README at `v0.2.2` ("Requires Zig 0.15.x") and at `9ede35b8` (Zig 0.17.x); `libghostty-vt-sys` `build.rs` (`git clone` at a pinned commit, Zig package fetches, `-Dtarget` for cross targets, `ZIG`/`GHOSTTY_SOURCE_DIR`/`GHOSTTY_ZIG_SYSTEM_DIR`, baseline CPU default). `(revised on plan audit)`
- **D8 The first milestone is a go/no-go gate.** Before sessiond is rewired, evidence must show: the runtime links on all four release targets; a snapshot produced by libghostty's VT formatter and replayed into a fresh terminal reproduces style, links, scroll region, modes and Kitty keyboard flags; per-code-point widths for CJK, emoji, ZWJ sequences, flags, skin tones, combining marks and VS16 disagree with xterm.js (Unicode 11) on no more cases than vt100 does; the D9 mechanism keeps mode 2027 from taking effect; the primary screen and its history can be formatted while the alternate screen is active without changing either screen's state; history memory at the default limit is at or below vt100's. Any failure stops the plan with a report; nothing partial ships. Gate outcome (2026-10-31): the width check failed only on regional indicators (two of 28 cases, flags); the user accepted that difference and the plan continued. The round trip lacked only the cursor shape, now appended (D2). The primary screen cannot be formatted by toggling `?47` on the live terminal — Ghostty copies the cursor and pen between screens and closes an open OSC 8 link — so it is formatted on a snapshot clone of the terminal instead, which never touches the live one. `(revised at gate)` Rejected: committing to the full migration first — plan 114's archived native-Ghostty spike showed the cost of discovering blockers late. Based on: Discussion log; `plans/114-desktop-ghostty-overlay-spike.md` on `dev/20260911-desktop-ghostty-spike`.
- **D9 Mode 2027 is neutralised at the byte offset where it is set.** The scanner reports the offset of the final byte of every DECSET whose parameters include 2027; the terminal thread writes up to and including that byte, resets mode 2027, then continues with the rest. Bytes are never rewritten. Rejected: resetting the mode after each whole write — text later in the same chunk would already be clustered. Rejected: stripping the parameter from the stream — the program's output would no longer be what sessiond stores and replays. Based on: Ghostty `modes.zig` (2027 defaults off; only DECSET turns it on; RIS resets it); D1. `(decided on plan audit)`
- **D10 The history limit stays a count of logical lines.** libghostty's scrollback cap is a byte budget for pages (`PageList` `max_size`), not a line count, and it never goes below the active area plus two pages. So snapshots and checkpoints select the newest `history_line_limit` logical lines (and fewer when a checkpoint must fit `max_bytes`) by walking rows and their wrap-continuation flags, while the byte cap is sized to hold at least those lines at the current width without exceeding vt100's memory for the same limit. Rejected: using the byte cap as the line limit — the number of lines it keeps varies with content and width, and `history_line_limit = 0` would still yield history. Based on: Ghostty `PageList.zig` (`max_size` doc, `min_max_size`); the bindings' `max_scrollback` doc, which wrongly says lines; `sessiond.rs:1886-1937`; tests with `history_line_limit = 0` in `sessiond.rs` `mod tests`. `(decided on plan audit)`

### Discussion log

- Exploration (2026-10-29/30) first framed the win as grapheme correctness; recon then found both clients use per-code-point widths, so that framing was corrected before the question below.
- Q1 (grill) — "What should the libghostty-vt switch deliver?" Options: Fidelity + memory (recommended) / Also cluster graphemes / Groundwork only. Answer: **Fidelity + memory**. Settled D1.
- D2–D8 were decided by the orchestrator from the code and the library's documented API, following the user's standing preference that purely technical forks are not put to them.
- Departure check — Execution: **Subagent (opus)**; Autopilot: **Plan audit**.
- Plan audit (fable, 2026-10-30), ten findings, all accepted `(revised on plan audit)`:
  - crates.io 0.2.2 needs Zig 0.15.x, so "exact crate + Zig 0.17.x" was unsatisfiable → D7 pins the `master` commit `9ede35b8` by git rev (orchestrator re-checked both READMEs).
  - The formatter only formats the active screen and `set_mode` does not switch screens → D8/T3 name the toggle method; D2 keeps writing `normal_before_alt` for rollback; T7 no longer feeds `normal_before_alt` on restore (today's `restore` feeds only the snapshot, which already contains the primary).
  - Ghostty dispatches primary DA for any `CSI Ps c` → D4 keeps xterm.js DA1 semantics and lists the parser's real limits; the scanner's alt machinery is removed instead of re-derived.
  - `git grep vt100` would still hit `.gitattributes` and a `proto` comment → both added to M3's scope.
  - Kitty graphics is still compiled into the C library → D5 caps APC/image retention.
  - Formatter unwrap/trim/keyboard/tab-stop flags are load-bearing → D2 fixes them.
  - `max_scrollback` is bytes → D10.
  - Mode 2027 needs a stated mechanism → D9.
  - Build gaps: `cross` containers need Zig, `git` and network; the Docker image is multi-arch; toggling `RUSTFLAGS` rebuilds the Zig library → T2 and Verification.
  - The terminal must be constructed inside its thread, `Drop` must join, and a never-waiting feed needs a bound → D3/T4.
- Milestone 1 (executor, opus; commits `0cb950c2`, `7750b5cb`): pin and Zig in every build environment done; musl builds keep `cross` with Ghostty source and Zig packages prefetched on the runner by a real lib-vt build (`--fetch=needed` misses five lazy dependencies) and mounted into the container. Gate checks: 3 (2027 lock), 5 (memory: ~5.7–6.5 MB vs ~21.2 MB at 5,000 lines, 120 columns; ~10 bytes/cell vs 32) and 6 (newest-N lines via a row walk and a selection) pass; 1 misses only cursor shape; 4 fails with the `?47` toggle and passes on a snapshot clone; 2 fails on flags (orchestrator re-ran the width harness: 2 regressions, 26 agreements).
- Gate question — "Flags are 2 cells per regional indicator in Ghostty vs 1 in xterm.js and vt100, no override; accept, patch Ghostty's width table, or stop?" Answer: **Accept the flag width difference**. Revised D1, D2, D8 and T7 `(revised at gate)`.
- Verification of M2–M3 (commits `57ff1037`, `8a68cc03`): 336/338 runtime tests pass with zero warnings. The two resize tests expose a formatter hazard: with unwrap on, empty cells at the start of a continuation row are emitted as `ECH`/`CUF` right after a row that exactly fills the width, and on replay the pending-wrap cursor erases or overwrites that row's last cell. Sent back as REVISE. `git grep vt100` still hit a desktop comment describing the old engine's width table; scope widened to that one comment `(added at verification)`.

### Maintenance notes

- libghostty-vt is pre-1.0 and the Ghostty C API is untagged. An upgrade is a deliberate change: move the git pin (or switch to a crates.io release that requires the same Zig minor), re-run the D8 evidence, and read the binding's history for parser changes that move the scanner's sequence boundaries (D4).
- The scanner (D4) must track the parser that actually consumes the bytes. Any change to how sequences are delimited — parameter limits, intermediates, string terminators — must be mirrored, or checkpoints can land mid-sequence and OSC 133 secrets can leak into the screen on replay.
- When a client renderer starts clustering graphemes, revisit D1 and D9: sessiond's width mode must move in lockstep with every client.
- Rollback across this change relies on vt100 runtimes parsing libghostty-written snapshots. Sequences vt100 ignores degrade harmlessly; nothing in D2's emission set may be destructive to a parser that ignores it.
- The bindings' `master` already exposes an OSC 133 semantic-prompt callback; it does not carry arbitrary parameters, so it cannot replace the secret check (D4).

## Execution brief

> Written for `subagent(opus)` at `32d8ede1`. Implement the milestones in
> order. Decide only what Your call leaves to you; on anything else that is
> unclear, stop and report.

### Goal

Replace the `vt100` crate inside `crates/runtime/src/sessiond.rs` with the `libghostty-vt` Rust bindings, keeping every public API of `TerminalState` and `SessionState` and the bytes they hand out compatible. sessiond's snapshots must start carrying the full SGR set, OSC 8 links, the scroll region and program-set modes (including Kitty keyboard flags), history memory must not grow, and vt100 must disappear from the tree. The ANSI snapshot, the checkpoint blob and its version, the protocol's messages, and every client stay as they are.

The binding is used at a git commit, not a crates.io release: read its API from the source at that commit (`gh api 'repos/uzaaft/libghostty-rs/contents/<path>?ref=9ede35b8ea94a55ed3608408d67e102883129f1e'`, one plain command at a time), not from docs.rs, which documents 0.2.2.

Conventions: Rust 2024 workspace; comments in English (existing Chinese comments may stay where you don't touch them); `cargo fmt` on files you change; zero warnings under `RUSTFLAGS="-D warnings"` — use that same setting for every cargo command, because changing `RUSTFLAGS` rebuilds the Zig library. GitHub Actions are pinned by commit SHA with the version in a trailing comment, as in `.github/workflows/ci.yml`. The Bash tool runs zsh: never write `"$VAR:path"` (zsh modifiers), use `${VAR}`.

Milestones are strictly sequential (M1 → M2 → M3); do not fan them out. M1 is a gate: if any of its checks fails, stop and report with the evidence instead of continuing.

### Milestone 1: libghostty-vt builds everywhere and the gate evidence is in

Depends on: none

#### T1 · The runtime depends on an exactly pinned, statically linked libghostty-vt

- Where: `crates/runtime/Cargo.toml` — the `vt100 = "0.16.2"` dependency block; root `Cargo.toml` near `vt100 = { path = "vendor/vt100" }`.
- Change: add `libghostty-vt = { git = "https://github.com/uzaaft/libghostty-rs", rev = "9ede35b8ea94a55ed3608408d67e102883129f1e", default-features = false }` (D7). Keep vt100 for now; it is removed in M3.
- After: `RUSTFLAGS="-D warnings" cargo build -p coflux-runtime` builds and links libghostty-vt statically on this Mac (Zig at `/opt/homebrew/bin/zig`, 0.17.0). `Cargo.lock` records the git commit.
- Don't: use crates.io `0.2.2` (it needs Zig 0.15.x), a branch or tag instead of the rev, `link-dynamic`, or a `native` CPU (D7).

#### T2 · Every environment that builds the runtime has Zig 0.17.x

- Where: `.github/workflows/ci.yml` (the job containing "Rust 单元测试（protocol/launcher/runtime/cli）" and "Rust 构建"; it also serves the black-box `pretest` build); `.github/workflows/release.yml` job `build` (matrix: two `cross` musl targets, two macOS targets; step "构建"); `.github/workflows/desktop-release.yml` step "cargo build（release，aarch64-apple-darwin）"; `Cross.toml`; `Dockerfile`; `AGENTS.md` line starting `Prerequisites:`; `docs/RELEASING.md` item "**Build matrix**".
- Change: install a pinned Zig 0.17.x before any cargo step in each workflow job above, with SHA-pinned actions. Make both musl targets build inside `cross`: the container needs Zig for the container's architecture, `git` (the `-sys` build script clones Ghostty) and outbound network for Zig package fetches — through `Cross.toml` `pre-build`, a custom image, or pre-fetching the Ghostty source and Zig packages on the runner and passing `GHOSTTY_SOURCE_DIR`/`GHOSTTY_ZIG_SYSTEM_DIR` through (`[build.env] passthrough`) — or replace `cross` for those two targets with an equivalent static-musl build; either way both targets keep producing static musl binaries from the same workflow step. Add Zig to the Docker test image, choosing the Zig tarball by the image's architecture (the base image is multi-arch: arm64 under OrbStack, x86_64 in CI). Add Zig 0.17.x to the prerequisites in `AGENTS.md` and to the build-matrix description in `docs/RELEASING.md`.
- After: from this Mac, with `RUSTFLAGS="-D warnings"`: `cargo build --release --target aarch64-apple-darwin -p coflux-runtime`, `cargo build --release --target x86_64-apple-darwin -p coflux-runtime`, and `cross build --release --target x86_64-unknown-linux-musl -p coflux-runtime` / `--target aarch64-unknown-linux-musl` (Docker via OrbStack) all succeed with the same configuration the release workflow uses; `file` on each runtime binary shows the expected architecture and, for musl, static linking. Record the four results in your report.
- Don't: set `LIBGHOSTTY_VT_SYS_CPU=native` or leave any job depending on a Zig that happens to be on the runner (D7).

#### T3 · Gate evidence for D8

- Where: a throwaway harness outside the committed tree (for example under `target/` or a temporary directory); it is not committed. Use `@xterm/headless` with the Unicode 11 addon for the xterm.js comparison, installed in that temporary location only.
- Change: measure, against the pinned libghostty-vt and the current vt100:
  1. **Formatter round trip**: write output that uses strikethrough, double and curly underline with an underline colour, blink, invisible, 256-colour and truecolour fg/bg, an OSC 8 link, a DECSTBM scroll region, bracketed paste, mouse modes, application cursor/keypad, cursor visibility and shape, modifyOtherKeys (`CSI > 4 ; 2 m`), custom tab stops, a soft-wrapped long line, a line ending in styled blank cells, and Kitty keyboard flags pushed by `CSI > 1 u`; format it with the VT formatter (unwrap on, trim off; cursor, style, modes, scrolling region, hyperlink, keyboard, kitty keyboard, tab stops, charsets on; palette and pwd off); replay into a fresh terminal of the same size; compare cells, styles, wrap state, cursor, modes and flags. Expected: identical.
  2. **Width parity**: for a corpus of CJK, emoji, ZWJ families (👨‍👩‍👧), flags (🇯🇵), skin tones (👋🏽), combining marks (e + U+0301), VS16 sequences, and a wide character at the last column, compare the cell position after each string in xterm.js (Unicode 11), vt100 and libghostty with mode 2027 off. Expected: libghostty disagrees with xterm.js on no case where vt100 agrees.
  3. **Mode 2027 lock (D9)**: feed `CSI ? 2027 h` (and `CSI ? 1 ; 2027 h`) followed by the corpus in the same write, splitting the write after the DECSET's final byte and resetting mode 2027 there. Expected: widths identical to the 2027-off run.
  4. **Alternate screen**: produce primary history, enter `?1049h`, draw on the alternate screen, then on the terminal's own thread write `\x1b[?47l`, format the primary screen with modes off (the formatter emits non-default modes before content, so a `?1049h` must not appear in the primary half), and write `\x1b[?47h` to return. Expected: the primary output matches the primary as it was before `?1049h`, and formatting the alternate screen before and after the toggle gives identical bytes (cursor, contents and modes unchanged). If the toggle changes any state, find another method or stop.
  5. **Memory**: resident bytes for 5,000 logical lines of styled 120-column output, vt100 at today's capacity (`history_line_limit × 4` rows) vs libghostty with a byte cap that holds the same 5,000 logical lines. Expected: libghostty ≤ vt100.
  6. **Logical-line selection (D10)**: confirm that the scrollback cap is a byte budget, choose how the cap is derived from `history_line_limit` and the width, and show how to format exactly the newest N logical lines plus the screen (rows and their wrap-continuation flags, a selection, or equivalent), including N = 0.
- After: a report with each check's result, the numbers, and the mechanisms used for checks 3, 4 and 6. Every check passes, or you stop here and report which failed (D8).

### Milestone 2: TerminalState runs on libghostty-vt with full fidelity

Depends on: Milestone 1 (all gate checks passed)

#### T4 · A libghostty terminal owned by one thread per session behind TerminalState

- Where: `crates/runtime/src/sessiond.rs` — `pub struct TerminalState` and `impl TerminalState` (`pub fn new`, `pub fn restore`, `pub fn feed`, `pub fn snapshot`, `pub fn checkpoint`, `pub fn resize`, `pub fn set_output_seq`); a new private module under `crates/runtime/src/` is allowed for the thread and its messages.
- Change: replace the `parser: vt100::Parser<OscCapture>` field with a handle to a dedicated thread. Construct the libghostty `Terminal` (and any formatter) inside that thread — the types are `!Send`, so they cannot be built outside and moved in. `feed` sends the bytes (with the D9 offsets) and returns without waiting for an answer; the channel is bounded by bytes so a flood blocks the feeder only once the backlog exceeds the bound (D3). `snapshot(&self)`, `checkpoint(&self)`, `resize` and `restore` send a request and wait for its answer. `Drop` closes the channel and joins the thread.
- After: `TerminalState` is `Send` with the same public signatures, so `sessions.rs`, `device.rs` and `agent_ctl.rs` compile unchanged. Requests apply in submission order: a `snapshot()` called right after `feed(x)` reflects `x`. Dropping a `TerminalState` ends its thread (no leaked threads across the unit tests).
- Don't: `unsafe impl Send`/`Sync` for libghostty types, share one VT thread across sessions, or use an unbounded channel (D3).

#### T5 · The scanner owns title, marks, DA1, mode 2027 and the checkpoint boundary

- Where: `crates/runtime/src/sessiond.rs` — `struct DecModeScanner` / `impl DecModeScanner`, `enum AltEvent`, `const VTE_CSI_PARAM_LIMIT`, `struct OscCapture` and `impl vt100::Callbacks for OscCapture`, `fn clamp_title`, `TerminalState::feed`.
- Change:
  - Move title (OSC 0/2) and secret-checked OSC 133 capture into the scanner, with a bounded payload buffer, keeping today's semantics: the title is clamped by `clamp_title` to `MAX_TITLE_BYTES`, a repeated identical title is not a change, a mark without the session secret (`coflux=<secret>` after the first two parameters) is dropped, and an empty secret accepts no marks.
  - Make the scanner's sequence boundaries follow libghostty's parser (D4): at most 24 CSI parameters and 4 intermediates, a CSI that reaches the parameter limit dropped whole; a colon separator aborting any CSI other than SGR; OSC payload bytes 0x20–0xFF ended by BEL or ESC `\`; CAN/SUB aborting any sequence; UTF-8 continuation tracking as today. Replace `VTE_CSI_PARAM_LIMIT` with a constant named for what it now mirrors.
  - Keep DA1 recognition exactly as today: no intermediates, final `c`, every parameter zero (`CSI c`, `CSI 0 c`), never inside an OSC/DCS payload or after an intermediate.
  - Report the offset of the final byte of every DECSET whose parameter list includes 2027 (D9).
  - Delete `AltEvent` and the scanner's 1049/47 tracking; `feed` no longer splits chunks at alternate-screen boundaries (alternate-screen handling lives on the terminal thread, T7).
- After: `checkpoint_eligible()` is true only between sequences as libghostty delimits them; `take_da1_queries()` reports exactly the queries it reports today for the same input; `take_title_change()` and `take_command_change()` behave as today for the same input, including when sequences are split across `feed` calls at every byte boundary; the feeding thread never queries the terminal thread.
- Don't: use a libghostty title, semantic-prompt or device-attributes callback to drive these side effects (D4).

#### T6 · libghostty's replies never leave its thread, and it retains no images

- Where: the libghostty terminal construction from T4.
- Change: register no reply-producing callback (PTY write, device attributes, XTVERSION, size, colour scheme, enquiry, clipboard), or register ones that discard. Cap APC buffering (`set_apc_max_bytes`) and, if the binding exposes it without the `kitty-graphics` feature, image storage to the smallest value the library accepts (D5).
- After: no byte produced by libghostty reaches `SessionState::take_query_replies` or a client; the only replies sessiond writes are its existing DA1 replies (`DA1_REPLY`). A Kitty graphics transmission in the output does not grow the terminal's memory beyond the cap.
- Don't: forward libghostty's query answers anywhere (D5).

#### T7 · Snapshot, checkpoint, restore and resize use libghostty's state and formatter

- Where: `crates/runtime/src/sessiond.rs` — `TerminalState::snapshot`, `TerminalState::checkpoint`, `TerminalState::restore`, `TerminalState::resize`, the `normal_before_alt` field, and the free functions from `struct CellStyle` through `fn push_color` (`capture_row`, `capture_viewport`, `capture_complete_history`, `render_normal_snapshot`, `reflow_normal_snapshot`, `render_active_grid`, `render_row`, `emit_style`).
- Change: produce snapshots with libghostty's VT formatter using D2's flags (unwrap on, trim off; cursor, style, modes, scrolling region, hyperlink, keyboard, kitty keyboard, tab stops, charsets on; palette and pwd off), and delete the hand-written capture/render/reflow functions. The formatter emits no DECSCUSR: append one built from the terminal's cursor style and blink state. Format the primary screen while the alternate screen is active on a clone of the terminal — `encode_snapshot_alloc` + `snapshot::Decoder::decode`, then write `\x1b[?47l\x1b8` on the clone and format its primary with modes off — never by toggling screens on the live terminal, which copies the cursor and pen across and closes an open OSC 8 link. Size the scrollback byte cap as `history_line_limit × 4 × cols × 12` bytes (`set_scrollback_max_bytes`), recomputed on every resize; at least that many bytes are kept, and the default cap (10,000 bytes) must never apply. Use libghostty's native resize (it reflows the primary screen) instead of replaying a snapshot. Restore by feeding only the checkpoint's `snapshot` into a fresh terminal, as today. Select history by logical lines (D10) with the M1 check 6 method.
- After: these invariants hold, as today:
  - A normal-screen snapshot starts with a full reset and carries at most `history_line_limit` logical lines of history (none when it is 0), never starting or ending in the middle of a logical line.
  - An alt-screen snapshot is the primary snapshot (no alternate-screen mode in it), then `\x1b[?1049h\x1b[H\x1b[2J` and the alternate screen with its modes, so leaving alt in the client restores the primary. A checkpoint taken while alt is active sets `normal_before_alt` to that primary snapshot; otherwise it is `None` (D2).
  - `checkpoint(max_bytes)` fits `max_bytes` by dropping the oldest logical lines, never by cutting bytes; it returns `None` only when the screen alone does not fit.
  - The snapshot emits style (full SGR), OSC 8 links, cursor position/visibility/shape, scroll region, program-set modes, modifyOtherKeys, Kitty keyboard flags and tab stops, and never OSC 4 palette, default-colour OSCs or OSC 7 (D2).
  - Widths are per code point and mode 2027 never takes effect, by D9's offset reset. Regional indicators are 2 cells each (Ghostty's table; accepted, D1) — do not patch or work around it.
  - A checkpoint written by the current vt100 code restores (generate one from the code at `32d8ede1` for a test fixture), and a checkpoint written after your change decodes with the unchanged `Checkpoint::decode`.
- Don't: change `CHECKPOINT_FORMAT_VERSION`, the `CheckpointHeader` fields, or feed `normal_before_alt` in `restore` — the snapshot already contains the primary and feeding both duplicates its history (D2).

#### T8 · sessiond's tests use libghostty as their oracle and cover the new fidelity

- Where: `crates/runtime/src/sessiond.rs` `mod tests` (every `vt100::Parser` use: `fn restored`, `assert_dec_scanner_matches_vt100`, `Da1Oracle` / `assert_da1_scanner_matches_vt100`, and the other tests that build a `vt100::Parser`); tests in `crates/runtime/src/sessions.rs` only if they reference vt100.
- Change: port the existing tests to a libghostty oracle (replay a snapshot into a fresh libghostty terminal and compare). For the scanner, compare sequence boundaries against libghostty's parser; keep the DA1 tests asserting today's xterm.js semantics (`CSI 5 c` is not a query) rather than libghostty's device-attributes callback (D4). Delete the alt-boundary scanner tests together with the machinery T5 removes, and tests that only exercised deleted vt100 workarounds (for example the vendored single-row wrap patch). Add: one round-trip test where strikethrough, curly underline with colour, an OSC 8 link, a DECSTBM region, `CSI > 4 ; 2 m` and `CSI > 1 u` survive `snapshot()` → replay; one test that `CSI ? 2027 h` followed by an emoji ZWJ sequence in the same feed leaves widths per code point; one test that a bar cursor (`CSI 6 q`) survives `snapshot()` → replay; one test that an alt-screen snapshot leaves the live terminal's alternate-screen cursor, pen and open OSC 8 link unchanged; one test that a resize reflows a long wrapped line on the primary screen; one test that a checkpoint taken in alt mode carries `normal_before_alt` and restores both screens; one that a vt100-era checkpoint fixture restores.
- After: no test in the runtime references vt100; the chunk-split tests for title, marks and DA1 (every split point) still exist and pass against the new scanner.

### Milestone 3: vt100 is gone from the tree

Depends on: Milestone 2

#### T9 · Remove vt100, its vendored patch and every reference

- Where: `vendor/vt100/` (whole directory); `.gitattributes` (`vendor/vt100/** linguist-vendored=true` — the file holds only that rule and its comment); root `Cargo.toml` (the comment `# vt100 0.16.2 单行终端换行修复…` and `vt100 = { path = "vendor/vt100" }`); `crates/runtime/Cargo.toml` (the vt100 comment and dependency); `Cargo.lock`; comments in `crates/runtime/src/sessiond.rs` that describe vt100 behaviour (module doc line 3, the `HISTORY_WRAP_FACTOR` doc, and any other); the comment above `string title = 7;` in `proto/coflux/v1/device.proto` ("sessiond 的 vt100 回调捕获").
- Change: delete the directory, the `.gitattributes` file, the patch entry and the dependency; rewrite the comments to describe the libghostty-based behaviour; recompute `HISTORY_WRAP_FACTOR` and its memory note, or remove it, per D10. For the proto comment, change only the comment text, then regenerate with `buf generate` run in `proto/` so the generated Rust, TS and Swift files match.
- After: `git grep -n -i vt100 -- . ':!wiki/plans' ':!plans'` finds nothing; the workspace builds and tests with zero warnings; the regenerated files differ from `HEAD` only in that comment.
- Don't: change any proto message, field or number — no wire change (D2).

### Your call

- The thread/message design inside `TerminalState`, its module layout, naming and the backlog byte bound, provided D3's ordering, bounded backpressure and non-waiting feed hold.
- The byte cap derived from `history_line_limit` and how snapshots select logical lines, provided D10 and T7's invariants hold and memory stays at or below today's.
- How Zig, `git` and network reach the musl builds, provided both targets stay static musl and are built by the release workflow.
- The test-harness design for M1 and the structure of the ported tests.

### Landmines

- GitHub is very slow from this machine and the `-sys` build script's own clone fails mid-fetch; build with `GHOSTTY_SOURCE_DIR=/Users/wsq/.cache/coflux-ghostty-gate/ghostty-521cf2c5`.
- Locally, the runtime's unit tests inherit the Coflux terminal's environment; run them as `COFLUX_HOME= cargo test -p coflux-runtime` or tests that touch agent presence fail spuriously.
- The worktree session's Bash guard rejects compound git write commands and complex shell constructs around `git`/`gh`; run git and `gh` commands one at a time from the worktree root.
- `sessions.rs` and the device router advance output sequences before delivery; a snapshot that does not correspond exactly to `output_seq()` produces duplicated or missing output on resume (D3 ordering protects this).
- Black-box suites own fixed ports; never run `pnpm -C tests test` while another suite runs on this machine.

### Scope

In scope:
- `crates/runtime/src/sessiond.rs`, plus new private module(s) under `crates/runtime/src/` for the terminal thread
- `crates/runtime/Cargo.toml`, root `Cargo.toml`, `Cargo.lock`
- `vendor/vt100/**` and `.gitattributes` (deletion)
- `proto/coflux/v1/device.proto` (one comment) and its `buf generate` outputs: `crates/protocol/src/gen/**`, `packages/protocol/src/gen/**`, `packages/swift-client/Sources/CofluxProtocol/Generated/**` (comment-only diff)
- `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `.github/workflows/desktop-release.yml`, `Cross.toml`, `Dockerfile`
- `AGENTS.md` (prerequisites line), `docs/RELEASING.md` (build matrix)
- `apps/desktop/src/renderer/components/workbench/terminal-pane.tsx` — only the comment above `terminal.loadAddon(new Unicode11Addon())` that names the daemon's width source `(added at verification)`

Out of scope:
- `crates/runtime/src/sessions.rs`, `device.rs`, `agent_ctl.rs` — `TerminalState`/`SessionState` keep their API; if they must change, stop and report
- Any proto message, field or number, and every other file under `crates/protocol/**`, `packages/**`, `apps/**` — no wire or client change (D2)
- `crates/ptyd/**`, `crates/launcher/**` — PTY custody and probation are untouched
- `CHECKPOINT_FORMAT_VERSION` and `CheckpointHeader` — unchanged (D2)
- Grapheme clustering and any xterm.js/SwiftTerm width setting — non-goal (D1)

### Stop and report if

- A task's anchor is missing, or the code there differs from what the task describes.
- A task needs a file outside the in-scope list.
- Two tasks contradict each other, or a task contradicts the code it changes.
- Any M1 gate check fails, or a mechanism required by checks 3, 4 or 6 does not exist at the pinned commit.
- libghostty-vt at the pinned commit does not build with Zig 0.17.x on one of the four release targets.
- Keeping `TerminalState`'s public API requires `feed` to wait for an answer from the terminal thread.

## Verification

All cargo commands run with `RUSTFLAGS="-D warnings"` so the Zig library is built once.

### Milestone validations

- Milestone 1: `RUSTFLAGS="-D warnings" cargo build -p coflux-runtime` → exit 0; the executor's report lists all four release-target builds succeeding and all six gate checks passing with numbers.
- Milestone 2: `COFLUX_HOME= RUSTFLAGS="-D warnings" cargo test -p coflux-runtime` → exit 0, including the new round-trip, mode-2027, reflow, alt-checkpoint and vt100-fixture tests.
- Milestone 3: `git grep -n -i vt100 -- . ':!wiki/plans' ':!plans'` → no output; `RUSTFLAGS="-D warnings" cargo build -p coflux-launcher -p coflux-runtime -p coflux-cli -p coflux-ptyd` → exit 0; `git diff 32d8ede1 -- crates/protocol packages proto` shows only the title comment.

### Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Rust unit tests (CI set) | `COFLUX_HOME= RUSTFLAGS="-D warnings" cargo test -p coflux-protocol -p coflux-launcher -p coflux-runtime -p coflux-cli -p coflux-ptyd` | exit 0 |
| Zero-warning build | `RUSTFLAGS="-D warnings" cargo build -p coflux-launcher -p coflux-runtime -p coflux-cli -p coflux-ptyd` | exit 0 |
| Format | `cargo fmt --all -- --check` | exit 0 |
| Diff hygiene | `git diff --check 32d8ede1 HEAD` | no output |
| Generated protocol in sync | `buf generate` in `proto/`, then `git status --porcelain -- packages/protocol/src/gen crates/protocol/src/gen packages/swift-client/Sources/CofluxProtocol/Generated` | no output |
| macOS x86_64 release build | `RUSTFLAGS="-D warnings" cargo build --release --target x86_64-apple-darwin -p coflux-runtime` | exit 0 |
| musl release builds (acceptance) | `RUSTFLAGS="-D warnings" cross build --release --target x86_64-unknown-linux-musl -p coflux-launcher -p coflux-runtime -p coflux-cli -p coflux-ptyd` and the same for `aarch64-unknown-linux-musl` | exit 0; `file` shows static binaries |
| Black-box core (acceptance) | `pnpm install --frozen-lockfile && pnpm -C tests test` | exit 0; `worker-upgrade` covers sessiond takeover across a runtime swap |
| Docker test image (acceptance) | `docker build -t coflux-test .` | builds with Zig |

### Done criteria

- [ ] All listed commands pass.
- [ ] Every task's `After` state holds.
- [ ] M1 evidence is recorded in the Outcome: four target builds, the six gate checks with numbers, and the mechanisms for 2027, alt-screen formatting and logical-line selection.
- [ ] Diff review: `TerminalState` and `SessionState` public signatures unchanged; no file under `crates/ptyd`, `crates/launcher` or `apps` changed; protocol and generated files differ only in the title comment; `CHECKPOINT_FORMAT_VERSION` and `CheckpointHeader` unchanged.
- [ ] Diff review: no `unsafe impl Send`/`Sync`; the libghostty terminal is constructed inside its thread; the feed channel is bounded by bytes; feed never waits for an answer; `Drop` joins the thread; no libghostty reply reaches the PTY.
- [ ] Diff review: DA1 recognition still requires all-zero parameters; the scanner no longer tracks alternate-screen boundaries; mode 2027 is reset at the scanner-reported offset.
- [ ] Diff review: the formatter configuration has unwrap on, trim off, and excludes palette, default-colour OSCs and OSC 7; `restore` feeds only `snapshot`; alt-mode checkpoints carry `normal_before_alt`.
- [ ] The new tests assert style/link/scroll-region/keyboard-mode round trip, 2027 neutrality, primary-screen reflow, alt-mode checkpoint restore and vt100-fixture restore, and would fail against the old vt100 implementation where it lacked the capability.
- [ ] Every workflow job that builds the runtime installs a pinned Zig through a SHA-pinned action; `AGENTS.md` and `docs/RELEASING.md` name Zig 0.17.x.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] The Outcome is appended and `wiki/plans/README.md` status is updated.

### Merge and deploy

- CI does not run the musl `cross` builds; only a `v*` tag does. Before tagging a release that contains this change, run both musl `cross build` commands locally (acceptance row above) — otherwise the first sign of a broken Zig-in-container setup is a failed release.
- The runtime now depends on a git commit of a third-party repository: release builds fetch it (and Ghostty's source and Zig packages) at build time. If that repository disappears, builds break; vendoring the source is the fallback.
- Ships as a runtime update: the center pushes the runtime to launcher daemons, and the swap rebuilds sessiond from ptyd checkpoints, so live terminals survive. The desktop app bundles the runtime too, so desktop and runtime ship in the same release as usual.
- Rollback: the launcher rolls back a crash-looping or pseudo-healthy runtime by itself; a manual rollback to the previous release restores from libghostty-written checkpoints because the format is unchanged and alt-mode checkpoints still carry the primary screen (D2). There are no migrations, flags or new environment variables.
- Manual acceptance after merge (`pnpm dev:desktop:prod` against a runtime built from this branch, or after release): in a terminal running a styled TUI (strikethrough/underline colours, links) and one using Kitty keyboard (e.g. an agent CLI), close and reopen the desktop window or switch devices, and confirm the reattached screen matches; resize the window with long wrapped lines in history and confirm reflow; run `coflux terminal read` on a live terminal and confirm readable output.
- Release notes: mention that reattached terminals now keep full styling, links and keyboard modes, and that terminal history uses less memory.
