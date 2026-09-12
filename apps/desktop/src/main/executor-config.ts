/**
 * The executor's global configuration and credentials.
 *
 * Split in two because the two halves have different security levels:
 *   - **Non-sensitive items** (provider, model id) go to plain JSON in userData, a sibling of
 *     `settings.json` but its own file, so a file that only knows `serverUrl` does not swell into a
 *     junk drawer.
 *   - The **API key** is encrypted to disk through `safeStorage`, reusing token-store's approach
 *     (write a temp file, then rename; if encryption is unavailable, write **nothing** rather than
 *     falling back to plaintext).
 *
 * The credential flows one way only: safeStorage -> main-process memory -> the start message at the
 * moment a runner is spawned. It never enters `settings.json`, a tool process's environment, the
 * transcript or the logs, and it is never sent to the renderer — the renderer only learns *whether*
 * something is configured, never what.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { TokenCodec } from "./token-store";
import { createTokenStore } from "./token-store";

/** The configuration shape the renderer can see — **no apiKey**, only whether one is set. */
export type ExecutorSettingsView = {
  provider: string;
  modelId: string;
  hasApiKey: boolean;
  /** Ready only when all three are present; the daemon refuses a submission on this at submit time. */
  ready: boolean;
  reason: string;
};

export type ExecutorSettingsFile = {
  provider?: string;
  modelId?: string;
};

/**
 * The system prompt, fixed by coflux. **Neither user-configurable nor passed by the calling agent** —
 * the executor's persona and boundaries are part of the product; making them configurable would mean
 * every caller has to think them through again, and the boundaries would get missed.
 */
export const EXECUTOR_SYSTEM_PROMPT = [
  "You are the coflux executor: a focused sub-agent that another coding agent delegates a single, bounded task to.",
  "",
  "Hard boundaries, enforced by a kernel sandbox — do not fight them, work within them:",
  "- You can only modify files inside the workspace you were started in. Paths outside it are unreadable and unwritable.",
  "- Git metadata is read-only. You cannot commit, stage, or rewrite history. Leave the changes in the working tree; the agent that called you reviews and commits them.",
  "- Your shell has no network access. Do not try to install dependencies or fetch anything; assume what is already present is all you get.",
  "- Use absolute paths for every file tool call.",
  "",
  "How to work:",
  "- You get one prompt and no follow-up. There is nobody to ask, so make reasonable assumptions and say what you assumed.",
  "- Finish the whole task. If part of it is impossible under the boundaries above, do the rest and state plainly what you skipped and why.",
  "- Your final message is the entire report the calling agent receives. Lead with what you did and what changed, then anything that needs attention. Be concise and concrete.",
].join("\n");

export type ExecutorConfigStore = {
  view(): ExecutorSettingsView;
  /** Called only when spawning a runner; the returned object holds the key in the clear — use it and
   * drop it, never cache it, never log it. */
  secrets(): { provider: string; modelId: string; apiKey: string };
  setModel(provider: string, modelId: string): void;
  /** An empty string clears it. */
  setApiKey(apiKey: string): boolean;
};

export type ExecutorConfigOptions = {
  settingsPath: string;
  keyPath: string;
  codec: TokenCodec;
  onError?: (stage: string, error: unknown) => void;
};

export function readExecutorSettingsFile(path: string): ExecutorSettingsFile {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object") return {};
    const record = parsed as Record<string, unknown>;
    return {
      provider: typeof record.provider === "string" ? record.provider : undefined,
      modelId: typeof record.modelId === "string" ? record.modelId : undefined,
    };
  } catch {
    return {};
  }
}

/** Ready only when all three are present. The reason is passed verbatim to the calling agent, so it
 * is phrased as something that agent can act on. */
export function deriveReadiness(provider: string, modelId: string, hasApiKey: boolean): { ready: boolean; reason: string } {
  if (!provider || !modelId) {
    return { ready: false, reason: "桌面 app 里还没配 executor 的 provider 与模型：打开账号菜单的「Executor 设置…」配好再发" };
  }
  if (!hasApiKey) {
    return { ready: false, reason: `桌面 app 里 ${provider} 的 API key 还没填：打开账号菜单的「Executor 设置…」填好再发` };
  }
  return { ready: true, reason: "" };
}

export function createExecutorConfigStore(options: ExecutorConfigOptions): ExecutorConfigStore {
  const keyStore = createTokenStore({
    filePath: options.keyPath,
    codec: options.codec,
    onError: (stage, error) => options.onError?.(`key:${stage}`, error),
  });

  const readFile = (): ExecutorSettingsFile => (existsSync(options.settingsPath) ? readExecutorSettingsFile(options.settingsPath) : {});

  function writeFile(next: ExecutorSettingsFile): void {
    try {
      mkdirSync(dirname(options.settingsPath), { recursive: true });
      const tempPath = `${options.settingsPath}.${process.pid}.tmp`;
      writeFileSync(tempPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      renameSync(tempPath, options.settingsPath);
    } catch (error) {
      options.onError?.("settings:write", error);
    }
  }

  return {
    view() {
      const file = readFile();
      const provider = file.provider ?? "";
      const modelId = file.modelId ?? "";
      const hasApiKey = keyStore.read() !== "";
      return { provider, modelId, hasApiKey, ...deriveReadiness(provider, modelId, hasApiKey) };
    },
    secrets() {
      const file = readFile();
      return { provider: file.provider ?? "", modelId: file.modelId ?? "", apiKey: keyStore.read() };
    },
    setModel(provider, modelId) {
      writeFile({ provider: provider.trim(), modelId: modelId.trim() });
    },
    setApiKey(apiKey) {
      return keyStore.write(apiKey.trim());
    },
  };
}
