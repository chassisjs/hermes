import {
  assert,
  createPollingOutbox,
  type Duration,
  type Event,
  type HermesProjection,
  type HermesReaction,
  type PolledMessage,
  type ReactionContext,
  type RecordedEvent,
  type RetryPolicy,
  usePartitionOrderingPolicy,
} from '@chassisjs/hermes'
import { type PoolConnection, type PoolOptions } from 'mysql2/promise'
import { createEventStorePollingStore } from './createEventStorePollingStore.js'
import { DeadLettersTable, SubscriptionsTable } from './eventStoreSql.js'
import { migrate } from './migrate.js'
import { applyToProjection } from './projections.js'
import { createPollingPool, inTransaction } from './sql.js'
import { type Stop } from './types.js'

/**
 * An event given to `publish` by a consumer of the event store.
 */
type HermesEventEnvelope<E extends Event = Event> = RecordedEvent<E> & {
  /** The number of failed attempts to publish the event (0 for the first one). */
  redeliveryCount: number
}

type EventStoreConsumerBaseParams = {
  /** Returns the options of the `mysql2` pool that Hermes creates for itself. */
  getOptions: () => PoolOptions
  /** How long to wait between polls when there was nothing more to publish. @defaultValue 1 second */
  pollInterval?: Duration
  /** The maximum number of events of a stream published per poll. @defaultValue `100` */
  batchSize?: number
  /** The maximum number of streams an instance publishes at the same time. @defaultValue `10` */
  maxPartitions?: number
  /** How long a claim of a stream lasts; another instance takes over the streams of a dead one after it. @defaultValue 30 seconds */
  lease?: Duration
  /** How long to wait before publishing a failed event again. @defaultValue 1 second, doubled, at most 1 minute */
  retry?: RetryPolicy
  /** The maximum number of connections of the pool that Hermes polls with. @defaultValue `3` */
  pollingConnectionLimit?: number
  /** Whether `start()` runs the migrations of the outbox and of the event store. @defaultValue `true` */
  migrate?: boolean
  /**
   * Where a consumer without checkpoints starts. A single-stream projection started from the end still builds a new
   * document from all the events of its stream. @defaultValue `'beginning'`
   */
  startFrom?: 'beginning' | 'end'
  /** Called when an event cannot be published. */
  onFailedPublish?: (error: unknown) => void
  /** Called when a query fails, e.g. when the database is not available. */
  onDbError?: (error: unknown) => void
}

type EventStoreConsumerParams<E extends Event> = EventStoreConsumerBaseParams & {
  /** The name of the consumer: it has its own checkpoint in every stream (at most 250 characters). */
  consumerName: string
  /** Publishes an event, e.g. to a message broker. Throw to publish it again later; its stream waits until then. */
  publish: (event: HermesEventEnvelope<E>) => Promise<void> | void
}

type EventStoreConsumer = {
  /**
   * Runs the migrations (unless `migrate` is `false`) and starts polling.
   *
   * @returns A function that stops polling, waits for the events being published, releases the claims and closes the
   * pool that Hermes polls with
   */
  start(): Promise<Stop>
}

/**
 * Starts polling the event store for one consumer, the common part of {@link createEventStoreConsumer} and
 * {@link createProjectionConsumer}.
 *
 * It creates the polling pool (`READ COMMITTED`), runs the migrations (unless `migrate` is `false`), prepares the
 * checkpoints of a new consumer (`startFrom`) and starts the polling outbox with `usePartitionOrderingPolicy`, where a
 * partition is a stream: the events of a stream are handled one by one, in order, by one instance at a time. When any
 * of it fails, the pool is closed and the error is thrown.
 *
 * @param params - The consumer and the options of polling
 * @param createPublish - Creates the function that handles an event, given the polling pool, e.g. to update a
 * projection and the checkpoint in one transaction. Throw to handle the event again later; its stream waits until then.
 * @returns A function that stops polling, waits for the events being handled, releases the claims and closes the pool.
 * Calling it again returns the same promise.
 */
const startConsumer = async (
  params: EventStoreConsumerBaseParams & { consumerName: string; projections?: readonly HermesProjection<any, any>[] },
  createPublish: (
    getPool: () => ReturnType<typeof createPollingPool>,
  ) => (message: PolledMessage<RecordedEvent>) => Promise<void>,
): Promise<Stop> => {
  const pollingPool = createPollingPool(params.getOptions(), params.pollingConnectionLimit)
  let stopPolling: () => Promise<void>

  try {
    const store = createEventStorePollingStore(() => pollingPool, {
      consumerName: params.consumerName,
      startFrom: params.startFrom,
    })
    const pollingOutbox = createPollingOutbox<RecordedEvent>({
      policy: usePartitionOrderingPolicy(store, { maxPartitions: params.maxPartitions }),
      publish: createPublish(() => pollingPool),
      pollInterval: params.pollInterval,
      batchSize: params.batchSize,
      lease: params.lease,
      retry: params.retry,
      onFailedPublish: params.onFailedPublish,
      onDbError: params.onDbError,
    })

    if (params.migrate !== false) {
      await migrate(pollingPool, { eventStore: true, projections: params.projections })
    }

    await store.initialize()
    stopPolling = pollingOutbox.start()
  } catch (error) {
    await pollingPool.end().catch(() => {})

    throw error
  }

  let stopping: Promise<void> | undefined

  return () => {
    stopping ??= (async () => {
      await stopPolling()
      await pollingPool.end()
    })()

    return stopping
  }
}

