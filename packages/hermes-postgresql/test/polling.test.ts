import { Duration } from '@chassisjs/hermes'
import { describe, expect, jest, test } from '@jest/globals'
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { setTimeout } from 'node:timers/promises'
import { Sql } from 'postgres'
import {
  createAsyncOutboxConsumer,
  createOutboxConsumer,
  HermesMessageEnvelope,
  useBasicAsyncOutboxConsumerPolicy,
} from '../src/index.js'
import { migrate } from '../src/outbox/migrate.js'
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

const waitUntil = async (condition: () => boolean, timeout = Duration.ofSeconds(20)) => {
  const deadline = Date.now() + timeout.ms

  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error('Timed out.')
    }

    await setTimeout(20)
  }
}

const event = generateEvent('med1')
const envelope = (messageId: string) => ({ message: event, messageId, messageType: event.name })
const checkInterval = Duration.ofMiliseconds(50)

const createAsyncOutbox = (sql: Sql, publish: (messageId: string, partitionKey: string) => Promise<void> | void) =>
  createAsyncOutboxConsumer<MedicineEvent>({
    getSql: () => sql as never,
    consumerName: 'app',
    checkInterval,
    publish: async (messages) => {
      for (const { messageId, partitionKey } of Array.isArray(messages) ? messages : [messages]) {
        await publish(messageId, partitionKey)
      }
    },
  })

