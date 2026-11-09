import type { DesktopDictationContext, DesktopDictationEntry, DesktopDictationRefineContext } from "../../../shared/desktop-bridge";
import type { TranscriptAgent, TranscriptExec } from "./terminal-transcript";
import { isUsableAgentSessionId } from "./terminal-transcript";

/**
 * Dictation context (plan 20261110-desktop-dictation), ported from the iOS `DictationContext.swift`
 * (apps/ios/Coflux/Speech/DictationContext.swift): a sentence naming the project, workspace and
 * branch, a sentence listing related terms, then the current agent's conversation newest first,
 * within about 1500 estimated tokens — the recognisers use it to spell project words and names
 * right. The correction context carries the conversation chronologically, tool-call inputs
 * included, and the repository terms.
 *
 * The reads run on the device through the pane's `execInWorkspace`, like the copyable conversation
 * (terminal-transcript.ts), and never fail: every miss degrades to what is available.
 *
 * The agent session id and the sizes are never interpolated into command text: the scripts are
 * fixed literals referencing `"$1"` to `"$3"`, the values travel as their own argv entries, and the
 * scripts refuse sizes that are not plain digits.
 */

export type DictationEntry = DesktopDictationEntry;

/** One parsed read: entries in conversation order and the terms they name, newest first. */
export type DictationReading = { entries: DictationEntry[]; terms: string[] };

/** The two transcript reads. The raw tail is larger than the printed limit so the filtered output
 * can fill it; the device prints at most `limitBytes` of filtered body. */
export type DictationRead = "recognition" | "correction";

export const DICTATION_READ_SIZES: Readonly<Record<DictationRead, { rawTailBytes: number; limitBytes: number }>> = {
  /** For the recognition context: bounded by the 1.2 s context deadline. */
  recognition: { rawTailBytes: 2 * 1024 * 1024, limitBytes: 256 * 1024 },
  /** For the correction pass: only has to be ready when the recogniser finishes. */
  correction: { rawTailBytes: 8 * 1024 * 1024, limitBytes: 1024 * 1024 },
};

const HEADER_PREFIX = "coflux-transcript";
/** Token budget for all recognition items together. */
export const DICTATION_TOKEN_BUDGET = 1500;
/** Share of the budget the term sentence may take. */
export const DICTATION_TERM_BUDGET = 200;
/** A truncated entry shorter than this is not worth sending. */
const MINIMUM_TRUNCATED_TOKENS = 24;
/** Cap for one tool-input value, in characters. */
const MAX_TOOL_VALUE_CHARACTERS = 300;

/** Exit codes shared by both scripts: 3 = not found, 4 = read failed or bad arguments. `$2` is the
 * raw tail size, `$3` the printed limit; both must be plain digits. Lines carrying tool results are
 * dropped before the limit is applied, so the printed body is conversation. */
const CLAUDE_LOCATOR_SCRIPT = `set -u
id="$1"
raw="$2"
limit="$3"
case "$raw" in ''|*[!0-9]*) echo "bad size" >&2; exit 4;; esac
case "$limit" in ''|*[!0-9]*) echo "bad size" >&2; exit 4;; esac
dir=\${CLAUDE_CONFIG_DIR:-}
if [ -z "$dir" ]; then
  if [ -z "\${HOME:-}" ]; then echo "HOME is not set" >&2; exit 4; fi
  dir=$HOME/.claude
fi
newest=
for f in "$dir"/projects/*/"$id".jsonl; do
  [ -f "$f" ] || continue
  if [ -z "$newest" ] || [ "$f" -nt "$newest" ]; then newest=$f; fi
done
if [ -z "$newest" ]; then exit 3; fi
size=$(wc -c < "$newest") || exit 4
printf 'coflux-transcript %s %s\\n' "$size" "$limit"
tail -c "$raw" "$newest" | grep -v -F '"type":"tool_result"' | tail -c "$limit" || exit 4
`;

