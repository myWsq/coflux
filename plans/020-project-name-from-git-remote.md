# Plan 020: Deriving project name from Git remote

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 8cf04db..HEAD -- proto/coflux/v1/daemon.proto proto/gen/swift/coflux/v1/daemon.pb.swift packages/protocol/src/gen/coflux/v1/daemon_pb.ts crates/protocol/src/gen/coflux/v1/coflux.v1.rs crates/protocol/src/wire_tests.rs crates/worker/src/git.rs crates/worker/src/main.rs apps/server/src/hub.ts tests/src/lifecycle.test.mjs`

## Status

- Priority: P2
- Effort: M
- Risk: MED
- Depends on: none
- Category: feature
- Execution: subagent
- Planned at: `8cf04db`, 2026-07-20

## Requirement

The web import flow omits name, so the server uses the final segment of the entered path. This loses remote namespaces and misnames imports started in repository subdirectories. For imports without an explicit name, derive the complete Git remote identity: this repository’s `https://github.com/myWsq/coflux.git` should produce `myWsq/coflux`.

Naming priority: nonblank explicit `name` → resolvable origin identity → first resolvable identity from other remotes → basename of the canonical repository root returned by Git. Missing/unsupported remotes and old workers without the new field must not fail import.

## Decisions & tradeoffs

- **Explicit names always win.** A trimmed-nonempty projectImport.name is the user override and must not be replaced by remote identity. Evidence: `proto/coflux/v1/client.proto:58-63` already makes name optional, and `apps/server/src/hub.ts:725` already prioritizes nonempty explicit names.
- **Try origin first, then other remotes in Git’s returned order.** The first resolvable identity wins; remote names do not appear in the result. Origin-only would unnecessarily fall back when another remote is valid; upstream-first conflicts with the user’s normal clone semantics.
- **Preserve the full namespace path and remove trailing `.git`.** GitHub owner/repo.git becomes owner/repo; GitLab group/subgroup/repo.git becomes group/subgroup/repo. Keeping only two segments or the first namespace plus project loses nested identity.
- **Read and parse remotes in the worker; the server only selects priority and persists the result.** Only the daemon machine has the repository/Git config. Return the derived candidate, never the complete remote URL. Server-side filesystem access is unavailable, and uploading URLs unnecessarily spreads sensitive data. Evidence: `crates/worker/src/git.rs:53-71` validates repositories; `crates/worker/src/main.rs:675-680` returns results.
- **Keep the new protocol field optional for rolling compatibility.** New servers fall back to the repository root when old workers omit it; old servers ignore the unknown field. Required candidates would break imports during worker hot upgrades/version skew. Evidence: worker-to-server `ProjectValidated` in `proto/coflux/v1/daemon.proto:45-52`.
- **Use the verified repository root for the directory fallback.** Imports from subdirectories must still use the root basename. The current input-path fallback at `apps/server/src/hub.ts:725` is wrong; `crates/worker/src/git.rs:59-63` already obtains `git rev-parse --show-toplevel`.
- **Support common network remotes and skip unparseable values (decided during planning).** Handle HTTPS/HTTP/SSH/git URLs and SCP-like `git@host:namespace/project.git`, including nested namespaces. Treat local paths, file: remotes, empty paths, and unsafe namespace/project values as unresolved and continue fallback. Supporting every exotic Git syntax risks mistaking local paths or credentials for names.

## Direction

Add an optional worker-derived remote-name candidate to the proto source of truth and regenerate all checked-in bindings. Read/parse remotes during existing repository validation. Preserve the explicit name until asynchronous validation completes, then apply the naming contract. Cover parser boundaries, protobuf round trips, and real-process imports.

### Milestone 1: Protocol expression optional remote name candidate

The repository verification result of worker → server can carry optional candidate names. The generated bindings of TS, Rust and Swift are consistent with the proto source of truth. The Rust wire round-trip covers both the value and missing situations.

Verification: `cd proto && buf lint && buf generate && git diff --exit-code -- ../packages/protocol/src/gen ../crates/protocol/src/gen gen/swift`→ exit 0; `cargo test -p coflux-protocol`→ exit 0.

### Milestone 2: Worker robustly deduces remote repository identity

Valid repository verification results can return the complete namespace/project according to origin priority rules; missing or unsupported remote does not affect the success of repository verification. Parsing tests cover HTTPS, SSH URLs, SCP-like, multi-layer namespaces, `.git`/ trailing slash, invalid and local paths, and verify remote fallback order.

