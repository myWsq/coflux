# Schema & Contract — Reference

**Scope**: `withSchema`, request/response validation behavior, `SchemaClass`, `defineContract`,
`registerContractRoute`, and the type-direction rules. This is the API behind the layered
interface pattern — for _where_ contract/handler files live and how to split them, see
[`../layer-responsibilities.md`](../layer-responsibilities.md).

## Standard Schema validation

RavenJS validation is **Standard Schema**-based, so it is schema-library agnostic — Zod,
Valibot, and any Standard Schema-compatible library work the same way. The core depends on
**no** specific validation library.

`withSchema(schemas, handler)` declares schemas for `body` / `query` / `params` / `headers` /
`response`. At request time the framework validates the request schemas during `processStates`,
writes the validated output back into the built-in states, and passes a typed `ctx` (`{ body,
query, params, headers }`) to the handler. `withSchema` itself does **no** validation — it just
returns a branded wrapper (`{ __ravenSchemaHandler: true, schemas, handler }`); validation runs
during route dispatch.

```ts
import { Raven, withSchema, isValidationError } from "@raven.js/core";
import { z } from "zod";

const app = new Raven();

app.post(
  "/users",
  withSchema(
    {
      body: z.object({ name: z.string() }),
      response: z.object({ id: z.number(), name: z.string() }),
    },
    async (ctx) => ({ id: 1, name: ctx.body.name }), // returns the response schema INPUT type
  ),
);
```

These schemas are **transport validation** (shape, parsing, coercion, basic format). Keep domain
invariants in entities — do not encode business rules in request schema (no `refine()` for
business meaning, no repository/gateway calls from a schema). See
[`../anti-patterns.md`](../anti-patterns.md).

### Two overloads

- **No `response`** → the handler must return a `Response` (`SchemaHandler`).
- **`response` declared** → the handler returns the **response schema input type**; core
  validates it and serializes the output with `Response.json(...)`. (Returning a DTO without a
  declared `response` schema is a type error.)

### Validated output is written back into state

Each request schema's **output** (after coercion/transform) is written into the built-in states
_before_ `beforeHandle` runs, so hooks and the handler observe the transformed value:

```ts
// query: z.object({ page: z.string().transform(Number) })
app.beforeHandle(() => {
  const { page } = QueryState.getOrFailed() as { page: number };
  page; // number, already transformed
});
```

The handler's `ctx` reads the built-in states live, so changes made in `beforeHandle`/
`processStates` are reflected. `ParamsState`/`QueryState`/`HeadersState` are always written;
`BodyState` is only written when the validated body is not `undefined`. With an empty schema
`{}`, `ctx.body` is `undefined` but `ctx.query` is `{}`.

## Validation failure behavior — the two cases differ sharply

### Request validation failure → throws, default **500** (not 400)

A failed request schema throws a single aggregated `ValidationError` carrying source-specific
issues (`bodyIssues` / `queryIssues` / `paramsIssues` / `headersIssues`). It propagates to
`onError`. **`ValidationError` is not a `RavenError`**, so without an `onError` hook that maps
it, `handleError` falls through to the generic **500** branch — **not** a 400. You must map it:

```ts
app.onError((error) => {
  if (isValidationError(error)) {
    return Response.json({ issues: error.bodyIssues }, { status: 400 });
  }
});
```

The only failure that auto-yields a true **400** is a malformed JSON body, which throws
`RavenError.ERR_BAD_REQUEST` (status 400) during body parsing.

### Response validation failure → fail-open, returns the raw value with **200**

If a schema-aware handler's return value fails its `response` schema, the framework does **not**
throw and does **not** call `onError`. It returns the handler's **original unvalidated value** as
`200` JSON and notifies `onResponseValidationError({ error, value })`:

```ts
app.onResponseValidationError(({ error, value }) => {
  console.error("Response schema mismatch", error.responseIssues, value);
});
```

This hook is **observe-only** — its exceptions are swallowed (logged), and it cannot change the
response. So a schema-violating response still reaches the client; the hook is your only signal.
Treat `response` validation as defensive observability, not a guarantee.

## `SchemaClass`

`SchemaClass(shape)` builds a class for **DTO-style type inference only** — it performs **no**
runtime validation. It `Object.assign`s the constructor input onto the instance and exposes the
original shape as `_shape` (static and instance). Construction input uses each schema's **input**
type; instance fields use the **output** type. An invalid value (e.g. `age: -1`) is stored as-is.

```ts
import { SchemaClass } from "@raven.js/core";
import { z } from "zod";

class OrderDTO extends SchemaClass({
  id: z.string(),
  userId: z.string(),
  totalAmount: z.number(),
}) {
  static fromEntity(order: OrderEntity) {
    return new OrderDTO({ id: order.id, userId: order.userId, totalAmount: order.totalAmount });
  }
}
```

