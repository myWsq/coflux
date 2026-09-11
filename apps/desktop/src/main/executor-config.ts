/**
 * executor 的全局配置与凭证（plan 116 M4）。
 *
 * 分成两半，因为两半的安全等级不同：
 *   - **非敏感项**（provider、模型 id）明文落 userData 下的 JSON，跟 `settings.json` 同级但独立成文件，
 *     免得把一个只认 `serverUrl` 的文件撑成杂物抽屉。
 *   - **API key** 走 `safeStorage` 加密落盘，复用 token-store 那套（先写临时文件再 rename，
 *     加密不可用就**不落盘**而不是回退明文）。
 *
 * 凭证的流向只有一条：safeStorage → 主进程内存 → 起 runner 那一刻的 start 消息。
 * 它不进 `settings.json`、不进工具进程的 env、不进转录、不进日志，也从不下发给渲染层——
 * 渲染层只知道「配没配」，不知道配的是什么。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { TokenCodec } from "./token-store";
import { createTokenStore } from "./token-store";

/** 渲染层能看到的配置形状——**没有 apiKey**，只有「配没配」。 */
export type ExecutorSettingsView = {
  provider: string;
  modelId: string;
  hasApiKey: boolean;
  /** 三项齐全才算 ready；executor 提交在 daemon 那一刻就按它拒 */
  ready: boolean;
  reason: string;
};

export type ExecutorSettingsFile = {
  provider?: string;
  modelId?: string;
};

/**
 * coflux 写死的 system prompt。**不由用户配、也不由发起方 agent 传**——executor 的人格与边界是产品的一部分，
 * 可配就意味着每个调用方都得重新想一遍，而且边界会被想漏。
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
  /** 起 runner 时才调；返回的对象含明文 key，用完即弃，不要缓存、不要日志 */
  secrets(): { provider: string; modelId: string; apiKey: string };
  setModel(provider: string, modelId: string): void;
  /** 空串 = 清除 */
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

/** 三项齐全才算 ready；理由是要原样透传给发起方 agent 的，写成它能照做的话。 */
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
