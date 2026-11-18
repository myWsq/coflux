import { isLoopbackHost } from "../shared/browser-loopback";

/**
 * Automatic sign-in for a dev build pointed at a local server.
 *
 * A preview against the local stack has nothing worth typing a password for: the server is the
 * developer's own, usually in password mode with its default account, and its database is often
 * recreated between runs — which is why a stored session cannot be relied on there. So an
 * unpackaged build whose server is on a loopback host signs in by itself at startup, with the same
 * `COFLUX_USERNAME` / `COFLUX_PASSWORD` the local server reads (default `admin` / `admin`), and
 * keeps that session in a token file of its own, so the profile's session for a real server
 * (seeded from the baseline, or signed in by hand) is never overwritten by a local one.
 *
 * Never applies to a packaged app or to a server that is not on loopback: both conditions are
 * checked here, not left to whoever sets the environment. `COFLUX_DESKTOP_DEV_LOGIN=0` turns it off
 * (to look at the sign-in screen itself).
 */

export type DevLoginPlan = {
  /** `POST` target: the server's password login. */
  url: string;
  username: string;
  password: string;
};

export function devLoginPlan(input: { packaged: boolean; serverUrl: string; env: Record<string, string | undefined> }): DevLoginPlan | null {
  if (input.packaged || input.env.COFLUX_DESKTOP_DEV_LOGIN === "0") return null;
  let server: URL;
  try {
    server = new URL(input.serverUrl);
  } catch {
    return null;
  }
  if (!isLoopbackHost(server.hostname)) return null;
  const protocol = server.protocol === "wss:" ? "https:" : server.protocol === "ws:" ? "http:" : null;
  if (!protocol) return null;
  return {
    url: `${protocol}//${server.host}/api/client/login`,
    username: input.env.COFLUX_USERNAME || "admin",
    password: input.env.COFLUX_PASSWORD || "admin",
  };
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ json(): Promise<unknown> }>;

/**
 * Signs in; the session token, or null with the reason reported — the server is not up yet, is not
 * in password mode, or holds other credentials. A failure is never fatal: the app starts with
 * whatever session it already had.
 */
export async function devLogin(plan: DevLoginPlan, fetchImpl: FetchLike, onFailure: (reason: string) => void, timeoutMs = 3000): Promise<string | null> {
  try {
    const response = await fetchImpl(plan.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ protocolVersion: 1, username: plan.username, password: plan.password }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = (await response.json()) as { ok?: unknown; value?: { token?: unknown }; error?: unknown } | null;
    const token = body?.ok === true ? body.value?.token : undefined;
    if (typeof token === "string" && token) return token;
    onFailure(typeof body?.error === "string" ? body.error : "the server did not return a session");
    return null;
  } catch (error) {
    onFailure(error instanceof Error ? error.message : String(error));
    return null;
  }
}
