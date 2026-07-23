/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_COFLUX_SERVER?: string;
  // 两者都设时，登录表单走 Supabase（email+password 换 access_token → WS 换票）；否则维持用户名+密码。
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
