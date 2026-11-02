import { Duration } from '../duration.js'
import { assert } from '../utils/assert.js'
import {
  type MessageClaimingStore,
  type PartitionClaimingStore,
  type PollingLane,
  type PollingPolicy,
  type RetryPolicy,
} from './types.js'

/**
 * Publishes the messages of a partition one by one, in the order of their `id`, and only one instance of the
 * application publishes a partition at a time. When a message cannot be published, the rest of its partition waits
 * until it is published. The other partitions go on.
 *
 * This keeps the causal order: when a transaction starts after another one has committed, its messages are published
 * after the messages of the other transaction. The messages of concurrent transactions can be published in any order.
 *
 * @param store - The store of the database
 * @param options.maxPartitions - The maximum number of partitions an instance publishes at the same time (default: 10)
 *
 * @example
 * ```typescript
 * const outbox = createPollingOutbox({
 *   policy: usePartitionOrderingPolicy(store),
 *   publish: async (message) => broker.publish(message),
 * })
 * ```
 */
const usePartitionOrderingPolicy = <Message>(
  store: PartitionClaimingStore<Message>,
  options?: { maxPartitions?: number },
): PollingPolicy<Message> => {
  const maxPartitions = options?.maxPartitions ?? 10
  const claimed = new Set<string>()
  const partitionsOf = (lanes: PollingLane<Message>[]) => [
    ...new Set(lanes.flatMap((lane) => lane.messages.map(({ partitionKey }) => partitionKey))),
  ]

  assert(Number.isInteger(maxPartitions) && maxPartitions >= 1, '`maxPartitions` has to be a positive integer.')

  return {
    markDelivered: (message) => store.markDelivered(message),
    markFailed: (message, params) => store.markFailed(message, params),

    async claim({ owner, lease, limit }) {
      const partitionKeys = await store.claimPartitions({ owner, lease, limit: maxPartitions })

      partitionKeys.forEach((partitionKey) => claimed.add(partitionKey))

      const lanes = await Promise.all(
        partitionKeys.map(async (partitionKey) => ({
          messages: await store.readPartition({ partitionKey, limit }),
          onFailure: 'stop' as const,
        })),
      )

      return lanes.filter(({ messages }) => messages.length > 0)
    },

    async renew({ owner, lease, lanes }) {
      const partitionKeys = partitionsOf(lanes)

      if (partitionKeys.length) {
        await store.renewPartitions({ owner, lease, partitionKeys })
      }
    },

    async release({ owner }) {
      const partitionKeys = [...claimed]

      claimed.clear()

      if (partitionKeys.length) {
        await store.releasePartitions({ owner, partitionKeys })
      }
    },
  }
}

/**
 * Publishes the messages in any order. Many instances of the application publish the messages of one partition at the
 * same time, and a message that cannot be published does not stop other messages.
 *
 * Use it when the order does not matter and you need more throughput than one instance per partition gives.
 *
 * @param store - The store of the database
 *
 * @example
 * ```typescript
 * const outbox = createPollingOutbox({
 *   policy: useNoOrderingPolicy(store),
 *   publish: async (message) => broker.publish(message),
 * })
 * ```
 */
const useNoOrderingPolicy = <Message>(store: MessageClaimingStore<Message>): PollingPolicy<Message> => ({
  markDelivered: (message) => store.markDelivered(message),
  markFailed: (message, params) => store.markFailed(message, params),

  async claim({ owner, lease, limit }) {
    const messages = await store.claimMessages({ owner, lease, limit })

    return messages.length ? [{ messages, onFailure: 'continue' }] : []
  },

  async renew({ owner, lease, lanes }) {
    const messages = lanes.flatMap((lane) => lane.messages)

    if (messages.length) {
      await store.renewMessages({ owner, lease, messages })
    }
  },

  async release({ owner }) {
    await store.releaseMessages({ owner })
  },
})

/**
 * Waits `initial` after the first failed attempt, and `multiplier` times longer after every next one, up to `max`.
 *
 * @example
 * ```typescript
 * // 1s, 2s, 4s, 8s, ... at most 1 minute
 * const retry = useExponentialRetryPolicy()
 * ```
 */
const useExponentialRetryPolicy =
  (options?: { initial?: Duration; max?: Duration; multiplier?: number }): RetryPolicy =>
  (attempts) => {
    const initial = options?.initial ?? Duration.ofSeconds(1)
    const max = options?.max ?? Duration.ofMinutes(1)
    const multiplier = options?.multiplier ?? 2

    return Duration.ofMiliseconds(Math.min(initial.ms * multiplier ** Math.max(attempts - 1, 0), max.ms))
  }

export { useExponentialRetryPolicy, useNoOrderingPolicy, usePartitionOrderingPolicy }
