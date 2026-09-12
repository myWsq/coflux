# Plan 105: Change Desktop Client Admission to the Control-Plane Protocol Version — Replacing Launch-Day build-id Lockstep

## Status

- Priority: P1
- Effort: S
- Risk: LOW
- Depends on: 103
- Category: feature
- Execution: self (the user decided this in session on 2026-09-11; implemented directly in the main session)
- Planned at: `733676f`, 2026-09-11

## Requirement

At launch, plan 103 made desktop admission require the desktop renderer's build-id to have the same SHA as the web deployment in prod (reusing plan 033's browser semantics). Launch day immediately proved this unusable: as soon as prod deployed a new SHA, online desktop clients were kicked to the "Update required" page until CI produced a package and the user manually updated. A small release-order mistake (deploying first and packaging afterward) caused several to more than ten minutes of unavailability. The user judged this "too painful and in need of a more professional solution."

After completion:

1. On desktop login, report `client_kind=desktop` and `control_protocol_version` (the `packages/protocol` constant `CONTROL_PROTOCOL_VERSION`, currently 1). The center rejects it **only** when it is below `COFLUX_MIN_CONTROL_PROTOCOL_VERSION` (default 1); build-id is an identifier only and does not participate in admission.
2. web/mobile (and old clients and iOS without `client_kind`) keep exactly their current behavior: admission remains exact by build-id, and one browser reload obtains the new bundle.
3. Deploying prod no longer kicks out old desktop clients; desktop upgrades in the background through electron-updater. The "Update required" page appears only when the protocol is too old.
4. For breaking protocol changes: increment `CONTROL_PROTOCOL_VERSION`, raise the server's default minimum version accordingly, release desktop first, then deploy prod. `buf breaking` gates this in CI; changes it permits do not need a version increment.

## Decisions & tradeoffs

- **A protocol version constant, not the app semantic version**: admission checks wire-protocol compatibility and is unrelated to the app version (0.1.x); one constant is referenced independently by both sides, so the server does not need to maintain a list of supported desktop versions. Rejected: having the server maintain a desktop build-id list—every desktop release would require a server configuration change. Rejected: using app semver as the minimum version—app versions also increment for UI-only changes and have no relationship to protocol compatibility.
- **Choose the rule by `client_kind`, rather than "use protocol admission whenever a protocol version is present"**: web also carries a protocol version (from the same client code), but web must retain build-id reload semantics (deployment means refresh, which is plan 033's purpose). Based on: the two existing rejection paths in `apps/server/src/hub.ts`'s `handleClientAuth` (clientOutdated / authError) remain unchanged.
- **Put the minimum version in server config (env-overridable, default 1)** rather than directly using the server's own `CONTROL_PROTOCOL_VERSION`: the minimum supported version is a policy about "how old a client we are still willing to serve," not the current version; the default rises in code alongside a breaking change.
- **Do not add fields to `ClientOutdated`**: the actions on the desktop "Update required" page (check for updates/restart installation) do not depend on the reason. The old desktop versions (0.1.0/0.1.1 from the plan 103 launch) do not send `client_kind`, so the center rejects them once under the web build-id rule; updating to a version after this plan restores access—this is the final lockstep.

## Direction

Single milestone: add two optional fields to proto and run `buf generate`; include kind and protocol version in the `packages/client` auth payload; route the server's authentication phase by kind; have desktop `MainPage` pass `clientKind: "desktop"` and change the copy to "No longer supported by the server"; remove the hard check in `desktop-release.yml` requiring build-id to equal HEAD; update the documentation (RELEASING / deployment / AGENTS / ROADMAP / apps/desktop/README).

Validation: add two desktop groups to `tests/src/build-version.test.mjs` (a sufficient protocol version → authOk even with a mismatched build-id; missing protocol version → clientOutdated; web kind unaffected; with `COFLUX_MIN_CONTROL_PROTOCOL_VERSION=2`, version 1 rejected and version 2 accepted); assert the auth payload fields in `packages/client/src/connection.test.ts`; run server/web tsc, buf lint, and generated-artifact consistency checks.

## Scope

In scope: `proto/coflux/v1/client.proto` and its three generated artifacts, `packages/protocol/src/index.ts`, `packages/client/src/{connection,store,index}.ts`, `apps/server/src/{config,hub}.ts`, `apps/web/src/pages/MainPage.tsx`, `apps/web/src/components/workbench/desktop-update.ts`, `.github/workflows/desktop-release.yml`, docs, and tests.
Out of scope: admission semantics for web/mobile/iOS, the `ClientOutdated` message shape, and the daemon.

## Done criteria

- [x] The tests and type checks above pass; CI generated-artifact consistency passes.
- [x] Release a desktop version (0.1.2) and deploy prod at the same SHA—this is the last alignment required; afterward, deploying prod no longer kicks desktop clients.

## Maintenance notes

- Breaking protocol change checklist: increment `CONTROL_PROTOCOL_VERSION` → increment the minimum-version default in `apps/server/src/config.ts` → package `desktop-v*` first → deploy prod afterward. In an emergency, temporarily raise `COFLUX_MIN_CONTROL_PROTOCOL_VERSION` through env.
- iOS does not send `client_kind` and continues to be admitted by build-id (its own registered native build id); this plan does not change that.
