import { describe, expect, jest, test } from '@jest/globals'
import { setTimeout } from 'node:timers/promises'
import { Duration } from '../duration.js'
import { createPollingOutbox } from './createPollingOutbox.js'
import { useExponentialRetryPolicy, useNoOrderingPolicy, usePartitionOrderingPolicy } from './policies.js'
import { type MessageClaimingStore, type PartitionClaimingStore, type PolledMessage } from './types.js'

type Row = {
  id: number
  partitionKey: string
  delivered: boolean
  attempts: number
  nextAttemptAt: number
  claimedBy: string | null
  claimedUntil: number
}

const createInMemoryStore = () => {
  const rows: Row[] = []
  const partitions = new Map<string, { claimedBy: string | null; claimedUntil: number }>()
  const toMessage = (row: Row): PolledMessage<string> => ({
    id: row.id,
    partitionKey: row.partitionKey,
    messageId: `m${row.id}`,
    messageType: 'Test',
    attempts: row.attempts,
    message: `payload-${row.id}`,
  })
  const pending = () => rows.filter((row) => !row.delivered).sort((a, b) => a.id - b.id)
  const rowOf = (message: PolledMessage<string>) => rows.find(({ id }) => id === message.id)!
  const store: MessageClaimingStore<string> & PartitionClaimingStore<string> = {
    async markDelivered(message) {
      Object.assign(rowOf(message), { delivered: true, claimedBy: null, claimedUntil: 0 })
    },
    async markFailed(message, { retryAfter, owner }) {
      const row = rowOf(message)

      if (row.delivered || (row.claimedBy !== null && row.claimedBy !== owner)) {
        return
      }

      Object.assign(row, {
        attempts: row.attempts + 1,
        nextAttemptAt: Date.now() + retryAfter.ms,
        claimedBy: null,
        claimedUntil: 0,
      })
    },
    async claimMessages({ owner, lease, limit }) {
      const now = Date.now()
      const claimed = pending()
        .filter((row) => row.nextAttemptAt <= now && row.claimedUntil < now)
        .slice(0, limit)

      claimed.forEach((row) => Object.assign(row, { claimedBy: owner, claimedUntil: now + lease.ms }))

      return claimed.map(toMessage)
    },
    async renewMessages({ owner, lease, messages }) {
      messages
        .map(rowOf)
        .filter((row) => row.claimedBy === owner && !row.delivered)
        .forEach((row) => (row.claimedUntil = Date.now() + lease.ms))
    },
    async releaseMessages({ owner }) {
      pending()
        .filter((row) => row.claimedBy === owner)
        .forEach((row) => Object.assign(row, { claimedBy: null, claimedUntil: 0 }))
    },
    async claimPartitions({ owner, lease, limit }) {
      const now = Date.now()
      const keys = [...new Set(pending().map(({ partitionKey }) => partitionKey))]
        .filter((key) => {
          const partition = partitions.get(key)
          const head = pending().find(({ partitionKey }) => partitionKey === key)!

          return (
            head.nextAttemptAt <= now && (!partition || partition.claimedBy === owner || partition.claimedUntil < now)
          )
        })
        .slice(0, limit)

      keys.forEach((key) => partitions.set(key, { claimedBy: owner, claimedUntil: now + lease.ms }))

      return keys
    },
    async readPartition({ partitionKey, limit }) {
      return pending()
        .filter((row) => row.partitionKey === partitionKey)
        .slice(0, limit)
        .map(toMessage)
    },
    async renewPartitions({ owner, lease, partitionKeys }) {
      partitionKeys
        .map((key) => partitions.get(key))
        .filter((partition) => partition?.claimedBy === owner)
        .forEach((partition) => (partition!.claimedUntil = Date.now() + lease.ms))
    },
    async releasePartitions({ owner }) {
      partitions.forEach((partition) => {
        if (partition.claimedBy === owner) {
          Object.assign(partition, { claimedBy: null, claimedUntil: 0 })
        }
      })
    },
  }
  const add = (id: number, partitionKey = 'default') =>
    rows.push({
      id,
      partitionKey,
      delivered: false,
      attempts: 0,
      nextAttemptAt: 0,
      claimedBy: null,
      claimedUntil: 0,
    })

  return { store, rows, partitions, add }
}

const waitUntil = async (condition: () => boolean, timeout = Duration.ofSeconds(5)) => {
  const deadline = Date.now() + timeout.ms

  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error('Timed out.')
    }

    await setTimeout(5)
  }
}

const fast = {
  pollInterval: Duration.ofMiliseconds(10),
  retry: () => Duration.ofMiliseconds(30),
}

