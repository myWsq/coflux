# API Overview — Reference

**Scope**: the public API surface of `@raven.js/core`, a source concept map, and the core
concepts. Read this first for any API/runtime task, then branch into
[`lifecycle.md`](./lifecycle.md), [`state-and-di.md`](./state-and-di.md),
[`schema-and-contract.md`](./schema-and-contract.md), [`plugins.md`](./plugins.md),
[`openapi.md`](./openapi.md), or [`gotchas.md`](./gotchas.md).

## Overview

RavenJS Core is a lightweight, contract-first web framework that runs on **Node (20+), Bun,
and Deno** (server-side; edge / Cloudflare Workers are not a target). It is built on
[Hono](https://hono.dev) as its HTTP / routing / serve engine, but layers a contract-first,
ambient-state programming model on top — **handlers never see Hono's `c`**.

It is distributed as a standard npm package, `@raven.js/core`, with `hono` as a
`peerDependency`.

Features:

- `app.ready()` returns a Web-standard `FetchHandler` (`(request: Request) => Promise<Response>`)
  you hand to any runtime's serve adapter.
- Ambient dependency injection via `AsyncLocalStorage` (`ScopedState`).
- Contract-first interface helpers (`defineContract`, `registerContractRoute`).
- Standard Schema request/response validation via `withSchema`.
- Lifecycle hooks (`onLoaded`, `onRequest`, `beforeHandle`, `beforeResponse`, `onError`,
  `onResponseValidationError`).
- Plugin system with scoped state.
- Built-in OpenAPI generation (`app.exportOpenAPI(...)` / `app.getOpenAPIDocument()`).
- `SchemaClass` for schema-shape type inference.

## Install

```bash
npm install @raven.js/core hono
# Node also needs a serve adapter:
npm install @hono/node-server
```

`hono` is a `peerDependency` — install it alongside `@raven.js/core`. Hono is used internally
as the HTTP / routing / serve engine, but its context (`c`) is never exposed to application code.

## Public API surface

The authoritative export map is the package root (`@raven.js/core`). These are the real public
exports; anything not listed here (e.g. internal hook arrays, `RouteData`, `RegisteredRoute`)
is **not** exported.

**App & plugins** — `Raven`, `definePlugin`

**Hook / handler / plugin types** — `FetchHandler`, `Handler`, `RouteHandler`,
`OnRequestHook`, `BeforeHandleHook`, `BeforeResponseHook`, `OnErrorHook`, `OnLoadedHook`,
`OnResponseValidationErrorHook`, `Plugin`, `ResponseValidationFailure`, `RavenInstance`

**State / DI** — `AppState`, `RequestState`, `ScopedState`, `defineAppState`,
`defineRequestState`, `StateOptions`, `StateSetter`, `StateView`; built-ins `RavenContext`,
`ParamsState`, `QueryState`, `HeadersState`, `BodyState`; storage `currentAppStorage`,
`requestStorage`, `ScopeKey` (also `internalSet` — framework-internal, do not call from app code)

**Routing** — `registerContractRoute` (standalone helper)

**Schema** — `withSchema`, `isSchemaAwareHandler`, `SchemaClass`, `ValidationError`,
`isValidationError`, `validateRequestSchemas`, plus the `SchemaContext` / `SchemaHandler` /
`Schemas` / `ValidationSource` / `StandardSchemaV1` / `StandardJSONSchemaV1` types

**Context & error** — `Context`, `RavenError`, `isRavenError`, `ErrorContext`

**OpenAPI** — `buildOpenAPIDocument`, `DEFAULT_OPENAPI_INFO`, `DEFAULT_OPENAPI_PATH`,
`OpenAPIDocument`, `OpenAPIExportOptions`, `OpenAPIInfo`, `OpenAPIWarning`

**Contract subentry** (`@raven.js/core/contract`) — a **frontend-safe** subentry whose module
graph pulls in **no** runtime (no Hono, no AsyncLocalStorage, no `Raven`). Exports
`defineContract`, `isSerializableContractSchema`, `materializeContractSchema(s)`, and all the
contract types (`Contract`, `AnyContract`, `HttpMethod`, `ContractSchemas`,
`InferContractBodyInput` / `…QueryInput` / `…ParamsInput` / `…HeadersInput` /
`…ResponseOutput`, etc.). These same symbols are also re-exported from the root, but author
`contract.ts` files against the subentry so they stay safe to import from frontend code.

## Source concept map

For AI-oriented reading, treat core as concept modules. (These are the framework's internal
source boundaries — useful for reasoning about behavior. The `.ts` source is **not** shipped in
the npm package, so reason from this reference; use `dist/index.d.mts` for exact types.)

- `index.ts` — public export map
- `contract/` — contract definition, transport-type inference, contract materialization
- `app/` — the `Raven` class, hook/plugin-facing types, route manifest, and `app/openapi.ts`
  (built-in OpenAPI document generation — a single file, **not** an `openapi/` directory)
- `runtime/` — the Hono adapter and request flow (`make-raven-handler`, `process-states`,
  `handle-response`, `handle-response-validation`, `handle-error`, `load-plugins`)
- `state/` — AsyncLocalStorage-backed storage, descriptors, built-in states
- `schema/` — `withSchema`, validation, `SchemaClass`, Standard Schema / Standard JSON Schema
- `context/` — the per-request `Context` object
- `error/` — the `RavenError` model

The request lifecycle entry is split across `app/raven.ts` (`Raven.dispatch`: ALS setup,
`onRequest`, awaits `hono.fetch`) and `runtime/make-raven-handler.ts` (the post-route-match
lifecycle). There is no single `dispatch-request.ts` — see [`lifecycle.md`](./lifecycle.md).

## Core concepts

### Raven

The application class — a **logic layer**. Register routes with full paths
(`app.get('/api/v1/users', handler)`), then `await app.ready()` to get a `FetchHandler` and
hand it to your runtime's serve adapter:

```ts
import { Raven } from "@raven.js/core";

const app = new Raven();
app.get("/", () => new Response("Hello"));

const fetch = await app.ready();
// Node:  import { serve } from "@hono/node-server"; serve({ fetch, port: 3000 });
// Bun:   export default { port: 3000, fetch };
// Deno:  Deno.serve({ port: 3000 }, fetch);
```

Route registration methods are `get` / `post` / `put` / `delete` / `patch` only. There is **no**
`options`, `head`, or `all` method, and `HttpMethod` does not include `HEAD` — see HEAD handling
in [`lifecycle.md`](./lifecycle.md). Each returns `this`, so registration chains.

**`RavenInstance` vs the concrete `Raven` class**: the exported `RavenInstance` interface
declares only `scopedStateMaps` and `exportOpenAPI(...)`. Methods like `getOpenAPIDocument()`,
the route methods, and the hook registrars exist on the concrete `Raven` class returned by
`new Raven()`. If you type a variable as `RavenInstance`, those extra methods are not visible —
prefer the concrete `Raven` type for app code.

### Context

The per-request context object, exposing `request`, `params`, `query`, `url`, `method`,
`headers`, and `body`. This is RavenJS's **own** ambient context — **not** Hono's `c`, which
never leaves framework internals. Access it via the built-in `RavenContext` state:

```ts
const ctx = RavenContext.getOrFailed();
ctx.method; // "GET"
ctx.params; // { id: "42" }
```

See [`state-and-di.md`](./state-and-di.md) for the full request-context shape and the built-in
states.

### Dependency Injection (`ScopedState`)

`ScopedState` is RavenJS's DI mechanism, backed by `AsyncLocalStorage`. `AppState` lives for the
whole app (DB clients, config); `RequestState` is isolated per request (current user, parsed
context). Handlers and reusable functions read state on demand — no `c` threading, no container.
Full rules in [`state-and-di.md`](./state-and-di.md).

### Schema validation

`withSchema` declares schemas for `body` / `query` / `params` / `headers` / `response`. Request
schemas are validated during the request lifecycle, validated output is written back into the
built-in states, and the handler receives a typed `ctx`. These schemas are **transport
validation** (shape, parsing, coercion, basic format) — domain invariants belong in entities.
Details, plus the important error-mapping caveats, in
[`schema-and-contract.md`](./schema-and-contract.md).

### Contract-first interface

A contract is a **serializable plain value** holding `method`, `path`, and `schemas` together.
Because it is a plain value, same-project frontend code can import it directly. Author one with
`defineContract` from the frontend-safe `@raven.js/core/contract` subentry; bind it to a handler
with `withSchema`; register it with `registerContractRoute`. See
[`schema-and-contract.md`](./schema-and-contract.md), and
[`../layer-responsibilities.md`](../layer-responsibilities.md) for where these files belong.

### Plugin

A plugin is a **named object** with a `load(app, set)` method, registered via `app.register()`
(synchronous, queues for loading during `ready()`) or `app.use()` (loads immediately). Plugins
are created by factory functions so they can accept configuration. Full authoring guide and the
four state-ownership patterns in [`plugins.md`](./plugins.md).

## Why this design

- **Hono is a mature multi-runtime engine** — RavenJS does not maintain its own router or
  dispatch pipeline.
- **The application model stays framework-neutral** — handlers never receive Hono's `c`; they
  read validated data and request info through ambient state, so business code does not couple
  to the engine.
- **Contracts are plain values** — the same contract drives backend registration, frontend type
  inference, and OpenAPI generation.
- **`AsyncLocalStorage` for state** — async-safe propagation with no cross-request leakage and
  no boilerplate context argument; ordinary reusable functions read state on demand.
- **Zero-argument handlers** — a handler only returns a `Response`; data is read on demand via
  state. `withSchema` adds a typed `ctx` where you want it without changing the registration
  style.
- **`register()` sync, `ready()` async** — `register()` declares structure (no I/O);
  `ready()` runs plugin `load()`s serially (async init like DB connections) then `onLoaded`
  hooks, and returns the `FetchHandler`.
