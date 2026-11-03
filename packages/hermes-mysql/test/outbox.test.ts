import { Duration } from '@chassisjs/hermes'
import { afterAll, afterEach, beforeAll, describe, expect, jest, test } from '@jest/globals'
import { CompiledQuery, Kysely, MysqlDialect } from 'kysely'
import { createPool as createCallbackPool } from 'mysql2'
import { type Pool, type PoolOptions, type RowDataPacket } from 'mysql2/promise'
import { setTimeout } from 'node:timers/promises'
import {
  createOutboxConsumer,
  createPollingPool,
  createPollingStore,
  type ConsumerCreationParams,
  type HermesMessageEnvelope,
  migrate,
  type OutboxConsumer,
} from '../src/index.js'
import { createMySql } from './mysql.js'

jest.setTimeout(Duration.ofMinutes(5).ms)

type Event = { name: string; value: number }

const mysql = createMySql(process.env.MYSQL_VERSION)

beforeAll(() => mysql.start(), Duration.ofMinutes(3).ms)
afterAll(() => mysql.stop())

const waitUntil = async (condition: () => boolean, timeout = Duration.ofSeconds(20)) => {
  const deadline = Date.now() + timeout.ms

  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error('Timed out.')
    }

    await setTimeout(20)
  }
}

const envelope = (messageId: string, value = 1) => ({
  messageId,
  messageType: 'Test',
  message: { name: 'Test', value },
})

const consumers: OutboxConsumer<Event>[] = []

afterEach(async () => {
  for (const consumer of consumers.splice(0)) {
    await consumer
      .getDbConnection()
      .end()
      .catch(() => {})
  }
})

const createConsumer = (
  options: PoolOptions,
  publish: ConsumerCreationParams<Event>['publish'],
  params?: Partial<ConsumerCreationParams<Event>>,
) => {
  const consumer = createOutboxConsumer<Event>({
    getOptions: () => options,
    publish,
    consumerName: 'app',
    pollInterval: Duration.ofMiliseconds(50),
    ...params,
  })

  consumers.push(consumer)

  return consumer
}

const select = async <T>(pool: Pool, sql: string) => {
  const [rows] = await pool.query<RowDataPacket[]>(sql)

  return rows as T[]
}

const pollingConnections = (pool: Pool) =>
  select<{ isolation: string }>(
    pool,
    `SELECT v.VARIABLE_VALUE AS isolation
     FROM performance_schema.session_connect_attrs a
     JOIN performance_schema.threads t ON t.PROCESSLIST_ID = a.PROCESSLIST_ID
     JOIN performance_schema.variables_by_thread v ON v.THREAD_ID = t.THREAD_ID
     WHERE a.ATTR_NAME = 'program_name' AND a.ATTR_VALUE = 'hermes-polling'
       AND v.VARIABLE_NAME = 'transaction_isolation'`,
  )

const expectNoPollingConnections = async (pool: Pool) => {
  const deadline = Date.now() + Duration.ofSeconds(10).ms

  while ((await pollingConnections(pool)).length && Date.now() < deadline) {
    await setTimeout(50)
  }

  expect(await pollingConnections(pool)).toEqual([])
}

describe('Migrations', () => {
  test('instances that start at the same time apply every migration once', async () => {
    await mysql.withDatabase(async ({ pool }) => {
      const results = await Promise.all([migrate(pool), migrate(pool), migrate(pool)])

      expect(results.flat()).toEqual([1])
      expect(await migrate(pool)).toEqual([])
      expect(await select(pool, 'SELECT `version`, `name` FROM `hermes_migrations`')).toEqual([
        { version: 1, name: 'create the outbox' },
      ])
      expect((await select<{ name: string }>(pool, 'SHOW TABLES')).map((row) => Object.values(row)[0]).sort()).toEqual([
        'hermes_migrations',
        'hermes_outbox',
        'hermes_outbox_partition',
      ])
    })
  })

  test('migrate on a polling pool keeps the short table lock timeout of the pool', async () => {
    await mysql.withDatabase(async ({ options }) => {
      const pollingPool = createPollingPool(options, 1)

      try {
        await migrate(pollingPool)

        const [{ timeout }] = await select<{ timeout: string }>(
          pollingPool,
          'SELECT @@SESSION.lock_wait_timeout AS `timeout`',
        )

        expect(Number(timeout)).toBe(5)
      } finally {
        await pollingPool.end()
      }
    })
  })

  test('start() does not migrate when `migrate` is false', async () => {
    await mysql.withDatabase(async ({ options, pool }) => {
      const stop = await createConsumer(options, () => {}, { migrate: false }).start()

      await stop()

      expect(await select(pool, 'SHOW TABLES')).toEqual([])
    })
  })
})