describe('createPollingOutbox with usePartitionOrderingPolicy', () => {
  test('publishes the messages of every partition in the order of their ids', async () => {
    const { store, add } = createInMemoryStore()
    const published: string[] = []

    add(3, 'b')
    add(1, 'a')
    add(4, 'a')
    add(2, 'b')

    const stop = createPollingOutbox({
      ...fast,
      policy: usePartitionOrderingPolicy(store),
      publish: ({ partitionKey, id }) => {
        published.push(`${partitionKey}${id}`)
      },
    }).start()

    await waitUntil(() => published.length === 4)
    await stop()

    expect(published.filter((m) => m.startsWith('a'))).toEqual(['a1', 'a4'])
    expect(published.filter((m) => m.startsWith('b'))).toEqual(['b2', 'b3'])
  })

  test('a failed message stops its partition until it is published, other partitions go on', async () => {
    const { store, add, rows } = createInMemoryStore()
    const published: number[] = []
    const onFailedPublish = jest.fn()
    let failures = 2

    add(1, 'a')
    add(2, 'a')
    add(3, 'b')

    const stop = createPollingOutbox({
      ...fast,
      policy: usePartitionOrderingPolicy(store),
      publish: ({ id }) => {
        if (id === 1 && failures-- > 0) {
          throw new Error('broker is down')
        }
        published.push(Number(id))
      },
      onFailedPublish,
    }).start()

    await waitUntil(() => published.length === 3)
    await stop()

    expect(published).toEqual([3, 1, 2])
    expect(onFailedPublish).toHaveBeenCalledTimes(2)
    expect(onFailedPublish).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ id: 1 }))
    expect(rows.find(({ id }) => id === 1)?.attempts).toBe(2)
  })

  test('publishes a message that appears after messages with greater ids', async () => {
    const { store, add } = createInMemoryStore()
    const published: number[] = []

    add(1)
    add(3)

    const stop = createPollingOutbox({
      ...fast,
      policy: usePartitionOrderingPolicy(store),
      publish: ({ id }) => {
        published.push(Number(id))
      },
    }).start()

    await waitUntil(() => published.length === 2)

    // the transaction of message 2 commits after the transaction of message 3
    add(2)

    await waitUntil(() => published.length === 3)
    await stop()

    expect(published).toEqual([1, 3, 2])
  })

  test('two instances never publish one partition at the same time and publish every message once', async () => {
    const { store, add } = createInMemoryStore()
    const published: number[] = []
    const inProgress = new Set<string>()
    let overlaps = 0

    for (let id = 1; id <= 60; id++) {
      add(id, `p${id % 3}`)
    }

    const createInstance = () =>
      createPollingOutbox({
        ...fast,
        batchSize: 5,
        policy: usePartitionOrderingPolicy(store),
        publish: async ({ id, partitionKey }) => {
          if (inProgress.has(partitionKey)) {
            overlaps++
          }
          inProgress.add(partitionKey)
          await setTimeout(1)
          published.push(Number(id))
          inProgress.delete(partitionKey)
        },
      }).start()
    const stop1 = createInstance()
    const stop2 = createInstance()

    await waitUntil(() => published.length === 60)
    await Promise.all([stop1(), stop2()])

    expect(overlaps).toBe(0)
    expect([...published].sort((a, b) => a - b)).toEqual(Array.from({ length: 60 }, (_, i) => i + 1))
    for (const partition of [0, 1, 2]) {
      const ids = published.filter((id) => id % 3 === partition)

      expect(ids).toEqual([...ids].sort((a, b) => a - b))
    }
  })

  test('renews the claim of a partition while its messages are published longer than the lease', async () => {
    const { store, add } = createInMemoryStore()
    const publishers: string[] = []

    add(1)
    add(2)

    const createInstance = (name: string) =>
      createPollingOutbox({
        ...fast,
        lease: Duration.ofMiliseconds(60),
        owner: name,
        policy: usePartitionOrderingPolicy(store),
        publish: async () => {
          publishers.push(name)
          await setTimeout(150)
        },
      }).start()
    const stop1 = createInstance('first')

    await waitUntil(() => publishers.length === 1)

    const stop2 = createInstance('second')

    await waitUntil(() => publishers.length === 2)
    await Promise.all([stop1(), stop2()])

    expect(publishers).toEqual(['first', 'first'])
  })

  test('stop waits for the message being published and releases the partitions', async () => {
    const { store, add, rows, partitions } = createInMemoryStore()
    let release = () => {}

    add(1)
    add(2)

    const stop = createPollingOutbox({
      ...fast,
      owner: 'instance',
      policy: usePartitionOrderingPolicy(store),
      publish: () => new Promise<void>((resolve) => (release = resolve)),
    }).start()

    await waitUntil(() => partitions.get('default')?.claimedBy === 'instance')
    await setTimeout(20)

    let isStopped = false
    const stopping = stop().then(() => (isStopped = true))

    await setTimeout(20)
    expect(isStopped).toBe(false)

    release()
    await stopping

    expect(rows.map(({ delivered }) => delivered)).toEqual([true, false])
    expect(partitions.get('default')?.claimedBy).toBeNull()
  })
})