const CODEX_LOCATOR_SCRIPT = `set -u
id="$1"
raw="$2"
limit="$3"
case "$raw" in ''|*[!0-9]*) echo "bad size" >&2; exit 4;; esac
case "$limit" in ''|*[!0-9]*) echo "bad size" >&2; exit 4;; esac
dir=\${CODEX_HOME:-}
if [ -z "$dir" ]; then
  if [ -z "\${HOME:-}" ]; then echo "HOME is not set" >&2; exit 4; fi
  dir=$HOME/.codex
fi
newest=
for f in "$dir"/sessions/*/*/*/rollout-*-"$id".jsonl; do
  [ -f "$f" ] || continue
  if [ -z "$newest" ] || [ "$f" -nt "$newest" ]; then newest=$f; fi
done
if [ -z "$newest" ]; then exit 3; fi
size=$(wc -c < "$newest") || exit 4
printf 'coflux-transcript %s %s\\n' "$size" "$limit"
tail -c "$raw" "$newest" | grep -v -F -e '"type":"function_call_output"' -e '"type":"custom_tool_call_output"' -e '"type":"event_msg"' | tail -c "$limit" || exit 4
`;

/** Bounded repository listing: a fixed literal script, output capped on the device. Not a
 * repository or no git prints nothing, which yields no terms. */
const REPOSITORY_SCRIPT = `set -u
git -c core.quotePath=false ls-files 2>/dev/null | head -c 262144
`;

/** The exact invocation: `sh -c '<fixed script>' sh <id> <raw tail bytes> <limit bytes>`. */
export function dictationTranscriptCommand(agent: TranscriptAgent, agentSessionId: string, read: DictationRead): { command: string; args: string[] } {
  const script = agent === "claude" ? CLAUDE_LOCATOR_SCRIPT : CODEX_LOCATOR_SCRIPT;
  const sizes = DICTATION_READ_SIZES[read];
  return { command: "sh", args: ["-c", script, "sh", agentSessionId, String(sizes.rawTailBytes), String(sizes.limitBytes)] };
}

export const DICTATION_REPOSITORY_COMMAND: { command: string; args: string[] } = { command: "sh", args: ["-c", REPOSITORY_SCRIPT, "sh"] };

// ---------------------------------------------------------------------------- text measures

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** The text as user-perceived characters (Swift `Character`s). */
function characters(text: string): string[] {
  return Array.from(graphemeSegmenter.segment(text), (segment) => segment.segment);
}

function isCJK(codePoint: number): boolean {
  return (
    (codePoint >= 0x3000 && codePoint <= 0x303f) ||
    (codePoint >= 0x3040 && codePoint <= 0x30ff) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7af) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xff00 && codePoint <= 0xffef) ||
    (codePoint >= 0x20000 && codePoint <= 0x2ffff)
  );
}

/** CJK characters ≈ 1 token each; other text ≈ 4 characters per token (Unicode scalars). Mirrors
 * the main process's dictation-text.ts. */
export function estimatedTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    if (isCJK(char.codePointAt(0)!)) cjk += 1;
    else other += 1;
  }
  return cjk + Math.floor((other + 3) / 4);
}

/** The longest end of `text` within `budget` estimated tokens, trimmed. */
export function suffixWithin(text: string, budget: number): string {
  if (budget <= 0) return "";
  const chars = characters(text);
  let cjk = 0;
  let other = 0;
  let start = chars.length;
  while (start > 0) {
    for (const scalar of chars[start - 1]!) {
      if (isCJK(scalar.codePointAt(0)!)) cjk += 1;
      else other += 1;
    }
    if (cjk + Math.floor((other + 3) / 4) > budget) break;
    start -= 1;
  }
  return chars.slice(start).join("").trim();
}

// ---------------------------------------------------------------------------- transcript parsing

/** Split the script's stdout into header and tail, then parse. Null when the header is missing. */
export function parseDictationOutput(agent: TranscriptAgent, stdout: string): DictationEntry[] | null {
  const newline = stdout.indexOf("\n");
  const header = newline === -1 ? stdout : stdout.slice(0, newline);
  const body = newline === -1 ? "" : stdout.slice(newline + 1);
  const fields = header.split(/\s+/).filter(Boolean);
  if (fields[0] !== HEADER_PREFIX || fields.length < 3) return null;
  return parseDictationTranscript(agent, body);
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Every record type is allow-listed; a tail read starts mid-line, so an unparsable line is skipped
 * like any other. */
export function parseDictationTranscript(agent: TranscriptAgent, text: string): DictationEntry[] {
  const entries: DictationEntry[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.replace(/^[ \t]+|[ \t]+$/g, "");
    if (!trimmed) continue;
    let record: unknown;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isObject(record)) continue;
    if (agent === "claude") collectClaude(record, entries);
    else collectCodex(record, entries);
  }
  return entries;
}

/** Claude `tool_use` input fields that name things. Never `content`, `old_string`, `new_string`,
 * edits or any other body. */