Use `OrderDTO._shape` to reuse schema atoms, and build a real runtime schema
(`z.object(OrderDTO._shape)`) only at the point where actual validation is needed — e.g. inside
`withSchema`. For DTO placement and mapping rules, see
[`../layer-responsibilities.md`](../layer-responsibilities.md).

## Contract-first interface

A contract is a **serializable plain value** holding `method`, `path`, and `schemas` together.
Author it with `defineContract` (an identity helper that captures literal types — it does no
runtime work). `HttpMethod` is `GET | POST | PUT | DELETE | PATCH` — **no** HEAD/OPTIONS.

Author `contract.ts` against the **frontend-safe** `@raven.js/core/contract` subentry (its module
graph pulls in no runtime), so same-project frontend code can import the contract value directly:

```ts
// interface/create-order/create-order.contract.ts  (frontend-safe)
import { defineContract, type InferContractBodyInput } from "@raven.js/core/contract";
import { z } from "zod";

export const CreateOrderContract = defineContract({
  method: "POST",
  path: "/orders",
  schemas: {
    body: z.object({ quantity: z.string().transform((v) => Number(v)) }),
    response: z.object({ id: z.string(), quantity: z.number() }),
  },
});

export type CreateOrderInput = InferContractBodyInput<typeof CreateOrderContract>;
```

```ts
// interface/create-order/create-order.handler.ts  (server-only)
import { withSchema } from "@raven.js/core";
import { CreateOrderContract } from "./create-order.contract.ts";

export const CreateOrderHandler = withSchema(CreateOrderContract.schemas, async (ctx) => ({
  id: "order_1",
  quantity: ctx.body.quantity, // number, already transformed
}));
```

```ts
// <app_root>/app.ts  (server-only)
import { registerContractRoute } from "@raven.js/core";
registerContractRoute(app, CreateOrderContract, CreateOrderHandler);
```

Same-project frontend reuses the raw contract value:

```ts
import {
  type InferContractBodyInput,
  type InferContractResponseOutput,
} from "@raven.js/core/contract";
import { CreateOrderContract } from "../../backend/src/interface/create-order/create-order.contract.ts";

type Input = InferContractBodyInput<typeof CreateOrderContract>;
type Result = InferContractResponseOutput<typeof CreateOrderContract>;

export async function createOrder(input: Input): Promise<Result> {
  const res = await fetch(CreateOrderContract.path, {
    method: CreateOrderContract.method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return res.json();
}
```

> Two things named `registerContractRoute`: the **standalone** helper exported from
> `@raven.js/core` — `registerContractRoute(app, Contract, Handler)` — is the recommended form
> and just delegates to the instance method `app.registerContractRoute(contract, handler)`,
> returning the app. Use the standalone form in docs/app code.

## Type-direction rules (three axes)

This is the central subtlety. Different consumers read different ends of a schema:

| Consumer                              | Request schemas (body/query/params/headers)                 | Response schema                                            |
| ------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------- |
| `InferContract*` (frontend & callers) | **input** (`InferContract{Body,Query,Params,Headers}Input`) | **output** (`InferContractResponseOutput`)                 |
| handler `ctx` / return                | **output** (validated values in `ctx`)                      | **input** for the return value (core serializes to output) |
| OpenAPI materialization               | **input** JSON Schema                                       | **output** JSON Schema                                     |

There is intentionally **only** `InferContractResponseOutput` for responses (no
`InferContract*Output` for request keys, no `InferContractResponseInput`).

## Contract serialization (for OpenAPI)

To appear in an exported OpenAPI document, a contract schema must implement **both** Standard
Schema (for validation) **and** Standard JSON Schema (for serialization) — i.e. a
`CombinedSchemaV1`. A schema that only validates (no `~standard.jsonSchema.input/output`) is
**skipped** during export with a single `console.warn`, and `materializeContractSchema` throws
if called directly on it. Zod/Valibot need their JSON-schema-emitting integration for contract
export to work. See [`openapi.md`](./openapi.md).

## `Context` and `RavenError` (related)

- `Context.body` returns the **raw** `Request` body stream — it does **not** parse JSON. Read a
  JSON body via `ctx.request.json()` or via `BodyState` (which the framework populates). See
  [`state-and-di.md`](./state-and-di.md).
- `RavenError` instances come only from the four static factories (`ERR_BAD_REQUEST`,
  `ERR_UNKNOWN_ERROR`, `ERR_STATE_NOT_INITIALIZED`, `ERR_STATE_CANNOT_SET`). `toResponse()`
  serializes **only** `{ message }` (code/context/cause/stack are hidden from clients);
  `toJSON()` returns the full diagnostic shape for logging. `ERR_STATE_*` have no `statusCode`,
  so their `toResponse()` falls back to 500. Use `isRavenError(error)` in `onError` to branch.
