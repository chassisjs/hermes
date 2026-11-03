# Change Log

# [1.0.0-alpha.23](https://github.com/chassisjs/hermes/compare/v1.0.0-alpha.22...v1.0.0-alpha.23) (2026-11-03)

### Chores

- The tests and `src/test.ts` are no longer published in `lib`. `1.0.0-alpha.22` was published without an entry here: it only stopped publishing the `*.test.ts` files of `src`.

# [1.0.0-alpha.20](https://github.com/chassisjs/hermes/compare/v1.0.0-alpha.19...v1.0.0-alpha.20) (2026-11-03)

The async outbox is now built on the polling outbox of the core package: it keeps the order per partition, separates consumers and partitions, and several instances share the work.

## ⚠️ Breaking changes

- **The async outbox publishes in the order of each partition by default** (`ordering: 'partition'`), and a message that cannot be published stops its partition until it is published. Pass `ordering: 'none'` to `useBasicAsyncOutboxConsumerPolicy` for the previous behaviour, where a failed message does not stop the others.
- **`queue()` and `send()` store the messages in the partition of the consumer by default**, instead of `'default'`. Pass `partitionKey` to store them in another one.
- Requires `@chassisjs/hermes` `1.0.0-alpha.20`.

## Upgrade

- `start()` adds the columns `partitionKey`, `nextAttemptAt`, `claimedBy` and `claimedUntil` to `asyncOutbox` and the table `asyncOutboxPartition`. The messages stored by earlier versions get the `'default'` partition.
- **Stop the instances of earlier versions before you start the new ones.** They publish the messages of all partitions and know no claims, so during a rolling deployment a message can be published twice, out of order, or by a consumer of another partition.
- **Big `asyncOutbox` tables (more than 10 000 rows, also delivered ones) need the index of the polling outbox built by hand.** Hermes warns about it (`HERMES_INDEX_MISSING`); without it, every poll reads the whole table. Run it before you start the new version, or right after:

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS "asyncOutboxPendingIdx"
ON "asyncOutbox" ("consumerName", "partitionKey", "position") WHERE "delivered" = false;
```

- Connect Hermes directly or through a session pooler, not a transaction pooler: instances that start at the same time migrate one after another under an advisory lock of the session.

## Features

- Async outbox options: `ordering`, `batchSize`, `lease`, `retry`, `onFailedPublish`, `onDbError`, and `partitionKey` in `send(message, { tx, partitionKey })`. `send(message, tx)` still works.
- `createPollingStore` is exported, to poll the `asyncOutbox` table with your own polling outbox.

## Bug fixes

- The async outbox published the messages of every consumer and partition; now only those of its `consumerName` and `partitionKey`.
- Stopping the consumer waits for the async outbox before it closes the connection.
- A failed `start()` closes its connections and the async outbox.
- The migration takes no lock of a table that is up to date, gives up a table lock after 500 ms and tries again, so it does not stop the inserts of the application behind a long transaction.
- The async outbox `partitionKey` is `VARCHAR(250)`, so a UUID fits.

# [1.0.0-alpha.19](https://github.com/chassisjs/hermes/compare/v1.0.0-alpha.18...v1.0.0-alpha.19) (2026-11-02)

A bigger release: backpressure, transactions of any database library, partitions that actually separate messages, and postgres.js 4.

## ⚠️ Breaking changes

- **Node `^20.19.0 || >=22.12.0` is required.** Hermes PostgreSQL now uses postgres.js 4, which is ESM-only and needs Node 20+. The CommonJS build relies on `require(esm)`, enabled by default from Node 20.19 and 22.12.
- **postgres.js 4 typings.** A postgres.js 3 transaction passed as `tx` still works at runtime, but no longer type-checks. Upgrade postgres.js to 4 in your app as well. `getDbConnection()` returns a postgres.js 4 connection.
- `JSONValue` is now defined and exported by Hermes (postgres.js 4 does not export it); the definition is the same as before.

## Features

- **Backpressure.** The new `maxQueueSize` option (default `1000`) limits the transactions waiting to be published or acknowledged. When the limit is reached, Hermes stops reading the replication stream, so PostgreSQL keeps the changes in the WAL instead of your app keeping them in memory. Reading resumes when the queue drops to half the limit. With `serialization: false`, it also caps the concurrent `publish` calls. While paused, Hermes sends its status every 10 seconds, so keep `wal_sender_timeout` above 10 seconds.
- **Transactions of any database library.** `queue(message, { tx })` and `send(message, tx)` accept a postgres.js transaction or any object with `query(text, params)`. A `pg` client and TypeORM's `QueryRunner` work as they are; see the docs for Kysely, Drizzle and Prisma.

```typescript
const client = await pool.connect()
await client.query('BEGIN')
await outbox.queue(event, { tx: client })
await client.query('COMMIT')
```

- Batches (`queue([...])`, `send([...])`) of any size are stored all or none, also without a transaction.

## Bug fixes

- **Partitions.** A consumer published the messages of every partition. Now it publishes only the messages of its `partitionKey`.
- **Partition and consumer names.** Names that PostgreSQL does not accept as a replication slot name (e.g. `tenant-1`, or longer than 63 characters) failed on `start()`. They now get a valid slot name. Names that worked before keep their slot.

## Known limitations

See the [backlog](https://github.com/chassisjs/hermes/blob/main/docs/BACKLOG.md): the async outbox does not separate consumers nor partitions yet.

# [1.0.0-alpha.18](https://github.com/chassisjs/hermes/compare/v1.0.0-alpha.17...v1.0.0-alpha.18) (2026-11-01)

A reliability release. It fixes how messages are acknowledged and how the consumer stops. No API changes.

## Bug fixes

- **No more message loss when acknowledging during the next transaction.** The replication stream used to read the transaction being received at the time of the acknowledgment. When a publish finished while the next transaction was still streaming in, the slot position jumped past an unpublished transaction and part of its inserts was dropped. Each acknowledgment now confirms the transaction it belongs to, and the standby status update is actually sent to PostgreSQL.
- **`stop()` stops the publishing queue.** Previously, retries kept running after `stop()`, failed on the cleared state and ended in unhandled promise rejections (which crash Node by default). `stop()` now stops new publishing, waits up to 5 seconds for the publish in progress to finish and be acknowledged, and only then closes the connections.
- **A failed acknowledgment no longer republishes the message.** If `publish` succeeded but the acknowledgment (e.g. saving the position) failed, the message was sent again and counted as a failed delivery. Now only the acknowledgment is retried, after `waitAfterFailedPublish`.
- **Non-blocking queue (`serialization: false`):**
  - Messages are acknowledged strictly in order by a single loop. A failed acknowledgment of a younger message no longer reports the wrong LSN and no longer leaves the queue stuck.
  - A message that is still being published is no longer resent by the retry timer.
  - A failing `onFailedPublish` no longer makes `run` reject.
- **Serialized queue (`serialization: true`):**
  - A failed acknowledgment of the last message in the queue no longer throws a `TypeError` and loses the message.
  - A failing `onFailedPublish` no longer stops the publishing loop.
  - `waitUntilIsEmpty()` no longer resolves while messages are still in the queue.
- **Replication stream:** status updates are skipped once the stream is closed, and a `CONNECTION_CLOSED` error without a query no longer throws inside the error handler.
- Debug `console.log` calls were removed.

## Behavior change

- **`waitAfterFailedPublish: Duration.ofSeconds(0)` no longer disables retries** for the non-blocking queue. A failed message was then never retried, its acknowledgment blocked all younger messages and the replication slot kept growing. `0` now means "retry without waiting", the same as in the serialized queue.

## Known limitations

- Retries are still unlimited. Use `redeliveryCount` in the message envelope to move a poison message aside in your `publish` callback.
- There is no backpressure yet: when publishing is slower than the incoming changes, pending messages accumulate in memory.

# [1.0.0-alpha.8](https://github.com/chassisjs/hermes/compare/v1.0.0-alpha.9...v1.0.0-alpha.10) (2025-03-08)

Greetings! 😍 🎉

In today's small release I introduced a feature that is expressed by the setting `waitAfterFailedPublish`.

Its default value if `Duration.ofSeconds(30)`. If 0, it will be disabled.

If a publishing of a message fail, then the next attempt will happen after the value specified via `waitAfterFailedPublish`.

See a test in the file [createNonBlockingPublishingQueue.unit.test.ts](./src/publishingQueue/nonBlockingQueue/createNonBlockingPublishingQueue.unit.test.ts):

- `when 'waitAfterFailedPublish' is set to non-zero or unspecified, then the queue must resend failed messages`

Have a wonderful day! 🎉

```typescript
const outbox = createOutboxConsumer<RegisterPatientEvent>({
  getOptions() {
    /*...*/
  },
  publish: async (message) => {
    /*...*/
  },
  consumerName: 'app',
  waitAfterFailedPublish: Duration.ofSeconds(30),
})
```

# [1.0.0-alpha.8](https://github.com/chassisjs/hermes/compare/@chassisjs/hermes-postgresql@1.0.0-alpha.7...@chassisjs/hermes-postgresql@1.0.0-alpha.8) (2025-02-24)

First release of the Hermes PostgreSQL! 😍 🎉

_A mythical god who brings reliability to your system 🫒 by implementing the Outbox pattern, so you don't have to think of it too much._

_You don't have to pray for the gifts of nature. Just run npm and type:_

```bash
npm i hermes hermes-postgresql
```

If you look for a full example, then [here you go](https://github.com/chassisjs/hermes/blob/main/examples/postgresql/patient-registration/index.ts)! 🎉🎉🎉

### Features

- **_Hermes PostgreSQL_ relies on the thin and fast [Postgres.js](https://github.com/porsager/postgres)**

- **Hermes PostgreSQL creates a subscription to PostgreSQL Replication Stream (WAL)**

![Hermes and PostgreSQL WAL](./public/outbox-concept.png)

As you can see, _Hermes PostgreSQL_ relies on the WAL (_Write-Ahead Log_) of the database cluster exposed by the _PostgreSQL Logical Replication_ [protocol](https://www.postgresql.org/docs/current/logical-replication.html). Thanks to that, it's fast and reliable; you won't lose any message as it can happen in a classical Outbox implementation.

By default, _Hermes PostgreSQL_ calls a _publish callback_ immediately when a message appears in the _PostgreSQL Logical Replication_ stream. It happens in order of commits.

This means that if messages of numbers 5, 6, and 7 were committed more or less at the same time, then - depending on the callback processing time - they could be processed simultaneously. But _Hermes PostgreSQL_ acknowledges messages to _PostgreSQL Logical Replication_ in order. So, even though the seventh message finished processing first, before the fifth, an acknowledgement will be done only when the fifth is completed successfully.

If the app goes down before the acknowledgment of the fifth message, then after the restart all messages, that is 5, 6 and 7 will be called to be processed again.

Remember, that is what is called _at-least-once delivery_ guarantee 🥰

Check an example how to use the _PostgreSQL Logical Replication_:

```typescript
import { DeepReadonly } from 'ts-essentials'
import { addDisposeOnSigterm, type Flavour } from '@chassisjs/hermes'
import { type HermesMessageEnvelope, type MessageEnvelope, createOutboxConsumer } from '@chassisjs/hermes-postgresql'

