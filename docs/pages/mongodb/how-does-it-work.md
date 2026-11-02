<img src="../../public/logo-main.png" alt="Hermes logo" style="margin: 0 auto; width: 70%; display: block;" />
<br />

# How does it work?

Simple! 😌

## TL;DR

- Hermes MongoDB is an implementation of the **Outbox pattern** in **NodeJS**/**TypeScript** environment.

- **Save data in the database and publish messages in one reliable logical unit.** Keep the consumer running within the oplog retention window (see [limitations](./limitations.md)).

- God Hermes finds a love interest in the native [MongoDB Node.js Driver](https://www.mongodb.com/docs/drivers/node/) which is its tool for talking to MongoDB. You pass your own `MongoClient` and `Db`.

- Hermes MongoDB follows the "**Log First!**" paradigm by working on MongoDB's **Change Streams**.

- Hermes relies on MongoDB's [Change Streams](https://www.mongodb.com/docs/manual/changeStreams/) feature.

- Hermes MongoDB provides its own implementation optimized for the Outbox pattern needs.

- This approach enables Hermes to receive information about things that come to the Outbox collection in **real-time**. **No long-polling**. Fast and reliable **publisher-subscriber** connection to MongoDB.

## What are Change Streams and Oplog?

Shortly, Change Streams provide a way to listen to real-time data changes in MongoDB. They are built on top of the **oplog** (operations log), which is similar to PostgreSQL's Write-Ahead Log (WAL).

**How MongoDB Change Streams work:**

➡️ Change Streams allow applications to access real-time data changes without the complexity and risk of tailing the oplog

➡️ MongoDB tracks changes in a special collection called the oplog (operations log) on replica sets

➡️ The oplog is a capped collection that stores an ordered history of logical writes

➡️ Each operation in the oplog has a resume token that uniquely identifies a point in time

➡️ Applications can use resume tokens to restart streams from specific points after disconnections

➡️ Change Streams provide a high-level API on top of the oplog with built-in error handling

➡️ Unlike PostgreSQL's WAL (which is retained until acknowledged), MongoDB's oplog can expire based on size or time limits

➡️ A subscriber gets the following logical transactional messages: insert, update, delete, replace, and more

➡️ Change Streams guarantee that events are delivered in the order they occurred

## MongoDB Change Streams vs PostgreSQL Logical Replication

While both implement the Outbox pattern reliably, there are important infrastructure differences:

**MongoDB Change Streams:**

- Based on the **oplog** (operations log)
- Oplog has limited retention (configurable, typically hours to days)
- Hermes tracks resume tokens to recover from any point that is still in the oplog
- **Operational consideration**: If consumer is down longer than oplog retention, you need to ensure oplog is sized appropriately
- Requires MongoDB to run as a replica set
- Simpler setup and configuration
- Excellent for most use cases with proper oplog monitoring

**PostgreSQL Logical Replication:**

- Based on the **WAL** (Write-Ahead Log)
- WAL is retained indefinitely until acknowledged by all replication slots
- Replication slots track consumer position
- **Operational consideration**: WAL can grow unbounded if consumers don't acknowledge
- Requires logical replication configuration
- More complex setup with replication slot management
- Better when you need infinite retention regardless of consumer downtime

## Internal implementation

**How things work internally in Hermes MongoDB:**

➡️ The app sends messages (events, commands) to Hermes MongoDB

➡️ Hermes MongoDB stores these messages in a dedicated Outbox collection (`__outboxMessages`), along with your data, in one transaction

➡️ All messages are logged in MongoDB's oplog, in the order of their commits

➡️ Hermes reads the inserts of its partition from a Change Stream, one message at a time

➡️ For each message, Hermes calls the application callback (`publish`) and waits until it finishes

➡️ When the callback finishes without an error, Hermes saves the message's resume token in the `__outboxConsumers` collection. This is the acknowledgment: after a restart, Hermes resumes after that message

➡️ Only then Hermes fetches the next message. So messages are published strictly one by one and in order, and there is no in-memory queue to grow

➡️ When the callback throws, Hermes calls `onFailedPublish` and tries again after `waitAfterFailedPublishMs` (1 second by default), with no limit of attempts. The following messages of the partition wait until it succeeds

## Key Features

### Atomic Operations with MongoDB Transactions

Hermes MongoDB uses MongoDB's multi-document transactions to ensure atomicity:

```typescript
await client.withSession((session) =>
  session.withTransaction(async (session) => {
    // Both operations succeed or both fail
    await db.collection('entities').insertOne(entity, { session })
    await outbox.publish(event, session)
  }),
)
```

### Real-Time Event Processing

Unlike polling-based solutions, Hermes MongoDB receives events in real-time through Change Streams:

- **Low latency**: Events are processed as soon as they're committed
- **Efficient**: No wasted CPU cycles polling the database
- **Scalable**: Can handle high throughput with minimal overhead

### At-Least-Once Delivery

Hermes MongoDB guarantees that events are delivered at least once:

- Events are retried on failure, with no limit of attempts
- Resume tokens allow recovery from disconnections
- Your event handlers should be idempotent

### Ordered Processing

Events are always processed in the order they were created:

- Per partition, events maintain strict ordering
- Hermes doesn't even fetch event N+1 until event N is published and acknowledged
- Prevents out-of-order processing in distributed systems

## Partitioning for Horizontal Scaling

Hermes MongoDB supports partitioning to scale horizontally:

```typescript
// Consumer 1 handles partition A
const outbox1 = createOutboxConsumer({
  client,
  db,
  publish: publishHandler,
  partitionKey: 'partition-a',
})

// Consumer 2 handles partition B
const outbox2 = createOutboxConsumer({
  client,
  db,
  publish: publishHandler,
  partitionKey: 'partition-b',
})
```

Each partition can be processed by a separate instance, allowing you to scale based on your needs. Run exactly one instance per partition: Hermes MongoDB does not prevent two instances of the same partition from running, and both would publish the same events.

## Important Considerations

### Oplog Retention

The MongoDB oplog has a finite size and retention period:

- **Monitor oplog size** regularly
- **Ensure consumers are always running** to process events before expiration
- **Alert on lag** if consumers fall behind
- **Consider increasing oplog size** for high-throughput scenarios

### Replica Set Requirement

Change Streams require MongoDB to run as a replica set:

- Even in development, you need a replica set (can be single-node)
- Use Docker or docker-compose to easily set up replica sets
- AWS DocumentDB and MongoDB Atlas support Change Streams; Hermes MongoDB requires version 5.0 or newer

### Idempotency

Since Hermes guarantees **at-least-once delivery**, your event handlers may be called multiple times for the same event. Hermes passes only your event to `publish`, so put an identifier into the event itself:

```typescript
publish: async (event) => {
  // Check if already processed
  const processed = await checkIfProcessed(event.eventId)
  if (processed) return // Safe to skip

  // Process the event
  await handleEvent(event)

  // Mark as processed
  await markAsProcessed(event.eventId)
}
```

## When to Use MongoDB vs PostgreSQL

**Use Hermes MongoDB when:**

- You're already using MongoDB
- You can ensure consumers run reliably (with monitoring and alerting)
- You can properly size and monitor oplog retention
- You want simpler setup and configuration
- You need real-time processing with minimal overhead
- Your operational setup ensures high consumer availability

**Use Hermes PostgreSQL when:**

- You need unbounded message retention regardless of consumer downtime
- You prefer WAL-based retention over oplog time windows
- Consumers might be offline for extended periods
- You're already using PostgreSQL
- You can manage replication slots and WAL growth
