# Plan 078: Web optimistic UI and a cold-start overlay—hide international RTT from interaction

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 0dc8ee9..HEAD -- apps/web/index.html apps/web/src packages/client/src/store.ts apps/server/src/hub.ts`

## Status

- Priority: P1
- Effort: M
- Risk: MED
- Depends on: none
- Category: feature
- Execution: subagent `dev:kimi-executor` (relay model `kimi-k3`; preflight completed during dev-explore, with `kimi-k3` in `$ANTHROPIC_BASE_URL/v1/models`; do not repeat preflight during execution)
- Planned at: `0dc8ee9`, 2026-08-17

## Requirement

Two frequent interactions in apps/web feel slow because of **international RTT** between residential broadband and prod-jp, currently routed through Surge because of GFW interference. Neither server speed nor center storage is responsible:

1. **Creation provides no immediate feedback.** "New workspace" leaves the UI unchanged for two RTTs plus daemon `git worktree add`. "New terminal tab" shows a loading button but still waits one RTT before adding the tab. Users cannot distinguish a missed click from ongoing work.
2. **Cold start flashes through four states.** First, empty `#root` in `index.html` leaves a blank page during bundle download—the longest stage on international links. Second, React mounts a full-screen spinner. Third, authentication succeeds before the snapshot arrives, so empty `projects`/`workspaces` arrays falsely show "Start with a project / Import project" and an empty sidebar. Fourth, real content arrives. Stage three is semantically wrong: data not received is not empty data.

After implementation:

- Creating a Git workspace or terminal tab inserts and selects its item **within the next frame**, without any network round trip. Server broadcast replaces it in place without a visible switch. Server errors remove it and display the error.
- Cold start has one visual state: a coflux-logo overlay from HTML arrival until workbench data and initial rendering are ready, followed by a fade-out. No blank page or false project-empty prompt.
- The overlay does not hide login from unauthenticated users or trap users on the logo forever when center is unreachable.

**Explicitly rejected adjacent solution**: do not change center storage or data models. dev-explore ruled out removing center persistence and fetching everything from daemons: offline visibility of devices/terminal state, prepared operations queued for offline devices that need stored `repoPath`, and fast cold starts using one local PG query instead of N daemon RTTs all depend on persistence. Removing it would not improve this plan's latency at all. This is **frontend-only**.

## Decisions & tradeoffs