const assertConsumerName = (consumerName: string) =>
  assert(
    typeof consumerName === 'string' && consumerName.length > 0 && consumerName.length <= 250,
    'A consumer name has to have 1 to 250 characters.',
  )

/**
 * Creates a consumer of the event store: it publishes the events of every stream, one by one and in their order, e.g.
 * to a message broker (a relay). Many instances share the streams; one instance publishes a stream at a time.
 *
 * Delivery is at least once: an event can be published again after a crash, so deduplicate by `eventId`.
 */
const createEventStoreConsumer = <E extends Event = Event>(params: EventStoreConsumerParams<E>): EventStoreConsumer => {
  assertConsumerName(params.consumerName)

  let isStarted = false

  return {
    async start() {
      assert(!isStarted, 'The consumer is already started.')
      isStarted = true

      try {
        const stop = await startConsumer(params, () => async (message) => {
          await params.publish({
            ...(message.message as RecordedEvent<E>),
            redeliveryCount: message.attempts,
          } as HermesEventEnvelope<E>)
        })

        return async () => {
          await stop()
          isStarted = false
        }
      } catch (error) {
        isStarted = false
        throw error
      }
    },
  }
}

type ProjectionConsumerParams = EventStoreConsumerBaseParams & {
  /** The async projection to update; its consumer is named `projection:<name>`. */
  projection: HermesProjection<any, any>
}

type ReactionConsumerParams = EventStoreConsumerBaseParams & {
  /** The reaction to run; its consumer is named `reaction:<name>`. */
  reaction: HermesReaction<any, any>
  /**
   * How many times to run the handler of an event before giving up on it: the event is then written to
   * `hermes_dead_letters` and skipped, in the transaction that moves the checkpoint of the reaction past it.
   * @defaultValue no limit: a failing event is retried until it succeeds, and the events after it in its stream wait
   */
  maxAttempts?: number
  /**
   * Called when the reaction gives up on an event (needs `maxAttempts`), in the transaction (`tx`) that writes its
   * dead letter and moves the checkpoint past it. Return to skip the event and handle the next ones, or throw to keep
   * the stream waiting, e.g. until the bug is fixed: nothing is written then, and the event is retried after the `retry`
   * delay, the handler first.
   */
  onGiveUp?: (event: RecordedEvent, error: unknown, context: ReactionContext<PoolConnection>) => Promise<void> | void
}

type GiveUp = {
  maxAttempts: number
  onGiveUp?: (connection: PoolConnection, event: RecordedEvent, error: unknown) => Promise<void>
}

const describeError = (error: unknown) =>
  error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : String(error)

/**
 * Creates a consumer that handles an event and moves its checkpoint past it in one transaction (`READ COMMITTED`), so
 * the work done in that transaction is never done twice. An event that `shouldHandle` rejects opens no transaction:
 * the polling outbox moves the checkpoint past it. With `giveUp`, the attempt number `maxAttempts` that fails writes
 * the event to `hermes_dead_letters`, runs `onGiveUp` and moves the checkpoint in a new transaction instead of failing.
 */
