import { readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { create, ClientToServerSchema, CONTROL_PROTOCOL_VERSION, decodeServerToClient, encodeClientToServer, type ClientToServerPayload } from "@coflux/protocol";
import type { TokenStore } from "./token-store";

type Cleanup = { accountId: string; token: string; daemonId: string };
type AccountData = { accountId: string | null; credentials: Record<string, string>; pending: Cleanup[] };
export type AccountSnapshot = { accountId: string; daemonIds: string[] };

/** 窄用途控制连接：只读取归属，或清理指定本机的终端并撤销退出的会话。 */
export function accountControl(serverUrl: string, token: string, cleanup?: { daemonId: string; accountId: string; revoke: boolean }): Promise<AccountSnapshot> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(serverUrl);
    socket.binaryType = "arraybuffer";
    let accountId = "";
    let snapshot: AccountSnapshot | undefined;
    let finished = false;
    let logoutSent = false;
    const remaining = new Set<string>();
    const timer = setTimeout(() => finish(new Error("账号清理连接超时，已保留待重试记录")), 15000);
    function finish(error?: Error) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.close();
      if (error) reject(error); else if (snapshot) resolve(snapshot); else reject(new Error("账号快照缺失"));
    }
    const send = (payload: ClientToServerPayload) => socket.send(encodeClientToServer(create(ClientToServerSchema, { payload })));
    function completeCleanup() {
      if (remaining.size || !snapshot || logoutSent || finished) return;
      if (cleanup?.revoke) { logoutSent = true; send({ case: "clientLogout", value: {} }); }
      else finish();
    }
    socket.onopen = () => send({ case: "clientAuth", value: { clientToken: token, clientKind: "desktop", clientVersion: "desktop-lifecycle", controlProtocolVersion: CONTROL_PROTOCOL_VERSION } });
    socket.onerror = () => finish(new Error("账号服务器暂不可达"));
    socket.onclose = (event) => {
      if (logoutSent && event.code === 4001) finish();
      else if (!finished) finish(new Error("账号连接提前结束"));
    };
    socket.onmessage = (event) => {
      try {
        const decoded = decodeServerToClient(new Uint8Array(event.data as ArrayBuffer));
        if (!decoded) return finish(new Error("账号服务响应无效"));
        const payload = decoded.payload;
        if (payload.case === "authOk") {
          accountId = payload.value.accountId;
          if (cleanup?.accountId && cleanup.accountId !== accountId) return finish(new Error("账号归属不匹配，拒绝清理"));
          send({ case: "clientSubscribe", value: {} });
        } else if (payload.case === "stateSnapshot") {
          snapshot = { accountId, daemonIds: payload.value.daemons.map((d) => d.daemonId) };
          if (!cleanup) return finish();
          for (const task of payload.value.tasks) if (task.daemonId === cleanup.daemonId) remaining.add(task.id);
          for (const taskId of remaining) send({ case: "taskRemove", value: { taskId } });
          completeCleanup();
        } else if (payload.case === "taskRemoved") {
          remaining.delete(payload.value.taskId);
          completeCleanup();
        } else if (payload.case === "authError" || payload.case === "clientOutdated" || payload.case === "error") {
          finish(Object.assign(new Error("账号会话不可用，待重新登录后继续清理"), { code: payload.case === "authError" ? "invalid_session" : "request_failed" }));
        }
      } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    };
  });
}

/** 凭据与清理 outbox 统一加密保存；不写明文 token，不依赖退出时网络一定可用。 */
export function createDesktopAccount(home: string, serverUrl: string, store: TokenStore, control = accountControl) {
  let data: AccountData = { accountId: null, credentials: {}, pending: [] };
  const raw = store.read();
  if (raw) {
    const parsed = JSON.parse(raw) as AccountData;
    if (!parsed || !Array.isArray(parsed.pending) || typeof parsed.credentials !== "object" || parsed.credentials === null) throw new Error("本机账号记录损坏，拒绝自动接入");
    data = parsed;
  }
  const commit = (next: AccountData) => {
    if (!store.write(JSON.stringify(next))) throw new Error("无法安全保存本机账号状态，请检查系统钥匙串后重试");
    data = next;
  };
  const credentialPath = join(home, "credentials.json");
  let draining: Promise<void> | null = null;
  async function drain(replacement?: { accountId: string; token: string }) {
    if (draining) return draining;
    draining = (async () => {
      for (const item of [...data.pending]) {
        if (replacement && item.daemonId && item.accountId !== replacement.accountId) continue;
        try { await control(serverUrl, item.token, { ...item, revoke: true }); }
        catch (error) {
          if (!item.daemonId && (error as { code?: string }).code === "invalid_session") {
            // 未接入过设备的客户端会话已经失效，无本机记录需要清理。
          } else if (replacement && replacement.accountId === item.accountId) {
            await control(serverUrl, replacement.token, { ...item, revoke: false });
          } else { throw error; }
        }
        commit({ ...data, pending: data.pending.filter((pending) => pending !== item) });
      }
    })();
    try { await draining; } finally { draining = null; }
  }
  return {
    accountId: () => data.accountId,
    hasPending: () => data.pending.length > 0,
    drain,
    async connect(token: string): Promise<void> {
      const snapshot = await control(serverUrl, token);
      await drain({ accountId: snapshot.accountId, token });
      if (data.accountId && data.accountId !== snapshot.accountId) throw new Error("请先退出当前账号，再切换账号");
      // 老安装的设备必须确实属于当前账号，不能把其 deviceToken 带入另一账号。
      if (existsSync(credentialPath)) {
        const credentials = JSON.parse(readFileSync(credentialPath, "utf8")) as { daemonId?: string };
        if (!credentials.daemonId || !snapshot.daemonIds.includes(credentials.daemonId)) throw new Error("这台 Mac 仍关联其他账号，请先在原账号中退出登录");
      } else if (data.credentials[snapshot.accountId]) {
        writeFileSync(credentialPath, data.credentials[snapshot.accountId], { mode: 0o600 });
      }
      commit({ ...data, accountId: snapshot.accountId });
    },
    logout(token: string): void {
      // 未完成归属校验时，只撤销客户端会话，不能触碰旧安装的设备凭据。
      const accountId = data.accountId;
      const credentials = { ...data.credentials };
      let daemonId = "";
      if (accountId && existsSync(credentialPath)) {
        const credential = readFileSync(credentialPath, "utf8");
        daemonId = (JSON.parse(credential) as { daemonId: string }).daemonId;
        if (!daemonId) throw new Error("本机设备凭据无效，无法确认清理范围");
        credentials[accountId] = credential;
      }
      if (!daemonId && accountId && credentials[accountId]) {
        daemonId = (JSON.parse(credentials[accountId]) as { daemonId: string }).daemonId;
      }
      // 先持久化重试所需状态，清理成功后才提交退出；文件删除失败时再次退出仍能继续清理。
      const pending = token && !data.pending.some((item) => item.token === token && item.daemonId === daemonId)
        ? [...data.pending, { accountId: accountId ?? "", token, daemonId }]
        : data.pending;
      commit({ accountId, credentials, pending });
      if (accountId) {
        for (const name of ["credentials.json", "pending-auth.json", "local-gateway.json"]) rmSync(join(home, name), { force: true });
        rmSync(join(home, "terminal-data"), { recursive: true, force: true });
      }
      commit({ ...data, accountId: null });
    },
  };
}
