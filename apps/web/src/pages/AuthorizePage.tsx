import { Match, Show, Switch, createSignal, onCleanup, onMount } from "solid-js";
import { CheckCircle2, LoaderCircle, ShieldCheck, ShieldX } from "lucide-solid";
import { create, encodeClientToServer, decodeServerToClient, ClientToServerSchema, type ClientToServerPayload } from "@coflux/protocol";

import { AuthMessage, AuthShell, CredentialsForm } from "@/components/auth/auth-shell";
import { Button } from "@/components/ui/button";
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
export function AuthorizePage(props: { token: string }) {
  let ws: WebSocket | null = null;
  const [state, setState] = createSignal<AuthorizeState>({ phase: "need-login" });
  const [username, setUsername] = createSignal("");
  const [password, setPassword] = createSignal("");

  const inPhase = <P extends AuthorizeState["phase"]>(phase: P) => {
    const current = state();
    return current.phase === phase ? (current as Extract<AuthorizeState, { phase: P }>) : undefined;
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
      setState((current) => (current.phase === "done" ? current : { phase: "failed", message: "连接已断开，请刷新页面重试" }));
    };
    socket.onmessage = (event) => {
      if (!(event.data instanceof ArrayBuffer)) return;
      const message = decodeServerToClient(new Uint8Array(event.data));
      if (!message) return;
      switch (message.payload.case) {
        case "authOk":
          setState({ phase: "looking-up" });
          send({ case: "deviceAuthorizeInfo", value: { token: props.token } });
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
  onMount(() => {
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

  function authorize() {
    setState({ phase: "authorizing" });
    send({ case: "deviceAuthorize", value: { token: props.token } });
  }

  const showLogin = () => state().phase === "need-login" || state().phase === "authenticating" || state().phase === "auth-failed";

  return (
    <AuthShell>
      <Show
        when={!showLogin()}
        fallback={
          <CredentialsForm
            title="授权新设备"
            description="先登录你的账号，再确认这台设备的信息"
            username={username()}
            password={password()}
            busy={state().phase === "authenticating"}
            error={inPhase("auth-failed")?.message}
            submitLabel="登录并继续"
            onUsernameChange={setUsername}
            onPasswordChange={setPassword}
            onSubmit={login}
          />
        }
      >
        <Switch>
          <Match when={inPhase("looking-up")}>
            <AuthMessage icon={<LoaderCircle class="size-5 animate-spin" />} title="正在核对授权链接" description="这通常只需要几秒钟。" />
          </Match>
          <Match when={inPhase("invalid")}>
            {(current) => <AuthMessage icon={<ShieldX class="size-5 text-destructive" />} title="授权链接不可用" description={current().message} />}
          </Match>
          <Match when={inPhase("confirm")}>
            {(current) => (
              <AuthMessage icon={<ShieldCheck class="size-5 text-primary" />} title="确认设备" description="允许以下设备接入你的账号和工作区。">
                <div class="rounded-lg border border-border bg-background px-4 py-3 text-left">
                  <div class="text-sm font-medium">{current().name || "未命名设备"}</div>
                  <div class="mt-1 font-mono text-[11px] text-muted-foreground">
                    {current().host || "未知主机"} · {current().platform || "未知平台"}
                  </div>
                </div>
                <Button class="mt-4 w-full" onClick={authorize}>
                  授权此设备
                </Button>
              </AuthMessage>
            )}
          </Match>
          <Match when={inPhase("authorizing")}>
            <AuthMessage icon={<LoaderCircle class="size-5 animate-spin" />} title="正在授权设备" description="请保持此页面打开。" />
          </Match>
          <Match when={inPhase("done")}>
            <AuthMessage icon={<CheckCircle2 class="size-5 text-success" />} title="设备已授权" description="设备已登记到你的账号，可以关闭此页面。" />
          </Match>
          <Match when={inPhase("failed")}>
            {(current) => <AuthMessage icon={<ShieldX class="size-5 text-destructive" />} title="授权未完成" description={current().message} />}
          </Match>
        </Switch>
      </Show>
    </AuthShell>
  );
}
