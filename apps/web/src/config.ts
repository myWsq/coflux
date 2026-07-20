export const SERVER_URL =
  import.meta.env.VITE_COFLUX_SERVER ??
  `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/client`;

export const TOKEN_KEY = "coflux_token";
export const WORKSPACE_KEY = "coflux_workspace";
export const SIDEBAR_WIDTH_KEY = "coflux_sidebar_width";

// Supabase 是构建期开关；未配置时继续使用服务端的本地账号模式。
export const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL?.replace(/\/+$/, "");
export const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
export const USE_SUPABASE = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

export type AuthCredential =
  | { token: string }
  | { supabaseToken: string }
  | { username: string; password: string };
