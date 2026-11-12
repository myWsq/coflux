# Show the user an HTML page: canvases

Read this before `coflux canvas show|list`, or when the user asks you to show them a mockup, a
design, a comparison or a visual summary.

```sh
coflux canvas show wiki/plans/home-redesign-mockup.html --title "Home redesign"
coflux canvas list
```

A canvas is an HTML file you wrote, shown to the user in a tab of their Coflux desktop. It belongs
to the workspace your cwd is in and is served from this machine, so it works the same on a remote
device.

## When to use one

- Use a canvas when the result is something to **look at**: a design mockup, two or three options
  side by side, a diagram, research findings laid out as a page, a report with tables or charts.
- Do not use one for an answer that reads fine as text, for a code change (the user reviews that in
  the changes view), or for an app that already has a dev server — give them its preview URL from
  `coflux ports` instead.

## Writing the page

- One `.html` (or `.htm`) file. It may load files that sit **beside it or below it** by relative
  URL: stylesheets, scripts, images, fonts. Nothing outside the file's directory is served, so
  `../shared.css` does not load; copy what you need next to the page or inline it.
- Keep it self-contained. The user's desktop may be on another machine or offline from the
  internet; do not depend on a CDN for the page to make sense.
- The directory is read live. Do not put the page in a directory that also holds secrets
  (`.env`, keys): anything in that directory can be fetched by a local process that knows the
  canvas's address.
- Put it where it should live. A mockup that documents a decision belongs in the repository (for
  example beside its plan); a throwaway belongs in a scratch directory. A canvas whose file is
  deleted disappears from the user's list.

## Showing and revising

- `show` registers the file and returns at once. The desktop opens the tab in the background and
  marks it unread; it does not notify the user or take their focus. When you need them to look
  now, follow it with `coflux notify "<what to look at and what you need>"`.
- `--title` is what the tab and the list show; without it the file name is used.
- To revise, edit the same file and run `show` on it again: the same tab reloads and is marked
  unread again. Do not create `mockup-v2.html` for every round — a new file is a new canvas, and
  annotations stay with the old one.
- `list` prints the workspace's canvases and names the workspace it resolved: an empty list in the
  wrong workspace means you moved (`coflux workspace`).
- If `show` reports that the canvas listener is not running, another process holds its port on
  this device; tell the user rather than retrying.

## Getting feedback

There is no approve button and nothing to wait on. The user tells you what they think in one of
two ways:

- In the conversation ("go with B", "tighter spacing").
- As **annotations**: they point at elements or drag a region on the canvas and write a comment.
  These are ordinary browser annotations of the workspace — read and resolve them with
  `coflux annotations list` and `coflux annotations resolve <id> --note "<what you changed>"`, as
  described in the annotations reference of this skill. After resolving, `show` the file again so
  the user sees the new version.
