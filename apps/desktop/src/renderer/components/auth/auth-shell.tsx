import { useEffect, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import { LoaderCircle } from "lucide-react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Center } from "@astryxdesign/core/Center";
import { Divider } from "@astryxdesign/core/Divider";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Heading, Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";

import type { DesktopBridge, DesktopBrowserLoginResult, DesktopLoginProvider } from "@/desktop-bridge";

// 独立认证页自绘 body 背景（无宿主壳）。Plan 20260923: centred column, no card — the same layout as the
// server-rendered /authorize, /proxy-auth and /login pages.
const pageStyle: CSSProperties = {
  minHeight: "100%",
  backgroundColor: "var(--color-background-body)",
  padding: "var(--spacing-6)",
};
const contentStyle: CSSProperties = {
  width: "100%",
  maxWidth: 360,
};

/** Host of the configured server and the app version, for the footer: "api.coflux.dev · v2.4.0". */
export function authFooterText(serverUrl: string, version: string): string {
  let host = "";
  try {
    host = new URL(serverUrl).host;
  } catch {
    host = "";
  }
  return [host, version ? `v${version}` : ""].filter(Boolean).join(" · ");
}

export function AuthShell({ children, tagline, footer }: { children: ReactNode; tagline?: string; footer?: string }) {
  return (
    <Center axis="both" style={pageStyle}>
      <VStack gap={6} hAlign="stretch" style={contentStyle}>
        <VStack gap={2} hAlign="center">
          <HStack gap={2} vAlign="center">
            <img src="/favicon.svg" alt="" width={28} height={28} style={{ borderRadius: "var(--radius-md, 6px)" }} />
            <Text type="large" weight="bold" size="xl">
              Coflux
            </Text>
          </HStack>
          <Text type="body" color="secondary" size="sm" justify="center">
            {tagline ?? "登录以连接你的工作区"}
          </Text>
        </VStack>
        {children}
        {footer ? (
          <Text type="supporting" size="xsm" justify="center" display="block">
            {footer}
          </Text>
        ) : null}
      </VStack>
    </Center>
  );
}

function GitHubMark() {
  return (
    <svg viewBox="0 0 16 16" width={16} height={16} aria-hidden="true" fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

function GoogleMark() {
  return (
    <svg viewBox="0 0 48 48" width={16} height={16} aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

const PROVIDER_VIEW: Record<DesktopLoginProvider, { label: string; icon: ReactNode }> = {
  github: { label: "使用 GitHub 继续", icon: <GitHubMark /> },
  google: { label: "使用 Google 继续", icon: <GoogleMark /> },
};

type CredentialsFormProps = {
  username: string;
  password: string;
  busy: boolean;
  error?: string;
  submitLabel?: string;
  /** "邮箱" in password mode; the server decides, so the form just shows what it is given. */
  usernameLabel?: string;
  /** The form is secondary when provider buttons sit above it. */
  secondary?: boolean;
  onUsernameChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
};

export function CredentialsForm(props: CredentialsFormProps) {
  return (
    <form onSubmit={props.onSubmit}>
      <VStack gap={3} hAlign="stretch">
        {props.error ? <Banner status="error" title={props.error} container="card" /> : null}
        <TextInput
          label={props.usernameLabel ?? "邮箱"}
          type="text"
          value={props.username}
          onChange={(value) => props.onUsernameChange(value)}
          placeholder="you@example.com"
          htmlName="username"
          hasAutoFocus={!props.secondary}
          isDisabled={props.busy}
        />
        <TextInput
          label="密码"
          type="password"
          value={props.password}
          onChange={(value) => props.onPasswordChange(value)}
          placeholder="输入密码"
          htmlName="password"
          isDisabled={props.busy}
        />
        <Button
          label={props.busy ? "连接中…" : (props.submitLabel ?? "登录")}
          variant={props.secondary ? "secondary" : "primary"}
          type="submit"
          width="100%"
          isLoading={props.busy}
          isDisabled={props.busy || !props.username || !props.password}
        />
      </VStack>
    </form>
  );
}

type LoginScreenProps = {
  bridge: Pick<DesktopBridge, "getLoginOptions" | "startBrowserLogin" | "reopenBrowserLogin" | "cancelBrowserLogin" | "serverUrl" | "version">;
  username: string;
  password: string;
  /** Error from the password path (the WebSocket's own reason). */
  passwordError?: string;
  onUsernameChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  /** A browser sign-in finished: the main process has stored the token; connect with it. */
  onBrowserLogin: () => void;
};

type BrowserState = { phase: "idle" } | { phase: "waiting"; provider: DesktopLoginProvider };

/**
 * The login screen (plan 20260923): provider buttons first (only those the server enabled), then the
 * email form below an "或" divider. A provider opens the system browser and the screen switches to a
 * waiting state with 「重新打开浏览器」 and 「取消」; failures come back as one of the fixed banners.
 */
export function LoginScreen(props: LoginScreenProps) {
  const { bridge } = props;
  const [providers, setProviders] = useState<DesktopLoginProvider[]>([]);
  const [browser, setBrowser] = useState<BrowserState>({ phase: "idle" });
  const [browserError, setBrowserError] = useState<string>("");

  useEffect(() => {
    let alive = true;
    void bridge
      .getLoginOptions()
      .then((options) => {
        if (alive) setProviders(options.providers);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [bridge]);

  async function startProvider(provider: DesktopLoginProvider) {
    setBrowserError("");
    setBrowser({ phase: "waiting", provider });
    let result: DesktopBrowserLoginResult;
    try {
      result = await bridge.startBrowserLogin(provider);
    } catch {
      result = { ok: false, reason: "failed", message: "登录未完成，请重试" };
    }
    setBrowser({ phase: "idle" });
    if (result.ok) {
      props.onBrowserLogin();
      return;
    }
    setBrowserError(result.message);
  }

  const footer = authFooterText(bridge.serverUrl, bridge.version);

  if (browser.phase === "waiting") {
    return (
      <AuthShell footer={footer} tagline="在浏览器中完成登录…">
        <VStack gap={4} hAlign="center">
          <LoaderCircle className="size-5 animate-spin text-primary" />
          <Text type="body" color="secondary" size="sm" justify="center">
            已在系统浏览器中打开 {browser.provider === "github" ? "GitHub" : "Google"} 登录，完成后会自动回到 Coflux。
          </Text>
        </VStack>
        <VStack gap={2} hAlign="stretch">
          <Button label="重新打开浏览器" variant="secondary" width="100%" onClick={() => bridge.reopenBrowserLogin()} />
          <Button label="取消" variant="ghost" width="100%" onClick={() => bridge.cancelBrowserLogin()} />
        </VStack>
      </AuthShell>
    );
  }

  const error = browserError || props.passwordError;
  return (
    <AuthShell footer={footer}>
      {providers.length > 0 ? (
        <VStack gap={3} hAlign="stretch">
          {browserError ? <Banner status="error" title={browserError} container="card" /> : null}
          {providers.map((provider) => (
            <Button
              key={provider}
              label={PROVIDER_VIEW[provider].label}
              icon={PROVIDER_VIEW[provider].icon}
              variant="primary"
              size="lg"
              width="100%"
              onClick={() => void startProvider(provider)}
            />
          ))}
          <Divider label="或" />
        </VStack>
      ) : null}
      <CredentialsForm
        username={props.username}
        password={props.password}
        busy={false}
        error={providers.length > 0 ? props.passwordError : error}
        submitLabel={providers.length > 0 ? "用邮箱登录" : "登录"}
        secondary={providers.length > 0}
        onUsernameChange={props.onUsernameChange}
        onPasswordChange={props.onPasswordChange}
        onSubmit={props.onSubmit}
      />
    </AuthShell>
  );
}

type AuthMessageProps = {
  icon: ReactNode;
  title: string;
  description?: string;
  children?: ReactNode;
};

export function AuthMessage(props: AuthMessageProps) {
  return (
    <VStack gap={2} hAlign="center">
      {props.icon}
      <Heading level={2}>{props.title}</Heading>
      {props.description ? (
        <Text type="body" color="secondary" size="sm">
          {props.description}
        </Text>
      ) : null}
      {props.children ? <VStack gap={0} hAlign="stretch">{props.children}</VStack> : null}
    </VStack>
  );
}
