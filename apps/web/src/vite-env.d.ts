/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_COFLUX_SERVER?: string;
  readonly VITE_COFLUX_TOKEN?: string;
  // 两者都设时，登录表单走 Supabase（email+password 换 access_token → WS 换票）；否则维持用户名+密码。
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// vite.config.ts 的 define 注入（plan 033）：生产构建 = git short SHA，vite dev = "dev"。
declare const __COFLUX_BUILD_ID__: string;
