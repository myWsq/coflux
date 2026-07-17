# State & Dependency Injection — Reference

**Scope**: `ScopedState` (`AppState` / `RequestState`), the built-in states, scope rules, and
the two state write paths. See [`plugins.md`](./plugins.md) for the state-ownership patterns and
[`../runtime-assembly.md`](../runtime-assembly.md) for when to use state vs an Object Style
Service.

## ScopedState is the DI mechanism

`ScopedState` is RavenJS's dependency injection, backed by `AsyncLocalStorage`. State propagates
through the async call chain, so handlers, hooks, plugins, and ordinary reusable functions read
dependencies on demand — no context argument threading, no DI container.

| Type              | Lifetime                                       | Typical use                                 |
| ----------------- | ---------------------------------------------- | ------------------------------------------- |
| `AppState<T>`     | the whole app (one value per `Raven` instance) | DB clients, config, caches, mailers         |
| `RequestState<T>` | isolated per HTTP request                      | current user, tenant, transaction, trace id |

Define a state at module level and export it as the read handle:

```ts
import { defineAppState, defineRequestState } from "@raven.js/core";

export const DBState = defineAppState<DbClient>({ name: "db" });
export const CurrentUser = defineRequestState<User>({ name: "current-user" });
```

> **Always pass an explicit `name`.** The only `StateOptions` field is `name`. If omitted, an
> auto name `state:N` is generated from a process-wide counter — unstable across module load
> order and useless in error messages. A state's identity is its internal `Symbol`, **not** its
> name (two states with the same name are still distinct), so the name exists purely for
> debuggable `getOrFailed` errors. Name everything.

## Reading state

Every state offers:

- `state.get(): T | undefined` — returns `undefined` when there is no active context or nothing
  was written.
- `state.getOrFailed(): T` — returns the value or throws
  `State is not initialized. Cannot access state: <name>`.
- `state.in(scopeKey): StateView<T>` — a read handle bound to a named scope (memoized:
  `state.in(k) === state.in(k)`).

```ts
const db = DBState.getOrFailed(); // throws if not set
const user = CurrentUser.get(); // User | undefined
const replica = DBState.in("replica").get(); // scoped read
```

> **`.get()` / `.getOrFailed()` always read the GLOBAL scope.** If a plugin was registered with
> a `scopeKey`, its value lands in that **named** scope and a bare `.get()` returns `undefined`.
> You must read with `.in(scopeKey)`. This is the #1 scope mistake.

> **`undefined` is indistinguishable from "not set".** A stored `undefined` reads as missing, so
> `getOrFailed` on it throws. `BodyState` in particular is only written when the validated body
> is not `undefined`.

**`AppState` reads need an active app context.** A value written during plugin `load()` is only
readable where the app's `AsyncLocalStorage` layer is active: inside plugin `load()`, lifecycle
hooks, and route handlers (during a request, `dispatch` nests the request store inside the app
store, so `AppState` resolves there too). Reading `AppState` at **module top level**, or from a
plain function called **outside** any request / `ready()` / serving, finds no app store —
`get()` returns `undefined` and `getOrFailed()` throws `ERR_STATE_NOT_INITIALIZED`. So read
`AppState` on demand inside handlers/hooks/services, not eagerly at import time. (For tests or
scripts that need it outside a request, run the read inside `currentAppStorage.run(app, () => …)`.)

## Built-in states

All built-ins are `RequestState` (per-request, isolated). The framework populates them
automatically — **do not set them manually**.

| State          | Type                     | Populated                                                               |
| -------------- | ------------------------ | ----------------------------------------------------------------------- |
| `RavenContext` | `Context`                | right after route match (full request context)                          |
| `ParamsState`  | `Record<string, string>` | by `processStates` (validated route params)                             |
| `QueryState`   | `Record<string, string>` | by `processStates` (validated query; last-value-wins for repeated keys) |
| `HeadersState` | `Record<string, string>` | by `processStates` (validated headers; **keys lowercased**)             |
| `BodyState`    | `unknown`                | by `processStates`, only when a JSON body is present                    |

