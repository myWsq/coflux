# Runtime Assembly — Reference

Reference for the RavenJS-specific runtime concerns: plugins, state, hooks, and app composition. See [overview](./overview.md) for the high-level pattern.

**Scope**: `app.ts`, plugins, states, scopes, and lifecycle hook placement.

State stays in this document because it is part of RavenJS runtime assembly, not a separate architectural layer.

Below is a concrete database plugin example that uses this exact pattern. It is runtime-agnostic: the database client is a placeholder you replace with your actual driver (`pg`, `postgres`, `mysql2`, `Bun.SQL`, a Deno driver, etc.).

## Runtime Assembly

This is the RavenJS-specific layer.

It owns:

- app composition
- direct route registration
- plugin registration for reusable runtime concerns
- state declaration colocated with plugins
- lifecycle hook placement
- error-to-response mapping

This layer is the only place that should deeply know RavenJS.

## State Rules

RavenJS introduces runtime state. Use it carefully.

### `AppState`

Use `AppState` only for long-lived runtime dependencies:

- database client
- config
- cache client
- mailer
- feature flags

Use `AppState` because Raven runtime owns their initialization, lifetime, or scope.

Do not lift an ordinary reusable helper or service into `AppState` just because:

- only one instance is needed
- the module is reused in many handlers
- the code was wrapped as a singleton service

Do not use `AppState` as a business model store.

### `RequestState`

Use `RequestState` only for per-request derived context:

- current user
- tenant
- transaction
- trace id
- permission snapshot

Do not store persistent business data in `RequestState`.

### Declaration Rules

In RavenJS, `State` should normally be declared together with the plugin that writes it.

Why:

- only plugins actually register and initialize runtime state
- only plugin `load()` has the framework-supported write path through `set(...)`
- colocating declaration and write ownership makes scope and lifecycle obvious

Recommended pattern:

```ts
// <app_root>/plugins/database.plugin.ts

// Replace this placeholder with your actual driver's client type,
// e.g. pg.Pool, the `postgres` Sql instance, mysql2 Connection,
// Bun.SQL, or a Deno database client.
interface DbClient {
  query<T>(text: string, params?: unknown[]): Promise<T[]>;
}

interface DbConfig {
  url: string;
}

// Replace with your driver's real constructor / connect call.
declare function createDbClient(config: DbConfig): DbClient;

const DBState = defineAppState<DbClient>({ name: "db" });

function databasePlugin(config: DbConfig) {
  return definePlugin({
    name: "database",
    load(_app, set) {
      set(DBState, createDbClient(config));
    },
  });
}

export { DBState, databasePlugin };
```

```ts
// <app_root>/plugins/auth.plugin.ts
const CurrentUserState = defineRequestState<User>({ name: "current-user" });

function authPlugin() {
  return definePlugin({
    name: "auth",
    load(app, set) {
      app.beforeHandle(async () => {
        const token = HeadersState.getOrFailed().authorization;
        const user = await resolveCurrentUser(token);
        set(CurrentUserState, user);
      });
    },
  });
}

export { CurrentUserState, authPlugin };
```

A reusable database plugin uses this exact pattern. The client type and
constructor are runtime-agnostic placeholders; swap them for your real driver
(`pg`, `postgres`, `mysql2`, `Bun.SQL`, a Deno driver, etc.):

```ts
// Database Plugin Example
// Minimal pattern for wrapping any database client with Raven's plugin + state APIs:
// 1. declare an AppState
// 2. create a definePlugin(...)
// 3. initialize the shared client in load(app, set)
// 4. read the client from handlers via ClientState.getOrFailed()

import { defineAppState, definePlugin } from "@raven.js/core";

// Replace with your actual driver's client + config types and connect call.
interface DbClient {
  query<T>(text: string, params?: unknown[]): Promise<T[]>;
}

interface DbConfig {
  url: string;
}

declare function createDbClient(config: DbConfig): DbClient;

export const ClientState = defineAppState<DbClient>({ name: "db-client" });

export function databasePlugin(config: DbConfig) {
  return definePlugin({
    name: "raven-database",
    load(_app, set) {
      set(ClientState, createDbClient(config));
    },
  });
}
```

