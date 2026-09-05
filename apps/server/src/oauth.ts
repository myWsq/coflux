/**
 * MCP 宿主的 OAuth 2.1 授权服务器（plan 090）。中心同时是资源服务器（`/mcp`）与授权服务器：
 * PRM / AS 元数据、动态客户端注册（DCR，公共客户端）、授权码 + PKCE(S256)、refresh 轮换。
 *
 * 状态分两层：
 * - 持久化（store）：DCR 客户端、access/refresh token（只存 sha256 hash）。
 * - 内存（本类）：authorize → 确认页之间的待确认请求、签出的授权码、已兑现授权码的短期指纹
 *   （二次使用即整链撤销）。与设备授权 pendingAuthorizations 同款——中心单实例，重启只是让宿主
 *   重来一次授权（见 docs/auth-design.md「状态只在内存里」）。
 *
 * 所有失败路径都构造 OAuth 格式的 Response（`{ error, error_description }`），绝不 throw——Raven 的
 * 错误信封 OAuth 客户端读不懂。URL 全部由 config.publicUrl 拼，不看请求 Host。
 */
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createLogger } from "@coflux/core";
import type { AccountId } from "@coflux/protocol";
import { config } from "./config.js";
import { genToken, hashToken } from "./secrets.js";
import type { OAuthClientRecord, Store } from "./store.js";

const log = createLogger("server");

/** 授权码 TTL：签发到宿主换 token 之间的窗口，OAuth 2.1 建议 ≤10 分钟。 */
const AUTH_CODE_TTL_MS = 5 * 60_000;
/** 已兑现授权码的指纹保留期：窗口内二次使用 → 整链撤销（RFC 6749 §4.1.2 / OAuth 2.1）。 */
const CONSUMED_CODE_TTL_MS = AUTH_CODE_TTL_MS;
const MAX_OAUTH_CLIENTS = 4096;
const MAX_CLIENT_NAME_CHARS = 200;
const MAX_REDIRECT_URIS = 16;
const MAX_REDIRECT_URI_CHARS = 2048;
const MAX_SCOPE_CHARS = 256;
const MAX_STATE_CHARS = 2048;
const MAX_FORM_FIELD_CHARS = 4096;
const SUPPORTED_GRANT_TYPES = ["authorization_code", "refresh_token"] as const;
const DEFAULT_CLIENT_NAME = "未命名客户端";

/** 由 bearer 解析出的调用者身份；tool 实现只拿它，不拿 Request。 */
export interface OAuthPrincipal {
  accountId: AccountId;
  userId: string | null;
  clientId: string;
  scope: string;
  expiresAt: number;
}

interface PendingAuthorizationRequest {
  id: string;
  clientId: string;
  clientName: string;
  redirectUri: string;
  state: string | null;
  scope: string;
  codeChallenge: string;
  createdAt: number;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
}

interface IssuedAuthorizationCode {
  code: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  codeChallenge: string;
  accountId: AccountId;
  userId: string | null;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
}

interface ConsumedAuthorizationCode {
  grantId: string;
  timer: ReturnType<typeof setTimeout>;
}

/** OAuth 错误应答：token/register 端点统一形状，禁止缓存。 */
export function oauthErrorResponse(status: number, error: string, description: string, extraHeaders: Record<string, string> = {}): Response {
  return Response.json({ error, error_description: description }, { status, headers: { "Cache-Control": "no-store", Pragma: "no-cache", ...extraHeaders } });
}

function jsonNoStore(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", Pragma: "no-cache" } });
}

function isLoopbackUrl(url: URL): boolean {
  if (url.protocol !== "http:") return false;
  const host = url.hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}

/** 注册时允许的 redirect_uri：https、loopback http（任意端口/路径）、或原生应用私有 scheme。 */
function acceptableRegisteredRedirect(raw: string): URL | undefined {
  if (raw.length > MAX_REDIRECT_URI_CHARS) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.hash || url.username || url.password) return undefined;
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:") return isLoopbackUrl(url) ? url : undefined;
  if (url.protocol === "javascript:" || url.protocol === "data:" || url.protocol === "file:" || url.protocol === "ws:" || url.protocol === "wss:") return undefined;
  return url;
}

