# Layer Responsibilities — Reference

Reference for where business-facing code lives and what each layer may do. See [overview](./overview.md) for the overall model.

**Scope**: deciding whether logic belongs in `interface`, `object-style-service`, `entity`, `repository`, `command`, `query`, `dto`, or explicit query-result mapping.

## Layer Map

| Layer                  | Owns                                                               | Should Not Own                               |
| ---------------------- | ------------------------------------------------------------------ | -------------------------------------------- |
| `Interface Unit`       | transport validation, orchestration, DTO mapping, response shaping | core business rules                          |
| `Object Style Service` | cohesive reusable function surface, ScopedState-on-demand access   | hidden singleton lifecycle, fake DI ceremony |
| `DTO`                  | transport shape, schema atoms, mapper methods, named read results  | business rules, Raven runtime                |
| `Entity`               | write-side business rules and behavior                             | Raven APIs, request lifecycle                |
| `Repository`           | entity hydration and persistence                                   | reports, aggregate reads, route logic        |
| `Command`              | reusable multi-entity write workflows                              | raw transport output, ad hoc SQL dumping     |
| `Query`                | complex reusable read queries that return DTOs or DTO-ready data   | entity mutation, ad hoc transport ceremony   |
| `Infra`                | technical capabilities such as SQL, mail, cache, gateway, queue    | interface orchestration, transport contract  |

## 1. Interface Unit

An interface unit is the inbound API organization unit.

In RavenJS, the default shape is one directory per interface:

- `interface/{entry}/{entry}.contract.ts`
- `interface/{entry}/{entry}.handler.ts`

Inside that directory:

- `contract.ts` is the only source of `method`, `path`, `schemas`, and contract-related type inference
- request schemas are defined by source: `body`, `query`, `params`, `headers`
- `response` is defined from DTO schema atoms when the route returns default JSON
- `handler.ts` exports `XxxHandler`, usually through `withSchema(Contract.schemas, ...)`
- `<app_root>/app.ts` registers the route through `registerContractRoute(app, Contract, Handler)`

The handler does:

1. perform transport validation on input
2. for entity paths, construct or load entities
3. for entity paths, call entity behavior or invoke a command
4. persist through repository, invoke a command, or execute a query
5. map to DTO
6. either return the DTO through `withSchema(...response)` or build a manual `Response` when status / headers must be customized

The handler does not own core business rules.

Agent-first rule:

- if the rule still matters after HTTP disappears, it is not interface logic
- if the rule is about request shape, parsing, coercion, or basic format, it can stay in schema
- if the rule is about business meaning, state transitions, or entrypoint-independent invariants, it belongs in the entity

Repository/query rule at the interface layer:

- if you need an `Entity`, go through `Repository`
- if a reusable write workflow spans multiple entities, go through `Command`
- if you need a reusable complex query result, go through `Query + DTO` or explicit result mapping
- simple one-off SQL may stay in the handler
- do not create a `Command` unless the write workflow is both reusable and beyond a single entity path
- do not create a `Query` unless the SQL is both complex and worth reusing
- DTO is still required at the interface boundary

Recommended contract-first shape:

```ts
// interface/create-order/create-order.contract.ts
import { defineContract, type InferContractBodyInput } from "@raven.js/core/contract";
import { z } from "zod";

export const CreateOrderContract = defineContract({
  method: "POST",
  path: "/orders",
  schemas: {
    body: z.object({
      userId: z.string(),
      items: z.array(
        z.object({
          productId: OrderItemDTO._shape.productId,
          productName: OrderItemDTO._shape.productName,
          unitPrice: OrderItemDTO._shape.unitPrice,
          quantity: OrderItemDTO._shape.quantity,
        }),
      ),
    }),
    response: z.object(OrderDTO._shape),
  },
});

export type CreateOrderInput = InferContractBodyInput<typeof CreateOrderContract>;
```

