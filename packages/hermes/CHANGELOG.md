# Change Log

All notable changes to this project will be documented in this file.
See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

# Unreleased

### Features

- **Reactions** (`defineHermesReaction`, alias `reactOn`): a fluent builder of a reaction to events, e.g. so that one module reacts to the events of another one. The handler gets only the events listed in `ofEvents`, and the transaction of the event store (`tx`) that moves the checkpoint of the reaction, so that its work commits together with the checkpoint.

# [1.0.0-alpha.23](https://github.com/chassisjs/hermes/compare/v1.0.0-alpha.22...v1.0.0-alpha.23) (2026-11-03)

`1.0.0-alpha.22` shipped the first version of the event sourcing API without an entry here; this section covers both.

### Features

- **Deciders** (`createCommandHandler`): `decide(command, state)`, `evolve(state, event)` and `initialState()`, as in Emmett. The state comes from the events of the stream, or from `loadState` (state-stored, e.g. a document of an inline projection). New events are appended at the version the state was loaded at, so a concurrent change is a `VersionConflictError`.
- Retries: `retry: { attempts, delay }`, where `delay` is a `RetryPolicy` (e.g. `useExponentialRetryPolicy`). Only a `VersionConflictError` is retried, never when the caller gives its own `expectedVersion`, and never in a transaction of the application (`tx`): under `REPEATABLE READ` the retry would read the same snapshot, so retry the whole transaction instead. `handle(..., { signal })` stops the command, also while it waits for a retry.
- `createInMemoryEventStore`, `VersionConflictError` and `assertExpectedVersion`; the expected version is a `bigint` (`0n`: the stream does not exist), `'no_stream'`, `'stream_exists'` or `'any'`.
- **Projections** (`defineHermesProjection`): a fluent builder in which `evolve` gets only the events listed in `ofEvents`, `ofId` makes a document fed by many streams, `.inline()` / `.async()` choose how it is updated (`.done()` alone means async), and returning `null` from `evolve` deletes the document. `applyProjection` applies events to a document.

### Fixes since 1.0.0-alpha.22

- A version conflict in a transaction of the application (`tx`) is not retried any more: the retries could only conflict again.

### Chores

- The tests and the fixtures in `src` are no longer published in `lib`.

# [1.0.0-alpha.21](https://github.com/chassisjs/hermes/compare/v1.0.0-alpha.20...v1.0.0-alpha.21) (2026-11-03)

### Features

- `parseIncrementalId` accepts a string too, e.g. a `BIGINT` that the database driver returns as a string. The string has to be written only with digits, without leading zeros, and is converted to a number; a value greater than `Number.MAX_SAFE_INTEGER` is rejected.

# [1.0.0-alpha.20](https://github.com/chassisjs/hermes/compare/v1.0.0-alpha.19...v1.0.0-alpha.20) (2026-11-03)

### Features

- **Polling outbox** (`createPollingOutbox`): a database-independent engine that polls an outbox table and publishes the messages. It keeps no "last published position", so a message whose transaction commits after one with a greater auto-increment id is not skipped. Every message has its own state (delivered, attempts, claim), and delivery is at-least-once.
- **Ordering policies:** `usePartitionOrderingPolicy` publishes every partition by one instance at a time, in order, and a failed message stops its partition until it is published; `useNoOrderingPolicy` lets many instances publish the messages in any order. `useExponentialRetryPolicy` (1 second, doubled, at most 1 minute) is the default retry.
- Claims are leases, renewed while publishing. A lane stops when its claim was lost or not renewed for two thirds of the lease, so it does not publish next to an instance that took it over.
- `Event`, `Command`, `DefaultRecord` and `DefaultCommandMetadata` are exported, so the messages can be typed without another library.
- `IncrementalId` and `parseIncrementalId`: an integer greater than 0, like an auto-increment identifier of a database row.

# [1.0.0-alpha.19](https://github.com/chassisjs/hermes/compare/v1.0.0-alpha.18...v1.0.0-alpha.19) (2026-11-02)

### Chores

- `uuid` updated to 14.0.3. No changes in the code.

# [1.0.0-alpha.7](https://github.com/chassisjs/hermes/compare/@chassisjs/hermes@1.0.0-alpha.6...@chassisjs/hermes@1.0.0-alpha.7) (2024-08-21)

### Features

- rearrangement, new urils, new errors, more tests ([2fa6b79](https://github.com/chassisjs/hermes/commit/2fa6b79fe4199e9ff614b04512a6f4bd44aaaa35))

# [1.0.0-alpha.6](https://github.com/chassisjs/hermes/compare/@chassisjs/hermes@1.0.0-alpha.5...@chassisjs/hermes@1.0.0-alpha.6) (2024-08-18)

**Note:** Version bump only for package @chassisjs/hermes

# 1.0.0-alpha.5 (2024-08-17)

### Features

- duration helper and common typings added ([f0b011b](https://github.com/chassisjs/hermes/commit/f0b011b741658a2e7320179f459f51d8299de2a4))

# 1.0.0-alpha.3 (2024-04-05)

### Features

- added assertDate util and unit tests ([00d1fcb](https://github.com/chassisjs/hermes/commit/00d1fcbecc1217fe049793eef84f208227c482ff))

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

- added assertDate util and unit tests ([00d1fcb](https://github.com/chassisjs/hermes/commit/00d1fcbecc1217fe049793eef84f208227c482ff))

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
