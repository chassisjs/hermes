# Change Log

All notable changes to this project will be documented in this file.
See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

# Unreleased

### Features

- **Every projection has its own tables**: `hermes_projection_<name>` for the documents (`id`, `data`, `created_at`, `updated_at`) and `hermes_projection_<name>_versions` for the version of every stream that fed a document, instead of the shared `hermes_projections` and `hermes_projection_versions`. `projectionTables(projection)` returns their names; a name that is not lowercase `[a-z0-9_]` (up to 37 characters) gets 8 characters of its SHA-256, so that two projections never share a table.
- The tables are created when they are missing, with `CREATE TABLE IF NOT EXISTS` on a connection of their own (DDL commits, so never in a transaction), and never changed: `eventStore.init()` creates the tables of all the projections given to `createEventStore`, the first append creates those of the inline projections, `createProjectionConsumer` creates those of its projection on start (unless `migrate: false`), and `migrate(pool, { eventStore: true, projections })` creates them in a deployment pipeline. Call `init()` on start when you append in a transaction of the application (`tx`): a table created after that transaction began cannot be read in it (`ER_TABLE_DEF_CHANGED`).
- `readProjection` returns `null` when the tables of the projection do not exist yet.

### BREAKING CHANGES

- Event store migration 3 drops `hermes_projections` and `hermes_projection_versions` with their documents, and removes the checkpoints of the async projections (`projection:*`), so that their consumers build them again from the first event. A single-stream inline projection catches up on the next append to a stream; the documents of a multi-stream inline projection are not built again.

# [1.0.0-alpha.24](https://github.com/chassisjs/hermes/compare/v1.0.0-alpha.23...v1.0.0-alpha.24) (2026-11-05)

It needs `@chassisjs/hermes` `~1.0.0-alpha.24` (`defineHermesReaction`).

### Features

- `createReactionConsumer`: runs a reaction (`defineHermesReaction` / `reactOn` of `@chassisjs/hermes`) on the events it handles, one by one per stream, in their order, by one instance at a time. The handler and the checkpoint share one transaction (`READ COMMITTED`), so what the handler does in `tx`, e.g. an append to a stream of another module, is done once; work outside of `tx` is done at least once. A failing handler rolls back and is retried; the events after it in its stream wait. The events the reaction does not handle only move its checkpoint, without a transaction.
- Dead letters of reactions: with `maxAttempts`, the last failing attempt writes the event to `hermes_dead_letters` (consumer, stream, position, event id and type, attempts, error) and skips it, in the transaction that moves the checkpoint. `onGiveUp(event, error, { tx })` runs in that transaction too: return to go on with the next events, or throw to keep the stream waiting (nothing is written, and the handler is retried) until the bug is fixed. Without `maxAttempts`, a failing event is retried forever, as before.
- Event store migration 2 adds `hermes_dead_letters`.

# [1.0.0-alpha.23](https://github.com/chassisjs/hermes/compare/v1.0.0-alpha.22...v1.0.0-alpha.23) (2026-11-03)

`1.0.0-alpha.22` shipped the first version of the event store without an entry here; this section covers both. It needs `@chassisjs/hermes` `~1.0.0-alpha.23`.

### Features

- **Event store**, opt-in: `migrate(pool, { eventStore: true })` adds `hermes_streams`, `hermes_events`, `hermes_subscriptions`, `hermes_projections` and `hermes_projection_versions`, on their own track of migrations (`hermes_event_store_migrations`). An application that uses only the outbox gets none of them.
- `createEventStore(pool, { projections })`: an append locks its stream, checks the expected version, stores the events and updates the inline projections in one transaction: its own, or the one of the application (`tx`), inside a savepoint, so a rejected append leaves nothing and the transaction stays usable.
- `fromInlineProjection`: a state-stored decider reads its state from the document of a single-stream inline projection.
- `createEventStoreConsumer` (e.g. a relay to a message broker) and `createProjectionConsumer` (async projections), on the polling outbox: one instance publishes a stream at a time, in order, and the checkpoint and the claim of every stream live in `hermes_subscriptions`. `startFrom: 'end'` starts a new consumer after the existing events; a single-stream projection started from the end still builds a new document from all the events of its stream. Every projection document keeps the version of every stream that fed it, so replays and redeliveries are idempotent.
- `createMutex`: a named lock of MySQL (`GET_LOCK`), e.g. for a scheduler that runs on one instance; `lock(signal)` can be aborted.
- `changedStreamsQuery` is exported.

### Limits

- Every poll of every consumer instance reads all the streams, so its cost grows with their number; tested up to 5,000 streams.
- `hermes_projection_versions` keeps one row per document and stream, and is never cleaned.
- An inline projection whose document is fed by many streams serializes the appends that feed it.

### Fixes since 1.0.0-alpha.22

- An append in a `REPEATABLE READ` transaction of the application whose snapshot was older than the documents of its stream failed with `ER_DUP_ENTRY`.
- A projection added to a running application built documents from the new events only, so a state-stored decider decided on an empty state. A new document now catches up from all the events of its stream, once.
- A decider whose document was deleted by `evolve` got `null` instead of the initial state.
- Streams early in the key order could starve the others; the consumers now take turns.
- Appends or projections creating the same stream or document at once could deadlock in the transactions of Hermes. In a transaction of the application a deadlock is still possible, and it is thrown, because MySQL rolls the whole transaction back.
- `readStream` without `tx` could return a `currentVersion` below its last event; it is now the greater of the two.
- `startFrom: 'end'` loaded all of `hermes_streams` into memory; it now pages through it by the primary key.
- `createMutex`: concurrent `tryLock` calls could take the reentrant lock of MySQL twice; they are now deduplicated.

# [1.0.0-alpha.20](https://github.com/chassisjs/hermes/compare/v1.0.0-alpha.19...v1.0.0-alpha.20) (2026-11-03)

The first release of the outbox for MySQL 8.0+ and Aurora MySQL 3, built on the polling outbox of `@chassisjs/hermes`.

### Features

- `createOutboxConsumer`: the application stores messages in `hermes_outbox` in its own transactions (`queue(message, { tx, partitionKey })`, with a `mysql2` connection or any object with `query(text, params)`), and the consumer polls the table and publishes them.
- Ordering per partition by default (`ordering: 'partition'`), or `'none'`. Many instances share the partitions.
- Versioned migrations under `GET_LOCK` (`migrate`), run by `start()` unless `migrate: false`.
- Hermes polls with its own small pool (`createPollingPool`, `pollingConnectionLimit`, 3 by default) in `READ COMMITTED`, so its claims do not lock gaps and do not block the inserts of the application. `stop()` closes only that pool; close the pool of `getDbConnection()` yourself.
