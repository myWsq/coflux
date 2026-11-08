/**
 * Claude Code's "session recap", read on demand for a terminal tab's hover card.
 *
 * After a session has sat idle for a few minutes Claude Code appends one record to its transcript:
 *
 *     {"type":"system","subtype":"away_summary","content":"<recap> (disable recaps in /config)",…}
 *
 * The same boundaries as `terminal-transcript.ts` apply: the daemon returns bytes only, all format
 * knowledge lives here, and the agent session id is never interpolated into command text — the
 * script is a fixed literal that references `"$1"`, and the id travels as its own argv entry.
 */
import {
  EXIT_NOT_FOUND,
  EXIT_READ_FAILED,
  HEADER_PREFIX,
  isUsableAgentSessionId,
  type TranscriptExec,
} from "@/components/workbench/terminal-transcript";

/**
 * A much smaller window than the paper's: the recap only matters while it is the latest thing in
 * the session, so it sits near the end of the file. Hovering a tab must stay cheap.
 */
export const RECAP_TAIL_BYTES = 64 * 1024;

/** Same lookup as the paper's Claude locator, with the smaller tail window. */
const CLAUDE_RECAP_SCRIPT = `set -u
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
printf '${HEADER_PREFIX} %s ${RECAP_TAIL_BYTES}\\n' "$size"
tail -c ${RECAP_TAIL_BYTES} "$newest" || exit ${EXIT_READ_FAILED}
`;

/** The suffix Claude Code appends to every recap; it is a setting hint, not part of the recap. */
const RECAP_SUFFIX = "(disable recaps in /config)";

export type Recap = {
  text: string;
  /** Epoch milliseconds, or null when the record carries no parsable timestamp. */
  timestamp: number | null;
};

/** The exact argv for locating and tailing a Claude transcript for its recap. */
export function recapCommand(agentSessionId: string): { command: string; args: string[] } {
  return { command: "sh", args: ["-c", CLAUDE_RECAP_SCRIPT, "sh", agentSessionId] };
}

/**
 * The current recap of a Claude session, or null for "none". Every failure — an unusable id, no
 * transcript, a failed read, a rejected exec, unrecognisable output — is also "none": the card
 * simply shows no recap, and none of these deserves an error on a hover.
 */
export async function loadRecap(
  exec: TranscriptExec,
  input: { agentSessionId: string; workspaceId: string },
): Promise<Recap | null> {
  if (!isUsableAgentSessionId(input.agentSessionId)) return null;
  const { command, args } = recapCommand(input.agentSessionId);
  let result: Awaited<ReturnType<TranscriptExec>>;
  try {
    result = await exec(input.workspaceId, command, args);
  } catch {
    return null;
  }
  if (!result.ok || result.exitCode !== 0) return null;
  return parseRecapOutput(result.stdout);
}

/** Split the locator's stdout into its header and the raw tail, then parse the tail. */
export function parseRecapOutput(stdout: string): Recap | null {
  const newline = stdout.indexOf("\n");
  if (newline === -1) return null;
  const fields = stdout.slice(0, newline).trim().split(/\s+/);
  if (fields[0] !== HEADER_PREFIX) return null;
  return parseRecap(stdout.slice(newline + 1));
}

/**
 * Pure function over the transcript tail. The recap is the last `away_summary` record, and it is
 * current only while the conversation has not moved on: any later `user` or `assistant` record
 * means a new turn started after it. Other record types (bookkeeping) do not count.
 *
 * The first line of a tail is usually a truncated fragment; like any unparsable line it is skipped.
 */
export function parseRecap(text: string): Recap | null {
  let recap: Record<string, unknown> | null = null;
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
    if (record.type === "system" && record.subtype === "away_summary") recap = record;
    else if (record.type === "user" || record.type === "assistant") recap = null;
  }
  if (!recap) return null;
  const content = typeof recap.content === "string" ? recap.content.trim() : "";
  const body = (content.endsWith(RECAP_SUFFIX) ? content.slice(0, -RECAP_SUFFIX.length) : content).trim();
  if (body.length === 0) return null;
  const parsed = typeof recap.timestamp === "string" ? Date.parse(recap.timestamp) : Number.NaN;
  return { text: body, timestamp: Number.isFinite(parsed) ? parsed : null };
}

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** How long ago the recap was written, as the card shows it. A future timestamp reads as 刚刚. */
export function formatRecapAge(now: number, timestamp: number): string {
  const elapsed = now - timestamp;
  if (elapsed < MINUTE_MS) return "刚刚";
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)} 分钟前`;
  if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)} 小时前`;
  return `${Math.floor(elapsed / DAY_MS)} 天前`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
