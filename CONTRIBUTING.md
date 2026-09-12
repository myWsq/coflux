# Contributing to Coflux

Thanks for helping improve Coflux. Please open an issue before a large architectural change so we can agree on the problem and scope.

## Getting started

Follow the development setup in [README.md](README.md). The repository uses Node.js 22+, pnpm 11, Rust stable, and PostgreSQL. Desktop work requires macOS.

Use an isolated branch or worktree. Never run tests against your personal Coflux home or a production database. The integration harness already creates temporary homes, databases, and ports.

## Making a change

- Keep pull requests focused. Describe the user-visible problem, the resulting behavior, and how you verified it.
- Use the current Electron app in `apps/desktop` for desktop work. Read [design guidelines](docs/design-guidelines.md) before changing the UI.
- Protocol definitions live in `proto/`. Regenerate bindings and keep Rust, TypeScript, and Swift wire formats consistent.
- Prefer behavior tests through real processes and the public protocol. Avoid tests that only repeat the implementation.
- Preserve terminal ownership, account isolation, and human takeover rules.
- Do not commit credentials, signing keys, personal logs, or local runtime data.

Run checks relevant to your change, plus the full integration suite before merging:

```sh
pnpm -C apps/desktop typecheck
pnpm -C apps/desktop test
pnpm -C apps/desktop build
cargo build -p coflux-supervisor -p coflux-worker -p coflux-cli
node scripts/build-test-transports.mjs
pnpm -C tests test
```

Public README files and release notes are written in English. Internal implementation notes and existing commit conventions are primarily Chinese; clear English issue reports and pull requests are welcome.

## Releases

A maintainer updates the shared version with `pnpm release:version X.Y.Z` and writes `docs/releases/X.Y.Z.md` in English. CI validates the version and release notes. A single `vX.Y.Z` tag publishes the desktop and runtime artifacts, followed by the matching npm package.

See [RELEASING.md](docs/RELEASING.md) for signing, publishing, and verification details.

## Security

Do not post vulnerabilities with exploit details or secrets in a public issue. Use GitHub's [private vulnerability reporting](https://github.com/myWsq/coflux/security/advisories/new).
