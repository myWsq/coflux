/**
 * Supabase 身份验签（IdP 一次性认证，见 plans/001）。
 *
 * 核心决策：Supabase 只做「你是谁」。web 用 Supabase 的 access_token(JWT) 换 coflux 会话 token，
 * server 用 JWKS 本地验签（无网络往返，公钥缓存 + 自动轮换），取 sub 为 userId。
 * 之后所有 WS 重连只用 coflux 自己的会话 token，全程不再触碰 Supabase。
 *
 * 要求 Supabase 项目启用非对称签名（ES256/RS256，新项目默认）；HS256 legacy secret 不支持，验签失败。
 */
import { createRemoteJWKSet, jwtVerify } from "jose";

export interface SupabaseIdentity {
  /** JWT `sub`：Supabase user UUID，作为 coflux 的 userId */
  userId: string;
  /** JWT `email` claim（可能缺失）；用作 lazy 建号时的账号名 */
  email: string | null;
}

export class SupabaseVerifier {
  private jwks: ReturnType<typeof createRemoteJWKSet>;
  private issuer: string;
  private audience = "authenticated";

  /** supabaseUrl 已去尾斜杠（见 config.ts） */
  constructor(supabaseUrl: string) {
    this.issuer = `${supabaseUrl}/auth/v1`;
    this.jwks = createRemoteJWKSet(new URL(`${supabaseUrl}/auth/v1/.well-known/jwks.json`));
  }

  /** 验签通过返回身份；过期 / 错签名 / iss/aud 不符 / 缺 sub 一律返回 null（调用方回 auth.error）。 */
  async verify(token: string): Promise<SupabaseIdentity | null> {
    try {
      const { payload } = await jwtVerify(token, this.jwks, {
        issuer: this.issuer,
        audience: this.audience,
      });
      if (typeof payload.sub !== "string" || !payload.sub) return null;
      const email = typeof payload.email === "string" ? payload.email : null;
      return { userId: payload.sub, email };
    } catch {
      return null;
    }
  }
}
