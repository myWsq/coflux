# Plugin Authoring — Reference

**Scope**: writing plugins — `definePlugin`, `register` / `use` / `onLoaded`, the four
state-ownership patterns, and the gotchas. See [`state-and-di.md`](./state-and-di.md) for state
mechanics and [`lifecycle.md`](./lifecycle.md) for load ordering. For confirming exact type
signatures, use `node_modules/@raven.js/core/dist/index.d.mts`.

A plugin is a **named object** with a `load()` function, created by a factory so it can accept
configuration. Register it before calling `app.ready()`.

```ts
import { definePlugin, type Raven, type StateSetter } from "@raven.js/core";

export function myPlugin(config: { prefix: string }) {
  return definePlugin({
    name: "my-plugin",
    async load(app: Raven, set: StateSetter) {
      // register hooks, routes, write state
    },
  });
}

const app = new Raven();
app.register(myPlugin({ prefix: "/api" }));
const fetch = await app.ready();
```

## Registration & lifecycle API

- **`definePlugin(plugin)`** — type helper only; returns its argument unchanged, no runtime
  effect.
- **`app.register(plugin, scopeKey?)`** — **synchronous**; queues the plugin. All queued plugins
  run in registration order during `await app.ready()`, each `load()` awaited serially. Returns
  `this`, so registration chains. Because loads are serial, a later plugin's `load()` can read
  state written by an earlier plugin's async `load()`.
- **`app.use(plugin, scopeKey?)`** — **async**; runs `load()` **immediately**. Returns
  `Promise<void>` — it does **not** chain (unlike `register`, which returns `this`), does **not**
  enter the pending queue, and does **not** trigger `onLoaded`. Use it inside another plugin's
  `load()` to declare an inline dependency whose state is needed right away (see Pattern 3).
- **`app.onLoaded(hook)`** — registers a hook that runs during `ready()`, after all plugin loads
  complete, in registration order. A throw in one stops the rest and rejects `ready()`. Register
  all plugins and `onLoaded` hooks **before** calling `ready()` (which is idempotent and caches
  its result).
- **`StateSetter`** (`set`) — the scope-bound write function injected as the second `load` arg:
  `set<T>(state, value): void`. It writes to the scope assigned at `register()` time. See
  [`state-and-di.md`](./state-and-di.md) for the AppState-durable vs RequestState-lazy behavior.

## State patterns

State ownership is the key design decision. Pick the pattern by who holds and who reads the
state.

### Pattern 1 — Plugin produces state

Define the state descriptor at module level and export it. In `load()`, write the value via
`set()`. As an author you **don't know which scope** your plugin runs in — that's the caller's
choice. `set()` is scope-transparent.

```ts
// db-plugin.ts
import { definePlugin, defineAppState, type Raven, type StateSetter } from "@raven.js/core";

export interface DB {
  query(sql: string): Promise<unknown[]>;
}

export const DBState = defineAppState<DB>({ name: "db" });

export function dbPlugin(dsn: string) {
  return definePlugin({
    name: "db",
    async load(_app: Raven, set: StateSetter) {
      set(DBState, await connectDatabase(dsn)); // scope is up to the caller
    },
  });
}
```

The caller decides registration:

```ts
// Single instance — no scopeKey, state lands in GLOBAL scope
app.register(dbPlugin(dsn));
DBState.getOrFailed(); // reads GLOBAL ✓

// Multiple instances — caller names each scope
app.register(dbPlugin(primaryDsn), "primary");
app.register(dbPlugin(replicaDsn), "replica");
DBState.in("primary").getOrFailed();
DBState.in("replica").getOrFailed();
```

> `DBState.get()` always reads GLOBAL. If the plugin was registered with a `scopeKey`, reads must
> use `.in(scopeKey)`.

### Pattern 2 — Plugin reads state from another plugin

Accept a `StateView<T>` as a factory parameter; the caller decides which scope to pass. The
plugin stays decoupled from scope details.

```ts
// auth-plugin.ts
import { definePlugin, type StateView, type Raven, type StateSetter } from "@raven.js/core";
import type { DB } from "./db-plugin.ts";

export function authPlugin(dbView: StateView<DB>) {
  return definePlugin({
    name: "auth",
    load(app: Raven, _set: StateSetter) {
      app.beforeHandle(async () => {
        const db = dbView.getOrFailed(); // reads whatever scope the caller bound
        // verify token against db...
      });
    },
  });
}
```

```ts
// app.ts
app.register(dbPlugin("postgres://primary/db"), "primary");
app.register(authPlugin(DBState.in("primary"))); // caller picks the scope

// If dbPlugin is registered without a scopeKey (GLOBAL), pass the bare descriptor —
// it structurally satisfies StateView<DB> and reads GLOBAL:
app.register(dbPlugin("postgres://host/db"));
app.register(authPlugin(DBState));
```

