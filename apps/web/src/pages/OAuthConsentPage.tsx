import { useEffect, useRef, useState, type FormEvent } from "react";
import { CheckCircle2, KeyRound, LoaderCircle, ShieldX } from "lucide-react";
import { create, encodeClientToServer, decodeServerToClient, ClientToServerSchema, type ClientToServerPayload } from "@coflux/protocol";

import { AuthMessage, AuthShell, CredentialsForm } from "@/components/auth/auth-shell";
import { Button } from "@astryxdesign/core/Button";
import { BUILD_ID, SERVER_URL, TOKEN_KEY, type AuthCredential } from "@/config";

type ConsentState =
  | { phase: "need-login" }
  | { phase: "authenticating" }
  | { phase: "auth-failed"; message: string }
  | { phase: "looking-up" }
  | { phase: "invalid"; message: string }
  | { phase: "confirm"; clientName: string; redirectHost: string; scope: string }
  | { phase: "deciding"; approve: boolean }
  | { phase: "redirecting"; approve: boolean }
  | { phase: "failed"; message: string };

/** OAuth 确认页（plan 090）：MCP 宿主（Claude Code / Codex）经 /oauth/authorize 落到这里，用已登录账号
 * 确认一次；照 AuthorizePage 的范式——独立组件树 + 独立 WS 连接，不触发主工作台订阅与终端副作用。
 * 确认/拒绝都由 server 回完整的回调 URL，页面只负责 location.assign 跳回宿主。 */