describe('Outbox', () => {
  test('stores the messages in the transaction of the application and publishes the committed ones', async () => {
    await mysql.withDatabase(async ({ options, pool }) => {
      const published: HermesMessageEnvelope<Event>[] = []
      const outbox = createConsumer(options, (message) => {
        published.push(message)
      })
      const stop = await outbox.start()
      const connection = await pool.getConnection()

      try {
        await connection.beginTransaction()
        await outbox.queue(envelope('rolled-back'), { tx: connection })
        await connection.rollback()

        await connection.beginTransaction()
        await outbox.queue([envelope('committed-1', 1), envelope('committed-2', 2)], { tx: connection })
        await connection.commit()
      } finally {
        connection.release()
      }

      await waitUntil(() => published.length === 2)
      await setTimeout(200)
      await stop()

      expect(published).toEqual([
        {
          position: expect.any(String),
          partitionKey: 'default',
          messageId: 'committed-1',
          messageType: 'Test',
          redeliveryCount: 0,
          message: { name: 'Test', value: 1 },
        },
        expect.objectContaining({ messageId: 'committed-2', message: { name: 'Test', value: 2 } }),
      ])
      expect(
        await select(pool, 'SELECT `message_id`, `delivered_at` IS NOT NULL AS delivered FROM `hermes_outbox`'),
      ).toEqual([
        { message_id: 'committed-1', delivered: '1' },
        { message_id: 'committed-2', delivered: '1' },
      ])
    })
  })

  test('works with the transactions of Kysely', async () => {
    await mysql.withDatabase(async ({ options, pool }) => {
      const published: string[] = []
      const outbox = createConsumer(options, ({ messageId }) => {
        published.push(messageId)
      })
      const db = new Kysely<unknown>({ dialect: new MysqlDialect({ pool: createCallbackPool(options) }) })
      const stop = await outbox.start()

      await db.transaction().execute(async (trx) => {
        await outbox.queue(envelope('kysely'), {
          tx: { query: (text, params) => trx.executeQuery(CompiledQuery.raw(text, params)) },
        })
      })

      await waitUntil(() => published.length === 1)
      await stop()
      await db.destroy()

      expect(published).toEqual(['kysely'])
      expect(await select(pool, 'SELECT `data` FROM `hermes_outbox`')).toEqual([{ data: { name: 'Test', value: 1 } }])
    })
  })

  test('publishes a message whose transaction commits after a transaction with a greater position', async () => {
    await mysql.withDatabase(async ({ options, pool }) => {
      const published: string[] = []
      const outbox = createConsumer(options, ({ messageId }) => {
        published.push(messageId)
      })
      const stop = await outbox.start()
      const connection = await pool.getConnection()

      try {
        await connection.beginTransaction()
        await outbox.queue(envelope('late'), { tx: connection })
        await outbox.queue(envelope('early'))

        await waitUntil(() => published.length === 1)
        await setTimeout(200)

        expect(published).toEqual(['early'])

        await connection.commit()
      } finally {
        connection.release()
      }

      await waitUntil(() => published.length === 2)
      await stop()

      expect(published).toEqual(['early', 'late'])
      expect(await select(pool, 'SELECT `message_id` FROM `hermes_outbox` ORDER BY `position`')).toEqual([
        { message_id: 'late' },
        { message_id: 'early' },
      ])
    })
  })

  test('stores many messages at once, all or none', async () => {
    await mysql.withDatabase(async ({ options, pool }) => {
      const outbox = createConsumer(options, () => {}, { pollInterval: Duration.ofMinutes(1) })
      const batch = Array.from({ length: 2500 }, (_, i) => envelope(`m${i}`))
      const stop = await outbox.start()
      const count = async () =>
        Number((await select<{ count: string }>(pool, 'SELECT COUNT(*) AS count FROM `hermes_outbox`'))[0].count)
      const connection = await pool.getConnection()

      await outbox.queue(batch)
      await connection.beginTransaction()
      await outbox.queue(batch, { tx: connection })
      await connection.commit()
      connection.release()

      expect(await count()).toBe(5000)

      // the invalid message is in the last statement, so the statements before it have to be rolled back
      await expect(outbox.queue([...batch, envelope('x'.repeat(300))])).rejects.toThrow(/too long/)

      expect(await count()).toBe(5000)

      await stop()
    })
  })
})

