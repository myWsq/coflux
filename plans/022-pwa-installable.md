# Plan 022: Installable PWA with manifest and icons, without a service worker

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 321ef97..HEAD -- apps/web/index.html apps/web/public apps/web/vite.config.ts`

## Status

- Priority: P2
- Effort: S
- Risk: LOW
- Depends on: none
- Category: feature
- Execution: subagent sonnet
- Planned at: `321ef97`, 2026-07-21

## Requirement

coflux web (`apps/web`, a Vite 6 + React 19 WebSocket-terminal SPA) has neither favicon nor manifest and cannot be installed as a standalone app. Make app.coflux.dev installable through iOS Safari Add to Home Screen, desktop Chrome/Edge, and Android, with a suitable icon and standalone window without browser chrome. Also fix the favicon 404.

Use **no service worker, npm dependency, or build step**: only static manifest/icons and index.html tags. Modern browser installability no longer requires a service worker. This application has no offline value, while a service worker adds stale-cache risk.

## Decisions & tradeoffs

- **No service worker.** Manifest and icons provide installation. Reject vite-plugin-pwa, offline caching, and update prompts: a pure WS terminal gains nothing offline and would incur cache/version maintenance. This was confirmed in the departure check.
- **Place static files in `apps/web/public/`.** Vite copies them unchanged to the dist root, so leave `apps/web/vite.config.ts` alone. A generation plugin would violate the zero-dependency decision. Neither public/ nor related Vite configuration currently exists.
- **Design the icon now and commit rendered artifacts.** Create a simple terminal-style SVG, such as a prompt glyph on a dark `#111214` background, and render PNG sizes once. Do not add sharp or build-time generation for five static images. The executor may use a one-shot CLI such as `pnpm dlx`; macOS sips cannot read SVG. Required public files: `favicon.svg`, `icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, and **opaque** 180×180 `apple-touch-icon.png` (iOS fills transparency with black). Keep maskable artwork within the central 80% safe area, with background padding.
- **Use `manifest.webmanifest`** with name/short_name `coflux`, `display: "standalone"`, `start_url: "/"`, background_color/theme_color `#111214`, 192/512 icons with `purpose: "any"`, and maskable 512 with `purpose: "maskable"`. This matches existing `<meta name="theme-color" content="#111214">` and color-scheme: dark in index.html.
- **Add apple-mobile-web-app-capable and status-bar-style black.** Opaque black does not overlap content; black-translucent would require safe-area-inset work beyond scope. Add `<meta name="apple-mobile-web-app-title" content="coflux">` too.
- **Add `<link rel="icon" href="/favicon.svg" type="image/svg+xml">`** to fix favicon requests. No .ico is needed for the supported modern browsers.

## Direction

### Milestone 1: Icons and manifest

Create all five icons and manifest.webmanifest under apps/web/public/. Ensure valid JSON, fields matching the decisions, paths matching actual files, and PNG dimensions matching declarations. Validation: `pnpm --filter @coflux/web build` → exit 0; the dist root contains the manifest and every icon.

### Milestone 2: HTML links and metadata

Add manifest, favicon, and apple-touch-icon links plus all three iOS meta tags to apps/web/index.html. Preserve viewport/theme-color/color-scheme/title. Validation: `pnpm --filter @coflux/web build` → exit 0; dist/index.html contains the tags.

## Scope

In scope:
- `apps/web/public/` (new)
- `apps/web/index.html`
- `plans/README.md` (status update)

Out of scope:
- `apps/web/vite.config.ts` —  No changes required (public/automatic copy)

- Any service worker / offline cache / update prompt

- `apps/web/package.json`/lockfile — no dependencies

- Any code under src/ - this requirement is purely static resources

- Installation guidance UI (like "Add to Home Screen" prompt) - not proposed

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Typecheck + build | `pnpm --filter @coflux/web build` | exit 0 |
| Artifact inspection | `ls apps/web/dist/manifest.webmanifest apps/web/dist/icon-512.png apps/web/dist/apple-touch-icon.png` | All present |
| Browser acceptance (acceptance) | `pnpm --filter @coflux/web preview`+ Browser access: manifest 200, no 404, Application panel can be installed | Pass |

## Done criteria

- [ ] All listed commands pass.
- [ ] `dist/` contains manifest + 5 icons; the declaration of manifest icons is consistent with the actual size of the file.

- [ ] `index.html` contains manifest/favicon/apple-touch-icon link and iOS meta.

- [ ] No service worker, no new dependencies, vite.config.ts remains unchanged.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.
- Unable to render PNG without persistent dependencies (one-shot `pnpm dlx` also fails).

## Maintenance notes

- After the official logo is finalized: replace `apps/web/public/favicon.svg` and re-render 4 PNGs.

  Manifest/index.html does not need to be modified.

- If offline capabilities or installation prompts are required in the future, re-evaluate vite-plugin-pwa; the update prompt UI will need to be processed at that time.
