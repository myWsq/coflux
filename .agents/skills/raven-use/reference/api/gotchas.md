# Framework Gotchas & Runtime Anti-Patterns — Reference

**Scope**: the framework-level traps and runtime anti-patterns — the **framework half** of the
Step 4 self-check. This is distinct from [`../anti-patterns.md`](../anti-patterns.md), which
covers **business-layer** smells (entity/repository/contract boundaries). Each entry links to
the topic doc with the full reasoning.

## Gotchas

1. **Hooks are global once registered.** A hook applies to every matching request, not just
   routes registered nearby. To scope a hook, check `RavenContext`/`request.url` inside it.
   ([`lifecycle.md`](./lifecycle.md))

2. **`register()` is sync; plugins load during `ready()`.** State written by a plugin is not
   available until after `await app.ready()`. `ready()` is idempotent and cached — register
   everything before calling it; plugins registered after the first `ready()` are ignored.
   ([`lifecycle.md`](./lifecycle.md), [`plugins.md`](./plugins.md))

3. **`use()` ≠ `register()`.** `use()` loads immediately, returns `Promise<void>` (not
   chainable), skips the pending queue, and does **not** fire `onLoaded`. ([`plugins.md`](./plugins.md))

4. **`StateSetter` only works in an active context.** For `AppState`, `set` writes durably during
   `load()`. For `RequestState`, calling `set` at `load()` time **silently no-ops** — write it
   from a per-request hook. The framework-internal `internalSet` instead **throws**
   `ERR_STATE_CANNOT_SET` when the store is missing. ([`state-and-di.md`](./state-and-di.md))

5. **`.get()` / `.getOrFailed()` always read GLOBAL scope.** A plugin registered with a
   `scopeKey` stores into that named scope; read it with `.in(scopeKey)` or get `undefined`.
   `scopeKey` is for multiple instances of the same plugin, not inter-plugin isolation.
   ([`state-and-di.md`](./state-and-di.md))

6. **`BodyState` only parses JSON, and is `unknown`.** It is populated only for
   `Content-Type: application/json`; otherwise read the raw body via `RavenContext`. Cast
   `BodyState`; `ParamsState`/`QueryState`/`HeadersState` are `Record<string,string>` and usable
   directly. ([`state-and-di.md`](./state-and-di.md))

7. **`onRequest` has a different signature and timing.** It receives the raw `Request` and runs
   **before** route matching — `RavenContext`, `ParamsState`, etc. are not set yet. Anything that
   needs route params / parsed body / validated input belongs in `beforeHandle`.
   ([`lifecycle.md`](./lifecycle.md))

8. **Hooks take effect only by returning a `Response`.** `onRequest`/`beforeHandle`/
   `beforeResponse`/`onError` returning `void` leaves the response unchanged. `onError` that
   forgets to return a `Response` falls through to the default 500. ([`lifecycle.md`](./lifecycle.md))

9. **Routing behavior (Hono engine, covered by RavenJS tests).** HEAD is rejected (→ `onError`
   404, no auto-HEAD from GET); trailing slash is strict (`/foo` ≠ `/foo/`); path params are
   `decodeURIComponent`-decoded; `/path/*` matches a zero-length tail. There is no `options`/
   `head`/`all` registration method. ([`lifecycle.md`](./lifecycle.md))

10. **Route conflicts are detected by normalized path SHAPE, not literal text.** `GET /orders/:id`
    and `GET /orders/:orderId` collide (both normalize to `/orders/:`); re-registering the same
    method+shape throws `Route conflict for <METHOD> <path>`. The export route (`/openapi.json`)
    participates too. ([`openapi.md`](./openapi.md))

11. **Request `ValidationError` defaults to 500, not 400.** It is **not** a `RavenError`, so
    without an `onError` hook that maps `isValidationError(error)` to a 400, it falls through to
    the generic 500. Only a malformed JSON body auto-yields a 400. ([`schema-and-contract.md`](./schema-and-contract.md))

12. **Response validation failure is fail-open.** A response that violates its `response` schema
    is returned **unvalidated** as `200`; `onResponseValidationError` is notified (observe-only,
    cannot change the response) and `onError` is **not** called. ([`schema-and-contract.md`](./schema-and-contract.md))

13. **`onError` also sees 404.** Route/method misses (and every HEAD) reach `onError` with
    `error.message === "Not Found"`. There is no separate `notFound` hook. ([`lifecycle.md`](./lifecycle.md))

14. **`beforeResponse` does not cover every exit.** Responses from an `onRequest` short-circuit
    and from any error path bypass `beforeResponse`. ([`lifecycle.md`](./lifecycle.md))

15. **Only `registerContractRoute` routes appear in OpenAPI.** Plain `app.get/post/...` routes
    are silently skipped. ([`openapi.md`](./openapi.md))

16. **`getOpenAPIDocument()` is on the concrete `Raven`, not `RavenInstance`, and needs
    `exportOpenAPI()` first.** ([`openapi.md`](./openapi.md))

17. **`SchemaClass` does no runtime validation.** It only assigns input and exposes `_shape`. For
    real validation, pass a runtime schema to `withSchema`. ([`schema-and-contract.md`](./schema-and-contract.md))

18. **Always name your states.** Omitting `name` yields an unstable `state:N` auto name; identity
    is the internal `Symbol`, not the name. ([`state-and-di.md`](./state-and-di.md))

19. **Two things named `registerContractRoute`.** Prefer the standalone helper
    `registerContractRoute(app, Contract, Handler)` (it delegates to the instance method).
    ([`schema-and-contract.md`](./schema-and-contract.md))

## Runtime anti-patterns

### Do not store request-scoped data in `AppState`

`AppState` is shared across the whole app — concurrent requests would overwrite each other. Use
`RequestState`.

```ts
const userState = defineAppState<User>({ name: "user" }); // ❌ shared across requests
const userState = defineRequestState<User>({ name: "user" }); // ✓ per request
```

### Do not register route-specific hooks globally

Hooks apply to all matching requests. To affect only a subset, check the path inside the hook.

```ts
app.beforeHandle(() => {
  const ctx = RavenContext.getOrFailed();
  if (!ctx.url.pathname.startsWith("/api")) return;
  return apiOnlyHook();
});
```

### Always return a `Response` from `onError`

```ts
app.onError((error) => {
  console.error(error);
  return new Response("Something went wrong", { status: 500 }); // ✓ must return
});
```

### Do not put route-aware logic in `onRequest`

Route context is not assembled in `onRequest`. Auth/logic that depends on `params`, query, or
parsed body belongs in `beforeHandle`.

### Do not lift ordinary helpers into `AppState`

Reserve `AppState` / `RequestState` for dependencies whose initialization, lifetime, or scope the
Raven runtime must own. Ordinary reusable code stays an Object Style Service — see
[`../runtime-assembly.md`](../runtime-assembly.md).

## Doc-drift note

If you are cross-referencing older material: there is **no** `runtime/dispatch-request.ts` (the
request entry is split between `Raven.dispatch` and `make-raven-handler`), there is **no**
`openapi/` directory (it is the single `app/openapi.ts`), and the `.ts` source is **not** shipped
in the npm package — only `dist` + a thin README. Treat this skill's `reference/` as the source
of truth and `dist/index.d.mts` as the exact type reference.
