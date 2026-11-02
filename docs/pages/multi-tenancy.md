<img src="../public/logo-main.png" alt="Hermes logo" style="margin: 0 auto; width: 70%; display: block;" />
<br />

# Multi-tenancy

Yes, you can run many Hermes instances, one per tenant, both with PostgreSQL and with MongoDB. A tenant gets its own **partition**: its own position in the stream of messages, its own publishing queue and its own retries. A tenant whose messages cannot be published does not stop the messages of other tenants.

There are three ways to serve many tenants:

| Model                  | How                                                                   | Isolation                                                    | Cost                                             |
| ---------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------ |
| One partition for all  | One consumer; the tenant id is a part of the message                  | None: a message that cannot be published blocks every tenant | The lowest                                       |
| A partition per tenant | One consumer per tenant, all in one database, `partitionKey` = tenant | A tenant's position, queue and failures are its own          | One replication slot or change stream per tenant |
| A database per tenant  | One consumer per tenant database                                      | Full: separate tables, positions and slots/streams           | As above, plus the tables in every database      |

With many tenants (hundreds or more), consider a partition per **group** of tenants, e.g. `` partitionKey: `bucket_${hash(tenantId) % 16}` ``. You keep the number of partitions fixed and still spread the publishing.

## PostgreSQL

### A partition per tenant

One consumer is identified by its `consumerName` and `partitionKey`, and gets its own [replication slot](./postgresql/how-does-it-work.md). The application passes the tenant's partition key when it queues a message:

```typescript
import { createOutboxConsumer } from '@chassisjs/hermes-postgresql'

const createTenantOutbox = (tenantId: string) =>
  createOutboxConsumer<DomainEvent>({
    getOptions: () => dbOptions,
    publish: (message) => broker.publish(tenantId, message),
    consumerName: 'app',
    partitionKey: tenantId, // 👈 one replication slot per tenant
  })

const outboxes = new Map(tenants.map((tenantId) => [tenantId, createTenantOutbox(tenantId)]))

for (const outbox of outboxes.values()) {
  await outbox.start()
}

await sql.begin(async (tx) => {
  await tx`INSERT INTO "patient" ...`
  await outboxes.get('tenant-1')!.queue(event, { tx, partitionKey: 'tenant-1' }) // 👈
})
```

`queue` takes the partition key of each message, so any of the consumers can queue messages for any tenant. The consumer of a partition publishes only the messages of its partition.

A slot can be used by one connection at a time. When another instance of your app starts a consumer of the same `consumerName` and `partitionKey`, `start()` fails with `HermesConsumerAlreadyTakenError`. So you can run many replicas of your app: for every tenant, one of them wins, and the others can retry `start()` later to take over when the winner stops.

Any partition key of up to 30 characters works since `1.0.0-alpha.19`, e.g. `tenant-1`. Earlier versions accept only lowercase letters, digits and `_`. A UUID (36 characters) is too long for the `partitionKey` column, so use a shorter id of the tenant.

### What every tenant costs

Every consumer uses:

- **one replication slot.** `max_replication_slots` (default 10) limits the slots of the whole cluster, so raise it to the number of tenants plus a margin. See [Limitations](./postgresql/limitations.md).
- **one WAL sender process and one replication connection.** Raise `max_wal_senders` (default 10) as well.
- **a pool of connections for its own queries.** The pool has up to 10 connections (the default of Postgres.js), so count `(1 + 10) × tenants` against `max_connections`, or limit the pool in `getOptions` (e.g. `max: 2`).

Things to keep in mind:

