import { useEffect, useRef, useState } from "react";
import type { ClientToServer, ServerToClient } from "@coflux/protocol";

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

  return (
    <div className="app">
      <div className="login">
        {state.phase === "invalid" ? (
          <div className="login-card">
            <div className="brand-lg">coflux</div>
            <p className="login-status err">链接无效：缺少跳转目标</p>
          </div>
        ) : showLogin ? (
          <form className="login-card" onSubmit={login}>
            <div className="brand-lg">coflux</div>
            <p className="login-hint">访问预览链接 —— 请先登录你的账号</p>
            <input
              autoFocus
              type={USE_SUPABASE ? "email" : "text"}
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder={USE_SUPABASE ? "邮箱" : "用户名"}
              autoComplete={USE_SUPABASE ? "email" : "username"}
            />
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="密码"
              autoComplete="current-password"
            />
            <button type="submit">登录</button>
            {state.phase === "authenticating" && <div className="login-status">连接中…</div>}
            {state.phase === "auth-failed" && <div className="login-status err">{state.message}</div>}
          </form>
        ) : (
          <div className="login-card">
            <div className="brand-lg">coflux</div>
            {state.phase === "issuing" && <p className="login-hint">正在跳转到预览页…</p>}
            {state.phase === "failed" && <p className="login-status err">{state.message}</p>}
          </div>
        )}
      </div>
    </div>
  );
}
