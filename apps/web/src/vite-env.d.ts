/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_COFLUX_SERVER?: string;
  readonly VITE_COFLUX_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// vite.config.ts 的 define 注入（plan 033）：生产构建 = git short SHA，vite dev = "dev"。
declare const __COFLUX_BUILD_ID__: string;
