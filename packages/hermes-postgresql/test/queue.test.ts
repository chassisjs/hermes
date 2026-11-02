import { Duration } from '@chassisjs/hermes'
import { describe, expect, jest, test } from '@jest/globals'
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { setTimeout } from 'node:timers/promises'
import pg from 'pg'
import { createOutboxConsumer, HermesMessageEnvelope } from '../src/index.js'
import { generateEvent, MedicineEvent } from './events.js'
import { postgres } from './postgresql.js'

jest.setTimeout(Duration.ofMinutes(5).ms)

const getOptions = (container: StartedPostgreSqlContainer) => ({
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

const event = generateEvent('med1')
const envelope = (messageId: string) => ({ message: event, messageId, messageType: event.name })

describe('Queueing messages without a transaction', () => {
  test('stores many messages at once, all or none', async () => {
    await postgres(async (sql, container, onDispose) => {
      const published: { messageId: string; message: MedicineEvent }[] = []
      const outbox = createOutboxConsumer<MedicineEvent>({
        getOptions: () => getOptions(container),
        publish: async (messages: HermesMessageEnvelope<MedicineEvent> | HermesMessageEnvelope<MedicineEvent>[]) => {
          for (const { messageId, message } of Array.isArray(messages) ? messages : [messages]) {
            published.push({ messageId, message })
          }
        },
        consumerName: 'app',
      })

      const stop = await outbox.start()
      onDispose(stop)

      await outbox.queue([])
      await outbox.queue([envelope('batch-1'), envelope('batch-2'), envelope('batch-3')])
      await expect(outbox.queue([envelope('valid'), envelope('x'.repeat(300))])).rejects.toThrow(/too long/)

      await waitUntil(() => published.length >= 3, Duration.ofSeconds(10))
      await setTimeout(200)

      expect(published).toEqual([
        { messageId: 'batch-1', message: event },
        { messageId: 'batch-2', message: event },
        { messageId: 'batch-3', message: event },
      ])
      expect(await sql`SELECT "messageId" FROM "outbox" ORDER BY "position"`).toEqual([
        { messageId: 'batch-1' },
        { messageId: 'batch-2' },
        { messageId: 'batch-3' },
      ])

      await stop()
    })
  })
})

describe('Queueing a large batch', () => {
  const size = 20_000
  const batch = Array.from({ length: size }, (_, i) => envelope(`m${i}`))

  test(`stores ${size} messages in one call, with and without a transaction`, async () => {
    await postgres(async (sql, container, onDispose) => {
      const options = getOptions(container)
      const pool = new pg.Pool({ ...options, user: options.username })
      const outbox = createOutboxConsumer<MedicineEvent>({
        getOptions: () => options,
        publish: async () => {},
        consumerName: 'app',
      })

      onDispose(() => pool.end())

      const stop = await outbox.start()
      onDispose(stop)

      await outbox.queue(batch)
      await sql.begin(async (tx) => outbox.queue(batch, { tx }))

      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await outbox.queue(batch, { tx: client })
        await client.query('COMMIT')
      } finally {
        client.release()
      }

      const [{ count }] = await sql<[{ count: string }]>`SELECT COUNT(*) AS count FROM "outbox"`

      expect(Number(count)).toBe(3 * size)

      // the invalid message is in the last statement, so the statements before it have to be rolled back.
      await expect(outbox.queue([...batch, envelope('x'.repeat(300))])).rejects.toThrow(/too long/)

      const [{ count: countAfterFailure }] = await sql<[{ count: string }]>`SELECT COUNT(*) AS count FROM "outbox"`

      expect(Number(countAfterFailure)).toBe(3 * size)

      await stop()
    })
  })
})
