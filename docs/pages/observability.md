<img src="../public/logo-main.png" alt="Hermes logo" style="margin: 0 auto; width: 70%; display: block;" />
<br />

# Observability

An outbox can fail quietly. When the broker is down, `publish` throws and you see errors. When the outbox falls behind, nothing throws. A claim can be too slow, or one failing message can stop its partition, or no instance runs at all, and the messages just wait in the table.

So watch three kinds of signals:

| Signal     | Question                              | Where it comes from                |
| ---------- | ------------------------------------- | ---------------------------------- |
| **Lag**    | How far behind is the consumer?       | `getLag()`, read from the database |
| **Polls**  | What does this instance do, how fast? | `onPoll`, after every poll         |
| **Errors** | What fails?                           | `onFailedPublish`, `onDbError`     |

Hermes reports all of them as plain values and callbacks, so you can send them to any logger or metrics library. For OpenTelemetry, there is a ready adapter (see [below](#opentelemetry)).

::: info Supported consumers
The lag and `onPoll` are in the outbox consumer of Hermes MySQL, and in the consumer and the async outbox of Hermes PostgreSQL. Hermes MongoDB does not have them yet.
:::

## Lag

`getLag()` reads from the database how far the consumer is behind:

```typescript
const lag = await outbox.getLag()
// {
//   oldestPendingAge: Duration | null, // the age of the oldest undelivered message, by the clock of the database
//   pending: 1200,                     // undelivered messages, counted up to `countLimit` (default 10 000)
//   isPendingExact: true,              // false when there are more than `countLimit`
//   failing: 3,                        // counted undelivered messages that failed at least once
//   partitions: 40,                    // partitions with undelivered messages
// }
```

- **`oldestPendingAge`** is the most useful value. It does not depend on the traffic. It grows when the consumer is slow, when a message keeps failing and stops its partition, and when the outbox publishes nothing and reports no error. It is `null` when every message is delivered.
- **`pending`** counts at most `countLimit` messages, so that a big backlog does not make the query expensive. Pass `getLag({ countLimit })` to change the limit. When there are more messages, `isPendingExact` is `false`.
- **`failing`** counts the undelivered messages that failed at least once. With partition ordering, every one of them stops its partition.
- **`partitions`** is the number of partitions with undelivered messages.

The lag is read from the database, so it is the same for every instance of the consumer. Aggregate it with `max`, not `sum`. It reads only the messages of the consumer's `consumerName`, and of its `partitionKey` when it has one.

A read costs about as much as one poll: it uses the same indexes. Read it when your metrics are collected (e.g. every 15–60 seconds), not in a loop.

In Hermes MySQL, `getLag()` does not need `start()`. It uses the pool of `getDbConnection()`, so you can also read the lag from a process that does not poll, e.g. a health check.

### The main outbox of Hermes PostgreSQL

The main outbox of Hermes PostgreSQL reads the messages from the WAL with logical replication. It does not keep the state of every message, so it cannot count the undelivered ones. Its `getLag()` returns another shape:

```typescript
const lag = await outbox.getLag()
// {
//   replication: {
//     walBytes: 52_428_800,         // the WAL that the replication slot did not confirm yet
//     isSlotActive: true,           // whether a process consumes the slot now
//     oldestPendingAge: Duration,   // the oldest transaction this instance received and did not publish yet
//     pendingTransactions: 2,       // the transactions this instance received and did not publish yet
//     redeliveryCount: 0,           // the failed attempts of the transaction that is published again
//   },
//   asyncOutbox: { oldestPendingAge, pending, ... } | null, // as above, when the consumer has an async outbox
// }
```

- **`walBytes`** is read from the database, so it grows also when no instance runs. It is the WAL that PostgreSQL keeps for the slot, so it also warns you before the slot fills the disk. It counts all the WAL of the database, not only the outbox, so it is not 0 on a busy database even when the consumer keeps up. Watch its trend.
- **`oldestPendingAge`** and **`pendingTransactions`** are kept in the memory of the instance. They cover the transactions that the instance received from the stream and did not publish yet. The age uses the commit time of PostgreSQL and the clock of the application, so a skew of the clocks shifts it.
- **`isSlotActive`** is `false` when no instance consumes the slot.

This `getLag()` needs a started consumer. It throws before `start()` and after `stop()`.

## Polls

`onPoll` is called after every poll that did not fail, also when there was nothing to publish:

```typescript
const outbox = createOutboxConsumer({
  // ...
  onPoll: (poll) => {
    // {
    //   claimDuration: Duration,   // the claim, reading the claimed messages included
    //   publishDuration: Duration, // publishing the claimed messages
    //   lanes: 2,                  // claimed lanes (partitions)
    //   messages: 25,              // claimed messages
    //   published: 24,             // published and marked as delivered
    //   failed: 1,                 // could not be published
    //   isClaimLost: false,        // another instance took over a claim
    // }
  },
})
```

In Hermes PostgreSQL, pass it to the async outbox: `useBasicAsyncOutboxConsumerPolicy(interval, { onPoll })`.

- **`claimDuration`** is the first thing to check when the lag grows without errors. A claim that takes a large part of the `lease` leaves little time to publish. Hermes then renews the claim before it publishes, but such a claim is already a problem.
- **`messages`** can be more than `published + failed`. A lane stops early after a failed message (partition ordering), when its claim is lost or cannot be renewed, when the outbox stops, or when the database fails.
- **`isClaimLost`** means that another instance took over a claim of this one, e.g. after this instance was paused for longer than the `lease`.

`onPoll` describes one instance. Sum its counters over the instances.

An error thrown by `onPoll` is ignored, so a broken metrics library does not stop the outbox.

## Errors

- **`onFailedPublish(error)`** is called when `publish` throws. The message is retried later (see [Retries](./polling-outbox.md#retries)).
- **`onDbError(error)`** is called when a query fails, e.g. when the database is not available. The outbox tries again after `pollInterval`.

In Hermes PostgreSQL, the async outbox takes its own handlers: `useBasicAsyncOutboxConsumerPolicy(interval, { onFailedPublish, onDbError })`. The main outbox calls `onFailedPublish` of the consumer and publishes the transaction again after `waitAfterFailedPublish`. It does not call `onDbError` yet, so watch `redeliveryCount` and the age of its oldest pending transaction too.

```typescript
const outbox = createOutboxConsumer({
  // ...
  onFailedPublish: (error) => logger.warn({ error }, 'Publishing failed'),
  onDbError: (error) => logger.error({ error }, 'Outbox query failed'),
})
```

Errors that these handlers throw are ignored.

Hermes PostgreSQL also warns with `process.emitWarning` while it migrates:

- **`HERMES_MIGRATION_LOCK`**: it has waited longer than 30 seconds for the migration lock of another instance, or it cannot release the lock.
- **`HERMES_INDEX_MISSING`**: the index of the async outbox is missing on a big table (see [the async outbox](./polling-outbox.md#the-async-outbox-of-hermes-postgresql)).

```typescript
process.on('warning', (warning) => {
  if ('code' in warning && String(warning.code).startsWith('HERMES_')) {
    logger.warn({ code: warning.code }, warning.message)
  }
})
```

## OpenTelemetry

`createOutboxMetrics` of Hermes MySQL and Hermes PostgreSQL records the lag and the polls with OpenTelemetry. Hermes does not depend on `@opentelemetry/api`: pass the `Meter` of your application, and configure the exporter (OTLP, Prometheus, ...) as you do for the rest of the application.

```typescript
import { metrics } from '@opentelemetry/api'
import { createOutboxConsumer, createOutboxMetrics } from '@chassisjs/hermes-mysql'

const outbox = createOutboxConsumer({
  // ...
  consumerName: 'orders',
  onPoll: (poll) => outboxMetrics.onPoll(poll),
})
const outboxMetrics = createOutboxMetrics({
  meter: metrics.getMeter('orders'),
  outbox,
  attributes: { 'hermes.consumer.name': 'orders' },
  onError: (error) => logger.warn({ error }, 'Reading the lag of the outbox failed'),
})
const stop = await outbox.start()

// on shutdown
outboxMetrics.dispose()
await stop()
await outbox.getDbConnection().end()
```

The gauges read the lag (`outbox.getLag()`) once per collection of the metrics, so how often depends on the metric reader of your application, e.g. `exportIntervalMillis` of `PeriodicExportingMetricReader`. In Hermes MySQL, `getLag()` does not need `start()`, so the metrics can be created before it. `onPoll` is called only after `start()`, so it can refer to `outboxMetrics` declared below it.

`createPollingOutboxMetrics` of `@chassisjs/hermes` is the adapter under both, for a polling outbox with your own store: it takes `getLag` as a function.

In Hermes PostgreSQL, `createOutboxMetrics` records the main outbox and the async outbox. Its `getLag()` needs a started consumer, so create the metrics after `start()`, and call `dispose()` before `stop()`:

```typescript
import { Duration, type PollingOutboxMetrics } from '@chassisjs/hermes'
import {
  createOutboxConsumer,
  createOutboxMetrics,
  useBasicAsyncOutboxConsumerPolicy,
} from '@chassisjs/hermes-postgresql'

let outboxMetrics: PollingOutboxMetrics | undefined
const outbox = createOutboxConsumer({
  // ...
  asyncOutbox: useBasicAsyncOutboxConsumerPolicy(Duration.ofSeconds(5), {
    onPoll: (poll) => outboxMetrics?.onPoll(poll),
  }),
})

const stop = await outbox.start()

outboxMetrics = createOutboxMetrics({
  meter: metrics.getMeter('orders'),
  outbox,
  attributes: { 'hermes.consumer.name': 'orders' },
})

// on shutdown
outboxMetrics.dispose()
await stop()
```

### Metrics

| Metric                                                     | Type      | Unit            | Source                   | Aggregate over instances |
| ---------------------------------------------------------- | --------- | --------------- | ------------------------ | ------------------------ |
| `hermes.outbox.oldest_pending_message.age`                 | gauge     | `s`             | `getLag()`               | `max`                    |
| `hermes.outbox.pending_messages`                           | gauge     | `{message}`     | `getLag()`               | `max`                    |
| `hermes.outbox.failing_messages`                           | gauge     | `{message}`     | `getLag()`               | `max`                    |
| `hermes.outbox.pending_partitions`                         | gauge     | `{partition}`   | `getLag()`               | `max`                    |
| `hermes.outbox.claim.duration`                             | histogram | `s`             | `onPoll`                 | merge                    |
| `hermes.outbox.publish.duration`                           | histogram | `s`             | `onPoll`                 | merge                    |
| `hermes.outbox.polls`                                      | counter   | `{poll}`        | `onPoll`                 | `sum`                    |
| `hermes.outbox.messages.published`                         | counter   | `{message}`     | `onPoll`                 | `sum`                    |
| `hermes.outbox.messages.failed`                            | counter   | `{message}`     | `onPoll`                 | `sum`                    |
| `hermes.outbox.claims.lost`                                | counter   | `{claim}`       | `onPoll`                 | `sum`                    |
| `hermes.outbox.replication.wal`                            | gauge     | `By`            | PostgreSQL, from the DB  | `max`                    |
| `hermes.outbox.replication.slot.active`                    | gauge     | `1`             | PostgreSQL, from the DB  | `max`                    |
| `hermes.outbox.replication.oldest_pending_transaction.age` | gauge     | `s`             | PostgreSQL, per instance | `max`                    |
| `hermes.outbox.replication.pending_transactions`           | gauge     | `{transaction}` | PostgreSQL, per instance | `sum`                    |
| `hermes.outbox.replication.redelivery_count`               | gauge     | `{attempt}`     | PostgreSQL, per instance | `max`                    |

The ages are 0 when nothing is waiting. The duration histograms use buckets from 5 ms to 60 s.

Exported to Prometheus, the names get the unit and the type as suffixes, e.g. `hermes_outbox_oldest_pending_message_age_seconds`, `hermes_outbox_messages_published_total` and `hermes_outbox_replication_wal_bytes`. Check the exact names in your exporter: e.g. `slot.active` (unit `1`) can get a `_ratio` suffix.

### Without OpenTelemetry

`getLag()` and `onPoll` work with any library. For example, with `prom-client`:

```typescript
import { Counter, Gauge } from 'prom-client'

new Gauge({
  name: 'hermes_outbox_oldest_pending_message_age_seconds',
  help: 'The age of the oldest undelivered message of the outbox.',
  async collect() {
    const lag = await outbox.getLag()

    this.set((lag.oldestPendingAge?.ms ?? 0) / 1000)
  },
})

const published = new Counter({ name: 'hermes_outbox_messages_published_total', help: 'Published messages.' })

const outbox = createOutboxConsumer({
  // ...
  onPoll: (poll) => published.inc(poll.published),
})
```

## Alerts

A starting point. Tune the thresholds to how fast your messages have to be delivered.

| Alert                                       | Condition                                                       | Usual causes                                                                                    |
| ------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **The outbox is behind**                    | `oldest_pending_message.age` above your target (e.g. 5 minutes) | Slow claims, a failing message, too few instances or partitions, no instance runs               |
| **A message keeps failing**                 | `failing_messages > 0` for longer than your retries take        | The broker rejects the message, a bug in `publish`                                              |
| **Claims are too slow**                     | p99 of `claim.duration` above a third of the `lease`            | A slow query on a big table, big messages read by `readPartition`, an overloaded database       |
| **Instances take over each other's claims** | `claims.lost` grows                                             | Instances paused longer than the `lease` (GC, CPU throttling), a `lease` that is too short      |
| **The consumer does not poll**              | `polls` does not grow                                           | The instance is down, or every poll fails (see `onDbError`)                                     |
| **The slot keeps WAL** (PostgreSQL)         | `replication.wal` grows for a long time, or `slot.active` is 0  | No instance consumes the slot, or publishing is stuck. PostgreSQL keeps the WAL, the disk fills |
