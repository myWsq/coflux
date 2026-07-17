---
name: raven-use
description: Learn RavenJS from this skill's own bundled reference and write correct @raven.js/core code — confirm the package resolves, study the self-contained reference (API surface, request lifecycle, ambient state/DI, schema & contract, plugins, OpenAPI, gotchas) plus the layered pattern docs, plan the structure, implement, then self-check. Use when creating or editing RavenJS servers, routes, handlers, hooks, validation, ambient state, contracts, plugins, or query/DTO code.
compatibility: Requires @raven.js/core (npm) installed so the code you write can import it. This skill ships ALL teaching docs itself and does NOT read documentation from node_modules. For exact, version-matched type signatures, consult node_modules/@raven.js/core/dist/index.d.mts.
---

# RavenJS Use Skill

A workflow for writing correct RavenJS code: confirm the package, learn from this skill's
bundled reference, plan the structure, write, then self-check.

RavenJS is a normal npm dependency (`@raven.js/core`, on a `hono` peer). This skill is
**self-contained**: every concept, API, lifecycle detail, gotcha, and layered pattern rule
ships inside this skill's `reference/` directory. The npm package itself ships only compiled
code, types, and a thin README — it no longer carries teaching docs. So do **not** look for
`GUIDE.md` / `PLUGIN.md` in `node_modules`; learn from `reference/` here, and use the
installed package only to (a) confirm it resolves and (b) check exact type signatures in
`dist/index.d.mts`.

## Step 0 — Make sure the package is installed

Your code imports from `@raven.js/core` (with `hono` as its peer), so it must be installed in
the target project. Verify that however you see fit; if it is not installed, stop and tell the
user to install it per the npm package README Quick Start (`@raven.js/core` + `hono`, plus
`@hono/node-server` for Node) before writing any code.

The installed package ships compiled code and types only — **no teaching docs**. When you need an
exact, version-matched type signature, read `dist/index.d.mts` inside the installed package;
learn everything else from this skill's `reference/`.

## Step 1 — Learn from this skill's bundled reference

Do not rely on prior knowledge of RavenJS — APIs and behaviors are exact and easy to
misremember. The bundled `reference/` has two groups; read what your task touches.

**API & runtime knowledge** (in [`reference/api/`](./reference/api/)) — read what your task touches:

- [`api/overview.md`](./reference/api/overview.md) — public API surface (the real `index.ts`
  exports), the source concept map, and the core concepts (Raven, Context, DI, Schema,
  Contract, Plugin).
- [`api/lifecycle.md`](./reference/api/lifecycle.md) — build lifecycle (`register` → `ready` →
  `FetchHandler`) and request lifecycle (two-layer AsyncLocalStorage, hook order, strict HEAD,
  query last-value-wins, the three error paths).
- [`api/state-and-di.md`](./reference/api/state-and-di.md) — `ScopedState`, `AppState` /
  `RequestState`, built-in states, scopes, and the two write paths (`StateSetter` vs internal).
- [`api/schema-and-contract.md`](./reference/api/schema-and-contract.md) — `withSchema`,
  request/response validation, `defineContract`, `SchemaClass`, and the type-direction rules.
- [`api/plugins.md`](./reference/api/plugins.md) — `definePlugin`, `register` / `use` /
  `onLoaded`, and the four state-ownership patterns.
- [`api/openapi.md`](./reference/api/openapi.md) — `exportOpenAPI` / `getOpenAPIDocument` /
  `buildOpenAPIDocument` and what does (and does not) appear in the document.
- [`api/gotchas.md`](./reference/api/gotchas.md) — the framework-level traps and runtime
  anti-patterns; this is also the framework half of the Step 4 self-check.

**Layered pattern methodology** (in [`reference/`](./reference/)) — for organizing business code:

- Business code (`interface`, `entity`, `repository`, `command`, `query`, `dto`, query-result
  mapping) → [`reference/overview.md`](./reference/overview.md), then the relevant sections of
  [`reference/layer-responsibilities.md`](./reference/layer-responsibilities.md),
  [`reference/conventions.md`](./reference/conventions.md), and
  [`reference/anti-patterns.md`](./reference/anti-patterns.md).
