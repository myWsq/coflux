/**
 * plan 090 黑盒辅助：用 fetch 直接打中心的 OAuth 2.1 端点与 `/mcp`（JSON-RPC over HTTP），
 * 确认页那一跳用测试 WS Client 发同款消息。与 harness.mjs 同一纪律：不 import apps/* 的实现。
 */
import { createHash, randomBytes } from "node:crypto";

export function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export async function fetchJson(url, init = {}) {
  const res = await fetch(url, init);
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* 非 JSON 或空体 */
  }
  return { status: res.status, headers: res.headers, json };
}

/** RFC 7591 动态注册：默认一个 loopback 回调，公共客户端。 */
export function registerClient(base, overrides = {}) {
  return fetchJson(`${base}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "test-host",
      redirect_uris: ["http://localhost/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...overrides,
    }),
  });
}

/** GET /oauth/authorize（不跟随跳转），返回 { status, location, json }。 */
export async function startAuthorization(base, { clientId, redirectUri, challenge, state, scope, resource, method = "S256", responseType = "code" }) {
  const url = new URL(`${base}/oauth/authorize`);
  if (responseType !== undefined) url.searchParams.set("response_type", responseType);
  url.searchParams.set("client_id", clientId);
  if (redirectUri !== undefined) url.searchParams.set("redirect_uri", redirectUri);
  if (challenge !== undefined) url.searchParams.set("code_challenge", challenge);
  if (method !== undefined) url.searchParams.set("code_challenge_method", method);
  if (state !== undefined) url.searchParams.set("state", state);
  if (scope !== undefined) url.searchParams.set("scope", scope);
  if (resource !== undefined) url.searchParams.set("resource", resource);
  const res = await fetch(url, { redirect: "manual" });
  let json = null;
  if (res.status !== 302) {
    try {
      json = await res.json();
    } catch {
      /* ignore */
    }
  }
  return { status: res.status, location: res.headers.get("location"), json };
}

export function requestIdFromConsentUrl(location) {
  return new URL(location).searchParams.get("request");
}

/** 从 sinceIndex 之后的 log 里等消息，避免命中同一 client 上早先的同类消息。 */
export function waitForSince(client, sinceIndex, pred, label, timeout = 10000) {
  const hit = client.log.slice(sinceIndex).find(pred);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout waiting for " + label)), timeout);
    client.waiters.push({ try: (m) => (pred(m) ? (clearTimeout(t), resolve(m), true) : false) });
  });
}

/** 一个已通过 clientAuth（不订阅）的测试 Client，模拟确认页的旁路连接。 */
export async function consentClient(stack, username = stack.username ?? "admin", password = stack.password ?? "admin") {
  const client = stack.makeClient();
  await client.ready;
  client.send({ case: "clientAuth", username, password });
  const reply = await client.waitFor((m) => m.case === "authOk" || m.case === "authError", "consent auth");
  if (reply.case !== "authOk") throw new Error("consent client auth failed");
  return client;
}

/** 确认页那一跳：查询请求信息 → 确认/拒绝，返回 { info, result }。 */
export async function consent(client, requestId, approve) {
  const since = client.log.length;
  client.send({ case: "oauthAuthorizeInfo", requestId });
  const info = await waitForSince(client, since, (m) => m.case === "oauthAuthorizeInfo", "oauth info");
  if (!info.ok) return { info, result: null };
  const since2 = client.log.length;
  client.send({ case: "oauthAuthorizeDecide", requestId, approve });
  const result = await waitForSince(client, since2, (m) => m.case === "oauthAuthorizeResult", "oauth result");
  return { info, result };
}

export function exchangeCode(base, { code, clientId, verifier, redirectUri }) {
  const body = new URLSearchParams({ grant_type: "authorization_code", code, client_id: clientId, code_verifier: verifier });
  if (redirectUri !== undefined) body.set("redirect_uri", redirectUri);
  return fetchJson(`${base}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
}

export function refreshTokens(base, { refreshToken, clientId }) {
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId });
  return fetchJson(`${base}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
}

/** 走完整授权码流程拿 token：DCR（可复用 clientId）→ authorize → 确认 → 换 token。 */
export async function obtainTokens(base, client, { clientId, redirectUri = "http://localhost:41234/callback", scope } = {}) {
  let id = clientId;
  if (!id) {
    const reg = await registerClient(base);
    if (reg.status !== 201) throw new Error(`register failed: ${reg.status} ${JSON.stringify(reg.json)}`);
    id = reg.json.client_id;
  }
  const { verifier, challenge } = pkce();
  const state = randomBytes(8).toString("hex");
  const auth = await startAuthorization(base, { clientId: id, redirectUri, challenge, state, scope, resource: `${base}/mcp` });
  if (auth.status !== 302) throw new Error(`authorize failed: ${auth.status} ${JSON.stringify(auth.json)}`);
  const requestId = requestIdFromConsentUrl(auth.location);
  const { info, result } = await consent(client, requestId, true);
  if (!info.ok || !result?.ok) throw new Error(`consent failed: ${JSON.stringify({ info, result })}`);
  const callback = new URL(result.redirectUrl);
  if (callback.searchParams.get("state") !== state) throw new Error("state mismatch");
  const code = callback.searchParams.get("code");
  const token = await exchangeCode(base, { code, clientId: id, verifier, redirectUri });
  if (token.status !== 200) throw new Error(`token failed: ${token.status} ${JSON.stringify(token.json)}`);
  return { clientId: id, ...token.json };
}

/* ------------------------------ MCP（JSON-RPC over HTTP） ------------------------------ */

let rpcId = 0;

export async function mcpRequest(base, token, method, params, extraHeaders = {}) {
  rpcId += 1;
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...extraHeaders,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId, method, ...(params === undefined ? {} : { params }) }),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* 401 等也带 JSON 体，但保险起见容忍空体 */
  }
  return { status: res.status, headers: res.headers, json };
}

export function mcpInitialize(base, token) {
  return mcpRequest(base, token, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "coflux-blackbox", version: "0.0.0" },
  });
}

export function mcpListTools(base, token) {
  return mcpRequest(base, token, "tools/list", {});
}

/** tools/call；返回 { status, result }，result = { content, structuredContent?, isError? }。 */
export async function callTool(base, token, name, args = {}) {
  const r = await mcpRequest(base, token, "tools/call", { name, arguments: args });
  return { status: r.status, json: r.json, result: r.json?.result ?? null, error: r.json?.error ?? null };
}

/** 解析 `WWW-Authenticate: Bearer k="v", …` 为对象。 */
export function parseWwwAuthenticate(header) {
  if (!header || !/^Bearer\b/i.test(header)) return null;
  const params = {};
  for (const match of header.slice(6).matchAll(/([a-zA-Z_]+)="([^"]*)"/g)) params[match[1]] = match[2];
  return params;
}
