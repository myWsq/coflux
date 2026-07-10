import { SUPABASE_ANON_KEY, SUPABASE_URL } from "@/config";

export type SupabaseLoginResult = { ok: true; accessToken: string } | { ok: false; message: string };

/** 只负责邮箱密码换取 Supabase access_token；coflux 会话换票仍走各页面自己的 WS。 */
export async function loginWithSupabase(email: string, password: string): Promise<SupabaseLoginResult> {
  try {
    const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { "content-type": "application/json", apikey: SUPABASE_ANON_KEY! },
      body: JSON.stringify({ email, password }),
    });
    if (!response.ok) return { ok: false, message: "邮箱或密码错误" };

    const data = (await response.json()) as { access_token?: unknown };
    if (typeof data.access_token !== "string" || !data.access_token) {
      return { ok: false, message: "登录失败：未获得访问令牌" };
    }
    return { ok: true, accessToken: data.access_token };
  } catch {
    return { ok: false, message: "网络错误：无法连接认证服务" };
  }
}
