<img src="../../public/logo-main.png" alt="Hermes logo" style="margin: 0 auto; width: 70%; display: block;" />
<br />

# Basic usage

## MongoDB configuration

First, ensure your MongoDB instance is running as a **replica set**. Change Streams require replica sets to function.

This is how you can set up a replica set with Docker Compose 👇

```yaml
services:
  mongo:
    image: mongo:7.0
    restart: always
    ports:
      - '27017:27017'
    environment:
      - MONGO_INITDB_ROOT_USERNAME=hermes
      - MONGO_INITDB_ROOT_PASSWORD=hermes
      - MONGO_INITDB_DATABASE=hermes
    command: mongod --replSet rs0
    healthcheck:
      test: ['CMD-SHELL', 'mongosh --eval "db.adminCommand(''ping'')" || exit 1']
      interval: 10s
      start_period: 5s
      timeout: 5s
      retries: 5
```

After starting MongoDB, you need to initialize the replica set:

```bash
docker exec -it <container-name> mongosh --eval "rs.initiate()"
```

For **local development**, you can also use `directConnection=true` in your connection string if you're running a single-node replica set:

```typescript
const mongoUri = 'mongodb://localhost:27017/?directConnection=true'
```

### AWS DocumentDB

When it comes to [AWS DocumentDB](https://aws.amazon.com/documentdb/), Change Streams are supported (DocumentDB 5.0+, Hermes MongoDB requires version 5 or newer):

```typescript
import { MongoClient } from 'mongodb'

const client = new MongoClient(
  'mongodb://<username>:<password>@<cluster-endpoint>:27017/?tls=true&replicaSet=rs0&readPreference=secondaryPreferred&retryWrites=false',
)
```

You can use AWS CDK to provision DocumentDB:

```typescript
import * as cdk from 'aws-cdk-lib'
import { aws_docdb as docdb, aws_ec2 as ec2 } from 'aws-cdk-lib'

const vpc = ec2.Vpc.fromLookup(this, 'DefaultVPC', { isDefault: true })

const cluster = new docdb.DatabaseCluster(this, 'DocumentDBCluster', {
  instanceType: ec2.InstanceType.of(ec2.InstanceClass.MEMORY5, ec2.InstanceSize.LARGE),
  vpc,
  masterUser: {
    username: 'hermes',
  },
  engineVersion: '5.0.0', // 👈 Hermes MongoDB requires 5.0+
})
```

### MongoDB Atlas

[MongoDB Atlas](https://www.mongodb.com/cloud/atlas) supports Change Streams by default. Simply create a cluster and use the connection string provided:

```typescript
const mongoUri = 'mongodb+srv://<username>:<password>@cluster0.mongodb.net/?retryWrites=true&w=majority'
```

## Installation

```bash
npm i @chassisjs/hermes @chassisjs/hermes-mongodb

# or

pnpm install @chassisjs/hermes @chassisjs/hermes-mongodb

# or

yarn add @chassisjs/hermes @chassisjs/hermes-mongodb
```

## Quick Start Example

Here's a complete example showing how to use Hermes MongoDB:

```typescript
import { createOutboxConsumer } from '@chassisjs/hermes-mongodb'
import { MongoClient } from 'mongodb'

// 1. Define your event types
type DomainEvent<Name extends string, Data> = Readonly<{
  name: Name
  data: Data
}>

type UserRegistered = DomainEvent<
  'UserRegistered',
  {
    userId: string
    email: string
  }
>

type UserEvent = UserRegistered

// 2. Connect to MongoDB
const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/?directConnection=true'
const client = new MongoClient(mongoUri)
const db = client.db('myapp')

await client.connect()

// 3. Create the outbox consumer
const outbox = createOutboxConsumer<UserEvent>({
  client,
  db,
  publish: async (event) => {
    // This callback is called for each event
    // If it succeeds, the event is acknowledged
    // If it throws, the event will be retried
    console.log('Processing event:', event)

    // In production, publish to your message broker:
    // await messageBroker.publish(event)
    // await kafka.send({ topic: 'user-events', messages: [event] })
  },
})

// 4. Start the consumer (it throws for MongoDB older than 5.0)
const stop = await outbox.start()

// 5. Publish events with transactions
async function registerUser(email: string) {
  const userId = generateId()

  // Everything in one transaction!
  await client.withSession((session) =>
    session.withTransaction(async (session) => {
      // Save user to database
      await db.collection('users').insertOne({ userId, email, createdAt: new Date() }, { session })

      // Publish event in the same transaction
      await outbox.publish(
        {
          name: 'UserRegistered',
          data: { userId, email },
        },
        session, // 👈 Pass session for atomicity
      )
    }),
  )
}
```

## Key Concepts

### One Instance per Partition

Run exactly one instance of the outbox consumer per partition key. Hermes MongoDB does not prevent a second instance of the same partition from running, and both would publish the same events. Use a lock (e.g. [an exclusive subscription in Apache Pulsar](/pages/pulsar.md)) when you run many replicas of your app.

### Partition Keys

You can use partition keys to scale horizontally:

```typescript
// Consumer 1 - handles tenant A
const outbox1 = createOutboxConsumer<UserEvent>({
  client,
  db,
  publish: publishToTenantA,
  partitionKey: 'tenant-a', // 👈
})

// Consumer 2 - handles tenant B
const outbox2 = createOutboxConsumer<UserEvent>({
  client,
  db,
  publish: publishToTenantB,
  partitionKey: 'tenant-b', // 👈
})

await outbox1.start()
await outbox2.start()
```

Each partition is processed independently, allowing you to scale based on your needs.

### Collections

Hermes stores the events in the `__outboxMessages` collection and the consumers' positions in the `__outboxConsumers` collection. The names are fixed.

### Publishing Events

There are two ways to publish events:

**1. Pass session explicitly (recommended):**

```typescript
await client.withSession((session) =>
  session.withTransaction(async (session) => {
    await db.collection('users').insertOne(user, { session })
    await outbox.publish(event, session) // 👈
  }),
)
```

**2. Let Hermes manage the transaction:**

```typescript
await outbox.publish(event, async (session, db) => {
  // Hermes starts a transaction for you
  await db.collection('users').insertOne(user, { session })
})
```

Both approaches guarantee atomicity. Choose based on your needs:

- Use #1 when you need fine-grained control over transactions
- Use #2 for simpler code when Hermes can manage the transaction

## Event Handler Best Practices

### Make Handlers Idempotent

Since Hermes guarantees **at-least-once delivery**, your handlers may be called multiple times. Hermes passes only your event to `publish`, so put an identifier into the event itself:

```typescript
publish: async (event) => {
  // Check if already processed
  const existing = await db.collection('processed_events').findOne({
    eventId: event.eventId,
  })

  if (existing) {
    console.log('Event already processed, skipping')
    return // ✅ Safe to skip
  }

  // Process the event
  await handleEvent(event)

  // Mark as processed
  await db.collection('processed_events').insertOne({
    eventId: event.eventId,
    processedAt: new Date(),
  })
}
```

### Handle Errors Properly

Only throw errors when you want the event to be retried. Hermes retries it every `waitAfterFailedPublishMs` (1 second by default) with no limit, and the following events of the partition wait until it succeeds:

```typescript
publish: async (event) => {
  try {
    await processEvent(event)
  } catch (error) {
    if (isRetryable(error)) {
      // Throw to trigger retry
      throw error
    } else {
      // Log and skip non-retryable errors
      console.error('Non-retryable error:', error)
      // Don't throw - event will be acknowledged
    }
  }
}
```

### Monitor Processing Time

Keep your event handlers fast to prevent backlog:

```typescript
publish: async (event) => {
  const start = Date.now()

  try {
    await processEvent(event)
  } finally {
    const duration = Date.now() - start
    metrics.recordEventProcessingTime(duration)

    if (duration > 5000) {
      console.warn('Slow event processing:', { event, duration })
    }
  }
}
```

## Graceful Shutdown

By default, Hermes stops the consumer on `SIGTERM` and `SIGINT`. If you set `shouldDisposeOnSigterm: false`, clean up on your own:

```typescript
const stop = await outbox.start()

const cleanup = async () => {
  console.log('Shutting down gracefully...')

  // Stop the outbox consumer
  await stop()

  // Close MongoDB connection
  await client.close()

  process.exit(0)
}

process.on('SIGINT', cleanup)
process.on('SIGTERM', cleanup)
```

## Configuration Options

Here are all available configuration options for `createOutboxConsumer`:

```typescript
type ConsumerCreationParams<Event> = {
  // Required
  client: MongoClient // MongoDB client instance
  db: Db // Database instance
  publish: (event: Event) => Promise<void> // Event handler callback, has to throw on failure

  // Optional
  partitionKey?: string // Partition key for scaling (default: 'default')
  waitAfterFailedPublishMs?: number // Delay before retrying a failed publish (default: 1000)
  shouldDisposeOnSigterm?: boolean // Stop the consumer on SIGTERM/SIGINT (default: true)
  saveTimestamps?: boolean // Save `sentAt` on every sent event; adds a write per event (default: false)
  onFailedPublish?: (error: unknown) => void // Called on every failed publish
  onDbError?: (error: unknown) => void // Called on change stream/database errors
  now?: () => Date // Clock used for timestamps (default: () => new Date())
}
```

## Monitoring and Observability

### Monitor Oplog Size

The MongoDB oplog has limited retention. Monitor it to ensure consumers stay within the retention window:

```javascript
// Connect to MongoDB
use local

// Check oplog status
db.oplog.rs.find().sort({$natural: -1}).limit(1)

// Check oplog size
db.oplog.rs.stats()

// Check oplog window (time range)
db.oplog.rs.find().sort({$natural: 1}).limit(1).forEach(first => {
  db.oplog.rs.find().sort({$natural: -1}).limit(1).forEach(last => {
    print("Oplog window: " + (last.ts.getTime() - first.ts.getTime()) + " seconds")
  })
})
```

### Set Up Alerts

Monitor key metrics:

```typescript
// Track lag between event creation and processing (put `createdAt` into your event)
const lag = Date.now() - event.createdAt.getTime()
metrics.recordEventLag(lag)

if (lag > 60000) {
  alerts.send('Event processing lag > 1 minute')
}

// Track oplog size
const oplogSize = await getOplogSize()
if (oplogSize > 0.8 * maxOplogSize) {
  alerts.send('Oplog size > 80% of max')
}
```

### Increase Oplog Size if Needed

If events are being lost due to oplog expiration:

```javascript
// Check current oplog size
db.oplog.rs.stats().maxSize

// Increase oplog size to 16GB
db.adminCommand({ replSetResizeOplog: 1, size: 16000 })
```

## Troubleshooting

### "Change Streams require MongoDB to be running as a replica set"

**Solution**: Initialize MongoDB as a replica set:

```bash
# For Docker
docker exec -it <container-id> mongosh --eval "rs.initiate()"

# For local MongoDB
mongosh --eval "rs.initiate()"
```

### Events not being processed

**Check:**

1. Is MongoDB running as a replica set? (`rs.status()`)
2. Is the outbox consumer started? (`await outbox.start()`)
3. Are there errors in the `publish` callback?
4. Check MongoDB logs for Change Stream errors

### Oplog full or events lost

**Solutions:**

1. Increase oplog size (see above)
2. Ensure consumers are processing events quickly
3. Monitor oplog usage with alerts
4. Consider moving to PostgreSQL for critical events

### High memory usage

Hermes MongoDB takes one event at a time from the change stream and fetches the next one only after the previous one is published, so slow publishing does not pile events up in memory. They wait in the `__outboxMessages` collection instead.

**Causes:**

- Large event payloads
- Memory used by your `publish` callback

**Solutions:**

- Reduce event payload size
- Scale horizontally with partition keys

## Production Checklist

Before going to production, ensure:

- ✅ MongoDB is running as a replica set (or using Atlas/DocumentDB)
- ✅ Oplog size is appropriate for your throughput
- ✅ Event handlers are idempotent
- ✅ Error handling is implemented
- ✅ Monitoring and alerting are set up
- ✅ Graceful shutdown is implemented
- ✅ Backup and disaster recovery plans are in place
- ✅ Load testing has been performed
- ✅ Oplog retention is monitored

## Next Steps

- Check out the [Medicine Assignment example](/pages/mongodb-medicine-assignment.md) for a complete walkthrough
- Learn about [How it works](/pages/mongodb/how-does-it-work.md) in detail
- Explore the [API documentation](https://docs.hermesjs.tech/hermes-mongodb/index.html)
- Compare with [PostgreSQL implementation](/pages/postgresql/how-does-it-work.md)
