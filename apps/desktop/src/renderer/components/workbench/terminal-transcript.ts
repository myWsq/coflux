/**
 * Agent transcript → a copyable conversation (plan 20260919).
 *
 * Why this exists at all: Claude Code and Codex render through Ink, which wraps prose to the
 * terminal width *itself* and emits a real newline plus an indent prefix on every visual line.
 * xterm's selection handles soft wrapping correctly, so every newline that survives a copy is one
 * the application really emitted — there is no terminal-side fix. The only source of unwrapped
 * prose is the agent's own transcript file, which is what this module reads.
 *
 * Two deliberate boundaries:
 *
 * - **The daemon returns bytes and nothing else.** These are private formats belonging to other
 *   vendors and they change without notice; teaching the daemon about them would weld a volatile
 *   format into our protocol and force a daemon release whenever a vendor shifts a field. Here, a
 *   format change is one patch in one place. Resist any later proposal to move this into the
 *   daemon or the protocol.
 * - **The agent session id is never interpolated into command text.** The script below is a fixed
 *   literal that references `"$1"`, and the id travels as its own argv entry
 *   (`sh -c '<fixed script>' sh <id>`). [[isUsableAgentSessionId]] is the *second* line of
 *   defence, not the first: a future call site that forgets to validate must still be safe.
 */

/** Upper bound for the agent session id; mirrors the worker and server checks. */
const MAX_AGENT_SESSION_ID_LENGTH = 128;

/**
 * Bounded tail read (plan 20260919). Transcripts grow without bound — one measured 978KB — and
 * nothing downstream truncates: the daemon converts all of stdout and the server's frame ceiling
 * is a hard 30MB wall. Reading a tail turns a cliff that only the heaviest users hit into a
 * gradual, *stated* loss: a measured 400KB tail still yielded dozens of messages.
 */
export const TRANSCRIPT_TAIL_BYTES = 512 * 1024;

/** The one line our locator scripts print before the tail, so the head loss is not guesswork. */
export const HEADER_PREFIX = "coflux-transcript";

/** Exit codes shared by both locator scripts. 0 = found, everything else is a distinct state. */
export const EXIT_NOT_FOUND = 3;
export const EXIT_READ_FAILED = 4;

/**
 * Claude's transcript is `<config>/projects/<slug>/<session-id>.jsonl`. The glob stays
 * single-level on purpose: the project directory also contains a same-named *directory*
 * `<session-id>/subagents/`, which a recursive `find -name` would happily descend into.
 *
 * The same id can exist under two project directories (the same session resumed from another
 * cwd). We pick the newest rather than letting `tail` print `==> file <==` banners we would then
 * have to tell apart from JSON.
 */
const CLAUDE_LOCATOR_SCRIPT = `set -u
id="$1"
dir=\${CLAUDE_CONFIG_DIR:-}
if [ -z "$dir" ]; then
  if [ -z "\${HOME:-}" ]; then echo "HOME is not set" >&2; exit ${EXIT_READ_FAILED}; fi
  dir=$HOME/.claude
fi
newest=
for f in "$dir"/projects/*/"$id".jsonl; do
  [ -f "$f" ] || continue
  if [ -z "$newest" ] || [ "$f" -nt "$newest" ]; then newest=$f; fi
done
if [ -z "$newest" ]; then exit ${EXIT_NOT_FOUND}; fi
size=$(wc -c < "$newest") || exit ${EXIT_READ_FAILED}
printf '${HEADER_PREFIX} %s ${TRANSCRIPT_TAIL_BYTES}\\n' "$size"
tail -c ${TRANSCRIPT_TAIL_BYTES} "$newest" || exit ${EXIT_READ_FAILED}
`;

/**
 * Codex rollouts are date-partitioned (`sessions/<y>/<m>/<d>/rollout-<stamp>-<thread-id>.jsonl`),
 * so finding one by thread id means walking three glob levels, not one directory.
 */