const CLAUDE_TOOL_FIELDS = ["file_path", "notebook_path", "path", "pattern", "glob", "query", "url", "command"];

function objectArray(value: unknown): JsonObject[] | null {
  return Array.isArray(value) && value.every(isObject) ? (value as JsonObject[]) : null;
}

function collectClaude(record: JsonObject, entries: DictationEntry[]): void {
  // Subagent conversations and synthetic bookkeeping are not this conversation.
  if (record.isSidechain === true) return;
  if (record.isMeta === true) return;
  const type = record.type;
  if ((type !== "user" && type !== "assistant") || !isObject(record.message)) return;
  const content = record.message.content;

  if (type === "user") {
    // Most `user` records carry tool results; the person's prompts are the minority.
    if (typeof content === "string") {
      pushPrompt(content, entries);
      return;
    }
    const blocks = objectArray(content);
    if (!blocks) return;
    if (blocks.some((block) => block.type === "tool_result")) return;
    for (const block of blocks) {
      if (block.type === "text") pushPrompt(typeof block.text === "string" ? block.text : "", entries);
    }
    return;
  }

  const blocks = objectArray(content);
  if (!blocks) return;
  for (const block of blocks) {
    switch (block.type) {
      case "text":
        pushProse(typeof block.text === "string" ? block.text : "", entries);
        break;
      // Kept here, unlike the desktop's copy view: the reasoning names the things the person is
      // about to talk about.
      case "thinking":
        pushProse(typeof block.thinking === "string" ? block.thinking : "", entries);
        break;
      case "tool_use": {
        const input = block.input;
        if (!isObject(input)) break;
        const values = CLAUDE_TOOL_FIELDS.map((field) => input[field]).filter((value): value is string => typeof value === "string");
        pushTool(typeof block.name === "string" ? block.name : null, values, entries);
        break;
      }
      default:
        break; // everything else: no entry
    }
  }
}

/** Codex `function_call` argument fields that name things, besides `command` / `cmd`. */
const CODEX_TOOL_FIELDS = ["path", "file_path", "pattern", "query", "url"];

function collectCodex(record: JsonObject, entries: DictationEntry[]): void {
  if (record.type !== "response_item" || !isObject(record.payload)) return;
  const payload = record.payload;
  switch (payload.type) {
    case "reasoning": {
      for (const item of objectArray(payload.summary) ?? []) pushProse(typeof item.text === "string" ? item.text : "", entries);
      return;
    }
    case "message": {
      const role = payload.role;
      const blocks = objectArray(payload.content);
      if ((role !== "user" && role !== "assistant") || !blocks) return;
      for (const block of blocks) {
        const text = typeof block.text === "string" ? block.text : "";
        if (!text) continue;
        if (role === "user") {
          if (block.type !== "input_text" && block.type !== "text") continue;
          pushPrompt(text, entries);
        } else {
          if (block.type !== "output_text" && block.type !== "text") continue;
          pushProse(text, entries);
        }
      }
      return;
    }
    case "function_call": {
      // `arguments` is a JSON object serialised as a string.
      if (typeof payload.arguments !== "string") return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload.arguments);
      } catch {
        return;
      }
      if (!isObject(parsed)) return;
      const args = parsed;
      const values: string[] = [];
      const command = codexCommand(args.command !== undefined ? args.command : args.cmd);
      if (command !== null) values.push(command);
      for (const field of CODEX_TOOL_FIELDS) {
        const value = args[field];
        if (typeof value === "string") values.push(value);
      }
      pushTool(typeof payload.name === "string" ? payload.name : null, values, entries);
      return;
    }
    default:
      // `custom_tool_call` inputs are patches or code-mode snippets: nothing is taken from them.
      // Tool outputs, agent_message and bookkeeping: no entry.
      return;
  }
}

/** A Codex command as one string: `["bash", "-lc", script]` is the script; other arrays are joined
 * with spaces. */
function codexCommand(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!Array.isArray(value) || value.length === 0 || !value.every((part) => typeof part === "string")) return null;
  const parts = value as string[];
  if (parts.length >= 3 && (parts[parts.length - 2] === "-lc" || parts[parts.length - 2] === "-c")) return parts[parts.length - 1]!;
  return parts.join(" ");
}