describe('Ordering', () => {
  test('a failed message stops its partition until it is published, other partitions go on', async () => {
    await mysql.withDatabase(async ({ options, pool }) => {
      const published: string[] = []
      let failures = 2
      const outbox = createConsumer(
        options,
        ({ messageId }) => {
          if (messageId === 'a1' && failures-- > 0) {
            throw new Error('broker is down')
          }
          published.push(messageId)
        },
        { retry: () => Duration.ofMiliseconds(100) },
      )

      await migrate(outbox.getDbConnection())
      await outbox.queue([envelope('a1'), envelope('a2')], { partitionKey: 'a' })
      await outbox.queue(envelope('b1'), { partitionKey: 'b' })

      const stop = await outbox.start()

      await waitUntil(() => published.length === 3)
      await stop()

      expect(published).toEqual(['b1', 'a1', 'a2'])
      expect(await select(pool, 'SELECT `message_id`, `attempts` FROM `hermes_outbox` ORDER BY `position`')).toEqual([
        { message_id: 'a1', attempts: 2 },
        { message_id: 'a2', attempts: 0 },
        { message_id: 'b1', attempts: 0 },
      ])
    })
  })

  test('two instances share the partitions, publish one partition at a time, in order, every message once', async () => {
    await mysql.withDatabase(async ({ options, pool }) => {
      const published: string[] = []
      const inProgress = new Set<string>()
      let overlaps = 0
      const publish = async ({ messageId, partitionKey }: HermesMessageEnvelope<Event>) => {
        if (inProgress.has(partitionKey)) {
          overlaps++
        }
        inProgress.add(partitionKey)
        await setTimeout(2)
        published.push(messageId)
        inProgress.delete(partitionKey)
      }
      const outbox1 = createConsumer(options, publish, { batchSize: 10 })
      const outbox2 = createConsumer(options, publish, { batchSize: 10 })
      const stop1 = await outbox1.start()

      for (const partitionKey of ['p0', 'p1', 'p2', 'p3']) {
        await outbox1.queue(
          Array.from({ length: 30 }, (_, i) => envelope(`${partitionKey}-${String(i).padStart(2, '0')}`)),
          { partitionKey },
        )
      }

      const stop2 = await outbox2.start()

      await waitUntil(() => published.length === 120)
      await Promise.all([stop1(), stop2()])

      expect(overlaps).toBe(0)
      expect(new Set(published).size).toBe(120)
      for (const partitionKey of ['p0', 'p1', 'p2', 'p3']) {
        const messages = published.filter((messageId) => messageId.startsWith(partitionKey))

        expect(messages).toEqual([...messages].sort())
      }
      expect(
        await select(pool, 'SELECT `claimed_by` FROM `hermes_outbox_partition` WHERE `claimed_by` IS NOT NULL'),
      ).toEqual([])
    })
  })

  test('another instance takes over the partition of an instance that died after the lease', async () => {
    await mysql.withDatabase(async ({ options, pool }) => {
      const published: string[] = []
      const outbox = createConsumer(options, ({ messageId }) => {
        published.push(messageId)
      })

      await migrate(outbox.getDbConnection())
      await outbox.queue(envelope('m1'))
      await pool.query(
        `INSERT INTO \`hermes_outbox_partition\` (\`consumer_name\`, \`partition_key\`, \`claimed_by\`, \`claimed_until\`)
         VALUES ('app', 'default', 'dead-instance', DATE_ADD(NOW(6), INTERVAL 1 SECOND))`,
      )

      const stop = await outbox.start()

      await setTimeout(500)
      expect(published).toEqual([])

      await waitUntil(() => published.length === 1)
      await stop()

      expect(published).toEqual(['m1'])
    })
  })

  test('with no ordering, two instances share the messages of one partition', async () => {
    await mysql.withDatabase(async ({ options }) => {
      const published: string[] = []
      const createInstance = (name: string) =>
        createConsumer(
          options,
          async ({ messageId }) => {
            await setTimeout(2)
            published.push(`${name}:${messageId}`)
          },
          { ordering: 'none', batchSize: 5 },
        )
      const outbox1 = createInstance('first')
      const outbox2 = createInstance('second')

      await migrate(outbox1.getDbConnection())
      await outbox1.queue(Array.from({ length: 60 }, (_, i) => envelope(`m${i}`)))

      const [stop1, stop2] = await Promise.all([outbox1.start(), outbox2.start()])

      await waitUntil(() => published.length === 60)
      await Promise.all([stop1(), stop2()])

      expect(new Set(published.map((entry) => entry.split(':')[1])).size).toBe(60)
      expect(new Set(published.map((entry) => entry.split(':')[0]))).toEqual(new Set(['first', 'second']))
    })
  })
})