/* Types definition */
type DomainEvent<
  EventType extends string = string,
  EventData extends Record<string, unknown> = Record<string, unknown>,
> = Flavour<
  DeepReadonly<{
    type: EventType
    data: EventData
  }>,
  'DomainEvent'
>
type PatientRegisteredSuccessfully = DomainEvent<
  'PatientRegisteredSuccessfully',
  {
    patientId: PatientId
    patientSub: Subject
  }
>
type PatientRegistrationFailed = DomainEvent<
  'PatientRegisteredSuccessfully',
  {
    email: Email
  }
>
type RegisterPatientEvent = PatientRegisteredSuccessfully | PatientRegistrationFailed

/* Initialization */
const publishOne = async (envelope: HermesMessageEnvelope<RegisterPatientEvent>) => {
  const { message, messageId, redeliveryCount } = envelope

  // Handling the message...
}
const outbox = createOutboxConsumer<RegisterPatientEvent>({
  getOptions() {
    return {
      host: 'localhost',
      port: 5434,
      database: 'hermes',
      user: 'hermes',
      password: 'hermes',
    }
  },
  publish: async (message) => {
    // if this function passes, then the message will be acknowledged;
    // otherwise, in case of an error the message won't be acknowledged.
    if (Array.isArray(message)) {
      for (const nextMessage of message) {
        await publishOne(nextMessage)
      }
    } else {
      await publishOne(message)
    }
  },
  consumerName: 'app',
})