**When to use**: a plugin reads (but does not write) state from another plugin.

### Pattern 3 — Plugin owns its dependency

To fully encapsulate a dependency, use `app.use()` with a fresh `Symbol` scope created inside
`load()`. `app.use()` runs the dependency's `load()` **immediately** (unlike `register`), so its
state is available in the same `load()` phase. A fresh `Symbol` per call keeps multiple
registrations collision-free.

```ts
// auth-plugin.ts
import { definePlugin, type Raven, type StateSetter } from "@raven.js/core";
import { dbPlugin, DBState } from "./db-plugin.ts";

export function authPlugin(dsn: string) {
  return definePlugin({
    name: "auth",
    async load(app: Raven, _set: StateSetter) {
      const dbScope = Symbol("auth:db"); // unique per load() call
      await app.use(dbPlugin(dsn), dbScope); // runs dbPlugin immediately
      const db = DBState.in(dbScope).getOrFailed(); // available now

      app.get("/auth/check", async () => {
        const conn = DBState.in(dbScope).getOrFailed(); // closure captures this instance's db
        // ...
      });
    },
  });
}
```

```ts
// app.ts — two independent auth instances, each with its own db
app.register(authPlugin("postgres://tenant-a/db"));
app.register(authPlugin("postgres://tenant-b/db"));
```

For multiple internal instances, create a separate `Symbol` for each.

**When to use**: a plugin has an internal dependency it wants to hide from the caller.

### Pattern 4 — Writing `RequestState` in hooks

`RequestState` is written per-request, not at registration time. Capture `set` in a closure and
call it inside a `beforeHandle`/`onRequest` hook. (Calling `set` for a `RequestState` at `load()`
time silently no-ops — there is no request store yet.)

```ts
// auth-plugin.ts
import {
  definePlugin,
  defineRequestState,
  HeadersState,
  type Raven,
  type StateSetter,
} from "@raven.js/core";

interface User {
  id: string;
  name: string;
}
export const CurrentUser = defineRequestState<User>({ name: "current-user" });

export function authPlugin() {
  return definePlugin({
    name: "auth",
    load(app: Raven, set: StateSetter) {
      app.beforeHandle(async () => {
        const headers = HeadersState.getOrFailed();
        const user = await verifyToken(headers["authorization"]);
        set(CurrentUser, user); // writes this request's scope
      });
    },
  });
}
```

```ts
app.get("/me", () => Response.json(CurrentUser.getOrFailed()));
```

**When to use**: state that differs per request (authenticated user, parsed body, tenant
context).

## Gotchas

### `app.register()` inside `load()` does not run immediately

Calling `app.register()` inside a `load()` appends to the pending queue — it runs _after_ the
current `load()` finishes. Reading the dependency's state in the same `load()` will fail. Use
`app.use()` (immediate) when you need the state right away.

```ts
// ❌ dbPlugin hasn't loaded yet
async load(app, set) {
  app.register(dbPlugin(dsn), "my-db");
  DBState.in("my-db").getOrFailed(); // throws — state not set
}
// ✓ app.use() runs immediately
async load(app, set) {
  const dbScope = Symbol("my-db");
  await app.use(dbPlugin(dsn), dbScope);
  DBState.in(dbScope).getOrFailed(); // safe
}
```

`app.register()` inside `load()` is fine if the dependency's state is only needed inside handlers
(request time), because all plugins have loaded by then.

### `scopeKey` is for multiple instances, not inter-plugin isolation

`scopeKey` gives independent state to multiple registrations of the **same** plugin. It is not a
general isolation mechanism between different plugins. Shared/cross-plugin state belongs in
GLOBAL (no `scopeKey`); readers call `state.get()` or accept a `StateView`.

### Scoped reads must match the registered scope key

`state.get()` reads GLOBAL only. If a plugin was registered with a `scopeKey`, read with
`.in(scopeKey)` or you get `undefined`.

### Hook order follows registration order

Hooks added in `load()` are appended to the global hook list; plugins registered first have their
hooks run first.

### `onLoaded` runs after all plugins, during `ready()`

`onLoaded` hooks run after all plugin `load()`s complete, in registration order, serially. A
throw skips the rest and rejects `ready()`. `app.use()` does **not** fire `onLoaded`.

### `load()` errors are wrapped with the plugin name

If `load()` throws, `ready()` rejects with `[<plugin-name>] Plugin load failed: <message>`. The
original error is preserved as `error.cause`.
