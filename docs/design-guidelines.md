# Desktop UI design guidelines

UI conventions for `apps/desktop/src/renderer`, the Electron desktop client's React renderer. Review these before changing UI. Keep new entries concise: one rule and its rationale.

## Hover hints: use `Tooltip`, not native `title`

Use `@astryxdesign/core/Tooltip` for icon buttons and elements requiring hover explanations. Its `display:contents` wrapper is layout-neutral. Native `title` attributes are **prohibited** for these uses.

Rationale: native titles have uncontrollable system styling, roughly one second of delay, no dark-theme support, and no visibility on touch devices. They conflict with the global Cursor-style tooltips standardized in July 2026.

Exception: `title` is temporarily allowed for truncated text to reveal its full contents, pending gradual migration.

## Tooltips on a `DropdownMenu` trigger: never `button.tooltip`

Render a sibling `Tooltip` **after** the menu, anchored to the trigger, and suppress it while the menu is open:

```tsx
const [open, setOpen] = useState(false);
const anchorRef = useRef<HTMLButtonElement | null>(null);
<>
  <DropdownMenu isMenuOpen={open} onOpenChange={setOpen} button={{ ref: anchorRef, /* no tooltip */ }}>…</DropdownMenu>
  <Tooltip anchorRef={anchorRef} isOpen={open ? false : undefined} content={…} />
</>
```

Symptom when `button.tooltip` is used instead: the tooltip stops appearing once the menu has been opened and closed, and only comes back after the pointer leaves and re-enters more than once.

Mechanism: an open `DropdownMenu` drops `button.tooltip`, so `Button` unmounts the tooltip's popover node while it is showing; removing a popover runs the hide algorithm without firing `toggle`, and the layer's open flag — which is only written back from `toggle` — stays stuck at true, swallowing later `show()` calls.

Two consequences worth knowing at the call site: `onOpenChange` fires **only** when `isMenuOpen` is also passed (otherwise the menu is uncontrolled and the callback is dead code), and the sibling `Tooltip` must come after the menu in document order, because its effect binds to `anchorRef.current` and the trigger's ref is only attached by then.

Delete this rule once astryx's `DropdownMenu` no longer contains `tooltip: isOpen ? undefined : button.tooltip` and `Button` no longer conditionally renders its tooltip node; the workaround exists only for the pinned 0.1.6.

## Interactive elements over a window drag region

Anything clickable that sits inside or overlaps a `-webkit-app-region: drag` area must declare `no-drag` **and come later in document order than that drag element**. Order decides the outcome: Electron composes the regions in document order, taking a union for `drag` and a difference for `no-drag`, so a hole punched earlier is filled back in by a `drag` rectangle declared later. A control that loses this race receives no click and no `mouseenter` at all — it reads as dead, not as misstyled. See the header comment in `apps/desktop/src/renderer/components/workbench/drag-region.ts`.

## Workspace activity: SVG dot matrices

Use `ActivityDots` for the four workspace activity states, matching assistant-ui DotMatrix's N×N SVG circles. Running: random flashes in a 4×4 matrix. Awaiting approval: slowly blinking 5×5 exclamation mark. Awaiting an answer: cycling 5×5 ellipsis. Turn complete: static 5×5 check mark. The neutral state remains GitBranch. Do not use `LoaderCircle`, sweeping highlights, Unicode braille, or lucide status icons in this slot.

## Icons: lucide-react, with consistent semantics across clients

Use corresponding icon families for the same meaning on desktop and iOS. Map desktop lucide icons to the nearest iOS SF Symbols, such as `GitBranch` ↔ `arrow.branch` and `Folder` ↔ `folder`. Before adding an icon, check existing imports in `sidebar.tsx` for a reusable choice.