describe('createPollingOutbox with useNoOrderingPolicy', () => {
  test('a failure reported after the claim expired keeps the claim of another instance', async () => {
    const { store, add, rows } = createInMemoryStore()
    let release = () => {}

    add(1)

    const stop = createPollingOutbox({
      ...fast,
      owner: 'slow',
      lease: Duration.ofMiliseconds(30),
      policy: useNoOrderingPolicy({ ...store, renewMessages: async () => {} }),
      publish: () =>
        new Promise<void>((_, reject) => {
          release = () => reject(new Error('broker is down'))
        }),
    }).start()

    await waitUntil(() => rows[0].claimedBy === 'slow')
    await setTimeout(60)

    const [message] = await store.claimMessages({ owner: 'other', lease: Duration.ofSeconds(30), limit: 1 })

    expect(message.id).toBe(1)

    release()
    await stop()

    expect(rows[0]).toEqual(expect.objectContaining({ claimedBy: 'other', attempts: 0 }))
  })

  test('a failed message does not stop other messages', async () => {
    const { store, add } = createInMemoryStore()
    const published: number[] = []
    let failures = 1

    add(1)
    add(2)
    add(3)

    const stop = createPollingOutbox({
      ...fast,
      policy: useNoOrderingPolicy(store),
      publish: ({ id }) => {
        if (id === 1 && failures-- > 0) {
          throw new Error('broker is down')
        }
        published.push(Number(id))
      },
    }).start()

    await waitUntil(() => published.length === 3)
    await stop()

    expect(published).toEqual([2, 3, 1])
  })

  test('two instances publish every message once', async () => {
    const { store, add } = createInMemoryStore()
    const published: number[] = []
    const publishers = new Set<string>()

    for (let id = 1; id <= 50; id++) {
      add(id)
    }

    const createInstance = (name: string) =>
      createPollingOutbox({
        ...fast,
        batchSize: 5,
        owner: name,
        policy: useNoOrderingPolicy(store),
        publish: async ({ id }) => {
          await setTimeout(1)
          publishers.add(name)
          published.push(Number(id))
        },
      }).start()
    const stop1 = createInstance('first')
    const stop2 = createInstance('second')

    await waitUntil(() => published.length === 50)
    await Promise.all([stop1(), stop2()])

    expect([...published].sort((a, b) => a - b)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1))
    expect(publishers).toEqual(new Set(['first', 'second']))
  })

  test('stop releases the claimed messages that were not published', async () => {
    const { store, add, rows } = createInMemoryStore()
    let release = () => {}

    add(1)
    add(2)

    const stop = createPollingOutbox({
      ...fast,
      policy: useNoOrderingPolicy(store),
      publish: () => new Promise<void>((resolve) => (release = resolve)),
    }).start()

    await waitUntil(() => rows.every(({ claimedBy }) => claimedBy !== null))
    await setTimeout(20)

    const stopping = stop()

    release()
    await stopping

    expect(rows.map(({ delivered, claimedBy }) => ({ delivered, claimedBy }))).toEqual([
      { delivered: true, claimedBy: null },
      { delivered: false, claimedBy: null },
    ])
  })
})

describe('createPollingOutbox', () => {
  test('reports the errors of the store and keeps polling', async () => {
    const { store, add } = createInMemoryStore()
    const published: number[] = []
    const onDbError = jest.fn()
    const claimPartitions = store.claimPartitions
    let failures = 2

    store.claimPartitions = (params) =>
      failures-- > 0 ? Promise.reject(new Error('db is down')) : claimPartitions(params)
    add(1)

    const stop = createPollingOutbox({
      ...fast,
      policy: usePartitionOrderingPolicy(store),
      publish: ({ id }) => {
        published.push(Number(id))
      },
      onDbError,
    }).start()

    await waitUntil(() => published.length === 1)
    await stop()

    expect(onDbError).toHaveBeenCalledTimes(2)
  })

  test('cannot be started twice, and can be started again after stop', async () => {
    const { store } = createInMemoryStore()
    const outbox = createPollingOutbox({ ...fast, policy: usePartitionOrderingPolicy(store), publish: () => {} })
    const stop = outbox.start()

    expect(() => outbox.start()).toThrow(/already started/)

    await stop()
    await stop()

    await outbox.start()()
  })

  test('checks its parameters', () => {
    const { store } = createInMemoryStore()
    const policy = usePartitionOrderingPolicy(store)

    expect(() => createPollingOutbox({ policy, publish: () => {}, batchSize: 0 })).toThrow(/batchSize/)
    expect(() => createPollingOutbox({ policy, publish: () => {}, lease: Duration.ofSeconds(0) })).toThrow(/lease/)
    expect(() => usePartitionOrderingPolicy(store, { maxPartitions: 0 })).toThrow(/maxPartitions/)
  })
})

describe('useExponentialRetryPolicy', () => {
  test('doubles the wait after every attempt, up to the maximum', () => {
    const retry = useExponentialRetryPolicy()

    expect([1, 2, 3, 7, 8, 100].map((attempts) => retry(attempts).ms)).toEqual([
      1000, 2000, 4000, 60_000, 60_000, 60_000,
    ])
  })

  test('takes custom values', () => {
    const retry = useExponentialRetryPolicy({
      initial: Duration.ofMiliseconds(100),
      max: Duration.ofSeconds(1),
      multiplier: 3,
    })

    expect([1, 2, 3, 4].map((attempts) => retry(attempts).ms)).toEqual([100, 300, 900, 1000])
  })
})
