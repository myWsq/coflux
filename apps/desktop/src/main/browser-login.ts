/**
 * Browser sign-in for the desktop app (plan 20260923-oauth-login-redesign): RFC 8252 loopback redirect
 * with PKCE (S256), entirely in the main process.
 *
 *   1. listen on 127.0.0.1:<ephemeral>          (only the main process can)
 *   2. POST /api/client/login/request            (port + code_challenge + state + host name)
 *   3. open the system browser on the returned /login/<id> page (embedded webviews are refused by Google)
 *   4. the page redirects to http://127.0.0.1:<port>/callback?code=…&state=… after 「允许登录」
 *   5. POST /api/client/login/exchange with code + code_verifier → ck_sess
 *
 * The verifier never leaves this module; the renderer only learns the outcome. Nothing here reads a
 * redirect target from the browser: the listener answers only on its own port and path and checks the
 * state it generated.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type { DesktopBrowserLoginResult, DesktopLoginOptions, DesktopLoginProvider } from "../shared/desktop-bridge";

const REQUEST_TIMEOUT_MS = 20_000;
/** Fallback when the server does not say how long the request lives. */
const DEFAULT_WAIT_MS = 10 * 60_000;
const PROVIDERS: readonly DesktopLoginProvider[] = ["github", "google"];

export type BrowserLoginOptions = {
  /** The control WebSocket URL the app is configured with (wss://…/client). */
  serverUrl: string;
  /** Reported to the server and shown on the confirmation card as "reported by the requester". */
  hostname: string;
  openExternal: (url: string) => void;
  /** Stores the freshly issued token through the same path the renderer's setSessionToken uses. */
  storeToken: (token: string) => void;
  /** Brings the window to the front once the login succeeded. */
  focusApp: () => void;
  fetchImpl?: typeof fetch;
  log?: (message: string, detail?: unknown) => void;
};

export type BrowserLogin = {
  getOptions(): Promise<DesktopLoginOptions>;
  start(provider: DesktopLoginProvider | ""): Promise<DesktopBrowserLoginResult>;
  /** Open the browser on the pending request's page again (the user closed the tab). */
  reopen(): void;
  cancel(): void;
  dispose(): void;
};

/** The HTTP origin that serves `/api/client/*` for a configured control WebSocket URL. */
export function apiOrigin(serverUrl: string): string {
  const url = new URL(serverUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : url.protocol === "ws:" ? "http:" : url.protocol;
  return url.origin;
}

export function isLoginProvider(value: unknown): value is DesktopLoginProvider {
  return typeof value === "string" && (PROVIDERS as readonly string[]).includes(value);
}

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier, "ascii").digest("base64url") };
}

const FAILURE_MESSAGES: Record<Exclude<DesktopBrowserLoginResult, { ok: true }>["reason"], string> = {
  not_allowed: "该邮箱未开通 Coflux",
  not_verified: "该账号的邮箱未经验证，无法登录",
  cancelled: "已取消登录",
  timeout: "登录超时，请重试",
  network: "连不上 Coflux 服务器，请检查网络后重试",
  failed: "登录未完成，请重试",
};

function failure(reason: Exclude<DesktopBrowserLoginResult, { ok: true }>["reason"], message?: string): DesktopBrowserLoginResult {
  return { ok: false, reason, message: message || FAILURE_MESSAGES[reason] };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch);
}