const CODEX_LOCATOR_SCRIPT = `set -u
id="$1"
dir=\${CODEX_HOME:-}
if [ -z "$dir" ]; then
  if [ -z "\${HOME:-}" ]; then echo "HOME is not set" >&2; exit ${EXIT_READ_FAILED}; fi
  dir=$HOME/.codex
fi
newest=
for f in "$dir"/sessions/*/*/*/rollout-*-"$id".jsonl; do
  [ -f "$f" ] || continue
  if [ -z "$newest" ] || [ "$f" -nt "$newest" ]; then newest=$f; fi
done
if [ -z "$newest" ]; then exit ${EXIT_NOT_FOUND}; fi
size=$(wc -c < "$newest") || exit ${EXIT_READ_FAILED}
printf '${HEADER_PREFIX} %s ${TRANSCRIPT_TAIL_BYTES}\\n' "$size"
tail -c ${TRANSCRIPT_TAIL_BYTES} "$newest" || exit ${EXIT_READ_FAILED}
`;

/** Agents whose transcript we know how to find and read. */
export type TranscriptAgent = "claude" | "codex";

export function transcriptAgentOf(agent: string): TranscriptAgent | null {
  const name = agent.trim().toLowerCase();
  return name === "claude" || name === "codex" ? name : null;
}

/**
 * Conservative shape check, applied again here even though the worker and the server already
 * checked: the id crosses three processes before it reaches us, and this is a defence in depth,
 * not the primary one (that one is positional — see the module header).
 */
export function isUsableAgentSessionId(value: string | undefined | null): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_AGENT_SESSION_ID_LENGTH &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)
  );
}

/**
 * The exact argv for locating and tailing a transcript. The script is a fixed literal; the id is
 * a separate argv entry, which is what makes it uninterpretable as script text. `$0` is the
 * conventional `sh` placeholder so that `$1` is the id.
 */
export function transcriptCommand(agent: TranscriptAgent, agentSessionId: string): { command: string; args: string[] } {
  const script = agent === "claude" ? CLAUDE_LOCATOR_SCRIPT : CODEX_LOCATOR_SCRIPT;
  return { command: "sh", args: ["-c", script, "sh", agentSessionId] };
}

export type TranscriptEntry =
  /** Something the person typed. */
  | { kind: "prompt"; text: string }
  /** Prose the agent wrote — the whole point of the page. */
  | { kind: "prose"; text: string }
  /** A tool call, kept only as a landmark while scrolling; never expanded. */
  | { kind: "tool"; label: string };

export type TranscriptDocument = {
  entries: TranscriptEntry[];
  /** True when the file was longer than the tail window, i.e. the page starts mid-conversation. */
  truncated: boolean;
};

export type TranscriptResult =
  | { status: "ok"; document: TranscriptDocument }
  /** No transcript file for this id. Distinct from a failure: the daemon runs as a launchd
   *  service whose environment differs from an interactive shell, so a miss is not
   *  self-explanatory and must not be dressed up as one. */
  | { status: "not-found" }
  | { status: "failed"; detail: string };

/** The subset of `CofluxClient.execInWorkspace` this module needs. */
export type TranscriptExec = (
  workspaceId: string,
  command: string,
  args: string[],
) => Promise<{ ok: boolean; exitCode: number; stdout: string; stderr: string; error: string }>;

/**
 * One snapshot: locate the transcript on whichever device owns the workspace, read a bounded
 * tail, parse it. `execInWorkspace` already routes local and remote identically, so there is no
 * branch here and no `daemonId` anywhere in sight.
 */
export async function loadTranscript(
  exec: TranscriptExec,
  input: { agent: string; agentSessionId: string; workspaceId: string },
): Promise<TranscriptResult> {
  const agent = transcriptAgentOf(input.agent);
  if (!agent) return { status: "failed", detail: `不认识的 agent：${input.agent}` };
  if (!isUsableAgentSessionId(input.agentSessionId)) return { status: "failed", detail: "会话标识不可用" };
  const { command, args } = transcriptCommand(agent, input.agentSessionId);
  let result: Awaited<ReturnType<TranscriptExec>>;
  try {
    result = await exec(input.workspaceId, command, args);
  } catch (error) {
    return { status: "failed", detail: error instanceof Error ? error.message : String(error) };
  }
  if (result.exitCode === EXIT_NOT_FOUND) return { status: "not-found" };
  if (!result.ok || result.exitCode !== 0) {
    const detail = result.error || result.stderr.trim() || `退出码 ${result.exitCode}`;
    return { status: "failed", detail };
  }
  return parseTranscriptOutput(agent, result.stdout);
}