- **Store optimistic state in apps/web component state**, merging it with store data when rendering. Rejected: injecting fake records into `packages/client` store. Snapshots **replace** workspace/task arrays, silently erasing fake records (`packages/client/src/store.ts:435-445`); and the shared web/mobile/iOS package must not acquire web-specific optimistic semantics. Based on that snapshot path and `apps/web/package.json`'s `@coflux/client: workspace:*` dependency.
- **Host the overlay directly under `<body>` in `index.html`, outside `#root`**, then let React remove it when ready. Rejected: a React-only overlay misses the longest blank-bundle-download stage. Placing it inside `#root` also fails because `createRoot` clears the container at mount and exposes stages two/three. Based on empty `<div id="root"></div>` in `apps/web/index.html` and mounting in `apps/web/src/main.tsx`.
- **Dismiss on `snapshotRevision > 0`**, meaning first snapshot received. Rejected: waiting for first terminal attach adds daemon RTT and can delay slow/offline devices until fallback timeout, worsening the experience. The terminal area's own attaching state is legitimate local loading, not the flicker being removed. Based on increment at `packages/client/src/store.ts:444` and post-snapshot selection reconciliation at `workbench.tsx:98-115`.
- **Two mandatory alternative escape conditions**: dismiss immediately for `authState` `need-login` or `auth-failed`, so login remains accessible; and dismiss unconditionally eight seconds after React mounts, so unreachable center does not permanently hide the disconnected/reconnecting banner. Either condition suffices. Based on `CredentialsForm` at `workbench.tsx:314-330` and banner at `:431-436`.
- **Use plain HTML and inline CSS for the index.html overlay**, without Astryx components or Tailwind tokens. This is an **intentional, narrow exception**: the overlay must appear before React and CSS bundles, when the design system does not exist. Its background must match `<meta name="theme-color" content="#111214">` to avoid a white-to-dark flash. This exception applies **only to the index.html overlay**. New React UI—pending items/tabs/creation prompts—must follow Astryx, with no bare `<div>` layout or raw hex/px. Based on index.html theme-color/color-scheme and `apps/web/.claude/CLAUDE.md`.
- **Optimism covers only Git workspace creation and top-bar terminal-tab creation.** Rejected: initial device terminal creation via `createDeviceTerminal` is infrequent, already has button `isLoading`, and adds `fsList(~)` round-trip and idempotent reuse complexity. Based on directory-list then terminalCreate at `workbench.tsx:172-183`, and per-device reuse at `apps/server/src/hub.ts:1570-1582`.
- **Rollback on store `lastError`**, removing the corresponding pending item and using existing error overlay. Also use a separate local timeout, independent of the overlay's eight seconds; executor chooses a value on the order of tens of seconds. This prevents permanent pending state if neither success nor error arrives. Rejected: success-only handling, because nonexistent project, deleting project, and offline daemon workspaceCreate failures return only errors, never workspaceCreated. Based on `hub.ts:1516-1528` and existing lastError pending cleanup at `workbench.tsx:211-214`.
- **(Decided while planning) Fade the overlay out**, around 200ms, rather than cutting abruptly. A hard final switch would restore the visual jump the overlay exists to eliminate.
- **(Decided while planning) Fix the false empty state itself.** `projects.length === 0` does not mean no projects before snapshot arrival. Never render the introductory empty state before data arrives. Login/timeout escape paths may expose the underlying UI; masking alone is insufficient. Based on `workbench.tsx:413-428`.

## Direction

Three frontend-only milestones. The web project has no tests under the `arch-web` no-frontend-tests convention, so each uses the same build/type-check command. The user performs behavioral acceptance under the established no-frontend-verification practice; see Commands.

Milestones are independent and may run in any order, but the suggested order solves the hardest problem—preventing existing selection reconciliation from ejecting pending items—in milestone 1, then reuses it in milestone 2.

### Milestone 1: Immediate Git workspace creation feedback

Within the next frame, add a visibly pending workspace under its sidebar project, select it, and show a creation prompt in the main area. `workspaceCreated` replaces it in place and preserves focus without another navigation. Error broadcast or timeout removes it and shows the existing error overlay.

Hard constraint: pending IDs never enter attach state machines or generate requests to nonexistent IDs.

Validation: `pnpm --filter @coflux/web build` exits 0.

### Milestone 2: Immediate terminal-tab creation feedback

Within the next frame, insert and select a pending tab. taskCreate broadcast replaces it with the real tab in place. If the user switched tabs while waiting, finalization must not reclaim focus. Errors/timeouts remove it.

The same hard constraint applies: no pending tab enters attach/activation state machines or generates fake-taskId requests.

Validation: `pnpm --filter @coflux/web build` exits 0.

### Milestone 3: One cold-start visual state

index.html shows the logo immediately on HTML arrival while workbench renders beneath it. Fade after `snapshotRevision > 0`; dismiss immediately for login, and unconditionally after eight seconds from React mount. Do not show the project-introduction empty state before snapshot arrival.

Validation: `pnpm --filter @coflux/web build` exits 0.

## Landmines

