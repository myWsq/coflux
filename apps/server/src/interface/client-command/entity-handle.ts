/**
 * Entity handles: `coflux:<kind>:<hex>` — a short string that is visibly coflux's and visibly typed,
 * accepted anywhere a real id is accepted and attached to every entity the account API returns.
 *
 * A handle is a boundary concept. It is parsed and resolved to a real id at the account-command entry
 * point, so nothing below that point ever sees one; generation is a pure concatenation of a kind token
 * and the first 8 hex characters of the entity's UUID, which is why every client composes handles
 * locally instead of the protocol carrying them.
 *
 * Resolution is account-scoped and kind-scoped by construction: the caller supplies a lookup already
 * bound to the requesting account, and a handle whose kind does not match what the command expects is
 * rejected by reading the kind token alone — it never probes another kind's table, so a handle can
 * never become an existence oracle for another account's entities.
 *
 * This is deliberately not called `shortId`: that name already means the port-preview routing identity
 * in this same server (`proxy.ts`), an unrelated concept.
 */

export type EntityKind = "device" | "project" | "workspace" | "terminal";

/** Generation always emits exactly 8 lowercase hex characters — the UUID's first dash-delimited group.
 * A shorter prefix is a collision budget being spent: the ambiguity error below is its visible cost. */
const REF_HEX_LENGTH = 8;

/** Input is case-insensitive (normalised to lowercase before matching). 4..32 hex characters keeps a
 * hand-shortened handle legal while refusing anything that is not a bare id prefix. */
const HANDLE_PATTERN = /^coflux:(device|project|workspace|terminal):([0-9a-f]{4,32})$/;

/** Runtime strings the user reads stay Chinese, like every neighbouring message on this endpoint. */
const KIND_LABEL: Record<EntityKind, string> = { device: "设备", project: "项目", workspace: "工作区", terminal: "终端" };

/** The handle of an entity, for any payload that carries that entity. Never replaces its id field. */
export function entityRef(kind: EntityKind, id: string): string {
  return `coflux:${kind}:${id.slice(0, REF_HEX_LENGTH).toLowerCase()}`;
}

export function parseEntityHandle(input: string): { kind: EntityKind; prefix: string } | undefined {
  const matched = HANDLE_PATTERN.exec(input.trim().toLowerCase());
  return matched ? { kind: matched[1] as EntityKind, prefix: matched[2] } : undefined;
}

/** Account-scoped candidate lookup: ids of `kind` in the requesting account whose id starts with
 * `prefix`, capped at `limit` rows. Bounded on purpose — ambiguity is decided from two rows, never
 * from a list of everything the account owns. */
export type HandleLookup = (kind: EntityKind, prefix: string, limit: number) => Promise<string[]>;

export type HandleResolution = { ok: true; value: string } | { ok: false; error: string };

/**
 * Normalise one id-shaped argument. A string that is not a handle passes through untouched (real ids
 * keep working exactly as before); a handle resolves to exactly one id, or fails with one of three
 * distinct, actionable messages: wrong kind, unknown handle, ambiguous prefix.
 */
export async function resolveEntityHandle(expected: EntityKind, input: string, lookup: HandleLookup): Promise<HandleResolution> {
  const handle = parseEntityHandle(input);
  if (!handle) return { ok: true, value: input };
  // Kind mismatch is answered from the token alone: a `terminal.stop` handed a workspace handle must
  // fail loudly rather than act on something adjacent, and must not learn whether that workspace exists.
  if (handle.kind !== expected) {
    return { ok: false, error: `${input} 是${KIND_LABEL[handle.kind]}标识，这里要的是${KIND_LABEL[expected]}标识（coflux:${expected}:…）` };
  }
  const matches = await lookup(expected, handle.prefix, 2);
  if (matches.length === 0) return { ok: false, error: `标识 ${input} 在当前账号下没有对应的${KIND_LABEL[expected]}` };
  if (matches.length > 1) return { ok: false, error: `标识 ${input} 同时匹配到多个${KIND_LABEL[expected]}，请改用完整 UUID` };
  return { ok: true, value: matches[0] };
}
