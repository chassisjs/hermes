import { Duration } from '@chassisjs/hermes'
import { describe, expect, jest, test } from '@jest/globals'
import { setTimeout } from 'node:timers/promises'
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { convertLsnToBigInt, Lsn } from '../src/common/lsn.js'
import { createOutboxConsumer, HermesMessageEnvelope } from '../src/index.js'
import { generateEvent, MedicineEvent } from './events.js'
import { postgres } from './postgresql.js'

jest.setTimeout(Duration.ofMinutes(5).ms)

const getOptions = (container: StartedPostgreSqlContainer) => () => ({
  host: container.getHost(),
  port: container.getPort(),
  username: container.getUsername(),
  password: container.getPassword(),
  database: container.getDatabase(),
})

const waitUntil = async (condition: () => boolean, timeout: Duration) => {
  const deadline = Date.now() + timeout.ms

  while (!condition() && Date.now() < deadline) {
    await setTimeout(50)
  }
}

describe.each([true, false])('Backpressure', (serialization) => {
  test(`limits the pending transactions to 'maxQueueSize' when serialization is ${serialization ? 'on' : 'off'}`, async () => {
    await postgres(async (sql, container, onDispose) => {
      const publishedLsns: string[] = []
      let inProgress = 0
      let maxInProgress = 0
      const outbox = createOutboxConsumer<MedicineEvent>({
        getOptions: getOptions(container),
        publish: async (messages: HermesMessageEnvelope<MedicineEvent> | HermesMessageEnvelope<MedicineEvent>[]) => {
          const [{ lsn }] = Array.isArray(messages) ? messages : [messages]

          maxInProgress = Math.max(maxInProgress, ++inProgress)
          await setTimeout(100)
          publishedLsns.push(lsn)
          inProgress--
        },
        consumerName: 'app',
        serialization,
        maxQueueSize: 2,
      })

      const stop = await outbox.start()
      onDispose(stop)

      for (let i = 0; i < 10; i++) {
        const event = generateEvent(`med${i}`)
        await outbox.queue({ message: event, messageId: `abc${i}`, messageType: event.name })
      }

      await waitUntil(() => publishedLsns.length === 10, Duration.ofSeconds(30))
      await setTimeout(200)

      const [{ lastProcessedLsn }] = await sql`select "lastProcessedLsn" from "outboxConsumer"`
      const sortedLsns = [...publishedLsns].sort((a, b) =>
        Number(convertLsnToBigInt(a as Lsn) - convertLsnToBigInt(b as Lsn)),
      )

      expect(publishedLsns).toHaveLength(10)
      expect(maxInProgress).toBeLessThanOrEqual(serialization ? 1 : 2)
      expect(lastProcessedLsn).toBe(sortedLsns[sortedLsns.length - 1])

      if (serialization) {
        expect(publishedLsns).toEqual(sortedLsns)
      }

      await stop()
    })
  })
})

describe('Backpressure', () => {
  test(`keeps the replication connection while paused for longer than 'wal_sender_timeout'`, async () => {
    await postgres(async (sql, container, onDispose) => {
      await sql`ALTER SYSTEM SET wal_sender_timeout = '15s'`
      await sql`SELECT pg_reload_conf()`

      const publishedLsns: string[] = []
      const publish = jest
        .fn<(messages: HermesMessageEnvelope<MedicineEvent>[]) => Promise<void>>()
        .mockImplementationOnce(async ([{ lsn }]) => {
          await setTimeout(Duration.ofSeconds(25).ms)
          publishedLsns.push(lsn)
        })
        .mockImplementation(async ([{ lsn }]) => {
          publishedLsns.push(lsn)
        })
      const outbox = createOutboxConsumer<MedicineEvent>({
        getOptions: getOptions(container),
        publish: publish as never,
        consumerName: 'app',
        serialization: true,
        maxQueueSize: 1,
      })

      const stop = await outbox.start()
      onDispose(stop)

      for (let i = 0; i < 3; i++) {
        const event = generateEvent(`med${i}`)
        await outbox.queue({ message: event, messageId: `abc${i}`, messageType: event.name })
      }

      await waitUntil(() => publishedLsns.length === 3, Duration.ofSeconds(60))
      await setTimeout(200)

      const [{ lastProcessedLsn }] = await sql`select "lastProcessedLsn" from "outboxConsumer"`

      expect(publishedLsns).toHaveLength(3)
      expect(lastProcessedLsn).toBe(publishedLsns[2])

      await stop()
    })
  })
})
