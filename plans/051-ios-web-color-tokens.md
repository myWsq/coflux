# Plan 051: Align iOS colors with Web warm near-black tokens

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Stop on any STOP condition. When complete,
> update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat f1377dc..HEAD -- apps/ios/Coflux/`

## Status

- Priority: P2
- Effort: S
- Risk: LOW
- Depends on: none (050 and dark-mode lock f1377dc are complete)
- Category: feature
- Execution: self
- Planned at: `f1377dc`, 2026-07-26

## Requirement

Forced dark mode makes iOS systemBackground pure black, text pure white, and status colors system green/orange/red. This conflicts with Web's Cursor-style warm near-black, subtle layering, and neutral accent (index.css:15-54). Users describe it as too dark.

Use Web tokens throughout iOS: terminal #0a0a0a, background #0f0f0f, surface #151514; foreground #e6e6e3, secondary #75756d; success #4fae6e, warning #c9a227, destructive #e05c6a.

## Decisions & tradeoffs

- **Web index.css :root is truth**. Copy exact hex values into Swift Theme constants without iOS-specific adjustment. System semantic black/white caused the complaint. Source: index.css:31-53.
- **Preserve layered semantics**: terminal backgroundColor/nativeBackgroundColor #0a0a0a; page/list rows #0f0f0f; filled controls use card/secondary/input #151514/#1f1f1e/#2a2a28. Login fields use input.
- **Text roles**: root foregroundStyle defaults foreground; secondaryLabel maps muted foreground; tertiaryLabel uses that color at reduced opacity. Keep native navigation label white, visually close enough to avoid UIAppearance hacks.
- **Status mapping**: green→success, orange running-takeover/main-branch/warnings→warning, red→destructive. Web main branch already uses warning.
- **Keep system glass/chrome**: glassEffect material, navigation bars, confirmationDialog tint remain native under 047/050. Only content colors change.
- **Manual synchronization**, like 048 icons: few rarely changing tokens do not justify a generator.
- **Terminal font/theme also aligned**, added by user during execution: SF Mono 12 via monospacedSystemFont, same family as Web's SFMono-Regular; blinking bar cursor; foreground/cursor #e4e4e4; ANSI 16 colors match xterm. For unspecified Web bright colors, use corresponding normal colors except brightBlack #6a6a6a and brightWhite #ffffff. SwiftTerm exposes no Web lineHeight 1.25 equivalent, so omit it. Source: terminal-pane.tsx:188-212.

## Direction

### Milestone 1: Theme and view migration

Add Theme.swift, replace Views' system colors/green/orange/red/Color.primary with tokens, and set terminal background. Build and residual check below pass.

## Landmines

- Do not commit/restore user project.pbxproj/Coflux.xcscheme signing edits, as in 047–050.
- Set both SwiftTerm backgroundColor and nativeBackgroundColor; otherwise terminal cells retain default black.
- Login primary button is inverted: primary #ececea background and primaryForeground #0f0f0f text. Do not convert it to an ordinary tinted button.

## Scope

In scope: apps/ios/Coflux/Views/** including new Theme.swift, which may sit beside Views or Client.

Out of scope: Web read-only truth, Xcode project/signing, native navigation/glass/system-dialog materials/tint.

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Build | `xcodebuild -project apps/ios/Coflux.xcodeproj -scheme Coflux -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=27.0' build CODE_SIGNING_ALLOWED=NO` | BUILD SUCCEEDED |
| Residual check | `grep -rn 'systemBackground\|secondarySystemBackground\|secondarySystemFill\|tertiaryLabel\|secondaryLabel' apps/ios/Coflux/Views/` | No output, exit 1 |
| Device visual acceptance | Compare Web/device background temperature, text gray, status colors | User confirmation |

## Done criteria

- [ ] Build and residual-reference checks pass.
- [ ] The three background layers, text hierarchy, and status colors exactly match Web token hex values.
- [ ] System materials, including glass capsules and navigation bars, do not regress.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- Cited facts change, excluded changes required, or validation fails twice after one reasonable fix.

## Maintenance notes

- Theme.swift header documents source path and manual Web-color synchronization.
- Consider generation only if token count or theme-change frequency grows.

### Original source references

`apps/web/src/index.css:15-54`, `apps/web/src/index.css:31-53`, `apps/web/src/components/workbench/terminal-pane.tsx:188-212`.
