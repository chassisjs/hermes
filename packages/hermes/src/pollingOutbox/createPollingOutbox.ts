import { randomUUID } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'
import { Duration } from '../duration.js'
import { assert } from '../utils/assert.js'
import { noop, swallow } from '../utils/utils.js'
import { useExponentialRetryPolicy } from './policies.js'
import { type PollingLane, type PollingOutbox, type PollingOutboxParams } from './types.js'

/**
 * Creates an outbox that polls the database for undelivered messages and publishes them.
 *
 * It does not keep a position like "the last published id". Every message keeps its own state (delivered, attempts,
 * claim), so a message is not skipped when its transaction commits after a transaction with a greater id. This is how
 * auto-increment identifiers work in relational databases: the id is assigned on insert, not on commit.
 *
 * Many instances of the application can poll the same outbox. The {@link PollingPolicy} decides how they share the
 * messages, e.g. {@link usePartitionOrderingPolicy} gives every partition to one instance at a time.
 *
 * Delivery is at-least-once: a message can be published again when an instance dies after publishing it, but before
 * marking it as delivered. Make the handlers of the messages idempotent.
 *
 * @template Message - The type of the message's payload
 *
 * @example
 * ```typescript
 * const outbox = createPollingOutbox({
 *   policy: usePartitionOrderingPolicy(store),
 *   publish: async (message) => broker.publish(message.messageType, message.message),
 *   pollInterval: Duration.ofSeconds(1),
 * })
 *
 * const stop = outbox.start()
 *
 * await stop()
 * ```
 */
const createPollingOutbox = <Message>(params: PollingOutboxParams<Message>): PollingOutbox => {
  const { policy, publish } = params
  const pollInterval = params.pollInterval ?? Duration.ofSeconds(1)
  const batchSize = params.batchSize ?? 100
  const lease = params.lease ?? Duration.ofSeconds(30)
  const retry = params.retry ?? useExponentialRetryPolicy()
  const owner = params.owner ?? randomUUID()
  const onFailedPublish = params.onFailedPublish ?? noop
  const onDbError = params.onDbError ?? noop
  let isStarted = false

  assert(Number.isInteger(batchSize) && batchSize >= 1, '`batchSize` has to be a positive integer.')
  assert(lease.ms > 0, '`lease` has to be longer than 0.')

  const publishLane = async (lane: PollingLane<Message>, stopping: AbortSignal) => {
    for (const message of lane.messages) {
      if (stopping.aborted) {
        return
      }

      let error: unknown

      try {
        await publish(message)
      } catch (e) {
        error = e ?? new Error('Publishing failed.')
      }

      try {
        if (error === undefined) {
          await policy.markDelivered(message)
        } else {
          onFailedPublish(error, message)
          await policy.markFailed(message, { retryAfter: retry(message.attempts + 1), owner })
        }
      } catch (dbError) {
        onDbError(dbError)
        return
      }

      if (error !== undefined && lane.onFailure === 'stop') {
        return
      }
    }
  }

  const publishLanes = async (lanes: PollingLane<Message>[], stopping: AbortSignal) => {
    let renewing: Promise<void> | undefined
    const renewal = setInterval(
      () => {
        renewing ??= policy
          .renew({ owner, lease, lanes })
          .catch(onDbError)
          .finally(() => {
            renewing = undefined
          })
      },
      Math.max(Math.floor(lease.ms / 3), 1),
    )

    try {
      await Promise.all(lanes.map((lane) => publishLane(lane, stopping)))
    } finally {
      clearInterval(renewal)
    }
  }

  return {
    start() {
      assert(!isStarted, 'The polling outbox is already started.')

      isStarted = true

      const stopping = new AbortController()
      const polling = (async () => {
        while (!stopping.signal.aborted) {
          let hasMore = false

          try {
            const lanes = await policy.claim({ owner, lease, limit: batchSize })

            await publishLanes(lanes, stopping.signal)

            hasMore = lanes.some(({ messages }) => messages.length >= batchSize)
          } catch (error) {
            onDbError(error)
          }

          if (!hasMore) {
            await setTimeout(pollInterval.ms, undefined, { signal: stopping.signal }).catch(noop)
          }
        }
      })()

      let stopped: Promise<void> | undefined

      return () => {
        stopped ??= (async () => {
          stopping.abort()
          await polling
          await swallow(() => policy.release({ owner }))
          isStarted = false
        })()

        return stopped
      }
    },
  }
}

export { createPollingOutbox }