```ts
// interface/create-order/create-order.handler.ts
import { withSchema } from "@raven.js/core";

import { CreateOrderContract } from "./create-order.contract.ts";

export const CreateOrderHandler = withSchema(CreateOrderContract.schemas, async (ctx) => {
  const order = OrderEntity.create({
    userId: ctx.body.userId,
  });

  for (const item of ctx.body.items) {
    order.addItem(
      new OrderItemEntity(item.productId, item.productName, item.unitPrice, item.quantity),
    );
  }

  order.submit();

  await OrderRepository.save(order);
  return OrderDTO.fromEntity(order);
});
```

```ts
// <app_root>/app.ts
import { registerContractRoute } from "@raven.js/core";

registerContractRoute(app, CreateOrderContract, CreateOrderHandler);
```

Request/response schema rules in RavenJS:

- split request schemas by source: `body`, `query`, `params`, `headers`
- only declare the parts the interface actually needs
- keep `response` beside the request schemas when the route returns default JSON
- reuse DTO fields explicitly from `DTO._shape`
- do not assume request field names must match DTO field names
- pass real runtime schemas to `withSchema()`, not `SchemaClass` itself
- keep request schema limited to transport validation
- do not put domain invariants into request schema
- do not call repository, gateway, or other infra from request schema
- use parsing or coercion only for transport concerns; do not use schema transforms to bypass entity behavior

Contract/handler boundary rules:

- `contract.ts` owns `method`, `path`, `schemas`, and contract inference
- `handler.ts` owns `withSchema(contract.schemas, ...)` and orchestration
- `handler.ts` should not redefine route metadata already present in `contract.ts`
- if frontend imports raw `contract.ts` directly, that file and its dependency tree must stay frontend-safe
- same-project frontend may import contract value directly when it needs `method`, `path`, `schemas`, or request/response inference
- cross-project or external API consumers should prefer OpenAPI exposed from the app composition root via `app.exportOpenAPI(...)`
- frontend should not depend on `handler.ts`

Type-direction rules:

- contract-side request inference reads schema input
- contract-side response inference reads schema output
- handler-side `ctx.body/query/params/headers` read schema output
- handler-side return type for declared `response` schema reads response schema input

If the route needs a custom status code or custom headers, keep the same directory shape but switch the handler back to a manual `Response`:

```ts
// interface/create-order/create-order.handler.ts
import { z } from "zod";

import { CreateOrderContract } from "./create-order.contract.ts";

const response = z.object(OrderDTO._shape);

export const CreateOrderHandler = withSchema(CreateOrderContract.schemas, async (ctx) => {
  const order = OrderEntity.create({
    userId: ctx.body.userId,
  });

  await OrderRepository.save(order);
  const dto = OrderDTO.fromEntity(order);
  return Response.json(response.parse(dto), { status: 201 });
});
```

This keeps the handler:

- schema-aware
- framework-adapted
- Raven-native
- business-light

The business rule still lives in the entity.

In practice:

- `schema` checks shape
- `entity` decides business meaning
- `repository` persists explicit state

Read-query path example:

```ts
export const ListOrderContract = defineContract({
  method: "GET",
  path: "/orders",
  schemas: {
    query: z.object({
      page: z.number(),
      pageSize: z.number(),
    }),
    response: z.object(ListOrderDTO._shape),
  },
});

export const ListOrderHandler = withSchema(ListOrderContract.schemas, async (ctx) => {
  const dto = await ListOrderQuery.execute({
    page: ctx.query.page,
    pageSize: ctx.query.pageSize,
  });

  return dto;
});
```

Command path example:

```ts
export const SubmitOrderContract = defineContract({
  method: "POST",
  path: "/orders/submit",
  schemas: {
    body: z.object({
      orderId: z.string(),
      paymentId: z.string(),
    }),
    response: z.object(OrderDTO._shape),
  },
});

export const SubmitOrderHandler = withSchema(SubmitOrderContract.schemas, async (ctx) => {
  const order = await SubmitOrderCommand.execute({
    orderId: ctx.body.orderId,
    paymentId: ctx.body.paymentId,
  });

  return OrderDTO.fromEntity(order);
});
```

Response schema rule in RavenJS:

- when the route is a default `200 application/json` response, prefer putting `response` into `withSchema(...)` and return the DTO directly
- when the route needs custom HTTP details such as `201`, headers, cookies, or non-JSON responses, keep returning a manual `Response`
- if the response schema mismatches at runtime, Raven triggers `onResponseValidationError` and falls back to the raw `Response.json(dto)` path instead of failing the request

