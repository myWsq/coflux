/**
 * Native browser login (plan 20260923-oauth-login-redesign) for the desktop main process and both CLIs:
 * which providers the server offers, register a login request (loopback port or paste, PKCE S256
 * challenge), and trade the one-time code + verifier for a `ck_sess` token. No origin/CORS relaxation:
 * these are plain JSON POST/GET endpoints called from native code, like `/api/client/login`.
 */
import { defineContract } from "@raven.js/core/contract";
import { z } from "zod";

/** Unauthenticated read: what the login surfaces may show. */
export const ClientAuthConfigContract = defineContract({
  method: "GET",
  path: "/api/client/auth-config",
  schemas: {},
});

export const ClientLoginRequestContract = defineContract({
  method: "POST",
  path: "/api/client/login/request",
  schemas: {
    body: z
      .object({
        protocolVersion: z.literal(1),
        clientKind: z.enum(["desktop", "cli"]),
        host: z.string().min(1).max(253),
        redirect: z.enum(["loopback", "paste"]),
        port: z.number().int().min(1024).max(65535).optional(),
        codeChallenge: z.string().length(43),
        codeChallengeMethod: z.literal("S256"),
        state: z.string().min(16).max(128),
      })
      .strict(),
  },
});

export const ClientLoginExchangeContract = defineContract({
  method: "POST",
  path: "/api/client/login/exchange",
  schemas: {
    body: z
      .object({
        protocolVersion: z.literal(1),
        code: z.string().min(1).max(64),
        codeVerifier: z.string().min(43).max(128),
      })
      .strict(),
  },
});
