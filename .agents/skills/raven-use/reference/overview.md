# RavenJS Entity-Centric Pattern — Reference

Pattern reference for the `raven-use` skill: where business-facing RavenJS code belongs. This is the entrypoint of the reference set; the topic docs below go deeper.

**Scope**: business-facing RavenJS code structure — `interface`, `service`, `entity`, `repository`, `command`, `query`, `dto`, and query-result mapping. Use it to decide where code belongs before generating code.

## Reading Guide

- Overview: this file
- [Layer Responsibilities](./layer-responsibilities.md): contract, handler, object style service, DTO, entity, repository, command, and query rules
- [Runtime Assembly](./runtime-assembly.md): plugins, `AppState`, `RequestState`, lifecycle placement, and composition root
- [Conventions](./conventions.md): directory layout, naming, and lightweight extension rules
- [Anti-Patterns](./anti-patterns.md): common mistakes and review smells

## Purpose

This pattern adapts a lightweight entity-centric server architecture to RavenJS.

It keeps the original design's core ideas:

- `Interface` as the organization unit for inbound APIs
- `Object Style Service` as the default module shape for reusable service capability
- `Entity` as the carrier of business rules
- `Repository` as the Object Style Service specialized for direct persistence logic
- `Command` as the abstraction for reusable write workflows
- `Query` as the abstraction for complex reusable queries
- `DTO` as the schema atom source, preferably declared with `SchemaClass`, including named read result shapes when a query needs one

It adds RavenJS-specific interface guidance:

- `contract.ts` as the only source of transport contract and route metadata
- `handler.ts` as the only place that binds `withSchema(contract.schemas, ...)` to orchestration code
- `registerContractRoute(...)` as the recommended route registration helper inside `<app_root>/app.ts`

It also keeps one RavenJS-specific layer:

- `Runtime Assembly` for app composition, plugin wiring, state injection, lifecycle hooks, and error mapping

The goal is to keep business code pure while still fitting RavenJS's real architecture:

- plugins for reusable runtime composition
- plugin-local `AppState` / `RequestState`
- `defineContract()` for frontend-safe transport contract reuse
- `withSchema()` for transport validation and optional response shaping
- `registerContractRoute()` for explicit route registration in the composition root
- clear repository/query boundaries:
  `Repository` handles entity persistence,
  `Command` orchestrates reusable write workflows,
  `Query` owns complex reusable reads,
  and `DTO` remains the external contract plus any named read result model

## Core Idea

RavenJS is not a traditional "controller + service + repository" framework.

Its real runtime model is:

- a logic-layer app
- direct route registration in `<app_root>/app.ts`
- plugin-based runtime composition
- lifecycle-driven request processing
- scoped state injection

Compared with a traditional service layer built around container-injected singleton classes, RavenJS lets independent functions read ScopedState on demand. When several related functions belong together, group them into one exported object. This is the default RavenJS service shape: `Object Style Service`.

`Repository` is one named `Object Style Service`: it is the version whose responsibility is specifically `Entity <-> DB`.

Here `<app_root>/` means the directory that contains all Raven app code. It is usually `src/`, but the pattern does not require that exact directory name.

So the RavenJS-friendly version of this architecture is:

```text
Interface Unit
  -> contract.ts owns method / path / schemas
  -> handler.ts owns withSchema(contract.schemas, ...) + orchestration
  -> simple write path: uses Entity + Repository
  -> reusable write path: uses Command
  -> query path: uses Query + DTO / explicit result mapping
  -> frontend may import contract value directly

Entity
  -> owns write-side entities and repositories
  -> contains business rules

Command
  -> orchestrates multi-entity write workflows
  -> may define transaction boundaries

Query
  -> holds complex reusable SQL / ORM queries
  -> returns DTO or DTO-ready result data

Runtime Assembly
  -> assembles <app_root>/app.ts
  -> provides infra dependencies
  -> writes request context state
  -> registers routes through registerContractRoute(...)
  -> maps framework errors to HTTP responses
```

This keeps business concepts stable and keeps Raven-specific concerns in one place.

## Agent-First Boundary Rules

When an Agent is deciding where logic belongs, use this order:

