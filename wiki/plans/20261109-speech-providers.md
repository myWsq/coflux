# Plan 20261109-speech-providers: dictation chooses its provider — Doubao Seed-ASR or OpenAI Realtime — each with its own base URL, model and key

> Three parts for three readers. The Record says why and stays true after the
> code moves on. The Execution brief is the only part a delegated executor
> receives. Verification is the orchestrator's. At close, `dev:execute-plan`
> appends an Outcome and updates `wiki/plans/README.md`.
>
> Drift check: `git diff --stat 56db5dcb..HEAD -- proto/coflux/v1/client.proto apps/server/src/hub.ts apps/server/src/store.ts apps/server/src/infra/database/schema-migrations.ts apps/server/src/executor-secrets.ts packages/client/src/store.ts apps/desktop/src/renderer/components/settings packages/swift-client/Sources/CofluxClientCore apps/ios/Coflux/Speech apps/ios/Coflux/Views/SpeechSettingsSheet.swift apps/ios/Coflux/Views/HomeComponents.swift apps/ios/Coflux/Views/WorkspaceDetailView.swift`

## Status

- Priority: P2
- Effort: L
- Risk: MED
- Depends on: none (builds on the shipped `wiki/plans/20261108-ios-seed-asr.md`)
- Category: feature
- Execution: subagent(opus) — departure check
- Stop after: implementation — departure check (plain autopilot)
- Plan review: none — departure check (the audit was recommended for the one-way migration and the shared contract; the user chose plain autopilot)
- Workspace: isolated — planned from the main worktree; branch `dev/20261109-speech-providers`, worktree `/Users/wsq/Workspace/coflux/.claude/worktrees/20261109-speech-providers`
- Planned at: `56db5dcb`, 2026-11-09

## Record

### Requirement

iOS long-press dictation is hard-wired to one engine: Doubao Seed-ASR 2.0 through the Ark Agent
Plan endpoint, with a fixed URL, a fixed resource id, and one account-level API key. The only
setting anywhere is that key (desktop 「语音识别」 settings section, iOS account menu 「语音识别…」).
The user wants the shape every other model setting has: choose a **provider**, and give it a
**base URL**, a **model** and a **key**.

Product conclusions (confirmed at the product gate):

- **Providers**: exactly two, both streaming WebSockets that show text while the user speaks —
  **豆包 Seed-ASR** (the existing engine) and **OpenAI Realtime** transcription.
- **Shape**: the account stores one configuration per provider — base URL, model, key — plus
  which provider is **in use**. Switching back and forth never requires re-entering a key. The key
  stays write-only: clients learn only whether one is stored and when it was written. Base URL and
  model are not secret and are shown back in the form.
- **Defaults** (an empty field means the default):
  - 豆包: base URL `wss://openspeech.bytedance.com/api/v3/plan/sauc/bigmodel_async`, model
    (Volcengine resource id) `volc.seedasr.sauc.duration`.
  - OpenAI: base URL `https://api.openai.com/v1`, model `gpt-live-transcribe`.
- **OpenAI models are live models only**: `gpt-live-transcribe` and its dated
  `gpt-live-transcribe-*` snapshots. Other transcription models (`gpt-transcribe`,
  `gpt-4o-transcribe`, …) only transcribe after the audio is committed, so they would show nothing
  while the user speaks; they are refused when saving.
- **Migration is silent**: the Doubao key already stored becomes the 豆包 configuration, and 豆包
  is the provider in use. The user does nothing after upgrading.
- **Context**: both providers get the same recognition context as today — the workspace sentence
  and the tail of the agent's conversation. 豆包 keeps `dialog_ctx`; OpenAI receives it as its
  transcription `prompt`.
- **UI** (desktop 「语音识别」 section and the iOS sheet share one structure):

  ```
  当前使用   [ 豆包 Seed-ASR | OpenAI Realtime ]
  ── 豆包 Seed-ASR ─────────────  ● 已配置
     Base URL  [stored value, default as placeholder]
     模型      [stored value, default as placeholder]
     API Key   [已保存（留空则不改）]          [保存] [清除]
  ── OpenAI Realtime ───────────  ○ 未配置
     … same fields …
  ```

  The existing states stay: disabled while offline, 「服务器版本过旧」 against an older centre,
  reading, inline success and error. Switching 当前使用 takes effect at once.
- **Dictation overlay**: with no key for the provider in use, the overlay reads
  「语音输入不可用：未配置 {provider} API Key」 with 「去设置」; the badge names the provider in use
  (「豆包 · 带语境」 / 「OpenAI · 带语境」, without 「· 带语境」 when no conversation went in). The
  interaction itself (long-press, slide to 取消 / 发送, confirm state) is unchanged.
- **Both platforms edit everything.**
- **Non-goals**: non-streaming `/audio/transcriptions`; a 「测试连接」 button (the key is in the
  centre, a client cannot probe on its own; a wrong setting shows up in the overlay); a third
  provider; more than one configuration per provider; dictation on the desktop.
- **Observable when done**: with OpenAI in use and keyed, a long-press on the iPhone shows text
  while speaking and the final text on release; switching back to 豆包 needs no key; after the
  upgrade the old 豆包 key still works; a custom base URL or model is the one actually used; an
  older iPhone build that has not been updated yet keeps dictating with the 豆包 key.

### Decisions & tradeoffs

- **D1 Two streaming providers, one recognition model per session**: 豆包 Seed-ASR over the
  existing Volcengine binary protocol, OpenAI over the Realtime API in a transcription session.
  Rejected: an OpenAI-compatible `/v1/audio/transcriptions` provider (upload after release, no
  text while speaking; broader third-party reach was not wanted); a second 豆包 credential style
  (App ID + Access Token). Based on: Discussion log 1.
