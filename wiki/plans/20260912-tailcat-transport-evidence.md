# Tailcat transport migration evidence

## Baseline and scope

- Coflux baseline: `67b51751c0e33e5742312975d9876dd83cbd0664`.
- Workspace: `dev/20260912-tailcat-transport`; the original main worktree is not modified by this migration.
- Implementation was explicitly authorized after the planning handoff. Production deployment is outside this execution.
- Tailcat: `github.com/tailscale/tailcat v0.6.1-0.20260909154426-91dc4979bd4a`, commit `91dc4979bd4ae88af6ae2c8bb549616de4bcaa5a`.
- Module checksum: `h1:DbJO8q3BPLAfr5wG5MARO6fcnVFJNQhQKJBFsZyzsUM=`.
- Go toolchain: `go1.27.1`, acquired through Go's toolchain mechanism.

## Pre-implementation checks

- `pnpm install --frozen-lockfile`: passed without changing the lockfile.
- Server `tsc --noEmit` and desktop typechecks: passed.
- Rust test prebuild (supervisor, worker, relay, CLI): passed with no warnings.
- Initial full black-box run: 209 passed, 6 failed out of 215. All six failures were setup failures in two files: PostgreSQL database creation and cancellation timed out before behavioral tests started.
- Serial rerun of `p2p-transport.test.mjs` and `project-rename.test.mjs`: all 6 passed without source changes.
- Complete rerun against task-owned temporary PostgreSQL: **215 passed, 0 failed, 0 skipped**, 121.28 seconds; no source changes were required.

## Upstream feasibility probe

The pinned upstream root package compiled with `CGO_ENABLED=0`, and its real
`TestTailcat` passed against its local DERP/STUN fixture (1.185 seconds). This
establishes buildability and basic upstream connectivity on the development Mac,
not Coflux integration or internet NAT success.

The first default-CGO link failed because the host linker rejected the installed
macOS 27 SDK's `arm64e.x1` TBD entries. Pure-Go compilation avoids that host toolchain
mismatch without altering or downgrading upstream source. Use the same explicit
CGO-free build mode for the helper unless a required feature proves incompatible.

## Acceptance status

Implementation, signed bundle delivery, Coflux terminal acceptance, network-fault
matrix, resource soak, cross-machine comparison, and packaged-app acceptance are
not yet complete. No performance or production-readiness claim is made.
