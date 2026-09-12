import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  createExecutorConfigStore,
  deriveReadiness,
  EXECUTOR_SYSTEM_PROMPT,
  readExecutorSettingsFile,
} from "./executor-config";
import type { TokenCodec } from "./token-store";

/** A workable fake codec: a prefix standing in for encryption, enough to prove nothing lands on
 * disk in the clear. */
function fakeCodec(available = true): TokenCodec {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain) => Buffer.from(`enc:${plain}`),
    decryptString: (buf) => buf.toString().replace(/^enc:/, ""),
  };
}

function store(codec: TokenCodec = fakeCodec()) {
  const dir = mkdtempSync(join(tmpdir(), "coflux-execcfg-"));
  return {
    dir,
    settingsPath: join(dir, "executor.json"),
    keyPath: join(dir, "executor-key"),
    make: () =>
      createExecutorConfigStore({ settingsPath: join(dir, "executor.json"), keyPath: join(dir, "executor-key"), codec }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("三项齐全才 ready，缺哪项理由就说哪项且告诉用户去哪配", () => {
  assert.equal(deriveReadiness("", "", false).ready, false);
  assert.match(deriveReadiness("", "", false).reason, /provider 与模型/);
  assert.match(deriveReadiness("anthropic", "", true).reason, /provider 与模型/);
  const noKey = deriveReadiness("anthropic", "claude-x", false);
  assert.equal(noKey.ready, false);
  assert.match(noKey.reason, /anthropic 的 API key/);
  assert.deepEqual(deriveReadiness("anthropic", "claude-x", true), { ready: true, reason: "" });
});

test("每条 reason 都指向账号菜单里的那个入口", () => {
  for (const reason of [deriveReadiness("", "", false).reason, deriveReadiness("a", "b", false).reason]) {
    assert.match(reason, /Executor 设置/);
  }
});

test("空配置下 view 不炸，ready 为假", () => {
  const s = store();
  try {
    const view = s.make().view();
    assert.deepEqual(
      { provider: view.provider, modelId: view.modelId, hasApiKey: view.hasApiKey, ready: view.ready },
      { provider: "", modelId: "", hasApiKey: false, ready: false },
    );
  } finally {
    s.cleanup();
  }
});

test("配齐之后 ready，且 view 里没有 apiKey 字段", () => {
  const s = store();
  try {
    const cfg = s.make();
    cfg.setModel("anthropic", "claude-x");
    assert.equal(cfg.setApiKey("sk-secret"), true);
    const view = cfg.view();
    assert.equal(view.ready, true);
    assert.equal(view.hasApiKey, true);
    assert.equal(JSON.stringify(view).includes("sk-secret"), false);
  } finally {
    s.cleanup();
  }
});

test("API key 不出现在明文设置文件里", () => {
  const s = store();
  try {
    const cfg = s.make();
    cfg.setModel("anthropic", "claude-x");
    cfg.setApiKey("sk-secret");
    const raw = readExecutorSettingsFile(s.settingsPath);
    assert.deepEqual(raw, { provider: "anthropic", modelId: "claude-x" });
  } finally {
    s.cleanup();
  }
});

test("secrets() 才给明文 key，且能取回写进去的值", () => {
  const s = store();
  try {
    const cfg = s.make();
    cfg.setModel("openai", "gpt-x");
    cfg.setApiKey("sk-abc");
    assert.deepEqual(cfg.secrets(), { provider: "openai", modelId: "gpt-x", apiKey: "sk-abc" });
  } finally {
    s.cleanup();
  }
});

test("加密不可用时不落盘、不回退明文，ready 保持为假", () => {
  const s = store(fakeCodec(false));
  try {
    const cfg = s.make();
    cfg.setModel("anthropic", "claude-x");
    assert.equal(cfg.setApiKey("sk-secret"), false);
    assert.equal(cfg.view().hasApiKey, false);
    assert.equal(cfg.view().ready, false);
  } finally {
    s.cleanup();
  }
});

test("空串清除 key", () => {
  const s = store();
  try {
    const cfg = s.make();
    cfg.setModel("anthropic", "claude-x");
    cfg.setApiKey("sk-secret");
    cfg.setApiKey("");
    assert.equal(cfg.view().hasApiKey, false);
  } finally {
    s.cleanup();
  }
});

test("provider / model 两端空白被 trim", () => {
  const s = store();
  try {
    const cfg = s.make();
    cfg.setModel("  anthropic  ", "  claude-x  ");
    assert.deepEqual(readExecutorSettingsFile(s.settingsPath), { provider: "anthropic", modelId: "claude-x" });
  } finally {
    s.cleanup();
  }
});

test("设置文件损坏时按空配置处理，不抛", () => {
  const s = store();
  try {
    writeFileSync(s.settingsPath, "{ not json");
    assert.deepEqual(readExecutorSettingsFile(s.settingsPath), {});
    assert.equal(s.make().view().ready, false);
  } finally {
    s.cleanup();
  }
});

test("system prompt 把三条硬边界都写给了模型", () => {
  assert.match(EXECUTOR_SYSTEM_PROMPT, /only modify files inside the workspace/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /Git metadata is read-only/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /no network access/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /absolute paths/);
});