- **Selection reconciliation ejects pending workspaces**: `workbench.tsx:98-115` validates selection whenever workspaces changes. IDs absent from workspaces/daemons fall back to the first project's main workspace. Pending IDs are necessarily absent, so immediate selection can be undone in the same frame. This is the easiest pitfall to introduce and hardest to notice.
- **Tab activation also resets**: `workspace-terminal.tsx:352-360`'s `useEffect([workspaceTasks])` selects workspaceTasks[0] without a valid currentActive. Pending tabs are absent too.
- **Coordinate existing unknown-ID detection with optimism**: `pendingWorkspaceCreateRef` at `workbench.tsx:190-215` captures known IDs and selects a newly broadcast workspace in the project. `pendingCreateRef` at `workspace-terminal.tsx:313-320 / 343-351` does the same for tabs. Reuse this finalization detection; a separate switching mechanism causes double focus jumps.
- **Snapshots replace arrays** at `packages/client/src/store.ts:435-445`, including after reconnect. Fake store entries would silently vanish.
- **`createRoot` clears `#root`**: put the overlay outside it.
- **`snapshotRevision` keeps increasing after reconnect**. `> 0` is safe as a once-ready condition, not a current-connection indicator; disconnect retains its last value and should display the existing banner, not the overlay.
- **Idempotent terminalCreate does not broadcast workspaceCreated**: `hub.ts:1570-1582` reuses a device directory workspace and creates only a task. Extending optimism to the excluded initial-device-terminal path would wait forever for workspaceCreated.

## Scope

In scope:

- `apps/web/index.html`
- `apps/web/src/components/workbench/workbench.tsx`
- `apps/web/src/components/workbench/workspace-terminal.tsx`
- `apps/web/src/components/workbench/sidebar.tsx`
- `apps/web/src/index.css` only if needed for overlay/workbench transitions
- New components/hooks under `apps/web/src/` as needed

Out of scope:

- `packages/client/**`: optimistic state stays outside shared store
- `apps/server/**`, `crates/**`, `proto/**`: frontend-only; zero server/daemon diff
- Frozen `apps/mobile/**`
- `ios/**`: separate mobile work
- Initial `createDeviceTerminal` path
- Any center storage/data-model change, explicitly rejected above

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Build and type check | `pnpm --filter @coflux/web build` | exit 0 |
| UI acceptance | User checks flicker-free cold start, immediate feedback at both creation entry points, rollback, and accessible login | Performed by user |

## Done criteria

- [ ] `pnpm --filter @coflux/web build` passes.
- [ ] Git workspace creation inserts/selects pending sidebar/main content within one frame; broadcast finalizes in place without refocusing; error removes pending state.
- [ ] Terminal-tab creation inserts/selects within one frame; finalization respects subsequent manual tab switching; failure removes it.
- [ ] Optimistic items never generate fake-ID requests or enter attach/activation state machines.
- [ ] HTML arrival shows the logo; snapshot readiness fades it; login and eight-second timeout dismiss it; no pre-snapshot project-empty prompt.
- [ ] Background matches theme-color `#111214`, with no white flash.
- [ ] New React UI follows Astryx, with no bare `<div>` layouts/raw hex/px; raw CSS is confined to the index.html overlay.
- [ ] No changes to excluded packages/client, apps/server, crates, proto, apps/mobile, or ios files.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- Cited facts change, such as snapshot replacement, snapshotRevision semantics, or selection reconciliation.
- Out-of-scope changes are required, especially a claimed need to put optimism in `packages/client`: stop and report rather than changing shared semantics.
- Build fails twice consecutively after one reasonable fix.
- Immediate selection irreconcilably conflicts with selection/activation state machines: report the conflict; do not bypass it with timing hacks such as `setTimeout`.

## Maintenance notes

- Dismissal depends on first full snapshot. If sync becomes incremental without that event, update the condition or every startup will wait eight seconds.
- Inline overlay CSS is a small design-system exception easily missed during theme changes. Update theme-color, color-scheme, and overlay background together to avoid flashes.
- This fixes perceived latency, not actual RTT. Routing domestic traffic through the existing bj relay to avoid disrupted direct routes is separate work requiring its own plan.

### Original source references

`apps/web/src/components/workbench/workbench.tsx:98-115`, `apps/web/src/components/workbench/workbench.tsx:314-330`, `apps/web/src/components/workbench/workbench.tsx:172-183`, `apps/server/src/hub.ts:1516-1528`, `apps/web/src/components/workbench/workbench.tsx:211-214`, `apps/web/src/components/workbench/workbench.tsx:413-428`, `apps/web/src/components/workbench/workspace-terminal.tsx:352-360`.