## 2. DTO

DTO stays the single schema atom source.

With `SchemaClass`, the recommended DTO form in RavenJS is no longer "Schema + Type + Mapper" as three fully separate artifacts.

Instead, prefer:

- a DTO class declared with `SchemaClass(...)`
- a runtime `Schema` derived from that DTO shape
- `fromEntity`, `fromEntities`, or read-result mapper methods when mapping is still useful

If a reusable read path needs its own named result model, model it as a DTO under `dto/` instead of creating a separate read-result layer.

Recommended shape:

```ts
import { SchemaClass } from "@raven.js/core";
import { z } from "zod";

class OrderDTO extends SchemaClass({
  id: z.string(),
  userId: z.string(),
  totalAmount: z.number(),
  createdAt: z.string(),
}) {
  static fromEntity(order: OrderEntity) {
    return new OrderDTO({
      id: order.id,
      userId: order.userId,
      totalAmount: order.totalAmount,
      createdAt: order.createdAt.toISOString(),
    });
  }
}

export { OrderDTO };
```

This gives:

- the class itself as the DTO type
- `_shape` as reusable schema atoms
- a full runtime schema can be built only where actual validation is needed

RavenJS note:

- `SchemaClass` is type inference only; it does not validate at runtime
- request validation must still use a real runtime schema with `withSchema()`
- response validation remains optional defensive validation
- avoid relying on `transform`, `coerce`, or `default` inside `SchemaClass` shapes unless a real runtime schema is applied separately
- Zod is a fine default because it works with RavenJS core's built-in Standard Schema validation
- prefer mapper inputs whose invariants are already explicit in code; avoid documenting DTO mapping against entities that still require non-null assertions

DTO rules:

- DTO may aggregate multiple entities
- DTO may nest other DTO schema atoms
- DTO may also model reusable read results such as paged lists, summaries, or search output
- DTO should expose schema atoms through `_shape`
- build `z.object(DTO._shape)` only at the usage site when a full runtime schema is actually needed
- DTO is required for both write responses and read views
- DTO must not import Raven APIs
- DTO is for transport shape, not business rules

`SchemaClass` is a good fit for DTOs because DTOs are mainly declaration and mapping objects.

It is not the right default base for entities, because entities usually need stronger invariants and explicit behavior-focused construction.

## 3. Object Style Service

Object Style Service is RavenJS's default module shape for a cohesive reusable service surface.

Compared with a traditional singleton service injected by a container:

- RavenJS does not require registering ordinary services into state or a DI container
- independent functions can read ScopedState on demand
- if several functions belong together, exporting one object is enough

Rules:

- default shape is a plain object or function collection
- prefer top-level functions plus one trailing object export
- read ScopedState inside each function only where it is actually needed
- do not hide ordinary service behavior behind constructor injection or manual singleton lifecycle
- if the service's responsibility is `Entity <-> DB`, call it `Repository`
- if it becomes reusable write orchestration, call it `Command`
- if it becomes reusable read logic returning DTOs or DTO-ready result data, call it `Query`

Minimal example:

```ts
// order-permission.service.ts
const canManage = async (orderId: string) => {
  const sql = DBState.getOrFailed();
  const currentUser = CurrentUserState.getOrFailed();

  const [row] = await sql`
    select 1
    from orders
    where id = ${orderId} and user_id = ${currentUser.id}
  `;

  return Boolean(row);
};

const ensureManageable = async (orderId: string) => {
  if (!(await canManage(orderId))) {
    throw new Error("forbidden");
  }
};

export const OrderPermissionService = { canManage, ensureManageable };
```

## 4. Entity

The entity layer is the business core for write-side behavior.

In the simplified version here, it mainly contains:

- entities
- repositories

This pattern intentionally uses a simplified, entity-centric model and refers to all business models uniformly as `Entity`.

Rules:

