import { useEffect, useRef, useState } from "react";
import type { ClientToServer, ServerToClient } from "@coflux/protocol";

import { SERVER_URL, TOKEN_KEY, USE_SUPABASE, type AuthCredential } from "@/config";
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
      setState((current) => (current.phase === "done" ? current : { phase: "failed", message: "连接已断开，请刷新页面重试" }));
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
          setState({ phase: "looking-up" });
          send({ type: "device.authorizeInfo", token });
          break;
        case "auth.error":
          localStorage.removeItem(TOKEN_KEY);
          setState({
            phase: "auth-failed",
            message: USE_SUPABASE ? "登录失败：会话已过期或凭证无效，请重新登录" : "登录失败：用户名或密码错误",
          });
          break;
        case "device.authorizeInfo":
          if (message.ok) setState({ phase: "confirm", name: message.name, host: message.host, platform: message.platform });
          else setState({ phase: "invalid", message: message.error || "授权链接无效或已过期" });
          break;
        case "device.authorized":
          setState({ phase: "done" });
          break;
        default:
          break;
      }
    };
  }

  useEffect(() => {
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

  function authorize() {
    setState({ phase: "authorizing" });
    send({ type: "device.authorize", token });
  }

  const showLogin = state.phase === "need-login" || state.phase === "authenticating" || state.phase === "auth-failed";

  return (
    <div className="app">
      <div className="login">
        {showLogin ? (
          <form className="login-card" onSubmit={login}>
            <div className="brand-lg">coflux</div>
            <p className="login-hint">授权新设备 —— 请先登录你的账号</p>
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
            {state.phase === "looking-up" && <p className="login-hint">正在核对授权链接…</p>}
            {state.phase === "invalid" && <p className="login-status err">{state.message}</p>}
            {state.phase === "confirm" && (
              <>
                <p className="login-hint">授权以下设备接入你的账号：</p>
                <p>
                  <b>{state.name || "（未命名设备）"}</b>
                  <br />
                  {state.host} · {state.platform}
                </p>
                <button onClick={authorize}>授权此设备</button>
              </>
            )}
            {state.phase === "authorizing" && <p className="login-hint">正在授权…</p>}
            {state.phase === "done" && <p className="login-status">✓ 授权成功，设备已登记。可以关闭此页面了。</p>}
            {state.phase === "failed" && <p className="login-status err">{state.message}</p>}
          </div>
        )}
      </div>
    </div>
  );
}