```text
1. Can the request be parsed and shaped safely?
   -> contract schema / transport validation

2. Does the rule still matter after HTTP disappears?
   -> Entity / domain invariants

3. Is the database enforcing storage-specific constraints?
   -> Repository / DB / persistence constraints
```

Use these fixed meanings:

- `transport validation`: request-source splitting, field shape, parsing, coercion, and basic format checks
- `domain invariants`: business meaning, state transitions, lifecycle rules, and cross-field domain constraints
- `persistence constraints`: uniqueness, foreign keys, and other storage-level constraints

Short rule for Agents:

- contract schema checks shape
- entity decides business meaning
- repository persists explicit state

If a rule would still apply for queue, cron, script, or test-created input after HTTP disappears, it belongs in the entity.

## Object Style Service / Repository / Command / Query Boundary

The core tension of this pattern is not read/write separation.

It is keeping each reusable capability small and stable while still giving persistence, write orchestration, and read queries clear homes.

`Object Style Service` is not a separate architectural layer.

It is RavenJS's default reusable module shape:

- group related functions into one exported object
- let each function read ScopedState on demand when needed
- do not introduce singleton service class injection by default

Use this split:

```text
Object Style Service
  -> groups related reusable functions
  -> may read ScopedState on demand

Repository
  -> Object Style Service specialized for Entity <-> DB

Command
  -> Object Style Service specialized for reusable write workflows

Query
  -> Object Style Service specialized for reusable read models
  -> returns DTO or DTO-ready result data
```

Rules:

- start with `Object Style Service` when you need a cohesive reusable capability
- an `Object Style Service` may read ScopedState directly inside its functions; it does not need constructor injection or container registration by default
- if the responsibility is specifically `Entity <-> DB`, call it `Repository`
- `Repository` only mediates `Entity <-> DB`
- `Repository.save(...)` should persist the entity's already-explicit state, not assign business-visible fields implicitly as a side effect
- if a write workflow spans multiple entities and is worth reusing, use `Command`
- `Repository` may query, but only when the result is still that model itself
- if the result is cascading, aggregated, joined, or otherwise no longer "the model itself", use `Query + DTO` or explicit result mapping
- not every write workflow needs a `Command`
- only extract a `Command` when the write logic is both reusable and beyond a single entity path
- not every SQL statement needs a `Query`
- only extract a `Query` when the SQL is both complex and worth reusing
- DTO remains the external contract at the interface boundary

## Core Concepts

| Concept                | Responsibility                                                                  | RavenJS Mapping                                                                         |
| ---------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `Interface Unit`       | One API entrypoint, including transport contract, handler, and route metadata   | one entrypoint directory + `XxxContract` + `XxxHandler` + `registerContractRoute(...)`  |
| `Object Style Service` | Cohesive reusable function surface                                              | top-level functions + trailing object export; may read ScopedState on demand            |
| `Entity`               | Pure in-memory business model and behavior                                      | plain TypeScript class/value object                                                     |
| `Repository`           | `Object Style Service` for an entity's persistence and hydration                | object module beside entity, reading infra via ScopedState when needed                  |
| `Command`              | `Object Style Service` for reusable write orchestration                         | object or function collection                                                           |
| `Query`                | `Object Style Service` for reusable read logic                                  | object or function collection returning DTO or DTO-ready result data                    |
| `DTO`                  | Schema atom, TS type, entity-to-JSON mapper / named read result shape           | `SchemaClass` + runtime `Schema` + mapper                                               |
| `Infra`                | Database client, external gateway, cache, mailer                                | plain technical adapters                                                                |
| `Runtime Assembly`     | Composition root, plugins, colocated states, hooks, explicit route registration | `definePlugin`, plugin-local `AppState`, `RequestState`, `registerContractRoute`, hooks |

## Architecture

