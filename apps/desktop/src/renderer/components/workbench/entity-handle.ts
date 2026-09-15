/**
 * coflux entity handles (plan 20260914-entity-handles): `coflux:<kind>:<short id>`, a short
 * string that is visibly coflux's and visibly typed. The user copies one and pastes it to an
 * agent; every interface that accepts the real id accepts the handle too.
 *
 * Handles are composed client-side — the protobuf contract deliberately carries no `ref` — so
 * this module is the desktop renderer's single generation point. Server, worker, both CLIs and
 * iOS each hold their own copy of the same rule; a grammar change has to touch all of them.
 */

/** The four entity kinds that have a handle. PTY sessions deliberately have none. */
export type EntityKind = "device" | "project" | "workspace" | "terminal";

/**
 * Generated handles always carry the UUID's first dash-delimited group, and never another
 * length. The 8 characters are a collision budget, not a cosmetic constant: a shorter one buys
 * a shorter paste and pays for it with user-visible "paste the full UUID" ambiguity errors on
 * the resolving side.
 */
const HANDLE_ID_LENGTH = 8;

/** `entityHandle("device", "b6767697-60b2-4700-…")` → `coflux:device:b6767697`. */
export function entityHandle(kind: EntityKind, id: string): string {
  return `coflux:${kind}:${id.slice(0, HANDLE_ID_LENGTH).toLowerCase()}`;
}

/**
 * Put an entity's handle on the clipboard. `clipboard-sanitized-write` is already granted to the
 * renderer (the permission handler in `src/main/index.ts`), so this needs no preload bridge.
 *
 * A rejected write is swallowed: the workbench has no toast surface, and the one error channel
 * at these call sites (`client.reportLocalError`) drives unrelated state — a copy that did not
 * land is retried by right-clicking again.
 */
export function copyEntityHandle(kind: EntityKind, id: string): void {
  void navigator.clipboard.writeText(entityHandle(kind, id)).catch(() => {});
}