/** Split the locator's stdout into its header and the raw tail, then parse. */
export function parseTranscriptOutput(agent: TranscriptAgent, stdout: string): TranscriptResult {
  const newline = stdout.indexOf("\n");
  const header = (newline === -1 ? stdout : stdout.slice(0, newline)).trim();
  const fields = header.split(/\s+/);
  if (fields[0] !== HEADER_PREFIX || fields.length < 3) {
    return { status: "failed", detail: "读到的不是 transcript（缺少头部标记）" };
  }
  const size = Number(fields[1]);
  const windowBytes = Number(fields[2]);
  const truncated = Number.isFinite(size) && Number.isFinite(windowBytes) && size > windowBytes;
  const body = newline === -1 ? "" : stdout.slice(newline + 1);
  return { status: "ok", document: { entries: parseTranscript(agent, body), truncated } };
}

/**
 * Pure function over the transcript text. Every record type is allow-listed: a real Claude file
 * also carries `last-prompt`, `ai-title`, `mode`, `permission-mode`, `atis-latch`, `attachment`,
 * `system`, `cost-state`, `continued-in`, `queue-operation` and `file-history-snapshot`, and a
 * Codex rollout carries a dozen more. Anything unrecognised is dropped rather than guessed at.
 *
 * A tail read starts mid-line, so the first line is usually a truncated JSON fragment. It needs
 * no special case: an unparsable line is skipped like any other.
 */
export function parseTranscript(agent: TranscriptAgent, text: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let record: unknown;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isRecord(record)) continue;
    if (agent === "claude") collectClaude(record, entries);
    else collectCodex(record, entries);
  }
  return entries;
}

/* ------------------------------------------------------------------ *
 * Claude Code
 * ------------------------------------------------------------------ */

function collectClaude(record: Record<string, unknown>, entries: TranscriptEntry[]): void {
  // Subagent conversations live in the same file and would interleave a different conversation
  // into the page.
  if (record.isSidechain === true) return;
  // Synthetic bookkeeping the person never typed.
  if (record.isMeta === true) return;
  const type = record.type;
  if (type !== "user" && type !== "assistant") return;
  const message = isRecord(record.message) ? record.message : null;
  if (!message) return;
  const content = message.content;

  if (type === "user") {
    // In sampled tails, 19 of 21 / 85 of 93 `user` records were `tool_result` payloads. The
    // person's own prompts are the minority; treat `user` as "candidate", never as "prompt".
    if (typeof content === "string") {
      pushPrompt(entries, content);
      return;
    }
    if (!Array.isArray(content)) return;
    if (content.some((block) => isRecord(block) && block.type === "tool_result")) return;
    for (const block of content) {
      if (!isRecord(block) || block.type !== "text") continue;
      pushPrompt(entries, typeof block.text === "string" ? block.text : "");
    }
    return;
  }

  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (!isRecord(block)) continue;
    // `thinking` is deliberately dropped: it is the agent's scratchpad, not the prose a person
    // copies out of the conversation.
    if (block.type === "text" && typeof block.text === "string") pushProse(entries, block.text);
    else if (block.type === "tool_use") entries.push({ kind: "tool", label: toolLabel(block.name, block.input) });
  }
}

/* ------------------------------------------------------------------ *
 * Codex
 * ------------------------------------------------------------------ */

function collectCodex(record: Record<string, unknown>, entries: TranscriptEntry[]): void {
  // There is no `user_message` in `event_msg`; prompts live only in response items. Everything
  // else on the stream (`token_count`, `item_completed`, `world_state`, `turn_context`,
  // `compacted`, `token_usage_record`, `session_meta`, …) is bookkeeping.
  if (record.type !== "response_item") return;
  const payload = isRecord(record.payload) ? record.payload : null;
  if (!payload) return;

  if (payload.type === "custom_tool_call" || payload.type === "function_call") {
    entries.push({ kind: "tool", label: toolLabel(payload.name, payload.arguments ?? payload.input) });
    return;
  }
  // `agent_message` is inter-agent traffic between a Codex thread and its subagents; its body is
  // mostly encrypted anyway. `reasoning` is the scratchpad.
  if (payload.type !== "message") return;
  const role = payload.role;
  if (role !== "user" && role !== "assistant") return;
  const content = payload.content;
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (!isRecord(block)) continue;
    const text = typeof block.text === "string" ? block.text : "";
    if (text.length === 0) continue;
    if (role === "user") {
      if (block.type !== "input_text" && block.type !== "text") continue;
      pushPrompt(entries, text);
    } else {
      if (block.type !== "output_text" && block.type !== "text") continue;
      pushProse(entries, text);
    }
  }
}

