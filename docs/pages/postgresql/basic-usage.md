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
