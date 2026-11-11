---
name: release
description: Cut a Coflux release end to end — decide from the changed paths which of the two release lines (desktop `v<semver>`, iOS `ios-<N>`) and whether a centre deploy are due, deploy the centre first when needed, bump the version and write the release notes, tag, push and watch the workflows, then report. Use when the owner asks for a release, e.g. "发版", "发个版", "release", "cut a release", "ship a version", "publish iOS", "发 TestFlight", "deploy and release".
---

# Release

The owner's release request is the authorization: decide, then run it to the end without asking
again. Stop and report only when a step fails in a way this procedure does not cover.
Detail lives in [docs/RELEASING.md](../../../docs/RELEASING.md) (release lines, recovery, secrets) and
[docs/deployment.md](../../../docs/deployment.md) (the centre); read the matching section before
acting on it.

## 1. Decide

```sh
git fetch --prune --tags origin
git tag --sort=-creatordate --list 'v*' | head -1      # last desktop release
git tag --sort=-creatordate --list 'ios-*' | head -1   # last iOS release
ssh coflux-bj 'git -C /opt/coflux rev-parse HEAD'      # commit the centre runs (root@82.157.104.55)
git diff --stat <ref> origin/main -- <paths>           # once per line, with the paths below
```

| Line | Due when `origin/main` changed, since its reference, anything under |
| --- | --- |
| Desktop (`v*`), since the last `v*` tag | `apps/desktop`, `crates/`, `packages/cli`, `packages/client`, `packages/core`, `packages/executor`, `packages/protocol`, `native/`, `transport/tailcat` (outside `cmd/coflux-transport-ios`), `integrations/claude-plugin`, `proto/` |
| iOS (`ios-*`), since the last `ios-*` tag | `apps/ios`, `packages/swift-client`, `scripts/build-ios-transport.mjs`, `transport/tailcat`, `proto/` |
| Centre deploy, since the deployed commit | `apps/server`, `packages/protocol`, `packages/core` |

Docs, plans, tests and CI-only changes release nothing. State the decision and its reason in one
line (for example "desktop + centre: apps/desktop and apps/server changed; iOS unchanged since
ios-1790"), then proceed. If nothing is due, say so and stop.

## 2. Preconditions

- Work in a worktree on a branch cut from `origin/main`; never switch the main worktree's branch.
- `main` CI is green: `gh run list --workflow ci.yml --branch main --limit 1`.
- Nothing in flight: `gh run list --workflow <name> --limit 3` shows no queued or running
  `release`, `npm-publish` or `ios-release` run.

## 3. Centre first (when due)

Follow [deployment.md, Server deployment](../../../docs/deployment.md#server-deployment), one ssh
command per step, never chained with `&&`:

1. Back up with `pg_dump -Fc` into `/var/backups/coflux/` and check the dump with `pg_restore -l`.
2. `git fetch` with a short timeout (`timeout 60 git fetch --tags origin`); when GitHub is
   unreachable from the host, create a `git bundle` locally, `scp` it over and fetch from it.
3. `git checkout --detach <commit>`: the release tag when a desktop release ships the same code,
   otherwise the `origin/main` commit.
4. `pnpm install --frozen-lockfile`, then `systemctl restart coflux-server`.
5. Verify: `systemctl is-active coflux-server`, `curl -sS http://127.0.0.1:8787/health`, the boot
   lines in `journalctl -u coflux-server`, `coflux.schema_migrations`, and that daemons reconnect
   (`coflux device list`).

A one-way migration is named in the release notes. Exception to the order: a breaking protocol
change (raised `CONTROL_PROTOCOL_VERSION` / server minimum) ships the desktop release first and
deploys the centre after it.

## 4. Desktop line (`vX.Y.Z`)

1. Choose the version (SemVer above the last `v*` tag), then `pnpm release:version X.Y.Z`.
2. Write `docs/releases/X.Y.Z.md`: English, no Han characters, starting with `# Coflux X.Y.Z`;
   user benefits, install/upgrade notes, one-way migrations, and whether headless hosts must run
   `cofluxd update && cofluxd restart` (launcher or CLI changed) or `cofluxd restart --ptyd` (ptyd
   changed). Add it at the top of [docs/releases/README.md](../../../docs/releases/README.md).
3. `pnpm release:check vX.Y.Z`, commit, `git push origin HEAD:main` (rebase onto `origin/main`
   first if it moved).
4. Tag that commit, which must be the `origin/main` tip, and push only that tag:
   `git tag vX.Y.Z <commit>`, `git push origin refs/tags/vX.Y.Z`. Never `--tags`, never two tags
   at once.
5. Watch `release`, then `npm-publish` (`gh run watch <id>`). Keep `main` still until npm finishes.
   The registry may lag a few minutes after `+ cofluxd@X.Y.Z`; check with `npm view cofluxd version`.

On a failure, see [RELEASING.md, Recovery](../../../docs/RELEASING.md#recovery) before re-running
anything: a full re-run after the GitHub Release exists is refused by the mirror gate.

## 5. iOS line (`ios-<N>`)

1. Tag the release commit (the desktop release commit when both lines ship, otherwise the
   `origin/main` tip): `N=$(git rev-list --count <commit>)`, `git tag ios-$N <commit>`,
   `git push origin refs/tags/ios-$N`.
2. Watch `ios-release` (`gh run list --workflow ios-release.yml --limit 1`, `gh run watch <id>`).
   Processing on App Store Connect takes 10-30 minutes inside the distribution step.
3. When only distribution failed (the log says the build is uploaded), rerun without re-uploading:
   `gh workflow run ios-release.yml --ref ios-$N -f tag=ios-$N -f distribute_only=true`.

## 6. Report

Report to the owner in Chinese: what shipped (versions, tags, run links), what was deployed and
the centre's commit, backup file names, one-way migrations, and anything left for the owner
(devices needing `cofluxd update` / restart, failures, follow-ups).