- **D2 OpenAI accepts live models only**: a model is valid when it is `gpt-live-transcribe` or
  `gpt-live-transcribe-` followed by `[A-Za-z0-9._-]+`; anything else is refused by the centre and
  flagged by the forms. Rejected: accepting any model and showing text only after release; per-model
  session shapes with server VAD. Based on: OpenAI docs (realtime-transcription guide, 2026-11-09):
  `gpt-live-transcribe` is "a streaming speech-to-text model … low-latency transcript deltas from
  live audio" and supports neither `server_vad` nor `semantic_vad`; `gpt-transcribe` emits deltas
  only after `input_audio_buffer.commit`. Discussion log 5.
- **D3 One configuration slot per provider plus an account-level active provider**: the slot holds
  base URL, model and an optional key ciphertext; the active provider is separate state. A slot can
  exist without a key, and a provider without a key can be active (dictation then says it is not
  configured). Rejected: a single `{provider, base URL, model, key}` record (switching would
  discard the other provider's key). Based on: Discussion log 3.
- **D4 The centre stores what the user typed; clients resolve defaults**: an empty base URL or
  model is stored and transmitted as empty, and each client maps empty to the provider's default
  (the TS client for placeholders, the Swift client for placeholders and for connecting). The
  centre knows no defaults. Rejected: the centre substituting defaults (a later change of default
  would be frozen into every stored row). Based on: (decided while planning).
- **D5 The centre is the authority on validity**: provider must be 豆包 or OpenAI; base URL empty or
  an absolute URL of at most 512 characters with no credentials, query or fragment, scheme `wss:`
  for 豆包 and `https:` for OpenAI; model empty or at most 128 characters — 豆包
  `^[A-Za-z0-9][A-Za-z0-9._-]*$`, OpenAI per D2; key rules unchanged (≤ 256 characters, no
  whitespace or control characters). The forms check the same rules for immediate feedback but
  never instead of the centre. Rejected: client-only validation (two clients, one stored record).
  Based on: existing key checks `MAX_SPEECH_KEY_CHARS` / `SPEECH_KEY_INVALID_CHARS` in
  `apps/server/src/hub.ts`; executor endpoints use REST-style base URLs
  (`apps/desktop/src/renderer/components/settings/executor-endpoint-dialog.tsx`, placeholder
  `https://example.com/v1`).
- **D6 Provider endpoint semantics**: 豆包's base URL is the full `wss://` endpoint and its model is
  sent as `X-Api-Resource-Id`, keeping `X-Api-Key`; OpenAI's base URL is the REST base, from which
  the client derives the socket URL by switching `https:` to `wss:`, dropping trailing slashes and
  appending `/realtime?intent=transcription`, authenticated with `Authorization: Bearer <key>`.
  Rejected: asking OpenAI users for a `wss://…/realtime` URL (unlike every other OpenAI setting).
  Based on: `apps/ios/Coflux/Speech/SeedASRProvider.swift` (`endpoint`, `resourceID`, headers);
  OpenAI Realtime reference: `wss://api.openai.com/v1/realtime`, `intent=transcription`, Bearer auth.
- **D7 Secrecy is unchanged**: base URL, model, `key_configured` and `updated_at` are broadcast in a
  status message to every client of the account; the plaintext key goes only to the connection that
  explicitly asks for one provider's credentials, is never logged, and on the phone lives only in
  process memory, cached per provider and invalidated when that provider's slot changes. Rejected:
  putting the key in the broadcast. Based on: D7/D8 of `wiki/plans/20261108-ios-seed-asr.md`.
- **D8 The wire is additive, and the old key messages keep working as the 豆包 slot**: new messages
  and a new `AuthOk` capability carry provider configurations; `SpeechKeySet` / `SpeechKeyGet` /
  `SpeechKeyStatus` stay, now meaning "the 豆包 slot's key", so a v2.23.x iPhone or desktop keeps
  working against the new centre until it is updated. Every accepted write — old or new message —
  broadcasts both the new status and the old status. New clients use only the new messages.
  Rejected: retiring the old messages now (an iPhone on the older TestFlight build would lose
  dictation until it is updated by hand). Based on: Discussion log 6; TestFlight upload is manual
  (2.23.0 release notes / `apps/ios/release.sh`).
- **D9 Migration 12 moves the stored keys into provider slots, in one transaction**: every row of
  `coflux.account_speech_keys` becomes that account's 豆包 slot with an empty base URL and model and
  the same ciphertext and `updated_at`; the old table is then dropped; an account without an active
  provider row is treated as 豆包. One-way, like every migration here. Rejected: keeping
  `account_speech_keys` beside the new tables (two sources of truth for the 豆包 key). Based on:
  `apps/server/src/infra/database/schema-migrations.ts` (`ACCOUNT_SPEECH_KEYS_SCHEMA_SQL`, migration
  runner inside `pool.begin`).
- **D10 OpenAI session shape**: one transcription session per dictation — `session.update` with
  `type: "transcription"`, `audio.input.format` `audio/pcm` at 24 000 Hz, `transcription.model`,
  `transcription.prompt` (the context), `transcription.languages: ["zh", "en"]`, and
  `turn_detection: null`; audio streams as `input_audio_buffer.append` while the user speaks, one
  `input_audio_buffer.commit` on release; deltas are the draft, the completion event is the final
  text. HTTP 401 at the handshake means an invalid key, as for 豆包. Capture runs at 24 kHz for
  OpenAI and 16 kHz for 豆包. Rejected: resampling 16 kHz audio up (quality loss for nothing; the
  capture already converts from the hardware rate). Based on: OpenAI realtime-transcription guide
  (24 kHz example, `turn_detection` null for `gpt-live-transcribe`, `languages` accepted by the live
  model); `apps/ios/Coflux/Speech/AudioCapture.swift` (`targetFormat` 16 kHz). `languages` is
  (decided while planning): the user dictates Chinese with English technical terms.
- **D11 Wire shape** (field numbers verified free on main at `56db5dcb`; no open PR touches
  `client.proto`):
  - `enum SpeechProvider { SPEECH_PROVIDER_UNSPECIFIED = 0; SPEECH_PROVIDER_DOUBAO = 1; SPEECH_PROVIDER_OPENAI = 2; }`
  - `message SpeechProviderConfig { SpeechProvider provider = 1; string base_url = 2; string model = 3; bool key_configured = 4; double updated_at = 5; }`
  - `message SpeechConfigSet { string request_id = 1; SpeechProvider provider = 2; string base_url = 3; string model = 4; string api_key = 5; bool clear_api_key = 6; }` — replaces that slot's base URL and model; a non-empty `api_key` replaces the key, `clear_api_key` removes it, neither keeps it; both at once is refused.
  - `message SpeechActiveSet { string request_id = 1; SpeechProvider provider = 2; }`
  - `message SpeechCredentialsGet { string request_id = 1; SpeechProvider provider = 2; }`
  - `message SpeechConfigStatus { SpeechProvider active = 1; repeated SpeechProviderConfig providers = 2; string request_id = 3; string error = 4; }` — `providers` always lists both providers, in enum order.
  - `message SpeechCredentials { string request_id = 1; SpeechProvider provider = 2; string base_url = 3; string model = 4; string api_key = 5; string error = 6; }` — stored values (empty = default), only to the requester; empty `api_key` with empty `error` = no key.
  - `AuthOk.speech_providers = 11`; `ClientToServer`: `speech_config_set = 53`, `speech_active_set = 54`, `speech_credentials_get = 55`; `ServerToClient`: `speech_config_status = 53`, `speech_credentials = 54`.
  Based on: `proto/coflux/v1/client.proto` (`speech_key_get = 52`, `speech_key_value = 52`,
  `speech_key = 10`); delivery rules copied from `SpeechKeyStatus` / `SpeechKeyValue`.

### Discussion log

1. Providers — options: 豆包 + OpenAI-compatible `/audio/transcriptions` (recommended) / 豆包 only
   with an open base URL / 豆包 + OpenAI Realtime / 豆包 with both credential styles +
   OpenAI-compatible → "豆包 + OpenAI Realtime" (D1).
2. Model field — options: add it with per-provider defaults (recommended) / hard-code the model per
   provider → "加模型字段，带默认值".
3. Configuration shape — options: one configuration per provider with an active selector
   (recommended) / a single configuration → "两家各存一套，选一个生效" (D3).
4. Product confirmation — options: confirm (recommended) / add 「测试连接」 / iOS only switches
   provider and edits the key → "确认".
5. Technical recon found that only `gpt-live-transcribe` streams text before commit, contradicting
   "both show live text" for other OpenAI models — options: other models show text after release
   (recommended) / server VAD for other models / allow live models only → "模型只允许 live 类" (D2).
6. Departure check — direction "按此方向" (the alternative offered was dropping the old-message
   compatibility, D8); execution "Subagent (opus)"; autopilot "直接自动执行" (the plan audit had been
   recommended for the one-way migration and the contract shared by three clients).
7. (decided while planning) the centre stores raw values and clients resolve defaults (D4); the
   validation rules (D5); the socket URL derivation (D6); migration 12 drops the old table (D9);
   `languages: ["zh", "en"]` (D10); the wire shape and numbers (D11); credentials requested per
   provider rather than "the active one", so a switch racing a dictation cannot hand the phone the
   wrong provider's key.

### Maintenance notes

- The OpenAI session facts in D2/D10 come from OpenAI's documentation, not from a live probe at
  planning time. If OpenAI renames the live model, changes the accepted sample rate or moves the
  transcript events, D2's pattern and the iOS provider change together.
- The old `SpeechKey*` messages (D8) are a transition path. Remove them — and the double broadcast —
  once no client older than this plan is in use; that removal is a breaking proto change and needs
  the usual `reserved` entries.
- Defaults live in two clients (TS and Swift, D4). A new default must be changed in both.
- Migration 12 is one-way: an older centre refuses the migrated database, so rolling the centre back
  means restoring the pre-deploy backup.
- `executor-secrets.ts` errors mention the executor; speech callers keep mapping them to their own
  text.
- The centre still cannot tell an iPhone from a desktop: "only the phone fetches credentials" is
  client policy (the TS client exposes no credentials getter), not a server guarantee.

## Execution brief

> Written for `subagent(opus)` at `56db5dcb`. Implement the tasks in order within each milestone.
> Decide only what Your call leaves to you; on anything else that is unclear, stop and report.

### Goal

Today iOS dictation always uses 豆包 Seed-ASR with a fixed endpoint and one account-level key. After
this change the account holds one configuration per provider — 豆包 Seed-ASR and OpenAI Realtime —
each with a base URL, a model and an optional encrypted key, plus which provider is in use. The
desktop settings page and the iOS sheet edit all of it; iOS dictation connects to the provider in
use. The work spans the protobuf contract (`proto/`, generated into TS, Rust and Swift), the TS
centre (`apps/server`), the TS client package and the desktop settings page, the Swift client
package, and the iOS app. Follow the existing speech-key code paths named in each task: this change
generalises them, it does not invent new machinery. Chinese user-facing copy where the surrounding
UI is Chinese, English code comments. Do not reformat untouched files; the desktop CI runs
`pnpm -C apps/desktop lint` (oxlint). Never log, print or persist an API key anywhere except the
encrypted centre column and the iPhone's process memory.

Provider defaults, used wherever "the default" appears below (D4):

| Provider | Display name | Short name (badge) | Default base URL | Default model |
| --- | --- | --- | --- | --- |
| 豆包 | 豆包 Seed-ASR | 豆包 | `wss://openspeech.bytedance.com/api/v3/plan/sauc/bigmodel_async` | `volc.seedasr.sauc.duration` |
| OpenAI | OpenAI Realtime | OpenAI | `https://api.openai.com/v1` | `gpt-live-transcribe` |

Validation rules, enforced by the centre and mirrored by both forms (D5): base URL empty, or an
absolute URL ≤ 512 characters with no username/password, no query, no fragment, no whitespace or
control characters, scheme `wss:` for 豆包 and `https:` for OpenAI; model empty, or ≤ 128
characters matching `^[A-Za-z0-9][A-Za-z0-9._-]*$` for 豆包 and
`^gpt-live-transcribe(-[A-Za-z0-9._-]+)?$` for OpenAI (D2); key ≤ 256 characters with no whitespace
or control characters (unchanged). The OpenAI model refusal reads
「OpenAI 只支持 gpt-live-transcribe 系列的实时转写模型」.

Milestone dependencies: M1 first. Then M2 (centre), M3 (TS client + desktop) and M4 (Swift client)
touch disjoint files and are independent of each other. M5 (iOS app) needs M4.

### Milestone 1: the wire contract carries provider configurations

Depends on: none

#### T1 · `client.proto` has the provider messages and capability

- Where: `proto/coflux/v1/client.proto` — `message AuthOk` (after `bool speech_key = 10;`), the
  `ClientToServer` oneof (after `SpeechKeyGet speech_key_get = 52;`), the `ServerToClient` oneof
  (after `SpeechKeyValue speech_key_value = 52;`), and the new types next to `message SpeechKeyValue`.
- Change: add exactly the enum, messages, `AuthOk` field and oneof entries of D11, with names and
  numbers as written there. Comment each in the style of the neighbouring `SpeechKey*` comments:
  `AuthOk.speech_providers` = this centre stores per-provider dictation configurations and accepts
  the three new requests; `SpeechConfigStatus` goes to the client after the subscribe snapshot
  (empty `request_id`) and, after every accepted write of any speech message, to every subscribed
  client of the account (that write's `request_id`; also directly to an unsubscribed writer); a
  non-empty `error` answers a rejected `SpeechConfigSet`/`SpeechActiveSet` to the writer only and
  its other fields must be ignored; `SpeechCredentials` goes only to the requesting connection.
  `updated_at` is the slot's last accepted write in ms epoch, centre clock, 0 for a slot never
  written. Amend the existing `SpeechKeySet`/`SpeechKeyGet`/`SpeechKeyStatus` comments to say they
  now address the 豆包 slot's key and remain for clients older than `speech_providers` (D8).
- After: `buf generate` (run from `proto/`) has refreshed `packages/protocol/src/gen`,
  `crates/protocol/src/gen` and `packages/swift-client/Sources/CofluxProtocol/Generated`; `buf lint`
  is clean; the change is purely additive.
- Don't: renumber, remove or rename any existing field or message (D8).

### Milestone 2: the centre stores provider slots and serves both old and new messages

Depends on: Milestone 1

#### T2 · Migration 12 turns the key table into provider slots

- Where: `apps/server/src/infra/database/schema-migrations.ts` — next to
  `const ACCOUNT_SPEECH_KEYS_SCHEMA_SQL` and the `MIGRATIONS` entry `version: 11, name: "account_speech_keys"`.
- Change: add `version: 12, name: "account_speech_providers"` whose SQL creates
  `coflux.account_speech_providers (account_id TEXT NOT NULL REFERENCES coflux.accounts(id) ON DELETE CASCADE, provider TEXT NOT NULL CHECK (provider IN ('doubao', 'openai')), base_url TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '', api_key_ciphertext TEXT, updated_at DOUBLE PRECISION NOT NULL, PRIMARY KEY (account_id, provider))`
  and `coflux.account_speech_settings (account_id TEXT PRIMARY KEY REFERENCES coflux.accounts(id) ON DELETE CASCADE, active_provider TEXT NOT NULL CHECK (active_provider IN ('doubao', 'openai')), updated_at DOUBLE PRECISION NOT NULL)`,
  copies every `coflux.account_speech_keys` row into `account_speech_providers` as
  `(account_id, 'doubao', '', '', api_key_ciphertext, updated_at)`, then drops
  `coflux.account_speech_keys` (D9). Follow the existing pattern: a `const …_SCHEMA_SQL` string used
  as both `definition` and `apply`.
- After: on a database at version 11 with stored keys, migrating to 12 leaves each account with a
  豆包 slot holding the same ciphertext and `updated_at`, no settings row, and no
  `account_speech_keys` table; a fresh database ends with the two new tables only.
- Don't: edit the version 11 entry or its SQL — its checksum is in every production ledger.

#### T3 · The store reads and writes slots and the active provider

- Where: `apps/server/src/store.ts` — the section `/* ---------------------- account speech key ---------------------- */`
  (`getSpeechKey`, `setSpeechKey`, `clearSpeechKey`).
- Change: replace those three methods with store methods over the new tables: read an account's
  slots plus its active provider (no settings row → `'doubao'`); upsert one slot's base URL and
  model together with a key action — keep the stored ciphertext, replace it, or set it to NULL — and
  the slot's `updated_at`; set the active provider. The store never encrypts or decrypts. Each write
  is a single statement or a transaction, so a slot is never half-written.
- After: a keep-key write on a slot that does not exist yet creates it with a NULL key; a
  replace-key write on an existing slot leaves no stale key; nothing reads `account_speech_keys`.

#### T4 · The hub serves the new messages and keeps the old ones as the 豆包 slot

- Where: `apps/server/src/hub.ts` — the speech constants after
  `const SPEECH_KEY_INVALID_CHARS`, the subscribe snapshot (`this.store.getSpeechKey(accountId)` in
  the `Promise.all` and the `sendClientNow(client, { case: "speechKeyStatus", …` line after it), the
  dispatch cases `case "speechKeySet":` / `case "speechKeyGet":`, the `authOk` send (`speechKey: true`),
  and the methods `setSpeechKey` and `getSpeechKey`.
- Change:
  - Capability: `authOk` also sets `speechProviders: true`.
  - Snapshot: read the account's slots once and send `speechConfigStatus` (both providers in enum
    order, empty `requestId`) and, derived from the 豆包 slot, the old `speechKeyStatus`
    (`configured` = 豆包 key stored, `updatedAt` = 豆包 slot `updated_at`, 0 when absent). The
    snapshot never decrypts.
  - `speechConfigSet`: validate per the Goal's rules (D5) — request id as today, provider not
    UNSPECIFIED, trimmed base URL and model, key rules, `api_key` and `clear_api_key` not both set;
    encrypt a new key only after `executorSecrets.available()` as `setSpeechKey` does today
    (clearing or keeping needs no encryption key); write through the per-account chain
    `speechKeyWrites`; on success broadcast both statuses (below); on any rejection answer the
    writer alone with `speechConfigStatus` carrying `error` and the write's `requestId`.
  - `speechActiveSet`: validate the provider, write the active provider through the same chain,
    broadcast both statuses.
  - `speechCredentialsGet`: answer only the requesting connection with `speechCredentials` for the
    requested provider — stored base URL and model, decrypted key or empty when none; an
    undecryptable ciphertext is an `error` (reuse the existing 「服务端密钥已变更…」 text), never "no
    key".
  - Old messages (D8): `speechKeySet` becomes a write of the 豆包 slot's key only — base URL and
    model kept — with today's validation and error texts; `speechKeyGet` answers with the 豆包 slot's
    key exactly as today's `speechKeyValue`.
  - Broadcast rule: every accepted write of any of the four write paths sends, to every subscribed
    client of the account and directly to an unsubscribed writer, both `speechConfigStatus` and the
    old `speechKeyStatus`, each with the write's `requestId`.
- After: an old client can still save, clear and fetch the 豆包 key and sees 已配置/未配置 follow
  writes made through the new messages; a new client sees base URL, model, `keyConfigured` and
  `updatedAt` for both providers and the active one; no status message carries a key; no log line
  carries a key or a base URL's secret parts (the URL has none by D5, but log only the provider and
  account).