describe('Consumers and partitions', () => {
  test('a consumer publishes only its own messages, and only of its partition when it has one', async () => {
    await mysql.withDatabase(async ({ options }) => {
      const published: Record<string, string[]> = { tenant: [], all: [], billing: [] }
      const tenant = createConsumer(
        options,
        ({ messageId }) => {
          published.tenant.push(messageId)
        },
        { partitionKey: 'tenant-0b1e8c8e-5f37-4a5e-9b8f-2f0c6a3d9e11' },
      )
      const all = createConsumer(
        options,
        ({ messageId }) => {
          published.all.push(messageId)
        },
        { consumerName: 'audit' },
      )
      const billing = createConsumer(
        options,
        ({ messageId }) => {
          published.billing.push(messageId)
        },
        { consumerName: 'billing' },
      )

      await migrate(tenant.getDbConnection())
      await tenant.queue(envelope('app-tenant'), { partitionKey: 'tenant-0b1e8c8e-5f37-4a5e-9b8f-2f0c6a3d9e11' })
      await tenant.queue(envelope('app-own'))
      await tenant.queue(envelope('app-default'), { partitionKey: 'default' })
      await all.queue(envelope('audit-a'), { partitionKey: 'a' })
      await all.queue(envelope('audit-b'), { partitionKey: 'b' })
      await billing.queue(envelope('billing'))

      const stops = await Promise.all([tenant.start(), all.start(), billing.start()])

      await waitUntil(() => published.tenant.length + published.all.length + published.billing.length === 5)
      await setTimeout(300)
      await Promise.all(stops.map((stop) => stop()))

      expect(published.tenant).toEqual(['app-tenant', 'app-own'])
      expect([...published.all].sort()).toEqual(['audit-a', 'audit-b'])
      expect(published.billing).toEqual(['billing'])
    })
  })
})