- pure TypeScript only
- no `Request`, `Response`, `RavenContext`, `BodyState`, `AppState`, or hooks
- entity should be a rich model with business behavior, not a data bag
- entity is the default home for domain invariants
- each entity should live in its own module
- repository stays with the entity module that owns write-side persistence
- repository only mediates entity persistence and reverse persistence
- use `static create()` for forward construction from input
- keep the constructor for reverse hydration from persistence
- entity methods usually mutate the current instance
- setter-like methods should usually return `void`
- cross-entity orchestration should not live inside entities

### Forward vs Reverse Construction

Entity creation has two paths, and they should not be mixed.

- forward construction means input -> entity
- reverse construction means database record -> entity

Forward construction should go through `static create(...)`.

Why:

- request input is incomplete and business-oriented
- this is where domain invariants usually belong
- default fields such as `id`, `status`, `createdAt`, `updatedAt` are often assigned here
- if an identifier is needed by downstream mapping or persistence, assign it explicitly here rather than relying on `save()` to mutate the entity later

Reverse construction should go through the constructor.

Why:

- persistence data is already complete
- it is restoring an existing entity, not creating a new business fact
- constructor params usually match storage shape, not request shape
- this path should focus on hydration, not repeat create-time business validation

Typical rule:

- `create(...)` enforces domain invariants and initializes
- `constructor(record)` restores
- `load()` uses the constructor
- handler write paths use `create(...)`

Minimal example:

```ts
// order-item.entity.ts
class OrderItemEntity {
  constructor(
    public readonly productId: string,
    public readonly productName: string,
    public readonly unitPrice: number,
    public readonly quantity: number,
  ) {}

  get amount() {
    return this.unitPrice * this.quantity;
  }
}

export { OrderItemEntity };
```

```ts
// order.entity.ts
import { OrderItemEntity } from "../order-item/order-item.entity";

class OrderEntity {
  public id: string;
  public readonly userId: string;
  public status: "draft" | "submitted";
  public readonly items: OrderItemEntity[];
  public readonly createdAt: Date;
  public updatedAt: Date;

  static create(params: { userId: string }) {
    if (!params.userId) {
      throw new Error("userId is required");
    }

    const now = new Date();
    return new OrderEntity({
      id: crypto.randomUUID(),
      userId: params.userId,
      status: "draft",
      items: [],
      createdAt: now,
      updatedAt: now,
    });
  }

  constructor(record: {
    id: string;
    userId: string;
    status: "draft" | "submitted";
    items: OrderItemEntity[];
    createdAt: Date;
    updatedAt: Date;
  }) {
    this.id = record.id;
    this.userId = record.userId;
    this.status = record.status;
    this.items = record.items;
    this.createdAt = record.createdAt;
    this.updatedAt = record.updatedAt;
  }

  addItem(item: OrderItemEntity): void {
    this.items.push(item);
    this.updatedAt = new Date();
  }

  submit(): void {
    if (this.status !== "draft") {
      throw new Error("order cannot be submitted");
    }

    if (this.items.length === 0) {
      throw new Error("order must contain at least one item");
    }

    this.status = "submitted";
    this.updatedAt = new Date();
  }

  get totalAmount() {
    return this.items.reduce((sum, item) => sum + item.amount, 0);
  }
}

export { OrderEntity };
```

### Repository

Repository is the `Object Style Service` specialized for entity hydration and persistence.

Repository stays beside the owning entity module.

```ts
// order.repository.ts
const load = async (id: string) => {
  const sql = DBState.getOrFailed();
  const [orderRow] =
    await sql`select id, user_id, status, created_at, updated_at from orders where id = ${id}`;

  if (!orderRow) {
    throw new Error("order not found");
  }

  const itemRows = await sql`
    select product_id, product_name, unit_price, quantity
    from order_items
    where order_id = ${id}
  `;

  return new OrderEntity({
    id: orderRow.id,
    userId: orderRow.user_id,
    status: orderRow.status,
    items: itemRows.map(
      (itemRow) =>
        new OrderItemEntity(
          itemRow.product_id,
          itemRow.product_name,
          itemRow.unit_price,
          itemRow.quantity,
        ),
    ),
    createdAt: orderRow.created_at,
    updatedAt: orderRow.updated_at,
  });
};

const save = async (order: OrderEntity) => {
  const sql = DBState.getOrFailed();
  await sql`insert into orders ${sql({
    id: order.id,
    user_id: order.userId,
    status: order.status,
  })}`;
  return order;
};

export const OrderRepository = { load, save };
```

