import type { TokenStorage } from "@coflux/client";

import type { DesktopBridge } from "@/desktop-bridge";

/**
 * 会话 token 的渲染层一侧（plan 106）：真相在主进程的 safeStorage 加密文件，渲染层启动时经桥接异步
 * 取回一次、之后只在内存里持有当前值，登录成功 / 登出 / 认证失败时把变化转发回主进程。
 * 首次启动做一次性迁移：旧版把 token 明文放在 localStorage（key `coflux_token`）——safeStorage 为空
 * 且旧值还在就迁入，无论是否迁入都把旧值删掉，渲染层从此不再落任何明文 token。
 */

export type InitialTokenDecision = {
  token: string;
  /** 旧值要写进 safeStorage */
  migrateLegacy: boolean;
  /** 旧值要从 localStorage 删除（只要还在就删，不管是否迁入） */
  clearLegacy: boolean;
};

export function resolveInitialToken(stored: string, legacy: string | null | undefined): InitialTokenDecision {
  const legacyToken = legacy ?? "";
  if (stored !== "") return { token: stored, migrateLegacy: false, clearLegacy: legacyToken !== "" };
  if (legacyToken !== "") return { token: legacyToken, migrateLegacy: true, clearLegacy: true };
  return { token: "", migrateLegacy: false, clearLegacy: false };
}

type SessionTokenBridge = Pick<DesktopBridge, "getSessionToken" | "setSessionToken" | "clearSessionToken">;
type LegacyTokenStorage = Pick<Storage, "getItem" | "removeItem">;

/** 启动时取回 token 并完成迁移；桥接取回失败（IPC 异常）按未登录处理。 */
export async function loadSessionToken(bridge: SessionTokenBridge, legacyStorage: LegacyTokenStorage, legacyKey: string): Promise<string> {
  const stored = await bridge.getSessionToken().catch(() => "");
  let legacy: string | null = null;
  try {
    legacy = legacyStorage.getItem(legacyKey);
  } catch {
    /* storage 不可用：没有可迁移的旧值 */
  }
  const decision = resolveInitialToken(typeof stored === "string" ? stored : "", legacy);
  if (decision.migrateLegacy) bridge.setSessionToken(decision.token);
  if (decision.clearLegacy) {
    try {
      legacyStorage.removeItem(legacyKey);
    } catch {
      /* 删不掉旧值不影响本次登录态 */
    }
  }
  return decision.token;
}

/** 给 createCofluxClient 的存储接口：同步读内存里的当前值，写/清转发给主进程。 */
export function createBridgeTokenStorage(bridge: SessionTokenBridge, initialToken: string): TokenStorage {
  let current = initialToken;
  return {
    read: () => current,
    write: (token) => {
      current = token;
      bridge.setSessionToken(token);
    },
    clear: () => {
      current = "";
      bridge.clearSessionToken();
    },
  };
}