/* How to run the Hermes PostgreSQL */
const stopOutbox = await outbox.start()
addDisposeOnSigterm(stopOutbox)

/* How to use the Hermes PostgreSQL */
const patientRegisterdEvent: MessageEnvelope<PatientRegisteredSuccessfully> = {
  message: {
    type: 'PatientRegisteredSuccessfully',
    data: { patientId: data.systemId, patientSub: data.sub },
  },
  messageId: constructMessageId('PatientRegisteredSuccessfully', data.sub),
  messageType: 'PatientRegisteredSuccessfully',
}

// One transaction that wraps two I/O-distinct operations.
// Now, you are sure that the `PatientRegisteredSuccessfully` will be published at-least-once.
await sql.begin(async (sql) => {
  await storePatient(data.systemId, data.sub, sql)
  // We pass the transaction to the `queue`.
  await outbox.queue(patientRegisterdEvent, { tx: sql })
})
```

- **It is based on a stream, not the pulling. So, it is less I/O operations**

- **You won't lose any message like it can happen in the classic implementation**

The classic implementation is based on a periodic pull. While doing so, it can happen that we will lose a message, which commiting takes longer than others.

It's the case because **the autoincrement identifiers are establish before starting a transaction**.

![Hermes and PostgreSQL WAL](./public/outbox-gap.png)

- **You can make Hermes PostgreSQL to call only one _publish callback_ at once, the rest will wait for it to be called**

```typescript
const outbox = createOutboxConsumer<RegisterPatientEvent>({
  // ...rest the same as before
  serialization: true,
})
```

- **You can't start two consumers (Hermes PostgreSQL instances) of the same name. It will throw an _HermesConsumerAlreadyTakenError_**

- **You can run two consumers of the same name but with a different _partition key_**

```typescript
const outbox = createOutboxConsumer<RegisterPatientEvent>({
  // ...rest the same as before
  partitionKey: `partition-for-tenant-XYZ`,
})
```

This is the way you can scale _Hermes PostgreSQL_ horizontally.

- **You can use _Hermes PostgreSQL_ without a _message broker_,**

then, the delivering and processing a message is a part of the same operation and can be confirmed only when the message's handler finishes successfully.

If you'd like to perform, e.g. a _compensation_, then you can use a special _Hermes PostgreSQL_ feature - _asynchronous outbox consumer_. This is a separate stack of messages which execution and delivering time doesn't matter. It has to happen at one time.

That's so that we don't occupy _PostgreSQL WAL_ when it's not needed.

```typescript
import { useBasicAsyncOutboxConsumerPolicy } from '@chassisjs/hermes-postgresql'

const outbox = createOutboxConsumer<RegisterPatientEvent>({
  // ...rest the same as before
  asyncOutbox: useBasicAsyncOutboxConsumerPolicy(),
})

const revertRegistration = async (params: _RevertPatientRegistration['data'], email: Email) => {
  const revertCommand = literalObject<MessageEnvelope<_RevertPatientRegistration>>({
    message: {
      type: '_RevertPatientRegistration',
      data: params,
    },
    messageId: constructMessageId('_RevertPatientRegistration', params.sub.toString()),
    messageType: '_RevertPatientRegistration',
  })

  // `send`, in contrast to the `queue`, puts a message in the asynchronous stack.
  await outbox.send(revertCommand)
}
```

- **Run multiple instances of your app and distribute the messages to them**

_Hermes PostgreSQL_ keeps one instance of your app exclusively and all messages from _Logical Replication_ go to that instance.

If you want to run multiple instances of the app, you'd probably also wish to distribute messages evenly evenly. If so, you must utilize a message broker's feature to create a _shared subscription_.

![Hermes and PostgreSQL WAL](./public/outbox-messages-scaling.png)
