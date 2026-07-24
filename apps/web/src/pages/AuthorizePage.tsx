import { useEffect, useRef, useState, type FormEvent } from "react";
import { CheckCircle2, LoaderCircle, ShieldCheck, ShieldX } from "lucide-react";
import { create, encodeClientToServer, decodeServerToClient, ClientToServerSchema, type ClientToServerPayload } from "@coflux/protocol";

import { AuthMessage, AuthShell, CredentialsForm } from "@/components/auth/auth-shell";
import { Button } from "@astryxdesign/core/Button";
import { BUILD_ID, SERVER_URL, TOKEN_KEY, USE_SUPABASE, type AuthCredential } from "@/config";
import { loginWithSupabase } from "@/lib/auth";

type AuthorizeState =
  | { phase: "need-login" }
  | { phase: "authenticating" }
  | { phase: "auth-failed"; message: string }
  | { phase: "looking-up" }
  | { phase: "invalid"; message: string }
  | { phase: "confirm"; name?: string; host?: string; platform?: string }
  | { phase: "authorizing" }
  | { phase: "done" }
  | { phase: "failed"; message: string };

/** 设备授权页保持独立组件树与独立连接，避免触发主工作台订阅和终端副作用。 */
export function AuthorizePage({ token }: { token: string }) {
  const wsRef = useRef<WebSocket | null>(null);
  const [state, setState] = useState<AuthorizeState>({ phase: "need-login" });
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  function inPhase<P extends AuthorizeState["phase"]>(phase: P): Extract<AuthorizeState, { phase: P }> | undefined {
    return state.phase === phase ? (state as Extract<AuthorizeState, { phase: P }>) : undefined;
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
      // 漏掉会被 server 当旧 bundle 拒掉（2026-07-24 生产事故）。
      if ("token" in credential) send({ case: "clientAuth", value: { clientToken: credential.token, clientVersion: BUILD_ID } });
      else if ("supabaseToken" in credential) send({ case: "clientAuth", value: { supabaseToken: credential.supabaseToken, clientVersion: BUILD_ID } });
      else send({ case: "clientAuth", value: { username: credential.username, password: credential.password, clientVersion: BUILD_ID } });
    };
    socket.onclose = () => {
      setState((current) => (current.phase === "done" ? current : { phase: "failed", message: "连接已断开，请刷新页面重试" }));
    };
    socket.onmessage = (event) => {
      if (!(event.data instanceof ArrayBuffer)) return;
      const message = decodeServerToClient(new Uint8Array(event.data));
      if (!message) return;
      switch (message.payload.case) {
        case "authOk":
          setState({ phase: "looking-up" });
          send({ case: "deviceAuthorizeInfo", value: { token } });
          break;
        case "authError":
          localStorage.removeItem(TOKEN_KEY);
          setState({
            phase: "auth-failed",
            message: USE_SUPABASE ? "登录失败：会话已过期或凭证无效，请重新登录" : "登录失败：用户名或密码错误",
          });
          break;
        case "deviceAuthorizeInfo": {
          const value = message.payload.value;
          if (value.ok) setState({ phase: "confirm", name: value.name, host: value.host, platform: value.platform });
          else setState({ phase: "invalid", message: value.error || "授权链接无效或已过期" });
          break;
        }
        case "deviceAuthorized":
          setState({ phase: "done" });
          break;
        default:
          break;
      }
    };
  }

  // 页面挂载时只消费一次既有登录态，后续状态由这条独立连接驱动。
  useEffect(() => {
    const savedToken = localStorage.getItem(TOKEN_KEY);
    if (savedToken) connect({ token: savedToken });
    return () => wsRef.current?.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!USE_SUPABASE) {
      connect({ username, password });
      return;
    }
    setState({ phase: "authenticating" });
    const result = await loginWithSupabase(username, password);
    if (!result.ok) {
      setState({ phase: "auth-failed", message: result.message });
      return;
    }
    connect({ supabaseToken: result.accessToken });
  }

  function authorize() {
    setState({ phase: "authorizing" });
    send({ case: "deviceAuthorize", value: { token } });
  }

  const showLogin = state.phase === "need-login" || state.phase === "authenticating" || state.phase === "auth-failed";

  return (
    <AuthShell>
      {showLogin ? (
        <CredentialsForm
          title="授权新设备"
          description="先登录你的账号，再确认这台设备的信息"
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
            <AuthMessage icon={<LoaderCircle className="size-5 animate-spin" />} title="正在核对授权链接" description="这通常只需要几秒钟。" />
          ) : null}
          {(() => {
            const invalid = inPhase("invalid");
            return invalid ? (
              <AuthMessage icon={<ShieldX className="size-5 text-destructive" />} title="授权链接不可用" description={invalid.message} />
            ) : null;
          })()}
          {(() => {
            const confirm = inPhase("confirm");
            return confirm ? (
              <AuthMessage icon={<ShieldCheck className="size-5 text-primary" />} title="确认设备" description="允许以下设备接入你的账号和工作区。">
                <div className="rounded-lg border border-border bg-background px-4 py-3 text-left">
                  <div className="text-sm font-medium">{confirm.name || "未命名设备"}</div>
                  <div className="mt-1 font-mono text-xs text-muted-foreground">
                    {confirm.host || "未知主机"} · {confirm.platform || "未知平台"}
                  </div>
                </div>
                <Button className="mt-4 w-full" label="授权此设备" variant="primary" onClick={authorize} />
              </AuthMessage>
            ) : null;
          })()}
          {inPhase("authorizing") ? (
            <AuthMessage icon={<LoaderCircle className="size-5 animate-spin" />} title="正在授权设备" description="请保持此页面打开。" />
          ) : null}
          {inPhase("done") ? (
            <AuthMessage icon={<CheckCircle2 className="size-5 text-success" />} title="设备已授权" description="设备已登记到你的账号，可以关闭此页面。" />
          ) : null}
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