- Don't: decrypt anything for a status; send `speechCredentials` or `speechKeyValue` to anyone but
  the requester (D7); surface `ExecutorSecrets*Error` messages to clients.

### Milestone 3: the TS client and the desktop settings section edit both providers

Depends on: Milestone 1

#### T5 · The TS client store exposes provider configurations

- Where: `packages/client/src/store.ts` — `export type SpeechKeyStatus`, `SpeechKeyWriteResult`,
  `SPEECH_KEY_WRITE_TIMEOUT_MS`, the state fields `speechKeySupported` / `speechKeyStatus`, the
  pending-write machinery `speechKeyRequest` / `pendingSpeechKeyWrites` / `settleSpeechKeyWrite` /
  `failSpeechKeyWrites` / `speechKeyAccount`, the `authOk` handling (`value.speechKey`), the
  `case "speechKeyStatus":` handler, `function setSpeechKey`, and every reset site that clears
  `speechKeyStatus` (logout, auth error, outdated, account change, disconnect).
- Change: replace the key-only state with the provider configuration: a supported flag from
  `AuthOk.speechProviders`, and a configuration value (active provider plus, per provider, base URL,
  model, `keyConfigured`, `updatedAt`) that is null until the first `speechConfigStatus` and is
  replaced by every status without `error`. Writes: one call that sends `speechConfigSet` for a
  provider (base URL, model, and keep / replace / clear for the key), and one that sends
  `speechActiveSet`; both resolve `{ ok: true }` when the status with their `requestId` arrives and
  `{ ok: false, error }` on a rejection, timeout, disconnect or logout — the same lifecycle and the
  same Chinese failure texts as today's speech-key writes. Export the provider defaults table from
  the Goal (display name, default base URL, default model) and a validation helper implementing the
  Goal's rules, for the settings form. Keep the reset rules exactly as `speechKeyStatus` has them
  (kept across disconnects, reset on account change, logout, auth error, outdated; never saved with
  the offline catalogue).