function page(rawTitle: string, rawBody: string): string {
  const title = escapeHtml(rawTitle);
  const body = escapeHtml(rawBody);
  return (
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${title} · Coflux</title><style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;` +
    `font:15px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;background:Canvas;color:CanvasText}` +
    `main{text-align:center;padding:24px}h1{font-size:18px;margin:0 0 8px}p{margin:0;opacity:.7}</style></head>` +
    `<body><main><h1>${title}</h1><p>${body}</p></main></body></html>`
  );
}

type Pending = {
  server: Server;
  url: string;
  settle: (result: DesktopBrowserLoginResult) => void;
};

export function createBrowserLogin(options: BrowserLoginOptions): BrowserLogin {
  const call = options.fetchImpl ?? fetch;
  const origin = apiOrigin(options.serverUrl);
  let pending: Pending | null = null;

  async function post(path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await call(`${origin}${path}`, {
      method: "POST",
      redirect: "error",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const parsed = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: response.status, body: parsed ?? {} };
  }

  function listen(): Promise<Server> {
    return new Promise((resolve, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve(server);
      });
    });
  }

  return {
    async getOptions() {
      try {
        const response = await call(`${origin}/api/client/auth-config`, { redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
        const body = (await response.json()) as { ok?: boolean; value?: { providers?: unknown } };
        const providers = Array.isArray(body?.value?.providers) ? body.value.providers.filter(isLoginProvider) : [];
        return { providers };
      } catch {
        // An older server has no auth-config: the password form alone is the honest answer.
        return { providers: [] };
      }
    },

    async start(provider) {
      if (pending) pending.settle(failure("cancelled"));
      let server: Server;
      try {
        server = await listen();
      } catch (error) {
        options.log?.("browser login could not listen on loopback", String(error));
        return failure("failed", "无法在本机启动登录回调，请重试");
      }
      const port = (server.address() as AddressInfo).port;
      const { verifier, challenge } = pkcePair();
      const state = randomBytes(24).toString("base64url");

      return new Promise<DesktopBrowserLoginResult>((resolve) => {
        let done = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const settle = (result: DesktopBrowserLoginResult) => {
          if (done) return;
          done = true;
          if (timer) clearTimeout(timer);
          if (pending?.server === server) pending = null;
          server.close();
          // Let the answer to the browser flush before dropping any keep-alive socket.
          setTimeout(() => server.closeAllConnections?.(), 1_000).unref?.();
          resolve(result);
        };
        const entry: Pending = { server, url: "", settle };
        pending = entry;

        server.on("request", (request: IncomingMessage, response: ServerResponse) => {
          const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
          const respond = (status: number, title: string, body: string) => {
            response.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
            response.end(page(title, body));
          };
          if (request.method !== "GET" || url.pathname !== "/callback" || url.searchParams.get("state") !== state) {
            respond(404, "页面不存在", "这个地址只用于 Coflux 登录回调。");
            return;
          }
          const error = url.searchParams.get("error");
          if (error) {
            const reason = error === "not_allowed" || error === "not_verified" || error === "cancelled" ? error : "failed";
            respond(200, "登录未完成", `${FAILURE_MESSAGES[reason]}。可以关闭此页面，回到 Coflux。`);
            settle(failure(reason));
            return;
          }
          const code = url.searchParams.get("code") ?? "";
          // The browser tab says what actually happened, so it answers only after the exchange.
          void (async () => {
            let result: DesktopBrowserLoginResult;
            try {
              const exchanged = await post("/api/client/login/exchange", { protocolVersion: 1, code, codeVerifier: verifier });
              const value = exchanged.body.value as { token?: unknown; login?: unknown } | undefined;
              if (exchanged.body.ok !== true || typeof value?.token !== "string" || !value.token) {
                result = failure("failed", typeof exchanged.body.error === "string" ? exchanged.body.error : undefined);
              } else {
                options.storeToken(value.token);
                result = { ok: true, login: typeof value.login === "string" ? value.login : "" };
              }
            } catch {
              result = failure("network");
            }
            if (result.ok) respond(200, "已登录", "已登录，可以回到 Coflux。");
            else respond(200, "登录未完成", `${result.message}。可以关闭此页面，回到 Coflux。`);
            settle(result);
            if (result.ok) options.focusApp();
          })();
        });

        void (async () => {
          let registered: { status: number; body: Record<string, unknown> };
          try {
            registered = await post("/api/client/login/request", {
              protocolVersion: 1,
              clientKind: "desktop",
              host: options.hostname.slice(0, 253) || "Mac",
              redirect: "loopback",
              port,
              codeChallenge: challenge,
              codeChallengeMethod: "S256",
              state,
            });
          } catch {
            settle(failure("network"));
            return;
          }
          const value = registered.body.value as { url?: unknown; expiresAt?: unknown } | undefined;
          if (registered.body.ok !== true || typeof value?.url !== "string") {
            settle(failure("failed", typeof registered.body.error === "string" ? registered.body.error : undefined));
            return;
          }
          if (done) return;
          const target = new URL(value.url);
          // The page URL must live on the configured server; never open anything else it might name.
          if (target.origin !== origin) {
            settle(failure("failed"));
            return;
          }
          if (provider && isLoginProvider(provider)) target.searchParams.set("provider", provider);
          entry.url = target.toString();
          const expiresAt = typeof value.expiresAt === "number" ? value.expiresAt : Date.now() + DEFAULT_WAIT_MS;
          timer = setTimeout(() => settle(failure("timeout")), Math.max(1_000, expiresAt - Date.now()));
          options.openExternal(entry.url);
        })();
      });
    },

    reopen() {
      if (pending?.url) options.openExternal(pending.url);
    },

    cancel() {
      pending?.settle(failure("cancelled"));
    },

    dispose() {
      pending?.settle(failure("cancelled"));
    },
  };
}
