import {
  assert,
  createPollingOutbox,
  type Duration,
  type Event,
  type HermesProjection,
  type PolledMessage,
  type RecordedEvent,
  type RetryPolicy,
  usePartitionOrderingPolicy,
} from '@chassisjs/hermes'
import { type PoolOptions } from 'mysql2/promise'
import { createEventStorePollingStore } from './createEventStorePollingStore.js'
import { SubscriptionsTable } from './eventStoreSql.js'
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

const startConsumer = async (
  params: EventStoreConsumerBaseParams & { consumerName: string },
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
      await migrate(pollingPool, { eventStore: true })
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

/**
 * Creates a consumer that updates an async projection.
 *
 * Every event updates the documents and the checkpoint of its stream in one transaction, and every document keeps the
 * version of every stream that fed it, so a replay or a redelivery does not apply an event twice. A failing `evolve`
 * changes nothing and is retried later; the rest of its stream waits.
 */
const createProjectionConsumer = (params: ProjectionConsumerParams): EventStoreConsumer => {
  const consumerName = `projection:${params.projection.name}`

  assertConsumerName(consumerName)

  let isStarted = false

  return {
    async start() {
      assert(!isStarted, 'The consumer is already started.')
      isStarted = true

      try {
        const stop = await startConsumer({ ...params, consumerName }, (getPool) => async (message) => {
          const event = message.message

          await inTransaction(
            getPool(),
            async (connection) => {
              await applyToProjection(connection, params.projection, [event], { readCommitted: true })
              await connection.query(
                `UPDATE \`${SubscriptionsTable}\`
                 SET \`attempts\` = 0, \`retry_at\` = NULL, \`version\` = GREATEST(\`version\`, CAST(? AS UNSIGNED))
                 WHERE \`consumer_name\` = ? AND \`stream_id\` = ?`,
                [event.streamPosition.toString(), consumerName, event.streamId],
              )
            },
            { readCommitted: true },
          )
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

export {
  createEventStoreConsumer,
  createProjectionConsumer,
  type EventStoreConsumer,
  type EventStoreConsumerParams,
  type HermesEventEnvelope,
  type ProjectionConsumerParams,
}