- After: the store no longer sends `speechKeySet` and ignores `speechKeyStatus`; it has no getter
  for credentials (D7).
- Don't: keep the old `setSpeechKey` API alongside the new one (D8 compatibility lives in the
  centre, not in new clients).

#### T6 · The desktop 「语音识别」 section edits the active provider and both slots

- Where: `apps/desktop/src/renderer/components/settings/speech-section.tsx` (`export function SpeechSection`),
  and the `id: "speech"` entry's `description` in `apps/desktop/src/renderer/components/settings/settings-nav.ts`.
- Change: rebuild the section to the confirmed structure: a 「当前使用」 control choosing between
  「豆包 Seed-ASR」 and 「OpenAI Realtime」 that writes at once; then one group per provider with a
  status dot (已配置 / 未配置, plus 「最近一次保存」 when `updatedAt > 0`), a Base URL input and a 模型
  input prefilled with the stored values and showing the provider's default as placeholder, a
  password API Key input that always starts empty (placeholder 「已保存（留空则不改）」 when a key is
  stored), and 「保存」 / 「清除」. 保存 sends that provider's base URL and model as typed and the key
  only when one was typed; 清除 removes the key and keeps the stored base URL and model. Inline
  errors from the validation helper appear before sending; the centre's error otherwise. Keep the
  existing disabled states (offline, unsupported centre, status not yet read) and the inline
  success/error feedback. Update the nav description to name both providers instead of only
  「豆包语音识别 2.0（火山方舟 Agent Plan）」. Use astryx components only (see
  `apps/desktop/.claude/CLAUDE.md`; follow `docs/design-guidelines.md`, Tooltip instead of `title`).
