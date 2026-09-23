/**
 * Who may sign in through a provider (plan 20260923-oauth-login-redesign). Pure functions, no config
 * import, so the rules are unit-testable: a mistake here is either a silent account takeover or a
 * silent lockout, and neither shows up while using the product.
 *
 * - A provider identity is only ever trusted with a **provider-verified** email. Unverified or missing
 *   emails are refused before anything is written.
 * - An email that already belongs to a coflux user signs into that user (same id, same account).
 * - An unknown email creates a user only when it matches the allowlist; otherwise it is refused.
 */

/** Refusal codes carried back to the pages as `?error=<code>`; pages map them to fixed copy. */
export const SIGNUP_REFUSAL = {
  emailNotVerified: "email_not_verified",
  emailNotAllowed: "email_not_allowed",
} as const;

export type SignupRefusal = (typeof SIGNUP_REFUSAL)[keyof typeof SIGNUP_REFUSAL];

/** Same normalisation as `scripts/create-user.mjs` and `checkCredentials`: trim + lower-case. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export interface SignupAllowlist {
  addresses: ReadonlySet<string>;
  /** Domains without the leading `@`. */
  domains: ReadonlySet<string>;
}

/** `COFLUX_SIGNUP_ALLOWLIST`: comma-separated exact addresses and `@domain` entries. Blank entries and
 * anything that is neither shape (no `@`, or an address with an empty local part) are ignored. */
export function parseSignupAllowlist(raw: string): SignupAllowlist {
  const addresses = new Set<string>();
  const domains = new Set<string>();
  for (const part of raw.split(",")) {
    const entry = normalizeEmail(part);
    if (!entry) continue;
    if (entry.startsWith("@")) {
      const domain = entry.slice(1);
      if (domain && !domain.includes("@")) domains.add(domain);
      continue;
    }
    const at = entry.indexOf("@");
    if (at > 0 && at === entry.lastIndexOf("@") && at < entry.length - 1) addresses.add(entry);
  }
  return { addresses, domains };
}

/** Exact address or exact domain match on the normalised email; a subdomain is not its parent domain. */
export function isAllowlisted(email: string, allowlist: SignupAllowlist): boolean {
  const normalized = normalizeEmail(email);
  const at = normalized.lastIndexOf("@");
  if (at <= 0 || at === normalized.length - 1 || normalized.indexOf("@") !== at) return false;
  if (allowlist.addresses.has(normalized)) return true;
  return allowlist.domains.has(normalized.slice(at + 1));
}

export type SignupDecision =
  | { case: "existing"; userId: string; email: string }
  | { case: "create"; email: string }
  | { case: "refuse"; code: SignupRefusal };

/**
 * The decision the Better Auth create hook applies. `emailVerified` must be the provider's own flag
 * (Better Auth's `user.emailVerified`), and only a literal `true` counts.
 */
export function decideProviderSignup(
  identity: { email: string | null | undefined; emailVerified: unknown },
  existingUserId: string | undefined,
  allowlist: SignupAllowlist,
): SignupDecision {
  const email = typeof identity.email === "string" ? normalizeEmail(identity.email) : "";
  if (!email || identity.emailVerified !== true) return { case: "refuse", code: SIGNUP_REFUSAL.emailNotVerified };
  if (existingUserId) return { case: "existing", userId: existingUserId, email };
  if (isAllowlisted(email, allowlist)) return { case: "create", email };
  return { case: "refuse", code: SIGNUP_REFUSAL.emailNotAllowed };
}
