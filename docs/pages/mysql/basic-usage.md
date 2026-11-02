<img src="../../public/logo-main.png" alt="Hermes logo" style="margin: 0 auto; width: 70%; display: block;" />
<br />

# Basic usage

Hermes MySQL is a [polling outbox](../polling-outbox.md) for MySQL 8.0+ and Aurora MySQL 3 (MySQL 8.0 compatible). Your application stores messages in the `hermes_outbox` table in its own transactions, and Hermes polls the table and publishes them.

## Installation

```bash
npm i @chassisjs/hermes @chassisjs/hermes-mysql
```

Hermes uses [mysql2](https://github.com/sidorares/node-mysql2) and creates its own pool from `getOptions()`.

## Quick start

```typescript
import { createOutboxConsumer } from '@chassisjs/hermes-mysql'

const outbox = createOutboxConsumer<DomainEvent>({
  getOptions: () => ({ host: 'localhost', port: 3306, user: 'app', password: 'secret', database: 'app' }),
  publish: async (envelope) => {
    // throw to publish the message again later
    await broker.publish(envelope.messageType, envelope.message)
  },
  consumerName: 'app',
})

const stop = await outbox.start()

process.on('SIGTERM', () => stop())
```

`start()` runs the migrations and starts polling. `stop()` waits for the message being published, releases the claims of this instance and closes the pool.

`publish` gets:

| Field             | Description                                                        |
| ----------------- | ------------------------------------------------------------------ |
| `position`        | The `AUTO_INCREMENT` position of the message, as a string          |
| `partitionKey`    | The partition of the message                                       |
| `messageId`       | Your identifier of the message. Use it to make handlers idempotent |
| `messageType`     | The type of the message                                            |
| `redeliveryCount` | The number of failed attempts so far                               |
| `message`         | The payload                                                        |

## Storing messages in your transaction

Pass your transaction as `tx`. A `mysql2` connection works as it is:

```typescript
const connection = await pool.getConnection()

try {
  await connection.beginTransaction()
  await connection.query('INSERT INTO patient (id, name) VALUES (?, ?)', [patientId, name])
  await outbox.queue(
    { messageId: patientId, messageType: 'PatientRegistered', message: { patientId, name } },
    { tx: connection, partitionKey: tenantId },
  )
  await connection.commit()
} catch (error) {
  await connection.rollback()
  throw error
} finally {
  connection.release()
}
```

Other libraries need an object with `query(text, params)` that runs SQL with `?` placeholders in their transaction:

```typescript
// Kysely
await db.transaction().execute(async (trx) => {
  await outbox.queue(message, {
    tx: { query: (text, params) => trx.executeQuery(CompiledQuery.raw(text, params)) },
  })
})

// Prisma
await prisma.$transaction(async (tx) => {
  await outbox.queue(message, {
    tx: { query: (text, params) => tx.$executeRawUnsafe(text, ...params) },
  })
})
```

`queue` takes one message or an array, and stores them all or none. Without `tx`, it stores them at once.

## Partitions and many instances

The messages of a partition are published one by one, in the order of their positions. `partitionKey` defaults to `'default'`. Use e.g. the id of a tenant or of an aggregate when the order matters only inside it.

You can run many instances of your application. Every instance claims free partitions (up to `maxPartitions`, 10 by default) for a lease (`lease`, 30 seconds by default) and renews it while it publishes. So:

- a partition is published by one instance at a time, in order;
- the instances share the partitions;
- when an instance dies, the others take its partitions after the lease.

A message that cannot be published stops its partition until it is published. Other partitions go on. The wait before the next attempt doubles after every attempt, from 1 second to 1 minute (`retry`).

When the order does not matter, `ordering: 'none'` lets all instances publish the messages of one partition at the same time, and a failed message does not stop other messages.

A consumer publishes the messages stored by consumers of the same `consumerName`. Give it a `partitionKey` to publish only one partition.

## Migrations

Hermes keeps the applied versions in the `hermes_migrations` table. `start()` applies the missing ones. Many instances can start at the same time: they wait for each other on a named lock (`GET_LOCK`), and every migration runs once.

When the user of your application must not change the schema, run the migrations in your deployment pipeline and turn them off in the consumer:

```typescript
import { migrate } from '@chassisjs/hermes-mysql'
import { createPool } from 'mysql2/promise'

const pool = createPool({ host, user: 'migrations', password, database: 'app' })

await migrate(pool)
await pool.end()

const outbox = createOutboxConsumer({ ...params, migrate: false })
```

The tables:

| Table                     | Content                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------- |
| `hermes_outbox`           | The messages, their attempts, the time of the next attempt, claims and the time of delivery |
| `hermes_outbox_partition` | The claims of the partitions                                                                |
| `hermes_migrations`       | The applied migrations                                                                      |

## Configuration options

| Option            | Default                       | Description                                                        |
| ----------------- | ----------------------------- | ------------------------------------------------------------------ |
| `getOptions`      | (required)                    | The options of the `mysql2` pool                                   |
| `publish`         | (required)                    | Publishes a message. Throw to retry it                             |
| `consumerName`    | (required)                    | The name of the consumer, at most 250 characters                   |
| `partitionKey`    | all partitions                | Publish only this partition                                        |
| `ordering`        | `'partition'`                 | `'partition'` or `'none'`                                          |
| `pollInterval`    | 1 second                      | The wait between polls when there was nothing more to publish      |
| `batchSize`       | 100                           | The maximum number of messages of a partition per poll             |
| `maxPartitions`   | 10                            | The maximum number of partitions an instance publishes at once     |
| `lease`           | 30 seconds                    | How long a claim lasts                                             |
| `retry`           | `useExponentialRetryPolicy()` | The wait before the next attempt of a failed message               |
| `migrate`         | `true`                        | Whether `start()` runs the migrations                              |
| `onFailedPublish` |                               | Called when a message cannot be published                          |
| `onDbError`       |                               | Called when a query fails. Hermes tries again after `pollInterval` |

## Limitations

- **Polling adds latency** of up to `pollInterval`, and every poll runs queries even when there are no messages.
- **Delivered messages stay in `hermes_outbox`**, with `delivered_at` set. Delete the old ones yourself, e.g. `DELETE FROM hermes_outbox WHERE delivered_at < NOW() - INTERVAL 7 DAY LIMIT 10000` in a scheduled job.
- **MySQL 8.0 or newer** is needed for `FOR UPDATE SKIP LOCKED`. The claims run in `READ COMMITTED` transactions, so they do not lock the gaps between rows and do not block the inserts of your application.
- **The order is the order of the positions**, which is the order of the inserts, not of the commits. Messages of transactions that run at the same time can be published in any order. Messages of a transaction that started after another one committed are published after its messages.
