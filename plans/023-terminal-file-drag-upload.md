# Plan 023: Drag small files into the web terminal, upload to daemon temporary storage, and insert their paths

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 7562f83..HEAD -- apps/web/src/components/workbench/terminal-pane.tsx apps/server/src/config.ts apps/server/src/index.ts crates/worker/src/ops.rs`

## Status

- Priority: P2
- Effort: S
- Risk: MED
- Depends on: none (reuse the implemented fsWrite temp pipeline in plans/014-terminal-image-paste.md)
- Category: feature
- Execution: agent:codex
- Planned at: `7562f83`, 2026-07-21

## Requirement

Support dropping small files from Finder/Explorer into the terminal. Upload bytes to daemon temporary storage, then inject the returned absolute paths, following clipboard image paste. This resembles macOS Terminal file dragging, but browser-local paths cannot be used remotely, so upload must come first.

Required outcomes:
- Drop one or more files from Finder, then insert their daemon-side absolute paths in order, separated by spaces according to shell-argument conventions, using ``terminal.paste(`${path} `)``.
- There is a visible "drop to upload" highlight prompt in the terminal area during the dragging process.
- Upload the image file as it is, and the path you get points to the original image (without compression).
- When a single file exceeds 30MB, it will be rejected and a system prompt will be given on the terminal, and the upload will not be performed.
- Dragging is rejected and prompts when no control is held (consistent with image paste).
- The upload limit is relaxed from 4MB (server) / 8MB (daemon) / 3.5MB (front-end) to 30MB.

## Decisions & tradeoffs

- **Reuse fsWrite temp mode, without chunking or a separate upload channel.** Call `sendFsWrite(workspaceId, name, bytes, temp=true)` (`apps/web/src/client/store.ts:381`), write into daemon `/coflux-pastes/` temporary storage (`crates/worker/src/ops.rs:154-181`), and inject the returned absolute path. A multipart/HTTP endpoint is excessive: 30MB is a rarely reached ceiling, and one fsWrite message suffices. Evidence: existing handlePaste at `apps/web/src/components/workbench/terminal-pane.tsx:258-292`.
- **30MB is a safety ceiling, not the expected transfer size.** Accept occasional brief head-of-line blocking while one large message shares the PTY WebSocket. Retaining 3.5MB would reject ordinary small files too often; building a routine large-transfer system is a separate, unneeded scope.
- **Set all three upload limits to 30MB:** frontend rejection threshold, server WS message limit, and worker write limit. A smaller downstream value would reject frontend-approved files. Document their coupling at `terminal-pane.tsx:37`, `apps/server/src/config.ts:81`, and `crates/worker/src/ops.rs:14`, following plan 014’s comments.
- **Keep upload ceiling and image-compression budget separate.** Preserve `PASTE_BUDGET_BYTES=3.5MB`; add a separate value such as `MAX_UPLOAD_BYTES=30MB` for drag uploads. Merging them would raise clipboard screenshot compression to 30MB and waste bandwidth.
- **Upload dropped images unchanged.** Drag means transferring the original file, so the returned path must reference its original bytes. Do not call compressToBudget: lossy compression belongs only to clipboard screenshot paste (`terminal-pane.tsx:277`).
- **Upload every file and inject paths in order, separated by spaces.** Keeping only the first loses files; newlines could execute multiple terminal commands.
- **Ignore folders.** Process only actual `kind==='file'` dataTransfer entries. Recursive webkitGetAsEntry traversal adds unrelated complexity; silently ignore directories.
- **Rejected without control**: `!(active && controlState==='owned' && sessionId)` `writeSystem` prompts and terminates, the same logic as handlePaste `terminal-pane.tsx:267-270`.
- **Show upload feedback.** Call `writeSystem("Uploading…")` after drop, then inject paths on success or show errors on failure. Large drops need this feedback even though compressed clipboard images do not.

## Direction

Keep changes in terminal-pane.tsx plus the three limits. Register drop/dragover handlers once in mount-only `useEffect(() => {...}, [])`, attach them to host as handlePaste does, read current `active/controlState/sessionId/workspaceId/sendFsWrite` through `liveRef.current` (`terminal-pane.tsx:137-156`), and remove handlers in the same cleanup.

Use React state for a "drop to upload" highlight over the terminal, following the warning strip in `apps/web/src/components/workbench/workspace-terminal.tsx:535` and Astryx/token rules in apps/web/.claude/CLAUDE.md. Use token classes such as `bg-warning/10` and `border-warning/20`, not raw hex/px.

### Milestone 1: The three upper limit constants are relaxed to 30MB and consistent

Add a separate frontend upload ceiling and set server maxPayload and worker MAX_WRITE_BYTES to the same 30MB, documenting coupling. Preserve the 3.5MB PASTE_BUDGET_BYTES compression target. Validation: `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` and `cargo check -p coflux-worker` → exit 0.

### Milestone 2: Drag and drop upload interaction

Handle dragover/dragleave/drop; preventDefault on dragover and drop. Read file entries, ignore folders, upload sequentially without image compression, and inject space-separated paths. Reject files above 30MB or without control. Show stable drop highlighting and "Uploading..." feedback. Validation: `node_modules/.bin/tsc -b apps/web/tsconfig.json` → exit 0.

## Landmines

- **The daemon rejects invalid single-segment names.** safe_resolve_temp_target (`crates/worker/src/ops.rs:154-162`) rejects empty names, `.`, `..`, and `/`. Sanitize dropped names; the recorded filename restrictions also affect spaces, Chinese characters, and special symbols. Prefer generated names such as `drop-${Date.now()}-${rand}.${ext}`, following image paste, or strict sanitization.
- **maxPayload applies to both client and daemon WS** through wssOpts shared by `daemonWss` and `clientWss` (`apps/server/src/index.ts:47-49`). Raising it relaxes every message limit, not just fsWrite. The worker still enforces 30MB writes; document the broader effect.
- **Browsers use dragged files as navigation by default**: both dragover and drop must be `preventDefault`, otherwise, letting go will replace the entire page with the file.
- **Bubbling dragenter/dragleave can flicker the overlay.** Moving between descendants triggers both. Use an enter counter, or keep highlighting during dragover and clear on dragleave only when relatedTarget is outside host.
- **Avoid stale closures.** Mount-only handlers otherwise capture first-render props. Read liveRef.current, following the existing pattern, instead of repeatedly registering effects.

## Scope

In scope:
- `apps/web/src/components/workbench/terminal-pane.tsx`
- `apps/server/src/config.ts`
- `crates/worker/src/ops.rs`

Out of scope:
- `apps/server/src/index.ts` —  Read-only `maxPayload`, `wssOpts` usage remains unchanged, only its value changes with config.ts.
- Clipboard image paste handlePaste and `compressToBudget` —  compression logic with 3.5MB budget is completely unchanged.
- Split/independent upload channel, upload progress bar - explicitly not done.
- Folder recursive expansion — explicitly not done.

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| web type checking | `node_modules/.bin/tsc -b apps/web/tsconfig.json` | exit 0 |
| server type check | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| worker build check | `cargo check -p coflux-worker` | exit 0, zero warnings |
| Real machine drag and drop (acceptance) | After all three development components are connected, drag single files/multiple files/pictures/over 30MB/without control rights from the Finder to the web terminal | Manual confirmation |

## Done criteria

- [ ] All non-acceptance commands pass.
- [ ] Drag a file from Finder to the terminal, and after releasing it, inject the absolute path on the daemon side into the input line.
- [ ] Drag multiple files, and inject them one after another with the paths separated by spaces.
- [ ] Drag the image, and the path points to the original image (uncompressed).
- [ ] Dragging files exceeding 30MB will be rejected and a terminal prompt will appear.
- [ ] Dragging without control will be rejected and a prompt will be displayed.
- [ ] There is a "drop to upload" highlight mask during the dragging process and does not flicker.
- [ ] The three upper limit constants are all 30MB and the comments indicate coupling; `PASTE_BUDGET_BYTES` is still 3.5MB.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] Files outside scope have not been changed (especially handlePaste/compressToBudget/index.ts logic).
- [ ] `plans/README.md` status updated.

## STOP conditions

- The file name verification rules of `safe_resolve_temp_target` have changed (ops.rs:154), and the naming strategy needs to be reset.
- `maxPayload` is no longer shared by client/daemon (index.ts:47-49 structural changes).
- The fsWrite temp pipeline (sendFsWrite / ClientFsWrite / write_file temp branch) no longer exists or the semantics have changed.
- Any validation command fails twice in a row even after a reasonable fix.

## Maintenance notes

- The three 30MB limits are coupled. Change all together or frontend-approved files may be rejected downstream or disconnect WS for oversized messages.
- If there is a need for normal large file transfer in the future, you should turn to chunking/independent upload channels instead of continuing to increase `maxPayload` —The latter will indiscriminately amplify the memory and blocking costs of all WS messages.
- `PASTE_BUDGET_BYTES` (image-paste compression budget) and upload upper limit constant are two independent knobs and should not be merged.
