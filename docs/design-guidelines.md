# Desktop UI design guidelines

UI conventions for `apps/desktop/src/renderer`, the Electron desktop client's React renderer. Review these before changing UI. Keep new entries concise: one rule and its rationale.

## Hover hints: use `Tooltip`, not native `title`

Use `@astryxdesign/core/Tooltip` for icon buttons and elements requiring hover explanations. Its `display:contents` wrapper is layout-neutral. Native `title` attributes are **prohibited** for these uses.

Rationale: native titles have uncontrollable system styling, roughly one second of delay, no dark-theme support, and no visibility on touch devices. They conflict with the global Cursor-style tooltips standardized in July 2026.

Exception: `title` is temporarily allowed for truncated text to reveal its full contents, pending gradual migration.

## Workspace activity: SVG dot matrices

Use `ActivityDots` for the four workspace activity states, matching assistant-ui DotMatrix's N×N SVG circles. Running: random flashes in a 4×4 matrix. Awaiting approval: slowly blinking 5×5 exclamation mark. Awaiting an answer: cycling 5×5 ellipsis. Turn complete: static 5×5 check mark. The neutral state remains GitBranch. Do not use `LoaderCircle`, sweeping highlights, Unicode braille, or lucide status icons in this slot.

## Icons: lucide-react, with consistent semantics across clients

Use corresponding icon families for the same meaning on desktop and iOS. Map desktop lucide icons to the nearest iOS SF Symbols, such as `GitBranch` ↔ `arrow.branch` and `Folder` ↔ `folder`. Before adding an icon, check existing imports in `sidebar.tsx` for a reusable choice.
