# Change Log

All notable changes to this project will be documented in this file.
See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

# Unreleased

### Bug Fixes

- `stop()` waits for the event being published and saves its position; an event that keeps failing stops being retried.
- The consumer no longer stops for good when the server ends the change stream: after an `invalidate` (e.g. a dropped outbox collection) it goes on from that event, after an error it cannot resume from it reports `onDbError` and opens the stream again from the last sent message.
- `start()` registers its `SIGTERM`/`SIGINT` handlers once per consumer, not on every start.
- `publish(event, session)` recognizes the callback by `typeof`, not by `instanceof ClientSession`, which failed with two copies of the `mongodb` driver.
- `occurredAt` comes from `now()`, like `sentAt`.
- The peer dependency on `mongodb` was `>= 6.8.0 || < 7.0.0`, which allowed any version; it is `>=6.8.0 <8` now (driver 7 is tested).
- The published types imported `ts-essentials`, which is not a dependency.

### Chores

- Tests run on the MongoDB versions supported by MongoDB: 7.0, 8.0 and 9.0. They used to name 5.0, 6.0, 7.0 and 8.0.0-rc.18, but every scenario ran on the first server the test file started (5.0), so 6.0 and 8.0 were never tested. MongoDB 5.0 and 6.0 (and AWS DocumentDB 5.0) are still accepted, but no longer tested.
- The `fullDocument` option of the change stream was dropped (an insert always carries the whole document), and with it the version policies; the package no longer depends on `whatwg-url`, and the tests are no longer published.
- Docs: supported versions, cleaning up `__outboxMessages` with a TTL index on `sentAt`, what happens when the change stream ends.

# [1.0.0-alpha.19](https://github.com/chassisjs/hermes/compare/v1.0.0-alpha.18...v1.0.0-alpha.19) (2026-11-02)

### Documentation

- API docs: `@chassisjs` package names, MongoDB 5.0+, the real collection names (`__outboxMessages`, `__outboxConsumers`), and what happens to events past the oplog window.

### Chores

- Development dependencies updated. No changes in the runtime code.

# [1.0.0-alpha.7](https://github.com/chassisjs/hermes/compare/@chassisjs/hermes-mongodb@1.0.0-alpha.6...@chassisjs/hermes-mongodb@1.0.0-alpha.7) (2024-08-21)

### Features

- support for the mongodb 5 and 6, 7 and 8-rc.x ([1a03779](https://github.com/chassisjs/hermes/commit/1a03779414e38ec4324303f4b8d38cfb404f5fcd))

# [1.0.0-alpha.6](https://github.com/chassisjs/hermes/compare/@chassisjs/hermes-mongodb@1.0.0-alpha.5...@chassisjs/hermes-mongodb@1.0.0-alpha.6) (2024-08-18)

**Note:** Version bump only for package @chassisjs/hermes-mongodb

# 1.0.0-alpha.5 (2024-08-17)

# 1.0.0-alpha.3 (2024-04-05)

### Features

- new option `saveTimestamps` lets to attach sent timestamps to events that have been successfully sent ([45f3b9c](https://github.com/chassisjs/hermes/commit/45f3b9c6a590889215f5a80ad75d36d81d72e129))

# 1.0.0-alpha.2 (2024-04-01)

### Bug Fixes

- fixed the build of hermes-mongodb to keep src files directly under the root build folder ([c3a372e](https://github.com/chassisjs/hermes/commit/c3a372e4672c9e85d7881a415cc1a0464686c5ec))

# 1.0.0-alpha.1 (2024-03-25)

# 1.0.0-alpha.0 (2024-03-25)

### Bug Fixes

- removed MongoDB from the CJS build ([b6c8ac0](https://github.com/chassisjs/hermes/commit/b6c8ac0c0cf30d6562a15a3cb391890a7223fffd))

### Features

- switching to monorepo ([62a629c](https://github.com/chassisjs/hermes/commit/62a629cc6b8e3ce40e9d413355e5a6cf5044204a))

## [1.0.0-alpha.3](https://github.com/chassisjs/hermes/compare/v1.0.0-alpha.2...v1.0.0-alpha.3) (2024-04-05)

### Features

- new option `saveTimestamps` lets to attach sent timestamps to events that have been successfully sent ([45f3b9c](https://github.com/chassisjs/hermes/commit/45f3b9c6a590889215f5a80ad75d36d81d72e129))

## [1.0.0-alpha.2](https://github.com/chassisjs/hermes/compare/v1.0.0-alpha.1...v1.0.0-alpha.2) (2024-04-01)

### Bug Fixes

- fixed the build of hermes-mongodb to keep src files directly under the root build folder ([c3a372e](https://github.com/chassisjs/hermes/commit/c3a372e4672c9e85d7881a415cc1a0464686c5ec))

## [1.0.0-alpha.1](https://github.com/chassisjs/hermes/compare/v1.0.0-alpha.0...v1.0.0-alpha.1) (2024-03-25)

## [1.0.0-alpha.0](https://github.com/chassisjs/hermes/compare/a59313897e62e604bf00b8293d69c77b00f98dc7...v1.0.0-alpha.0) (2024-03-25)

### Features

- possibility to automatically add a callback on SIGTERM to release outbox consumer ([0883658](https://github.com/chassisjs/hermes/commit/088365889b705404d4d83550532ca176a1887295))
- providing documentation ([a1fd348](https://github.com/chassisjs/hermes/commit/a1fd348d45a23b0933c444619d1b5fd04da3463e))
- publishEvent accepts a callback + a test for partitioning ([79a1a0d](https://github.com/chassisjs/hermes/commit/79a1a0da65c104d9e70b7fc6630fe6f5f6dbc30a))
- simplest version of the outbox pattern based on mongodb and its change events ([a593138](https://github.com/chassisjs/hermes/commit/a59313897e62e604bf00b8293d69c77b00f98dc7))
- switching to monorepo ([62a629c](https://github.com/chassisjs/hermes/commit/62a629cc6b8e3ce40e9d413355e5a6cf5044204a))

### Bug Fixes

- handling error by optional callbacks onDbError and onFailedPublish ([cc14afe](https://github.com/chassisjs/hermes/commit/cc14afe8662daf0a60d3089452f5d98b637de5ba))
- removed MongoDB from the CJS build ([b6c8ac0](https://github.com/chassisjs/hermes/commit/b6c8ac0c0cf30d6562a15a3cb391890a7223fffd))
