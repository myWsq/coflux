# OpenAPI Export — Reference

**Scope**: `exportOpenAPI` / `getOpenAPIDocument` / `buildOpenAPIDocument`, what appears in the
document, and the hardcoded behaviors. RavenJS ships its **own** OpenAPI generator (no dependency
on `@hono/zod-openapi`); the document is built from the contract routes registered on the app
instance. See [`schema-and-contract.md`](./schema-and-contract.md) for contract authoring.

## Turning on export

```ts
import { Raven, registerContractRoute } from "@raven.js/core";

const app = new Raven();
registerContractRoute(app, CreateOrderContract, CreateOrderHandler);

app.exportOpenAPI({
  info: { title: "Orders API", version: "1.0.0" },
  // path defaults to "/openapi.json"
});
```

`app.exportOpenAPI(options?)`:

- Registers a GET route at `options.path ?? "/openapi.json"` that returns
  `Response.json(this.getOpenAPIDocument())`.
- `info` defaults field-by-field to `DEFAULT_OPENAPI_INFO` (`{ title: "Raven API", version:
"1.0.0" }`).
- Returns `this` (chainable on the concrete `Raven`).
- **Can only be called once** — a second call throws `OpenAPI export is already configured at
<path>`.

`app.getOpenAPIDocument(): OpenAPIDocument` returns the document object. It **throws** `OpenAPI
export is not configured for this app` if `exportOpenAPI` was not called first.

> `getOpenAPIDocument()` exists only on the **concrete `Raven` class**, not on the exported
> `RavenInstance` interface (which declares only `scopedStateMaps` and `exportOpenAPI`). A
> reference typed as `RavenInstance` cannot call it — type app code as `Raven`.

## What appears in the document

- **Only routes registered via `registerContractRoute`** (i.e. carrying a `contract`) are
  included. Plain `app.get` / `app.post` / … routes have no contract and are **silently
  skipped** — no path, no warning. If a route is missing from the spec, this is usually why.
- Contract routes registered during a **plugin's `load()`** are included (loads finish before
  any request is dispatched).
- The document route itself (e.g. `/openapi.json`) has no contract, so it does not appear in its
  own `paths`.

For each contract, `body` / `query` / `params` / `headers` / `response` are materialized to JSON
Schema (`target: "openapi-3.0"`): request keys use schema **input**, `response` uses schema
**output**. `query` → `in: "query"`, `params` → `in: "path"`, `headers` → `in: "header"`; `body`
→ `requestBody` (`application/json`, `$ref` into `components.schemas`); `response` →
`responses["200"]` (`application/json`, `$ref`). Hono-style `:param` paths become OpenAPI
`{param}`.

## Hardcoded behaviors (know these)

- `openapi` is the literal `"3.0.3"`.
- **Path params are always `required: true`** — the schema's own `required` is ignored for path
  parameters.
- **`requestBody.required` is always `true`** regardless of which body fields are required.
- Only a **`200` "Success"** response is generated — no 4xx/error responses.
- Media type is fixed to `application/json`.
- No `servers`, `securitySchemes`, or `tags` are emitted.
- A contract schema that does **not** implement Standard JSON Schema (a runtime-only validator)
  does **not** fail the export — the offending route is **skipped** with a single
  `console.warn("[Raven OpenAPI] Skipped <method> <path>: <reason>")`. The document still
  returns, missing that path. The only signal is stderr. (See contract serialization in
  [`schema-and-contract.md`](./schema-and-contract.md).)

## Caching

The document is cached behind a dirty flag. Every `addRoute` (including the export route itself)
marks it dirty, so newly registered contract routes trigger a rebuild on next read. Warnings are
replayed only when the document is rebuilt — if a cached (clean) document is returned, the
`console.warn` lines are not reprinted.

> The export route is registered via `app.get(path)`, so it participates in normal route-conflict
> detection. Exporting at a path that is already registered (or registering a route at the export
> path afterwards) throws a `Route conflict` — see route conflicts in
> [`gotchas.md`](./gotchas.md).

## `buildOpenAPIDocument` (standalone)

`buildOpenAPIDocument(routes, options?)` is the pure function behind the method. It takes a list
of registered routes and returns `{ document, warnings }` — it never throws; a route that fails
to materialize is collected into `warnings` and skipped (a route with no contract is skipped
without a warning). Exported from the package root if you need to build a document outside the
app's served route.

For cross-project or external API consumers, prefer exposing OpenAPI from the app composition
root with `app.exportOpenAPI(...)` rather than importing backend source directly. The exported
document reflects exactly the contract routes registered on the current app instance.
