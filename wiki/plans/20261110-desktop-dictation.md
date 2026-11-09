# Plan 20261110-desktop-dictation: Dictation in desktop terminals — a floating mic button, a bubble that types out what you say

> Three parts for three readers. The Record says why and stays true after the
> code moves on. The Execution brief is the only part a delegated executor
> receives. Verification is the orchestrator's. At close, `dev:execute-plan`
> appends an Outcome and updates `wiki/plans/README.md`.
>
> Drift check: `git diff --stat 49e84159..HEAD -- apps/desktop apps/ios/Coflux/Speech packages/client/src/store.ts apps/server/src/hub.ts`

## Status

- Priority: P2
- Effort: L
- Risk: MED
- Depends on: wiki/plans/20261109-dictation-refine.md (PR #131, unmerged), which depends on wiki/plans/20261109-speech-providers.md (PR #129, unmerged)
- Category: feature
- Execution: subagent(opus) — from the departure check
- Stop after: implementation — from the departure check (plain autopilot)
- Plan review: none — from the departure check
- Workspace: current — already in the linked worktree `.claude/worktrees/20261109-dictation-refine`; per the approved direction a new branch `dev/20261110-desktop-dictation` was cut there from `HEAD` (`49e84159`), stacked on PR #131
- Planned at: `49e84159`, 2026-11-10

## Record

### Requirement

iOS can dictate into a terminal (豆包 Seed-ASR or OpenAI Realtime, transcript context, optional LLM correction). The desktop app can edit the account's speech configuration but cannot dictate. Desktop users want the same: speak a prompt to an agent instead of typing it, with mixed Chinese/English technical terms recognised as well as on iOS.

Product conclusions (confirmed with the user on an interactive HTML draft, `/tmp/desktop-dictation-design.8yhhxx/desktop-dictation.html`, not committed):

- **Entry.** Every terminal pane has a round mic button fixed in its bottom-right corner. It never moves; the existing "Agent 请求输入" cards and the executor deck sit above it. When dictation is not usable — the active provider has no key, or the centre does not support speech settings — the button is not shown at all and the shortcut does nothing.
- **Trigger.** Click to start, click again to stop. `⌥Space` in the focused terminal: a short press toggles; held longer than 0.5 s it is push-to-talk and release stops. `Esc` cancels at any stage and writes nothing.
- **Button states.** Idle: low-key, brightens when the pointer is in the pane. Connecting / finishing / correcting: disabled, a grey sound-bar loading icon (four bars, a wave travelling left to right, each bar brightening at its crest — "W1+W2"). Listening: red; the icon stays a mic whose capsule fills with the voice level, plus two rings that spread with the level ("A+B"). The motion follows the real microphone level; silence is still.
- **Bubble.** Only the recognised text — no title, engine name, status line or key hints. It appears with the first character, types out character by character with a soft fade/blur-in, and grows smoothly from the button up and to the left, wrapping at about 420 px. iOS-style continuous corners (squircle), no pointer tail. While finishing/correcting the text stays still; the button shows the loading state.
- **Confirm.** The same bubble becomes editable. Words the correction changed flash briefly. Bottom-right: "原文" (only when the correction changed something; toggles original ↔ corrected) and a round send button. `⏎` sends (writes the text and Enter), `⌘⏎` inserts without Enter, `Esc` cancels. There is no skip-confirmation mode.
- **Errors.** A connection that drops mid-sentence is treated as the user stopping: what was recognised goes on to confirm, no message. A failure before any text: a grey one-line "连接失败" that disappears by itself after ~2 s (clicking the mic again is the retry). Microphone permission denied: one line "需要麦克风权限" + "打开系统设置".
- **Not in scope.** Skipping confirmation, a configurable shortcut, dictation anywhere other than a terminal pane.
- **Observable when done.** With speech configured, each terminal pane shows the button; dictating into a Claude Code session puts the corrected text into its prompt (sent or inserted); with speech unconfigured no button appears; API keys never reach the renderer.

### Decisions & tradeoffs

- **D1 Keys live only in the main process.** The main process fetches the active provider's credentials and the correction credentials, opens the recogniser connection and calls the correction model; the renderer never receives a key, base URL with credentials, or authorization header. Rejected: adding credential getters to the TS client store and handing keys to the renderer — the desktop's standing rule is that API keys never pass through the renderer. Based on: `apps/desktop/src/main/executor-settings-writer.ts:9` ("would also push API keys through the renderer, which is the one thing this whole design refuses"); `packages/client/src/store.ts` deliberately has no credential getter (plan 20261109-speech-providers).
- **D2 Credentials come over a short-lived control connection, no server change.** Main opens its own WebSocket to the centre with the session token it already holds (as `accountControl` does), authenticates as `clientKind: "desktop"`, sends `speechCredentialsGet` for the active provider and, when correction is enabled, `speechRefineCredentialsGet`, reads the answers and closes. Results are cached in main memory only, keyed by `(provider, updatedAt)` and the refine record's `updatedAt`; the renderer passes the `updatedAt` values it sees in `speechConfig`, and a mismatch refetches. Rejected: a new HTTPS endpoint on the centre — it would add a server change and a deploy-order dependency for something the wire already supports for any client. Based on: `apps/desktop/src/main/desktop-account.ts:35` (`accountControl`, auth at `:71`); `apps/server/src/hub.ts:3438` and `:3446` (both credential requests handled for any authenticated client).
- **D3 The engines are ports of the Swift implementations, in the main process.** Seed-ASR's binary WebSocket protocol, OpenAI Realtime transcription and the correction request are ported from `apps/ios/Coflux/Speech/` with the same wire behaviour, budgets and acceptance rules (Seed: 16 kHz, `X-Api-Key` header, model as resource id, context in the first frame; OpenAI: 24 kHz, bearer auth, context as `prompt`, `turn_detection: null`, languages zh/en; correction: temperature 0, non-streaming, answer accepted only within 0.5–2× of the raw length, ~3 s bound, otherwise the raw text). Use the `ws` package for the recogniser sockets because both need request headers. Rejected: running engines in the renderer — browser WebSockets cannot set headers and it would violate D1. Based on: `apps/desktop/package.json` (`"ws": "^8.18.0"` is already a dependency); `apps/ios/Coflux/Speech/SpeechTranscribing.swift`.
- **D4 Audio is captured in the renderer and streamed to main.** `getUserMedia` (audio only) feeds an AudioWorklet that downsamples to mono Int16 PCM at the active provider's rate (豆包 16 kHz, OpenAI 24 kHz) and computes the level that drives the button; PCM chunks go to main over IPC. Capture starts on the click, before the engine is ready; chunks are buffered and flushed once the session starts, so the first words are not lost. Rejected: capturing in main — Electron's main process has no audio capture API.
- **D5 Context is assembled in the renderer.** Reading the agent transcript and the repository term list needs device exec, which the renderer already has per pane (`execInWorkspace`, `transcriptAgent`, `agentSessionId` are passed to `TerminalPane`). The renderer ports `DictationContext.swift` (filtered locator scripts, Claude/Codex parsing including tool inputs, term extraction, budgets, recognition and correction contexts) and sends the resulting plain-text context to main. Context contains no secret. Based on: `apps/desktop/src/renderer/components/workbench/terminal-panes.tsx:95-110`.
- **D6 Microphone permission is opened narrowly.** The permission handlers in main allow `media` only for audio requests from the app's own renderer, never video; the packaged app gains `NSMicrophoneUsageDescription` and the hardened-runtime entitlement `com.apple.security.device.audio-input`; main asks TCC with `systemPreferences.askForMediaAccess("microphone")` and can open the microphone pane of System Settings. Based on: `apps/desktop/src/main/index.ts:195` (today every media permission is refused); `apps/desktop/build/entitlements.mac.plist`; `apps/desktop/electron-builder.yml` (`extendInfo`).
- **D7 Delivery goes through the pane's existing paths.** Insert = `terminal.paste(text)` (xterm applies bracketed paste); send = the same paste followed by `\r` through the pane's input path. Nothing is written while the pane cannot send input (`canSendTerminalInput`). Based on: `apps/desktop/src/renderer/components/workbench/terminal-pane.tsx` (`pasteFromClipboard`, the input path guarded by `canSendTerminalInput`).
- **D8 `⌥Space` is taken from the terminal for the focused pane only.** Both keydown and keyup of `⌥Space` are withheld from xterm (otherwise a kitty-protocol TUI receives an orphan release) and drive the pane's dictation; every other `⌥` combination keeps its terminal meaning. Rejected: a window-level global shortcut — dictation always targets one pane, the focused one. Based on: `apps/desktop/src/renderer/components/workbench/terminal-key-ownership.ts` ("⌥ 是 Meta/ESC 前缀" stays with the terminal), the handler at `terminal-pane.tsx` `attachCustomKeyEventHandler`.
- **D9 One dictation at a time.** Starting in another pane cancels the running one. `(decided while planning)`
- **D10 An invalid key is reported like a connection failure, with a route to settings.** Start failing with HTTP 401 shows one line "语音识别 API Key 无效" with "去设置". `(decided while planning)` — the product conclusions cover "not configured" (no button) but not a configured, wrong key.
- **D11 The button area stays clear.** While the button is shown, the pane's secret-request card stack and the executor deck's bottom-right resting place sit above it. Based on: `secret-request-card.tsx:43` (`bottom-4`, right-aligned stack), `executor-deck.ts` `cornerTarget` (`DECK_MARGIN = 16`).

### Discussion log

- `/dev:explore` request: "继续增加桌面端的语音输入吧, 我想入口可以放在终端详情的右下角, 增加一个语音输入的悬浮按钮, 触发后开始聆听, 文字可以也悬浮展示气泡, 按照这个思路, 先做 html 设计稿来评审吧" — an interactive HTML draft was built for review (the Artifact publish was refused for lack of a claude.ai login; the draft was opened locally).
- Draft review, listening icon: "聆听中的话，这个图标还是麦克风的图标嘛…带着动画的效果" → three mic animations offered (A fill with level, B spreading rings, C side arcs) → user: "A+B".
- Draft review, bubble: "不用这么麻烦，好多提示…正常只带着这个输出的文字"; "随着文字的说话的变多…气泡慢慢的一起撑着变大"; "比较顺滑的打字机的渐变效果" → bubble reduced to text, typewriter fade-in, smooth growth.
- Draft review, corners: "最好用 iOS 的完美圆角" → squircle (`corner-shape`), pointer tail removed.
- Draft review, unconfigured: "这个语音没有设置的 就不要展示这个按钮了" → button hidden (overrides the draft's earlier "dimmed button + 去设置").
- Draft review, connection drop: "什么用这段…连接中断，那就相当于是停止了呗" → a drop is a stop; failure before any text is a self-dismissing line.
- Draft review, loading: "连接中和整理中这种 loading 状态…用麦克风的 icon 换一个其他的 icon…麦克风这个本来也是处于一个禁用状态" → disabled button with a loading icon; "这个太俗了，换一个好看的…和声音相关的" → three sound-bar loaders offered → "W1 + W2 扫光".
- Product confirmation (third round, after two "还要改"): confirmed the summary recorded under Requirement.
- Departure check: direction "按此方向" (main fetches credentials over a short control connection, engines in main, keys never in the renderer; renderer captures audio, builds context, UI, writes to the terminal; new branch stacked on #131); execution "Subagent (opus)"; autopilot "直接自动执行" (no plan audit).
- D9, D10 `(decided while planning)`.

### Maintenance notes

- The TS engines and context builder duplicate the Swift ones. A behaviour change to either (budgets, locator scripts, prompt, acceptance rule) must be made on both clients.
- Correction requires migration 13 on the centre (PR #131); against a centre without it `speechRefineSupported` is false and dictation runs without correction.
- Development builds run as `Electron.app`, so macOS asks for microphone access for Electron, not Coflux; the packaged app asks under its own bundle id.

## Execution brief

> Written for `subagent(opus)` at `49e84159`. Implement the milestones in
> order. Decide only what Your call leaves to you; on anything else that is
> unclear, stop and report.

### Goal

Add dictation to the Electron desktop app's terminal panes, matching the iOS feature. Three layers:

- **Main process** (`apps/desktop/src/main/`): fetch speech credentials from the centre over a short WebSocket control connection, run the recogniser (豆包 Seed-ASR or OpenAI Realtime) and the optional correction request, ask for microphone permission. API keys exist only here.
- **Bridge** (`src/shared/ipc.ts`, `src/shared/desktop-bridge.ts`, `src/preload/index.ts`): a small dictation API between renderer and main.
- **Renderer** (`src/renderer/components/workbench/`): microphone capture, context assembly from the agent transcript, the per-pane mic button and text bubble, the `⌥Space` shortcut, delivery into the terminal.

The iOS implementation is the reference for all engine and context behaviour; read it before writing the ports: `apps/ios/Coflux/Speech/SeedASRProvider.swift`, `OpenAIRealtimeTranscriber.swift`, `DictationRefiner.swift`, `DictationContext.swift`, `DictationSession.swift` (timings: context deadline 1.2 s, refine budget 3 s, refine context wait 0.8 s), `SpeechTranscribing.swift`, `AudioCapture.swift`. The desktop settings page already edits the configuration: `src/renderer/components/settings/speech-section.tsx`. The renderer reads configuration from the client store: `speechConfigSupported`, `speechRefineSupported`, `speechConfig` (`packages/client/src/store.ts`, `SpeechConfig` / `SpeechProviderState` / `SpeechRefineState`).

Conventions: read `docs/design-guidelines.md` before UI work (Tooltip not `title`, type scale 13/12/11 px, lucide icons). Code comments in English. There is no formatter for this package; keep the surrounding style. Tests use `node --test` in `*.test.ts` next to the module.

### Milestone 1: main process can transcribe and correct, keys stay in main

Depends on: none

#### T1 · Credentials reach main without touching the renderer

- Where: new `apps/desktop/src/main/dictation-credentials.ts`; wire-up in `src/main/index.ts` next to the other main services that read `tokenStore.read`.
- Change: implement a credential source that opens a WebSocket to the configured server URL, authenticates exactly like `accountControl` in `src/main/desktop-account.ts` (`clientAuth` with the session token, `clientKind: "desktop"`, `controlProtocolVersion`), sends `speechCredentialsGet` for the requested provider and, when asked, `speechRefineCredentialsGet`, waits for the matching `speechCredentials` / `speechRefineCredentials` by request id, then closes. Bound the whole exchange (connect + answers) with a timeout. Cache results in memory keyed by provider + its `updatedAt` and by the refine `updatedAt`; a request whose expected `updatedAt` differs from the cached one refetches. Clear the cache on sign-out / token change.
- After: given the session token and `{ provider, providerUpdatedAt, refine: boolean, refineUpdatedAt }`, it returns `{ baseUrl, model, apiKey }` for the provider (empty base URL/model mean the provider defaults: 豆包 `wss://openspeech.bytedance.com/api/v3/plan/sauc/bigmodel_async` / `volc.seedasr.sauc.duration`; OpenAI `https://api.openai.com/v1` / `gpt-live-transcribe`) and, when requested and enabled, the refine `{ baseUrl, model, apiKey }`; or a typed failure (`not_configured`, `unreachable`). Keys are never logged and never leave main (D1, D2).
- Don't: add a credential getter to `packages/client` or send any key over IPC (D1). Don't add a server endpoint (D2).

#### T2 · The two recognisers and the correction request, ported

- Where: new files under `apps/desktop/src/main/` (e.g. `dictation-seed.ts`, `dictation-openai.ts`, `dictation-refine.ts`); sources `apps/ios/Coflux/Speech/SeedASRProvider.swift`, `OpenAIRealtimeTranscriber.swift`, `DictationRefiner.swift`.
- Change: port each to TypeScript with the same contract as `SpeechTranscribing`: `start()` (throws `invalid_key` on HTTP 401, otherwise `unreachable`), `feed(pcm)`, `finish()` (flush, wait bounded for the final text), `cancel()`, and events carrying the **full** text (`volatile` / `finalized`), `failed`, `closed`. Use the `ws` package for both sockets (headers are required) (D3). Port the correction request: OpenAI-compatible `POST {base}/chat/completions`, temperature 0, non-streaming, the same system instructions and prompt layout (workspace → repository terms → conversation → `<dictation>` last), the same token budgets and `max_tokens` rule, the ~3 s deadline, and the same acceptance (`accepted(answer:raw:)`: length within 0.5–2× of raw, strip one code fence or one pair of quotes) — returning `refined(text)` or `notRefined`.
- After: byte-for-byte the same Seed frames and the same OpenAI session/update messages as the Swift code for the same inputs. Tests: Seed frame encoding of a config frame and an audio frame, and decoding of a server response frame carrying text → the expected bytes / text; correction acceptance: `"rebase 到 main"` for raw `"瑞贝斯 到 妹恩"` → accepted, an answer 3× longer → rejected, a fenced answer → fence stripped.
- Don't: invent new prompt wording or budgets; the Swift values are the spec (D3).

#### T3 · A dictation session API over IPC

- Where: `src/shared/ipc.ts` (channel names), `src/shared/desktop-bridge.ts` (types on `DesktopBridge`), `src/preload/index.ts`, `src/main/ipc.ts` (handlers, using the same sender-trust checks as the existing handlers), a new main module owning the session (e.g. `src/main/dictation-session.ts`).
- Change: expose on `window.cofluxDesktop`:
  - `dictationStart({ provider, providerUpdatedAt, refineUpdatedAt | null, context })` → `{ ok: true, sessionId } | { ok: false, error: "not_configured" | "invalid_key" | "unreachable" }`. `context` is the recognition context assembled by the renderer (the shape the Swift `DictationContext` carries; plain text only).
  - `dictationAudio(sessionId, pcm: ArrayBuffer)` — fire-and-forget Int16 mono PCM at the provider's rate.
  - `dictationFinish(sessionId, refineContext | null)` — stop feeding, wait for the final text, then run the correction when `refineContext` is given and correction is enabled.
  - `dictationCancel(sessionId)`.
  - `onDictationEvent(listener)` → unsubscribe; events `{ sessionId, kind: "text", text, final }`, `{ sessionId, kind: "result", raw, refined: string | null }`, `{ sessionId, kind: "failed", error: "unreachable" | "invalid_key", text }` (`text` = whatever was recognised so far), `{ sessionId, kind: "closed" }`.
  - `microphoneAccess()` → `"granted" | "denied"` (asks TCC via `systemPreferences.askForMediaAccess("microphone")` when undetermined) and `openMicrophoneSettings()` (opens System Settings › Privacy & Security › Microphone).
- After: main holds at most one session; a new `dictationStart` cancels the previous one (D9). A recogniser failure after text exists is reported as `failed` with that text so the renderer can treat it as a stop. Closing or reloading the window cancels the session. No event or return value contains a key (D1).

#### T4 · The packaged app may use the microphone, and only that

- Where: `src/main/index.ts` — `const allowedPermissions = new Set([...])` and the two `setPermission*Handler` calls; `apps/desktop/build/entitlements.mac.plist`; `apps/desktop/electron-builder.yml` — `extendInfo:`.
- Change: allow the `media` permission only when the request is audio-only (no video) and comes from the app's own renderer; keep everything else refused and keep the existing comment block accurate. Add `com.apple.security.device.audio-input` to the entitlements and `NSMicrophoneUsageDescription` (a short Chinese sentence saying Coflux uses the microphone for voice input into terminals) to `extendInfo`.
- After: `getUserMedia({ audio })` succeeds in the renderer once TCC allows it; a video request is still refused; the guest `<webview>` sessions in `browser-host.ts` are unchanged (D6).
- Don't: allow `media` unconditionally (D6).

### Milestone 2: the renderer can capture, build context and drive a session

Depends on: Milestone 1

#### T5 · Microphone capture with level

- Where: new renderer module(s) under `src/renderer/components/workbench/` (e.g. `dictation-capture.ts`) plus an AudioWorklet processor file.
- Change: capture mono audio with `getUserMedia({ audio: { echoCancellation, noiseSuppression, autoGainControl } })`, downsample in an AudioWorklet to Int16 PCM at the target rate (16000 for `doubao`, 24000 for `openai`), deliver ~100 ms chunks, and publish a smoothed 0…1 level (fast attack, slower release) for the button animation. Stop releases the tracks (the macOS mic indicator goes off).
- After: start → chunks and level flow; stop/cancel → tracks stopped, no further chunks (D4).
- Don't: load the worklet from a `blob:` or `data:` URL — the renderer CSP is `script-src 'self'` (`src/main/app-protocol-pure.ts` `RENDERER_CSP`); ship it as a same-origin asset through the Vite build.

#### T6 · Dictation context from the agent transcript

- Where: new renderer module (e.g. `src/renderer/components/workbench/dictation-context.ts`); source `apps/ios/Coflux/Speech/DictationContext.swift`; existing helpers `transcriptAgentOf`, `isUsableAgentSessionId`, `TranscriptExec` in `terminal-transcript.ts`.
- Change: port the Swift context builder: the two read sizes (`recognition`: raw tail 2 MiB / print ≤ 256 KiB; `correction`: raw 8 MiB / print ≤ 1 MiB), the Claude and Codex locator scripts **exactly** (fixed literal `sh -c` scripts; the agent session id and sizes passed only as positional arguments, digits checked in the script; tool-output lines filtered on the device), parsing into person / agent / tool entries (tool inputs only), the workspace sentence, the 「相关术语：…」 sentence from tool inputs and `git -c core.quotePath=false ls-files | head -c 262144`, the 1500-token recognition budget and the correction context (repository terms only, entries chronological). Run reads through the pane's `execInWorkspace`.
- After: for a Claude or Codex pane with a usable agent session id it yields the same recognition context and correction context the iOS builder yields for the same transcript; for a plain shell pane it yields the workspace sentence only; any read failure yields the smaller context, never an error. Tests: a small Claude JSONL and a small Codex JSONL → expected entries (tool results excluded, tool inputs kept, injected/system prompts dropped); the budget keeps the newest text.
- Don't: interpolate the session id into a script string (shell injection).

#### T7 · A per-pane dictation controller

- Where: new renderer module (e.g. `src/renderer/components/workbench/use-dictation.ts`).
- Change: one state machine per pane — `idle → connecting → listening → finishing → (correcting) → confirm → idle`, plus `error` — that: on start, checks `microphoneAccess()`, starts capture at once (buffering chunks), gathers the recognition context in parallel (at most 1.2 s, then proceeds with what it has), calls `dictationStart`, flushes buffered audio and streams the rest; on stop, starts the correction-context read (waits at most 0.8 s), calls `dictationFinish`; on `result` enters confirm with raw and refined text; on cancel, stops capture and calls `dictationCancel`. A `failed` event with non-empty text behaves like a stop and enters confirm with that text (no message); with empty text it shows "连接失败" for ~2 s then returns to idle; `invalid_key` shows "语音识别 API Key 无效" with "去设置" (D10). Starting in another pane cancels this one (D9).
- After: the controller exposes state, the live text, the level, `start / stop / cancel / send / insert / toggleOriginal`, and whether the button should exist (`speechConfigSupported` and the active provider `keyConfigured`; correction used only when `speechRefineSupported`, `refine.enabled` and `refine.keyConfigured`).

### Milestone 3: the button, the bubble and delivery in every terminal pane

Depends on: Milestone 2

#### T8 · Mic button and text bubble in the pane

- Where: `src/renderer/components/workbench/terminal-pane.tsx` (render next to the existing absolute overlays, e.g. near `props.secretCards`), new component file(s) for the button and bubble; `docs/design-guidelines.md` for conventions.
- Change: render the button (34 px circle, 16 px from the pane's right and bottom) only when the controller says dictation is usable. States: idle (muted, brightens on pane hover, Tooltip "语音输入 ⌥Space"); connecting / finishing / correcting (disabled, grey four-bar loading icon: bars rise in a wave left → right, each brightening at its crest); listening (red fill, white mic whose capsule fills bottom-up with the level, two translucent rings whose spread follows the level, the icon scaling slightly with it). Render the bubble above the button, anchored bottom-right: only the text; it appears with the first character; characters are appended one at a time and fade/blur in (pace speeds up when a backlog builds); the box animates its width and height to the content (max content width ~420 px, then wraps); continuous corners via `corner-shape: squircle` with a larger radius; no tail; no titles or hints. In confirm the text is editable in place, words the correction changed flash briefly, and a bottom-right row holds "原文"/"整理后" (only when raw ≠ refined) and a round send button. Error lines: "连接失败" (grey, self-dismissing), "需要麦克风权限" + "打开系统设置", "语音识别 API Key 无效" + "去设置" (opens the settings page at its speech section if the settings navigation supports a section target, otherwise opens settings).
- After: matches the Requirement's product conclusions; honours `prefers-reduced-motion`; all text sizes follow the 13/12/11 px scale.
- Don't: add any status text, engine name or key hint to the bubble — the user removed them explicitly.

#### T9 · Keyboard: `⌥Space`, `Esc`, `⏎`, `⌘⏎`

- Where: `terminal-pane.tsx` — the `terminal.attachCustomKeyEventHandler((event) => {` handler; `terminal-key-ownership.ts` if the decision belongs there.
- Change: in the focused pane, `⌥Space` keydown and keyup are withheld from xterm and drive the controller: short press toggles; a press held > 0.5 s that started listening stops on release. While the bubble is active, `Esc` cancels; in confirm, `⏎` sends, `⌘⏎` inserts, `⇧⏎` inserts a newline in the editable text.
- After: other `⌥` combinations still reach the terminal; with no dictation configured `⌥Space` behaves as before (D8).

#### T10 · Delivery and the clear corner

- Where: `terminal-pane.tsx` (`terminal.paste`, the input path guarded by `canSendTerminalInput`); `secret-request-card.tsx` (`"pointer-events-none absolute inset-x-0 bottom-4 z-30 flex flex-col items-end gap-2 px-4"`); `executor-deck.ts` (`cornerTarget`).
- Change: insert = `terminal.paste(text)`; send = paste then `\r` through the pane's input path; disable both while `canSendTerminalInput` is false (D7). While the mic button is shown, lift the secret-card stack and the deck's bottom-right resting position above the button (D11).
- After: dictated text lands in the agent's prompt exactly as typed text would; cards and deck never cover the button.

### Your call

- File and symbol names, module split, React structure, how the controller state is stored.
- Resampling algorithm, chunk size within ~60–200 ms, level smoothing constants, animation durations and easing.
- The exact shape of the `context` / `refineContext` objects over IPC, as long as they carry only plain text.
- Whether a few pure helpers get tests beyond those listed.

### Landmines

- `src/main/index.ts:190-197`: the permission policy comment says the renderer needs no browser permission; update it with the microphone exception so it stays true.
- Electron unpackaged runs as `Electron.app`: TCC prompts name Electron. Do not add code that depends on the bundle id.
- The kitty keyboard protocol (`terminal-key-ownership.ts` header): any key withheld on keydown must also be withheld on keyup.

### Scope

In scope:
- `apps/desktop/src/main/` (new dictation modules, `index.ts`, `ipc.ts`)
- `apps/desktop/src/shared/ipc.ts`, `apps/desktop/src/shared/desktop-bridge.ts`
- `apps/desktop/src/preload/index.ts`
- `apps/desktop/src/renderer/components/workbench/` (new dictation modules and components, `terminal-pane.tsx`, `terminal-panes.tsx`, `secret-request-card.tsx`, `executor-deck.ts`, `terminal-key-ownership.ts`)
- `apps/desktop/build/entitlements.mac.plist`, `apps/desktop/electron-builder.yml`
- `wiki/plans/20261110-desktop-dictation.md`, `wiki/plans/README.md`

Out of scope:
- `apps/server`, `proto`, `packages/protocol`, `packages/client` — no wire or store change (D1, D2).
- `apps/ios` — reference only.
- `src/renderer/components/settings/speech-section.tsx` — configuration UI is done.
- `src/main/browser-host.ts` permission handlers — guest pages stay without microphone.

### Stop and report if

- A task's anchor is missing, or the code there differs from what the task describes.
- A task needs a file outside the in-scope list.
- Two tasks contradict each other, or a task contradicts the code it changes.
- The centre refuses `speechCredentialsGet` from a desktop control connection for a reason other than a missing key.
- A Swift behaviour cannot be reproduced in TypeScript without changing what goes on the wire.

## Verification

### Milestone validations

- Milestone 1: `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test` → exit 0 (Seed codec and correction acceptance tests included).
- Milestone 2: same commands → exit 0 (context parser tests included).
- Milestone 3: `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test && pnpm -C apps/desktop lint && pnpm -C apps/desktop build` → exit 0.

### Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Typecheck | `pnpm -C apps/desktop typecheck` | exit 0 |
| Unit tests | `pnpm -C apps/desktop test` | exit 0 |
| Lint | `pnpm -C apps/desktop lint` | exit 0 |
| Build | `pnpm -C apps/desktop build` | exit 0 |
| Engine probe (acceptance) | A throwaway Node script (outside the repo) that synthesizes speech with macOS `say`, converts it to 24 kHz mono Int16 with `afconvert`, and drives the main-process OpenAI engine and correction modules directly with `OPENAI_API_KEY` from this Mac's environment (never printed) | final text close to the spoken sentence; correction fixes the planted terms; a bogus key → `invalid_key` |
| Walkthrough (acceptance) | `pnpm dev:desktop:prod` (see the desktop-preview skill), handed to the user | the Requirement's product conclusions hold; production lacks migration 13 until #131 deploys, so correction is off there |

### Done criteria

- [ ] All listed non-acceptance commands pass.
- [ ] Every task's `After` state holds.
- [ ] `grep` over the diff shows no API key, `Authorization` or `X-Api-Key` value crossing IPC or entering renderer code (D1).
- [ ] No server, proto, `packages/client` or iOS change in the diff (D2).
- [ ] The `media` permission is granted only for audio-only requests from the app renderer (D6).
- [ ] Engine probe: OpenAI path transcribes and corrects; invalid key maps to `invalid_key`.
- [ ] Required tests exist and assert meaningful behaviour.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] The Outcome is appended and `wiki/plans/README.md` status is updated.

### Merge and deploy

- Stacked on PR #131 (itself on #129). Merge order: #129 → #131 → this; retarget each to `main` as its base merges.
- No server change and no migration in this plan. Correction needs the centre to carry migration 13 (#131); without it the desktop dictates without correction.
- The packaged app gains a new entitlement (`com.apple.security.device.audio-input`) and `NSMicrophoneUsageDescription`; both go through the normal signed/notarized desktop release. Users see a microphone prompt on first use.
- Rollback: revert the desktop release; nothing persists.

## Outcome

- Status: APPROVE — 2026-11-10
- Mode: subagent(opus), one work package (strictly serial milestones), one revision round
- Commits: `659a7fb7..dab8400e` (`d928e715` main process, `672a7ab8` renderer controller, `12e6b094` UI, `bf1d60c2` credential-exchange error fix, `dab8400e` revision: hook declaration order for the React Compiler lint rule, Enter sent 80 ms after the paste)
- Verification: desktop typecheck, lint, 583/583 tests and build green; key fields appear in no renderer, preload or shared file; no change outside `apps/desktop`. Engine probe on this Mac: synthesized speech through the main-process OpenAI Realtime transcriber gave 「帮我看一下 rebase到 main之后 Tailcat的连接测试有没有过，然后把 worktree清理一下。」 (~4.7 s from connect at ~4× feed speed), the gpt-4.1-mini correction returned in 2.0 s with only spacing changed; an invalid key surfaced as `invalid_key` (OpenAI accepts the socket and reports `invalid_api_key` as an event, which the port maps).
- Deviations:
  - A bridge method `openSettings()` was added: the settings page has no section target, so 「去设置」 opens settings.
  - `src/main/ipc-sanitize.ts` and `src/main/renderer-reset.ts` were touched (inside `src/main/`): payload sanitizers for the new channels, and cancelling the session when the page is rebuilt.
  - Seed's config JSON and OpenAI's `session.update` match the Swift payloads in content, not byte order (Swift dictionary encoding has no fixed key order); frame headers, sequences and audio payloads match exactly.
  - The correction-context read starts at the stop (as the brief says), not at the start as on iOS.
  - A connection that drops after text exists goes to confirm with the raw text, without the correction pass.
- Follow-ups:
  - The 豆包 path has not been exercised live (no key on this Mac); only reviewed line by line against the Swift port.
  - The recogniser WebSockets (`ws`) do not use the macOS system proxy; the correction request does (`net.fetch`). From China without a system-wide proxy, OpenAI recognition may be slow or fail.
  - iOS's dictation 「发送」 only types the text (no Enter); the desktop's 发送 sends Enter, as the user confirmed for the desktop.
  - Desktop walkthrough pending the user; development builds prompt for the microphone as Electron.
