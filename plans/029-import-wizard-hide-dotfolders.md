# Plan 029: Hide dot-prefixed folders by default in the import wizard, with a header toggle

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 8d7ca3b..HEAD -- apps/web/src/components/workbench/import-project-wizard.tsx`

## Status

- Priority: P2
- Effort: S
- Risk: LOW
- Depends on: none
- Category: feature
- Execution: subagent sonnet
- Planned at: `8d7ca3b`, 2026-07-23

## Requirement

The browse step of the two-step import project wizard (select device → browse folder) currently displays all subdirectories, including hidden folders starting with `.` (`.git`, `.cache`, etc.), and the list is noisy. Change to:

1. Folders starting with `.` are hidden by default.
2. Add a “Show hidden items” Switch in the Dialog header during browse only. The device-selection header retains only its step text.
3. Do not persist the switch: reset it to false whenever the dialog opens.
4. If the path filter starts with `.` (for example `.c` to find `.config`), temporarily include hidden directories even when the switch is off, matching VSCode quick-open behavior. Hide them again when the filter clears.

Filter already-loaded frontend entries. Toggling the switch or entering a dot-prefixed filter **must not request the directory again**. Determine hidden status from entry.name, not the full path.

## Decisions & tradeoffs

- **Filter in `filteredEntries` useMemo**. Rejected: filtering during `loadDirectory`/`setEntries`, which discards data and forces a refetch when toggled. `loadDirectory` already fetches all subdirectories (`apps/web/src/components/workbench/import-project-wizard.tsx:137`); existing text filtering is at `:78-82`.
- **Use Astryx `Switch`** (`@astryxdesign/core/Switch`) labeled “Show hidden items”. Rejected: CheckboxInput; Astryx defines Switch for immediately applied preferences, matching this interaction. Use a compact header layout if needed, possibly `isLabelHidden` with an alternative accessible label, but always provide a visible or accessible label.
- **Use `DialogHeader` `endContent`**: browse shows Switch plus the original “Step 2 of 2” text; device selection shows only the step text. Rejected: path-bar/footer placement, because the user requested the header. `endContent` currently renders stepLabel at `import-project-wizard.tsx:285-294`.
- **State lifetime**: initialize `showHidden` with false in useState and reset it in the `props.open` effect. Rejected: localStorage persistence; per-dialog state is sufficient. See existing reset behavior at `import-project-wizard.tsx:86-99`.
- **Temporarily include dot-prefix matches**: use `showHidden || pathFilter.trim().startsWith(".")`. Rejected: always obeying the switch, since the user confirmed this enhancement.
- **Update the obsolete comment** at `import-project-wizard.tsx:136` stating that all subdirectories, including hidden ones, are shown like Cursor. Describe the new behavior instead.

## Direction

Change one file using React 19 and Astryx, following its existing function-component/hooks structure and the historical convention of Chinese comments.

### Milestone 1: Hidden by default + header switch +`.` prefix allowed

Browse hides dot-prefixed directories by default; the header toggle shows them, a dot-prefixed filter temporarily includes them, and reopening resets the switch. Keyboard highlighting and list length must use the same `filteredEntries`; reuse it rather than introducing another list.

Validation: `pnpm -C apps/web exec tsc -b` → exit 0.

## Landmines

- `highlight`, `listLength`, Tab completion, and Enter navigation all index `filteredEntries` (`import-project-wizard.tsx:84,181,210,228`). Apply hidden filtering there or keyboard selection and rendering will diverge.
- Header controls in `DialogHeader` `endContent` must not overlap the close button’s hit area. Switch `onChange` must not close the dialog or change steps.

## Scope

In scope:
- `apps/web/src/components/workbench/import-project-wizard.tsx`

Out of scope:
- FsList protocol and implementation on daemon/server side - filtering is entirely frontend-side
- File (not folder) display logic - the wizard only lists directories
- Preference persistence (localStorage): explicitly excluded

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Typecheck | `pnpm -C apps/web exec tsc -b` | exit 0 |
| Build (acceptance) | `pnpm --filter @coflux/web build` | exit 0 |

## Done criteria

- [ ] All listed commands pass.
- [ ] Folders starting with `.` are not displayed by default in the browsing step; they are displayed after the switch is turned on; they are temporarily displayed when the filter words start with `.`; the switch is reset to off when the dialog box is reopened.
- [ ] The device step header has no switch, the browse step header has a switch and the step copy is retained.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.
- Astryx Switch cannot render at a reasonable size in header endContent (stop and report if a different component is needed).

## Maintenance notes

The hidden item determination is `name.startsWith(".")`, which only covers Unix conventions; the Windows hidden attribute is not within the scope of this plan (the daemon does not report this attribute). If you need persistence preferences in the future, refer to plan 021's localStorage mode.
