import { Show, type JSX, type ParentProps } from "solid-js";
import { LoaderCircle, LockKeyhole, Network } from "lucide-solid";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { USE_SUPABASE } from "@/config";

export function AuthShell(props: ParentProps) {
  return (
    <main class="relative flex min-h-screen min-w-[1024px] items-center justify-center overflow-hidden bg-background px-8 py-12 text-foreground">
      <div class="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_50%_0%,rgba(255,255,255,0.04),transparent_55%)]" />
      <div class="relative w-full max-w-[390px]">
        <div class="mb-7 flex items-center justify-center">
          <span class="text-lg font-medium tracking-tight">coflux</span>
        </div>
        <div class="rounded-lg border border-border bg-card p-6">{props.children}</div>
        <div class="mt-5 flex items-center justify-center gap-1.5 text-[10px] text-muted-foreground/70">
          <Network class="size-3" />
          安全连接到你的远程工作区
        </div>
      </div>
    </main>
  );
}

type CredentialsFormProps = {
  title: string;
  description: string;
  username: string;
  password: string;
  busy: boolean;
  error?: string;
  submitLabel?: string;
  onUsernameChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onSubmit: (event: SubmitEvent) => void;
};

export function CredentialsForm(props: CredentialsFormProps) {
  return (
    <form onSubmit={(event) => props.onSubmit(event)}>
      <div class="mb-6 text-center">
        <div class="mx-auto mb-3 flex size-9 items-center justify-center rounded-full border border-border bg-muted text-muted-foreground">
          <LockKeyhole class="size-4" />
        </div>
        <h1 class="text-base font-semibold">{props.title}</h1>
        <p class="mt-1.5 text-xs leading-5 text-muted-foreground">{props.description}</p>
      </div>
      <div class="space-y-4">
        <div class="space-y-1.5">
          <Label for="coflux-username">{USE_SUPABASE ? "邮箱" : "用户名"}</Label>
          <Input
            id="coflux-username"
            autofocus
            type={USE_SUPABASE ? "email" : "text"}
            value={props.username}
            onInput={(event) => props.onUsernameChange(event.currentTarget.value)}
            placeholder={USE_SUPABASE ? "you@example.com" : "输入用户名"}
            autocomplete={USE_SUPABASE ? "email" : "username"}
            disabled={props.busy}
          />
        </div>
        <div class="space-y-1.5">
          <Label for="coflux-password">密码</Label>
          <Input
            id="coflux-password"
            type="password"
            value={props.password}
            onInput={(event) => props.onPasswordChange(event.currentTarget.value)}
            placeholder="输入密码"
            autocomplete="current-password"
            disabled={props.busy}
          />
        </div>
      </div>
      <Show when={props.error}>
        <div class="mt-4 rounded-md border border-destructive/25 bg-destructive/8 px-3 py-2 text-xs leading-5 text-destructive">{props.error}</div>
      </Show>
      <Button class="mt-5 w-full" type="submit" disabled={props.busy || !props.username || !props.password}>
        <Show when={props.busy}>
          <LoaderCircle class="animate-spin" />
        </Show>
        {props.busy ? "连接中…" : props.submitLabel ?? "登录"}
      </Button>
    </form>
  );
}

type AuthMessageProps = ParentProps<{
  icon: JSX.Element;
  title: string;
  description?: string;
}>;

export function AuthMessage(props: AuthMessageProps) {
  return (
    <div class="text-center">
      <div class="mx-auto mb-4 flex size-11 items-center justify-center rounded-full border border-border bg-muted text-muted-foreground">{props.icon}</div>
      <h1 class="text-base font-semibold">{props.title}</h1>
      <Show when={props.description}>
        <p class="mt-2 text-xs leading-5 text-muted-foreground">{props.description}</p>
      </Show>
      <Show when={props.children}>
        <div class="mt-5">{props.children}</div>
      </Show>
    </div>
  );
}
