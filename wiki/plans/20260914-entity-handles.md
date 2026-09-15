# Plan 20260914-entity-handles: Paste-recognisable coflux entity handles

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `wiki/plans/README.md`.
>
> Drift check: `git diff --stat ebca9085..HEAD -- apps/server/src apps/desktop/src apps/ios/Coflux/Views crates/cli/src crates/worker/src packages/cli tests/src integrations/claude-plugin`

## Status

- Priority: P2
- Effort: L
- Risk: MED
- Depends on: none
- Category: feature
- Execution: subagent(opus) — departure check
- Stop after: implementation — departure check (advisor review, then straight to execution)
- Plan review: advisor — departure check; review ran and its findings are folded in
- Workspace: isolated — cut from the main worktree at plan time
- Planned at: `ebca9085`, 2026-09-14

## Requirement

Every coflux entity id is a bare UUID (`randomUUID()`, `apps/server/src/hub.ts:1285`,
`:2898`). When the user copies one and pastes it to an agent, nothing about the
string says which product it belongs to or which kind of entity it names — device,
project, workspace and terminal ids are indistinguishable. The agent has to guess,
or re-list everything until something matches.

This plan gives each entity a **handle**: a short string that is visibly coflux's
and visibly typed, accepted anywhere the real id is accepted, and returned
anywhere entities are returned.

### Product conclusions (settled in exploration — do not reopen)

- **Consumer**: an agent running inside a coflux terminal, which already has the
  `coflux` CLI and skill. The gap it closes is "what kind of thing is this id",
  not "does coflux exist".
- **Form**: `coflux:<kind>:<short>` where `kind` is one of `device`, `project`,
  `workspace`, `terminal`, and `<short>` is the first 8 lowercase hex characters
  of the entity's UUID. Examples: `coflux:device:b6767697`,
  `coflux:project:7a83f21e`, `coflux:workspace:3f2a1b7c`,
  `coflux:terminal:9e21c4d0`. A human-readable name segment was considered and
  explicitly rejected by the user: handles are ASCII, type + short id only.
- **Equivalence**: every interface or command that accepts an id accepts a handle
  too, and every interface or command that returns an entity returns its handle.
- **Copy affordances**: the desktop sidebar's device, project and workspace context
  menus each gain a "copy handle" item; the terminal tab bar gains a context menu
  with the same item; iOS gains long-press copy on its device rows, workspace rows
  and terminal tab chips. The handle is never rendered as persistent UI text.
- **Agent context**: the `<coflux-session>` block gains the handles of the current
  terminal's coordinates alongside — never replacing — the existing id lines, and
  the skill documents the format and the equivalence rule.
- **Non-goals**: UUIDs remain canonical (primary keys, protocol ids); no `resolve`
  command; PTY sessions get no handle; the protobuf contract is not changed.

### Observable outcome

Pasting `coflux:workspace:3f2a1b7c` to an agent is enough for it to know it holds a
workspace handle and to use it directly — `coflux terminal new --workspace
coflux:workspace:3f2a1b7c` works exactly as the UUID would. Right-clicking a device
in the desktop sidebar (or long-pressing it on iOS) puts its handle on the
clipboard. `coflux device list` and the local `coflux terminal list` both show
handles.

## Decisions & tradeoffs

- **Handle grammar**: `coflux:<kind>:<hex>`, `kind` ∈ {`device`, `project`,
  `workspace`, `terminal`}, `hex` = `[0-9a-f]{4,32}`. Parsing is
  case-insensitive on input and normalised to lowercase; generation always emits
  lowercase and always uses exactly 8 characters. Rejected: a readable name
  segment (`coflux:device:mbp-b676`) — the user chose type + short id only after
  seeing both; rejected: an opaque prefix without a kind (`cfx_b6767697`) — the
  kind is the whole point, it is what lets the agent skip the guess. Based on:
  every entity id is a UUID v4 (`apps/server/src/hub.ts:1285`, `:2898`).