/** Whole-text wrappers that are machine injection, matched at the start of the message only. */
const INJECTED_PREFIXES = [
  "<command-name>",
  "<command-message>",
  "<command-args>",
  "<local-command-stdout>",
  "<local-command-stderr>",
  "<user-prompt-submit-hook>",
  "<system-reminder>",
  "# AGENTS.md instructions for ",
  "<INSTRUCTIONS>",
];
/** Claude writes these into the stream as `user` text; they are markers, not prose. */
const SYSTEM_MARKER = "[Request interrupted by user";

function isInjected(text: string): boolean {
  const trimmed = text.replace(/^\s+/, "");
  if (INJECTED_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) return true;
  if (trimmed.startsWith(SYSTEM_MARKER)) return true;
  const firstLine = (trimmed.split("\n", 1)[0] ?? "").replace(/^[ \t]+|[ \t]+$/g, "");
  return isLoneOpeningTag(firstLine);
}

/** A first line that is a lone opening tag (`<environment_context>`, `<skill>`, …): shape, not a
 * name list — a person's prompt does not open with a bare tag alone on line one. */
function isLoneOpeningTag(line: string): boolean {
  return /^<[A-Za-z][A-Za-z0-9_-]*>$/.test(line);
}

function pushPrompt(text: string, entries: DictationEntry[]): void {
  const value = text.trim();
  if (!value || isInjected(value)) return;
  entries.push({ speaker: "person", text: value });
}

function pushProse(text: string, entries: DictationEntry[]): void {
  const value = text.trim();
  if (!value) return;
  entries.push({ speaker: "agent", text: value });
}

/** One tool call's naming fields: each value's first line only (a command's heredoc body is
 * content, not a name), capped at `MAX_TOOL_VALUE_CHARACTERS`. */
function pushTool(name: string | null, values: readonly string[], entries: DictationEntry[]): void {
  const kept: string[] = [];
  for (const value of values) {
    const line = value.split(/\r\n|[\n\r\v\f\u0085\u2028\u2029]/).find((piece) => piece.length > 0) ?? "";
    const trimmed = line.replace(/^[ \t]+|[ \t]+$/g, "");
    if (!trimmed) continue;
    const chars = characters(trimmed);
    kept.push(chars.length > MAX_TOOL_VALUE_CHARACTERS ? chars.slice(0, MAX_TOOL_VALUE_CHARACTERS).join("") : trimmed);
  }
  if (kept.length === 0) return;
  const entry: DictationEntry = { speaker: "tool", text: kept.join(" · ") };
  if (name !== null) entry.tool = characters(name.trim()).slice(0, 64).join("");
  entries.push(entry);
}

// ---------------------------------------------------------------------------- budget

/** Recognition items within the budget: the workspace sentence, the term sentence, then
 * conversation entries newest first — tool entries never go in. The entry that crosses the budget
 * is cut from its start (its end is the most recent part) and is the last one in. */
export function recognitionItems(sentence: string | null, termSentence: string | null, entries: readonly DictationEntry[]): { items: string[]; includesConversation: boolean } {
  const items: string[] = [];
  let used = 0;
  for (const fixed of [sentence, termSentence]) {
    if (fixed === null) continue;
    items.push(fixed);
    used += estimatedTokens(fixed);
  }
  let included = false;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.speaker === "tool") continue;
    const text = (entry.speaker === "person" ? "我：" : "Agent：") + entry.text;
    const cost = estimatedTokens(text);
    if (used + cost <= DICTATION_TOKEN_BUDGET) {
      items.push(text);
      used += cost;
      included = true;
      continue;
    }
    const remaining = DICTATION_TOKEN_BUDGET - used;
    if (remaining >= MINIMUM_TRUNCATED_TOKENS) {
      const prefix = entry.speaker === "person" ? "我：…" : "Agent：…";
      const tail = suffixWithin(entry.text, remaining - estimatedTokens(prefix));
      if (tail) {
        items.push(prefix + tail);
        included = true;
      }
    }
    break;
  }
  return { items, includesConversation: included };
}

// ---------------------------------------------------------------------------- terms

/** Generic path pieces that name nothing in particular. */
const STOP_WORDS = new Set([
  "src", "lib", "libs", "test", "tests", "spec", "docs", "doc", "index", "main", "app", "apps",
  "gen", "dist", "build", "bin", "tmp", "README", "LICENSE", "readme", "license", "the", "and",
  "for", "with", "from", "this", "that", "http", "https", "www", "com",
]);
const MINIMUM_TERM_LENGTH = 3;
const MAXIMUM_TERM_LENGTH = 64;
/** Repository terms kept at most; the term sentence and the refiner's budget take far fewer. */
const MAX_REPOSITORY_TERMS = 4000;
/** Conversation terms kept at most. */
const MAX_CONVERSATION_TERMS = 1000;

