<img src="../../public/logo-main.png" alt="Hermes logo" style="margin: 0 auto; width: 70%; display: block;" />
<br />

# Limitations

MongoDB's oplog (operations log) has time/size-based retention limits. If messages remain unconsumed longer than the oplog retention window, Hermes cannot stream them anymore. They stay in the `__outboxMessages` collection, but you have to replay them on your own.

## Explanation

The oplog is a **capped collection** that stores an ordered history of all write operations in MongoDB. It has two key limits:

1. **Size limit**: The oplog has a maximum size (configurable, typically gigabytes)
2. **Time window**: Older entries are automatically removed when the oplog reaches capacity

If the Hermes MongoDB consumer (outbox processor) is **down or unable to process messages** for longer than the oplog retention window, those messages will not be published because:

➡️ The oplog rolls over and removes old entries when it reaches its size limit

➡️ Hermes stores resume tokens to track its position in the oplog

➡️ If the resume token points to an entry that has already been removed from the oplog, Hermes cannot resume from that position

➡️ Unlike PostgreSQL's WAL (which is retained until acknowledged), MongoDB's oplog does not wait for consumers

This is an **operational consideration**, not a Hermes MongoDB bug. The solution is proper monitoring and sizing.

## When Can This Happen?

Messages can become unrecoverable when:

❌ **Consumer downtime exceeds oplog retention**: Your application is down for hours/days and the oplog rolls over

❌ **Slow processing with high write volume**: The consumer is running but processing messages slower than they're being written, causing the oplog to cycle before older messages are consumed

❌ **Oplog sized too small**: The oplog is too small for your write throughput and expected downtime scenarios

❌ **Network partitions**: The consumer cannot reach MongoDB for an extended period

## How to Prevent Message Loss

### 1. Size Your Oplog Appropriately

Check your current oplog size and retention window:

```javascript
// Connect to MongoDB
use local

// Check oplog size
db.oplog.rs.stats()

// Check oplog time window
db.oplog.rs.find().sort({$natural: 1}).limit(1).forEach(first => {
  db.oplog.rs.find().sort({$natural: -1}).limit(1).forEach(last => {
    const windowSeconds = last.ts.getTime() - first.ts.getTime()
    print("Oplog retention window: " + (windowSeconds / 3600) + " hours")
  })
})
```

**Increase oplog size if needed:**

```javascript
// Resize oplog to 16GB (16000 MB)
db.adminCommand({ replSetResizeOplog: 1, size: 16000 })
```

**Guidelines for sizing:**

- Consider your expected consumer downtime (e.g., deployment, maintenance)
- Factor in write throughput (messages per second)
- Add buffer for unexpected scenarios
- **Rule of thumb**: Oplog should retain at least 24-48 hours of operations

### 2. Monitor Oplog Usage

Set up monitoring and alerting:

```typescript
// Example monitoring script
async function checkOplogHealth() {
  const admin = db.admin()
  const replSetStatus = await admin.command({ replSetGetStatus: 1 })

  // Calculate oplog lag
  const local = client.db('local')
  const oplogStats = await local.command({ collStats: 'oplog.rs' })

  const oplogSizeMB = oplogStats.maxSize / (1024 * 1024)
  const oplogUsedMB = oplogStats.size / (1024 * 1024)
  const oplogUsedPercent = (oplogUsedMB / oplogSizeMB) * 100

  // Alert if oplog is filling up
  if (oplogUsedPercent > 80) {
    alerts.send(`Oplog is ${oplogUsedPercent.toFixed(2)}% full`)
  }

  // Calculate time window
  const oplog = local.collection('oplog.rs')
  const firstEntry = await oplog.find().sort({ $natural: 1 }).limit(1).toArray()
  const lastEntry = await oplog.find().sort({ $natural: -1 }).limit(1).toArray()

  if (firstEntry.length && lastEntry.length) {
    // `ts` is a BSON Timestamp; its high bits are seconds since the epoch
    const windowHours = (lastEntry[0].ts.getHighBits() - firstEntry[0].ts.getHighBits()) / 3600

    // Alert if window is too small
    if (windowHours < 24) {
      alerts.send(`Oplog retention window is only ${windowHours.toFixed(2)} hours`)
    }
  }
}
```

### 3. Ensure High Consumer Availability

Design your system for high availability:

✅ **Use multiple instances**: Run Hermes consumers in a high-availability setup (though only one active consumer per partition)

✅ **Health checks**: Implement health checks to detect consumer failures quickly