- **Short id = the UUID's first 8 hex characters**, i.e. `id.slice(0, 8)` — the
  first dash-delimited group of a UUID. Generation never uses any other length.
  Rejected: 4 characters — with a few hundred entities in one account the
  birthday collision probability is percent-scale, and every collision turns into
  a user-visible "paste the full UUID" error; rejected: the full UUID — the point
  is a short paste.

- **Do not name anything `shortId`** `(revised on advisor review)`. That name is
  already taken by the port-preview routing identity (`apps/server/src/proxy.ts:4`,
  `:7`, `:30`, `:53`), an unrelated concept in the same server. Call this one a
  handle (`ref` in payloads). An executor grepping for `shortId` otherwise lands
  in the proxy layer.

- **Equivalence is implemented at the interface boundary, not in the domain**:
  handles are normalised to real ids on the way in, and nothing below the entry
  point ever sees a handle. Rejected: teaching each store/hub method to accept
  both — it would spread the parse across dozens of call sites and make every
  future method a place the equivalence can be forgotten. Based on: all account
  commands funnel through one switch at
  `apps/server/src/interface/client-command/client-command.handler.ts:20-50`, and
  all local agent commands through one action match at
  `crates/worker/src/agent_ctl.rs:355-460`.

- **Two resolution points, plus one client-side comparison** `(revised on advisor
  review)`. Resolution proper happens at (1) the server's account-command entry,
  covering every `/api/client/command` operation carrying an id (`workspace.new`'s
  `projectId`, `workspace.rename`/`remove`'s `workspaceId`, `terminal.new`'s
  `workspaceId`, every `terminal.*`'s `terminalId`, `device.exec`'s `deviceId`);
  and (2) the worker's local agent commands, where the handle is resolved before
  `resolve_local_target` (`crates/worker/src/agent_ctl.rs:752`). Additionally, both
  CLIs filter `--device` / `--workspace` **client-side** by comparing raw JSON
  strings (`crates/cli/src/account.rs:340-347`,
  `packages/cli/account-client.mjs:132`); those comparisons must accept a handle
  too. That is a comparison, not a resolution — it needs no lookup, only the same
  grammar. Treating it as an exception is the failure mode: a handle passed to
  `--device` then matches nothing and prints an empty list with no error. The
  contract schema needs no change: `id` is already `z.string().min(1).max(256)`
  (`apps/server/src/interface/client-command/client-command.contract.ts:4`).

- **Server-side resolution is account-scoped prefix matching, never global**: the
  candidate set is the entities of the requesting account with the handle's kind.
  Exactly one match resolves; zero matches is a not-found error; two or more is an
  ambiguity error telling the user to paste the full UUID. A handle whose kind does
  not match what the command expects is rejected with an error naming both the
  handle's kind and the expected kind — this check reads the kind token alone and
  never probes another kind's table. Rejected: matching across kinds and correcting
  silently — a `terminal.stop` handed a workspace handle must fail loudly, not act
  on something adjacent. Rejected: resolving before the account is known — that
  would make handles an existence oracle for other accounts' entities. The four
  tables are `TEXT PRIMARY KEY` with an `account_id` index
  (`apps/server/src/infra/database/schema-migrations.ts:197-231`, `:366-371`), so a
  bounded `WHERE account_id = $1 AND id LIKE $2 || '%'` query is the intended shape.

- **Worker-side resolution is scoped to the calling workspace, not the device**
  `(revised on advisor review)`. `resolve_local_target` deliberately collapses "not
  in this workspace" and "does not exist" into one message
  (`crates/worker/src/agent_ctl.rs:749-757`) so a local command cannot probe other
  workspaces. A prefix match over the whole ledger would break that: two terminals
  in different workspaces sharing a prefix would surface an ambiguity error that
  reveals the other one exists. The candidate set is therefore the terminals of the
  effective workspace only, and ambiguity is judged within that set. Add a new
  prefix-aware lookup rather than changing `SessionLedger::task`
  (`crates/worker/src/session_ledger.rs:223-227`): it is an exact `HashMap` lookup
  with six exact-match unit tests on it (`:270-321`).