/* ------------------------------------------------------------------ *
 * Shared filters
 * ------------------------------------------------------------------ */

/**
 * Whole-text wrappers that are machine injection, not a person typing. Matched against the start
 * of the message only — a prompt that merely *mentions* one of these keeps its text.
 */
const INJECTED_PREFIXES = [
  // Claude slash-command bookkeeping and hook output
  "<command-name>",
  "<command-message>",
  "<command-args>",
  "<local-command-stdout>",
  "<local-command-stderr>",
  "<user-prompt-submit-hook>",
  "<system-reminder>",
  // Codex: the AGENTS.md preamble, which starts with a heading rather than a tag
  "# AGENTS.md instructions for ",
  "<INSTRUCTIONS>",
];

/**
 * Codex injects several blocks whose first line is a lone opening tag on its own —
 * `<recommended_plugins>`, `<user_instructions>`, `<environment_context>`, `<app-context>`,
 * `<skill>`. Shape, not an ever-growing name list: a person's prompt does not open with a bare
 * XML tag alone on line one.
 */
const LONE_OPENING_TAG = /^<[A-Za-z][A-Za-z0-9_-]*>$/;

/** Claude writes these into the stream as `user` text; they are markers, not prose. */
const SYSTEM_MARKER = /^\[Request interrupted by user/;

function isInjected(text: string): boolean {
  const trimmed = text.trimStart();
  if (INJECTED_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) return true;
  if (SYSTEM_MARKER.test(trimmed)) return true;
  const firstLine = trimmed.split("\n", 1)[0]?.trim() ?? "";
  return LONE_OPENING_TAG.test(firstLine);
}

function pushPrompt(entries: TranscriptEntry[], text: string): void {
  const value = text.trim();
  if (value.length === 0 || isInjected(value)) return;
  entries.push({ kind: "prompt", text: value });
}

function pushProse(entries: TranscriptEntry[], text: string): void {
  const value = text.trim();
  if (value.length === 0) return;
  entries.push({ kind: "prose", text: value });
}

/** How much of a tool call's argument survives into the landmark line. */
const TOOL_SUMMARY_LIMIT = 72;

/**
 * Fields worth showing first, in the order a reader would recognise the call by. Anything else
 * falls back to the first string-valued property, so an unknown tool still gets a usable label.
 */
const TOOL_SUMMARY_KEYS = [
  "command",
  "cmd",
  "file_path",
  "path",
  "notebook_path",
  "pattern",
  "query",
  "url",
  "subagent_type",
  "description",
  "prompt",
];

function toolLabel(name: unknown, input: unknown): string {
  const toolName = typeof name === "string" && name.length > 0 ? name : "tool";
  const summary = toolSummary(input);
  return summary.length === 0 ? toolName : `${toolName}(${summary})`;
}

function toolSummary(input: unknown): string {
  if (typeof input === "string") {
    // Codex passes either a JS snippet (`custom_tool_call.input`) or a JSON string
    // (`function_call.arguments`); try the structured reading first, then fall back to the text.
    const parsed = tryParseJson(input);
    if (isRecord(parsed)) return summaryFromObject(parsed);
    return shorten(input);
  }
  if (isRecord(input)) return summaryFromObject(input);
  return "";
}

function summaryFromObject(input: Record<string, unknown>): string {
  for (const key of TOOL_SUMMARY_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.trim().length > 0) return shorten(value);
  }
  for (const value of Object.values(input)) {
    if (typeof value === "string" && value.trim().length > 0) return shorten(value);
  }
  return "";
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function shorten(value: string): string {
  const oneLine = value.trim().split("\n", 1)[0]?.trim() ?? "";
  return oneLine.length > TOOL_SUMMARY_LIMIT ? `${oneLine.slice(0, TOOL_SUMMARY_LIMIT - 1)}…` : oneLine;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