```text
┌──────────────────────────────────────────────────────────────┐
│                      Runtime Assembly                        │
│                                                              │
│  <app_root>/app.ts                                           │
│  <app_root>/plugins/                                         │
│  <app_root>/scopes.ts (optional)                             │
│                                                              │
│  register infra plugins                                      │
│  register context plugins                                    │
│  registerContractRoute(...)                                  │
│  register global error mapping                               │
└───────────────┬──────────────────────────────────────────────┘
                │
                ▼
┌──────────────────────────────────────────────────────────────┐
│                       Interface Unit                         │
│                                                              │
│  interface/create-order/                                     │
│    create-order.contract.ts                                  │
│    create-order.handler.ts                                   │
└───────────────┬──────────────────────────────┬───────────────┘
                │                              │
                ▼                              ▼
┌──────────────────────┐  ┌──────────────────────┐  ┌──────────────────────┐  ┌──────────────────────┐
│        Entity        │  │       Command        │  │        Query         │  │         DTO          │
│                      │  │                      │  │                      │  │                      │
│  order/              │  │  submit-order...ts  │  │  list-order.query.ts │  │  order.dto.ts        │
│  order-item/         │  │  pay-order...ts     │  │  search-order...ts   │  │  order-item.dto.ts   │
│  user/               │  │                      │  │                      │  │  paged-order-id...   │
└────────────┬─────────┘  └────────────┬─────────┘  └────────────┬─────────┘  └────────────┬─────────┘
             │                         │                         │                           │
             └─────────────────────────┴─────────────────────────┴──────────────┬────────────┘
                                                                                 ▼
┌──────────────────────────────────────────────────────────────┐
│                           Infra                              │
│                                                              │
│  sql client / external gateway / cache / mailer              │
└──────────────────────────────────────────────────────────────┘
```

## Default Flow

### Write Path

1. `contract.ts` declares `method`, `path`, and transport schemas.
2. `handler.ts` binds `withSchema(contract.schemas, ...)`.
3. Handler either constructs an entity directly or delegates to a `Command`.
4. Entity owns the business rule transitions.
5. Repository persists the entity's current explicit state.
6. Handler maps the final result to a DTO and either returns that DTO through `withSchema(...response)` or builds a manual `Response` when HTTP details must be customized.
7. `<app_root>/app.ts` registers the route with `registerContractRoute(app, Contract, Handler)`.

### Read Path

1. `contract.ts` declares query / params / headers schema and optional response schema.
2. `handler.ts` performs orchestration with validated schema output.
3. Handler calls a `Query` when the read is complex and reusable.
4. Query returns a DTO or DTO-ready result data.
5. Handler returns that DTO directly or performs the final DTO mapping.
6. same-project frontend may reuse the same raw contract value for `method`, `path`, `schemas`, and type inference.

## Adoption Rules

- Keep `contract.ts` as the only source of transport contract and route metadata.
- If `contract.ts` is imported directly by frontend, keep it frontend-safe. It must not import Raven runtime, state, hooks, or other server-only modules.
- Keep `handler.ts` schema-aware and business-light.
- Keep request schema focused on transport validation, not domain invariants.
- Keep entity code pure TypeScript.
- Keep entity as the single home for entrypoint-independent business rules.
- Keep repository focused on entity persistence and hydration.
- Prefer invariants that are explicit in code before persistence; avoid patterns that require `save()` to backfill ids or similar fields invisibly.
- Use `Command` only for reusable multi-entity write workflows.
- Use `Query + DTO` or explicit result mapping only for complex reusable reads.
- Keep `DTO` as the transport contract at the boundary.
- Keep RavenJS-specific concerns inside runtime assembly.
- Prefer `Object Style Service` for reusable helpers and service capabilities.
- Treat `Repository` as one named `Object Style Service`, not as an unrelated pattern to imitate indirectly.
- Keep ordinary helpers, services, and repositories as plain object exports unless Raven runtime must manage them through `State`.
- Let same-project frontend import raw contract value directly when that source tree stays frontend-safe. For external API consumers, prefer exposing OpenAPI from the app composition root with `app.exportOpenAPI(...)`. Do not make frontend depend on `handler.ts`.

## Next Read

- If you are shaping handlers or deciding where logic belongs, read [Layer Responsibilities](./layer-responsibilities.md).
- If you are wiring plugins, states, hooks, or the app entrypoint, read [Runtime Assembly](./runtime-assembly.md).
- If you are naming files, arranging folders, or choosing lightweight extensions, read [Conventions](./conventions.md).
- If you are reviewing for common mistakes or design smells, read [Anti-Patterns](./anti-patterns.md).
