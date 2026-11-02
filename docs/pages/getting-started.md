## ⚙️ Install

If you work with **PostgreSQL**, then:

```bash
npm i @chassisjs/hermes @chassisjs/hermes-postgresql
```

If you work with **MongoDB**, then:

```bash
npm i @chassisjs/hermes @chassisjs/hermes-mongodb
```

## 💡 The easiest example for MongoDB

First, create an OutboxConsumer instance.

```typescript
const outbox = createOutboxConsumer<Event1 | Event2>({
  client,
  db: client.db('hospital'),
  publish: async (event) => await eventBus.publish(event),
})

const stop = await outbox.start()
```

Remember, that the `publish` **has to throw an error** if the delivery to the message broker fails.

Then, you can use the instance to publish events along with a database operation:

```typescript
await outbox.publish(event, async (session, db) => {
  await db.collection('test').insertOne({ param: 1 }, { session })
})
```

As you see, the `event` is passed to the `outbox.publish`. **Hermes** starts a new database session and passes it to the callback (the second parameter of `outbox.publish`) as its first argument.\
The changes made in the callback will be persisted along with the passed event.\
_The event will be sent as fast as the message broker is available._

Alternatively, you can also create a session by your own:

```typescript
await client.withSession(async (session) => {
  await session.withTransaction(async (session) => {
    await outbox.publish(event1, session)
    await outbox.publish(event2, session)
  })
})
```

## Partitioning

By default, `Hermes` works on `default` partition.\
If you want to scale out `Hermes`, then you can use multiple partition keys and run separate instances for each partition key.\
Example can be running `Hermes` instances for tenants of your system. Then, each `Hermes` will be responsible for one tenant.

> ➡️ **If you noticed a performance issue**: Consider, if your application is not too big, dealing with too many messages. Maybe it's time for a redesign and try to split your application into smaller ones?

```typescript
const outbox1 = createOutboxConsumer<Event1 | Event2>({
  client,
  db: client.db('hospital'),
  partitionKey: 'tenant-1',
  publish,
})
const outbox2 = createOutboxConsumer<Event1 | Event2>({
  client,
  db: client.db('hospital'),
  partitionKey: 'tenant-2',
  publish,
})
```

Run exactly one instance per partition key. **Hermes MongoDB** does not prevent a second instance of the same partition from running, and both would publish the same events.

## 🧹 Cleaning

By default, **Hermes** does the cleanup on `SIGTERM` and `SIGINT` unless `shouldDisposeOnSigterm` is set to `false`. Then you have to call the `stop` function returned by `outbox.start()` on your own.