- **Local command results always report the resolved UUID in `taskId`** `(revised
  on advisor review)`. Local results echo back the caller's string
  (`crates/worker/src/agent_ctl.rs:385`, `:404`, `:435`, `:448`, `:887`, `:890`), so
  an implementation that resolves a handle but keeps echoing the input would put a
  handle in `taskId` and derive `ref` from a handle — and still satisfy a naive
  "results carry `ref`" check. `taskId` is the full UUID; `ref` is the handle;
  neither is ever the caller's raw input.

- **Output field name is `ref`**, added alongside the existing id field on every
  entity the account API returns and in local command results. The id field keeps
  its current name and value. Rejected: renaming or replacing the id field —
  clients and tests read it, and UUIDs stay canonical. Entities returned nested or
  singly count too: `terminal.new`'s `Task` (`apps/server/src/hub.ts:3910`),
  `workspace.rename`'s `Workspace` (`:3849`), `terminal.stop`'s `{task}` (`:4152`),
  `workspace.remove`'s `{workspaceId, removedTerminalIds}` (`:3859`), and locally
  `TerminalNew`'s result (`crates/worker/src/agent_ctl.rs:312`), every item of
  `TerminalList` (`:331`), and `WorkspaceCurrent`'s `workspaceId` /
  `owningWorkspaceId` (`:502-508`) — the last is additive and safe, its readers take
  only `workspaceId` (`integrations/claude-plugin/scripts/session-moved.mjs:108`,
  `crates/cli/src/integration.rs:206`).

- **Normalisation rewrites the command object, not a local variable** `(revised on
  advisor review)`. The handler forwards the whole parsed command downstream
  (`apps/server/src/interface/client-command/client-command.handler.ts:34`, `:37`),
  so resolving into a local and leaving the object untouched silently reaches the
  hub with the handle still in it.

- **The local `terminal list` text line leads with the handle** `(revised on advisor
  review)`. Its first column is the bare task id today
  (`crates/cli/src/commands.rs:163-185`); it becomes the handle, which is both
  shorter and typed. This is the line agents read most often, and the equivalence
  rule makes the handle directly reusable in the next command. The JSON payload
  still carries `taskId` as the UUID plus `ref`.

- **Both CLI implementations change together** `(revised on advisor review)`. The
  npm package publishes `coflux` as well as `cofluxd`
  (`packages/cli/package.json:6-9`), and the Rust CLI's output phrases are
  contractually word-for-word identical to the Node ones — there is a unit test
  named for it (`crates/cli/src/commands.rs:811`,
  `terminal_new_and_run_output_matches_node`, and the note at `:6`). Any printed
  line this plan changes must change in `packages/cli/coflux.mjs` too, with the
  parity test updated in the same milestone.

- **Both `<coflux-session>` emitters change together** `(revised on advisor
  review)`. There are two: the plugin's shell hook
  (`integrations/claude-plugin/scripts/session-context.sh`) and the device-level
  agent integration in the Rust CLI (`crates/cli/src/integration.rs:225`, the one
  that produced the block in a managed terminal). They must print the same handle
  lines. They live in different milestones' file sets, so the exact line format is
  fixed here: one `coflux:<kind>:<short>` line per coordinate, labelled by kind,
  printed after the existing id lines and never replacing them.

- **User-facing runtime messages stay in Chinese** `(revised on advisor review)`.
  The repository's language policy covers documentation, comments and commits
  (`AGENTS.md`), while runtime strings the user reads are Chinese throughout
  (`crates/cli/src/account.rs:137`, `crates/worker/src/agent_ctl.rs:757`). The three
  new errors — unknown handle, ambiguous prefix, kind mismatch — follow their
  neighbours.