Usage:

```ts
import { Raven } from "@raven.js/core";
import { ClientState, databasePlugin } from "./plugins/database.plugin";

const app = new Raven().register(databasePlugin({ url: "postgres://localhost/app" }));

app.get("/users", async () => {
  const db = ClientState.getOrFailed();
  const rows = await db.query("SELECT * FROM users LIMIT 10");
  return Response.json(rows);
});
```

Do not create a standalone `<app_root>/state/` directory by default.

### State Placement Test

Before introducing `AppState` or `RequestState`, ask:

1. does a plugin need to initialize it and write it through `set(...)`?
2. does it need Raven app/request lifetime or scope isolation?
3. must hooks or handlers read it through `State`, instead of a normal module import?

If the answer is no, keep it as an `Object Style Service` or another normal module export.

This is the default for:

- lightweight services or helpers
- object style services, including `Repository`, `Command`, and `Query`

RavenJS note:

- ScopedState is already the DI system
- independent functions can call `DBState.getOrFailed()`, `CurrentUserState.getOrFailed()`, and other ScopedState readers directly when needed
- if several related functions belong together, export them as one `Object Style Service`
- do not add plugin/state ceremony unless Raven runtime truly needs to own the dependency itself

Example of an `Object Style Service` that does **not** need `AppState`:

```ts
// <app_root>/auth/token.service.ts
const issue = async (userId: string) => {
  const config = AuthConfigState.getOrFailed();
  return signToken({ sub: userId }, config.jwtSecret);
};

const verify = async (token: string) => {
  const config = AuthConfigState.getOrFailed();
  return verifyToken(token, config.jwtSecret);
};

export const TokenService = { issue, verify };
```

### What Can Be Declared Separately?

Usually not `State` itself.

The thing that is sometimes worth declaring separately is a shared `ScopeKey`.

Keep all shared scope keys in one file when you need them:

```ts
// <app_root>/scopes.ts
const ANALYTICS_DB = Symbol("analytics-db");

export const ScopeKeys = { ANALYTICS_DB } as const;
```

```ts
// <app_root>/app.ts
app.register(databasePlugin(analyticsConfig), ScopeKeys.ANALYTICS_DB);
```

```ts
// <app_root>/plugins/reporting.plugin.ts
const sql = DBState.in(ScopeKeys.ANALYTICS_DB).getOrFailed();
```

If a scope key is only used inside one plugin, keep it inline instead of extracting it.

### Preferred Access Pattern

At Raven runtime, dependency injection for true runtime-managed dependencies should primarily happen through `State`.

Use this split:

1. `AppState` for shared runtime dependencies such as database clients
2. `RequestState` for per-request derived context
3. plain object style services or function collections for reusable code that does not need Raven-managed lifetime
4. plain constructor params only inside pure object construction

This keeps Raven's DI model consistent while still allowing entity objects to stay plain.

### Scope Rules

When a dependency has multiple runtime instances:

- use `register(plugin, scopeKey)`
- read with `State.in(scopeKey)`

When a dependency is private to a plugin:

- use `app.use()` with a private `Symbol` scope

This matches Raven's existing plugin and state patterns.

## Runtime Registration

In RavenJS, runtime assembly should usually happen directly under `<app_root>/`, where `<app_root>` is the directory that contains all Raven app code and is usually `src/`.

The default composition root is `<app_root>/app.ts`.

Use this split:

