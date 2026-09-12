# Plan 111: Match desktop confirmation dialogs to Cursor: no title bar, footer key hints, and Enter to act

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 34078ff..HEAD -- apps/desktop/src/renderer/components/workbench/dialogs.tsx apps/desktop/src/renderer/components/workbench/workbench.tsx apps/desktop/src/renderer/index.css`

## Status

- Priority: P2
- Effort: S
- Risk: LOW
- Depends on: none
- Category: feature
- Execution: self
- Planned at: `34078ff`, 2026-09-11

## Requirement

Desktop confirmation dialogs (the `apps/desktop` renderer) currently use an ordinary Dialog: a title bar with an × at the upper right, a one-line body, a footer without a divider, a gray Cancel button, and a red action button. Esc and backdrop clicks close it; Enter has no confirmation semantics. The user wants every confirmation dialog to match Cursor's confirmation style (the reference screenshot says “Close this window?”):

- No title bar or ×; the title and subdued description share one content block.
- A divider separates content from the footer.
- Two right-aligned footer buttons have equal height and are one size smaller than today. Cancel is plain text with no fill; the action button is filled. Each includes a subdued key hint immediately after its label: `Esc` for cancel and a return symbol for the action.
- Interaction: Esc cancels, Enter executes the action immediately, and backdrop clicks do nothing.

**Product conclusions (confirmed during exploration)**

1. **Scope**: rebuild `ConfirmActionDialog`; leave its four call sites (remove project, delete workspace, remove device, and stop/close terminal, all in `workbench.tsx`) unchanged. The three rename dialogs (workspace/device/project) and Add Device are form dialogs: keep their title bars and ×, but give their footers the same smaller buttons, plain-text cancel, and key hints.
2. **Action color**: all four actions are destructive; retain red destructive styling instead of copying Cursor's blue primary color. Reserve blue for potential future nondestructive confirmations.
3. **Key-hint appearance**: subdued borderless text, not boxed keycaps.
4. **Unchanged**: the main process's native Server Address `showMessageBox` and iOS.
5. **User-visible acceptance**: any confirmation opens without ×; Enter acts, Esc cancels, and the backdrop does nothing. Both footer buttons show key hints. The four form dialogs use matching footer button sizes, cancel styling, and hints; their Enter submission behavior remains intact.

## Decisions & tradeoffs

- **Foundation**: continue composing the confirmation from Astryx `Dialog` + `Layout`, with `role="alertdialog"` and `purpose="form"`. Rejected: Astryx `AlertDialog` — its ghost cancel and action buttons are fixed, have no `endContent` slot, and cannot change size, so they cannot accommodate the hints. Based on: `apps/desktop/node_modules/@astryxdesign/core/src/AlertDialog/AlertDialog.tsx:181-193` (fixed buttons accepting labels only); `Dialog.tsx:91` (`purpose='form'` disables backdrop dismissal but permits Esc).
- **No title bar**: remove `DialogHeader`; put `Heading level={2}` inside `LayoutContent` and use `Text type="body" color="secondary"` for the description, as Astryx `AlertDialog` does. Rejected: retaining `DialogHeader` while hiding × — the title would still occupy a separate bar, unlike the reference. Based on: `AlertDialog.tsx:166-175`; existing global styles at `apps/desktop/src/renderer/index.css:247-252` already reduce `[role="alertdialog"] h2` to body size and should remain unchanged.
- **Enter to execute**: add `data-autofocus` to the action button. Dialog focuses it on opening; native Enter/Space activates it. **Do not add a keydown listener.** Focusing the red action button immediately deliberately follows Cursor rather than Astryx `AlertDialog` documentation's recommendation to focus cancel. Rejected: intercepting Enter with a dialog keydown handler — an extra keyboard implementation inconsistent with forms' native submit path. Based on: `Dialog.tsx:391-398` (focuses the first `[data-autofocus]` after `showModal()`).
- **Key hints**: use Astryx `Button`'s `endContent` slot for subdued text, such as secondary text one size smaller than the button label. Rejected: Astryx `Kbd` — its bottom-bordered keycap appearance does not match the reference. Based on: `Button.tsx:350-356` (`endContent` inherits button text color and is ignored for `isIconOnly`); `Kbd.tsx:37-55` (keycap styling).
- **Button specifications**: use `size="sm"` across all five dialog footers; cancel uses `variant="ghost"`, confirmation actions use `variant="destructive"`, and form Save/Done buttons retain `primary`. Set `hasDivider` explicitly on `LayoutFooter`. Confirmation requires a divider; the executor may choose form dividers based on the reference, but all five dialogs must be consistent. Rejected: `secondary` cancel — it has a fill, unlike the reference's plain text. Based on: `Button.tsx:133-141` (sm/md/lg), `Button.tsx:203-205` (transparent ghost), and `LayoutFooter.tsx:152` (`hasDivider` defaults to false).
- **Enter in forms**: the three rename dialogs already submit through `<form onSubmit>` plus a hidden submit button. **Do not** add `data-autofocus` to Save: focus must remain in the input. Its return hint is descriptive only. Add Device has only Done; the executor may optionally autofocus it to make Enter close the dialog. Based on: `dialogs.tsx:45-53` (form and hidden submit); `dialogs.tsx:187-189` (keep DeviceRename's empty-name disable logic).
- **Caller contract**: keep the `ConfirmAction` type (title / description / confirmLabel / onConfirm), `ConfirmActionDialog` props, and all four `setConfirmAction` sites unchanged. Based on: `workbench.tsx:454-509`.

## Direction

A refactor in one renderer file, with two independent milestones affecting different components in that file. Complete them sequentially in one package; splitting is not worthwhile.

### Milestone 1: Match confirmations to the reference

Make `ConfirmActionDialog` an alertdialog without a title bar: `role="alertdialog"`, `purpose="form"`; content contains a title and subdued description; a divided footer contains right-aligned sm ghost Cancel (`endContent` `Esc`) and destructive action (`endContent` return symbol, `data-autofocus`) buttons. Leave the four call sites unchanged.
Validation: `pnpm -C apps/desktop typecheck` -> exit 0; `pnpm -C apps/desktop test` -> all pass.

### Milestone 2: Matching form footers

Use the same specifications and hints for footer buttons in `WorkspaceRenameDialog`, `DeviceRenameDialog`, `ProjectRenameDialog`, and `EnrollmentDialog`: size, ghost cancel, endContent hints, and consistent divider policy. Retain title bars and ×, submission behavior, and disable conditions. A small shared footer-button component may live in `dialogs.tsx` or a new file alongside it.
Validation: `pnpm -C apps/desktop typecheck` -> exit 0; `pnpm -C apps/desktop build` -> exit 0.

## Landmines

- `index.css:255-267` uses `button[aria-label="Close"]` to shrink DialogHeader's ×. Removing DialogHeader naturally makes this rule inapplicable to confirmations; do not change CSS for that reason.
- `Dialog.tsx:394` focuses only the **first** `[data-autofocus]`; in confirmations mark only the action button, never cancel.
- Astryx `Button` ignores `endContent` with `isIconOnly` (`Button.tsx:351`); use ordinary labeled buttons for hints.
- `dialogs.tsx` has no unit tests. Desktop tests use node --test without a DOM; passing establishes only the absence of compile-time regressions. The user checks visuals and keyboard behavior on a real machine; do not use Playwright/UI automation, following project practice.

## Scope

In scope:
- `apps/desktop/src/renderer/components/workbench/dialogs.tsx`
- `apps/desktop/src/renderer/components/workbench/` (if extracting a footer-button component)
- `apps/desktop/src/renderer/index.css` (only if hints need a global style; none is expected)
- `plans/README.md`, `plans/111-desktop-confirm-dialog.md`

Out of scope:
- `apps/desktop/src/renderer/components/workbench/workbench.tsx` — all four call sites stay unchanged
- `apps/desktop/src/main/**` — native `showMessageBox` is unchanged
- `apps/desktop/src/renderer/components/workbench/import-project-wizard.tsx` — a list-selection flow, not a confirmation
- `apps/ios/**` — native SwiftUI dialogs are outside this plan
- `@astryxdesign/core` components — no patch or fork

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Typecheck | `pnpm -C apps/desktop typecheck` | exit 0 |
| Unit tests | `pnpm -C apps/desktop test` | exit 0 |
| Build | `pnpm -C apps/desktop build` | exit 0 |
| Manual walkthrough (acceptance) | User checks on a real machine: four confirmations have no ×; Enter acts, Esc cancels, backdrop does nothing, hints are visible; four form footers match and Enter still submits | User confirmation |

## Done criteria

- [ ] All listed commands pass.
- [ ] `ConfirmActionDialog` has no DialogHeader, uses `role="alertdialog"` and `purpose="form"`, autofocuses the action, and has sm buttons, ghost cancel, endContent key hints, and a footer divider.
- [ ] All four form footers match these specifications and hints; title bars and × remain, and form submission/disable logic is unchanged.
- [ ] No keydown listeners and no Astryx `Kbd` / `AlertDialog`.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds, especially the `[data-autofocus]` behavior in `Dialog.tsx` or the `endContent` slot in `Button`.
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.
- A named assumption is false.

## Maintenance notes

- Route future confirmations through `ConfirmAction` and `ConfirmActionDialog`. If nondestructive confirmations need blue actions, add an optional variant to `ConfirmAction` instead of building another dialog.
- Focusing the action means Enter deletes immediately. If a future action has exceptional consequences, make them clear in the copy instead of returning initial focus to cancel and fragmenting the five dialogs' keyboard behavior.
- Hints are static text with no platform detection. Only macOS desktop exists today, but Esc/Enter are equally applicable on Windows.
