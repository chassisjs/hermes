# Backlog

Known issues and improvements that are not scheduled yet.

## The `partitionKey` column is too short for UUIDs (PostgreSQL)

**Type:** improvement · **Package:** `@chassisjs/hermes-postgresql`

The `partitionKey` columns (`outbox`, `outboxConsumer`, `asyncOutbox`, `asyncOutboxPartition`) and `consumerName` are `VARCHAR(30)` (`packages/hermes-postgresql/src/outbox/migrate.ts`), so a UUID (36 characters) does not fit. Widen them (e.g. to `VARCHAR(250)`) with `ALTER TABLE ... ALTER COLUMN ... TYPE`, which in PostgreSQL does not rewrite the table when only the length grows. Check that the `outbox` table, which is in the publication, keeps streaming after the change.

## No lock against a second instance of a partition (MongoDB)

**Type:** improvement · **Package:** `@chassisjs/hermes-mongodb`

Two instances of one partition both publish the same messages and overwrite each other's position. A claim with a lease in `__outboxConsumers` (like `asyncOutboxPartition` in PostgreSQL) would let only one of them publish. The position is also stored per `partitionKey` only, so two services that use one database and one partition key share it; add a consumer name.

## Filter partitions on the server side (PostgreSQL)

**Type:** improvement · **Package:** `@chassisjs/hermes-postgresql`

There is one publication for the whole outbox table: `CREATE PUBLICATION hermes_pub FOR TABLE outbox` (`packages/hermes-postgresql/src/outbox/migrate.ts:92`). So every replication slot decodes and streams all the inserts, and each consumer drops the messages of other partitions (`packages/hermes-postgresql/src/outbox/OutboxConsumer.ts:316`).

**Impact:** With N partitions, PostgreSQL decodes and sends every message N times. Partitioning spreads the publishing, but not the decoding work and network traffic.

**Proposed fix:** Starting from PostgreSQL 15, publications support row filters. Create one publication per partition:

```sql
CREATE PUBLICATION hermes_pub_<partition> FOR TABLE outbox WHERE ("partitionKey" = '<partition>');
```

Then start the replication with that publication.

Things to handle:

- Keep the current client-side filter as a fallback for PostgreSQL < 15, and pick the strategy from `server_version_num`.
- Publication names have the same character and length rules as slot names (see below).
- Existing slots: a slot streams whatever publication is named in `START_REPLICATION`, so switching publications needs no new slot. Check how the switch behaves for transactions that are already in the slot.

## Replication slot name collisions (PostgreSQL)

**Type:** bug · **Package:** `@chassisjs/hermes-postgresql`

The slot name joins the consumer name and the partition key with `_`: `hermes_slot_${consumerName}_${partitionKey}` (`packages/hermes-postgresql/src/common/consts.ts:11`). Both parts may contain `_`, so different pairs can produce the same name:

| `consumerName` | `partitionKey` | Slot name           |
| -------------- | -------------- | ------------------- |
| `a_b`          | `c`            | `hermes_slot_a_b_c` |
| `a`            | `b_c`          | `hermes_slot_a_b_c` |

**Impact:** Two different consumers share one slot. The second one fails with `HermesConsumerAlreadyTakenError`, or, when they do not run at the same time, they take over each other's position.

Names that PostgreSQL does not accept (e.g. `tenant-1`, or longer than 63 characters) already get a hash of the pair since `1.0.0-alpha.19`, so they do not collide. Only names made of `[a-z0-9_]` are affected.

**Proposed fix:** Use an unambiguous encoding for every name, e.g. always add a hash of the pair. This changes the slot names of existing installations, so it needs a migration: look up the old slot name, and either rename the slot or create the new one from the position saved in `outboxConsumer` and drop the old one. Release it as a breaking change.
