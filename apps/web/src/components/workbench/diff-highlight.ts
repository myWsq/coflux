import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

// 单一暗色主题：应用无亮色模式，无需第二套（plan 025 决策）。
const THEME_ID = "github-dark-default";

// 扩展名 → shiki 语言 id；未命中 = null，调用方降级纯文本渲染。
const LANG_BY_EXT: Record<string, string> = {
  ts: "typescript", mts: "typescript", cts: "typescript",
  tsx: "tsx",
  js: "javascript", mjs: "javascript", cjs: "javascript",
  jsx: "jsx",
  json: "json", jsonc: "jsonc", json5: "json5",
  py: "python",
  rs: "rust",
  go: "go",
  rb: "ruby",
  java: "java",
  c: "c", h: "c",
  cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp", hxx: "cpp",
  cs: "csharp",
  php: "php",
  sh: "bash", bash: "bash",
  zsh: "zsh",
  yml: "yaml", yaml: "yaml",
  toml: "toml",
  md: "markdown", markdown: "markdown",
  html: "html", htm: "html",
  css: "css",
  scss: "scss",
  less: "less",
  sql: "sql",
  xml: "xml",
  vue: "vue",
  svelte: "svelte",
  kt: "kotlin", kts: "kotlin",
  swift: "swift",
  ex: "elixir", exs: "elixir",
  erl: "erlang", hrl: "erlang",
  hs: "haskell",
  lua: "lua",
  graphql: "graphql", gql: "graphql",
  ini: "ini",
  proto: "proto",
  r: "r",
  dart: "dart",
  groovy: "groovy",
  pl: "perl",
  ps1: "powershell",
};

const FILENAME_LANG: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
};

// 语言按需懒加载：每个条目是独立 import()，构建器按此天然做代码分割（不进主 bundle）。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const LANG_LOADERS: Record<string, () => Promise<any>> = {
  typescript: () => import("@shikijs/langs/typescript"),
  tsx: () => import("@shikijs/langs/tsx"),
  javascript: () => import("@shikijs/langs/javascript"),
  jsx: () => import("@shikijs/langs/jsx"),
  json: () => import("@shikijs/langs/json"),
  jsonc: () => import("@shikijs/langs/jsonc"),
  json5: () => import("@shikijs/langs/json5"),
  python: () => import("@shikijs/langs/python"),
  rust: () => import("@shikijs/langs/rust"),
  go: () => import("@shikijs/langs/go"),
  ruby: () => import("@shikijs/langs/ruby"),
  java: () => import("@shikijs/langs/java"),
  c: () => import("@shikijs/langs/c"),
  cpp: () => import("@shikijs/langs/cpp"),
  csharp: () => import("@shikijs/langs/csharp"),
  php: () => import("@shikijs/langs/php"),
  bash: () => import("@shikijs/langs/bash"),
  zsh: () => import("@shikijs/langs/zsh"),
  yaml: () => import("@shikijs/langs/yaml"),
  toml: () => import("@shikijs/langs/toml"),
  markdown: () => import("@shikijs/langs/markdown"),
  html: () => import("@shikijs/langs/html"),
  css: () => import("@shikijs/langs/css"),
  scss: () => import("@shikijs/langs/scss"),
  less: () => import("@shikijs/langs/less"),
  sql: () => import("@shikijs/langs/sql"),
  xml: () => import("@shikijs/langs/xml"),
  vue: () => import("@shikijs/langs/vue"),
  svelte: () => import("@shikijs/langs/svelte"),
  kotlin: () => import("@shikijs/langs/kotlin"),
  swift: () => import("@shikijs/langs/swift"),
  elixir: () => import("@shikijs/langs/elixir"),
  erlang: () => import("@shikijs/langs/erlang"),
  haskell: () => import("@shikijs/langs/haskell"),
  lua: () => import("@shikijs/langs/lua"),
  graphql: () => import("@shikijs/langs/graphql"),
  ini: () => import("@shikijs/langs/ini"),
  proto: () => import("@shikijs/langs/proto"),
  r: () => import("@shikijs/langs/r"),
  dart: () => import("@shikijs/langs/dart"),
  groovy: () => import("@shikijs/langs/groovy"),
  perl: () => import("@shikijs/langs/perl"),
  powershell: () => import("@shikijs/langs/powershell"),
  dockerfile: () => import("@shikijs/langs/dockerfile"),
  makefile: () => import("@shikijs/langs/makefile"),
};

/** 由文件路径推断 shiki 语言 id；未知扩展名/文件名返回 null（调用方降级纯文本渲染）。 */
export function resolveLang(path: string): string | null {
  const base = (path.split("/").pop() ?? "").toLowerCase();
  if (FILENAME_LANG[base]) return FILENAME_LANG[base];
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return null;
  return LANG_BY_EXT[base.slice(dot + 1)] ?? null;
}

let highlighterPromise: ReturnType<typeof createHighlighterCore> | null = null;
const loadedLangs = new Set<string>();

function getHighlighter() {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighterCore({
      themes: [import("@shikijs/themes/github-dark-default")],
      langs: [],
      engine: createJavaScriptRegexEngine(),
    });
  }
  return highlighterPromise;
}

export type HighlightToken = { content: string; color?: string };

/**
 * 按行高亮：整份 code 一次性 tokenize（保留跨行语法上下文，如多行字符串/注释），
 * 返回逐行 token 数组，调用方按行渲染。lang 为 null 或未登记语言时原样返回（纯文本降级）。
 */
export async function highlightLines(code: string, lang: string | null): Promise<HighlightToken[][]> {
  if (!lang || !LANG_LOADERS[lang]) {
    return code.split("\n").map((line) => [{ content: line }]);
  }
  const highlighter = await getHighlighter();
  if (!loadedLangs.has(lang)) {
    await highlighter.loadLanguage(LANG_LOADERS[lang]!());
    loadedLangs.add(lang);
  }
  const tokenLines = highlighter.codeToTokensBase(code, { lang, theme: THEME_ID });
  return tokenLines.map((line) => line.map((token) => ({ content: token.content, color: token.color })));
}