- register routes directly in `<app_root>/app.ts`
- prefer `registerContractRoute(app, Contract, Handler)` so route metadata still comes from `contract.ts`
- expose API documentation from `<app_root>/app.ts` with `app.exportOpenAPI(...)` when the app should publish OpenAPI
- use plugins for reusable runtime concerns
- register global `onError` handling in `<app_root>/app.ts` or a small reusable plugin
- register `onResponseValidationError` when response schema mismatch should produce logs, metrics, or alerts
- keep feature code in `interface/`, not hidden behind route plugins by default

In practice, plugins here usually do one of two things:

- provide shared infra through `AppState`
- write per-request context through `RequestState`

Route handlers do not need to be wrapped in plugins by default.

Register them directly in `<app_root>/app.ts` unless there is a concrete reason to hide route registration behind a plugin.
Do not wrap contract-driven route registration into a plugin just to avoid calling `registerContractRoute(...)` explicitly.

## Lifecycle Placement Rules

| Lifecycle        | Put Here                                                               | Do Not Put Here                                                  |
| ---------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `onRequest`      | logging, trace id, raw request guard, CORS, cheap rate limit           | logic that depends on route params, parsed body, validated input |
| `beforeHandle`   | auth, tenant resolution, transaction open, permission snapshot         | DTO mapping, entity construction, response shaping               |
| `handler`        | input-to-entity orchestration, command calls, query calls, DTO mapping | generic cross-cutting concerns shared by many routes             |
| `beforeResponse` | response headers, envelope, tracing headers                            | business decisions that should have happened earlier             |
| `onError`        | validation error mapping, business error mapping, fallback response    | core business logic                                              |
| `onLoaded`       | one-time startup checks and initialization                             | per-request logic                                                |

Important RavenJS constraint:

- if logic needs route `params`, `query`, or parsed `body`, prefer `beforeHandle`
- `onRequest` runs before full route context is assembled

## Composition Root Pattern

`<app_root>/app.ts` should be the single composition root.

It should:

1. create the Raven app
2. register infra plugins
3. register context plugins
4. register routes directly
5. register global error mapping
6. export `app`

Let the actual serving entrypoint decide when to call `await app.ready()` instead of wrapping that step inside `<app_root>/app.ts`.

Example shape:

```ts
import { Raven, registerContractRoute } from "@raven.js/core";

const app = new Raven();

app.register(databasePlugin(process.env.DATABASE_URL!));
app.register(authPlugin());
app.register(errorPlugin());

app.onResponseValidationError(({ error, value }) => {
  console.error("Response schema mismatch", error.responseIssues, value);
});

registerContractRoute(app, CreateOrderContract, CreateOrderHandler);
registerContractRoute(app, GetOrderContract, GetOrderHandler);
app.exportOpenAPI({
  info: {
    title: "Orders API",
    version: "1.0.0",
  },
});

export { app };
```

This keeps framework assembly out of entity code and out of interface folders.

## Serving Entrypoint

RavenJS does not listen on a port itself. `await app.ready()` returns a Web-standard
`FetchHandler` (`(request: Request) => Promise<Response>`). The serving entrypoint
hands that handler to whatever runtime you target — Node (via `@hono/node-server`),
Bun, or Deno. Keep `app.ready()` out of `<app_root>/app.ts` and call it here.

Node (`@hono/node-server`):

```ts
// <app_root>/server.ts
import { serve } from "@hono/node-server";
import { app } from "./app";

serve({ fetch: await app.ready(), port: 3000 });
```

Bun (native):

```ts
// <app_root>/server.ts
import { app } from "./app";

export default { port: 3000, fetch: await app.ready() };
```

Deno (native):

```ts
// <app_root>/server.ts
import { app } from "./app";

Deno.serve({ port: 3000 }, await app.ready());
```

This is the default RavenJS style for this pattern:

- routes are visible in one place
- runtime concerns are still modular through plugins
- business code stays outside `<app_root>/app.ts`
- `contract.ts` remains the only source of `method`, `path`, and `schemas`
- OpenAPI exposure still derives from the routes actually registered on this app