/** Conversation and tool-input terms, newest entry first, in order of appearance within an entry. */
export function conversationTerms(entries: readonly DictationEntry[]): string[] {
  const seen = new Set<string>();
  const collected: string[] = [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    for (const term of termsIn(entry.text, entry.speaker === "tool")) {
      if (seen.has(term)) continue;
      seen.add(term);
      collected.push(term);
      if (collected.length >= MAX_CONVERSATION_TERMS) return collected;
    }
  }
  return collected;
}

/** Directory names (most files beneath them first), then each file's stem and basename in listing
 * order. A truncated last line is ignored. */
export function repositoryTerms(listing: string): string[] {
  const lines = listing.split("\n").filter(Boolean);
  if (!listing.endsWith("\n") && lines.length > 0) lines.pop();
  const directoryCounts = new Map<string, number>();
  const directoryOrder: string[] = [];
  const fileTerms: string[] = [];
  const seenFiles = new Set<string>();
  for (const line of lines) {
    const components = line.split("/").filter(Boolean);
    const basename = components[components.length - 1];
    if (basename === undefined) continue;
    for (const directory of components.slice(0, -1)) {
      if (!isName(directory)) continue;
      if (!directoryCounts.has(directory)) directoryOrder.push(directory);
      directoryCounts.set(directory, (directoryCounts.get(directory) ?? 0) + 1);
    }
    for (const term of [stem(basename), basename]) {
      if (!isName(term) || seenFiles.has(term)) continue;
      seenFiles.add(term);
      fileTerms.push(term);
    }
  }
  const directories = directoryOrder
    .map((name, offset) => ({ name, offset, count: directoryCounts.get(name) ?? 0 }))
    .sort((left, right) => (left.count !== right.count ? right.count - left.count : left.offset - right.offset))
    .map((entry) => entry.name);
  return mergedTerms(directories, fileTerms).slice(0, MAX_REPOSITORY_TERMS);
}

/** `first` then `second`, without repeats. */
export function mergedTerms(first: readonly string[], second: readonly string[]): string[] {
  const seen = new Set<string>();
  return [...first, ...second].filter((term) => {
    if (seen.has(term)) return false;
    seen.add(term);
    return true;
  });
}

/** 「相关术语：A、B、C。」 with as many terms as fit `budget` estimated tokens; null without terms. */
export function termSentence(terms: readonly string[], budget: number): string | null {
  const prefix = "相关术语：";
  const kept: string[] = [];
  let used = estimatedTokens(`${prefix}。`);
  for (const term of terms) {
    const cost = estimatedTokens(term) + (kept.length === 0 ? 0 : 1);
    if (used + cost > budget) break;
    kept.push(term);
    used += cost;
  }
  return kept.length > 0 ? `${prefix}${kept.join("、")}。` : null;
}

const ASCII_NAME_CHAR = /^[A-Za-z0-9_.\-/]$/;

/** Terms in one entry. Inside backticks, and everywhere in a tool input (`lenient`), any ASCII name
 * counts; in prose only identifier-shaped tokens do, so ordinary English words stay out. Paths
 * contribute their pieces. */
function termsIn(text: string, lenient: boolean): string[] {
  const result: string[] = [];
  let inCode = false;
  let current = "";
  const flush = () => {
    const token = current.replace(/^[.\-/_]+|[.\-/_]+$/g, "");
    current = "";
    if (!token) return;
    if (token.includes("/")) {
      for (const piece of token.split("/").filter(Boolean)) {
        for (const term of [piece, stem(piece)]) if (isName(term)) result.push(term);
      }
      return;
    }
    if (!isName(token)) return;
    if (lenient || inCode || isIdentifierShaped(token)) {
      result.push(token);
      const tokenStem = stem(token);
      if (tokenStem !== token && isName(tokenStem) && hasFileExtension(token)) result.push(tokenStem);
    }
  };
  for (const char of text) {
    if (char === "`") {
      flush();
      inCode = !inCode;
      continue;
    }
    if (ASCII_NAME_CHAR.test(char)) current += char;
    else flush();
  }
  flush();
  return result;
}

