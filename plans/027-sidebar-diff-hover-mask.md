# Plan 027: Shared hover mask for sidebar workspace suffixes; keep diff statistics last

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat aa514dd..HEAD -- apps/web/src/components/workbench/sidebar.tsx`

## Status

- Priority: P2
- Effort: S
- Risk: LOW
- Depends on: none
- Category: bug
- Execution: subagent sonnet
- Planned at: `aa514dd`, 2026-07-23

## Requirement

When hovering a sidebar workspace row, the absolutely positioned delete button at the right edge (X, roughly 24px) overlaps diff statistics such as “−2” without a fade. The existing right-edge `mask-image:linear-gradient` applies only to the custom-name span. Plan 024 (f2ac56b) inserted diff statistics to its left without sharing the mask; with no custom name, the diff becomes the trailing element beneath the button.

The user also explicitly requested that diff statistics remain last in the row: change `branch name → diff stats → custom name` to `branch name → custom name → diff stats`.

Required outcomes:

1. Hovering a non-main workspace fades the trailing custom name and diff statistics together from the right, making room for delete. Both remain fully visible otherwise.
2. Diff statistics, when present, are the final content item, with the custom name to their left.
3. Main-workspace trailing content does not fade on hover because it has no delete button, preserving existing behavior.

## Decisions & tradeoffs

- **Mask placement**: wrap custom name and diff statistics in one trailing container and move the hover-gradient mask from the name span to it. Rejected: copying the mask onto the diff span; duplicate masks can still leave neighboring content under the button when names are short. The existing mask is at `apps/web/src/components/workbench/sidebar.tsx:325-330`; the delete button uses absolute `right-1` and `size-5` at `sidebar.tsx:340-346`.
- **Element order**: move diff statistics after the custom name, as explicitly requested mid-turn. Rejected: retaining diff-before-name order. The current order is visible at `sidebar.tsx:305-336`.
- **Mask only non-main workspaces**: preserve `!workspace.isMain`. Main workspaces have no delete button and need no clearance (`sidebar.tsx:339`, existing mask condition `sidebar.tsx:328`).
- **Retain gradient values**: `linear-gradient(to_left,transparent_18px,black_44px)` is already tuned for right-1 plus a 20px button. Do not redesign it (`sidebar.tsx:329`).

## Direction

This is a single-file JSX/className change with no protocol, data-flow, or state changes. Preserve flex semantics: branch name uses `min-w-0 flex-1 truncate` for remaining width; the trailing container is shrink-0, with the inner name still `max-w-24 truncate`. Preserve h-7 row height and vertically centered buttons.

### Milestone 1: Right container + mask migration + sequence adjustment

Wrap custom-name and diff-stat spans in one container, ordered name then diff. Move the hover mask to that container under the same `!workspace.isMain` condition. Validation: `pnpm --filter @coflux/web exec tsc -b` exits 0.

## Landmines

- The name is conditionally rendered by an IIFE and may be null; diff requires additions/deletions >0 (`sidebar.tsx:306-336`). Both may be absent. Avoid extra spacing by omitting the empty container or ensuring it has zero width.
- The outer button currently separates name/diff through `gap-2` (`sidebar.tsx:299`). After wrapping, supply internal spacing without materially changing density.
- The Tailwind arbitrary-value mask uses underscores for spaces (`[mask-image:linear-gradient(to_left,...)]`). Preserve its escaping.

## Scope

In scope:

- `apps/web/src/components/workbench/sidebar.tsx`

Out of scope:

- `apps/web/src/components/workbench/workspace-terminal.tsx` diff in top bar display — no masking issue; leave unchanged.
- The diff statistics pipeline of daemon/server/proto - a pure presentation layer issue.

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Typecheck | `pnpm --filter @coflux/web exec tsc -b` | exit 0 |
| Build (acceptance) | `pnpm --filter @coflux/web build` | exit 0 |

## Done criteria

- [ ] All listed commands pass.
- [ ] When the non-main workspace is hovered, the content at the right end (name + diff) gradually fades out from the right side, and the delete button no longer obscures the numbers.
- [ ] diff statistics are present at the end of the line content, with the custom name to the left.
- [ ] main workspace behavior unchanged (no mask, no delete button).
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.
- A named assumption is false.

## Maintenance notes

Place future trailing icons/counts inside the same container so the mask covers them automatically. Putting them outside reproduces the bug.
