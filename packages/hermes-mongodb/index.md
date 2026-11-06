## ⚙️ Install

```bash
npm i @chassisjs/hermes @chassisjs/hermes-mongodb
```

## 😍 Supported versions of the MongoDB

➡️ **7**.0 😙\
➡️ **8**.0 😚\
➡️ **9**.0 😎

These are the versions supported by MongoDB, and the basic scenarios run on each of them in [the tests](https://github.com/chassisjs/hermes/blob/main/packages/hermes-mongodb/test/simple.test.ts). Hermes MongoDB still starts on MongoDB 5.0 and 6.0 (and on AWS DocumentDB 5.0), but they are past their end of life and no longer tested.

## 📒 API

<a href="modules.html">See the full docs.</a>

## ⚠️ Caveats

The implementation is based on the `MongoDB Change Streams`, so internally the `oplog` is used.\
The `oplog` gets removed _if it passes the specified time period or if the oplog reaches the maximum size_.\
So, _if your events are not processed successfully by then, Hermes will not stream them anymore_. They stay in the `__outboxMessages` collection, but you have to replay them on your own.

See the [official docs](https://www.mongodb.com/docs/manual/core/replica-set-oplog/).