/** Long enough, not too long, has an ASCII letter, and is not a generic word. */
function isName(token: string): boolean {
  if (token.length < MINIMUM_TERM_LENGTH || token.length > MAXIMUM_TERM_LENGTH) return false;
  if (!/[A-Za-z]/.test(token) || token.startsWith("-")) return false;
  return !STOP_WORDS.has(token);
}

/** camelCase / PascalCase, snake_case, an acronym, letters with digits, or a dotted name with a part
 * of two or more characters (`e.g` is not a name, `store.ts` is). */
function isIdentifierShaped(token: string): boolean {
  const letters = token.replace(/[^A-Za-z]/g, "");
  if (/[A-Z]/.test(token.slice(1))) return true;
  if (token.includes("_")) return true;
  if (letters.length >= 2 && letters === letters.toUpperCase()) return true;
  if (/[0-9]/.test(token)) return true;
  if (token.includes(".")) {
    const parts = token.split(".").filter(Boolean);
    return parts.some((part) => part.length >= 2) && parts.length >= 2;
  }
  return false;
}

function hasFileExtension(token: string): boolean {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return false;
  const ext = token.slice(dot + 1);
  return ext.length >= 1 && ext.length <= 5 && /^[A-Za-z0-9]+$/.test(ext);
}

/** The name without its last extension; the name itself for dotfiles and names without one. */
function stem(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return name;
  return name.slice(0, dot);
}

// ---------------------------------------------------------------------------- the source

/** 「当前项目 X，工作区 Y，分支 Z。」 with unknown parts left out; null when nothing is known. */
export function workspaceSentence(project: string, workspace: string, branch: string): string | null {
  const parts: string[] = [];
  if (project) parts.push(`当前项目 ${project}`);
  if (workspace && workspace !== branch) parts.push(`工作区 ${workspace}`);
  if (branch) parts.push(`分支 ${branch}`);
  return parts.length > 0 ? `${parts.join("，")}。` : null;
}

export type DictationContextSource = {
  readonly workspaceSentence: string | null;
  /** Read and parse the transcript with `read`'s bounds; null for a plain shell, an unusable id, a
   * missing or unreadable file, or an exec error. */
  readTranscript: (read: DictationRead) => Promise<DictationReading | null>;
  /** Repository names from `git ls-files` in the workspace; empty for no git or any error. */
  readRepositoryTerms: () => Promise<string[]>;
  recognitionContext: (reading: DictationReading | null, repositoryTerms: readonly string[] | null) => DesktopDictationContext;
  refineContext: (reading: DictationReading | null, repositoryTerms: readonly string[] | null) => DesktopDictationRefineContext;
};

/** Where the context comes from: the pane's agent and workspace. */
export function createDictationContextSource(options: {
  exec: TranscriptExec;
  workspaceId: string;
  workspaceSentence: string | null;
  agent: TranscriptAgent | null;
  agentSessionId: string | null;
}): DictationContextSource {
  const { exec, workspaceId, agent, agentSessionId } = options;
  const sentence = options.workspaceSentence;
  return {
    workspaceSentence: sentence,
    async readTranscript(read) {
      if (!agent || !agentSessionId || !isUsableAgentSessionId(agentSessionId)) return null;
      const { command, args } = dictationTranscriptCommand(agent, agentSessionId, read);
      try {
        const result = await exec(workspaceId, command, args);
        if (!result.ok || result.exitCode !== 0) return null;
        const entries = parseDictationOutput(agent, result.stdout);
        return entries ? { entries, terms: conversationTerms(entries) } : null;
      } catch {
        return null;
      }
    },
    async readRepositoryTerms() {
      try {
        const result = await exec(workspaceId, DICTATION_REPOSITORY_COMMAND.command, DICTATION_REPOSITORY_COMMAND.args);
        if (!result.ok || result.exitCode !== 0) return [];
        return repositoryTerms(result.stdout);
      } catch {
        return [];
      }
    },
    recognitionContext(reading, terms) {
      const merged = mergedTerms(reading?.terms ?? [], terms ?? []);
      return { items: recognitionItems(sentence, termSentence(merged, DICTATION_TERM_BUDGET), reading?.entries ?? []).items };
    },
    refineContext(reading, terms) {
      // Repository terms only: conversation terms change every turn and would break the request's
      // cacheable prefix; the conversation entries themselves are in the request anyway.
      return { workspaceSentence: sentence, terms: [...(terms ?? [])], entries: [...(reading?.entries ?? [])] };
    },
  };
}
