import { Match, Switch, createSignal, onCleanup, onMount } from "solid-js";
import { ExternalLink, LoaderCircle, ShieldX } from "lucide-solid";
import { create, encodeClientToServer, decodeServerToClient, ClientToServerSchema, type ClientToServerPayload } from "@coflux/protocol";

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
  let ws: WebSocket | null = null;
  const redirectTarget = new URLSearchParams(location.search).get("to");
  const [state, setState] = createSignal<ProxyAuthState>(redirectTarget ? { phase: "need-login" } : { phase: "invalid" });
  const [username, setUsername] = createSignal("");
  const [password, setPassword] = createSignal("");

  const inPhase = <P extends ProxyAuthState["phase"]>(phase: P) => {
    const current = state();
    return current.phase === phase ? (current as Extract<ProxyAuthState, { phase: P }>) : undefined;
  };

  const send = (payload: ClientToServerPayload) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(encodeClientToServer(create(ClientToServerSchema, { payload })));
  };

  function connect(credential: AuthCredential) {
    setState({ phase: "authenticating" });
    const socket = new WebSocket(SERVER_URL);
    socket.binaryType = "arraybuffer";
    ws = socket;
    socket.onopen = () => {
      if ("token" in credential) send({ case: "clientAuth", value: { clientToken: credential.token } });
      else if ("supabaseToken" in credential) send({ case: "clientAuth", value: { supabaseToken: credential.supabaseToken } });
      else send({ case: "clientAuth", value: { username: credential.username, password: credential.password } });
    };
    socket.onclose = () => {
      setState((current) => (current.phase === "issuing" ? current : { phase: "failed", message: "连接已断开，请刷新页面重试" }));
    };
    socket.onmessage = (event) => {
      if (!(event.data instanceof ArrayBuffer)) return;
      const message = decodeServerToClient(new Uint8Array(event.data));
      if (!message) return;
      switch (message.payload.case) {
        case "authOk":
          setState({ phase: "issuing" });
          send({ case: "proxyIssueAuth", value: { redirect: redirectTarget! } });
          break;
        case "authError":
          localStorage.removeItem(TOKEN_KEY);
          setState({
            phase: "auth-failed",
            message: USE_SUPABASE ? "登录失败：会话已过期或凭证无效，请重新登录" : "登录失败：用户名或密码错误",
          });
          break;
        case "proxyAuth": {
          const value = message.payload.value;
          if (value.ok && value.url) location.href = value.url;
          else setState({ phase: "failed", message: value.error || "无法访问该预览链接" });
          break;
        }
        default:
          break;
      }
    };
  }

  // 页面挂载时只消费一次既有登录态，后续状态由这条独立连接驱动。
  onMount(() => {
    if (!redirectTarget) return;
    const savedToken = localStorage.getItem(TOKEN_KEY);
    if (savedToken) connect({ token: savedToken });
  });
  onCleanup(() => ws?.close());

  async function login(event: SubmitEvent) {
    event.preventDefault();
    if (!USE_SUPABASE) {
      connect({ username: username(), password: password() });
      return;
    }
    setState({ phase: "authenticating" });
    const result = await loginWithSupabase(username(), password());
    if (!result.ok) {
      setState({ phase: "auth-failed", message: result.message });
      return;
    }
    connect({ supabaseToken: result.accessToken });
  }

  const showLogin = () => state().phase === "need-login" || state().phase === "authenticating" || state().phase === "auth-failed";

  return (
    <AuthShell>
      <Switch>
        <Match when={inPhase("invalid")}>
          <AuthMessage
            icon={<ShieldX class="size-5 text-destructive" />}
            title="预览链接无效"
            description="链接缺少跳转目标，请从终端 Tab 的端口入口重新打开。"
          />
        </Match>
        <Match when={showLogin()}>
          <CredentialsForm
            title="访问端口预览"
            description="登录后将安全跳转到该工作区的预览页面"
            username={username()}
            password={password()}
            busy={state().phase === "authenticating"}
            error={inPhase("auth-failed")?.message}
            submitLabel="登录并访问"
            onUsernameChange={setUsername}
            onPasswordChange={setPassword}
            onSubmit={login}
          />
        </Match>
        <Match when={inPhase("issuing")}>
          <AuthMessage icon={<LoaderCircle class="size-5 animate-spin" />} title="正在打开预览" description="正在签发一次性访问凭证并跳转。">
            <div class="flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground">
              <ExternalLink class="size-3" />
              即将离开 coflux 工作台
            </div>
          </AuthMessage>
        </Match>
        <Match when={inPhase("failed")}>
          {(current) => <AuthMessage icon={<ShieldX class="size-5 text-destructive" />} title="无法打开预览" description={current().message} />}
        </Match>
      </Switch>
    </AuthShell>
  );
}