- After: switching 当前使用 needs no other action; saving one provider never changes the other's
  fields or key; an OpenAI model outside D2 cannot be saved and says why.
- Don't: show or request a stored key (D7); add a 「测试连接」 button (non-goal).

### Milestone 4: the Swift client exposes provider configurations and per-provider credentials

Depends on: Milestone 1

#### T7 · `CofluxClient` speaks the new messages

- Where: `packages/swift-client/Sources/CofluxClientCore/SpeechKey.swift` (`SpeechKeyStatus`,
  `SpeechKeyWriteResult`, `SpeechKeyError`) and `packages/swift-client/Sources/CofluxClientCore/CofluxClient.swift`
  — `speechKeySupported`, `speechKeyStatus`, `enum ControlReply`, `cachedSpeechKey`, the `authOk`
  handling (`value.speechKey`), `case .speechKeyStatus` / `case .speechKeyValue` in the message
  switch, `// MARK: - Speech key (plan 20261108-ios-seed-asr)` with `setSpeechKey` and `speechKey()`,
  and `resetSpeechKeyState()`.
- Change: mirror T5 in Swift: a supported flag from `AuthOk.speechProviders`; an observable
  configuration value (active provider, per-provider base URL, model, `keyConfigured`, `updatedAt`)
  replaced by every `speechConfigStatus` without `error`; async writes for one provider's
  configuration (keep / replace / clear key) and for the active provider, answered through the
  existing `controlRequest` machinery; and an async credentials fetch for one named provider that
  sends `speechCredentialsGet` and returns the base URL and model **with defaults already resolved**
  (empty → the Goal's default) plus the key. Cache fetched credentials in memory per provider,
  valid while that provider's `updatedAt` is unchanged and invalidated by any status change of that
  slot, by logout and by account change — never on disk or in the Keychain (D7). Put the provider
  enum, display and short names, and the defaults table in `SpeechKey.swift` (rename the file if you
  like) so the iOS app reads them from one place.
- After: the client no longer sends `speechKeySet`/`speechKeyGet` and ignores their answers; a
  credentials fetch for 豆包 while OpenAI is active returns 豆包's slot (credentials are asked for by
  provider, not "the active one").