✅ **Auto-restart**: Use container orchestration (Kubernetes, Docker Swarm) to automatically restart failed consumers

✅ **Alerting**: Alert immediately if consumers go down

### 4. Use Partitioning for Scalability

Scale horizontally with partition keys:

```typescript
// Partition by tenant
const tenant1Consumer = createOutboxConsumer({
  client,
  db,
  publish: publishHandler,
  partitionKey: 'tenant-1',
})

const tenant2Consumer = createOutboxConsumer({
  client,
  db,
  publish: publishHandler,
  partitionKey: 'tenant-2',
})
```

Benefits:

- Each partition processed independently
- Reduces load per consumer
- Limits blast radius if one consumer falls behind

### 5. Monitor Consumer Lag

Track how far behind consumers are:

```typescript
publish: async (event) => {
  // Measure lag between event creation and processing.
  // Hermes passes only your event, so put the creation time into it.
  const lagMs = Date.now() - event.createdAt.getTime()

  metrics.recordLag(lagMs)

  // Alert if lag exceeds threshold
  if (lagMs > 5 * 60 * 1000) {
    // 5 minutes
    alerts.send(`Consumer lag is ${lagMs / 1000}s`)
  }

  await handleEvent(event)
}
```

## Recovery from Oplog Expiration

If your consumer's resume token points to an expired oplog entry:

**What happens:**

- The Change Stream fails with an error indicating the resume token is no longer valid
- `start()` does not throw. The error is passed to `onDbError`, and Hermes keeps retrying every `waitAfterFailedPublishMs`
- The consumer cannot automatically resume, so handle this error in `onDbError`

**Recovery options:**

### Option 1: Start from Current Position (Accept Message Loss)

```typescript
// Manually clear the consumer's resume token to start fresh
await db.collection('__outboxConsumers').deleteOne({
  partitionKey: 'your-partition-key',
})

// Restart the consumer - it will start from current oplog position
await outbox.start()
```

⚠️ **Warning**: Messages between the old resume token and current position are lost

### Option 2: Replay from Database

If you maintain a `sentAt` timestamp on outbox messages:

```typescript
const outbox = createOutboxConsumer({
  client,
  db,
  publish: publishHandler,
  saveTimestamps: true, // 👈 Enable timestamp tracking
})
```

Then you can query for unsent messages:

```typescript
// Find messages that were never sent
const unsentMessages = await db
  .collection('__outboxMessages')
  .find({
    partitionKey: 'your-partition-key',
    sentAt: { $exists: false },
  })
  .sort({ _id: 1 })
  .toArray()

// Manually replay them
for (const message of unsentMessages) {
  await publishHandler(message.data)
  await db.collection('__outboxMessages').updateOne({ _id: message._id }, { $set: { sentAt: new Date() } })
}
```

## MongoDB vs PostgreSQL: Retention Comparison

| Aspect                          | MongoDB (Oplog)                           | PostgreSQL (WAL)                              |
| ------------------------------- | ----------------------------------------- | --------------------------------------------- |
| **Retention Model**             | Time/size-based rolling window            | Indefinite until acknowledged                 |
| **Consumer Downtime Tolerance** | Limited to oplog window (hours/days)      | Unlimited (until disk full)                   |
| **Operational Focus**           | Monitor oplog size and consumer uptime    | Monitor WAL growth and disk space             |
| **Message Loss Scenario**       | Consumer down longer than oplog retention | Disk full (WAL growth unbounded)              |
| **Recovery**                    | May lose messages if resume token expired | No message loss, but disk pressure            |
| **Best For**                    | High-availability setups with monitoring  | Critical events requiring guaranteed delivery |

## Best Practices Summary

✅ **Size your oplog generously** - at least 24-48 hours of retention

✅ **Monitor oplog health** - track size, usage, and time window

✅ **Ensure consumer high availability** - use orchestration and auto-restart

✅ **Alert on consumer lag** - detect processing delays early

✅ **Use partitioning** - scale horizontally and reduce load

✅ **Test recovery scenarios** - practice handling consumer downtime

✅ **Consider PostgreSQL** - for scenarios requiring unbounded retention

## When to Use PostgreSQL Instead

Consider Hermes PostgreSQL if:

- ❗ Consumer downtime may exceed oplog retention window
- ❗ Zero message loss is absolutely critical (financial transactions)
- ❗ You cannot guarantee high consumer availability
- ❗ Operational complexity of oplog management is too high
- ❗ You need indefinite message retention

Both implementations are reliable when operated correctly - choose based on your operational requirements and constraints.