function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  if (value.length > max) return undefined;
  // 控制字符会污染 JSON/HTML 展示面；OAuth 参数本就应是可打印文本。
  if (/[\u0000-\u001f\u007f]/.test(value)) return undefined;
  return value;
}

/** PKCE S256：sha256(verifier) 的 base64url 与 challenge 定长比较。 */
function verifyPkce(codeVerifier: string, codeChallenge: string): boolean {
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(codeVerifier)) return false;
  const expected = Buffer.from(createHash("sha256").update(codeVerifier).digest("base64url"));
  const actual = Buffer.from(codeChallenge);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function appendQuery(redirectUri: string, params: Record<string, string | null | undefined>): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
}

export class OAuthService {
  private readonly pending = new Map<string, PendingAuthorizationRequest>();
  private readonly codes = new Map<string, IssuedAuthorizationCode>();
  private readonly consumedCodes = new Map<string, ConsumedAuthorizationCode>();
  /** DCR 全局固定窗口限速（无来源 IP 可用：Raven 上下文里没有 peer 地址；按全局兜底）。 */
  private registerWindow = { startedAt: 0, count: 0 };
  private closed = false;

  constructor(private readonly store: Store) {}

  get issuer(): string {
    return config.publicUrl;
  }
  /** `/mcp` 的资源标识（RFC 8707 resource）。 */
  get resource(): string {
    return `${config.publicUrl}/mcp`;
  }
  /** 401 挑战里 resource_metadata 指向的 PRM 文档地址（RFC 9728 路径后缀形式）。 */
  get resourceMetadataUrl(): string {
    return `${config.publicUrl}/.well-known/oauth-protected-resource/mcp`;
  }
  get consentUrlBase(): string {
    return `${config.webUrl}/oauth/consent`;
  }

  /* ------------------------------ 元数据 ------------------------------ */

  protectedResourceMetadata(): Record<string, unknown> {
    return {
      resource: this.resource,
      authorization_servers: [this.issuer],
      bearer_methods_supported: ["header"],
      resource_name: "coflux",
    };
  }

