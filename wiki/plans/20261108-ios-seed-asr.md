# Plan 20261108-ios-seed-asr: iOS dictation runs on Doubao Seed-ASR 2.0 with the agent conversation as context, keyed by an account-level API key

> Three parts for three readers. The Record says why and stays true after the
> code moves on. The Execution brief is the only part a delegated executor
> receives. Verification is the orchestrator's. At close, `dev:execute-plan`
> appends an Outcome and updates `wiki/plans/README.md`.
>
> Drift check: `git diff --stat a43d9d67..HEAD -- proto/coflux/v1/client.proto apps/server/src/hub.ts apps/server/src/store.ts apps/server/src/infra/database/schema-migrations.ts apps/server/src/executor-secrets.ts packages/client/src/store.ts apps/desktop/src/renderer/components/settings packages/swift-client/Sources/CofluxClientCore/CofluxClient.swift apps/ios/Coflux apps/ios/Coflux.xcodeproj apps/ios/Coflux-Info.plist apps/ios/CofluxTests apps/desktop/src/renderer/components/workbench/terminal-transcript.ts`

## Status

- Priority: P2
- Effort: L
- Risk: MED
- Depends on: none (branch is stacked on `dev/20261107-ios-duo-redesign`, PR #126)
- Category: feature
- Execution: subagent(opus) — departure check
- Stop after: implementation — departure check (plan audit, then execute)
- Plan review: audit — departure check
- Workspace: isolated — the user asked for a separate workspace ("立项在独立的工作区里做") cut from the Duo branch; coflux workspace `5ce98a4b`, path `/Users/wsq/.coflux/worktrees/5ce98a4b-7866-48a2-b129-42e5b4aeac5d`, branch `dev/20261108-ios-seed-asr`
- Planned at: `a43d9d67`, 2026-11-08

## Record

### Requirement

On iOS the user dictates to agents in a terminal by long-pressing the composer. Recognition is
poor on exactly the words that matter — project names, identifiers, mixed Chinese/English
technical terms, things the agent just said — because the current engines (a reverse-engineered
Doubao input-method channel, falling back to Apple's on-device recogniser) hear the audio with no
context. Doubao's Seed-ASR 2.0 accepts conversation context with the request, and a live probe on
2026-11-08 with the user's Ark Agent Plan key showed context fixing exactly those words
(`coflux`, `Tailcat`, `DERP` went from `Coffex`/`tail cut`/`dirty` to correct).

When this is done:

- Seed-ASR 2.0 is the **only** dictation engine. The input-method channel and Apple's recogniser
  are gone, and so is the speech-recognition permission; only the microphone is requested.
- The API key belongs to the **account**: stored encrypted in the centre's database, entered from
  either the iOS app or the desktop settings page, used by the iPhone, which fetches it from the
  centre and connects to Volcengine directly.
- Every dictation automatically carries context: one sentence naming the project, workspace and
  branch; and, when the terminal runs an agent (Claude Code or Codex), the newest part of that
  agent's conversation — the agent's replies, its thinking, and the user's own messages, never
  tool calls or tool output.

Product conclusions (confirmed by the user at the product gate; key storage amended afterwards):

- **Entry (iOS)**: the account menu (today it holds only 「退出登录」) gains 「语音识别…」, which
  opens a sheet: a masked field for the Doubao Agent Plan API key, 「保存」 and 「清除」, a status
  line 已配置 / 未配置, and a one-line explanation that the key is stored on the account and shared
  by the account's devices. The stored key is never shown back.
- **Entry (desktop)**: a settings section for the same key — masked input, save, clear, status —
  write-only like the iOS sheet.
- **Dictation interaction is unchanged**: long-press, slide to 取消 / 发送, release in place → the
  confirm state with the editable draft.
- **No key configured**: no prewarm on touch-down; a long-press shows the overlay with
  「语音输入不可用：未配置豆包 API Key」 and a 「去设置」 button that opens the sheet.
- **Failures**: an invalid key (Volcengine rejects the handshake) shows 「Key 无效」; a network or
  service failure shows 「无法连接识别服务」. Text already transcribed still goes to the confirm
  state. An older centre that cannot store the key says so instead of 「未配置」.
- **Badge** on the overlay: 「豆包 · 带语境」 when the agent conversation was included,
  「豆包」 otherwise.
- **Never block speaking**: if the conversation cannot be read in time, dictation starts without it.
- **Non-goals**: a custom word list, image context, dictation on the desktop, any fallback engine.
- **Observable when done**: with a key configured the badge reads 带语境 in an agent terminal and
  names the agent just used are recognised; clearing the key makes long-press show 不可用 + 去设置;
  a key entered on the desktop works on the iPhone without re-entering it.

### Decisions & tradeoffs

- **D1 One engine, Seed-ASR 2.0 through the Ark Agent Plan endpoint**: the bidirectional streaming
  endpoint with two-pass recognition is the only engine; no fallback of any kind. Rejected: keeping
  the input-method channel or Apple's recogniser as fallbacks — the user chose "只留 Seed ASR，否则提示
  语音功能不可用"; a fallback would silently give context-free, worse text. Based on: Discussion log;
  live probe (two-pass final ~0.7–0.9 s after the last frame).
- **D2 Uncompressed frames both ways**: requests use compression type 0, and the service then
  answers uncompressed. Rejected: gzip as in Volcengine's sample — iOS has no gzip in its system
  frameworks and it buys nothing at 16 kHz PCM sizes. Based on: probe on 2026-11-08 (uncompressed
  JSON + PCM accepted; every response frame had compression 0; same recognition result).
- **D3 Context travels once, in the first (configuration) frame, as dialog context with the
  workspace sentence newest**: `corpus.context` is a JSON string `{"context_type":"dialog_ctx",
  "context_data":[{"text":…}, …]}` ordered newest first; item 0 is the workspace sentence, then
  the conversation entries newest → oldest, capped client-side at an estimated 1500 tokens.
  No `hotwords` list. Rejected: a hotword list (lost its effect after ~80 items in the probe, and
  sentences carried the same words better); sending more than the budget (the service silently
  keeps only the newest ~1500–2000 tokens — larger payloads are accepted, not rejected — so the
  surplus is wasted bytes on the phone's uplink). Based on: capacity probes — a key sentence
  survived behind ~1500 tokens of English filler and 1500 Chinese characters, and was lost behind
  ~2000 tokens / 3000 characters; the documented 20-round cap was not enforced; context added no
  measurable latency.
- **D4 Conversation context comes from the agent's own transcript file**, read on the device that
  owns the workspace with the same fixed locator scripts the desktop's copy view uses, through the
  existing exec RPC; replies, thinking (Codex: reasoning summaries) and the user's messages are
  kept, tool calls and tool results and injected bookkeeping are dropped. Rejected: the terminal
  screen/scrollback (mostly tool output, wrapped and framed by the TUI); a new daemon or protocol
  feature for transcripts (the desktop module's header records why the daemon must stay ignorant
  of vendor formats). Based on: `apps/desktop/src/renderer/components/workbench/terminal-transcript.ts`
  (header comment, locator scripts, `parseTranscript`); the user: "工具输出我感觉没啥用，主要是 message
  和 thinking"; `SessionAgentRef.agent_session_id` reaches iOS through `sessionAgentsUpdated`.
- **D5 The agent session id is never part of command text**: the locator script is a fixed literal
  run as `sh -c <script> sh <id>`, the id validated by the same shape check as the desktop
  (`^[A-Za-z0-9][A-Za-z0-9._-]*$`, ≤ 128). Rejected: interpolating the id. Based on:
  `terminal-transcript.ts` header ("The agent session id is never interpolated into command text").
- **D6 The key is stored per account in the centre, encrypted with the existing executor-secrets
  machinery** (AES-256-GCM, key ids, rotation via `COFLUX_EXECUTOR_KEYS`): one row per account in a
  new table, created by migration 11; writing is refused with a readable error when no encryption
  key is configured, and an undecryptable row is reported as such, never as "not configured".
  Rejected: iOS Keychain (the user: "我们有账号体系，存到我们的数据库里就行"); a hash (the phone needs
  the plaintext). Based on: `apps/server/src/executor-secrets.ts` header and `createExecutorSecrets`;
  prod already has `COFLUX_EXECUTOR_KEYS`.
- **D7 The plaintext leaves the centre only as a direct answer to one connection's explicit
  request; everything broadcast carries status only**: `SpeechKeyStatus { configured, updated_at }`
  goes to each client after its subscribe snapshot and to all of the account's clients after an
  accepted write; `SpeechKeyValue { api_key }` answers `SpeechKeyGet` to the requesting connection
  only. The desktop never requests the value. Rejected: including the key in the broadcast like
  `AgentSettingsUpdated` (it would reach every desktop and stale connection); an HTTP contract
  like `client-executor` (iOS talks to the centre over the WS control channel only, and the
  desktop's settings writes already go over WS). Based on: `DeviceJoinKeyCreated` precedent
  ("only to the requesting connection", `proto/coflux/v1/client.proto`); the user chose
  "中心存、发给手机直连".
- **D8 The phone caches the fetched key in memory, keyed by the status's `updated_at`**: fetched
  on the first dictation of a connection (or when `updated_at` changes), dropped on logout and on
  any status change. Never written to disk or Keychain on the phone. Rejected: fetching on every
  dictation (an extra centre round trip before every connect); persisting it (two copies to keep
  in sync). Based on: (decided while planning).
- **D9 Invalid key = HTTP 401 at the WebSocket handshake**: that, and only that, maps to 「Key
  无效」; every other connect or stream failure maps to 「无法连接识别服务」. Based on: probe with
  two bogus keys → `401` at handshake (2026-11-08).
- **D10 Wire shape** (additive only): `AuthOk.speech_key = 10` (this centre stores the key);
  `ClientToServer.speech_key_set = 51` (`SpeechKeySet { request_id, api_key }`, empty `api_key`
  clears), `ClientToServer.speech_key_get = 52` (`SpeechKeyGet { request_id }`);
  `ServerToClient.speech_key_status = 51` (`SpeechKeyStatus { configured, updated_at, request_id,
  error }`), `ServerToClient.speech_key_value = 52` (`SpeechKeyValue { request_id, api_key, error }`).
  Based on: free numbers on main and on the open PR branches #126/#128/#113 (2026-11-08).
- **D11 Workspace placement**: a new worktree on `dev/20261108-ios-seed-asr`, cut from the Duo
  redesign branch, PR targeting that branch. Rejected: cutting from main (guaranteed conflicts with
  PR #126 in the overlay, account menu and dictation entry). Based on: Discussion log.

### Discussion log

1. Research: which ASR models take context → Doubao (hotwords + dialog context, image on 2.0),
   Qwen3-ASR (10k tokens), OpenAI (`prompt` + `keywords`), Gemini (`custom_vocabulary` only on the
   live transcribe model; full prompt only via non-streaming Flash). No public leaderboard measures
   Chinese or context; recommended a small private eval.
2. "尝试用豆包 doubao-seed-asr-2.0 看看能不能跑通" → probe ran end to end with the user's Agent Plan
   key; context with hotwords + dialog fixed `coflux`/`tailcat`/`derp`.
3. `/dev:explore` "立项在独立的工作区里做".
4. Key storage — options: iOS Keychain (recommended) / centre per account / build-time injection →
   "iOS 钥匙串"; **later overridden** by the user: "我们有账号体系，存到我们的数据库里就行" (D6).
5. Engine order — options: Seed when keyed else unchanged (recommended) / three-level chain / drop
   the input-method channel → user's own answer "只留 Seed ASR，否则提示语音功能不可用" (D1).
6. Context content — the user asked how much context fits; capacity probes measured the window
   (D3). The user: tool output is useless, keep messages and thinking → options: replies + thinking +
   your messages (recommended) / replies + thinking / replies only → "回复 + thinking + 你的消息" (D4).
7. Supplementary context — options: custom word list (recommended) / workspace info / none →
   "工作区信息" only.
8. Product confirmation → "确认".
9. Base branch — options: the Duo branch (recommended) / main → "从 Duo 分支切" (D11).
10. Departure check → direction "按此方向"; execution "Subagent (opus)"; autopilot "计划审计后自动执行".
11. After the departure check the user moved the key to the centre (entry 4) → asked: centre stores
    and hands the key to the phone (recommended) / centre proxies the audio → "中心存、发给手机直连"
    (D7); entry — iOS only (recommended) / iOS and desktop settings → "iOS 和桌面设置页都能录".
12. (decided while planning) uncompressed frames (D2, probed), 401 as the invalid-key signal (D9,
    probed), status-only broadcast with a per-connection value answer (D7), in-memory key cache
    (D8), wire numbers (D10).
13. (revised on plan audit, fable) fixed two `rg` gates that matched nothing (`\|` is a literal
    pipe in ripgrep); kept a ~3 s admission bound in `DictationSession`; clearing the key is always
    allowed even without encryption keys; snapshot status via `sendClientNow`; TS store resets
    follow `agentSettingsSupported` (not on disconnect) and stay out of the offline catalog;
    `.modelDownloading` and two-engine comments removed; the context read is cancellable on
    tap-to-type; the sheet hangs off the page's outermost container. All anchors and the free
    proto/migration numbers were re-verified by the auditor.

### Maintenance notes

- The capacity numbers in D3 are measured behaviour of a hosted service, not a documented
  contract; Volcengine may change truncation. Re-probe before raising the budget.
- The transcript parsers now exist twice (TS on the desktop, Swift on iOS). Vendor format changes
  must be patched in both; the desktop module drops thinking by design, the iOS one keeps it.
- `executor-secrets.ts` now guards a second secret; its error texts mention the executor, so
  callers outside the executor must not surface them verbatim.
- Migration 11 is one-way: an older centre refuses a migrated database.
- The centre cannot tell an iOS connection from a desktop one: "only the phone fetches the key"
  is a client-side policy (the TS store has no getter), not a server guarantee. Any signed-in
  client of the account can request the value.

## Execution brief

> Written for `subagent(opus)` at `a43d9d67`. Implement the tasks in order within each milestone.
> Decide only what Your call leaves to you; on anything else that is unclear, stop and report.

### Goal

Replace iOS dictation's two engines with Doubao Seed-ASR 2.0, send the current agent's
conversation as recognition context, and store the API key on the account in the centre. Work
spans the protobuf contract (`proto/`, generated into TS, Rust and Swift), the TS centre
(`apps/server`), the TS client package and the desktop settings page, the Swift client package,
and the iOS app. Follow the patterns named in each task; write Chinese user-facing copy where the
surrounding UI is Chinese, English code comments. Format TS with the repo's existing tooling
(`pnpm -C apps/desktop lint` runs oxlint in CI; do not reformat untouched files).
Never log, print, or persist the API key anywhere except the encrypted centre column and the
iPhone's process memory.

Milestone dependencies: M1 first. Then M2 (centre), M3 (TS client + desktop) and M4 (Swift
client) are independent of each other — disjoint files — and may run concurrently. M5 (iOS app)
needs M4.

### Milestone 1: the wire contract carries the speech key

Depends on: none

#### T1 · `client.proto` has the speech-key messages and capability

- Where: `proto/coflux/v1/client.proto` — `message AuthOk` (after `bool project_archive = 9;`),
  the `ClientToServer` oneof (after `ProjectSetArchived project_set_archived = 50;`), the
  `ServerToClient` oneof (after `SessionMetadata session_metadata = 50;`), and new messages next
  to `message DeviceJoinKeyCreated`.
- Change: add exactly (D10):
  - `AuthOk`: `bool speech_key = 10;` — comment in the style of `agent_settings`: this centre
    stores the account's dictation API key and accepts `SpeechKeySet`/`SpeechKeyGet`; false = an
    older centre.
  - `message SpeechKeySet { string request_id = 1; string api_key = 2; }` — empty `api_key` clears.
  - `message SpeechKeyGet { string request_id = 1; }`
  - `message SpeechKeyStatus { bool configured = 1; double updated_at = 2; string request_id = 3; string error = 4; }`
  - `message SpeechKeyValue { string request_id = 1; string api_key = 2; string error = 3; }`
  - `ClientToServer`: `SpeechKeySet speech_key_set = 51;`, `SpeechKeyGet speech_key_get = 52;`
  - `ServerToClient`: `SpeechKeyStatus speech_key_status = 51;`, `SpeechKeyValue speech_key_value = 52;`
  - Document each message's delivery rule in its comment (D7): status after the subscribe
    snapshot (empty `request_id`) and to every subscribed client of the account after an accepted
    write (the write's `request_id`; also sent directly to an unsubscribed writer); a non-empty
    `error` answers a rejected write to the writer only and its `configured`/`updated_at` must be
    ignored; `SpeechKeyValue` goes only to the requesting connection — empty `api_key` with empty
    `error` means not configured. `updated_at` is ms epoch, centre clock.
- After: `buf generate` (run from `proto/`) has refreshed `packages/protocol/src/gen`,
  `crates/protocol/src/gen` and `packages/swift-client/Sources/CofluxProtocol/Generated`;
  `buf lint` is clean; the change is purely additive.
- Don't: renumber anything or reuse reserved numbers (4, 16–17, 19–23, 25, 29–31, 33, 35, 36 and
  the reserved server-side ones).

### Milestone 2: the centre stores, reports and hands out the key

Depends on: Milestone 1

#### T2 · Migration 11 creates the account speech-key table

- Where: `apps/server/src/infra/database/schema-migrations.ts` — next to
  `const PROJECT_ARCHIVE_SCHEMA_SQL` and the `MIGRATIONS` entry `version: 10, name: "project_archive"`.
- Change: add `version: 11, name: "account_speech_keys"` creating
  `coflux.account_speech_keys (account_id TEXT PRIMARY KEY REFERENCES coflux.accounts(id) ON DELETE CASCADE, api_key_ciphertext TEXT NOT NULL, updated_at DOUBLE PRECISION NOT NULL)`,
  in the same style as `ACCOUNT_AGENT_SETTINGS_SCHEMA_SQL`.
- After: a fresh database and a database at version 10 both migrate to 11; nothing else in the
  file changes (baseline validation logic untouched).

#### T3 · The store reads, writes and clears the ciphertext

- Where: `apps/server/src/store.ts` — next to the account agent-settings methods (the ones
  querying `account_agent_settings`).
- Change: add methods to get `{ ciphertext, updatedAt } | undefined` for an account, upsert
  `(ciphertext, updatedAt)`, and delete the row.
- After: the store knows nothing about encryption; ciphertext in, ciphertext out.

#### T4 · The hub answers `speechKeySet` / `speechKeyGet` and reports status

- Where: `apps/server/src/hub.ts` — the client message switch (`case "agentSettingSet": {`), the
  subscribe snapshot (where `agentSettingsUpdated` is sent with `requestId: ""`), the `authOk`
  send (`agentSettings: true, sessionMetadata: true, projectArchive: true`), and a new private
  method modelled on `setAgentSetting` and `createJoinKey`.
- Change:
  - `authOk` also sets `speechKey: true`.
  - After the subscribe snapshot, send this client its `speechKeyStatus` (`configured` = a row
    exists, `updatedAt` = the row's or 0, empty `requestId`). Status is computed without
    decrypting. Load it alongside the other snapshot reads and send it with `sendClientNow`, as
    the snapshot's `agentSettingsUpdated` is sent, so it lands before the backlog replay.
  - `speechKeySet`: validate `requestId` like `setAgentSetting` does; trim `apiKey`; reject a key
    longer than 256 characters or containing control characters or whitespace. Empty → delete the
    row — always, even when no encryption key is configured, so a stored key can always be
    cleared. Non-empty → `this.executorSecrets.encrypt(key)` and upsert with `Date.now()`. For a
    non-empty key only, when `this.executorSecrets.available()` is false, reject with a
    speech-specific message, e.g.
    「中心还没有配置凭据加密密钥，拒绝以明文保存 API Key」 (D6) — do not surface the executor's error
    text. On success broadcast `speechKeyStatus` with the write's `requestId` to the account and,
    if the writer is not subscribed, send it to the writer too. Rejections go to the writer only,
    as `speechKeyStatus` with `error` set.
  - `speechKeyGet`: answer only this connection with `speechKeyValue`: the decrypted key; empty
    key and empty error when no row; on a decryption failure an error such as
    「服务端密钥已变更，原先保存的 API Key 无法读取：请重新填写」 (D6) — never "not configured".
  - Both require an authenticated client (follow how the neighbouring cases guard `accountId`).
- After: the plaintext appears only in the `speechKeyValue` answer to the requester (D7); no log
  line contains it; a write with no encryption keys configured stores nothing.
- Don't: put the key in `speechKeyStatus` or in any broadcast (D7); reuse the executor settings
  table or its columns (D6).

### Milestone 3: the desktop can set and clear the key

Depends on: Milestone 1

#### T5 · The TS client store tracks status and writes the key

- Where: `packages/client/src/store.ts` — the `agentSettingsUpdated` case and `setAgentSetting`,
  the `authOk` handling that records `agentSettingsSupported`, and the exported result types near
  `AgentSettingWriteResult`.
- Change: record `speechKeySupported` from `authOk.speechKey`; keep
  `speechKeyStatus: { configured, updatedAt } | null` (null until the first status arrives).
  Reset both at the same points as `agentSettingsSupported` — authError, clientOutdated, logout,
  and an account change in `authOk` — and **not** on disconnect (the neighbours keep state across
  disconnects on purpose). Fail pending `setSpeechKey` promises wherever `failAgentSettingWrites`
  is called, including `disconnect()`. Keep `speechKeyStatus` out of `persistOfflineCatalog`.
  On a status with `error`, settle the
  pending write as failed and do not touch the state; on a status without error, replace the state
  and settle a pending write with the same `requestId` as ok. Add `setSpeechKey(apiKey)` returning
  `{ ok: true } | { ok: false; error }`, with the same not-connected / unsupported / timeout
  handling as `setAgentSetting`. Do not add a function that reads the key value.
- After: a desktop never requests or holds the plaintext key.

#### T6 · A desktop settings section for the key

- Where: `apps/desktop/src/renderer/components/settings/settings-nav.ts` (`SettingsSectionId`,
  `SETTINGS_SECTIONS`), `settings-page.tsx`, a new section component beside `agents-section.tsx`.
- Change: add a section id `speech`, label 「语音识别」, description saying it is the Doubao
  speech-recognition 2.0 (火山方舟 Agent Plan) API key used by iPhone long-press dictation, stored
  on the account and shared by its devices; place it in group 1 after 「Agents」. The section shows
  status 已配置 / 未配置 (or 「服务器版本过旧，不支持保存语音识别 Key」 when unsupported, and a
  loading state before the first status), a password-type input, 「保存」 and 「清除」 (clear asks
  no confirmation; disabled when not configured), and the write's error inline. Follow
  `docs/design-guidelines.md` (Tooltip component, never native `title`) and the layout of the
  existing sections.
- After: `settings-nav.test.ts` still passes (update its expectations if it pins the section list).

### Milestone 4: the Swift client exposes status, write and fetch

Depends on: Milestone 1

#### T7 · `CofluxClient` speaks the speech-key messages

- Where: `packages/swift-client/Sources/CofluxClientCore/CofluxClient.swift` — `case .authOk(let value):`,
  the `apply` switch (`case .secretRequestsUpdated(let value):`), `logout()`, the reset of state on
  disconnect/snapshot, and the public API near `executeInWorkspace`.
- Change:
  - Publish `speechKeySupported: Bool` (from `authOk.speechKey`) and
    `speechKeyStatus: SpeechKeyStatus?` (configured, updatedAt), nil until the first status.
  - Add `setSpeechKey(_ apiKey: String) async -> Result`-style API (ok / error message) and
    `speechKey() async throws -> String` (empty string = not configured). This needs a small
    request/response mechanism keyed by `request_id` with a timeout (~15 s, as the TS store's
    write timeouts) that fails pending requests on disconnect — there is none in the Swift client
    today; build one that both calls share.
  - In-memory cache for the fetched key (D8): reuse it while `speechKeyStatus.updatedAt` is
    unchanged; drop it on any status change, logout, account change and auth error.
- After: `swift test --package-path packages/swift-client` passes; nothing writes the key to disk.
- Don't: store the key in `KeychainTokenStore` or any file (D8).

### Milestone 5: iOS dictation runs on Seed-ASR with conversation context

Depends on: Milestone 4

#### T8 · `SeedASRProvider` implements `SpeechTranscribing`

- Where: new `apps/ios/Coflux/Speech/SeedASRProvider.swift`; protocol in
  `apps/ios/Coflux/Speech/SpeechTranscribing.swift` (`protocol SpeechTranscribing`).
- Change: an actor conforming to `SpeechTranscribing`, initialised with the API key and the
  context items. Protocol facts (verified against the service on 2026-11-08):
  - URL `wss://openspeech.bytedance.com/api/v3/plan/sauc/bigmodel_async`. Request headers:
    `X-Api-Key: <key>`, `X-Api-Resource-Id: volc.seedasr.sauc.duration`, `X-Api-Request-Id` and
    `X-Api-Connect-Id` both one fresh UUID, `X-Api-Sequence: -1`. Keep the response header
    `X-Tt-Logid` for the failure log line (never the key).
  - Every frame: 4-byte header `[0x11, (messageType << 4) | flags, (serialization << 4) | compression, 0x00]`,
    then a big-endian Int32 sequence, then a big-endian UInt32 payload length, then the payload.
    Compression is always 0 (D2).
  - First frame: messageType `0b0001`, flags `0b0001`, serialization 1 (JSON), sequence 1, payload
    UTF-8 JSON:
    `{"user":{"uid":"coflux-ios"},"audio":{"format":"pcm","codec":"raw","rate":16000,"bits":16,"channel":1},"request":{"model_name":"bigmodel","enable_itn":true,"enable_punc":true,"enable_nonstream":true,"show_utterances":true,"result_type":"full","corpus":{"context":"<JSON string>"}}}`
    — omit `corpus` when there is no context item. The context string is
    `{"context_type":"dialog_ctx","context_data":[{"text":…},…]}` serialised to a string (D3).
  - Audio frames: messageType `0b0010`, serialization 0, flags `0b0001`, sequence 2, 3, …; payload
    raw 16 kHz mono Int16 PCM, 200 ms (6400 bytes) per frame. The final frame uses flags `0b0011`
    and the **negated** next sequence number. If no audio was ever sent, still send one final frame
    of 6400 zero bytes.
  - Server frames: header length is `(byte0 & 0x0F) * 4`; messageType `byte1 >> 4`, flags
    `byte1 & 0x0F`. Flag `0x01` → an Int32 sequence follows; flag `0x04` → an Int32 event follows
    (skip it); messageType `0b1111` (error) → an Int32 error code precedes the UInt32 size. Flag
    `0x02` marks the last package. Payload JSON: `result.text` is the full text so far;
    `result.utterances[].definite == true` marks finalised segments. A response frame whose
    compression nibble is not 0 is a protocol failure.
  - Map to `SpeechTranscriptEvent`: emit `.volatile(text)` while any utterance is not definite,
    `.finalized(text)` when all present utterances are definite; after the last package emit the
    final text as `.finalized` then `.closed`.
  - `start()` throws a typed error distinguishing **invalid key** — the handshake answered HTTP 401
    (read the status from the task's `HTTPURLResponse`) — from **unreachable** (everything else,
    including a server error frame before any text) (D9). A server error frame mid-stream yields
    `.failed(…)` with the generic 「无法连接识别服务」 meaning.
  - `finish()` sends the remaining buffered PCM and the final frame, then waits for the last
    package; `cancel()` closes the socket at once.
  - In `SpeechTranscribing.swift`, remove the `.modelDownloading` event case (Apple-only) and
    rewrite the protocol's doc comments for a single engine with no fallback (D1).
- After: the provider never retries and never falls back (D1).
- Don't: gzip anything (D2); send context anywhere but the first frame (D3).

#### T9 · Transcript context for the current terminal

- Where: new `apps/ios/Coflux/Speech/DictationContext.swift` (or similar); data from
  `CofluxClient.sessionAgents` (keyed by session id, `.session.agent`, `.session.agentSessionID`),
  `CofluxClient.executeInWorkspace(workspaceID:command:args:)`, and the project/workspace records
  the views already use for titles.
- Change: port from `apps/desktop/src/renderer/components/workbench/terminal-transcript.ts`:
  - the two locator scripts (`CLAUDE_LOCATOR_SCRIPT`, `CODEX_LOCATOR_SCRIPT`) as fixed literals,
    the header line `coflux-transcript <size> <window>`, exit codes 3 (not found) / 4 (read
    failed); use a tail window of 256 KiB instead of 512 KiB;
  - `transcriptAgentOf` and `isUsableAgentSessionId`; invocation exactly `sh`, `["-c", script, "sh", id]` (D5);
  - the parsers and filters (`isSidechain`, `isMeta`, tool-result-bearing `user` records,
    `INJECTED_PREFIXES`, `LONE_OPENING_TAG`, `SYSTEM_MARKER`), with these differences (D4):
    keep Claude `thinking` blocks (text in the block's `thinking` field) and Codex `reasoning`
    payloads' `summary[].text`; produce no entries for tool calls at all.
  - Build the context items: item 0 is one sentence such as 「当前项目 <project>，工作区
    <workspace>，分支 <branch>。」 (omit unknown parts); then conversation entries newest first,
    each as plain text (prefixing the speaker, e.g. 「我：」/「Agent：」, is allowed), stopping
    when the estimated total exceeds 1500 tokens; truncate the oldest included entry from its
    start rather than dropping a long newest entry entirely (D3).
  - Report whether any conversation entry was included (drives the badge).
- After: a plain shell terminal, an unknown agent, an unusable id, exit 3/4, an exec error or a
  missed deadline all yield only the workspace sentence — never an error shown to the user.
- Don't: interpolate the id into the script (D5); read the terminal screen as context (D4).

#### T10 · `DictationSession` drives only Seed-ASR

- Where: `apps/ios/Coflux/Speech/DictationSession.swift` — `enum Engine`, `enum Phase`,
  `static var permissionsGranted`, `func begin()`, `private func start()` (the Doubao/Apple
  admission and fallback after `let doubao = DoubaoIMEProvider()`), `requestSpeechPermission`.
- Change:
  - `DictationSession` needs the `CofluxClient` and the target terminal (workspace id, session id)
    to fetch the key and build context; pass them in from `WorkspaceDetailView.startDictation()`.
  - Permissions: microphone only. `permissionsGranted` becomes the microphone check; remove
    `import Speech`, `SFSpeechRecognizer` and `requestSpeechPermission`. Keep the existing
    first-grant wait-for-active timing and its comment (the AURemoteIO abort landmine).
  - Start: if the centre is unsupported or `speechKeyStatus?.configured != true`, set an
    *unavailable* phase (distinguishing 「未配置」 from 「服务器版本过旧」) and do not open the
    microphone. Otherwise, concurrently: open the microphone (buffering into the existing
    `pendingPCM`), fetch the key (`speechKey()`), and build the context with a deadline; connect
    `SeedASRProvider` as soon as the key is in hand and the context is ready or its deadline
    passed. Map `start()` failures to 「Key 无效」 / 「无法连接识别服务」 (D9). No fallback (D1).
  - Bound the whole admission (key fetch + context wait + connect) to about 3 s, replacing today's
    `admissionTimeout` (2.5 s) rather than dropping it: on expiry → 「无法连接识别服务」 and
    `capture.stop()`. `finish()` awaits `startTask` first, so an unbounded admission would leave
    the overlay in finalizing for the key fetch's full timeout. Keep `finish()`'s existing wait for
    the final package as is (Seed's two-pass final arrives ~0.7–0.9 s after the last frame).
  - The context read starts with the session (touch-down prewarm) but must be cancellable:
    `cancel()` (the tap-to-type `abortDictation()` path) cancels the context and key-fetch tasks,
    and their late results are ignored. Remove the `.modelDownloading` arm in `apply`.
  - Phase reports whether conversation context was included (for the badge). Replace the
    `.modelDownloading` phase and the Apple-only paths.
  - Keep every existing `teardownRequested` re-check after each `await`, `pendingPCM` replay, and
    `capture.stop()` on every exit path.
- After: `prewarmDictation()` in `WorkspaceDetailView` does nothing when the key is not
  configured (it currently gates on `DictationSession.permissionsGranted`; add the key check);
  finish/cancel semantics seen by `endDictation()` are unchanged.

#### T11 · Overlay states, the settings sheet and its entries

- Where: `apps/ios/Coflux/Speech/DictationOverlay.swift` (`private var engineBadge`, the
  permission-denied text 「需要麦克风与语音识别权限」), `apps/ios/Coflux/Views/HomeComponents.swift`
  (`struct AccountMenu`), `apps/ios/Coflux/Views/WorkspaceDetailView.swift` (overlay
  presentation), a new sheet view under `apps/ios/Coflux/Views/`.
- Change:
  - Badge: 「豆包 · 带语境」 when conversation context was included, else 「豆包」; 「连接中…」
    while connecting. Remove the `.modelDownloading` arms.
  - Attach the sheet's `.sheet` to the outermost container of `WorkspaceDetailView`, next to the
    existing dictation overlay — not to an inner view under the frozen page size
    (`frozenPageSize`; the comment near it records that a `fullScreenCover` re-laid the page out
    on the Duo).
  - Unavailable state: 「语音输入不可用：未配置豆包 API Key」 with a 「去设置」 button that closes
    the overlay and opens the sheet; the old-centre variant has no button. Failure texts per D9.
    Permission denied now reads 「需要麦克风权限」.
  - `AccountMenu` gains 「语音识别…」 above 「退出登录」, opening the sheet.
  - Sheet: title 「语音识别」; status (已配置 / 未配置 / 服务器版本过旧 / loading); a `SecureField`
    for the key; 「保存」 (calls `setSpeechKey`, shows the error inline, dismisses on success) and
    「清除」 (calls `setSpeechKey("")`); one explanatory line that the key is the 火山方舟 Agent Plan
    key for 豆包语音识别 2.0, stored on the account and shared by the account's devices.
  - Follow `AGENTS.md`'s iPhone Duo rules: system containers only (`NavigationStack` +
    `.toolbar` items with icon and title, `.sheet`), no hand-drawn headers or floating buttons,
    layout from the container size, dark theme colours from `Theme.swift`.
- After: the sheet works from both `AccountMenu` call sites (`WorkspaceListView`, `HomeSidebar`)
  and from the overlay's 「去设置」.

#### T12 · The old engines and their dependencies are gone

- Where: `apps/ios/Coflux/Speech/` (`DoubaoIMEProvider.swift`, `DoubaoCredentials.swift`,
  `DoubaoProtobuf.swift`, `DoubaoOpusEncoder.swift`, `AppleSpeechProvider.swift`),
  `apps/ios/Coflux.xcodeproj/project.pbxproj` (the `swift-opus` package reference and the `Opus`
  product/build-file entries), `apps/ios/Coflux-Info.plist` (`NSSpeechRecognitionUsageDescription`
  and its comment line), `apps/ios/CofluxTests/DictationProbeTests.swift`, and the comment in
  `apps/ios/Coflux/Views/TerminalInputArea.swift` that cites `DictationSession.requestSpeechPermission`,
  and the engine comments in `apps/ios/Coflux/Speech/AudioCapture.swift` (the 「做 Opus」 comment)
  and `apps/ios/Coflux/Speech/SpeechTranscribing.swift` (豆包/Apple two-engine wording, if T8 left any).
- Change: delete the five files; remove the Opus package from the project (all entries: build
  file, frameworks phase, package product dependency, remote package reference) and its `swift-opus` pin from
  `apps/ios/Coflux.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved`; delete the plist key; drop the probe tests for deleted
  engines, keeping `audioCaptureStartStop`; reword the stale comment. Also delete the stored
  input-method credential file only if a trivial one-liner does it — otherwise leave it (it is
  harmless).
- After: nothing in `apps/ios` references `Doubao`, `AppleSpeech`, `SFSpeech`, `Opus`, `modelDownloading` or `import Speech` (comments included).
- Don't: hand-edit pbxproj sections you do not understand; the Speech folder's source files are
  not listed in pbxproj (synchronized group), so adding/removing Swift files needs no pbxproj edit.

### Your call

- Names of Swift/TS types and functions not fixed by D10; file layout inside `apps/ios/Coflux/Speech/`.
- The context-read deadline (at most 1.5 s from touch-down) and the token estimator (e.g. CJK
  characters ≈ 1 token, other text ≈ 4 characters per token), as long as the budget is ~1500
  estimated tokens (D3).
- Whether the per-account server writes are serialised like `agentSettingWrites`.
- Sheet and desktop section layout details within the stated content.
- Exact wording of explanatory lines, within the stated meaning.

### Landmines

- `apps/ios/Coflux/Speech/AudioCapture.swift` and the `DictationSession` comments: the microphone
  tap must be stopped on every exit path (a dangling tap makes the next long-press silent or
  crashes), and starting AURemoteIO right after a permission prompt aborts the process.
- `buf generate` uses remote plugins (network) with `clean: true` and rewrites all three generated
  trees; commit them with the proto.
- The shell in this environment is zsh: write `${VAR}:path`, never `$VAR:path` (`:a`, `:h` etc. are
  modifiers).
- Never write the API key into logs, error messages, analytics, test fixtures or files.

### Scope

In scope:
- `proto/coflux/v1/client.proto` and the three generated trees
- `apps/server/src/{hub.ts,store.ts,infra/database/schema-migrations.ts}`
- `packages/client/src/store.ts`
- `apps/desktop/src/renderer/components/settings/`
- `packages/swift-client/Sources/CofluxClientCore/`
- `apps/ios/Coflux/Speech/`, `apps/ios/Coflux/Views/{HomeComponents,WorkspaceDetailView,TerminalInputArea}.swift`, a new sheet view in `apps/ios/Coflux/Views/`, `apps/ios/Coflux.xcodeproj/project.pbxproj` (Opus removal only), `Package.resolved` (Opus removal only), `apps/ios/Coflux-Info.plist`, `apps/ios/CofluxTests/DictationProbeTests.swift`

Out of scope:
- `apps/server/src/executor-secrets.ts` and `executor-settings.ts` — reused, not changed.
- `apps/desktop/src/renderer/components/workbench/terminal-transcript.ts` — the desktop parser keeps dropping thinking.
- `crates/runtime`, `crates/ptyd`, daemon code — no daemon change.
- Desktop dictation, word lists, image context, any other ASR vendor.

### Stop and report if

- A task's anchor is missing, or the code there differs from what the task describes.
- A task needs a file outside the in-scope list.
- Two tasks contradict each other, or a task contradicts the code it changes.
- A proto number in D10 is already taken on this branch.
- `buf generate` cannot run, or the breaking check flags the change.
- `sessionAgents` on iOS does not carry the agent session id for a running agent.
- `URLSessionWebSocketTask` cannot expose the handshake status code, making D9 unobservable.

## Verification

### Milestone validations

- Milestone 1: `cd proto && buf lint && buf generate` then `git status --porcelain -- packages/protocol/src/gen crates/protocol/src/gen packages/swift-client/Sources/CofluxProtocol/Generated` → regenerated and committed, a second `buf generate` adds no diff; `cd proto && node ../scripts/check-protocol-breaking.mjs "../.git#ref=a43d9d67,subdir=proto"` → no breaking change.
- Milestone 2: `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` → exit 0.
- Milestone 3: `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test && pnpm -C apps/desktop build` → exit 0; `pnpm -C apps/desktop lint` → clean.
- Milestone 4: `swift test --package-path packages/swift-client` → exit 0.
- Milestone 5: device compile and test compile (Commands) → succeeded.

### Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Protocol lint + generate | `cd proto && buf lint && buf generate` | clean, no diff after commit |
| Protocol breaking | `cd proto && node ../scripts/check-protocol-breaking.mjs "../.git#ref=a43d9d67,subdir=proto"` | no breaking change |
| Rust build | `cargo build` | zero warnings |
| Rust protocol tests | `cargo test -p coflux-protocol` | exit 0 |
| Server typecheck | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| Desktop | `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test && pnpm -C apps/desktop build` | exit 0 |
| Swift client | `swift test --package-path packages/swift-client` | exit 0 |
| iOS device compile | `xcodebuild build -project apps/ios/Coflux.xcodeproj -scheme Coflux -destination 'generic/platform=iOS' -skipPackagePluginValidation -allowProvisioningUpdates` | `** BUILD SUCCEEDED **` (needs the Metal Toolchain) |
| iOS test compile | `xcodebuild build-for-testing -project apps/ios/Coflux.xcodeproj -scheme Coflux -destination 'generic/platform=iOS' -skipPackagePluginValidation -allowProvisioningUpdates` | `** TEST BUILD SUCCEEDED **` |
| Black-box (wire touched) | `pnpm -C tests test` (clear inherited `COFLUX_*` variables first; local Postgres on 5432) | all pass |
| Key never leaves except on request | `rg -n 'apiKey|api_key' apps/server/src/hub.ts` and read each hit | plaintext only in the `speechKeyValue` answer; no log call carries it |
| Old engines gone | `rg -n 'Doubao|AppleSpeech|SFSpeech|Opus|import Speech|modelDownloading' apps/ios` | no hits |
| Centre round trip (acceptance) | local stack (`pnpm dev:pg`, `pnpm dev:server` with `COFLUX_EXECUTOR_KEYS` set), desktop dev against it: save a key, restart the server, status still 已配置; clear → 未配置 | as described |
| Device walkthrough (acceptance) | the user on iPhone Duo after the centre is deployed | see Done criteria |

### Done criteria

- [ ] All listed non-acceptance commands pass.
- [ ] Every task's `After` state holds.
- [ ] `speechKeyStatus` never carries the key; `speechKeyValue` is sent only to the requesting connection (read the diff).
- [ ] With `COFLUX_EXECUTOR_KEYS` unset, `speechKeySet` with a non-empty key stores nothing and returns an error.
- [ ] The Swift client never writes the key to disk or Keychain (read the diff).
- [ ] The locator invocation is `sh -c <fixed literal> sh <id>` with the id validated (read the diff).
- [ ] Conversation context drops tool calls/results and keeps thinking (read the parser).
- [ ] No fallback engine remains; only the microphone permission is requested.
- [ ] (acceptance, user) Badge 「豆包 · 带语境」 in an agent terminal; agent-mentioned names recognised; clearing the key → 不可用 + 去设置; a key saved on the desktop works on the iPhone; a wrong key → 「Key 无效」.
- [ ] No out-of-scope files changed.
- [ ] The Outcome is appended and `wiki/plans/README.md` status is updated.

### Merge and deploy

- The branch is stacked on `dev/20261107-ios-duo-redesign` (PR #126); open the PR against that branch and merge it after #126, or retarget to main once #126 lands.
- Deploy order: centre first (migration 11, new messages), then the desktop and the iOS build. Migration 11 is one-way — an older centre refuses the migrated database; take the usual pre-deploy backup on coflux-bj.
- The centre needs `COFLUX_EXECUTOR_KEYS` (already configured in production); without it saving the key is refused.
- iOS reaches the user through TestFlight (`apps/ios/release.sh`); an older iOS build keeps the removed engines until updated.
- Volcengine usage is billed to the user's Ark Agent Plan quota (`volc.seedasr.sauc.duration`).
