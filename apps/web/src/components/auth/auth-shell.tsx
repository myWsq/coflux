import type { FormEvent, ReactNode } from "react";
import { LoaderCircle, LockKeyhole, Network } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { USE_SUPABASE } from "@/config";

export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <main className="relative flex min-h-screen min-w-[1024px] items-center justify-center overflow-hidden bg-background px-8 py-12 text-foreground">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_50%_0%,rgba(255,255,255,0.04),transparent_55%)]" />
      <div className="relative w-full max-w-[390px]">
        <div className="mb-7 flex items-center justify-center">
          <span className="text-lg font-medium tracking-tight">coflux</span>
        </div>
        <div className="rounded-lg border border-border bg-card p-6">{children}</div>
        <div className="mt-5 flex items-center justify-center gap-1.5 text-[10px] text-muted-foreground/70">
          <Network className="size-3" />
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
  onSubmit: (event: FormEvent) => void;
};

export function CredentialsForm({
  title,
  description,
  username,
  password,
  busy,
  error,
  submitLabel = "登录",
  onUsernameChange,
  onPasswordChange,
  onSubmit,
}: CredentialsFormProps) {
  return (
    <form onSubmit={onSubmit}>
      <div className="mb-6 text-center">
        <div className="mx-auto mb-3 flex size-9 items-center justify-center rounded-full border border-border bg-muted text-muted-foreground">
          <LockKeyhole className="size-4" />
        </div>
        <h1 className="text-base font-semibold">{title}</h1>
        <p className="mt-1.5 text-xs leading-5 text-muted-foreground">{description}</p>
      </div>
      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="coflux-username">{USE_SUPABASE ? "邮箱" : "用户名"}</Label>
          <Input
            id="coflux-username"
            autoFocus
            type={USE_SUPABASE ? "email" : "text"}
            value={username}
            onChange={(event) => onUsernameChange(event.target.value)}
            placeholder={USE_SUPABASE ? "you@example.com" : "输入用户名"}
            autoComplete={USE_SUPABASE ? "email" : "username"}
            disabled={busy}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="coflux-password">密码</Label>
          <Input
            id="coflux-password"
            type="password"
            value={password}
            onChange={(event) => onPasswordChange(event.target.value)}
            placeholder="输入密码"
            autoComplete="current-password"
            disabled={busy}
          />
        </div>
      </div>
      {error && <div className="mt-4 rounded-md border border-destructive/25 bg-destructive/8 px-3 py-2 text-xs leading-5 text-destructive">{error}</div>}
      <Button className="mt-5 w-full" type="submit" disabled={busy || !username || !password}>
        {busy && <LoaderCircle className="animate-spin" />}
        {busy ? "连接中…" : submitLabel}
      </Button>
    </form>
  );
}

export function AuthMessage({ icon, title, description, children }: { icon: ReactNode; title: string; description?: string; children?: ReactNode }) {
  return (
    <div className="text-center">
      <div className="mx-auto mb-4 flex size-11 items-center justify-center rounded-full border border-border bg-muted text-muted-foreground">{icon}</div>
      <h1 className="text-base font-semibold">{title}</h1>
      {description && <p className="mt-2 text-xs leading-5 text-muted-foreground">{description}</p>}
      {children && <div className="mt-5">{children}</div>}
    </div>
  );
}