describe('Review fixes', () => {
  test('queue() stores the messages in the partition of the consumer by default', async () => {
    await mysql.withDatabase(async ({ options, pool }) => {
      const published: string[] = []
      const outbox = createConsumer(
        options,
        ({ messageId }) => {
          published.push(messageId)
        },
        { partitionKey: 'tenant-1' },
      )
      const stop = await outbox.start()

      await outbox.queue(envelope('own'))
      await outbox.queue(envelope('other'), { partitionKey: 'tenant-2' })

      await waitUntil(() => published.length === 1)
      await setTimeout(200)
      await stop()

      expect(published).toEqual(['own'])
      expect(
        await select(pool, 'SELECT `message_id`, `partition_key` FROM `hermes_outbox` ORDER BY `position`'),
      ).toEqual([
        { message_id: 'own', partition_key: 'tenant-1' },
        { message_id: 'other', partition_key: 'tenant-2' },
      ])
    })
  })

  test('partition keys and consumer names are compared byte by byte', async () => {
    await mysql.withDatabase(async ({ options, pool }) => {
      const published: string[] = []
      const outbox = createConsumer(options, ({ messageId, partitionKey }) => {
        published.push(`${partitionKey}:${messageId}`)
      })
      const stop = await outbox.start()

      await outbox.queue(envelope('1'), { partitionKey: 'Tenant-A' })
      await outbox.queue(envelope('2'), { partitionKey: 'tenant-a' })
      await outbox.queue(envelope('3'), { partitionKey: 'tenant-á' })
      await outbox.queue(envelope('4'), { partitionKey: 'tenant-a ' })

      await waitUntil(() => published.length === 4)
      await stop()

      expect([...published].sort()).toEqual(['Tenant-A:1', 'tenant-a :4', 'tenant-a:2', 'tenant-á:3'])
      expect(
        await select(pool, "SELECT COUNT(*) AS count FROM `hermes_outbox` WHERE `partition_key` = 'tenant-a'"),
      ).toEqual([{ count: '1' }])
    })
  })

  test('stop can be called many times at once', async () => {
    await mysql.withDatabase(async ({ options }) => {
      const stop = await createConsumer(options, () => {}).start()

      await Promise.all([stop(), stop(), stop()])
      await stop()
    })
  })

  test('a failed start can be started again', async () => {
    await mysql.withDatabase(async ({ options, pool }) => {
      const database = `${options.database}_later`
      const outbox = createConsumer({ ...options, database }, () => {})

      await expect(outbox.start()).rejects.toThrow(/Unknown database/)

      await pool.query(`CREATE DATABASE \`${database}\``)

      const stop = await outbox.start()

      await stop()
    })
  })

  test('a failure reported after the claim expired keeps the claim of another instance', async () => {
    await mysql.withDatabase(async ({ options, pool, onDispose }) => {
      const outbox = createConsumer(options, () => {})
      const pollingPool = createPollingPool(options)
      const store = createPollingStore<Event>(() => pollingPool, { consumerName: 'app' })

      onDispose(() => pollingPool.end())

      await migrate(pool)
      await outbox.queue(envelope('m1'))

      const [claimedByFirst] = await store.claimMessages({
        owner: 'first',
        lease: Duration.ofMiliseconds(50),
        limit: 1,
      })

      await setTimeout(100)

      const [claimedBySecond] = await store.claimMessages({ owner: 'second', lease: Duration.ofSeconds(30), limit: 1 })

      expect(claimedBySecond.messageId).toBe('m1')

      await store.markFailed(claimedByFirst, { retryAfter: Duration.ofSeconds(1), owner: 'first' })

      expect(await select(pool, 'SELECT `claimed_by`, `attempts`, `next_attempt_at` FROM `hermes_outbox`')).toEqual([
        { claimed_by: 'second', attempts: 0, next_attempt_at: null },
      ])

      await store.markDelivered(claimedBySecond)
      await store.markFailed(claimedBySecond, { retryAfter: Duration.ofSeconds(1), owner: 'second' })

      expect(await select(pool, 'SELECT `attempts` FROM `hermes_outbox`')).toEqual([{ attempts: 0 }])

      await outbox.getDbConnection().end()
    })
  })

  test('finds the partitions with undelivered messages, also more than 1000 of them, and removes the empty ones', async () => {
    await mysql.withDatabase(async ({ options, pool, onDispose }) => {
      const outbox = createConsumer(options, () => {})
      const pollingPool = createPollingPool(options)
      const store = createPollingStore<Event>(() => pollingPool, { consumerName: 'app' })

      onDispose(() => pollingPool.end())
      const count = async () =>
        Number(
          (await select<{ count: string }>(pool, 'SELECT COUNT(*) AS count FROM `hermes_outbox_partition`'))[0].count,
        )

      await migrate(pool)
      for (let i = 0; i < 1200; i++) {
        await outbox.queue(envelope(`m${i}`), { partitionKey: `p${String(i).padStart(4, '0')}` })
      }

      await store.claimPartitions({ owner: 'first', lease: Duration.ofSeconds(30), limit: 10 })

      expect(await count()).toBe(1200)

      await pool.query("UPDATE `hermes_outbox` SET `delivered_at` = NOW(6) WHERE `partition_key` <> 'p0042'")
      await store.releasePartitions({ owner: 'first' })

      expect(await store.claimPartitions({ owner: 'first', lease: Duration.ofSeconds(30), limit: 10 })).toEqual([
        'p0042',
      ])
      expect(await count()).toBe(1)

      await store.releasePartitions({ owner: 'first' })

      expect(
        await select(pool, 'SELECT `claimed_by` FROM `hermes_outbox_partition` WHERE `claimed_by` IS NOT NULL'),
      ).toEqual([])

      await outbox.getDbConnection().end()
    })
  })

  test('a failed start keeps the pool that the application already uses', async () => {
    await mysql.withDatabase(async ({ options, pool }) => {
      const outbox = createConsumer(options, () => {})
      const ownPool = outbox.getDbConnection()

      await pool.query('CREATE VIEW `hermes_migrations` AS SELECT 1 AS `other`')

      await expect(outbox.start()).rejects.toThrow(/Unknown column/)

      expect(await ownPool.query('SELECT 1 AS `one`').then(([rows]) => rows)).toEqual([{ one: '1' }])

      await ownPool.end()
    })
  })

  test('Hermes polls with its own pool in READ COMMITTED, also with resetOnRelease, and stop() closes only that pool', async () => {
    await mysql.withDatabase(async ({ options, pool }) => {
      const published: string[] = []
      const outbox = createConsumer({ ...options, resetOnRelease: true }, ({ messageId }) => {
        published.push(messageId)
      })

      const stop = await outbox.start()

      for (let i = 0; i < 20; i++) {
        await outbox.queue(envelope(`m${i}`), { partitionKey: `p${i % 4}` })
      }
      await waitUntil(() => published.length === 20)

      const connections = await pollingConnections(pool)

      expect(connections.length).toBeGreaterThan(0)
      expect(connections.length).toBeLessThanOrEqual(3)
      expect(new Set(connections.map(({ isolation }) => isolation))).toEqual(new Set(['READ-COMMITTED']))

      await stop()

      expect(await select(outbox.getDbConnection(), 'SELECT @@transaction_isolation AS `isolation`')).toEqual([
        { isolation: 'REPEATABLE-READ' },
      ])

      await expectNoPollingConnections(pool)
    })
  })

  test('markDelivered tries again when a transaction of the application locks the message for a while', async () => {
    await mysql.withDatabase(async ({ options, pool, onDispose }) => {
      const outbox = createConsumer(options, () => {})
      const pollingPool = createPollingPool(options)
      const store = createPollingStore<Event>(() => pollingPool, { consumerName: 'app' })

      onDispose(() => pollingPool.end())

      await migrate(pool)
      await outbox.queue(envelope('m1'))

      const [message] = await store.claimMessages({ owner: 'first', lease: Duration.ofSeconds(30), limit: 1 })
      const connection = await pool.getConnection()

      try {
        await connection.beginTransaction()
        await connection.query('SELECT * FROM `hermes_outbox` FOR UPDATE')

        const committing = setTimeout(Duration.ofSeconds(6).ms).then(() => connection.commit())

        await store.markDelivered(message)
        await committing
      } finally {
        connection.release()
      }

      expect(await select(pool, 'SELECT `delivered_at` IS NOT NULL AS `delivered` FROM `hermes_outbox`')).toEqual([
        { delivered: '1' },
      ])
    })
  })

  test('a failed start closes the polling pool and can be tried again', async () => {
    await mysql.withDatabase(async ({ options, pool }) => {
      await expect(createConsumer(options, () => {}, { maxPartitions: 0 }).start()).rejects.toThrow(/partitions/i)
      await expect(createConsumer(options, () => {}, { pollingConnectionLimit: 0 }).start()).rejects.toThrow(
        /positive integer/,
      )

      expect(await select(pool, 'SHOW TABLES')).toEqual([])

      const outbox = createConsumer(options, () => {})

      await pool.query('CREATE VIEW `hermes_migrations` AS SELECT 1 AS `other`')

      await expect(outbox.start()).rejects.toThrow(/Unknown column/)
      await expectNoPollingConnections(pool)

      await pool.query('DROP VIEW `hermes_migrations`')

      const stop = await outbox.start()

      await stop()
      await expectNoPollingConnections(pool)
    })
  })

  test('with partition ordering, a failure reported by an instance that lost the partition is ignored', async () => {
    await mysql.withDatabase(async ({ options, pool, onDispose }) => {
      const outbox = createConsumer(options, () => {})
      const pollingPool = createPollingPool(options)
      const store = createPollingStore<Event>(() => pollingPool, { consumerName: 'app' })

      onDispose(() => pollingPool.end())

      await migrate(pool)
      await outbox.queue(envelope('m1'))

      expect(await store.claimPartitions({ owner: 'second', lease: Duration.ofSeconds(30), limit: 10 })).toEqual([
        'default',
      ])

      const [message] = await store.readPartition({ partitionKey: 'default', limit: 1 })

      await store.markFailed(message, { retryAfter: Duration.ofSeconds(1), owner: 'first' })

      expect(await select(pool, 'SELECT `attempts`, `next_attempt_at` FROM `hermes_outbox`')).toEqual([
        { attempts: 0, next_attempt_at: null },
      ])

      await store.markFailed(message, { retryAfter: Duration.ofSeconds(1), owner: 'second' })

      expect(await select(pool, 'SELECT `attempts` FROM `hermes_outbox`')).toEqual([{ attempts: 1 }])

      await outbox.getDbConnection().end()
    })
  })

  test('releasing the claims does not wait for the open transactions of the application', async () => {
    await mysql.withDatabase(async ({ options, pool }) => {
      const outbox = createConsumer(options, () => {}, { ordering: 'none' })
      const stop = await outbox.start()
      const connection = await pool.getConnection()

      try {
        await connection.beginTransaction()
        await outbox.queue(envelope('uncommitted'), { tx: connection })

        const startedAt = Date.now()

        await stop()

        expect(Date.now() - startedAt).toBeLessThan(Duration.ofSeconds(5).ms)
      } finally {
        await connection.rollback()
        connection.release()
      }
    })
  })
})
