# Lifecycle — Reference

**Scope**: the build lifecycle (`register` → `ready` → `FetchHandler`) and the per-request
lifecycle (two-layer AsyncLocalStorage, hook order, HEAD handling, query semantics, and the
three error paths). See [`overview.md`](./overview.md) for the API surface and
[`plugins.md`](./plugins.md) for plugin loading details.

## Build lifecycle

```
app setup (sync)
   │  app.get/post/... and app.register(plugin) — synchronous; declare routes and queue plugins
   ▼
await app.ready()  — async build phase (idempotent, cached):
   │   1. load queued plugins serially, in registration order (each load() awaited)
   │   2. run onLoaded hooks in order
   │   3. return a Web-standard FetchHandler: (request) => Response
   ▼
app ready — hand the FetchHandler to a runtime serve adapter
```

- **`register()` is synchronous** — it only queues the plugin (FIFO). The actual `load()` runs
  during `ready()`. Always `await app.ready()` before serving.
- **`ready()` is idempotent and caches its promise.** Calling it again returns the **same**
  `FetchHandler` and does **not** re-load plugins. Plugins (or `onLoaded` hooks) registered
  after the first `ready()` have no effect on the running handler. Register everything before
  calling `ready()`.
- **Plugin load order is load-bearing.** A later plugin's `load()` can read state written by an
  earlier plugin's (even async) `load()`. `onLoaded` hooks run once, after all loads, in
  registration order; a throw in one stops the rest and rejects `ready()`.
- **`use()` vs `register()`** — `app.use(plugin, scopeKey?)` loads the plugin **immediately**
  (inside the app storage context), returns `Promise<void>` (it does **not** chain like
  `register`, which returns `this`), does **not** enter the pending queue, and does **not**
  trigger `onLoaded`. Use it inside another plugin's `load()` to pull an inline dependency whose
  state is needed right away. See [`plugins.md`](./plugins.md).

## Request lifecycle (matched route)

```
incoming request
   │
   ▼
two-layer AsyncLocalStorage opens   ← currentAppStorage.run(app, () => requestStorage.run(new Map(), ...))
   │
   ▼
[onRequest hooks]    ← raw Request arg; RavenContext is NOT built yet. Return a Response to short-circuit.
   │
   ▼
[route matching]     ← performed by the internal Hono engine; no match → 404 (see error paths)
   │
   ▼
RavenContext set     ← internalSet(RavenContext, new Context(request, params, query)) after the match
   │
   ▼
[processStates]      ← parse body (JSON only), lowercase headers, validate declared schemas,
   │                   write validated output into ParamsState / QueryState / HeadersState / BodyState
   ▼
[beforeHandle hooks] ← no args; all states ready. Return a Response to short-circuit (still runs beforeResponse).
   │
   ▼
[handler()]          ← zero-arg handler, or the typed schema handler registered via withSchema
   │
   ▼
[beforeResponse hooks] ← receives the Response; return a new Response to replace it (void keeps current)
   │
   ▼
outgoing response
```

The exact order is: `onRequest` → route match → **RavenContext set** → `processStates` →
`beforeHandle` → `handler` → `beforeResponse`. This order is asserted by the test suite.

### Two-layer AsyncLocalStorage

`Raven.dispatch` (the private entry behind the `FetchHandler`) opens two ALS layers:
`currentAppStorage` (the app, outer) wrapping `requestStorage` (a fresh per-request `Map`,
inner). The whole `hono.fetch(request)` is awaited **inside** those layers, so the matched
handler, hooks, `onError`, and `notFound` all run in the same ambient context. This is what
makes `RavenContext`, `AppState`, and `RequestState` readable on demand without threading a
context argument — and it isolates request state across concurrent in-flight requests.

> There is no single `dispatch-request.ts` file. The lifecycle entry is split between
> `Raven.dispatch` (ALS setup, `onRequest`, awaiting `hono.fetch`, the outer `catch`) and the
> per-route `make-raven-handler` (the post-match steps above). Don't look for a dispatch
> pipeline file.

### `onRequest` runs before the context exists

`onRequest` is the only hook that receives an argument — the raw `Request`. It runs **before**
route matching, so `RavenContext`, `ParamsState`, `QueryState`, etc. are **not** populated yet.
Reading `params`/`query` in `onRequest` silently sees nothing. For anything that needs route
params, the parsed body, or validated input, use `beforeHandle`.

