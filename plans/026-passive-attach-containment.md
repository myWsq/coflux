# Plan 026: Observer clients will no longer passively seize terminal control

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 723e4e0..HEAD -- apps/web/src/components/workbench/workspace-terminal.tsx apps/web/src/components/workbench/terminal-pane.tsx apps/server/src/hub.ts`

## Status

- Priority: P1
- Effort: S
- Risk: MED
- Depends on: none
- Category: bug
- Execution: subagent sonnet
- Planned at: `723e4e0`, 2026-07-23

## Requirement

With a second client open for the same account—another tab, a forgotten PWA window, or another device—each new terminal is taken over by the other client within one second, showing the “taken over by another client” banner. Refreshing/reconnecting an observer also takes over every RUNNING terminal held by its peer. Evidence from two browser contexts: observer B took over a terminal 500ms after A created it, and B logging in immediately took over A’s existing terminals.

Root cause: A creates a terminal → server creates the session with holder=A (`apps/server/src/hub.ts:1076`) → `taskUpdated` broadcasts → B mounts keepalive `TerminalPane` instances across workspaces → the new pane calls `onSessionReady` (`terminal-pane.tsx:430`) → `handleSessionReady` unconditionally calls `beginAttach` for RUNNING tasks not launched by B (`workspace-terminal.tsx:207`) → server `setHolder` removes A and sends `taskDetached` (`hub.ts:189`).

After completion, a client requests control **only for the terminal the user is viewing**: the `WorkspaceTerminal` instance has `active===true` and the task is its active tab. Background panes, hidden workspaces, and inactive tasks on an observer page send no `taskStart` and acquire no holder. Clicking a task tab takes over through `requestActivation`. Creating a terminal on A no longer lets B steal it while B views another task or none.

The boundary between correct solution vs plausible but incorrect solutions:
- Incorrect: changing only `handleSessionReady`, leaving the `snapshotRevision` reconnect effect unchanged. B would still take over all tasks on every reconnect, fixing only half the bug.
- Incorrect: removing automatic `requestActivation` for the first task on page load (`workspace-terminal.tsx:296-297`). That visible terminal counts as being viewed; removing activation produces an empty terminal on opening. Preserve this behavior.
- Incorrect: changing server `setHolder`/attach semantics. Explicit handoff is intentional and protected by `tests/src/handoff.test.mjs`. Make no server changes.

## Decisions & tradeoffs

- **Restrict passive web attachment without changing server semantics**: passive `beginAttach` is allowed only when the instance’s `active` prop is true and the task is the active tab. Rejected: a read-only observer protocol for simultaneous viewing, which spans proto/server/web and needs a separate requirement. Rejected: server attach that does not acquire the holder, which breaks explicit takeover through tab/banner clicks and `tests/src/handoff.test.mjs:14`. The passive entry points are `apps/web/src/components/workbench/workspace-terminal.tsx:207` (`handleSessionReady` else branch) and `:320-332` (snapshotRevision reattach-all effect).
- **Keep reconnect attachment for the viewed task**: after snapshotRevision changes on reconnect/relogin, the server has cleared the old holder (`apps/server/src/hub.ts:1211`), so the visible terminal must request it again or become read-only. Filter only inactive/invisible tasks. Rejected: deleting the whole effect, which breaks input after reconnect. See the documented reconnect semantics at `workspace-terminal.tsx:318-319`.
- **Preserve the self-initiated launch path**: tasks in `launchingTaskIdsRef` still call markOwned directly without a second taskStart (`workspace-terminal.tsx:196-205`).
- **Unattached RUNNING tasks must not spin forever** (decided while planning): `stateOf` and its inline counterpart default to attaching when controlState is absent (`workspace-terminal.tsx:368`, `:509`). After this fix, background tasks may remain intentionally unattached; an endless spinner would falsely suggest a hang. Give them neutral presentation, such as a normal terminal icon. The executor may add a minimal state literal if needed, with no new user-facing copy.
- **Use the existing takeover path on tab click**: unattached task → `requestActivation` → `performActivation` → `beginAttach(force=false)`. Its deduplication key `${snapshotRevision}:${sessionId}` has not been recorded, so attachment proceeds without new protocol or force semantics (`workspace-terminal.tsx:130-150`).
- **Accepted residual behavior**: two clients actively viewing the same terminal can still take it over from each other, including automatic first-task activation when an observer opens the page. This follows the single-holder model; the takeover banner exists for this case.

## Direction

Single milestone, all changes at `apps/web/src/components/workbench/workspace-terminal.tsx`.

### Milestone 1: Passive attach converges to a visible and active terminal

The non-launch branch of `handleSessionReady` and the snapshotRevision reconnect effect call `beginAttach` only when the instance has `active===true` and `task.id === activeTaskIdRef.current`. Other tasks send no `taskStart`. Unattached RUNNING tabs show a neutral icon, neither spinner nor detached state, and use the existing takeover path when clicked.

Validation: `pnpm --filter @coflux/web build`→ exit 0 (including `tsc -b`).

## Landmines

- Always retain `sessionReadyRef.current.set(taskId, sessionId)` at the start of `handleSessionReady` (`workspace-terminal.tsx:199`). Both `performActivation` and `beginAttach` gate on `sessionReadyRef` (`:134`, `:160`); skipping registration makes later tab clicks silently fail forever. Restrict only the subsequent `beginAttach` call.
- Reading `active` directly inside `handleSessionReady` risks stale render closures: TerminalPane may invoke the callback from any render generation. Mirror the current value in a ref, as already done for `activeTaskIdRef` (`workspace-terminal.tsx:80-83`) and described by landmine 17 at `:67-69`.
- The RUNNING fallback to attaching appears twice: `workspace-terminal.tsx:368` and `:509`, the latter supplying TerminalPane `controlState`. Update both when changing presentation.
- `TerminalPane.onData/onResize` permits input only when `controlState === "owned"` (`terminal-pane.tsx:270-274`), naturally blocking unattached input. If adding a state literal, inspect all `TerminalControlState` checks in `terminal-pane.tsx`.

## Scope

In scope:
- `apps/web/src/components/workbench/workspace-terminal.tsx`
- `apps/web/src/components/workbench/terminal-pane.tsx` (only if new TerminalControlState literals and corresponding comparisons are needed)
- `plans/026-passive-attach-containment.md`, `plans/README.md` (status update)

Out of scope:
- `apps/server/src/hub.ts`, `proto/`, `packages/protocol/` — — server/protocol semantics remain unchanged, active takeover behavior is protected by black-box testing
- Read-only observation by multiple clients (direction B): a separate requirement.
- `tests/src/*` — This change is purely web-based, and no new additions are needed for protocol layer black-box testing.

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Typecheck + build | `pnpm --filter @coflux/web build` | exit 0 |
| Protocol layer regression (acceptance) | `cd tests && COFLUX_TEST_PG_URL=postgres://postgres:postgres@127.0.0.1:54322/postgres pnpm test` | exit 0 |
| Dual-terminal behavior recurrence (acceptance) | Dual-browser context: B watches (activate Tab for other tasks or empty), A creates a new terminal → A does not have the "Has been taken over by another client" banner within 12s; B clicks the terminal tab → A displays the banner | Matches the described behavior |

Note: Worktree has no dependencies installed, so `pnpm install` must be installed before building.

## Done criteria

- [ ] `pnpm --filter @coflux/web build` passed.
- [ ] A spectator client with another task active sends no taskStart and causes no takeover banner on the holder, verified with two browser contexts.
- [ ] After reconnection, the activated terminal will still automatically regain control; inactive tasks will not be re-preempted.
- [ ] The unattached RUNNING task Tab does not have a permanent spinner, and it can be taken over normally by clicking on it.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.
- The actual `handleSessionReady`/`beginAttach`/`performActivation` gating differs from the referenced behavior. Check for concurrent drift before continuing.

## Maintenance notes

- This restriction depends on attach acquiring the holder (`hub.ts` `startOrAttachTask`/`attachSession`). If read-only observation is later implemented (direction B), revisit it as an input-focus acquisition rule.
- Opening an observer page still takes over its first task through automatic activation. If that remains disruptive, consider changing initial activation to click-to-attach, accepting an initially blank terminal.
