<img src="../../public/logo-main.png" alt="Hermes logo" style="margin: 0 auto; width: 70%; display: block;" />
<br />

# Basic usage

The classic use case for the Hermes and Outbox pattern itself is saving data in a database and publishing an event, so that we are sure the two happen within one transaction and that the event will be eventually published.

First create an instnace of the Hermes PostgreSQL 👇

```typescript
import {
  type HermesMessageEnvelope,
  type MessageEnvelope,
  createOutboxConsumer,
  useBasicAsyncOutboxConsumerPolicy,
} from '@chassisjs/hermes-postgresql'

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
// Running this for the second time will fail.
await outbox.start()
```

The cleanup will be done automatically on _SIGTERM_.

After that, you can use your Hermes 👇

```typescript
await sql.begin(async (sql) => {
  await sql`
    insert into users
      (name, age)
    values
      ('Max', 'Payne')
  `
  const patientRegisterdEvent: MessageEnvelope<SomeEvent> = {
    message: {
      kind: 'event',
      type: 'SomeEvent',
      data: { name: 'Max', surname: 'Payne' },
    },
    messageId: 'your message id',
    messageType: 'SomeEvent',
  }

  // Passing the transaction 👇
  await hermes.queue(patientRegisterdEvent, { tx: sql })
})
```