- Runtime assembly (`app.ts`, plugins, states, scopes, hooks, serve) →
  [`reference/runtime-assembly.md`](./reference/runtime-assembly.md), then
  [`reference/anti-patterns.md`](./reference/anti-patterns.md) before finishing.

There are two "anti-pattern" docs, by layer: `api/gotchas.md` covers **framework-runtime** traps
(ambient state, hook scope, HEAD/404, validation/error mapping, response fail-open, scopes);
`anti-patterns.md` covers **business-layer** smells (entity/repository/contract boundaries).

**Engine boundary**: RavenJS 3.x runs on a **Hono** engine, but Hono's context `c` is an
internal detail. Handlers receive only the validated `{ body, query, params, headers }` (via
`withSchema`) and read everything else through ambient state (`RavenContext`,
`AppState` / `RequestState`). Never write code that expects a Hono `c` parameter.

Do not stop until both the relevant API/runtime path and the relevant pattern path are complete.

## Step 2 — Make a Pattern Plan

Before editing files, classify the task into one of these shapes:

- `object style service`
- `simple write`
- `reusable write`
- `complex read`
- `runtime assembly`

Write down a short Pattern Plan before touching files. It must answer:

- which task shape applies
- which layers are required, and which are explicitly not needed
- which files/directories to create or update
- whether each reusable dependency is runtime state, an `Object Style Service`, or a
  specialized form (`Repository` / `Command` / `Query`)
- where business rules, persistence, query logic, hooks, and plugins belong

## Step 3 — Write the code

Apply the Pattern Plan and the reference. Import runtime APIs from the package root, and author
frontend-safe contracts from the `/contract` subentry:

```ts
// handler / app code (server-only)
import { Raven, withSchema, registerContractRoute, defineAppState } from "@raven.js/core";
// contract.ts (must stay frontend-safe — import only from the contract subentry)
import { defineContract, type InferContractBodyInput } from "@raven.js/core/contract";
```

Follow the reference's concepts, gotchas, anti-patterns, and examples exactly. In particular:

- Handlers receive only `{ body, query, params, headers }` and read other request data via
  ambient state — never expect a Hono `c`.
- A failed **request** schema validation throws `ValidationError`, which is **not** a
  `RavenError`; without an `onError` hook that maps it, it falls through to a generic **500**,
  not a 400. Only a malformed JSON body auto-yields a 400. (See `api/schema-and-contract.md`.)
- Only routes registered via `registerContractRoute` (carrying a contract) appear in the
  exported OpenAPI document; plain `app.get/post/...` routes are silently skipped.
- Confirm any uncertain signature against `dist/index.d.mts` in the installed package.

## Step 4 — Run a pattern self-check

Before finishing, review the changed code against both halves of the self-check:

- Framework-level — [`reference/api/gotchas.md`](./reference/api/gotchas.md): ambient-state
  context rules, hook scope, HEAD/404 behavior, validation/error mapping, response fail-open,
  scoped reads using `.in(scopeKey)`, `onError` returning a `Response`.
- Business-layer — [`reference/anti-patterns.md`](./reference/anti-patterns.md) and
  [`reference/conventions.md`](./reference/conventions.md). At minimum verify:
  - entities and repositories did not import Raven runtime APIs without a strong reason
  - hooks and plugins did not absorb business logic that belongs elsewhere
  - ordinary reusable helpers were not turned into `AppState` when an `Object Style Service`
    was enough
  - new files follow the expected naming and placement rules

## Guardrails

- Confirm `@raven.js/core` resolves at the start of every invocation.
- Do not rely on prior knowledge — this skill's `reference/` is the source of truth for API,
  lifecycle, gotchas, file structure, and boundary rules. Use the installed package's
  `dist/index.d.mts` only to confirm exact type signatures.
- Do not read teaching docs from `node_modules/@raven.js/core` — they are not shipped there.
- Do not edit files inside `node_modules/@raven.js/core` (the framework is an installed
  dependency, not project source).
- Do not write code until the relevant API/runtime reference and the relevant pattern
  reference have been read.
