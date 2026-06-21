/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_COFLUX_SERVER?: string;
  readonly VITE_COFLUX_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
