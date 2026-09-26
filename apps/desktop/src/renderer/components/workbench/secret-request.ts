import type { SecretAnswer, SecretAnswerResult, SecretRequestState } from "@coflux/client";

/**
 * Agent secret requests (plan 20260926-agent-secret-input), the pure half: which requests belong to
 * a terminal, how a card moves after the worker acknowledges an answer, and how an inbox entry of a
 * request reads once the request is over.
 *
 * The worker raises one inbox entry per request whose message starts with this prefix followed by
 * the NAME. It must match `NOTIFY_PREFIX` in `crates/worker/src/secret/socket.rs`.
 */
export const SECRET_REQUEST_NOTIFY_PREFIX = "Secret requested: ";

/** The NAME a secret-request inbox message is about; null for any other message. */
export function secretRequestNameOf(message: string): string | null {
  if (!message.startsWith(SECRET_REQUEST_NOTIFY_PREFIX)) return null;
  const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(message.slice(SECRET_REQUEST_NOTIFY_PREFIX.length));
  return match ? match[0] : null;
}

/**
 * Whether a secret-request inbox entry reads as ended: its terminal has no pending request for the
 * same NAME in the live set. null = the entry is not a secret request. No protocol field backs this;
 * the live set from the center is the only truth.
 */
export function secretRequestEntryEnded(
  item: { message: string; taskId: string },
  pending: Readonly<Record<string, SecretRequestState>>,
): boolean | null {
  const name = secretRequestNameOf(item.message);
  if (name === null) return null;
  return !Object.values(pending).some((request) => request.taskId === item.taskId && request.name === name);
}

/** The pending requests of one terminal, oldest first (the order the agent asked in). */
export function secretRequestsForTask(
  pending: Readonly<Record<string, SecretRequestState>>,
  taskId: string,
): SecretRequestState[] {
  return Object.values(pending)
    .filter((request) => request.taskId === taskId)
    .sort((a, b) => a.createdAt - b.createdAt || a.requestId.localeCompare(b.requestId));
}

/** Where a card is. `closed` removes it at once, before the live set catches up. */
export type SecretCardPhase =
  | { kind: "pending" }
  | { kind: "submitting"; answer: SecretAnswer["kind"] }
  | { kind: "failed"; error: string }
  | { kind: "closed"; reason: "provided" | "declined" | "cancelled" | "answered_elsewhere" | "expired" };

/** The card's next phase once the worker acknowledged (or the send failed). */
export function phaseAfterAnswer(answer: SecretAnswer["kind"], result: SecretAnswerResult): SecretCardPhase {
  switch (result.status) {
    case "accepted":
      return { kind: "closed", reason: answer === "provide" ? "provided" : answer === "decline" ? "declined" : "cancelled" };
    case "already_answered":
      return { kind: "closed", reason: "answered_elsewhere" };
    case "expired":
    case "unknown_request":
      return { kind: "closed", reason: "expired" };
    case "invalid":
      return { kind: "failed", error: "设备拒绝了这个值：不能为空、不能超过 64 KB，也不能含 NUL 字符" };
    case "failed":
      return { kind: "failed", error: `没能送达设备：${result.error}` };
  }
}