- **Every slot decodes all the messages.** There is one publication for the whole `outbox` table, so PostgreSQL decodes and streams every message to every slot, and each consumer skips the messages of other tenants. With N tenants, PostgreSQL does the decoding work N times. Filtering on the server side is in the [backlog](https://github.com/chassisjs/hermes/blob/main/docs/BACKLOG.md#filter-partitions-on-the-server-side-postgresql).
- **The slowest slot holds the WAL.** A tenant whose consumer is stopped, or cannot publish, keeps the WAL on the disk until it moves again. Watch the replication lag of every slot (`pg_replication_slots`) and the free disk space.
- **The async outbox is per partition too.** The async outbox of a consumer (`outbox.send()`) publishes only the messages of its partition, and `send()` stores the messages in the partition of the consumer, unless you pass another one: `outbox.send(message, { tx, partitionKey: 'tenant-2' })`. See [Polling outbox](./polling-outbox.md).

### Removing a tenant

A slot that nobody reads holds the WAL forever. When you remove a tenant, stop its consumer and then drop its slot and its position:

```sql
SELECT slot_name, active FROM pg_replication_slots WHERE slot_name LIKE 'hermes_slot_app_%';

SELECT pg_drop_replication_slot('hermes_slot_app_tenant_1_3f2a9c1b7e04');
DELETE FROM "outboxConsumer" WHERE "consumerName" = 'app' AND "partitionKey" = 'tenant-1';
```

The slot name is `hermes_slot_<consumerName>_<partitionKey>`. When the name has characters other than lowercase letters, digits and `_`, or is longer than 63 characters, Hermes replaces these characters with `_`, shortens it and adds a hash, so look the name up in `pg_replication_slots`.

### A database per tenant

Point every consumer at the database of its tenant. Hermes creates its tables, publication and slot in every database:

```typescript
const createTenantOutbox = (tenantId: string) =>
  createOutboxConsumer<DomainEvent>({
    getOptions: () => ({ ...dbOptions, database: `tenant_${tenantId}` }),
    publish: (message) => broker.publish(tenantId, message),
    consumerName: `app_${tenantId}`, // 👈 unique in the whole cluster
  })
```

Replication slot names are unique in the whole **cluster**, not in a database, and a slot belongs to the database where it was created. So when the tenant databases are in one cluster, give every consumer a unique `consumerName` (or `partitionKey`). Two consumers named the same in two databases would try to use one slot, and the second one fails to start.

A schema per tenant (many `outbox` tables in one database) is not supported: the publication (`hermes_pub`) and the tables have fixed names.

## MongoDB

### A partition per tenant

Every consumer opens a change stream that matches only the messages of its partition. MongoDB filters them on the server, so a consumer receives only its tenant's messages.

The partition key is a parameter of the consumer, not of a single message: `publish()` and `withScope()` store the message in the partition of the consumer you call them on. So create one outbox per tenant, also in the parts of your app that only store messages (they do not need to call `start()`):

```typescript
import { createOutboxConsumer } from '@chassisjs/hermes-mongodb'

const createTenantOutbox = (tenantId: string) =>
  createOutboxConsumer<DomainEvent>({
    client,
    db,
    publish: (event) => broker.publish(tenantId, event),
    partitionKey: tenantId, // 👈 one change stream per tenant
  })

const outboxes = new Map(tenants.map((tenantId) => [tenantId, createTenantOutbox(tenantId)]))

for (const outbox of outboxes.values()) {
  await outbox.start()
}

await outboxes.get('tenant-1')!.publish(event, async (session, db) => {
  await db.collection('patients').insertOne(patient, { session })
})
```

Things to keep in mind:

- **Hermes MongoDB does not stop a second instance of the same partition.** Two instances of one partition publish the same messages, and they overwrite each other's position. When you run many replicas of your app, make sure only one of them starts the consumer of a tenant, e.g. with a lock or an [exclusive subscription in Apache Pulsar](./pulsar.md).
- **The position is stored per partition key only.** The `__outboxConsumers` collection has no consumer name, so two different services that use the same database and the same partition key share one position. Give them different partition keys (e.g. `orders_tenant-1` and `billing_tenant-1`) or different databases.
- **Every change stream uses resources.** It keeps a cursor open on the server, reads the oplog, and uses a connection of the `MongoClient` pool while it waits for new events. With many tenants in one process, raise `maxPoolSize` of the client (default 100), or use a partition per group of tenants.
- **A stopped consumer can lose its position.** The position is a resume token that points into the oplog. When a tenant's consumer is stopped longer than the oplog keeps its history, the token expires. See [Limitations](./mongodb/limitations.md).

### Removing a tenant

Stop its consumer and delete its position (and, if you want, its messages):

```typescript
await db.collection('__outboxConsumers').deleteOne({ partitionKey: 'tenant-1' })
await db.collection('__outboxMessages').deleteMany({ partitionKey: 'tenant-1' })
```

### A database per tenant

Hermes uses the collections of the `db` you pass, so every tenant database has its own `__outboxMessages` and `__outboxConsumers`. One `MongoClient` can serve all of them, and the partition key can stay `default`:

```typescript
const createTenantOutbox = (tenantId: string) =>
  createOutboxConsumer<DomainEvent>({
    client,
    db: client.db(`tenant_${tenantId}`), // 👈
    publish: (event) => broker.publish(tenantId, event),
  })
```

Transactions over the tenant's data and its messages work as long as both are in the same tenant database.

## PostgreSQL vs MongoDB

|                                      | PostgreSQL                                                        | MongoDB                                                 |
| ------------------------------------ | ----------------------------------------------------------------- | ------------------------------------------------------- |
| Unit of a tenant                     | Replication slot (`consumerName` + `partitionKey`)                | Change stream (`partitionKey`)                          |
| Partition key of a message           | Per call: `queue(message, { partitionKey })`                      | Per outbox instance                                     |
| Two instances of the same tenant     | The second `start()` fails with `HermesConsumerAlreadyTakenError` | Both run and publish the same messages; you need a lock |
| Filtering of other tenants' messages | In the consumer, after decoding                                   | On the server, in the change stream                     |
| Limit                                | `max_replication_slots`, `max_wal_senders`, connections           | Connections of the pool, load of the change streams     |
| Stopped tenant                       | Its slot holds the WAL, the disk fills up                         | Its resume token can expire, messages can be skipped    |