describe('Async outbox', () => {
  test('publishes a message whose transaction commits after a transaction with a greater position', async () => {
    await postgres(async (sql) => {
      const published: string[] = []

      await migrate(sql, 'hermes_slot_app_default')

      const outbox = createAsyncOutbox(sql, (messageId) => {
        published.push(messageId)
      })
      const stop = outbox.start()
      const tx = await sql.reserve()

      try {
        await tx`BEGIN`
        await outbox.send(envelope('late'), { tx: { query: (text, params) => tx.unsafe(text, params as never[]) } })
        await outbox.send(envelope('early'))

        await waitUntil(() => published.length === 1)
        await setTimeout(200)

        expect(published).toEqual(['early'])

        await tx`COMMIT`
      } finally {
        tx.release()
      }

      await waitUntil(() => published.length === 2)
      await stop()

      expect(published).toEqual(['early', 'late'])

      const rows = await sql<{ messageId: string; position: string }[]>`
        SELECT "messageId", "position" FROM "asyncOutbox" ORDER BY "position"
      `

      expect(rows.map(({ messageId }) => messageId)).toEqual(['late', 'early'])
    })
  })

  test('a failed message stops its partition until it is published, other partitions go on', async () => {
    await postgres(async (sql) => {
      const published: string[] = []
      let failures = 2

      await migrate(sql, 'hermes_slot_app_default')

      const outbox = createAsyncOutboxConsumer<MedicineEvent>({
        getSql: () => sql as never,
        consumerName: 'app',
        checkInterval,
        retry: () => Duration.ofMiliseconds(100),
        publish: async (messages) => {
          for (const { messageId } of Array.isArray(messages) ? messages : [messages]) {
            if (messageId === 'a1' && failures-- > 0) {
              throw new Error('broker is down')
            }
            published.push(messageId)
          }
        },
      })

      await outbox.send([envelope('a1'), envelope('a2')], { partitionKey: 'a' })
      await outbox.send(envelope('b1'), { partitionKey: 'b' })

      const stop = outbox.start()

      await waitUntil(() => published.length === 3)
      await stop()

      expect(published).toEqual(['b1', 'a1', 'a2'])
      expect(await sql`SELECT "messageId", "failsCount", "delivered" FROM "asyncOutbox" ORDER BY "position"`).toEqual([
        { messageId: 'a1', failsCount: 2, delivered: true },
        { messageId: 'a2', failsCount: 0, delivered: true },
        { messageId: 'b1', failsCount: 0, delivered: true },
      ])
    })
  })

  test('two instances publish every message once, one partition at a time, in order', async () => {
    await postgres(async (sql) => {
      const published: string[] = []
      const inProgress = new Set<string>()
      let overlaps = 0

      await migrate(sql, 'hermes_slot_app_default')

      const publish = async (messageId: string, partitionKey: string) => {
        if (inProgress.has(partitionKey)) {
          overlaps++
        }
        inProgress.add(partitionKey)
        await setTimeout(2)
        published.push(messageId)
        inProgress.delete(partitionKey)
      }
      const outbox1 = createAsyncOutbox(sql, publish)
      const outbox2 = createAsyncOutbox(sql, publish)

      for (const partitionKey of ['p0', 'p1', 'p2']) {
        await outbox1.send(
          Array.from({ length: 30 }, (_, i) => envelope(`${partitionKey}-${String(i).padStart(2, '0')}`)),
          { partitionKey },
        )
      }

      const stop1 = outbox1.start()
      const stop2 = outbox2.start()

      await waitUntil(() => published.length === 90)
      await Promise.all([stop1(), stop2()])

      expect(overlaps).toBe(0)
      expect(new Set(published).size).toBe(90)
      for (const partitionKey of ['p0', 'p1', 'p2']) {
        const messages = published.filter((messageId) => messageId.startsWith(partitionKey))

        expect(messages).toEqual([...messages].sort())
      }
      expect(await sql`SELECT "claimedBy" FROM "asyncOutboxPartition" WHERE "claimedBy" IS NOT NULL`).toEqual([])
    })
  })

  test('with no ordering, two instances share the messages of one partition', async () => {
    await postgres(async (sql) => {
      const published: string[] = []

      await migrate(sql, 'hermes_slot_app_default')

      const createInstance = (name: string) =>
        createAsyncOutboxConsumer<MedicineEvent>({
          getSql: () => sql as never,
          consumerName: 'app',
          checkInterval,
          ordering: 'none',
          batchSize: 5,
          publish: async (messages) => {
            for (const { messageId } of Array.isArray(messages) ? messages : [messages]) {
              await setTimeout(2)
              published.push(`${name}:${messageId}`)
            }
          },
        })
      const outbox1 = createInstance('first')
      const outbox2 = createInstance('second')

      await outbox1.send(Array.from({ length: 40 }, (_, i) => envelope(`m${i}`)))

      const stop1 = outbox1.start()
      const stop2 = outbox2.start()

      await waitUntil(() => published.length === 40)
      await Promise.all([stop1(), stop2()])

      expect(new Set(published.map((entry) => entry.split(':')[1])).size).toBe(40)
      expect(new Set(published.map((entry) => entry.split(':')[0]))).toEqual(new Set(['first', 'second']))
    })
  })

  test('the async outbox of a consumer publishes only the messages of its partition', async () => {
    await postgres(async (sql, container, onDispose) => {
      const published: Record<string, string[]> = { 'tenant-1': [], 'tenant-2': [] }
      const createConsumer = (partitionKey: string) =>
        createOutboxConsumer<MedicineEvent>({
          getOptions: () => getOptions(container),
          publish: async (messages: HermesMessageEnvelope<MedicineEvent> | HermesMessageEnvelope<MedicineEvent>[]) => {
            for (const { messageId } of Array.isArray(messages) ? messages : [messages]) {
              published[partitionKey].push(messageId)
            }
          },
          consumerName: 'app',
          partitionKey,
          asyncOutbox: useBasicAsyncOutboxConsumerPolicy(checkInterval),
        })
      const outbox1 = createConsumer('tenant-1')
      const outbox2 = createConsumer('tenant-2')
      const stop1 = await outbox1.start()
      onDispose(stop1)
      const stop2 = await outbox2.start()
      onDispose(stop2)

      await outbox1.send(envelope('async-1'), { partitionKey: 'tenant-1' })
      await sql.begin(async (tx) => {
        await outbox1.send(envelope('async-2'), { tx, partitionKey: 'tenant-2' })
      })
      await sql.begin(async (tx) => {
        await outbox2.send(envelope('async-default'), tx)
      })

      await waitUntil(() => published['tenant-1'].length + published['tenant-2'].length === 2)
      await setTimeout(300)

      expect(published).toEqual({ 'tenant-1': ['async-1'], 'tenant-2': ['async-2'] })
      expect(await sql`SELECT "messageId", "partitionKey", "delivered" FROM "asyncOutbox" ORDER BY "position"`).toEqual(
        [
          { messageId: 'async-1', partitionKey: 'tenant-1', delivered: true },
          { messageId: 'async-2', partitionKey: 'tenant-2', delivered: true },
          { messageId: 'async-default', partitionKey: 'default', delivered: false },
        ],
      )

      await stop1()
      await stop2()
    })
  })

  test('migrates the async outbox of earlier versions', async () => {
    await postgres(async (sql) => {
      const published: string[] = []

      await sql`
        CREATE TABLE "asyncOutbox" (
          "position"      BIGSERIAL     PRIMARY KEY,
          "consumerName"  VARCHAR(30)   NOT NULL,
          "messageId"     VARCHAR(250)  NOT NULL,
          "messageType"   VARCHAR(250)  NOT NULL,
          "data"          JSONB         NOT NULL,
          "addedAt"       TIMESTAMPTZ   DEFAULT NOW() NOT NULL,
          "createdAt"     TIMESTAMPTZ   DEFAULT NOW() NOT NULL,
          "failsCount"    INTEGER       DEFAULT 0,
          "sentAt"        TIMESTAMPTZ   NULL,
          "delivered"     BOOLEAN       DEFAULT FALSE
        )
      `
      await sql`
        INSERT INTO "asyncOutbox" ("consumerName", "messageId", "messageType", "data")
        VALUES ('app', 'old', 'Test', '{}'::jsonb)
      `

      await migrate(sql, 'hermes_slot_app_default')

      const stop = createAsyncOutbox(sql, (messageId) => {
        published.push(messageId)
      }).start()

      await waitUntil(() => published.length === 1)
      await stop()

      expect(published).toEqual(['old'])
      expect(await sql`SELECT "partitionKey" FROM "asyncOutbox"`).toEqual([{ partitionKey: 'default' }])
    })
  })
})
