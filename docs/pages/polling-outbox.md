<img src="../public/logo-main.png" alt="Hermes logo" style="margin: 0 auto; width: 70%; display: block;" />
<br />

# Polling outbox

Hermes PostgreSQL and Hermes MongoDB read the outbox from the log of the database (Logical Replication, Change Streams). A **polling outbox** asks the database for undelivered messages every few seconds instead. It works with any database that can lock rows, and it is what the async outbox of Hermes PostgreSQL (`outbox.send()`) is built on.

The engine is in `@chassisjs/hermes` and does not depend on any database. A database gives it a **store**: a few queries that claim, read and mark messages. `@chassisjs/hermes-postgresql` has the store of its `asyncOutbox` table, and [`@chassisjs/hermes-mysql`](./mysql/basic-usage.md) is a whole outbox for MySQL built on it. Both export their store as `createPollingStore`.

## Why not "give me the messages after the last id"?

The simplest polling keeps the id of the last published message and asks for greater ones. It loses messages.

An auto-increment id (a sequence in PostgreSQL, `AUTO_INCREMENT` in MySQL, `IDENTITY` in SQL Server) is assigned on **insert**, not on commit. So the transactions commit in an order different from their ids:

1. Transaction A inserts a message and gets id `1`.
2. Transaction B inserts a message and gets id `2`, and commits.
3. The outbox publishes message `2` and remembers `2`.
4. Transaction A commits. Message `1` is now visible, but the outbox asks for ids greater than `2`. Message `1` is never published.

The Hermes polling outbox does not keep a position. Every message keeps its own state: delivered or not, the number of attempts, the time of the next attempt and who claimed it. A message that becomes visible late is still undelivered, so the next poll takes it.

## Ordering policies

Many instances of your application can poll the same outbox. The policy decides how they share the messages.

### `usePartitionOrderingPolicy` (default)

- One instance publishes a partition at a time. It **claims** the partition for a lease (30 seconds by default) and renews the claim while it publishes.
- The messages of a partition are published one by one, in the order of their ids.
- A message that cannot be published stops its partition until it is published. Other partitions go on.
- When an instance dies, another one takes its partitions after the lease.

This keeps the **causal order** in a partition: when a transaction starts after another one has committed, it gets greater ids, so its messages are published later. The messages of transactions that run at the same time have no order between them, and the outbox can publish them in any order.

### `useNoOrderingPolicy`

- The instances claim single messages (`FOR UPDATE SKIP LOCKED`), so many of them publish the messages of one partition at the same time.
- A message that cannot be published does not stop other messages.

Use it when the order does not matter and you need more throughput than one instance per partition.

## Retries

A failed message waits before the next attempt. By default (`useExponentialRetryPolicy()`), it waits 1 second, doubled after every attempt, at most 1 minute. The times are computed with the clock of the database, so that all instances agree on them.

Delivery is **at-least-once**. An instance can die after publishing a message and before marking it as delivered, and then the message is published again. Make the handlers idempotent, e.g. with the `messageId`.

## The async outbox of Hermes PostgreSQL

```typescript
import { Duration } from '@chassisjs/hermes'
import { createOutboxConsumer, useBasicAsyncOutboxConsumerPolicy } from '@chassisjs/hermes-postgresql'

const outbox = createOutboxConsumer<DomainEvent>({
  getOptions: () => dbOptions,
  publish: async (message) => broker.publish(message),
  consumerName: 'app',
  partitionKey: 'tenant-1',
  asyncOutbox: useBasicAsyncOutboxConsumerPolicy(Duration.ofSeconds(5), {
    ordering: 'partition', // or 'none'
    batchSize: 100,
    lease: Duration.ofSeconds(30),
  }),
})

await outbox.start()

await sql.begin(async (tx) => {
  await tx`UPDATE "payment" SET "status" = 'failed' WHERE "id" = ${paymentId}`
  await outbox.send(revertPaymentCommand, { tx, partitionKey: 'tenant-1' }) // 👈
})
```

The async outbox of a consumer publishes only the messages of the consumer's `consumerName` and `partitionKey`. `send()` stores the messages in the partition of the consumer unless you pass another `partitionKey`.

`send(message, tx)` still works: the second parameter is either a transaction or `{ tx, partitionKey }`.

Hermes adds the columns `partitionKey`, `nextAttemptAt`, `claimedBy` and `claimedUntil` to the `asyncOutbox` table, and the `asyncOutboxPartition` table with the claims of the partitions, when the consumer starts. Earlier versions did not store the partition of a message, so the messages they stored get the `'default'` partition (the default value of the column), also the ones stored by instances of an earlier version during a rolling deployment:

- The consumer of the `'default'` partition (a consumer without `partitionKey`) publishes them.
- A consumer of another partition never publishes them, so the messages of one tenant do not go to another one. When all your consumers have other partitions, let the async outbox publish all its messages before you upgrade (`SELECT COUNT(*) FROM "asyncOutbox" WHERE "delivered" = false`), or move the messages to the right partitions after the upgrade, when no instance of an earlier version runs: `UPDATE "asyncOutbox" SET "partitionKey" = 'tenant-1' WHERE "partitionKey" = 'default' AND ...`.

::: warning Rolling deployment
Instances of an earlier version do not know the partitions and the claims. They publish all the undelivered messages of their `consumerName`, of every partition, also the ones that the new instances are publishing at the same time. Until the last old instance stops, a message can go through the `publish` of a consumer of another partition (another tenant), be published twice, or out of order. When that matters, stop all the old instances before you start the new ones.
:::

## Your own store

To poll another database, implement `PartitionClaimingStore` (for `usePartitionOrderingPolicy`) or `MessageClaimingStore` (for `useNoOrderingPolicy`) from `@chassisjs/hermes`:

```typescript
import { createPollingOutbox, usePartitionOrderingPolicy, type PartitionClaimingStore } from '@chassisjs/hermes'

const store: PartitionClaimingStore<DomainEvent> = {
  claimPartitions: async ({ owner, lease, limit }) => {
    /* ... */
  },
  readPartition: async ({ partitionKey, limit }) => {
    /* ... */
  },
  renewPartitions: async ({ owner, lease, partitionKeys }) => {
    /* ... */
  },
  releasePartitions: async ({ owner, partitionKeys }) => {
    /* ... */
  },
  markDelivered: async (message) => {
    /* ... */
  },
  markFailed: async (message, { retryAfter }) => {
    /* ... */
  },
}

const stop = createPollingOutbox({
  policy: usePartitionOrderingPolicy(store),
  publish: async (message) => broker.publish(message),
}).start()
```

The rules:

- **Claim with row locks that skip locked rows**, so that two instances never take the same partition or message: `FOR UPDATE SKIP LOCKED` in PostgreSQL and MySQL 8, `WITH (UPDLOCK, READPAST)` in SQL Server.
- **Compute the times with the clock of the database** (`now()`), not of the application.
- **`claimPartitions` returns only partitions whose first undelivered message is due**, so a failed message keeps its partition waiting.
- **`readPartition` returns the undelivered messages in the order of their ids**.

See `createPollingStore` in `@chassisjs/hermes-postgresql` for a complete example.
