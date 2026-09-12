# Plan 048: Component Tooltip for terminal tabs—status, device, and diagnostics

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 4e86465..HEAD -- apps/web/src/components/workbench/workspace-terminal.tsx apps/web/src/components/workbench/sidebar.tsx packages/protocol/src/gen/coflux/v1/common_pb.ts`

## Status

- Priority: P2
- Effort: S
- Risk: LOW
- Depends on: none
- Category: feature
- Execution: subagent sonnet
- Planned at: `4e86465`, 2026-07-26

## Requirement

Terminal tab main buttons currently use native title (workspace-terminal.tsx:474), delayed roughly one second and limited to task title. Replace with component Tooltip matching sidebar device tooltips (:516-537): bold conclusion/title followed by icon-and-context rows.

User-selected content includes diagnostics:

- Task title, falling back to Terminal, plus state: running/taken over/exited with code N when exitCode exists. Preserve "click to take over again" for detached state.
- Device name and online/offline from task.daemonId lookup; missing record message if absent; creation time, optional sessionId, update time.

Hover should promptly show structured, store-reactive content. Sidebar comments :513-514 explain why native title is unsuitable. Merely wrapping the old string, or inventing a different layout, is insufficient.

## Decisions & tradeoffs

- **Wrap only the main tab button**, replacing its title attribute (workspace-terminal.tsx:471-484). Wrapping container would nest port dropdown/close tooltips at :489/:504.
- **Use already imported @astryxdesign/core Tooltip** (:9), placement="below" matching :504/:516, hasHoverIndication=false matching sidebar:549. Native title delays and does not update with heartbeat/store.
- **Match device structure**: flex flex-col gap-1, bold title, text-xs text-muted-foreground icon rows; Lucide size-3, Monitor for device and executor-chosen suitable time/session/update icons. Reference sidebar:522-537.
- **Combine stateOf(task) and task.status**. Detached takes priority with takeover action hint; EXITED includes code when exitCode!==undefined; RUNNING says running; IDLE/attaching receive concise semantically appropriate Chinese UI copy, wording not fixed. TaskStatus enum at common_pb.ts:558-578. task.status alone would lose takeover meaning.
- **Read daemons directly from client.store**, following useStore at workspace-terminal:47-60, not new props. Match task.daemonId and existing missing-device copy at sidebar:267.
- **Native Date localization to minute precision**, no date library. createdAt/updatedAt are Date.now milliseconds (hub.ts:850,1310); repository has no toLocale/dayjs/date-fns convention.
- **Omit session row when absent**; preserve full value when present, with visual truncate allowed, like optional workerVersion and truncation in sidebar:518/:532.

## Landmines

- Main button only: port DropdownMenu and close button have their own Tooltip at :485-511; wrong wrapper causes double popups or swallowed hover.
- stateOf closes over detachedTaskIds/controlStates. Build content in render, not an external pure helper detached from local state.
- Directory workspaces hide the entire tab bar at :420; no special branch needed in the non-directory tab map.

## Scope

In scope: apps/web/src/components/workbench/workspace-terminal.tsx only.

Out of scope: sidebar layout reference, frozen mobile, iOS, protocol/server/data plane.

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Web types | `node_modules/.bin/tsc -b apps/web/tsconfig.json` | exit 0 |
| UI acceptance | User manual verification under no-Claude-frontend-walkthrough convention | User confirmation |

## Done criteria

- [ ] `node_modules/.bin/tsc -b apps/web/tsconfig.json` passes.
- [ ] Task-tab main buttons have no native title. Hover opens the component-library Tooltip with a bold title/status line and rows for device, creation time, sessionId when present, and update time.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- Cited Tooltip API/tab structure facts change, excluded edits required, or types fail twice after one reasonable fix.

## Maintenance notes

- Device/task tooltips share layout vocabulary in two handwritten sites. Extract common component if a third appears, not prematurely.
- Future state text evolves with stateOf in tab-map title synthesis.

### Original source references

`apps/web/src/components/workbench/workspace-terminal.tsx:474`, `apps/web/src/components/workbench/sidebar.tsx:516-537`, `apps/web/src/components/workbench/workspace-terminal.tsx:471-484`, `packages/protocol/src/gen/coflux/v1/common_pb.ts:558-578`.