- Don't: resolve defaults anywhere but here and in the TS store (D4); write the key anywhere
  persistent.

### Milestone 5: iOS dictation and settings use the provider in use

Depends on: Milestone 4

#### T8 · Capture runs at the provider's sample rate

- Where: `apps/ios/Coflux/Speech/AudioCapture.swift` — `private let targetFormat` (16 000 Hz) and
  `func start()`.
- Change: let the caller choose the target sample rate per start (16 000 for 豆包, 24 000 for
  OpenAI, D10); everything else — the tap, the converter from the hardware rate, the stop paths —
  unchanged.
- After: a 豆包 session receives exactly what it receives today; an OpenAI session receives 24 kHz
  mono Int16 PCM.

#### T9 · 豆包 reads its endpoint and resource id from the configuration

- Where: `apps/ios/Coflux/Speech/SeedASRProvider.swift` — `private static let endpoint`,
  `private static let resourceID`, `init(apiKey:contextItems:)`.
- Change: take the resolved base URL and model from the caller instead of the two constants; the
  model goes into `X-Api-Resource-Id` (D6). Nothing else in the protocol changes.
- After: with default credentials the provider behaves byte-for-byte as today.

#### T10 · An OpenAI Realtime transcriber

- Where: a new file next to `SeedASRProvider.swift` in `apps/ios/Coflux/Speech/`, conforming to
  `protocol SpeechTranscribing` in `SpeechTranscribing.swift`. The app target uses a
  file-system synchronized group (`PBXFileSystemSynchronizedRootGroup`, path `Coflux`), so a new
  file under `apps/ios/Coflux/` is in the target without editing `project.pbxproj`.
