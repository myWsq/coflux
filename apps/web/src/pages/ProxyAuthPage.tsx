import { useEffect, useRef, useState } from "react";
import { ExternalLink, LoaderCircle, ShieldX } from "lucide-react";
import type { ClientToServer, ServerToClient } from "@coflux/protocol";

import { AuthMessage, AuthShell, CredentialsForm } from "@/components/auth/auth-shell";
import { SERVER_URL, TOKEN_KEY, USE_SUPABASE, type AuthCredential } from "@/config";
import { loginWithSupabase } from "@/lib/auth";

type ProxyAuthState =
  | { phase: "need-login" }
  | { phase: "authenticating" }
  | { phase: "auth-failed"; message: string }
  | { phase: "invalid" }
  | { phase: "issuing" }
  | { phase: "failed"; message: string };

/** 端口预览门禁页使用独立连接换一次性回调 URL，不订阅主应用状态。 */
export function ProxyAuthPage() {
  const wsRef = useRef<WebSocket | null>(null);
  const redirectTarget = new URLSearchParams(location.search).get("to");
  const [state, setState] = useState<ProxyAuthState>(redirectTarget ? { phase: "need-login" } : { phase: "invalid" });
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const send = (message: ClientToServer) => {
    const socket = wsRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  };

  function connect(credential: AuthCredential) {
    setState({ phase: "authenticating" });
    const socket = new WebSocket(SERVER_URL);
    wsRef.current = socket;
    socket.onopen = () => {
      if ("token" in credential) send({ type: "client.auth", clientToken: credential.token });
      else if ("supabaseToken" in credential) send({ type: "client.auth", supabaseToken: credential.supabaseToken });
      else send({ type: "client.auth", username: credential.username, password: credential.password });
    };
    socket.onclose = () => {
      setState((current) => (current.phase === "issuing" ? current : { phase: "failed", message: "连接已断开，请刷新页面重试" }));
    };
    socket.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      let message: ServerToClient;
      try {
        message = JSON.parse(event.data) as ServerToClient;
      } catch {
        return;
      }
      switch (message.type) {
        case "auth.ok":
          setState({ phase: "issuing" });
          send({ type: "proxy.issueAuth", redirect: redirectTarget! });
          break;
        case "auth.error":
          localStorage.removeItem(TOKEN_KEY);
          setState({
            phase: "auth-failed",
            message: USE_SUPABASE ? "登录失败：会话已过期或凭证无效，请重新登录" : "登录失败：用户名或密码错误",
          });
          break;
        case "proxy.auth":
          if (message.ok && message.url) location.href = message.url;
          else setState({ phase: "failed", message: message.error || "无法访问该预览链接" });
          break;
        default:
          break;
      }
    };
  }

  useEffect(() => {
    if (!redirectTarget) return;
    const savedToken = localStorage.getItem(TOKEN_KEY);
    if (savedToken) connect({ token: savedToken });
    return () => wsRef.current?.close();
    // 页面挂载时只消费一次既有登录态，后续状态由这条独立连接驱动。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function login(event: React.FormEvent) {
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

  const showLogin = state.phase === "need-login" || state.phase === "authenticating" || state.phase === "auth-failed";

  if (state.phase === "invalid") {
    return (
      <AuthShell>
        <AuthMessage icon={<ShieldX className="size-5 text-destructive" />} title="预览链接无效" description="链接缺少跳转目标，请从终端 Tab 的端口入口重新打开。" />
      </AuthShell>
    );
  }

  if (showLogin) {
    return (
      <AuthShell>
        <CredentialsForm
          title="访问端口预览"
          description="登录后将安全跳转到该工作区的预览页面"
          username={username}
          password={password}
          busy={state.phase === "authenticating"}
          error={state.phase === "auth-failed" ? state.message : undefined}
          submitLabel="登录并访问"
          onUsernameChange={setUsername}
          onPasswordChange={setPassword}
          onSubmit={login}
        />
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      {state.phase === "issuing" && (
        <AuthMessage icon={<LoaderCircle className="size-5 animate-spin" />} title="正在打开预览" description="正在签发一次性访问凭证并跳转。">
          <div className="flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground">
            <ExternalLink className="size-3" />
            即将离开 coflux 工作台
          </div>
        </AuthMessage>
      )}
      {state.phase === "failed" && (
        <AuthMessage icon={<ShieldX className="size-5 text-destructive" />} title="无法打开预览" description={state.message} />
      )}
    </AuthShell>
  );
}