```ts
app.onRequest((request) => {
  const token = request.headers.get("authorization"); // ✓ raw request only
  // RavenContext.get() is not usable here
});

app.beforeHandle(() => {
  const ctx = RavenContext.getOrFailed(); // ✓ params/query/body ready
});
```

### Hook return contract

`onRequest`, `beforeHandle`, `beforeResponse`, and `onError` only take effect by **returning a
`Response`**. Returning `void`/`undefined` leaves the current response unchanged (`beforeResponse`
replaces the response only when the hook returns a `Response`). A `beforeHandle` that returns a
`Response` short-circuits the handler but still runs the `beforeResponse` chain.

### Routing behavior (Hono engine, covered by RavenJS tests)

Routing runs on the Hono engine; these behaviors are verified by RavenJS's own routing tests:

- **HEAD is rejected.** RavenJS's `HttpMethod` has no `HEAD`, so HEAD routes cannot be
  registered, and a HEAD request to a GET route is intercepted before the GET handler runs: it
  resolves to `notFound` → `onError` with a **404** and `error.message === "Not Found"`. A
  GET handler's side effects never fire for HEAD. There is also no `OPTIONS`/`all` registration.
- **Trailing slash is strict.** `/foo` and `/foo/` are distinct routes — no normalization
  (`/strict` → 200, `/strict/` → 404).
- **Path params are `decodeURIComponent`-decoded** (`/decode/a%20b` → `params.name === "a b"`).
- **Wildcards** `/path/*` also match a zero-length tail, so `/files/` matches `/files/*`.

### Query duplicate-key semantics

RavenJS rebuilds `query` from `new URL(request.url).searchParams` with **last-value-wins** for
repeated keys (it deliberately does **not** use Hono's `c.req.query()`, which returns the first
value). If you rely on repeated query keys, expect the last value.

## Error paths

Three entry points all converge on the same error handler (`handleError(error, onError)`):

1. **404 / notFound** — a route or method miss (including every HEAD) calls
   `handleError(new Error("Not Found"), onError, 404)`. **`onError` sees 404s** — there is no
   separate user-registrable `notFound` hook. To special-case it, check
   `error.message === "Not Found"`.
2. **Thrown errors** — anything thrown in `processStates`, `beforeHandle`, the handler, or
   `beforeResponse` is caught by Hono's `onError` and routed to `handleError` (default status
   500). Non-`Error` throws are normalized to `RavenError.ERR_UNKNOWN_ERROR`.
3. **`onRequest` / fetch failures** — `dispatch`'s own `try/catch` wraps errors from `onRequest`
   hooks and from `hono.fetch` the same way.

`handleError` resolution order:

1. the first `onError` hook that returns a `Response` wins; else
2. if the error is a `RavenError`, return `error.toResponse()` (serializes using its
   `statusCode`); else
3. if a status of 404 was passed, return a plain `404 Not Found`; else
4. a generic `500 Internal Server Error` (with `console.error`).

> **`beforeResponse` does not cover every exit.** Responses from an `onRequest` short-circuit
> and from any error path (`handleError`) bypass the `beforeResponse` chain. Only normal handler
> returns and `beforeHandle` short-circuits pass through `beforeResponse`. Don't rely on
> `beforeResponse` to decorate error responses.

> **`ValidationError` from request validation is not a `RavenError`.** A failed request schema
> validation throws inside `processStates` and, without an `onError` hook that maps it, falls
> through to the generic **500** branch — **not** a 400. Only a malformed JSON body auto-yields a
> 400 (via `RavenError.ERR_BAD_REQUEST`). See [`schema-and-contract.md`](./schema-and-contract.md).

> **Response validation failure is non-fatal (fail-open).** When a schema-aware handler's
> response fails its `response` schema, the framework returns the handler's **original
> unvalidated value** as `200` JSON and notifies the `onResponseValidationError` hook
> (observe-only — hook exceptions are swallowed, and the hook cannot change the response).
> `onError` is **not** called. See [`schema-and-contract.md`](./schema-and-contract.md).

## Plugin load errors

If a plugin's `load()` throws, `ready()` rejects with the message wrapped by the plugin name:

```
[my-plugin] Plugin load failed: <original message>
```

The original error is preserved as `error.cause`.
