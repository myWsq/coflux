import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createTokenStore, type TokenCodec, type TokenStoreStage } from "./token-store";

// 假 safeStorage：可切换「加密可用」，密文 = 前缀 + 明文反转，足以证明文件里没有明文。
function fakeCodec(available = true): TokenCodec & { available: boolean } {
  const codec = {
    available,
    isEncryptionAvailable: () => codec.available,
    encryptString: (plain: string) => Buffer.from(`enc:${[...plain].reverse().join("")}`),
    decryptString: (encrypted: Buffer) => {
      const text = encrypted.toString();
      if (!text.startsWith("enc:")) throw new Error("bad ciphertext");
      return [...text.slice(4)].reverse().join("");
    },
  };
  return codec;
}

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "coflux-token-store-"));
  try {
    run(dir);
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

test("没有文件：read 返回空串（未登录），不报错", () => {
  withTempDir((dir) => {
    const errors: TokenStoreStage[] = [];
    const store = createTokenStore({ filePath: join(dir, "session-token.bin"), codec: fakeCodec(), onError: (stage) => errors.push(stage) });
    assert.equal(store.read(), "");
    assert.deepEqual(errors, []);
  });
});

test("write 后 read 回原值；文件里是密文而不是明文", () => {
  withTempDir((dir) => {
    const filePath = join(dir, "nested", "session-token.bin");
    const store = createTokenStore({ filePath, codec: fakeCodec() });
    assert.equal(store.write("tok-secret-123"), true);
    assert.equal(store.read(), "tok-secret-123");
    const onDisk = readFileSync(filePath).toString();
    assert.ok(!onDisk.includes("tok-secret-123"), "落盘内容不得含明文 token");
    assert.ok(!existsSync(`${filePath}.${process.pid}.tmp`), "临时文件应已 rename 掉");
  });
});

test("加密不可用：write 不落盘也不回退明文（返回 false）；已有文件也按未登录读", () => {
  withTempDir((dir) => {
    const filePath = join(dir, "session-token.bin");
    const codec = fakeCodec(false);
    const store = createTokenStore({ filePath, codec });
    assert.equal(store.write("tok"), false);
    assert.equal(existsSync(filePath), false);

    // 之前加密可用时写过、现在不可用（例如签名身份切换）：不尝试解密，直接未登录
    codec.available = true;
    assert.equal(store.write("tok"), true);
    codec.available = false;
    assert.equal(store.read(), "");
  });
});

test("文件损坏 / 解密失败：read 归一为空串并上报 read 阶段错误", () => {
  withTempDir((dir) => {
    const filePath = join(dir, "session-token.bin");
    writeFileSync(filePath, "garbage");
    const errors: TokenStoreStage[] = [];
    const store = createTokenStore({ filePath, codec: fakeCodec(), onError: (stage) => errors.push(stage) });
    assert.equal(store.read(), "");
    assert.deepEqual(errors, ["read"]);
  });
});

test("clear 删除文件；重复 clear 与空串 write 都等价于清除且不抛", () => {
  withTempDir((dir) => {
    const filePath = join(dir, "session-token.bin");
    const store = createTokenStore({ filePath, codec: fakeCodec() });
    store.write("tok");
    assert.equal(existsSync(filePath), true);
    store.clear();
    assert.equal(existsSync(filePath), false);
    store.clear();
    store.write("tok");
    assert.equal(store.write(""), true);
    assert.equal(existsSync(filePath), false);
    assert.equal(store.read(), "");
  });
});