Verification: `cargo test -p coflux-worker`→ exit 0; `cargo build -p coflux-supervisor -p coflux-worker`→ exit 0 with zero warnings.

### Milestone 3: server applies final naming priority and completes black-box acceptance

The server persists the project name in the order of explicit name, worker candidate, and canonical repo root basename. The namespace/project name is observed after the real stack imports the repository with origin; the explicit name still overrides the remote candidate; when there is no valid remote, it falls back to the repo root directory name.

Verification: `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit`→ exit 0; see the acceptance item of Commands for the final black-box package.

## Landmines

- `OpData` currently requires a string name and fills it from the input path before daemon validation (`apps/server/src/hub.ts:125-127,725-730`). Keep explicit-name presence distinct until validation finishes instead of prematurely mixing in a directory fallback.
- `ProjectValidated` is a protobuf that crosses language boundaries (`proto/coflux/v1/daemon.proto:45-52`); according to repository discipline, you must modify the proto source of truth and run `buf generate`, and you cannot manually modify any generated file. CI will intercept drift with post-generation zero diff (`.github/workflows/ci.yml:39-51`).
- The remote URL may contain username, token or host information; only the parsed namespace/project is allowed to appear in logs, errors and protocols, and the original URL is not allowed to be returned or printed.
- Git-command failure, missing remotes, and parse failures mean no candidate, not an invalid repository. Preserve the existing success check based on `rev-parse --show-toplevel`.
- The black-box harness will directly build and run the Rust supervisor/worker; the test must use the temporary repository and local Git configuration, do not access the external network, and must not rely on the local global Git remote.

## Scope

In scope:
- `proto/coflux/v1/daemon.proto`
- `proto/gen/swift/coflux/v1/daemon.pb.swift`
- `packages/protocol/src/gen/coflux/v1/daemon_pb.ts`
- `crates/protocol/src/gen/coflux/v1/coflux.v1.rs`
- `crates/protocol/src/wire_tests.rs`
- `crates/worker/src/git.rs`
- `crates/worker/src/main.rs`
- `apps/server/src/hub.ts`
- `tests/src/lifecycle.test.mjs`

Out of scope:
- `proto/coflux/v1/client.proto` and Web import UI - there is already an optional explicit name, and there is no need to add a new input box for Web.
- Project renaming ability - This requirement only changes the default name when importing.
- Data migration or batch rename of existing projects - the new rules only apply to subsequent imports.
- Add Git host to the name - the target format is namespace/project, not host/namespace/project.

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Proto lint + codegen consistency | `cd proto && buf lint && buf generate && git diff --exit-code -- ../packages/protocol/src/gen ../crates/protocol/src/gen gen/swift` | exit 0 |
| Rust protocol tests | `cargo test -p coflux-protocol` | exit 0 |
| Worker unit tests | `cargo test -p coflux-worker` | exit 0 |
| Server typecheck | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| Daemon build | `cargo build -p coflux-supervisor -p coflux-worker` | exit 0, zero warnings |
| Full black-box suite (acceptance) | `pnpm -C tests test` | exit 0; project name priority is accepted by the real server + Rust daemon |

## Done criteria

- [ ] This repository's remote `https://github.com/myWsq/coflux.git` obtains `myWsq/coflux` according to the same parsing rules.
- [ ] Non-empty explicit name covers all remote candidates.
- [ ] When not explicitly named, origin takes precedence; if origin is missing/unresolvable, the first resolvable value of other remotes is tried.
- [ ] GitLab multi-layer namespace is fully retained, and common HTTPS/SSH/SCP-like URLs are tested.
- [ ] When there is no valid remote candidate or the old worker has missing fields, use the standard repo root basename and the project import will still be successful.
- [ ] Original remote URL does not enter worker → server messages, logs or user errors.
- [ ] proto is consistent with the generated bindings for all three languages, and all related unit tests, type checks, construction and full black-box tests have passed.
- [ ] Implementation follows every convention of Decisions & tradeoffs, without changing files outside scope.
- [ ] `plans/README.md` status updated.

## STOP conditions

- Decisions & tradeoffs refer to protocol or import link facts that are no longer established.
- Correct implementation requires modifying files outside the scope.
- The original remote URL needs to be sent to the server to complete the derivation.
- Any verification command fails twice in a row after a reasonable fix.

## Maintenance notes

- If you want to display the host in the future, you should add a separate field or display strategy, and do not change the stable project name semantics here.
- When adding a new remote URL form, priority should be given to expanding the pure parsing test of the worker, and maintaining the principle of "only fallback if parsing fails".
