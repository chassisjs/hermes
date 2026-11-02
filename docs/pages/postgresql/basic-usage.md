<img src="../../public/logo-main.png" alt="Hermes logo" style="margin: 0 auto; width: 70%; display: block;" />
<br />

# Basic usage

The classic use case for the Hermes and Outbox pattern itself is saving data in a database and publishing an event, so that we are sure the two happen within one transaction and that the event will be eventually published.

First create an instance of the Hermes PostgreSQL 👇

```typescript
import { type MessageEnvelope, createOutboxConsumer } from '@chassisjs/hermes-postgresql'

const hermes = createOutboxConsumer<RegisterPatientCommand | RegisterPatientEvent>({
  getOptions() {
    return {
      host: 'localhost',
      port: 5432,
      database: 'hermes',
      user: 'hermes',
      password: 'hermes',
    }
  },
  publish: async (message) => {
    /*
      If this callback successfully finishes ✅,
      then the event is considered as delivered 📨🎉;
      If this callback throws an error ⛔,
      then Hermes PostgreSQL 🫒 will try to deliver this message again later ⏲️.
    */

    // Handle the message (event or command).
    console.log(message)
  },
  consumerName: 'app',
})

export { hermes }
```

Then, start the Hermes PostgreSQL 👇

```typescript
// Starting a second consumer of the same name and partition fails with `HermesConsumerAlreadyTakenError`.
const stop = await hermes.start()
```

Call the returned `stop` function when your app shuts down (e.g. on _SIGTERM_). It lets the message being published finish and closes the connections.

After that, you can use your Hermes 👇

```typescript
await sql.begin(async (sql) => {
  await sql`
    insert into users
      (name, surname)
    values
      ('Max', 'Payne')
  `
  const patientRegisteredEvent: MessageEnvelope<SomeEvent> = {
    message: {
      kind: 'event',
      type: 'SomeEvent',
      data: { name: 'Max', surname: 'Payne' },
    },
    messageId: 'your message id',
    messageType: 'SomeEvent',
  }

  // Passing the transaction 👇
  await hermes.queue(patientRegisteredEvent, { tx: sql })
})
```

## Using the transactions of your database library

_Available since `1.0.0-alpha.19`._

Hermes talks to PostgreSQL with [Postgres.js](https://github.com/porsager/postgres) on its own connections. Your app can use any other library. To store messages atomically with your data, pass your library's transaction as `tx`. Hermes accepts:

- a Postgres.js transaction, as in the example above,
- any object with a `query(text, params)` method that runs SQL with positional parameters (`$1`, `$2`, ...) in your transaction.

The same works for `send()` of the async outbox: `await hermes.send(message, tx)`.

### node-postgres (`pg`)

A `pg` client already has a matching `query` method, so pass it as it is:

```typescript
const client = await pool.connect()

try {
  await client.query('BEGIN')
  await client.query(`insert into users (name, surname) values ($1, $2)`, ['Max', 'Payne'])
  await hermes.queue(patientRegisteredEvent, { tx: client })
  await client.query('COMMIT')
} catch (error) {
  await client.query('ROLLBACK')
  throw error
} finally {
  client.release()
}
```

The `QueryRunner` of TypeORM also has a matching `query` method.

### Kysely

```typescript
import { CompiledQuery } from 'kysely'

await db.transaction().execute(async (trx) => {
  await trx.insertInto('users').values({ name: 'Max', surname: 'Payne' }).execute()
  await hermes.queue(patientRegisteredEvent, {
    tx: { query: (text, params) => trx.executeQuery(CompiledQuery.raw(text, params)) },
  })
})
```

### Drizzle

```typescript
import { sql } from 'drizzle-orm'

const toDrizzleSql = (text: string, params: unknown[]) =>
  sql.join(text.split(/\$(\d+)/).map((part, i) => (i % 2 === 0 ? sql.raw(part) : sql`${params[Number(part) - 1]}`)))

await db.transaction(async (tx) => {
  await tx.insert(users).values({ name: 'Max', surname: 'Payne' })
  await hermes.queue(patientRegisteredEvent, {
    tx: { query: (text, params) => tx.execute(toDrizzleSql(text, params)) },
  })
})
```

### Prisma

```typescript
await prisma.$transaction(async (tx) => {
  await tx.user.create({ data: { name: 'Max', surname: 'Payne' } })
  await hermes.queue(patientRegisteredEvent, {
    tx: { query: (text, params) => tx.$executeRawUnsafe(text, ...params) },
  })
})
```

When you queue many messages at once (`hermes.queue([message1, message2], { tx })`), Hermes stores them all or none, also without `tx`.