export function OAuthConsentPage({ requestId }: { requestId: string }) {
  const wsRef = useRef<WebSocket | null>(null);
  const [state, setState] = useState<ConsentState>(requestId ? { phase: "need-login" } : { phase: "invalid", message: "链接缺少授权请求 id，请回到宿主重新发起授权" });
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  function inPhase<P extends ConsentState["phase"]>(phase: P): Extract<ConsentState, { phase: P }> | undefined {
    return state.phase === phase ? (state as Extract<ConsentState, { phase: P }>) : undefined;
  }

  function send(payload: ClientToServerPayload) {
    if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(encodeClientToServer(create(ClientToServerSchema, { payload })));
  }

  function connect(credential: AuthCredential) {
    setState({ phase: "authenticating" });
    const socket = new WebSocket(SERVER_URL);
    socket.binaryType = "arraybuffer";
    wsRef.current = socket;
    socket.onopen = () => {
      // clientVersion 必带：本页是独立于主 store 的旁路连接，版本准入（plan 033）同样适用——
      // 漏掉会被 server 当旧 bundle 拒掉（AuthorizePage 记着 2026-07-24 的生产事故）。
      if ("token" in credential) send({ case: "clientAuth", value: { clientToken: credential.token, clientVersion: BUILD_ID } });
      else send({ case: "clientAuth", value: { username: credential.username, password: credential.password, clientVersion: BUILD_ID } });
    };
    socket.onclose = () => {
      setState((current) => (current.phase === "redirecting" ? current : { phase: "failed", message: "连接已断开，请刷新页面重试" }));
    };
    socket.onmessage = (event) => {
      if (!(event.data instanceof ArrayBuffer)) return;
      const message = decodeServerToClient(new Uint8Array(event.data));
      if (!message) return;
      switch (message.payload.case) {
        case "authOk":
          setState({ phase: "looking-up" });
          send({ case: "oauthAuthorizeInfo", value: { requestId } });
          break;
        case "authError":
          localStorage.removeItem(TOKEN_KEY);
          setState({ phase: "auth-failed", message: "登录失败：用户名或密码错误" });
          break;
        case "oauthAuthorizeInfo": {
          const value = message.payload.value;
          if (value.ok) setState({ phase: "confirm", clientName: value.clientName || "未命名客户端", redirectHost: value.redirectHost || "", scope: value.scope || "" });
          else setState({ phase: "invalid", message: value.error || "授权请求无效或已过期" });
          break;
        }
        case "oauthAuthorizeResult": {
          const value = message.payload.value;
          if (value.ok && value.redirectUrl) {
            setState((current) => ({ phase: "redirecting", approve: current.phase === "deciding" ? current.approve : true }));
            location.assign(value.redirectUrl);
          } else {
            setState({ phase: "failed", message: value.error || "授权未完成，请回到宿主重新发起授权" });
          }
          break;
        }
        default:
          break;
      }
    };
  }

  // 页面挂载时只消费一次既有登录态，后续状态由这条独立连接驱动。
  useEffect(() => {
    if (!requestId) return;
    const savedToken = localStorage.getItem(TOKEN_KEY);
    if (savedToken) connect({ token: savedToken });
    return () => wsRef.current?.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    connect({ username, password });
  }

  function decide(approve: boolean) {
    setState({ phase: "deciding", approve });
    send({ case: "oauthAuthorizeDecide", value: { requestId, approve } });
  }

  const showLogin = state.phase === "need-login" || state.phase === "authenticating" || state.phase === "auth-failed";

  return (
    <AuthShell>
      {showLogin ? (
        <CredentialsForm
          title="授权应用访问"
          description="先登录你的账号，再决定是否允许该应用访问"
          username={username}
          password={password}
          busy={state.phase === "authenticating"}
          error={inPhase("auth-failed")?.message}
          submitLabel="登录并继续"
          onUsernameChange={setUsername}
          onPasswordChange={setPassword}
          onSubmit={login}
        />
      ) : (
        <>
          {inPhase("looking-up") ? (
            <AuthMessage icon={<LoaderCircle className="size-5 animate-spin" />} title="正在核对授权请求" description="这通常只需要几秒钟。" />
          ) : null}
          {(() => {
            const invalid = inPhase("invalid");
            return invalid ? (
              <AuthMessage icon={<ShieldX className="size-5 text-destructive" />} title="授权请求不可用" description={invalid.message} />
            ) : null;
          })()}
          {(() => {
            const confirm = inPhase("confirm");
            return confirm ? (
              <AuthMessage icon={<KeyRound className="size-5 text-primary" />} title={`${confirm.clientName} 请求访问你的 coflux 账号`} description="允许后，该应用可以查看你账号下的设备、项目、工作区与终端内容。">
                <div className="rounded-lg border border-border bg-background px-4 py-3 text-left">
                  <div className="text-sm font-medium">{confirm.clientName}</div>
                  <div className="mt-1 font-mono text-xs text-muted-foreground">授权完成后跳回 {confirm.redirectHost || "应用"}</div>
                  {confirm.scope ? <div className="mt-1 font-mono text-xs text-muted-foreground">scope: {confirm.scope}</div> : null}
                </div>
                <Button className="mt-4 w-full" label="允许访问" variant="primary" onClick={() => decide(true)} />
                <Button className="mt-2 w-full" label="拒绝" variant="secondary" onClick={() => decide(false)} />
              </AuthMessage>
            ) : null;
          })()}
          {(() => {
            const deciding = inPhase("deciding");
            return deciding ? (
              <AuthMessage icon={<LoaderCircle className="size-5 animate-spin" />} title={deciding.approve ? "正在签发授权" : "正在拒绝授权"} description="请保持此页面打开。" />
            ) : null;
          })()}
          {(() => {
            const redirecting = inPhase("redirecting");
            return redirecting ? (
              <AuthMessage
                icon={<CheckCircle2 className="size-5 text-success" />}
                title={redirecting.approve ? "已授权" : "已拒绝"}
                description="正在跳回应用；若浏览器没有自动跳转，可以关闭此页面回到应用。"
              />
            ) : null;
          })()}
          {(() => {
            const failed = inPhase("failed");
            return failed ? (
              <AuthMessage icon={<ShieldX className="size-5 text-destructive" />} title="授权未完成" description={failed.message} />
            ) : null;
          })()}
        </>
      )}
    </AuthShell>
  );
}
