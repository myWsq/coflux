# Plan 20261109-dictation-refine: dictation gets mixed Chinese/English terms right — fuller recognition context, then an optional LLM pass that corrects terms from the conversation and the repository

> Three parts for three readers. The Record says why and stays true after the
> code moves on. The Execution brief is the only part a delegated executor
> receives. Verification is the orchestrator's. At close, `dev:execute-plan`
> appends an Outcome and updates `wiki/plans/README.md`.
>
> Drift check: `git diff --stat 23ca7cc4..HEAD -- proto/coflux/v1/client.proto apps/server/src/hub.ts apps/server/src/store.ts apps/server/src/infra/database/schema-migrations.ts packages/client/src apps/desktop/src/renderer/components/settings/speech-section.tsx packages/swift-client/Sources/CofluxClientCore apps/ios/Coflux/Speech apps/ios/Coflux/Views/SpeechSettingsSheet.swift apps/ios/Coflux/Views/WorkspaceDetailView.swift crates/runtime/src/device.rs crates/runtime/src/ops.rs`

## Status

- Priority: P2
- Effort: L
- Risk: MED
- Depends on: `wiki/plans/20261109-speech-providers.md` (PR #129, open, not merged) — this branch is stacked on `dev/20261109-speech-providers`
- Category: feature
- Execution: subagent(opus) — departure check
- Stop after: implementation — departure check (plain autopilot)
- Plan review: none — departure check (the audit was recommended for the one-way migration 13, the contract shared by three clients and the unmerged base; the user chose plain autopilot)
- Workspace: isolated — planned from the main worktree; branch `dev/20261109-dictation-refine` cut from `dev/20261109-speech-providers` (`23ca7cc4`) at the user's request ("看下 PR 129, 基于这个做"), worktree `/Users/wsq/Workspace/coflux/.claude/worktrees/20261109-dictation-refine`; the pull request targets `dev/20261109-speech-providers`
- Planned at: `23ca7cc4`, 2026-11-09

## Record

### Requirement

iOS long-press dictation to agent terminals keeps getting mixed Chinese/English technical terms
wrong (the user: "现在总是有一些中英混杂的术语识别不准"). The user confirmed three kinds of error:
generic English technical words spoken inside Chinese (rebase, worktree, hook, PR), project-specific
words (file, function and product names), and words the agent has just said in the conversation.

The recognition engines (豆包 Seed-ASR, OpenAI Realtime since PR #129) take a context of the
workspace sentence plus the tail of the agent's conversation, capped at about 1500 estimated
tokens because Seed keeps only the newest ~1500–2000 tokens. Two gaps were found:

- The budget is not even full: the transcript read is a 256 KiB tail, and in tool-heavy Claude
  sessions most of those bytes are tool output that the parser discards, leaving about 1000 tokens.
- File names and identifiers live mostly in tool calls, which the context drops entirely; and a
  recognition context can only bias the recogniser — it cannot be instructed, and it does nothing
  for a generic English word heard as a Chinese homophone.

When this is done, two layers improve accuracy:

1. **Recognition context (no visible change)**: the conversation read fills the budget, and a short
   term sentence — identifiers from the agent's tool-call inputs and the repository's file names —
   rides in the context for both engines.
2. **识别后整理 (new, optional)**: after recognition, an account-configured OpenAI-compatible chat
   model corrects the text, given a much larger context than the recogniser can take.

Product conclusions (confirmed at the product gate, "确认"):

- **Settings**: the speech settings (desktop 「语音识别」 section and the iOS 「语音识别…」 sheet, both
  as reshaped by #129) gain a third group, 「识别后整理」, beside the two engines and outside the
  当前使用 selector: an on/off switch, an OpenAI-compatible Base URL, a 模型 and an API Key. The key
  is write-only and account-level, stored encrypted in the centre, like the engine keys. Both
  platforms edit everything. When the switch is on, Base URL and 模型 are required (no defaults). A
  one-line explanation says what it does and suggests a fast model without deep thinking.

  ```
  ── 识别后整理 ─────────  [开关]  ● 已配置
     用大模型按对话和仓库术语纠正识别结果。建议选不带深度思考的快速模型。
     Base URL  [https://…/v1]
     模型      [model id]
     API Key   [已保存（留空则不改）]          [保存] [清除]
  ```

- **Off, or not fully configured** (switch off, or no key, Base URL or model): dictation behaves
  exactly as it does today.
- **Release flow when on**: 识别中 → 整理中 → result, on both release paths.
  - Release in place → the confirm state shows the corrected text, headed 「识别结果 · 已整理」, with
    a 「看原文」 toggle that switches to the recogniser's text and back. 发送 and 编辑 use the
    version on screen.
  - Slide onto 发送 → waits for the correction, then sends it.
  - The whole correction is bounded (about 3 s after the recogniser's final text). On timeout or any
    failure the recogniser's text is used, never blocking; the confirm state then reads
    「识别结果 · 未整理」.
- **What the model receives** (sent to the provider the user configured, about 20–30k tokens): a
  longer stretch of the agent conversation (replies, thinking, the user's own messages), the inputs
  of the agent's tool calls (paths, commands, search terms — never tool output), and the
  repository's file and directory names.
- **What the model is told**: correct only misheard terms, mixed Chinese/English spelling and
  casing; never reorder, polish, answer, translate or add anything; output only the corrected text.
- **Non-goals**: polishing or rewriting; correcting while the user is still speaking; desktop
  dictation; a user-edited glossary; vendor-specific request options.
- **Observable when done**: rebase, worktree, Tailcat, file and function names come out right;
  「看原文」 shows what the recogniser heard; switching 识别后整理 off restores today's behaviour; a
  configuration entered on the desktop works on the iPhone.

### Decisions & tradeoffs

- **D1 Two layers, both in this plan**: the recognition-context improvements ship together with the
  correction pass. Rejected: only the correction pass (words just said in the conversation are
  still misheard, so the recogniser's own context is demonstrably underfed); only the context fix
  (cannot fix generic English words heard as Chinese, the user's first error kind). Based on:
  Discussion log 1, 6; `apps/ios/Coflux/Speech/DictationContext.swift` (`tailBytes = 256 * 1024`,
  `tool_use and everything else: no entry`); ios-seed-asr maintenance note (~1000 tokens from the
  tail in tool-heavy sessions).
- **D2 The correction runs on the iPhone and calls the provider directly**: the phone fetches the
  correction key from the centre on request, keeps it in process memory only, and POSTs to the
  provider itself. Rejected: running it on the workspace's device (the key would have to travel to
  that device, and the runtime has no LLM client); the centre proxying the request (local-first: the
  centre never sits in a path the phone can close itself). Based on: the 豆包 and OpenAI engines
  already connect from the phone with a centre-held key (`wiki/plans/20261109-speech-providers.md`
  D7).
- **D3 The correction configuration is its own record, not a third speech provider**: one row per
  account with `enabled`, base URL, model and an optional encrypted key; it is carried in a new
  field of `SpeechConfigStatus` and written and read through new messages. It is never a value of
  `SpeechProvider` and never selectable as 当前使用. Rejected: adding `SPEECH_PROVIDER_REFINE` to the
  enum (`SpeechActiveSet` would have to refuse it, and `SpeechConfigStatus.providers` is documented
  as "always lists both providers", which clients built from #129 rely on); one correction model per
  engine (two configurations for the same job). Based on: `proto/coflux/v1/client.proto`
  (`SpeechConfigStatus` comment: "`providers` always lists both providers, in enum order");
  Discussion log 3.
- **D4 Wire shape** (additive only; numbers verified free on `23ca7cc4`):
  - `message SpeechRefineConfig { bool enabled = 1; string base_url = 2; string model = 3; bool key_configured = 4; double updated_at = 5; }`
  - `SpeechConfigStatus.refine = 5` (`SpeechRefineConfig`), always present in a status without an
    error.
  - `message SpeechRefineSet { string request_id = 1; bool enabled = 2; string base_url = 3; string model = 4; string api_key = 5; bool clear_api_key = 6; }` —
    replaces `enabled`, base URL and model; a non-empty `api_key` replaces the key, `clear_api_key`
    removes it, neither keeps it, both at once is refused. Answered with `SpeechConfigStatus`
    carrying the same `request_id`.
  - `message SpeechRefineCredentialsGet { string request_id = 1; }` — answered with
    `message SpeechRefineCredentials { string request_id = 1; string base_url = 2; string model = 3; string api_key = 4; string error = 5; }`,
    only to the requesting connection.
  - `ClientToServer.speech_refine_set = 56`, `ClientToServer.speech_refine_credentials_get = 57`,
    `ServerToClient.speech_refine_credentials = 55`, `AuthOk.speech_refine = 12`.
  Based on: `client.proto` on `23ca7cc4` (`speech_credentials_get = 55`, `speech_credentials = 54`,
  `speech_providers = 11`, `SpeechConfigStatus` fields 1–4).
- **D5 Secrecy is the same as for engine keys**: the plaintext key appears only in a
  `SpeechRefineCredentials` answer to the connection that asked; statuses and broadcasts carry
  `key_configured` and `updated_at` only; no log line carries the key, the conversation context or
  the dictated text; the phone caches the credentials in memory, invalidated when the refine
  record's `updated_at` changes and on logout. Rejected: any broadcast of the key. Based on:
  `wiki/plans/20261109-speech-providers.md` D7.
- **D6 The centre validates the correction record**: base URL empty or an absolute `https:` URL of
  at most 512 characters with no credentials, query or fragment (the same rule #129 applies to the
  OpenAI engine); model empty or at most 128 characters matching `^[A-Za-z0-9][A-Za-z0-9._:/-]*$`
  (model ids such as `deepseek-chat`, `doubao-seed-1-6-flash-250828`, `openai/gpt-4o-mini`); key
  rules unchanged; `enabled = true` with an empty base URL or model is refused. Writing a key without
  `COFLUX_EXECUTOR_KEYS` is refused while the other fields and clearing still save, as for engine
  keys. The forms mirror these rules for immediate feedback only. Based on: `speechBaseUrlError`,
  `speechKeyError` in `apps/server/src/hub.ts`; #129 D5.
- **D7 Migration 13 adds `coflux.account_speech_refine`** (account id primary key, cascade on account
  delete, `enabled`, `base_url`, `model`, nullable `api_key_ciphertext`, `updated_at`); no row means
  disabled and unconfigured. Additive, but like every migration here an older centre refuses the
  migrated database. Rejected: columns on `account_speech_settings` (that table is the 当前使用
  selector). Based on: `ACCOUNT_SPEECH_PROVIDERS_SCHEMA_SQL` and the `MIGRATIONS` list in
  `apps/server/src/infra/database/schema-migrations.ts`.
- **D8 Two transcript reads at touch-down, both filtered on the device**: the locator scripts drop
  the transcript lines that carry tool output (Claude records containing `"type":"tool_result"`;
  Codex `function_call_output` / `custom_tool_call_output` records and `event_msg` records, which
  repeat command output and are ignored by the parser anyway) before printing, so the bytes
  that reach the phone are mostly prose and tool inputs. The recognition read keeps today's transfer
  size (at most 256 KiB of filtered output) and today's 1.2 s deadline; the correction read is a
  second, larger one (at most 1 MiB of filtered output) that only has to be ready when the
  recogniser finishes. The script stays a fixed literal; the session id stays a positional argument,
  and a size travels only as a fixed literal or a positional argument validated as digits, never
  interpolated into the script. Rejected: one large read for both (a slower transfer would push the
  recognition context past its 1.2 s deadline and lose it, a regression); filtering on the phone
  only (the phone would download the tool output it then throws away). Based on:
  `DictationContext.swift` (locator scripts, `contextDeadline` in `DictationSession.swift`); the
  device's `ExecRun` path has no output cap of its own (`crates/runtime/src/device.rs`
  `Payload::ExecRun` → `crate::ops::run_command`), so the scripts must bound their output; the
  seed-asr plan D5 (id never in command text).
- **D9 Tool-call inputs are kept as short fields only**: from Claude `tool_use` blocks and Codex
  function calls, only fields that name things — file paths, paths, commands, glob and search
  patterns, queries, URLs — each value capped (about 300 characters). File contents, edit strings
  (`old_string`, `new_string`, `content`), patches, code bodies (Codex `custom_tool_call` inputs
  are patches or code-mode snippets: take at most the command strings they plainly contain, or
  nothing) and tool output never become context. Rejected:
  whole tool inputs (a Write or Edit input is a file body and would drown the terms); tool output
  (the user: "工具输出我感觉没啥用"; Discussion log 4). Based on: Discussion log 4.
- **D10 Repository terms come from `git ls-files` in the workspace**, run at touch-down in parallel
  as its own exec with a fixed literal script whose output is bounded on the device (at most
  256 KiB); the phone derives file basenames, stems and directory names, deduplicated. Missing git,
  a non-repository or an error yields no terms, never a failure. Based on: Discussion log 4;
  `client.executeInWorkspace` runs in the workspace root (`workspace_root` in the `ExecRun` handler).
- **D11 The recognition context gains one term sentence**: placed right after the workspace sentence,
  at most about 200 of the 1500 estimated tokens, listing distinct terms — the ones from the most
  recent tool inputs and conversation first, then repository names — in the form
  「相关术语：A、B、C。」. Both engines receive it, since both take the same context items. Rejected: a
  hotword list (the seed-asr probe found sentences beat hotwords, and lists lose effect past ~80
  items). Based on: `wiki/plans/20261108-ios-seed-asr.md` D3.
- **D12 The correction request**: `POST {base URL without trailing slashes}/chat/completions` with
  `Authorization: Bearer <key>`, non-streaming, `temperature: 0`, a bounded `max_tokens`, one system
  message holding the fixed instructions and one user message ordered for prefix caching — workspace
  sentence, term list, then the conversation in chronological order, then the recogniser's text,
  clearly delimited, last. Budget about 24k estimated tokens in total; when it is exceeded the oldest
  conversation goes first. No vendor-specific fields. Rejected: newest-first ordering (each new
  dictation would change the prefix and defeat provider prefix caching); streaming (nothing is shown
  until the whole answer is checked anyway). Based on: Discussion log 4; OpenAI-compatible chat
  completions is the one shape Ark, DeepSeek and OpenAI all accept.
- **D13 The answer is checked before it replaces anything**: the first choice's message content,
  trimmed, with one surrounding pair of quotes or one code fence removed, is accepted only if it is
  non-empty and its length is within 0.5×–2× of the recogniser's text (in characters). Anything else
  — HTTP error, timeout, unparsable body, a failed check — means the recogniser's text, marked
  未整理. No retry. Rejected: trusting the answer (a model that answers the question instead of
  correcting it would send that answer to the agent). Based on: Discussion log 2.
- **D14 Time bounds**: the correction phase — waiting for its context and the request together — is
  bounded at about 3 s from the moment the recogniser's final text is available; if the larger
  correction context is not ready in time, the correction uses whatever context is ready (at least
  the recognition context). The recognition admission and its 1.2 s context deadline are unchanged.
  Based on: Discussion log 2 ("超时（如 3 秒）或失败就用 ASR 原文，绝不卡住").
- **D15 The toggle shows only when the texts differ** (decided while planning): when the corrected
  text equals the recogniser's text the header still reads 「识别结果 · 已整理」 but no 「看原文」 toggle
  is offered — there is nothing to compare.

### Discussion log

1. Error kinds (multi-select) — options: generic English tech words / project-specific words /
   casing and format / words just said in the conversation → "通用英文技术词, 项目专有词, 对话里刚说过的词"
   (D1).
2. When the correction shows — options: both release paths wait for it, timeout falls back to the
   raw text, confirm state can switch to 原文 (recommended) / correct only the confirm state / show
   the raw text first and swap in the correction → "两条路径都整理" (product conclusions, D13, D14).
3. Where the correction model is configured — options: a new slot in the speech settings
   (recommended) / reuse the executor's model configuration / reuse the 豆包 key against Ark chat
   models (unverified) → "看下 PR 129, 基于这个做". Then, on #129's shape — options: an independent
   「识别后整理」 group (recommended) / the same with an option to share the 豆包 key / one correction
   model under each engine → "独立「识别后整理」分区" (D3).
4. What the model receives (multi-select) — options: longer agent conversation / tool-call inputs /
   repository term list / tool output (not recommended) → the first three (D9, D10, D12).
5. Product confirmation → "确认".
6. Departure check — direction "按此方向" (the alternative offered was splitting into a context-only
   plan first); execution "Subagent (opus)"; autopilot "直接自动执行" (the plan audit had been
   recommended).
7. (decided in exploration, technical) the correction runs on the phone (D2); two filtered reads
   (D8); request shape and ordering (D12); answer checks (D13).
8. (decided while planning) the record is separate from `SpeechProvider` (D3); wire numbers (D4);
   model id pattern (D6); migration 13 as its own table (D7); term sentence size and form (D11); the
   toggle only when texts differ (D15).

### Maintenance notes

- The 0.5×–2× length check (D13) and the ~3 s bound (D14) are judgment, not measurement. If real use
  shows legitimate corrections being refused, or slow providers always timing out, retune them —
  and measure the chosen model's latency with a ~24k-token prompt before raising the budget.
- Reasoning models (deep thinking on by default) will usually miss the 3 s bound and show 未整理
  every time; the settings copy steers users to fast models, and no vendor switch is sent (D12).
- The transcript filters in the locator scripts (D8) match the vendors' current JSONL spelling. A
  format change makes them filter less (more bytes, same result), not break parsing — but the
  parsers in `DictationContext.swift` and the desktop's `terminal-transcript.ts` must still be kept
  in step by hand.
- The correction sends conversation and repository file names to a third-party provider the user
  chose; that is the product decision, recorded here so a later reviewer does not "fix" it silently.
- Migration 13 stacks on #129's one-way migration 12: the centre deploy carries both, and rolling
  back means restoring the pre-deploy backup.

## Execution brief

> Written for `subagent(opus)` at `23ca7cc4`. Implement the tasks in order within each milestone.
> Decide only what Your call leaves to you; on anything else that is unclear, stop and report.

### Goal

iOS dictation gets mixed Chinese/English terms right in two ways. First, the recognition context the
engines already receive gets fuller: the transcript read is filtered on the device so the 1500-token
budget fills with prose, and a short term sentence (identifiers from tool-call inputs, repository
file names) is added. Second, an optional account-level 「识别后整理」 configuration (switch, OpenAI-
compatible base URL, model, write-only key) lets the iPhone send the recogniser's final text, with a
large context, to a chat model that corrects only misheard terms; the confirm state can show either
version.

This builds directly on PR #129's speech configuration (already on this branch): follow its patterns
everywhere — the wire messages and capability flag, the per-account write chain and status broadcast
in `apps/server/src/hub.ts`, the store methods in `apps/server/src/store.ts`, the TS store's
`speechConfig` state and write helpers in `packages/client/src/store.ts`, the Swift client's
`SpeechConfig` / credentials cache in `packages/swift-client/Sources/CofluxClientCore`, and the
settings group structure in `apps/desktop/src/renderer/components/settings/speech-section.tsx` and
`apps/ios/Coflux/Views/SpeechSettingsSheet.swift`. Generated protocol code comes from
`cd proto && buf generate`; never hand-edit files under `gen/` or `Generated/`. Code comments are in
English; user-facing copy is the Chinese given here.

Milestone dependencies: M1 first. M2, M3 and M4 each need only M1 and are independent of each other
(disjoint files). M5 needs M4.

### Milestone 1: the wire carries the correction configuration

Depends on: none

#### T1 · `client.proto` declares the correction record, its messages and capability

- Where: `proto/coflux/v1/client.proto` — after `message SpeechCredentials`; the `ClientToServer`
  oneof after `SpeechCredentialsGet speech_credentials_get = 55;`; the `ServerToClient` oneof after
  `SpeechCredentials speech_credentials = 54;`; `message AuthOk` after `bool speech_providers = 11;`;
  `message SpeechConfigStatus`.
- Change: add exactly the shapes of D4: `SpeechRefineConfig`, `SpeechConfigStatus.refine = 5`,
  `SpeechRefineSet`, `SpeechRefineCredentialsGet`, `SpeechRefineCredentials`, the oneof entries
  `speech_refine_set = 56`, `speech_refine_credentials_get = 57`, `speech_refine_credentials = 55`,
  and `AuthOk.speech_refine = 12`. Comment each like its #129 neighbours: what it carries, who
  receives it, that the key never appears outside `SpeechRefineCredentials`, and that the
  `api_key` / `clear_api_key` semantics match `SpeechConfigSet`.
- Then regenerate: `cd proto && buf generate` updates `packages/protocol/src/gen`,
  `crates/protocol/src/gen` and `packages/swift-client/Sources/CofluxProtocol/Generated`.
- After: the change is additive only (no renumbering, no removed field); generated code for all three
  languages is in the diff and a second `buf generate` changes nothing.
- Don't: add a value to `enum SpeechProvider` (D3).

### Milestone 2: the centre stores, validates and serves the correction configuration

Depends on: Milestone 1

#### T2 · Migration 13 creates `account_speech_refine`

- Where: `apps/server/src/infra/database/schema-migrations.ts` — after
  `ACCOUNT_SPEECH_PROVIDERS_SCHEMA_SQL`, and the `MIGRATIONS` entry `version: 12`.
- Change: add the schema SQL and a `version: 13` migration named `account_speech_refine` per D7, with
  a doc comment like version 12's (what it stores, that no row means disabled, one-way note).
- After: a fresh database and a version-12 database both migrate to 13; the table is in schema
  `coflux` with the account foreign key `ON DELETE CASCADE`.

#### T3 · The store reads and writes the correction record

- Where: `apps/server/src/store.ts` — the section `/* -------------------- account speech providers -------------------- */`
  (`getSpeechConfig`, `setSpeechProvider`).
- Change: return the account's refine record from `getSpeechConfig` (or a sibling read used wherever
  a status is built — your call), and add an upsert that replaces `enabled`, base URL and model and
  applies a `SpeechKeyAction` to the key, like `setSpeechProvider`.
- After: an account without a row reads as `{ enabled: false, baseUrl: "", model: "", ciphertext: null, updatedAt: 0 }`;
  keep-key writes keep the stored ciphertext.

#### T4 · The hub accepts `speechRefineSet` and `speechRefineCredentialsGet` and reports the record

- Where: `apps/server/src/hub.ts` — the client message switch (`case "speechCredentialsGet":`), the
  `authOk` send (`speechProviders: true`), `function speechStatusPayloads(`, `private async setSpeechConfig(`,
  `private async getSpeechCredentials(`, `function speechBaseUrlError(`, `function speechModelError(`.
- Change:
  - `authOk` sets `speechRefine: true`.
  - Every `SpeechConfigStatus` without an error carries `refine` (D4) — snapshot after subscribe and
    every broadcast.
  - `speechRefineSet`: validate per D6 (reuse `speechBaseUrlError("https:", …)` and `speechKeyError`;
    add the refine model rule; refuse `enabled` with an empty base URL or model; refuse `api_key`
    with `clear_api_key`), encrypt a new key with the same helper as engine keys, write through
    `chainSpeechWrite`, then `broadcastSpeechStatus` with the request id; a rejection goes only to
    the writer as a `speechConfigStatus` error, exactly like `setSpeechConfig`.
  - `speechRefineCredentialsGet`: answer only this connection with the stored base URL, model and
    decrypted key; an undecryptable key is an `error`, never an empty key; a missing key is empty
    `api_key` with empty `error`.
- After: statuses never contain a key (D5); no log call includes the key; without
  `COFLUX_EXECUTOR_KEYS`, a key write is refused while field writes and clearing succeed (D6); old
  `SpeechKey*` and #129 messages behave exactly as before.
- Don't: surface `executor-secrets.ts` error texts verbatim (they mention the executor) — map them the
  way the existing speech handlers do.

### Milestone 3: desktop edits 「识别后整理」

Depends on: Milestone 1

#### T5 · The TS client exposes the correction configuration

- Where: `packages/client/src/store.ts` — `export type SpeechConfig =`, `speechConfigSupported`,
  `speechConfig`, the speech write helpers around `pendingSpeechWrites`, `export function speechConfigInputError(`;
  `packages/client/src/index.ts` exports.
- Change: add `speechRefineSupported` (from `AuthOk.speech_refine`, reset with the same lifecycle as
  `speechConfigSupported`), carry `refine: { enabled, baseUrl, model, keyConfigured, updatedAt }` in
  the stored speech configuration, a `setSpeechRefine({ enabled, baseUrl, model, key: SpeechKeyChange })`
  write that resolves like the existing speech writes, and an input check mirroring D6. No getter for
  the plaintext key (only the phone fetches it).
- After: a `speechConfigStatus` replaces the refine state together with the providers; the desktop
  can tell "older centre" (`speechRefineSupported` false) from "not configured".

#### T6 · The 「语音识别」 settings section shows the 「识别后整理」 group

- Where: `apps/desktop/src/renderer/components/settings/speech-section.tsx` — `export function SpeechSection(`,
  `function ProviderGroup(`.
- Change: add a third group below the two engines, outside the 当前使用 selector, with the structure
  in the product conclusions: switch, Base URL (placeholder `https://api.example.com/v1`), 模型, API Key
  (write-only, 「已保存（留空则不改）」 when one is stored), 保存 and 清除, a status of 「● 已配置」
  (enabled, key, Base URL and model all present), 「○ 未启用」 (switch off) or 「○ 未配置」 (on but
  something missing), and the line 「用大模型按对话和仓库术语纠正识别结果。建议选不带深度思考的快速模型。」.
  The switch writes at once, keeping the stored key; turning it on with an empty Base URL or model
  shows the centre's (or the local check's) error inline and leaves it off. Against a centre without
  `speech_refine` the group shows 「服务器版本过旧」 and is disabled, like the engine groups.
- After: follows `docs/design-guidelines.md` (Tooltip component, no native `title`); offline and
  older-centre states match the engine groups.

### Milestone 4: the Swift client exposes the correction configuration and credentials

Depends on: Milestone 1

#### T7 · `CofluxClient` holds the refine state, writes it and fetches its credentials

- Where: `packages/swift-client/Sources/CofluxClientCore/SpeechConfig.swift` (`public struct SpeechConfig`,
  `public struct SpeechCredentials`, `public func speechConfigInputError(`);
  `packages/swift-client/Sources/CofluxClientCore/CofluxClient.swift` (`speechConfigSupported`,
  `cachedSpeechCredentials`, `public func setSpeechProviderConfig(`, `public func speechCredentials(for`,
  `private func applySpeechConfigStatus(`, `private func resetSpeechState(`).
- Change: add `speechRefineSupported`, a refine state on `SpeechConfig` (enabled, base URL, model,
  key configured, updated at, plus an `isUsable` = enabled ∧ key ∧ non-empty base URL ∧ non-empty
  model), `setSpeechRefine(enabled:baseURL:model:key:) -> SpeechWriteResult`, and
  `speechRefineCredentials() async throws -> SpeechRefineCredentials` with a memory-only cache keyed
  by the refine `updatedAt`, dropped on any refine status change and on logout (D5); an input check
  mirroring D6.
- After: the key is never written to disk or Keychain and never appears in a `description`
  (follow `SpeechCredentials`' redacting `description`); `swift test --package-path packages/swift-client`
  still passes.

### Milestone 5: iOS dictation uses the fuller context and the correction pass

Depends on: Milestone 4

#### T8 · The transcript reads are filtered on the device, and tool inputs and repository terms are collected

- Where: `apps/ios/Coflux/Speech/DictationContext.swift` — `claudeLocatorScript`, `codexLocatorScript`,
  `static let tailBytes`, `static func command(agent:agentSessionID:)`, `collectClaude`, `collectCodex`,
  `struct Entry`, `struct DictationContextSource` / `func load(client:)`.
- Change:
  - The locator scripts drop tool-output lines before printing (D8) and bound their printed body: at
    most 256 KiB for the recognition read, at most 1 MiB for the correction read (read a larger raw
    tail than that so the filtered output can fill it). The header line keeps its
    `coflux-transcript <size> <bytes>` shape that `parseOutput` checks.
  - The parsers additionally collect tool-call inputs per D9 as a third kind of entry (a speaker or
    kind of your choosing), in conversation order.
  - A repository-terms read per D10: a fixed literal `sh -c` script running `git ls-files` in the
    workspace with its output bounded on the device; the phone derives deduplicated basenames,
    stems and directory names.
  - Loading produces two results: the recognition context (unchanged contract: `DictationContext`
    items + `includesConversation`) and a correction context (workspace sentence, term list,
    chronological entries including tool inputs). The recognition context waits only for the small
    read and for repository terms that are already in by its deadline; the correction context
    finishes on its own.
- After: the recognition context is the workspace sentence, then the term sentence of D11, then
  conversation entries newest first — never tool-input entries themselves — within
  `tokenBudget = 1500`; for a plain shell, an unknown agent or any exec failure both contexts degrade
  to what is available (workspace sentence and repository terms), never an error; the agent session
  id is still only a positional argument (seed-asr D5).
- Don't: interpolate the session id or any size into script text (D8); put tool output, file
  contents, `old_string` / `new_string` / `content` or patches into any context (D9).

#### T9 · A correction client turns the recogniser's text into the corrected text, or reports why not

- Where: new file `apps/ios/Coflux/Speech/DictationRefiner.swift` (add it to the Coflux target in
  `apps/ios/Coflux.xcodeproj` the way #129 added `OpenAIRealtimeTranscriber.swift`).
- Change: given refine credentials, the correction context and the raw text, build the request of D12
  and check the answer per D13; return either the corrected text or a not-refined outcome. Use an
  ephemeral `URLSession`; the request's own timeout never exceeds the time left in the D14 budget.
  The system instructions say, in substance: this is dictation addressed to a coding agent; correct
  only misheard terms, mixed Chinese/English spelling and casing using the terms and conversation
  given; keep every other word and the order; never answer, explain, translate, polish or add
  anything; output only the corrected text.
- After: no retries; failures log only the HTTP status or error category (never the key, the context
  or the text, D5); budgets are named constants (~24k estimated tokens total, D12), using the
  existing `estimatedTokens` estimate.
- Don't: send vendor-specific request fields (D12); accept an answer that fails the D13 checks.

#### T10 · The dictation session runs the correction after recognition and exposes both texts

- Where: `apps/ios/Coflux/Speech/DictationSession.swift` — `private func start()`, `func finish() async -> String`,
  `func cancel()`, `@Published private(set) var displayText`.
- Change: at touch-down, when `client.speechConfig`'s refine state is usable (T7), start fetching the
  refine credentials and the correction context alongside the existing key and context tasks; both
  are cancelled by `cancel()`. After the recogniser's final text, when refinement is usable and the
  text is non-empty, run T9 within the D14 bound and publish a refining flag while it runs. The
  session's result exposes the raw text, the corrected text (when accepted) and the outcome
  (refined / not refined / refinement off).
- After: with refinement off or not usable, `finish()` behaves exactly as today (same timing, same
  text); with it on, the total wait after the recogniser's final text never exceeds the D14 bound;
  the microphone is still released at the same point as today (on release, before any network wait).

#### T11 · The overlay and the release paths show and use the corrected text

- Where: `apps/ios/Coflux/Speech/DictationOverlay.swift` — `Text(confirming ? "识别结果 · 点按文字可编辑" : "正在聆听")`,
  the line returning `"正在识别…"`; `apps/ios/Coflux/Views/WorkspaceDetailView.swift` —
  `private func endDictation()`, `private func sendDictation()`, `private func editDictation()`.
- Change:
  - While the correction runs the status line reads 「正在整理…」 (the overlay stays non-interactive
    as it is during finalizing).
  - Confirm-state header: refinement off → unchanged; refined → 「识别结果 · 已整理」, plus a
    「看原文」 toggle only when the texts differ (D15) — showing the raw text with header
    「识别结果 · 原文」 and the toggle 「看整理后」; not refined (timeout or failure) → 「识别结果 · 未整理」.
  - Slide onto 发送 sends the corrected text when accepted, else the raw text; 发送 and 编辑 in the
    confirm state use the version on screen.
- After: Duo layouts (outer display, inner wide and tall, Split View) keep fitting — the header and
  toggle are one line within the overlay's existing width rules; the cancel path and the empty-text
  path are unchanged.

#### T12 · The iOS 「语音识别」 sheet edits 「识别后整理」

- Where: `apps/ios/Coflux/Views/SpeechSettingsSheet.swift`.
- Change: add the 「识别后整理」 group with the same fields, copy, status values and switch behaviour
  as T6, using T7's API.
- After: it follows the sheet's existing structure and dark theme colours from
  `apps/ios/Coflux/Views/Theme.swift`; older centre → 「服务器版本过旧」 and disabled.

### Your call

- Internal structure and names: the store/hub function split, the Swift types for the correction
  context and the session result, the entry kind for tool inputs.
- Exact field allow-lists for tool inputs within D9, and the term-derivation rules within D10/D11
  (minimum length, what counts as an identifier, dropping plain Chinese words).
- The exact wording of the system instructions within T9's substance, and its language.
- Exact constants within the stated bounds (raw tail sizes, `max_tokens`, how the 3 s is split
  between waiting for context and the request).
- Whether the desktop/iOS switch shares a component with the engine groups.

### Landmines

- `AudioCapture` must be stopped on every path, including a refine path that is cancelled or times
  out (the session already stops it in `finish()` / `cancel()`; do not move that later).
- Two transcript parsers exist (iOS `DictationContext.swift`, desktop
  `apps/desktop/src/renderer/components/workbench/terminal-transcript.ts`); this plan changes only the
  iOS one. The desktop copy view must not change.
- `apps/ios/Coflux/Views/WorkspaceDetailView.swift` is also touched by the parallel branch
  `dev/20261109-ios-duo-inner-display` (6 lines); keep edits there confined to the three dictation
  functions named in T11.
- The old `SpeechKey*` messages and #129's messages must keep working unchanged for older clients.

### Scope

In scope:
- `proto/coflux/v1/client.proto` and its generated outputs (`packages/protocol/src/gen`,
  `crates/protocol/src/gen`, `packages/swift-client/Sources/CofluxProtocol/Generated`)
- `apps/server/src/infra/database/schema-migrations.ts`, `apps/server/src/store.ts`, `apps/server/src/hub.ts`
- `packages/client/src/store.ts`, `packages/client/src/index.ts`
- `apps/desktop/src/renderer/components/settings/speech-section.tsx`
- `packages/swift-client/Sources/CofluxClientCore/SpeechConfig.swift`, `packages/swift-client/Sources/CofluxClientCore/CofluxClient.swift`
- `apps/ios/Coflux/Speech/DictationContext.swift`, `DictationSession.swift`, `DictationOverlay.swift`, new `DictationRefiner.swift`
- `apps/ios/Coflux/Views/WorkspaceDetailView.swift` (the three dictation functions only), `apps/ios/Coflux/Views/SpeechSettingsSheet.swift`
- `apps/ios/Coflux.xcodeproj/project.pbxproj` (registering the new file)
- `apps/ios/CofluxTests/*` only if a signature change breaks compilation

Out of scope:
- `SeedASRProvider.swift`, `OpenAIRealtimeTranscriber.swift` — the engines already take context items;
  their protocol handling does not change.
- The desktop transcript module `terminal-transcript.ts` and any desktop dictation.
- `crates/runtime` — no daemon change; the reads use the existing exec path.
- `enum SpeechProvider`, `SpeechActiveSet`, the 当前使用 selector (D3).

### Stop and report if

- A task's anchor is missing, or the code there differs from what the task describes.
- A task needs a file outside the in-scope list.
- Two tasks contradict each other, or a task contradicts the code it changes.
- A D4 field number is already taken on this branch.
- The device-side filter cannot be written as a fixed literal script using only POSIX `sh`, `tail`,
  `grep` and `head`.

## Verification

### Milestone validations

- Milestone 1: `cd proto && buf lint && buf generate`, then a second `buf generate` adds no diff;
  `cd proto && node ../scripts/check-protocol-breaking.mjs "../.git#ref=23ca7cc4,subdir=proto"` → no
  breaking change.
- Milestone 2: `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` → exit 0.
- Milestone 3: `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test && pnpm -C apps/desktop build && pnpm -C apps/desktop lint`
  → exit 0, lint clean.
- Milestone 4: `swift test --package-path packages/swift-client` → exit 0.
- Milestone 5: iOS device compile and test compile (Commands) → succeeded.

### Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Protocol lint + generate | `cd proto && buf lint && buf generate` | clean, no diff after commit |
| Protocol breaking | `cd proto && node ../scripts/check-protocol-breaking.mjs "../.git#ref=23ca7cc4,subdir=proto"` | no breaking change |
| Rust build | `cargo build` | zero warnings |
| Rust protocol tests | `cargo test -p coflux-protocol` | exit 0 |
| Server typecheck | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| Desktop | `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test && pnpm -C apps/desktop build && pnpm -C apps/desktop lint` | exit 0, lint clean |
| Swift client | `swift test --package-path packages/swift-client` | exit 0 |
| iOS device compile | `xcodebuild build -project apps/ios/Coflux.xcodeproj -scheme Coflux -destination 'generic/platform=iOS' -skipPackagePluginValidation -allowProvisioningUpdates` | `** BUILD SUCCEEDED **` (needs `apps/ios/Frameworks/CofluxTailcat.xcframework`, gitignored — copy it from the main worktree, and the Metal Toolchain) |
| iOS test compile | `xcodebuild build-for-testing -project apps/ios/Coflux.xcodeproj -scheme Coflux -destination 'generic/platform=iOS' -skipPackagePluginValidation -allowProvisioningUpdates CODE_SIGNING_ALLOWED=NO` | `** TEST BUILD SUCCEEDED **` |
| Black-box (wire touched) | `pnpm -C tests test` (clear inherited `COFLUX_*` variables, unset `FORCE_COLOR`; local Postgres on 5432) | all pass |
| Keys stay out of broadcasts and logs | `rg -n 'apiKey|api_key|ciphertext' apps/server/src/hub.ts` and read each hit; `rg -n 'Logger|log\.' apps/ios/Coflux/Speech/DictationRefiner.swift` | plaintext only in credential answers; no log call carries a key, context or dictated text |
| Locator scripts on real transcripts (acceptance) | run each new locator script with `sh -c '<script>' sh <id>` against a real Claude session id and a real Codex session id on this Mac, and the repository-terms script in this worktree | header line intact; no `"tool_result"` / `function_call_output` lines in the body; body within its bound; the parsed recognition context reaches close to 1500 estimated tokens for a tool-heavy Claude session |
| Centre round trip (acceptance) | throwaway script against a centre from `pnpm dev:server` on a database at version 12: migrate to 13, then drive `speechRefineSet` / `speechRefineCredentialsGet` and the #129 messages over the WS with two clients | see Done criteria |
| Correction against a live provider (acceptance) | if the user provides a key through `coflux secret`: compile `DictationRefiner.swift` into a macOS harness (as #129 did for `SeedASRProvider`), send a raw text such as 「帮我瑞贝斯到妹恩，再跑一下 dictation context 的测试」 with this repository's context | corrected terms within the 3 s bound; a bogus key → not refined; otherwise record as unverified |
| Device walkthrough (acceptance) | the user on iPhone Duo after the centre is deployed | see Done criteria |

### Done criteria

- [ ] All listed non-acceptance commands pass.
- [ ] Every task's `After` state holds.
- [ ] Migration 13 applies on a version-12 database; an account without a row reads as disabled and
      unconfigured (acceptance script).
- [ ] The centre refuses `enabled` with an empty base URL or model, an `http:` base URL, a URL with a
      query, a model with a space, and `api_key` with `clear_api_key` — each with an error to the
      writer only, changing nothing; accepted writes reach a second client as `speechConfigStatus`
      with `refine` and no key; `speechRefineCredentials` reaches only the requester (acceptance
      script).
- [ ] With `COFLUX_EXECUTOR_KEYS` unset, a refine key write is refused while field writes and clearing
      succeed.
- [ ] The #129 engine messages and the old `SpeechKey*` messages behave as before (acceptance script).
- [ ] Locator scripts keep the session id positional and never interpolate it or a size (read the
      diff).
- [ ] No tool output, file contents or edit strings reach either context (read the parser diff).
- [ ] The correction request has no vendor-specific fields, orders the prompt as D12 says, and the
      answer passes the D13 checks before use (read the diff).
- [ ] With refinement off, the dictation code path is unchanged in timing and text (read the diff).
- [ ] (acceptance, user) On the Duo with 识别后整理 on: 正在整理… after release; confirm state
      「已整理」 with 「看原文」 when the texts differ; slide-to-send sends the corrected text; a wrong
      key or a slow model → 「未整理」 with the raw text, never a hang; switching off restores today's
      behaviour; a configuration saved on the desktop works on the iPhone; terms such as rebase,
      worktree, Tailcat and repository file names come out right.
- [ ] No out-of-scope files changed.
- [ ] The Outcome is appended and `wiki/plans/README.md` status is updated.

### Merge and deploy

- This branch is stacked on PR #129 (`dev/20261109-speech-providers`) and its pull request targets
  that branch; merge #129 first, then retarget or merge this one.
- Deploy order: centre first (migrations 12 and 13 and the new messages), then the desktop release,
  then the iOS build through TestFlight (`apps/ios/release.sh`, manual). New clients against a centre
  without `speech_refine` show 「服务器版本过旧」 in the 「识别后整理」 group and dictate without
  correction; older clients ignore the new status field.
- Migration 13 is additive but, like every migration here, an older centre refuses the migrated
  database: take the usual pre-deploy backup on the centre host (coflux-bj).
- The centre needs `COFLUX_EXECUTOR_KEYS` (configured in production) to store the refine key.
- Correction calls are billed to whatever provider key the user stores; nothing in the centre calls
  the provider.
