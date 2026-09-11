/// <reference types="vite/client" />

// electron.vite.config.ts 的 define 注入（plan 033）：生产构建 = git short SHA，dev = "dev"。只作标识上报，桌面按控制面协议版本准入（plan 105）。
declare const __COFLUX_BUILD_ID__: string;
