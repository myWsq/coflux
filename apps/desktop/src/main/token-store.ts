import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * 会话 token 的加密落盘（plan 106）：主进程用 Electron safeStorage（macOS 钥匙串派生密钥）加密后写
 * userData 下的独立文件，渲染层经桥接读写、不再把 token 落到任何明文存储。
 *
 * 失败态一律归一为「未登录」（read 返回空串）：加密不可用、文件缺失/损坏、解密失败——不崩、不回退
 * 明文落盘、不弹自定义对话框。ad-hoc 签名的 dev 包与 Developer ID 签名的安装版共用钥匙串项、切换时
 * 可能解密失败，也落在这条兜底上。
 */

/** safeStorage 的最小面，便于单测注入假件 */
export type TokenCodec = {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
};

export type TokenStoreStage = "read" | "write" | "clear";

export type TokenStore = {
  /** 失败态一律返回空串 = 未登录 */
  read(): string;
  /** 加密不可用时不落盘（不回退明文），返回 false；空串等同 clear */
  write(token: string): boolean;
  clear(): void;
};

export type TokenStoreOptions = {
  filePath: string;
  codec: TokenCodec;
  /** 失败只上报给日志，不影响返回值 */
  onError?: (stage: TokenStoreStage, error: unknown) => void;
};

export function createTokenStore(options: TokenStoreOptions): TokenStore {
  const { filePath, codec } = options;
  const report = (stage: TokenStoreStage, error: unknown) => options.onError?.(stage, error);

  function clear(): void {
    try {
      if (existsSync(filePath)) unlinkSync(filePath);
    } catch (error) {
      report("clear", error);
    }
  }

  return {
    read() {
      try {
        if (!existsSync(filePath)) return "";
        if (!codec.isEncryptionAvailable()) return "";
        const token = codec.decryptString(readFileSync(filePath));
        return typeof token === "string" ? token : "";
      } catch (error) {
        report("read", error);
        return "";
      }
    },
    write(token) {
      if (token === "") {
        clear();
        return true;
      }
      try {
        if (!codec.isEncryptionAvailable()) return false;
        const encrypted = codec.encryptString(token);
        mkdirSync(dirname(filePath), { recursive: true });
        // 先写临时文件再 rename：进程中途被杀不会留下半截密文
        const tempPath = `${filePath}.${process.pid}.tmp`;
        writeFileSync(tempPath, encrypted, { mode: 0o600 });
        renameSync(tempPath, filePath);
        return true;
      } catch (error) {
        report("write", error);
        return false;
      }
    },
    clear,
  };
}
