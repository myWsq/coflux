# Plan 061: Unify iOS login—remove SupabaseAuth and send account/password directly

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat c772ed4..HEAD -- apps/ios`

## Status

- Priority: P1
- Effort: S
- Risk: LOW
- Depends on: plans/059-server-password-auth.md
- Category: migration
- Execution: self
- Planned at: `c772ed4`, 2026-07-28

## Requirement

Align with 060 and 059's shared clientAuth username/password contract. Replace HTTP Supabase access_token→supabase credential with one-hop password credential, deleting Supabase code/constants. Login supports local/password modes; rg excluding generated pb.swift finds no Supabase. Obsolete proto field remains untouched.

## Decisions & tradeoffs

- **Remove supabase credential case**; retain token/password. Delete usesExternalLogin, SupabaseAuth.exchange, authPayload/error forks. No speculative OAuth extension. CofluxClient.swift:21,138-154,307-320,541-548.
- **Delete SupabaseAuth.swift** (:12-44) and Config supabaseURL/supabaseAnonKey/useSupabase (:7-10).
- **Neutral Account/Password copy**, matching 060. Remove Config.useSupabase-driven label/keyboard branching (LoginView:28,31). Email keyboard may remain at executor discretion but cannot depend on deleted switch.
- **No generated Swift changes**, per 059's zero-protocol decision.
- **Token lifecycle unchanged**, authOk tokenStore.write and reconnect at CofluxClient:307-309.

## Direction

### Milestone 1: Credential cleanup

Delete branches/files and clean any explicit project reference. Simulator build below passes, using repository/release.sh's actual scheme/destination if different.

## Landmines

- Planned assumption: remove SupabaseAuth.swift pbxproj reference at :158-159 if explicit. There is no Supabase SPM dependency; only swift-protobuf/SwiftTerm, so leave dependencies unchanged. **Execution finding**: project uses filesystem synchronization, so deleting source needs no pbxproj edit.
- Old HTTP error classification distinguishes invalid_credentials/status (SupabaseAuth:27-35); new errors all come from server authError. Remove classification, do not recreate it.

## Scope

In scope: Client SupabaseAuth deletion/Config/CofluxClient; LoginView; pbxproj only if reference cleanup needed (execution found none); AuthFlowTests/DeviceIntegrationTests/ReducerTests init calls, an execution scope correction after removing usesExternalLogin exposed three missed callers.

Out of scope: generated Swift, other views/terminal/scrolling, server/Web/mobile (059/060).

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Build | `xcodebuild -project apps/ios/Coflux.xcodeproj -scheme Coflux -destination 'generic/platform=iOS Simulator' build` | exit 0 |
| Login acceptance | Simulator to local password-mode server | authOk |

## Done criteria

- [ ] All listed commands pass.
- [ ] `rg -i supabase apps/ios --glob '!*.pb.swift'` returns no matches.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- Cited facts change, excluded work required, or validation fails twice after one reasonable fix.

## Maintenance notes

- User performs device production acceptance; release.sh/TestFlight follows 063 cutover.

Historical integration acceptance uses a local `COFLUX_AUTH=password` server and a created account to complete the login flow.

### Original source references

`apps/ios/Coflux/Client/CofluxClient.swift:21,138-154,307-320,541-548`, `apps/ios/Coflux/Client/SupabaseAuth.swift:12-44`, `apps/ios/Coflux/Client/Config.swift:7-10`, `apps/ios/Coflux/Views/LoginView.swift:28,31`, `apps/ios/Coflux/Client/CofluxClient.swift:307-309`, `apps/ios/Coflux.xcodeproj/project.pbxproj:158-159`, `SupabaseAuth.swift:27-35`.
