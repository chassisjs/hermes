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

When it comes to [AWS DocumentDB](https://aws.amazon.com/documentdb/), Change Streams are supported out of the box (DocumentDB 4.0+):

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
  engineVersion: '4.0.0', // 👈 Change Streams require 4.0+
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

// 4. Start the consumer
outbox.start()

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

### Consumer Name

Each outbox consumer has a unique name. This prevents multiple consumers from competing:

```typescript
const outbox = createOutboxConsumer<UserEvent>({
  client,
  db,
  publish,
  consumerName: 'user-service', // 👈 Unique consumer identifier
})
```

Only one consumer with the same name can run at a time. If you try to start another consumer with the same name, MongoDB will prevent it.

This is a beautiful native mechanism that ensures exactly-one consumer of a given name is processing events.

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

outbox1.start()
outbox2.start()
```

Each partition is processed independently, allowing you to scale based on your needs.

### Custom Collection Names

By default, Hermes creates a collection named `hermes_outbox`. You can customize this:

```typescript
const outbox = createOutboxConsumer<UserEvent>({
  client,
  db,
  publish,
  collectionName: 'my_custom_outbox', // 👈
})
```

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

Since Hermes guarantees **at-least-once delivery**, your handlers may be called multiple times:

```typescript
publish: async (event) => {
  // Check if already processed
  const existing = await db.collection('processed_events').findOne({
    eventId: event.messageId,
  })

  if (existing) {
    console.log('Event already processed, skipping')
    return // ✅ Safe to skip
  }

  // Process the event
  await handleEvent(event)

  // Mark as processed
  await db.collection('processed_events').insertOne({
    eventId: event.messageId,
    processedAt: new Date(),
  })
}
```

### Handle Errors Properly

Only throw errors when you want the event to be retried:

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

Always clean up resources when shutting down:

```typescript
const cleanup = async () => {
  console.log('Shutting down gracefully...')

  // Stop the outbox consumer
  outbox.stop()

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
interface OutboxConsumerConfig<T> {
  // Required
  client: MongoClient // MongoDB client instance
  db: Db // Database instance
  publish: (event: T) => Promise<void> // Event handler callback

  // Optional
  consumerName?: string // Unique consumer identifier (default: 'default')
  collectionName?: string // Outbox collection name (default: 'hermes_outbox')
  partitionKey?: string // Partition key for scaling (default: undefined)
  batchSize?: number // Number of events to process in parallel (default: 10)
  pollInterval?: number // Polling interval in ms for recovery (default: 5000)
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
// Track lag between event creation and processing
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
2. Is the outbox consumer started? (`outbox.start()`)
3. Are there errors in the `publish` callback?
4. Check MongoDB logs for Change Stream errors

### Oplog full or events lost

**Solutions:**

1. Increase oplog size (see above)
2. Ensure consumers are processing events quickly
3. Monitor oplog usage with alerts
4. Consider moving to PostgreSQL for critical events

### High memory usage

**Causes:**

- Change Stream buffering too many events
- Slow event processing
- Large event payloads

**Solutions:**

- Optimize event handlers for performance
- Reduce event payload size
- Scale horizontally with partition keys
- Adjust `batchSize` configuration

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