- **Handles are composed client-side, and the protobuf contract is untouched**:
  the generation rule is a pure concatenation of a kind token and an id prefix,
  so server (TS), worker/CLI (Rust and Node), desktop (TS) and iOS (Swift) each
  compose it locally. Rejected: adding a `ref` field to
  `proto/coflux/v1/common.proto` — it buys one generation site at the cost of a
  proto change, regenerated TS/Rust/Swift bindings and an iOS transport rebuild,
  for a rule with no room to drift. The user saw this tradeoff and accepted it.

- **The desktop clipboard needs no new bridge surface**: `clipboard-sanitized-write`
  is already in the renderer's allowed permissions
  (`apps/desktop/src/main/index.ts:162`), so the renderer can call
  `navigator.clipboard.writeText` directly. Rejected: routing the copy through the
  preload bridge — no capability is missing.

- **New assertions go into the existing black-box file, not a new one** `(revised on
  advisor review)`. `AGENTS.md:68-80` records that the suite was deliberately cut to
  five files on 2026-09-13 and must not grow back by habit. `tests/src/contract.test.mjs`
  already logs in and wraps `accountCommand()` on port 8826 (`:11`, `:31-41`), which
  is exactly the surface milestone 1 needs — and reusing it sidesteps picking a new
  port.

- **iOS is in scope** (departure check): device rows, workspace rows and terminal
  tab chips gain long-press copy. Note the terminal affordance is a chip in a
  horizontal `ScrollView` (`apps/ios/Coflux/Views/WorkspaceDetailView.swift:322-324`),
  not a list row. Rejected: deferring iOS — the user chose to include it.

## Direction

The handle is a boundary concept: a string the user and agents exchange, resolved
to a real id at every entry point and attached to every entity on the way out.
Nothing inside the domain layer changes shape.

The five milestones below are **mutually independent**: their file sets are
disjoint, none consumes another's output, and each is validated on its own. The
shared grammar and the two cross-milestone formats (the `<coflux-session>` handle
lines, the three error kinds) are fixed by the Decisions section, not by any
milestone's code, so they may be fanned out into concurrent work packages. When
they are fanned out, the orchestrator — not the packages — updates
`wiki/plans/README.md` and this plan file; concurrent packages must not touch
either, or they collide on the same two files.

### Milestone 1: The account API speaks handles

Every `/api/client/command` operation accepts a handle wherever it accepts an id,
resolving it account-scoped with the error semantics recorded above, and every
entity in every response — including the nested and single-entity results listed
under Decisions — carries its `ref`. Resolution reaches the database as a bounded
query rather than loading an account's terminal list into memory.

Validation: `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` -> exit 0;
`pnpm -C tests test` -> exit 0, with assertions added to `tests/src/contract.test.mjs`
showing that a handle and a UUID drive the same command identically, that an
ambiguous prefix and a kind mismatch each fail with their own message, and that
snapshot entities carry `ref`.

### Milestone 2: Local commands, both CLIs, and the managed session block

Local terminal commands (`read`, `run`, `wait`, `send`, `close`, `status`) accept a
terminal handle and resolve it within the calling workspace; their results report
the resolved UUID in `taskId` and add `ref`; `TerminalNew`, `TerminalList` and
`WorkspaceCurrent` carry `ref` as recorded. The local `terminal list` text line
leads with the handle. Both CLIs' `--device` / `--workspace` filters accept handles.
The CLI help text documents the handle form once. The device-level agent
integration's `<coflux-session>` block prints the handle lines in the format fixed
above. The Rust and Node CLIs stay word-for-word identical.

Validation: `cargo test -p coflux-cli -p coflux-worker` -> exit 0, covering handle
parsing (valid, wrong kind, ambiguous, unknown), workspace-scoped prefix lookup, and
the updated render functions including the Node-parity test
(`crates/cli/src/commands.rs:811`).

### Milestone 3: Desktop copy affordances

The sidebar's device, project and workspace context menus each offer copying that
entity's handle, and the terminal tab bar offers the same through a context menu it
does not have today. No handle is rendered as persistent UI text.

Validation: `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test && pnpm -C apps/desktop build` -> exit 0.

