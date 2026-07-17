# Anti-Patterns — Reference

Compact reference for common design mistakes when applying the RavenJS entity-centric pattern. See [overview](./overview.md) for the big picture.

**Scope**: review and final self-check — catch boundary mistakes before finishing a change.

## 1. Entity Imports Raven APIs

Bad:

- entity imports `RavenContext`
- repository imports `BodyState`
- entity method returns `Response`

Why it is wrong:

- entity layer becomes framework-coupled
- tests get heavier
- reuse gets harder

## 2. `Object Style Service` Hidden Behind Class + `AppState`

Bad:

- registering a repository into `AppState` even when it is just an `Object Style Service` for persistence
- writing a reusable helper/service as a singleton class and then registering it into `AppState()` only because it is shared
- handler requires a large manual `deps` object for ordinary Raven runtime dependencies

Why it is wrong:

- it adds ceremony without buying much
- it turns an ordinary module into fake runtime state
- it hides a simple object module behind unnecessary class and plugin ceremony
- it fights Raven's natural State-based DI style for the dependencies that truly need it

Prefer:

- keep ordinary reusable modules as direct `Object Style Service` exports
- treat `Repository` as one named `Object Style Service`, not as a special excuse to introduce state
- reserve `AppState` / `RequestState` for dependencies that Raven runtime must initialize, scope, or refresh

## 3. Business Logic in Hooks

Bad:

- order confirmation logic in `beforeHandle`

Why it is wrong:

- hooks should prepare context, not replace entity behavior

## 4. Write Handler Bypasses Entity Rules

Bad:

- write handler updates business state with raw SQL and skips entity behavior

Why it is wrong:

- business rules become duplicated and transport-bound

Allowed:

- simple one-off SQL may stay in the handler
- reusable write workflows should move into `Command`
- complex reusable queries should move into `Query + DTO` or explicit result mapping

## 5. Business Rules in Request Schema

Bad:

- using request schema `refine()` or async validation to encode domain invariants
- querying a repository or gateway from request schema
- relying on schema transforms so the handler can skip entity creation or entity mutators

Why it is wrong:

- transport validation and business meaning become mixed together
- business rules become tied to HTTP instead of applying across queue, cron, script, or tests
- Agents lose a stable rule for deciding whether logic belongs in schema or entity

Use this test:

- if the rule still matters after HTTP disappears, it belongs in the entity

Prefer:

- keep request schema for shape, parsing, coercion, and basic format checks
- put domain invariants and state transitions in `Entity.create(...)` or entity methods
- let handlers orchestrate, not redefine business rules

## 6. Massive All-in-One Plugin

Bad:

- one plugin owns database, auth, billing, user, and all routes

Why it is wrong:

- composition becomes opaque
- reuse and scoped state isolation get harder

Related smell:

- moving ordinary route registration into plugins without gaining reuse or isolation

## 7. Using `onRequest` for Route-Aware Logic

Bad:

- auth logic in `onRequest` that depends on `params.id`

Why it is wrong:

- route context is not fully assembled there
- use `beforeHandle` instead

## 8. Repository `save()` Mutates Business Fields Implicitly

Bad:

- `save()` assigns `entity.id`, timestamps, or other business-visible fields as a hidden side effect
- DTO mapping relies on `save()` having mutated the same entity instance behind the scenes

Why it is wrong:

- business invariants become implicit instead of visible in code
- mappers and handlers need non-null assertions or lifecycle knowledge to look safe
- persistence and domain state changes get coupled in a way that is harder to reason about

Prefer:

- assign ids and other create-time defaults explicitly during forward construction
- let `save()` persist the current explicit state
- if persistence-generated values must be observed, expose them via an explicit reload or hydration step

## 9. Frontend Imports `handler.ts` or Root Server Entry

Bad:

- frontend imports `CreateOrderHandler`
- frontend imports `@raven.js/core` root entry just to reach contract metadata
- `contract.ts` imports Raven runtime modules, state, or hooks

Why it is wrong:

- frontend and backend stop sharing the real contract value cleanly
- `contract.ts` can no longer stay frontend-safe
- contract reuse falls back to copied path strings or type-only imports

Prefer:

- keep `contract.ts` as the only source of `method`, `path`, and `schemas`
- import `defineContract` and `InferContract*` from the frontend-safe contract helper entry
- let frontend import contract value directly and let backend keep runtime concerns in `handler.ts` and `app.ts`

## 10. Single-File Interface or `index.ts` Aggregation by Default

Bad:

- `create-order.interface.ts` contains route metadata, schema, and handler in one file
- `interface/create-order/index.ts` re-exports contract and handler as a hidden aggregation layer

Why it is wrong:

- contract ownership becomes ambiguous
- Agents lose a stable rule for deciding whether a change belongs in `contract.ts`, `handler.ts`, or `app.ts`
- frontend-safe reuse gets harder because the visible import path no longer clearly points to the contract source

Prefer:

- one entrypoint directory per interface
- exactly one `{entry}.contract.ts` plus one `{entry}.handler.ts`
- route registration in `<app_root>/app.ts` through `registerContractRoute(...)`
