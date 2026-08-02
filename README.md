# @fookiejs/graphql-server

Hand it a running fookie `App` and get a complete GraphQL server: arbitrarily deep relation traversal
without N+1, snapshot-consistent reads, mutations that report saga signals honestly, and subscriptions
over SSE.

```ts
import { graphqlServer, defaultOptions } from "@fookiejs/graphql-server";

const server = graphqlServer(app, {
  ...defaultOptions(),
  port: ["4000"],
  subscriptions: [{ authorizeRooms: async (headers, rooms) => permittedFor(headers, rooms) }],
});
```

Dependencies are `graphql` (zero transitive deps) and `zod`, with `@fookiejs/core` as a peer. Not yoga,
not apollo, not dataloader.

## Reads go through your model flows

Every read this server issues is an `app.list(...)` call, so it runs the model's list flow — which is
where your authorization and filtering live. A resolver never reaches for SQL, and CI greps for
`.sql(` and `selectRows` in `src` to keep it that way.

## Batching: prefetch, then execute

Not per-field resolvers with a loader. Phase A walks the operation AST into a fetch tree — fragments
flattened, `@skip`/`@include` evaluated, args coerced — keyed by `(edge, argsHash)`. Phase B resolves
**breadth-first, one level at a time**, grouping by `(childModel, edgeKind, fkKey, filterHash)` and
issuing one `list(Child, { fk: { in: chunk } })` per group. Then graphql-js `execute` runs against
resolvers that are pure synchronous lookups into the prefetched store.

Cost is O(depth × distinct edges), independent of row count. graphql-js keeps aliases, non-null
propagation, error paths and introspection; we keep the I/O. The headline test asserts on the driver's
query log that a four-level query issues one `SELECT` **per level, not per row**.

Four failure modes, each with a test:

- An empty `in` list throws inside core, so the batch is skipped and **zero** queries are issued.
- Postgres caps a statement at 65535 parameters, so ids are chunked (`maxInChunk`, default 1000) and
  the chunks run sequentially under the pinned client.
- An identity map keyed `Model:id` means a self-referential cycle costs a bounded number of queries at
  any requested depth.
- `maxDepth` (8) and `maxRows` (50 000) return `QUERY_TOO_LARGE` rather than melting the database.

### The one honest limitation

**A per-parent `limit` on a reverse relation cannot be expressed as a single `IN` query** — `LIMIT`
bounds the batch, not each parent. v1 applies limit/offset/order **in memory** after the batch, so
`books(limit: 10)` under 10 000 authors really does read every book. The fix is a core
`ROW_NUMBER() OVER (PARTITION BY fk ORDER BY ...)`, not a clever workaround here.

## Naming

Forward `author` exposes both `authorId: UUID` and `author: Author`. Reverse edges are synthesized by
inverting the forward list: one FK becomes `books`; two or more (`Message.sender` and
`Message.recipient` both pointing at `User`) become `messagesBySender` and `messagesByRecipient`.

Collisions are **boot errors, never silent renames**, and an FK to an unregistered model is a boot
error naming both the model and the field. Pluralisation is deliberately dumb and overridable.

Filter inputs are generated from core's exported filter-op config, so a GraphQL-accepted filter is by
construction a core-accepted filter and cannot drift. A test imports that table and asserts parity.

## Locking and consistency

Query resolution is wrapped in `withReadSnapshot`, which pins a client and opens
`REPEATABLE READ READ ONLY`. That takes **no locks**, blocks nothing and cannot deadlock. The one
artefact is intentional staleness: **a mutation committed by another client midway through your query
will not appear in the later levels of that query.** That is the guarantee, not a bug — the alternative
is a response assembled from two different states of the database.

A pinned client is single-threaded, so consistency costs latency on a wide query. Set `snapshot: false`
to read committed instead.

**Pool exhaustion is the real operational risk**: one pinned client per in-flight query. The server
carries a concurrency limit for exactly this reason — size it against your pool, not against your
traffic.

## Mutations

`signal: RUNNING` is **data, not an error**. A mutation returns `{ signal, id, runId }` honestly,
including when the saga is still in flight; only thrown validation or database errors become GraphQL
errors. Create inputs are all-required, since core builds a non-partial object; update inputs are all
optional.

## Subscriptions

`Subscription.events(rooms: [String!]!)` over SSE, wire-compatible with `graphql-sse` in
distinct-connections mode.

`authorizeRooms` is **required** — it returns the permitted subset of the requested rooms. Core has no
concept of identity, so an implicit allow-all would be indefensible; omitting it is a boot error, and a
subscriber authorized for no room gets a 403.

Events carry `{ model, operation, id, runId, signal }` and **no payload, deliberately**. A payload
would bypass per-subscriber authorization, so each event costs the client a follow-up query it must
pass the model flow to answer. Delivery is room-targeted and at most once per subscriber no matter how
many of their rooms an event names. A slow client is dropped once its socket buffers past 1 MB rather
than being allowed to back up the process.

## graphql-js is quarantined

graphql-js's surface is saturated with `null`, `undefined`, `any` and `unknown`, all of which the house
lint rules reject. Every contact point lives in `src/graphql-adapter/**` with slot-style signatures
facing the rest of the package, and the eslint override is scoped to that directory. CI fails if an
import of `graphql` appears anywhere else in `src`.

## License

MIT