- Change: an actor that, per D6/D10: derives the socket URL from the resolved base URL; opens a
  `URLSessionWebSocketTask` (ephemeral session) with `Authorization: Bearer <key>`; on `start()`
  sends the `session.update` of D10 with the context as `prompt` and throws an invalid-key error
  for HTTP 401 at the handshake and an unreachable error for every other connect failure (the same
  two-way split `SeedASRStartError` makes, D9 of the previous plan — share or mirror that enum);
  `feed(pcm:)` buffers and sends `input_audio_buffer.append` events with base64 audio in chunks of
  roughly 100–200 ms; `finish()` sends any remaining audio (a session that sent none sends a short
  silence first, since committing an empty buffer is an error), then `input_audio_buffer.commit`,
  then waits a bounded time (2–3 s, like Seed's `finalResultTimeout`) for the completion event;
  `cancel()` closes at once. Map `conversation.item.input_audio_transcription.delta` to
  `.volatile(<all text so far>)` and `…completed` to `.finalized(transcript)` — events carry the full
  text, never a delta (see `SpeechTranscriptEvent`); an `error` event after start is `.failed` with
  the unreachable text; the stream ends with `.closed` exactly once. Build the `prompt` from
  `DictationContext.items` within the existing `DictationTranscript.tokenBudget`. Log failures the
  way `SeedASRProvider` does — status codes and ids, never the key or the prompt.
- After: the same `DictationSession` flow drives either provider without knowing which protocol
  runs underneath.
- Don't: enable `server_vad` or `semantic_vad` (D2/D10); send the key anywhere but the handshake
  header.

#### T11 · The dictation session picks the provider in use

- Where: `apps/ios/Coflux/Speech/DictationSession.swift` — `enum Unavailability`, `enum Phase`,
  `static func isAvailable(on:)`, `private func start()` (the `client.speechKeySupported` /
  `speechKeyStatus` guards, `client.speechKey()`, `SeedASRProvider(apiKey:contextItems:)`, the
  `SeedASRStartError` switch); `apps/ios/Coflux/Speech/DictationOverlay.swift` —
  `private var engineBadge` (「豆包 · 带语境」) and `private var restingFooter`
  (「语音输入不可用：未配置豆包 API Key」, 「…不支持语音识别 Key」); and any caller of
  `isAvailable(on:)` or `.unavailable` (`apps/ios/Coflux/Views/WorkspaceDetailView.swift`).
- Change: at touch-down read the active provider from the client's configuration; available means
  the centre supports provider configurations and that provider has a key. Start capture at that
  provider's rate (T8), fetch that provider's credentials (T7), and build the matching transcriber
  (T9/T10); keep the admission bound, the pending-PCM buffering, the context deadline and every
  teardown check as they are (scale the pending-PCM cap to the capture rate if you keep it in
  bytes). Carry the provider into the not-configured state and the active phase so the overlay can
  say 「语音输入不可用：未配置 {display name} API Key」 and badge 「{short name} · 带语境」 / 「{short name}」.
  The outdated-server text becomes 「语音输入不可用：服务器版本过旧，不支持语音识别设置」.
- After: with 豆包 in use everything behaves as today; with OpenAI in use and keyed the overlay
  shows OpenAI's live text; a provider without a key never opens the microphone and offers 「去设置」.
- Don't: fall back to the other provider when one fails (D1 of the previous plan still holds: no
  fallback engine).

#### T12 · The iOS 「语音识别」 sheet edits the active provider and both slots

- Where: `apps/ios/Coflux/Views/SpeechSettingsSheet.swift` (`struct SpeechSettingsSheet`).
- Change: rebuild the sheet to the same structure as the desktop (T6) with system Form controls: a
  「当前使用」 picker that writes at once; a section per provider with its status (已配置 / 未配置),
  Base URL and 模型 text fields prefilled with stored values and the default as placeholder, a
  `SecureField` for the key that starts empty, and 「清除」 when a key is stored; the toolbar 「保存」
  writes every provider section the user changed (key only when typed) and dismisses on success,
  keeping the error inline otherwise. Mirror the Goal's validation for inline feedback. Keep
  `.preferredColorScheme(.dark)`, the presentation modifiers, `Theme` colours, and clearing typed
  keys on disappear. Follow the iOS rules in `AGENTS.md` (system containers and toolbars only; the
  toolbar items keep an icon and a title).
- After: no edit is silently dropped — a failed write leaves the sheet open with the user's input;
  the stored key is never shown.

### Your call

- Swift and TS API names, file splits inside the touched packages, and how state is modelled
  internally, within the semantics above.
- The exact desktop control for 「当前使用」 (segmented control or selector) and the iOS picker style.
- Error texts other than the ones quoted in this brief, in the tone of the existing speech texts.
- How the OpenAI `prompt` is laid out (order, separators) within the token budget.
- Chunk size for `input_audio_buffer.append` (within 100–200 ms) and the final wait bound (2–3 s).
- Whether the 豆包 and OpenAI start errors share one enum.

### Landmines

- Generated code: never hand-edit `packages/protocol/src/gen`, `crates/protocol/src/gen` or
  `packages/swift-client/Sources/CofluxProtocol/Generated`; regenerate with `buf generate` from
  `proto/`.
- The OpenAI Realtime event names and the 24 kHz requirement come from OpenAI's documentation and
  were not probed live while planning; implement them as written, and report any place where the
  documented event shape seemed ambiguous instead of guessing a second shape.
- The Swift message switch in `CofluxClient.swift` has a `default:` branch; removing the old
  `speechKeyStatus`/`speechKeyValue` cases must not swallow the new ones.
- Rust: `crates/protocol` is generated only; nothing in the runtime consumes these messages, but
  the zero-warning `cargo build` must still pass after generation.

### Scope

In scope:
- `proto/coflux/v1/client.proto` and the three generated trees
- `apps/server/src/infra/database/schema-migrations.ts`, `apps/server/src/store.ts`, `apps/server/src/hub.ts`
- `packages/client/src/store.ts`
- `apps/desktop/src/renderer/components/settings/speech-section.tsx`, `apps/desktop/src/renderer/components/settings/settings-nav.ts`
- `packages/swift-client/Sources/CofluxClientCore/SpeechKey.swift` (or its renamed successor), `packages/swift-client/Sources/CofluxClientCore/CofluxClient.swift`, Swift client tests under `packages/swift-client/Tests` only if existing tests reference the removed API
- `apps/ios/Coflux/Speech/` (all files), `apps/ios/Coflux/Views/SpeechSettingsSheet.swift`, `apps/ios/Coflux/Views/WorkspaceDetailView.swift` and `apps/ios/Coflux/Views/HomeComponents.swift` only where they reference the changed session or settings API

Out of scope:
- `apps/server/src/executor-secrets.ts` — reused as is
- The dictation context reader (`DictationContextSource`, the locator scripts, the transcript parsers) — unchanged apart from reading `DictationContext.items` for the prompt
- Executor endpoint settings (`executor-endpoint-dialog.tsx`, `executor-section.tsx`) — a look-alike that must not change
- Release notes, `docs/`, `wiki/plans/README.md` — the orchestrator's

### Stop and report if

