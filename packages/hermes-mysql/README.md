_A mythical god who brings reliability to your system 🫒 by implementing the Outbox pattern, so you don't have to think of it too much._

_You don't have to pray for the gifts of nature. Just run npm and type:_

```bash
npm i @chassisjs/hermes @chassisjs/hermes-mysql
```

### Features

- **MySQL 8.0+ and Aurora MySQL 3**, with [mysql2](https://github.com/sidorares/node-mysql2)
- **Messages stored in the transactions of your application**: a `mysql2` connection, Kysely, Drizzle, Prisma or any library that runs SQL
- **No lost messages**: Hermes does not poll for "the messages after the last id". Every message keeps its own state, so a message is not skipped when its transaction commits after a transaction with a greater `AUTO_INCREMENT` id
- **Ordered partitions**: the messages of a partition are published one by one, in order, by one instance of your application at a time. The instances share the partitions and take over the partitions of an instance that died
- **Retries** with an exponential backoff. A failed message stops only its partition
- **Versioned migrations** that many instances can run at the same time

### Example

```typescript
import { createOutboxConsumer } from '@chassisjs/hermes-mysql'

const outbox = createOutboxConsumer<DomainEvent>({
  getOptions: () => ({ host: 'localhost', port: 3306, user: 'app', password: 'secret', database: 'app' }),
  publish: async (envelope) => {
    await broker.publish(envelope.messageType, envelope.message)
  },
  consumerName: 'app',
})

const stop = await outbox.start()

const connection = await pool.getConnection()

await connection.beginTransaction()
await connection.query('INSERT INTO patient (id) VALUES (?)', [patientId])
await outbox.queue(
  { messageId: patientId, messageType: 'PatientRegistered', message: { patientId } },
  { tx: connection, partitionKey: tenantId },
)
await connection.commit()
```

Delivery is _at-least-once_, so make the handlers of the messages idempotent 🥰

See the [documentation](https://docs.hermesjs.tech/pages/mysql/basic-usage.html).