`bulkLoad` and `bulkSave` follow the same pattern.

Repository rules:

- repository is still an `Object Style Service`: plain object or function collection
- use a plain object or function collection, not a class
- keep repository with the owning entity module
- default method set is `load`, `bulkLoad`, `save`, `bulkSave`
- do not expand repository into list/search/report style methods
- if an extra finder is unavoidable, it must still return the model itself
- `load` means the record must exist; if nullable semantics are needed, add a separate `find`
- if a result is no longer the model itself, it belongs to `Query + DTO` or explicit result mapping, not `Repository`
- repository may query, but only when it still returns the model itself
- in RavenJS, repository may directly read infra state such as `DBState`
- do not put request lifecycle logic into repository implementation
- `save` should persist the entity's current explicit state; avoid hidden in-place mutations such as assigning ids or other business-visible fields during persistence
- if persistence-generated data must be observed by the domain model, surface it through an explicit construction/hydration step rather than mutating the same entity instance behind `save()`

Pragmatic RavenJS note:

- `Entity` should stay pure
- `Repository` is one named `Object Style Service`
- `Repository` may be Raven-aware
- if a repository imports `DBState`, treat it as a persistence adapter that lives beside the entity layer, not as a pure entity object
- if a nearby helper does not own `Entity <-> DB`, keep it as `*.service.ts` or another fitting object module instead of naming it repository
- if Raven runtime does not need to own a helper's lifecycle, keep it as an `Object Style Service` instead of turning it into `AppState`

## 5. Command

Command is the home for reusable write workflows.

Use it when one use case:

- writes multiple entities
- coordinates multiple repositories
- needs a clear transaction boundary
- is worth reusing across handlers, jobs, or consumers

Rules:

- Command files are flat and named by write intent, for example `submit-order.command.ts`
- Command orchestrates entities and repositories; it does not replace entity business rules
- Command must not become a SQL container
- Command must not return DTO directly
- Command may return `void`, an `Entity`, multiple entities, or a small result object
- if a write path only touches one entity and is not reused, the handler may stay direct

Minimal example:

```ts
// submit-order.command.ts
const execute = async (params: { orderId: string; paymentId: string }): Promise<OrderEntity> => {
  const order = await OrderRepository.load(params.orderId);
  const payment = await PaymentRepository.load(params.paymentId);

  payment.capture();
  order.submit();

  await PaymentRepository.save(payment);
  await OrderRepository.save(order);

  return order;
};

export const SubmitOrderCommand = { execute };
```

## 6. Query

Query is the home for complex reusable queries.

Rules:

- Query files are flat and named by query intent, for example `list-order.query.ts`
- Query returns DTOs or DTO-ready result data
- if a query result needs a reusable named shape, define it in `dto/`
- Query is for complex and reusable queries
- simple one-off SQL should usually stay in the handler
- Query may return a DTO directly when that DTO is already the intended response contract
- Query must not hydrate Entity directly

Minimal example:

```ts
// list-order.query.ts
const execute = async (params: { page: number; pageSize: number }): Promise<PagedOrderIdDTO> => {
  const sql = DBState.getOrFailed();
  const rows = await sql`
    select id
    from orders
    order by created_at desc
    limit ${params.pageSize}
    offset ${(params.page - 1) * params.pageSize}
  `;

  const [{ count }] = await sql`select count(*)::int as count from orders`;

  return new PagedOrderIdDTO({
    ids: rows.map((row) => row.id),
    total: count,
    page: params.page,
    pageSize: params.pageSize,
  });
};

export const ListOrderQuery = { execute };
```

## 7. Infra

Infra is pure technical capability:

- SQL client
- external HTTP gateway
- cache
- mailer
- queue producer

Infra does not know about handlers, DTO, or Raven lifecycle.

## Runtime-Specific Rules

`Runtime Assembly` is intentionally split into its own document because it is the RavenJS-specific part of the pattern.

Read [Runtime Assembly](./runtime-assembly.md) for:

- plugin ownership
- `AppState` / `RequestState`
- lifecycle placement
- composition root rules
