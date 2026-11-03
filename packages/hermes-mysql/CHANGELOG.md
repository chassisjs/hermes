# Change Log

All notable changes to this project will be documented in this file.
See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

# [1.0.0-alpha.20](https://github.com/chassisjs/hermes/compare/v1.0.0-alpha.19...v1.0.0-alpha.20) (2026-11-03)

The first release of the outbox for MySQL 8.0+ and Aurora MySQL 3, built on the polling outbox of `@chassisjs/hermes`.

### Features

- `createOutboxConsumer`: the application stores messages in `hermes_outbox` in its own transactions (`queue(message, { tx, partitionKey })`, with a `mysql2` connection or any object with `query(text, params)`), and the consumer polls the table and publishes them.
- Ordering per partition by default (`ordering: 'partition'`), or `'none'`. Many instances share the partitions.
- Versioned migrations under `GET_LOCK` (`migrate`), run by `start()` unless `migrate: false`.
- Hermes polls with its own small pool (`createPollingPool`, `pollingConnectionLimit`, 3 by default) in `READ COMMITTED`, so its claims do not lock gaps and do not block the inserts of the application. `stop()` closes only that pool; close the pool of `getDbConnection()` yourself.