const createTransactionalConsumer = (
  params: EventStoreConsumerBaseParams & { projections?: readonly HermesProjection<any, any>[] },
  consumerName: string,
  shouldHandle: (event: RecordedEvent) => boolean,
  handle: (connection: PoolConnection, event: RecordedEvent) => Promise<void>,
  giveUp?: GiveUp,
): EventStoreConsumer => {
  assertConsumerName(consumerName)

  const moveCheckpoint = (connection: PoolConnection, event: RecordedEvent) =>
    connection.query(
      `UPDATE \`${SubscriptionsTable}\`
       SET \`attempts\` = 0, \`retry_at\` = NULL, \`version\` = GREATEST(\`version\`, CAST(? AS UNSIGNED))
       WHERE \`consumer_name\` = ? AND \`stream_id\` = ?`,
      [event.streamPosition.toString(), consumerName, event.streamId],
    )

  let isStarted = false

  return {
    async start() {
      assert(!isStarted, 'The consumer is already started.')
      isStarted = true

      try {
        const stop = await startConsumer({ ...params, consumerName }, (getPool) => async (message) => {
          const event = message.message

          if (!shouldHandle(event)) {
            return
          }

          try {
            await inTransaction(
              getPool(),
              async (connection) => {
                await handle(connection, event)
                await moveCheckpoint(connection, event)
              },
              { readCommitted: true },
            )
          } catch (error) {
            if (!giveUp || message.attempts + 1 < giveUp.maxAttempts) {
              throw error
            }

            await inTransaction(
              getPool(),
              async (connection) => {
                const attempts = message.attempts + 1
                const description = describeError(error)

                await connection.query(
                  `INSERT INTO \`${DeadLettersTable}\`
                     (\`consumer_name\`, \`stream_id\`, \`stream_position\`, \`event_id\`, \`event_type\`, \`attempts\`, \`error\`)
                   VALUES (?, ?, CAST(? AS UNSIGNED), ?, ?, ?, ?)
                   ON DUPLICATE KEY UPDATE
                     \`attempts\` = ?, \`error\` = ?, \`failed_at\` = CURRENT_TIMESTAMP(6)`,
                  [
                    consumerName,
                    event.streamId,
                    event.streamPosition.toString(),
                    event.eventId,
                    event.type,
                    attempts,
                    description,
                    attempts,
                    description,
                  ],
                )
                await giveUp.onGiveUp?.(connection, event, error)
                await moveCheckpoint(connection, event)
              },
              { readCommitted: true },
            )
          }
        })

        return async () => {
          await stop()
          isStarted = false
        }
      } catch (error) {
        isStarted = false
        throw error
      }
    },
  }
}

/**
 * Creates a consumer that updates an async projection.
 *
 * `start()` creates the missing tables of the projection (unless `migrate` is `false`; then run
 * `migrate(pool, { eventStore: true, projections })` yourself). Every event updates the documents and the checkpoint
 * of its stream in one transaction, and every document keeps the version of every stream that fed it, so a replay or
 * a redelivery does not apply an event twice. A failing `evolve`
 * changes nothing and is retried later; the rest of its stream waits.
 */
const createProjectionConsumer = (params: ProjectionConsumerParams): EventStoreConsumer =>
  createTransactionalConsumer(
    { ...params, projections: [params.projection] },
    `projection:${params.projection.name}`,
    () => true,
    (connection, event) => applyToProjection(connection, params.projection, [event], { readCommitted: true }),
  )

/**
 * Creates a consumer that runs a reaction ({@link defineHermesReaction}) on the events it handles, e.g. so that one
 * module reacts to the events of another one.
 *
 * The events of a stream are handled one by one, in their order, by one instance at a time; there is no order between
 * streams. The handler gets the transaction (`tx`, `READ COMMITTED`) that moves the checkpoint of the reaction past
 * the event, so what it does in it, e.g. an append with `{ tx }`, commits together with the checkpoint, or not at
 * all, and is not done twice. The work done outside of `tx` (e.g. a call of an HTTP API) is done at least once, so
 * make it idempotent, e.g. by `eventId`.
 *
 * A handler that throws (including a {@link VersionConflictError} of an append in `tx`, which a command handler does
 * not retry in a transaction) rolls everything back, and the event is handled again after the `retry` delay; the
 * events after it in its stream wait until then. With `maxAttempts`, the last failing attempt writes the event to
 * `hermes_dead_letters` (the dead letter queue) and skips it instead; `onGiveUp` can keep the stream waiting by
 * throwing. The events the reaction does not handle only move its checkpoint.
 *
 * @example
 * ```typescript
 * const stop = await createReactionConsumer({
 *   reaction: chargeOnTaskCompleted,
 *   getOptions: () => ({ uri: process.env.MYSQL_URL }),
 * }).start()
 * ```
 */
const createReactionConsumer = (params: ReactionConsumerParams): EventStoreConsumer => {
  const { maxAttempts, onGiveUp } = params

  assert(
    maxAttempts === undefined || (Number.isInteger(maxAttempts) && maxAttempts >= 1),
    'maxAttempts has to be an integer of at least 1.',
  )
  assert(onGiveUp === undefined || maxAttempts !== undefined, 'onGiveUp needs maxAttempts.')

  return createTransactionalConsumer(
    params,
    `reaction:${params.reaction.name}`,
    (event) => params.reaction.canHandle(event),
    async (connection, event) => {
      await params.reaction.handle(event, { tx: connection })
    },
    maxAttempts === undefined
      ? undefined
      : {
          maxAttempts,
          onGiveUp: onGiveUp
            ? async (connection, event, error) => {
                await onGiveUp(event, error, { tx: connection })
              }
            : undefined,
        },
  )
}

export {
  createEventStoreConsumer,
  createProjectionConsumer,
  createReactionConsumer,
  type EventStoreConsumer,
  type EventStoreConsumerParams,
  type HermesEventEnvelope,
  type ProjectionConsumerParams,
  type ReactionConsumerParams,
}
