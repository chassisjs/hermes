import { randomUUID } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'
import { Duration } from '../duration.js'
import { assert } from '../utils/assert.js'
import { noop, swallow } from '../utils/utils.js'
import { useExponentialRetryPolicy } from './policies.js'
import { type PollingLane, type PollingOutbox, type PollingOutboxParams } from './types.js'

/**
 * Wraps a handler of the application, so an error it throws or a promise it rejects does not stop polling or crash
 * the process.
 */
const ignoringErrors =
  <Args extends unknown[]>(handler: ((...args: Args) => unknown) | undefined) =>
  (...args: Args): void => {
    Promise.resolve()
      .then(() => handler?.(...args))
      .catch(noop)
  }

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
  const onFailedPublish = ignoringErrors(params.onFailedPublish)
  const onDbError = ignoringErrors(params.onDbError)
  let isStarted = false
  let renewing: Promise<void> | undefined

  assert(Number.isInteger(batchSize) && batchSize >= 1, '`batchSize` has to be a positive integer.')
  assert(lease.ms > 0, '`lease` has to be longer than 0.')

  const publishLane = async (lane: PollingLane<Message>, stopping: AbortSignal, hasClaim: () => boolean) => {
    for (const message of lane.messages) {
      if (stopping.aborted || !hasClaim()) {
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

  /**
   * Publishes the claimed lanes and renews their claims meanwhile. A lane stops taking new messages when a renewal says
   * that a claim was lost, or when the claim was not renewed for two thirds of the lease, so it does not go on when
   * another instance may have taken it over. A renewal that does not end within a lease is given up, so a hanging
   * query does not stop the next renewals or the end of the batch.
   */
  const publishLanes = async (lanes: PollingLane<Message>[], stopping: AbortSignal, claimedAt: number) => {
    let renewedAt = claimedAt
    let isClaimLost = false
    const hasClaim = () => !isClaimLost && Date.now() - renewedAt < lease.ms - Math.floor(lease.ms / 3)
    const renew = async () => {
      const startedAt = Date.now()
      const timeout = new AbortController()

      try {
        const isClaimed = await Promise.race([
          policy.renew({ owner, lease, lanes }),
          setTimeout(lease.ms, undefined, { signal: timeout.signal }).then(() => {
            throw new Error('Renewing the claims timed out.')
          }),
        ])

        if (isClaimed) {
          renewedAt = Math.max(renewedAt, startedAt)
        } else {
          isClaimLost = true
        }
      } catch (error) {
        onDbError(error)
      } finally {
        timeout.abort()
      }
    }
    const renewal = setInterval(
      () => {
        renewing ??= renew().finally(() => {
          renewing = undefined
        })
      },
      Math.max(Math.floor(lease.ms / 3), 1),
    )

    try {
      await Promise.all(lanes.map((lane) => publishLane(lane, stopping, hasClaim)))
    } finally {
      clearInterval(renewal)
      await renewing
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
            const claimedAt = Date.now()
            const lanes = await policy.claim({ owner, lease, limit: batchSize })

            await publishLanes(lanes, stopping.signal, claimedAt)

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