### Milestone 4: iOS copy affordances

Device rows, workspace rows and terminal tab chips each offer long-press copy of the
entity's handle through the platform context menu and pasteboard.

Validation: acceptance-tier, run by the verifier — see Commands.

### Milestone 5: The plugin hook and the skill

The plugin's `<coflux-session>` shell hook prints the same handle lines as the
managed integration does, keeping its existing best-effort failure behaviour and
never dropping an existing id line. The skill documents the grammar, the
equivalence rule and the three error kinds, in English, in both synced copies.

Validation: `node scripts/sync-claude-plugin.mjs --check` -> exit 0.

## Landmines

- **There are two `<coflux-session>` emitters, in two different milestones.**
  `integrations/claude-plugin/scripts/session-context.sh` and
  `crates/cli/src/integration.rs:225`. Changing one and not the other leaves agents
  seeing different coordinates depending on how their terminal was started.
- **`shortId` already means something else in this server** (port-preview routing,
  `apps/server/src/proxy.ts:4-53`). Do not reuse the name for the handle's id
  segment.
- **The two CLIs are output-identical by contract.** `packages/cli/coflux.mjs` and
  `crates/cli/src/commands.rs` print the same phrases, asserted by
  `terminal_new_and_run_output_matches_node` (`crates/cli/src/commands.rs:811`, note
  at `:6`). Changing one side alone fails `cargo test`.
- **The CLIs' list filters compare raw JSON strings**
  (`crates/cli/src/account.rs:340-347`, `packages/cli/account-client.mjs:132`). A
  handle passed to `--device` silently matches nothing — empty output, not an error.
- **Local-command errors deliberately hide whether a terminal exists elsewhere**
  (`crates/worker/src/agent_ctl.rs:749-757`). Prefix matching across workspaces
  would leak that through an ambiguity message.
- **`SessionLedger::task` has six exact-match unit tests on it**
  (`crates/worker/src/session_ledger.rs:270-321`). Add a prefix lookup beside it
  rather than redefining it.
- **The black-box suite is deliberately small** (`AGENTS.md:68-80`, cut from 59
  files to 5 on 2026-09-13). Add assertions to `tests/src/contract.test.mjs`; do not
  create a new test file, and do not pick a new port.
- **The skill exists twice and CI compares them.** The only source is
  `packages/cli/skills/coflux/SKILL.md`; `node scripts/sync-claude-plugin.mjs`
  copies it to `integrations/claude-plugin/skills/coflux/SKILL.md` and
  `--check` is what CI runs (`.github/workflows/ci.yml`). Editing the plugin copy
  directly, or editing the source without syncing, fails CI. The plugin directory's
  skill must be entirely in English.
- **Shipping is out of this plan's authority.** Bumping
  `integrations/claude-plugin/.claude-plugin/plugin.json` and handing the SHA to the
  marketplace builder happens after merge, at the user's call. An unbumped version
  is not an incomplete milestone.
- **Handles only work end-to-end after a release.** A daemon or CLI older than this
  change rejects a handle locally; the skill reaches machines through the
  device-level agent-integration bundle
  (`~/.coflux/agent-integrations/<sha>/skills/coflux/SKILL.md`), so it travels with
  a daemon upgrade, and the desktop and iOS builds ship separately. Expected; do not
  paper over it with fallbacks.
- **Repository language policy**: documentation, code comments and commit messages
  are English (`AGENTS.md`); runtime strings the user reads stay Chinese.

## Scope

In scope:

- `apps/server/src/interface/client-command/`, plus the store/hub query support
  resolution needs, and assertions in `tests/src/contract.test.mjs` (milestone 1)
- `crates/worker/src/agent_ctl.rs`, `crates/worker/src/session_ledger.rs`,
  `crates/cli/src/` (including `integration.rs`), `packages/cli/coflux.mjs`,
  `packages/cli/account-client.mjs` (milestone 2)
