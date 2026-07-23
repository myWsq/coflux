export const SERVER_URL =
  import.meta.env.VITE_COFLUX_SERVER ??
  `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/client`;

// 独立命名空间：与桌面 web 同域调试时不串台（决策见 plan 032）。
export const TOKEN_KEY = "coflux_m_token";

// Supabase 是构建期开关；未配置时继续使用服务端的本地账号模式。
export const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL?.replace(/\/+$/, "");
export const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
export const USE_SUPABASE = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

export type { AuthCredential } from "@coflux/client";