- A task's anchor is missing, or the code there differs from what the task describes.
- A task needs a file outside the in-scope list.
- Two tasks contradict each other, or a task contradicts the code it changes.
- `buf generate` changes generated files unrelated to `client.proto`, or the breaking check reports
  a breaking change.
- Migration 12 cannot be written as one SQL string run by the existing runner.

## Verification

### Milestone validations

- Milestone 1: `cd proto && buf lint && buf generate`, then a second `buf generate` adds no diff;
  `cd proto && node ../scripts/check-protocol-breaking.mjs "../.git#ref=56db5dcb,subdir=proto"` →
  no breaking change.
- Milestone 2: `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` → exit 0.
- Milestone 3: `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test && pnpm -C apps/desktop build`
  → exit 0; `pnpm -C apps/desktop lint` → clean.
- Milestone 4: `swift test --package-path packages/swift-client` → exit 0.
- Milestone 5: iOS device compile and test compile (Commands) → succeeded.

### Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Protocol lint + generate | `cd proto && buf lint && buf generate` | clean, no diff after commit |
| Protocol breaking | `cd proto && node ../scripts/check-protocol-breaking.mjs "../.git#ref=56db5dcb,subdir=proto"` | no breaking change |
| Rust build | `cargo build` | zero warnings |
| Rust protocol tests | `cargo test -p coflux-protocol` | exit 0 |
| Server typecheck | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| Desktop | `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test && pnpm -C apps/desktop build && pnpm -C apps/desktop lint` | exit 0, lint clean |
| Swift client | `swift test --package-path packages/swift-client` | exit 0 |
| iOS device compile | `xcodebuild build -project apps/ios/Coflux.xcodeproj -scheme Coflux -destination 'generic/platform=iOS' -skipPackagePluginValidation -allowProvisioningUpdates` | `** BUILD SUCCEEDED **` (needs `apps/ios/Frameworks/CofluxTailcat.xcframework`, gitignored — copy it from the main worktree, and the Metal Toolchain) |
| iOS test compile | `xcodebuild build-for-testing -project apps/ios/Coflux.xcodeproj -scheme Coflux -destination 'generic/platform=iOS' -skipPackagePluginValidation -allowProvisioningUpdates CODE_SIGNING_ALLOWED=NO` | `** TEST BUILD SUCCEEDED **` |
| Black-box (wire touched) | `pnpm -C tests test` (clear inherited `COFLUX_*` variables, unset `FORCE_COLOR`; local Postgres on 5432) | all pass |
| Keys stay out of broadcasts and logs | `rg -n 'apiKey|api_key|ciphertext' apps/server/src/hub.ts` and read each hit | plaintext only in `speechCredentials` / `speechKeyValue` answers; no log call carries it |
| Migration and compat round trip (acceptance) | throwaway script against a centre started by the test harness or `pnpm dev:server` on a database first brought to version 11 with a stored key: migrate to 12; then drive old and new messages over the WS | see Done criteria |
| OpenAI provider against the live service (acceptance) | if an OpenAI key is available to the orchestrator: compile `OpenAIRealtimeTranscriber`'s source into a macOS harness as was done for `SeedASRProvider`, stream a short recording at 24 kHz | deltas before release, final after commit, bogus key → invalid-key error; otherwise record it as unverified |
| Device walkthrough (acceptance) | the user on iPhone Duo after the centre is deployed | see Done criteria |

### Done criteria

- [ ] All listed non-acceptance commands pass.
- [ ] Every task's `After` state holds.
- [ ] After migration 12 an account's old key is its 豆包 slot, active provider 豆包, and an old
      `speechKeyGet` still returns it (acceptance script).
- [ ] Old `speechKeySet` changes only the 豆包 key; new `speechConfigSet` for OpenAI leaves the 豆包
      slot untouched; every accepted write is followed by both `speechConfigStatus` and
      `speechKeyStatus` to the account's clients (acceptance script).
- [ ] The centre refuses `gpt-4o-transcribe` for OpenAI, an `http:` OpenAI base URL, an `https:`
      豆包 base URL, a URL with a query, and `api_key` together with `clear_api_key` — each with an
      error to the writer only (acceptance script).
- [ ] `speechConfigStatus` never carries a key; `speechCredentials` goes only to the requester (read
      the diff).
- [ ] With `COFLUX_EXECUTOR_KEYS` unset, a key write is refused while clearing and base-URL/model
      writes succeed.
- [ ] The Swift client resolves defaults and never persists a key (read the diff).
- [ ] The OpenAI session sends `turn_detection: null`, 24 kHz `audio/pcm`, the model, the prompt and
      `languages: ["zh", "en"]` (read the diff).
- [ ] (acceptance, user) With OpenAI in use, live text while speaking and final text on release;
      switching back to 豆包 needs no key; an untouched upgrade keeps 豆包 working; an older iPhone
      build still dictates; a wrong key → 「Key 无效」; no key → 「未配置 {provider} API Key」 + 去设置.
- [ ] No out-of-scope files changed.
- [ ] The Outcome is appended and `wiki/plans/README.md` status is updated.

### Merge and deploy

- Deploy order: centre first (migration 12 and the new messages), then the desktop release, then the
  iOS build through TestFlight (`apps/ios/release.sh`, manual). Clients older than this plan keep
  working against the new centre through the old messages (D8); new clients against an old centre
  show 「服务器版本过旧」.
- Migration 12 is one-way and rewrites the stored speech keys (drops `account_speech_keys`): take the
  usual pre-deploy backup on the centre host (coflux-bj) before deploying.
- The centre needs `COFLUX_EXECUTOR_KEYS` (already configured in production); without it saving a key
  is refused.
- OpenAI usage is billed to whatever OpenAI key the user stores; nothing in the centre calls OpenAI.