```ts
const { id } = ParamsState.getOrFailed(); // Record<string,string> — use directly
const body = BodyState.getOrFailed() as { name: string }; // unknown — cast required
const ctx = RavenContext.getOrFailed(); // request / params / query / url / method / headers / body
```

Notes:

- `ParamsState` / `QueryState` / `HeadersState` are `Record<string, string>` — usable directly.
  `BodyState` is `unknown` because JSON structure is arbitrary — **cast it**.
- `BodyState` is only populated for `Content-Type: application/json`. For form-data, text, or
  binary, read the raw body via `RavenContext.getOrFailed().request`.
- For routes registered with `withSchema`, these states hold the **validated output** (after
  coercion/transform) before `beforeHandle` runs. Treat them as transport validation; if you
  need the raw request, read `RavenContext.getOrFailed().request`.

## Scopes

A `ScopeKey` is a `string | symbol`. Scopes give independent state to **multiple registrations
of the same plugin** (or to a plugin's private internal dependency) — they are **not** a general
isolation mechanism between different plugins. Shared/cross-plugin state belongs in GLOBAL.

- **Named (string) scopes** — multiple instances: `app.register(dbPlugin(a), "primary")` then
  read `DBState.in("primary")`.
- **Private (symbol) scopes** — a plugin's own internal dependency: create a fresh `Symbol`
  inside `load()` and use `app.use(dep, symbolScope)` so registrations never collide. See
  Pattern 3 in [`plugins.md`](./plugins.md).

## The two write paths

There are two ways state gets written, with **different failure modes** — do not conflate them.

1. **`StateSetter` (the supported app-author path)** — the `set` injected as the second arg of
   a plugin's `load(app, set)`. Signature `set<T>(state, value): void`. It is scope-bound: it
   writes to the scope assigned at `register()` time (`scopeKey ?? GLOBAL`).
   - For `AppState`, the write happens immediately during `load()` and is durable.
   - For `RequestState`, the write targets the **current request's** store, resolved lazily at
     call time. Calling it at `load()` time **silently no-ops** (no request store exists yet) —
     so always write `RequestState` from inside a per-request hook (`onRequest` / `beforeHandle`),
     capturing `set` in a closure.

2. **`internalSet` (framework-internal)** — always writes the GLOBAL scope and **throws**
   `ERR_STATE_CANNOT_SET` if the relevant ALS store is missing. It is exported but is for
   framework use (populating built-ins); app code should not call it.

There is no other public write API: the only supported app-author writer is the `set` passed
into `Plugin.load`. To "write" derived request data, write a `RequestState` from a hook.

```ts
// AppState — write at load time
definePlugin({
  name: "db",
  load(_app, set) {
    set(DBState, createDbClient(config)); // durable, scope = registration scope
  },
});

// RequestState — write per request from a hook (NOT at load time)
definePlugin({
  name: "auth",
  load(app, set) {
    app.beforeHandle(async () => {
      const user = await resolveUser(HeadersState.getOrFailed().authorization);
      set(CurrentUser, user); // writes this request's store
    });
  },
});
```

## `StateView` structural compatibility

`AppState` and `RequestState` both structurally satisfy `StateView<T>` (they implement
`get`/`getOrFailed`), so a bare descriptor can be passed where a `StateView<T>` parameter is
expected — but it then reads the **GLOBAL** scope. To bind a non-global scope, pass
`DBState.in(scope)` instead of `DBState`. This is the mechanism behind Pattern 2 in
[`plugins.md`](./plugins.md).

## Isolation guarantees (verified by tests)

- **Per-request isolation** — each request gets a fresh store, so concurrent in-flight requests
  never leak `RequestState` into each other (verified with interleaved requests).
- **Per-instance isolation** — each `Raven` instance owns its own `AppState` storage; two apps
  hold independent values.
