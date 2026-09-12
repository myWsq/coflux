# Plan 019: Terminal-tab port forwarding: PlugZap icon and HoverCard preview links

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 5465ab8..HEAD -- apps/web/src/components/workbench/workspace-terminal.tsx`

## Status

- Priority: P3
- Effort: S
- Risk: LOW
- Depends on: none
- Category: dx
- Execution: subagent sonnet
- Planned at: `5465ab8`, 2026-07-20

## Requirement

Terminal tabs currently show a port such as `:3000` after the title (`workspace-terminal.tsx:439`), but only `taskPorts[0]`; additional ports have no visible links.

For `taskPorts.length > 0`, replace the inline port text with a `PlugZap` icon indicating available forwarding. Hovering opens a HoverCard with one row per port, each showing the number and a clickable preview link opening a new tab. Tabs without ports remain unchanged.

The boundary between the correct solution and the plausible but incorrect solution:
- The icon must be just the anchor point of the HoverCard for both single port and multi-port - the special case of "clicking the icon to jump directly" must not be added to a single port (interaction unification).
- The links in the panel must be truly clickable (this is the only reason to choose HoverCard instead of Tooltip).
- The existing list of port links on the right side of the top bar (`:463-478`) **remains untouched** - this plan does not touch it, and the active tab showing the port in both places for a short time is an accepted trade-off.

## Decisions & tradeoffs

- **Use Astryx HoverCard, not Tooltip.** HoverCard supports interactive content and its default 200ms hideDelay lets the pointer move into the panel to click links. Tooltip is documented for short, noninteractive text and closes when hovering its content, preventing the required navigation. Evidence: `@astryxdesign/core/dist/Tooltip/useTooltip.d.ts` and `@astryxdesign/core/dist/HoverCard/HoverCard.d.ts:92`. The APIs have the same shape: `<HoverCard content={<panel>} placement="below">{trigger}</HoverCard>`.
- **Use lucide-react `PlugZap`, explicitly selected by the user.** Do not substitute Globe/Radio/Network. Add it to the existing lucide-react import (`workspace-terminal.tsx:4`).
- **Use the icon only as a HoverCard anchor for both one and multiple ports.** Add no direct-navigation special case or count badge. Uniform interaction avoids unnecessary branches, as agreed in the requirements.
- **Follow the top-bar link semantics/style at :466-475:** `<a href={preview.url} target="_blank" rel="noreferrer">`, a port number, and an icon in small monospace text. Copy-URL and embedded iframe previews are out of scope. Evidence: `workspace-terminal.tsx:463-478`.
- **Retain the top-bar port list.** Scope this change to tab :439, following the exploration choice to keep the top bar and add a tab icon.
- **Follow this file’s DOM + Tailwind conventions (decided during planning).** Its div/button/a elements use tokens such as text-muted-foreground and bg-accent; write the panel similarly. Applying apps/web/.claude/CLAUDE.md’s no-div/Astryx-only layout rule here would conflict with the surrounding file. Evidence: `workspace-terminal.tsx:413-478`.

## Direction

Single file changes, only `apps/web/src/components/workbench/workspace-terminal.tsx`.

The data does not need to be changed: `taskPorts = ports[task.id] ?? []` (`:417`) is already in the rendering scope, and each `PortPreview = { port, url }` contains a ready-made URL.

### Milestone 1: Tab port text replaced with PlugZap + HoverCard

Replace `<span>:{taskPorts[0].port}</span>` at `workspace-terminal.tsx:439` with a PlugZap HoverCard trigger when taskPorts.length > 0. Use `taskPorts.map` to map every port to a row with its number and an `<a target="_blank" rel="noreferrer">` opening preview.url. Render nothing for no ports. Leave the top bar at :463-478 untouched.

Verification: `pnpm --filter @coflux/web build`→ exit 0 (`tsc -b` passes, which means the type is correct).

## Landmines

- **Do not nest the trigger inside the title `<button>`** (`workspace-terminal.tsx:426-440`). HoverCard’s focusable button/span trigger would create nested interactive controls and conflicting events. Place HoverCard directly under the tab container div (:419), between the title button ending at :440 and close-button Tooltip at :441, as a sibling.
- **`HoverCard` needs to be imported from `@astryxdesign/core/HoverCard`** (same origin and different subpaths as `Tooltip`, see the `Tooltip` import writing method `@astryxdesign/core/Tooltip` of `:8`).
- HoverCard defaults to `placement='above'`; the tab should pop down in the top bar and panel, use `placement="below"` (the same as the Tooltip usage in the same file, such as `:441`).

## Scope

In scope:
- `apps/web/src/components/workbench/workspace-terminal.tsx`

Out of scope:
- `workspace-terminal.tsx:463-478` (top bar port link list) - explicitly left unchanged
- `apps/web/src/client/store.ts`, protocol layer - the port data model does not need to be changed
- "Summary of all forwarding ports" in the lower left corner of the device - create a separate plan, with different data sources and destinations

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Typecheck + build | `pnpm --filter @coflux/web build` | exit 0 |
| UI acceptance (acceptance) | Start `pnpm dev:web` and open a terminal with a listening port tab | tab displays the PlugZap icon (no naked port number); hover popup panel lists all ports; click the link in the panel to open the preview URL in a new tab; tab without port has no port element |

## Done criteria

- [ ] `pnpm --filter @coflux/web build` passes (exit 0).
- [ ] Tabs with ports display the PlugZap icon instead of the `:port number` text; hover expands the HoverCard panel and lists **all** ports (no longer only the first one is displayed), and each row of links can be clicked to open `preview.url` in a new tab.
- [ ] Portless tabs do not render any port-related elements.
- [ ] The top bar `:463-478` port link list has not been changed.
- [ ] Single-port and multi-port interactions are consistent (the icons are only HoverCard anchor points, and there is no direct jump exception).
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status updated.

## STOP conditions

- `@astryxdesign/core/HoverCard` does not exist or content does not support interactive content (conflicts the facts on which Decisions are based).
- To achieve this appearance, you need to modify the files outside the scope.
- `pnpm --filter @coflux/web build` failed twice after a reasonable fix.

## Maintenance notes

- If the duplicated top-bar and tab-panel links are consolidated later, remove the top-bar section at :463-478 and retain this panel as the sole entry.
- A future device-wide port summary can aggregate `ports` (`store.ts:33`) across tasks and render near the device list. It has different data/placement and need not share files with this plan.