- `apps/desktop/src/renderer/components/workbench/sidebar.tsx`,
  `apps/desktop/src/renderer/components/workbench/workspace-terminal.tsx`
  (milestone 3)
- `apps/ios/Coflux/Views/DevicesView.swift`,
  `apps/ios/Coflux/Views/WorkspaceListView.swift`,
  `apps/ios/Coflux/Views/WorkspaceDetailView.swift` (milestone 4)
- `integrations/claude-plugin/scripts/session-context.sh`,
  `packages/cli/skills/coflux/SKILL.md` and its synced copy (milestone 5)

Out of scope:

- `proto/` and the generated bindings — decided against; handles are composed
  client-side
- Replacing UUIDs anywhere, including in the protocol, the database, or existing
  response fields
- A `resolve`-style command, and handles for PTY sessions
- Persistent on-screen display of handles in any client
- New black-box test files, and any new test port
- Releasing: version bumps, tags, npm publication, plugin marketplace submission
- `wiki/plans/README.md` and this plan file when milestones run as concurrent
  packages — the orchestrator owns both

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Server typecheck | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| Black-box core | `pnpm -C tests test` | exit 0 |
| Rust tests | `cargo test -p coflux-cli -p coflux-worker` | exit 0 |
| Desktop | `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test && pnpm -C apps/desktop build` | exit 0 |
| Plugin skill sync check | `node scripts/sync-claude-plugin.mjs --check` | exit 0 |
| iOS build (acceptance) | `xcodebuild build -project apps/ios/Coflux.xcodeproj -scheme Coflux -destination 'generic/platform=iOS' -allowProvisioningUpdates` | BUILD SUCCEEDED |
| Swift client tests (acceptance) | `swift test --package-path packages/swift-client` | exit 0 |

## Done criteria

- [ ] All listed commands pass.
- [ ] A handle and the corresponding UUID are interchangeable on every account
      command that takes an id, and on every local terminal command.
- [ ] Every entity returned by the account API carries `ref`, including the nested
      and single-entity results named under Decisions; local results carry `ref`
      and report the resolved **UUID** in `taskId`, never the caller's input.
- [ ] An ambiguous prefix, an unknown handle and a kind mismatch each fail with a
      distinct, actionable Chinese message; none acts on an adjacent entity; local
      ambiguity is judged within the calling workspace only.
- [ ] Both CLIs accept a handle in `--device` / `--workspace` filters and print
      identical phrases, with the parity test updated.
- [ ] Desktop offers handle copy on device, project, workspace and terminal;
      iOS offers it on device rows, workspace rows and terminal tab chips.
- [ ] Both `<coflux-session>` emitters print the same handle lines, with every
      existing id line intact.
- [ ] The skill documents the grammar in English in both synced copies.
- [ ] Required tests exist and assert meaningful behavior.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed; no new black-box test file was created.
- [ ] `wiki/plans/README.md` status is updated (by the orchestrator when the plan
      was fanned out).

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files — in particular, if handles cannot be
  made to work without changing `proto/`, stop and report rather than changing it.
- A validation command fails twice after one reasonable fix.
- Resolution cannot be kept account-scoped on the server, or workspace-scoped in
  the worker, at some entry point.

## Maintenance notes

- The handle grammar is defined in five places by construction (server, worker,
  Rust CLI, Node CLI, desktop, iOS) and in prose in the skill. A future change to
  the format has to touch all of them; if that becomes painful, revisit the
  rejected option of carrying `ref` in the protobuf contract.
- The 8-character short id is a collision budget, not a constant to shrink
  casually: the ambiguity error is the user-visible cost of a shorter one.
- The advisor review also flagged `scripts/stage-daemon.mjs` as a path that copies
  the plugin directory into the desktop bundle; that file does not exist at
  `ebca9085` and the claim was not adopted. The skill's real delivery path is the
  device-level agent-integration bundle, recorded under Landmines.
- Once released, the plugin needs a version bump and a marketplace SHA handoff
  before agents on other machines see the new session block and skill text.
