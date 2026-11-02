import { Duration } from '@chassisjs/hermes'
import { describe, expect, jest, test } from '@jest/globals'
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { sql as drizzleSql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { CompiledQuery, Kysely, PostgresDialect } from 'kysely'
import { setTimeout } from 'node:timers/promises'
import pg from 'pg'
import { Sql } from 'postgres'
import {
  createOutboxConsumer,
  HermesMessageEnvelope,
  OutboxTransaction,
  useBasicAsyncOutboxConsumerPolicy,
} from '../src/index.js'
import { generateEvent, MedicineEvent } from './events.js'
import { postgres } from './postgresql.js'

jest.setTimeout(Duration.ofMinutes(5).ms)

type InTransaction = (work: (tx: OutboxTransaction) => Promise<void>, options: { rollback: boolean }) => Promise<void>
type Library = {
  name: string
  create: (sql: Sql, pool: pg.Pool) => { inTransaction: InTransaction; dispose: () => Promise<void> }
}

class Rollback extends Error {}

const libraries: Library[] = [
  {
    name: 'postgres.js',
    create: (sql) => ({
      inTransaction: async (work, { rollback }) => {
        await sql
          .begin(async (tx) => {
            await work(tx)
            if (rollback) throw new Rollback()
          })
          .catch((error) => {
            if (!(error instanceof Rollback)) throw error
          })
      },
      dispose: async () => {},
    }),
  },
  {
    name: 'pg',
    create: (_, pool) => ({
      inTransaction: async (work, { rollback }) => {
        const client = await pool.connect()

        try {
          await client.query('BEGIN')
          await work(client)
          await client.query(rollback ? 'ROLLBACK' : 'COMMIT')
        } catch (error) {
          await client.query('ROLLBACK')
          throw error
        } finally {
          client.release()
        }
      },
      dispose: async () => {},
    }),
  },
  {
    name: 'Kysely',
    create: (_, pool) => {
      const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) })

      return {
        inTransaction: async (work, { rollback }) => {
          await db
            .transaction()
            .execute(async (trx) => {
              await work({ query: (text, params) => trx.executeQuery(CompiledQuery.raw(text, params)) })
              if (rollback) throw new Rollback()
            })
            .catch((error) => {
              if (!(error instanceof Rollback)) throw error
            })
        },
        dispose: async () => {},
      }
    },
  },
  {
    name: 'Drizzle',
    create: (_, pool) => {
      const db = drizzle(pool)

      return {
        inTransaction: async (work, { rollback }) => {
          await db
            .transaction(async (tx) => {
              await work({
                query: (text, params) =>
                  tx.execute(
                    drizzleSql.join(
                      text
                        .split(/\$(\d+)/)
                        .map((part, i) =>
                          i % 2 === 0 ? drizzleSql.raw(part) : drizzleSql`${params[Number(part) - 1]}`,
                        ),
                    ),
                  ),
              })
              if (rollback) throw new Rollback()
            })
            .catch((error) => {
              if (!(error instanceof Rollback)) throw error
            })
        },
        dispose: async () => {},
      }
    },
  },
]

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

describe.each(libraries)("Queueing messages in the app's transaction", ({ name, create }) => {
  test(`works with ${name}`, async () => {
    await postgres(async (sql, container, onDispose) => {
      const published: { messageId: string; message: MedicineEvent }[] = []
      const options = getOptions(container)
      const pool = new pg.Pool({ ...options, user: options.username })
      const library = create(sql, pool)
      const outbox = createOutboxConsumer<MedicineEvent>({
        getOptions: () => options,
        publish: async (messages: HermesMessageEnvelope<MedicineEvent> | HermesMessageEnvelope<MedicineEvent>[]) => {
          for (const { messageId, message } of Array.isArray(messages) ? messages : [messages]) {
            published.push({ messageId, message })
          }
        },
        consumerName: 'app',
        asyncOutbox: useBasicAsyncOutboxConsumerPolicy(),
      })
      const event = generateEvent('med1')
      const envelope = (messageId: string) => ({ message: event, messageId, messageType: event.name })

      onDispose(async () => {
        await library.dispose()
        await pool.end()
      })

      const stop = await outbox.start()
      onDispose(stop)

      await library.inTransaction(async (tx) => outbox.queue(envelope('rolled-back'), { tx }), { rollback: true })
      await library.inTransaction(async (tx) => outbox.queue(envelope('committed'), { tx }), { rollback: false })
      await library.inTransaction(async (tx) => outbox.queue([envelope('batch-1'), envelope('batch-2')], { tx }), {
        rollback: false,
      })
      await library.inTransaction(
        async (tx) => outbox.queue(envelope('other-partition'), { tx, partitionKey: 'tenant-1' }),
        { rollback: false },
      )
      const error = await library
        .inTransaction(
          async (tx) => {
            await outbox.queue(envelope('before-error'), { tx })
            await outbox.queue(envelope('x'.repeat(300)), { tx })
          },
          { rollback: false },
        )
        .then(
          () => undefined,
          (error: Error) => error,
        )

      // some libraries (e.g. Drizzle) wrap the PostgreSQL error and keep it as the `cause`
      expect(`${error?.message} ${(error?.cause as Error | undefined)?.message}`).toMatch(/too long/)

      await waitUntil(() => published.length >= 3, Duration.ofSeconds(10))
      await setTimeout(200)

      expect(published).toEqual([
        { messageId: 'committed', message: event },
        { messageId: 'batch-1', message: event },
        { messageId: 'batch-2', message: event },
      ])
      expect(await sql`SELECT "messageId", "partitionKey", "data" FROM "outbox" ORDER BY "position"`).toEqual([
        { messageId: 'committed', partitionKey: 'default', data: event },
        { messageId: 'batch-1', partitionKey: 'default', data: event },
        { messageId: 'batch-2', partitionKey: 'default', data: event },
        { messageId: 'other-partition', partitionKey: 'tenant-1', data: event },
      ])

      await library.inTransaction(async (tx) => outbox.send(envelope('async-rolled-back'), tx), { rollback: true })
      await library.inTransaction(async (tx) => outbox.send(envelope('async-committed'), tx), { rollback: false })

      expect(await sql`SELECT "messageId", "data" FROM "asyncOutbox"`).toEqual([
        { messageId: 'async-committed', data: event },
      ])

      await stop()
    })
  })
})