  authorizationServerMetadata(): Record<string, unknown> {
    return {
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}/oauth/authorize`,
      token_endpoint: `${this.issuer}/oauth/token`,
      registration_endpoint: `${this.issuer}/oauth/register`,
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: [...SUPPORTED_GRANT_TYPES],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      authorization_response_iss_parameter_supported: true,
    };
  }

  /* ------------------------------ DCR ------------------------------ */

  /** RFC 7591 动态注册：只签发公共客户端（token_endpoint_auth_method=none）。 */
  async registerClient(body: unknown): Promise<Response> {
    const now = Date.now();
    if (now - this.registerWindow.startedAt >= config.authRateWindowMs) this.registerWindow = { startedAt: now, count: 0 };
    this.registerWindow.count += 1;
    if (this.registerWindow.count > config.oauthRegisterRateLimit) {
      return oauthErrorResponse(429, "temporarily_unavailable", "客户端注册过于频繁，请稍后重试");
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return oauthErrorResponse(400, "invalid_client_metadata", "注册请求体必须是 JSON 对象");
    }
    const meta = body as Record<string, unknown>;

    const rawUris = meta.redirect_uris;
    if (!Array.isArray(rawUris) || rawUris.length === 0 || rawUris.length > MAX_REDIRECT_URIS) {
      return oauthErrorResponse(400, "invalid_redirect_uri", "redirect_uris 必须是非空数组");
    }
    const redirectUris: string[] = [];
    for (const raw of rawUris) {
      const url = typeof raw === "string" ? acceptableRegisteredRedirect(raw) : undefined;
      if (!url) return oauthErrorResponse(400, "invalid_redirect_uri", "redirect_uris 只接受 https、loopback http 或原生应用私有 scheme");
      redirectUris.push(raw as string);
    }

    const authMethod = meta.token_endpoint_auth_method ?? "none";
    if (authMethod !== "none") {
      return oauthErrorResponse(400, "invalid_client_metadata", "仅支持公共客户端（token_endpoint_auth_method=none）");
    }
    const grantTypes = meta.grant_types === undefined ? ["authorization_code", "refresh_token"] : meta.grant_types;
    if (!Array.isArray(grantTypes) || grantTypes.length === 0 || !grantTypes.every((g) => (SUPPORTED_GRANT_TYPES as readonly string[]).includes(g as string))) {
      return oauthErrorResponse(400, "invalid_client_metadata", "grant_types 只支持 authorization_code / refresh_token");
    }
    if (!grantTypes.includes("authorization_code")) {
      return oauthErrorResponse(400, "invalid_client_metadata", "grant_types 必须包含 authorization_code");
    }
    const responseTypes = meta.response_types === undefined ? ["code"] : meta.response_types;
    if (!Array.isArray(responseTypes) || responseTypes.some((r) => r !== "code")) {
      return oauthErrorResponse(400, "invalid_client_metadata", "response_types 只支持 code");
    }
    const clientNameRaw = meta.client_name === undefined ? DEFAULT_CLIENT_NAME : boundedText(meta.client_name, MAX_CLIENT_NAME_CHARS);
    if (clientNameRaw === undefined) return oauthErrorResponse(400, "invalid_client_metadata", "client_name 过长或含控制字符");
    const clientName = clientNameRaw.trim() || DEFAULT_CLIENT_NAME;
    const scope = meta.scope === undefined ? "" : boundedText(meta.scope, MAX_SCOPE_CHARS);
    if (scope === undefined) return oauthErrorResponse(400, "invalid_client_metadata", "scope 过长或含控制字符");

    if ((await this.store.countOAuthClients()) >= MAX_OAUTH_CLIENTS) {
      log.warn("oauth 客户端数达到上限", { limit: MAX_OAUTH_CLIENTS });
      return oauthErrorResponse(429, "temporarily_unavailable", "客户端数已达上限");
    }

    const clientId = genToken("cf_oc");
    const response: Record<string, unknown> = {
      client_id: clientId,
      client_id_issued_at: Math.floor(now / 1000),
      client_name: clientName,
      redirect_uris: redirectUris,
      grant_types: grantTypes,
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...(scope ? { scope } : {}),
    };
    await this.store.createOAuthClient({
      clientId,
      clientName,
      redirectUris,
      grantTypes: grantTypes as string[],
      tokenEndpointAuthMethod: "none",
      metadata: JSON.stringify(response),
      createdAt: now,
      lastUsedAt: null,
    });
    log.info("oauth 客户端已注册", { clientId, clientName });
    return jsonNoStore(201, response);
  }

  /* ------------------------------ authorize ------------------------------ */

  /** 校验 redirect_uri：loopback 允许任意端口与路径（RFC 8252，Claude Code 每次随机端口回调）；
   * 非 loopback 必须与注册值精确相等。 */
  private resolveRedirectUri(client: OAuthClientRecord, requested: string | null): string | undefined {
    if (requested === null) return client.redirectUris.length === 1 ? client.redirectUris[0] : undefined;
    if (requested.length > MAX_REDIRECT_URI_CHARS) return undefined;
    if (client.redirectUris.includes(requested)) return requested;
    let url: URL;
    try {
      url = new URL(requested);
    } catch {
      return undefined;
    }
    if (url.hash || url.username || url.password) return undefined;
    if (!isLoopbackUrl(url)) return undefined;
    const registeredLoopback = client.redirectUris.some((uri) => {
      try {
        return isLoopbackUrl(new URL(uri));
      } catch {
        return false;
      }
    });
    return registeredLoopback ? requested : undefined;
  }

  /** GET /oauth/authorize：校验后记内存待确认请求，302 到 web 确认页。client_id / redirect_uri
   * 不合法时直接 400（不能往未经校验的地址跳）；其余参数错误按 OAuth 规范带 error 跳回宿主。 */
  async beginAuthorization(query: URLSearchParams): Promise<Response> {
    const clientId = boundedText(query.get("client_id") ?? undefined, MAX_FORM_FIELD_CHARS);
    if (!clientId) return oauthErrorResponse(400, "invalid_request", "缺少 client_id");
    const client = await this.store.getOAuthClient(clientId);
    if (!client) return oauthErrorResponse(400, "invalid_client", "client_id 未注册");
    const redirectUri = this.resolveRedirectUri(client, query.get("redirect_uri"));
    if (!redirectUri) return oauthErrorResponse(400, "invalid_request", "redirect_uri 未注册或不合法");

    const state = query.get("state");
    if (state !== null && boundedText(state, MAX_STATE_CHARS) === undefined) {
      return oauthErrorResponse(400, "invalid_request", "state 过长或含控制字符");
    }
    const redirectError = (error: string, description: string): Response => {
      const location = appendQuery(redirectUri, { error, error_description: description, state, iss: this.issuer });
      return new Response(null, { status: 302, headers: { Location: location, "Cache-Control": "no-store" } });
    };

    if (query.get("response_type") !== "code") return redirectError("unsupported_response_type", "只支持 response_type=code");
    const codeChallenge = query.get("code_challenge");
    if (!codeChallenge || !/^[A-Za-z0-9\-_]{43}$/.test(codeChallenge)) return redirectError("invalid_request", "缺少或非法的 code_challenge（必须 PKCE S256）");
    if (query.get("code_challenge_method") !== "S256") return redirectError("invalid_request", "code_challenge_method 只支持 S256");
    const scope = boundedText(query.get("scope") ?? "", MAX_SCOPE_CHARS);
    if (scope === undefined) return redirectError("invalid_scope", "scope 过长或含控制字符");
    const resource = query.get("resource");
    if (resource !== null && resource !== this.resource) return redirectError("invalid_target", `resource 只能是 ${this.resource}`);
    if (this.closed) return redirectError("temporarily_unavailable", "服务正在关闭");
    if (this.pending.size >= config.maxPendingAuthorizations) {
      log.warn("oauth 待确认请求达到上限", { limit: config.maxPendingAuthorizations });
      return redirectError("temporarily_unavailable", "待确认的授权请求过多，请稍后重试");
    }

    const now = Date.now();
    const id = genToken("cf_oreq");
    const timer = setTimeout(() => this.pending.delete(id), config.authorizeTtlMs);
    timer.unref();
    this.pending.set(id, {
      id,
      clientId: client.clientId,
      clientName: client.clientName,
      redirectUri,
      state,
      scope,
      codeChallenge,
      createdAt: now,
      expiresAt: now + config.authorizeTtlMs,
      timer,
    });
    const location = `${this.consentUrlBase}?request=${encodeURIComponent(id)}`;
    return new Response(null, { status: 302, headers: { Location: location, "Cache-Control": "no-store" } });
  }

  /** 确认页查询：不消费。未命中不区分"过期"与"从未存在"。 */
  describePending(requestId: string): { clientName: string; redirectHost: string; scope: string } | undefined {
    const p = this.pending.get(requestId);
    if (!p || p.expiresAt <= Date.now()) return undefined;
    let redirectHost: string;
    try {
      const url = new URL(p.redirectUri);
      redirectHost = url.host || url.protocol.replace(/:$/, "");
    } catch {
      redirectHost = p.redirectUri;
    }
    return { clientName: p.clientName, redirectHost, scope: p.scope };
  }

  /** 确认页决定：一次性摘除待确认请求；同意则签授权码，拒绝则回调带 access_denied。
   * 返回完整的 redirect URL（含原 state 与 iss），页面直接跳转。 */
  decide(requestId: string, approve: boolean, identity: { accountId: AccountId; userId: string | null }): { redirectUrl: string } | undefined {
    const p = this.pending.get(requestId);
    if (!p) return undefined;
    this.pending.delete(requestId);
    clearTimeout(p.timer);
    if (p.expiresAt <= Date.now()) return undefined;

    if (!approve) {
      log.info("oauth 授权被拒绝", { clientId: p.clientId });
      return { redirectUrl: appendQuery(p.redirectUri, { error: "access_denied", error_description: "用户拒绝了授权", state: p.state, iss: this.issuer }) };
    }
    if (this.codes.size >= config.maxPendingAuthorizations) {
      log.warn("oauth 待兑现授权码达到上限", { limit: config.maxPendingAuthorizations });
      return { redirectUrl: appendQuery(p.redirectUri, { error: "temporarily_unavailable", error_description: "待兑现的授权码过多，请稍后重试", state: p.state, iss: this.issuer }) };
    }
    const code = genToken("cf_oac");
    const timer = setTimeout(() => this.codes.delete(code), AUTH_CODE_TTL_MS);
    timer.unref();
    this.codes.set(code, {
      code,
      clientId: p.clientId,
      redirectUri: p.redirectUri,
      scope: p.scope,
      codeChallenge: p.codeChallenge,
      accountId: identity.accountId,
      userId: identity.userId,
      expiresAt: Date.now() + AUTH_CODE_TTL_MS,
      timer,
    });
    log.info("oauth 授权已确认", { clientId: p.clientId, accountId: identity.accountId });
    return { redirectUrl: appendQuery(p.redirectUri, { code, state: p.state, iss: this.issuer }) };
  }

  /* ------------------------------ token ------------------------------ */

  /** POST /oauth/token：authorization_code（+PKCE）与 refresh_token（轮换）两种 grant。 */
  async exchangeToken(params: URLSearchParams): Promise<Response> {
    const field = (name: string): string | undefined => boundedText(params.get(name) ?? undefined, MAX_FORM_FIELD_CHARS);
    const grantType = field("grant_type");
    if (grantType === "authorization_code") return this.exchangeAuthorizationCode(field);
    if (grantType === "refresh_token") return this.exchangeRefreshToken(field);
    return oauthErrorResponse(400, "unsupported_grant_type", "grant_type 只支持 authorization_code / refresh_token");
  }

  private async exchangeAuthorizationCode(field: (name: string) => string | undefined): Promise<Response> {
    const code = field("code");
    const clientId = field("client_id");
    const codeVerifier = field("code_verifier");
    const redirectUri = field("redirect_uri");
    if (!code) return oauthErrorResponse(400, "invalid_request", "缺少 code");
    if (!clientId) return oauthErrorResponse(400, "invalid_request", "缺少 client_id");
    if (!codeVerifier) return oauthErrorResponse(400, "invalid_request", "缺少 code_verifier（PKCE 必填）");

    const consumed = this.consumedCodes.get(code);
    if (consumed) {
      // 授权码二次使用：把首次兑现签出的整链 token 作废（OAuth 2.1 §4.1.2）。
      this.consumedCodes.delete(code);
      clearTimeout(consumed.timer);
      await this.store.revokeOAuthGrant(consumed.grantId);
      log.warn("oauth 授权码被重放，已整链撤销", { clientId });
      return oauthErrorResponse(400, "invalid_grant", "授权码已使用");
    }
    const issued = this.codes.get(code);
    if (!issued) return oauthErrorResponse(400, "invalid_grant", "授权码无效或已过期");
    // 一次性：无论后续校验成败都先摘除，失败的尝试不能再拿同一个 code 重试。
    this.codes.delete(code);
    clearTimeout(issued.timer);
    if (issued.expiresAt <= Date.now()) return oauthErrorResponse(400, "invalid_grant", "授权码无效或已过期");
    if (issued.clientId !== clientId) return oauthErrorResponse(400, "invalid_grant", "client_id 与授权码不匹配");
    if (redirectUri !== undefined && redirectUri !== issued.redirectUri) return oauthErrorResponse(400, "invalid_grant", "redirect_uri 与授权时不一致");
    if (!verifyPkce(codeVerifier, issued.codeChallenge)) return oauthErrorResponse(400, "invalid_grant", "PKCE 校验失败");

    const grantId = randomUUID();
    const consumedTimer = setTimeout(() => this.consumedCodes.delete(code), CONSUMED_CODE_TTL_MS);
    consumedTimer.unref();
    this.consumedCodes.set(code, { grantId, timer: consumedTimer });
    return this.issueTokens({ grantId, clientId, accountId: issued.accountId, userId: issued.userId, scope: issued.scope });
  }

  private async exchangeRefreshToken(field: (name: string) => string | undefined): Promise<Response> {
    const refreshToken = field("refresh_token");
    const clientId = field("client_id");
    if (!refreshToken) return oauthErrorResponse(400, "invalid_request", "缺少 refresh_token");
    if (!clientId) return oauthErrorResponse(400, "invalid_request", "缺少 client_id");
    const record = await this.store.getOAuthToken(hashToken(refreshToken), "refresh");
    if (!record) return oauthErrorResponse(400, "invalid_grant", "refresh_token 无效或已过期");
    if (record.revoked) {
      // 已轮换掉的 refresh 再次出现 = 泄露信号，整链撤销。
      await this.store.revokeOAuthGrant(record.grantId);
      log.warn("oauth refresh token 被重放，已整链撤销", { clientId: record.clientId });
      return oauthErrorResponse(400, "invalid_grant", "refresh_token 已失效");
    }
    if (record.expiresAt <= Date.now()) return oauthErrorResponse(400, "invalid_grant", "refresh_token 无效或已过期");
    if (record.clientId !== clientId) return oauthErrorResponse(400, "invalid_grant", "client_id 与 refresh_token 不匹配");
    // 轮换：旧 refresh 立即作废（旧 access 到期自然失效），新 access+refresh 沿用 grant。
    await this.store.revokeOAuthToken(record.tokenHash);
    return this.issueTokens({ grantId: record.grantId, clientId, accountId: record.accountId, userId: record.userId, scope: record.scope });
  }

  private async issueTokens(grant: { grantId: string; clientId: string; accountId: AccountId; userId: string | null; scope: string }): Promise<Response> {
    const now = Date.now();
    const accessToken = genToken("cf_oat");
    const refreshToken = genToken("cf_ort");
    const accessExpiresAt = now + config.oauthAccessTtlMs;
    await this.store.insertOAuthToken({
      tokenHash: hashToken(accessToken),
      kind: "access",
      grantId: grant.grantId,
      clientId: grant.clientId,
      accountId: grant.accountId,
      userId: grant.userId,
      scope: grant.scope,
      createdAt: now,
      expiresAt: accessExpiresAt,
      revoked: false,
    });
    await this.store.insertOAuthToken({
      tokenHash: hashToken(refreshToken),
      kind: "refresh",
      grantId: grant.grantId,
      clientId: grant.clientId,
      accountId: grant.accountId,
      userId: grant.userId,
      scope: grant.scope,
      createdAt: now,
      expiresAt: now + config.oauthRefreshTtlMs,
      revoked: false,
    });
    await this.store.touchOAuthClient(grant.clientId, now);
    return jsonNoStore(200, {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: Math.floor(config.oauthAccessTtlMs / 1000),
      refresh_token: refreshToken,
      ...(grant.scope ? { scope: grant.scope } : {}),
    });
  }

  /* ------------------------------ 资源服务器侧 ------------------------------ */

  /** 解析 Authorization: Bearer → principal；无/坏 token 返回 undefined，由调用方回 401 挑战。 */
  async authenticate(authorization: string | null): Promise<{ principal?: OAuthPrincipal; error?: "missing" | "invalid" }> {
    if (!authorization) return { error: "missing" };
    const match = /^Bearer\s+(\S+)\s*$/i.exec(authorization);
    if (!match) return { error: "invalid" };
    const token = match[1];
    if (token.length > 512) return { error: "invalid" };
    const record = await this.store.getOAuthToken(hashToken(token), "access");
    if (!record || record.revoked || record.expiresAt <= Date.now()) return { error: "invalid" };
    return {
      principal: { accountId: record.accountId, userId: record.userId, clientId: record.clientId, scope: record.scope, expiresAt: record.expiresAt },
    };
  }

  /** `/mcp` 的 401 挑战：`WWW-Authenticate: Bearer resource_metadata="…"`，宿主据此发现 PRM → AS。 */
  challenge(error?: "invalid"): Response {
    const parts = [`resource_metadata="${this.resourceMetadataUrl}"`];
    if (error === "invalid") parts.push('error="invalid_token"', 'error_description="access token 无效或已过期"');
    return Response.json(
      { jsonrpc: "2.0", error: { code: -32001, message: error === "invalid" ? "Unauthorized: access token 无效或已过期" : "Unauthorized: 需要 OAuth 授权" }, id: null },
      { status: 401, headers: { "WWW-Authenticate": `Bearer ${parts.join(", ")}`, "Cache-Control": "no-store" } },
    );
  }

  /** 运行时计数（供 /health 之类观察；不含 DB 侧）。 */
  stats(): { pendingAuthorizations: number; pendingCodes: number } {
    return { pendingAuthorizations: this.pending.size, pendingCodes: this.codes.size };
  }

  shutdown(): void {
    this.closed = true;
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
    for (const c of this.codes.values()) clearTimeout(c.timer);
    this.codes.clear();
    for (const c of this.consumedCodes.values()) clearTimeout(c.timer);
    this.consumedCodes.clear();
  }
}
