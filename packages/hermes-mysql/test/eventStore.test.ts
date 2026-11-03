import { createCommandHandler, defineHermesProjection, Duration, VersionConflictError } from '@chassisjs/hermes'
import { afterAll, beforeAll, describe, expect, jest, test } from '@jest/globals'
import { type Pool, type PoolConnection, type RowDataPacket } from 'mysql2/promise'
import { setTimeout } from 'node:timers/promises'
import {
  createEventStore,
  createEventStoreConsumer,
  createMutex,
  createProjectionConsumer,
  fromInlineProjection,
  type HermesEventEnvelope,
  migrate,
} from '../src/index.js'
import { createMySql } from './mysql.js'
import {
  complete,
  completed,
  FUTURE,
  NoOpenOccurrenceError,
  note,
  NOW,
  PAST,
  schedule,
  scheduled,
  scheduling,
  tick,
  type Occurrence,
  type SchedulingEvent,
} from './scheduling.js'

jest.setTimeout(Duration.ofMinutes(5).ms)

const mysql = createMySql(process.env.MYSQL_VERSION)

beforeAll(() => mysql.start(), Duration.ofMinutes(3).ms)
afterAll(() => mysql.stop())

/*
  ----------------------------------------
  Helpers
  ----------------------------------------
*/

const waitUntil = async (condition: () => boolean | Promise<boolean>, timeout = Duration.ofSeconds(20)) => {
  const deadline = Date.now() + timeout.ms

  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw new Error('Timed out.')
    }

    await setTimeout(20)
  }
}

const select = async <T>(pool: Pool, sql: string, params: unknown[] = []) => {
  const [rows] = await pool.query<RowDataPacket[]>(sql, params)

  return rows as T[]
}

const count = async (pool: Pool, sql: string, params: unknown[] = []) =>
  Number((await select<{ n: string | number }>(pool, sql, params))[0].n)

const withTransaction = async <T>(pool: Pool, fn: (tx: PoolConnection) => Promise<T>) => {
  const connection = await pool.getConnection()

  try {
    await connection.beginTransaction()
    const result = await fn(connection)
    await connection.commit()

    return result
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }
}

const occurrences = defineHermesProjection<Occurrence, SchedulingEvent>()
  .ofName('occurrences')
  .ofDocumentType()
  .ofEvents('OccurrenceScheduled', 'OccurrenceBecameDueNow', 'TaskCompleted', 'NoteAdded')
  .ofInitialState(scheduling.initialState)
  .ofEvolve(scheduling.evolve)
  .inline()
  .done()

/** Counts all the events of all the streams in one document. */
const eventCounter = defineHermesProjection<{ count: number }, SchedulingEvent>()
  .ofName('eventCounter')
  .ofDocumentType()
  .ofEvents('OccurrenceScheduled', 'OccurrenceBecameDueNow', 'TaskCompleted', 'NoteAdded')
  .ofInitialState(() => ({ count: 0 }))
  .ofEvolve((state) => ({ count: state.count + 1 }))
  .ofId(() => 'all')
  .async()
  .done()

const setUp = async (pool: Pool) => {
  await migrate(pool)

  return createEventStore(pool, { projections: [occurrences] })
}

const positionsBy = (published: HermesEventEnvelope<SchedulingEvent>[], streamId: string) =>
  published.filter((event) => event.streamId === streamId).map(({ streamPosition }) => streamPosition)

/*
  ----------------------------------------
  Tests
  ----------------------------------------
*/

describe('Migrations', () => {
  test('migrate creates the tables of the event store', async () => {
    await mysql.withDatabase(async ({ pool }) => {
      expect(await migrate(pool)).toEqual([1, 2])
      expect(await select(pool, 'SELECT `version`, `name` FROM `hermes_migrations` ORDER BY `version`')).toEqual([
        { version: 1, name: 'create the outbox' },
        { version: 2, name: 'create the event store' },
      ])

      const tables = (await select<Record<string, string>>(pool, 'SHOW TABLES')).map((row) => Object.values(row)[0])

      expect(tables).toEqual(
        expect.arrayContaining(['hermes_streams', 'hermes_events', 'hermes_subscriptions', 'hermes_projections']),
      )
    })
  })
})

describe('Appending and reading', () => {
  test('the first append creates the stream, and its version is the number of its events', async () => {
    await mysql.withDatabase(async ({ pool }) => {
      const eventStore = await setUp(pool)

      await eventStore.appendToStream<SchedulingEvent>('task-1', [scheduled('o-1', FUTURE), note('a')])
      const result = await eventStore.appendToStream<SchedulingEvent>('task-1', [note('b')])

      expect(result).toEqual({ nextVersion: 3n, createdNewStream: false })
      expect(await select(pool, 'SELECT `version` FROM `hermes_streams` WHERE `stream_id` = ?', ['task-1'])).toEqual([
        { version: '3' },
      ])
      expect(
        await select(pool, 'SELECT `stream_position` FROM `hermes_events` WHERE `stream_id` = ? ORDER BY 1', [
          'task-1',
        ]),
      ).toEqual([{ stream_position: '1' }, { stream_position: '2' }, { stream_position: '3' }])
    })
  })

  test('reads the events in order, also after a position', async () => {
    await mysql.withDatabase(async ({ pool }) => {
      const eventStore = await setUp(pool)

      for (const text of ['a', 'b', 'c', 'd']) {
        await eventStore.appendToStream<SchedulingEvent>('task-1', [note(text)])
      }

      const all = await eventStore.readStream<SchedulingEvent>('task-1')
      const after = await eventStore.readStream<SchedulingEvent>('task-1', { after: 2n })

      expect(all.events.map(({ data }) => data)).toEqual([{ text: 'a' }, { text: 'b' }, { text: 'c' }, { text: 'd' }])
      expect(all.currentVersion).toBe(4n)
      expect(after.events.map(({ streamPosition }) => streamPosition)).toEqual([3n, 4n])
    })
  })

  test('a stream that does not exist is empty at version 0', async () => {
    await mysql.withDatabase(async ({ pool }) => {
      const eventStore = await setUp(pool)

      expect(await eventStore.readStream('task-404')).toEqual({ events: [], currentVersion: 0n, streamExists: false })
    })
  })

  test('stores the data, the metadata, a unique id and the time of every event', async () => {
    await mysql.withDatabase(async ({ pool }) => {
      const eventStore = await setUp(pool)

      await eventStore.appendToStream('task-1', [
        { type: 'NoteAdded', data: { text: 'a' }, metadata: { correlationId: 'c-1', userId: 'u-1' } },
        { type: 'NoteAdded', data: { text: 'b' }, metadata: { correlationId: 'c-1' } },
      ])

      const { events } = await eventStore.readStream('task-1')

      expect(events[0]).toMatchObject({
        type: 'NoteAdded',
        data: { text: 'a' },
        metadata: { correlationId: 'c-1', userId: 'u-1' },
      })
      expect(new Set(events.map(({ eventId }) => eventId)).size).toBe(2)
      events.forEach(({ recordedAt }) => expect(recordedAt).toBeInstanceOf(Date))
    })
  })

  test('reads its own writes at once, also inside the transaction of the application', async () => {
    await mysql.withDatabase(async ({ pool }) => {
      const eventStore = await setUp(pool)

      await withTransaction(pool, async (tx) => {
        await eventStore.appendToStream<SchedulingEvent>('task-1', [note('a')], { tx })

        expect((await eventStore.readStream('task-1', { tx })).currentVersion).toBe(1n)
      })

      expect((await eventStore.readStream('task-1')).currentVersion).toBe(1n)
    })
  })

  test('events appended in the transaction of the application are stored only when it commits', async () => {
    await mysql.withDatabase(async ({ pool }) => {
      const eventStore = await setUp(pool)

      await expect(
        withTransaction(pool, async (tx) => {
          await eventStore.appendToStream<SchedulingEvent>('task-1', [note('a')], { tx })
          throw new Error('The application failed.')
        }),
      ).rejects.toThrow('The application failed.')

      expect(await eventStore.readStream('task-1')).toMatchObject({ streamExists: false })
      expect(await count(pool, 'SELECT COUNT(*) AS n FROM `hermes_streams`')).toBe(0)
    })
  })
})

describe('Optimistic concurrency', () => {
  test('a stale expected version is a conflict, and nothing is appended', async () => {
    await mysql.withDatabase(async ({ pool }) => {
      const eventStore = await setUp(pool)

      await eventStore.appendToStream<SchedulingEvent>('task-1', [note('a'), note('b')])

      const error = await eventStore
        .appendToStream<SchedulingEvent>('task-1', [note('c'), note('d')], { expectedVersion: 1n })
        .catch((error: unknown) => error)

      expect(error).toBeInstanceOf(VersionConflictError)
      expect(error).toMatchObject({ details: { streamId: 'task-1', expectedVersion: 1n, currentVersion: 2n } })
      expect(await count(pool, 'SELECT COUNT(*) AS n FROM `hermes_events`')).toBe(2)
    })
  })

  test('`no_stream` and `stream_exists`', async () => {
    await mysql.withDatabase(async ({ pool }) => {
      const eventStore = await setUp(pool)

      await expect(
        eventStore.appendToStream<SchedulingEvent>('task-1', [note('a')], { expectedVersion: 'stream_exists' }),
      ).rejects.toBeInstanceOf(VersionConflictError)

      await eventStore.appendToStream<SchedulingEvent>('task-1', [note('a')], { expectedVersion: 'no_stream' })

      await expect(
        eventStore.appendToStream<SchedulingEvent>('task-1', [note('b')], { expectedVersion: 'no_stream' }),
      ).rejects.toBeInstanceOf(VersionConflictError)
      await expect(
        eventStore.appendToStream<SchedulingEvent>('task-1', [note('b')], { expectedVersion: 'stream_exists' }),
      ).resolves.toMatchObject({ nextVersion: 2n })
    })
  })

  test('of concurrent appends with the same expected version, one succeeds and the others are conflicts', async () => {
    await mysql.withDatabase(async ({ pool }) => {
      const eventStore = await setUp(pool)

      await eventStore.appendToStream<SchedulingEvent>('task-1', [note('a')])

      const results = await Promise.allSettled(
        Array.from({ length: 10 }, (_, i) =>
          eventStore.appendToStream<SchedulingEvent>('task-1', [note(`b${i}`)], { expectedVersion: 1n }),
        ),
      )

      expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
      // a conflict, never a deadlock or a duplicate key leaking out of the store
      results
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .forEach(({ reason }) => expect(reason).toBeInstanceOf(VersionConflictError))
      expect((await eventStore.readStream('task-1')).currentVersion).toBe(2n)
    })
  })

  test('concurrent creations of the same stream: one succeeds', async () => {
    await mysql.withDatabase(async ({ pool }) => {
      const eventStore = await setUp(pool)

      const results = await Promise.allSettled(
        Array.from({ length: 5 }, (_, i) =>
          eventStore.appendToStream<SchedulingEvent>('task-1', [note(`${i}`)], { expectedVersion: 'no_stream' }),
        ),
      )

      expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
      expect((await eventStore.readStream('task-1')).currentVersion).toBe(1n)
    })
  })

  test('appends to different streams do not wait for each other', async () => {
    await mysql.withDatabase(async ({ pool }) => {
      const eventStore = await setUp(pool)

      await withTransaction(pool, async (tx) => {
        await eventStore.appendToStream<SchedulingEvent>('task-1', [note('a')], { tx })

        // task-1 stays locked by the open transaction
        await expect(
          Promise.race([
            eventStore.appendToStream<SchedulingEvent>('task-2', [note('b')]),
            setTimeout(Duration.ofSeconds(2).ms).then(() => 'blocked'),
          ]),
        ).resolves.toEqual({ nextVersion: 1n, createdNewStream: true })
      })
    })
  })
})

describe('Inline projections', () => {
  test('the document is updated in the transaction of the append, at the version of the stream', async () => {
    await mysql.withDatabase(async ({ pool }) => {
      const eventStore = await setUp(pool)

      await eventStore.appendToStream<SchedulingEvent>('task-1', [scheduled('o-1', FUTURE)])
      await eventStore.appendToStream<SchedulingEvent>('task-1', [note('a')])

      expect(await eventStore.readProjection(occurrences, 'task-1')).toEqual({
        data: { status: 'scheduled', occurrenceId: 'o-1', dueAt: FUTURE },
        version: 2n,
      })
    })
  })

  test('a conflict leaves the document as it was', async () => {
    await mysql.withDatabase(async ({ pool }) => {
      const eventStore = await setUp(pool)

      await eventStore.appendToStream<SchedulingEvent>('task-1', [scheduled('o-1', FUTURE)])
      await expect(
        eventStore.appendToStream<SchedulingEvent>('task-1', [completed('o-1')], { expectedVersion: 0n }),
      ).rejects.toBeInstanceOf(VersionConflictError)

      expect(await eventStore.readProjection(occurrences, 'task-1')).toMatchObject({
        data: { status: 'scheduled' },
        version: 1n,
      })
    })
  })

  test('a rolled back transaction of the application leaves no document', async () => {
    await mysql.withDatabase(async ({ pool }) => {
      const eventStore = await setUp(pool)

      await withTransaction(pool, async (tx) => {
        await eventStore.appendToStream<SchedulingEvent>('task-1', [scheduled('o-1', FUTURE)], { tx })
        throw new Error('rollback')
      }).catch(() => {})

      expect(await eventStore.readProjection(occurrences, 'task-1')).toBeNull()
    })
  })

  test('fromInlineProjection needs a projection of a single stream', async () => {
    await mysql.withDatabase(async ({ pool }) => {
      const eventStore = await setUp(pool)
      const multiStream = defineHermesProjection<Occurrence, SchedulingEvent>()
        .ofName('multiStream')
        .ofDocumentType()
        .ofEvents('OccurrenceScheduled')
        .ofInitialState(scheduling.initialState)
        .ofEvolve(scheduling.evolve)
        .ofId(() => 'all')
        .inline()
        .done()

      expect(() => fromInlineProjection(eventStore, multiStream)).toThrow()
    })
  })
})

describe('Command handler, state-stored', () => {
  test('decides on the document of the inline projection, not on the events', async () => {
    await mysql.withDatabase(async ({ pool }) => {
      const eventStore = await setUp(pool)
      const handle = createCommandHandler({
        decider: scheduling,
        eventStore,
        loadState: fromInlineProjection(eventStore, occurrences),
      })

      await handle('task-1', schedule('o-1', FUTURE))
      // Only the document says that the occurrence is due; folding the events would say it is not.
      await pool.query(
        "UPDATE `hermes_projections` SET `data` = JSON_SET(`data`, '$.dueAt', ?) WHERE `name` = ? AND `id` = ?",
        [PAST, 'occurrences', 'task-1'],
      )

      const { newEvents, nextVersion } = await handle('task-1', tick(NOW))

      expect(newEvents.map(({ type }) => type)).toEqual(['OccurrenceBecameDueNow'])
      expect(nextVersion).toBe(2n)
    })
  })

  test('of a tick and users completing the same occurrence at once, exactly one completes it', async () => {
    await mysql.withDatabase(async ({ pool }) => {
      const eventStore = await setUp(pool)
      const handle = createCommandHandler({
        decider: scheduling,
        eventStore,
        loadState: fromInlineProjection(eventStore, occurrences),
        retry: { attempts: 10 },
      })

      await handle('task-1', schedule('o-1', PAST, PAST))

      const results = await Promise.allSettled([
        handle('task-1', tick(NOW)),
        ...Array.from({ length: 5 }, () => handle('task-1', complete('o-1'))),
      ])
      const completions = results.slice(1)

      expect(completions.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
      completions
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .forEach(({ reason }) => expect(reason).toBeInstanceOf(NoOpenOccurrenceError))

      const types = (await eventStore.readStream<SchedulingEvent>('task-1')).events.map(({ type }) => type)

      expect(types.filter((type) => type === 'TaskCompleted')).toHaveLength(1)
      expect(await eventStore.readProjection(occurrences, 'task-1')).toMatchObject({ data: { status: 'completed' } })
    })
  })
})

describe('Event store consumer', () => {
  test('publishes every event once, and the events of a stream in order, with two instances', async () => {
    await mysql.withDatabase(async ({ pool, options, onDispose }) => {
      const eventStore = await setUp(pool)
      const published: HermesEventEnvelope<SchedulingEvent>[] = []

      for (let i = 0; i < 2; i++) {
        const consumer = createEventStoreConsumer<SchedulingEvent>({
          getOptions: () => options,
          consumerName: 'relay',
          publish: (event) => void published.push(event),
          pollInterval: Duration.ofMiliseconds(50),
          maxPartitions: 3,
        })
        onDispose(await consumer.start())
      }

      for (let position = 0; position < 10; position++) {
        for (const streamId of ['task-1', 'task-2', 'task-3', 'task-4', 'task-5']) {
          await eventStore.appendToStream<SchedulingEvent>(streamId, [note(`${position}`)])
        }
      }

      await waitUntil(() => published.length >= 50)
      await setTimeout(300)

      expect(published).toHaveLength(50)
      expect(new Set(published.map(({ eventId }) => eventId)).size).toBe(50)
      for (const streamId of ['task-1', 'task-2', 'task-3', 'task-4', 'task-5']) {
        expect(positionsBy(published, streamId)).toEqual([1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n, 10n])
      }
    })
  })

  test('consumers of different names get all the events each', async () => {
    await mysql.withDatabase(async ({ pool, options, onDispose }) => {
      const eventStore = await setUp(pool)
      const relay: string[] = []
      const audit: string[] = []

      onDispose(
        await createEventStoreConsumer<SchedulingEvent>({
          getOptions: () => options,
          consumerName: 'relay',
          publish: (event) => void relay.push(event.eventId),
          pollInterval: Duration.ofMiliseconds(50),
        }).start(),
      )
      onDispose(
        await createEventStoreConsumer<SchedulingEvent>({
          getOptions: () => options,
          consumerName: 'audit',
          publish: (event) => void audit.push(event.eventId),
          pollInterval: Duration.ofMiliseconds(50),
        }).start(),
      )

      await eventStore.appendToStream<SchedulingEvent>('task-1', [note('a'), note('b')])
      await eventStore.appendToStream<SchedulingEvent>('task-2', [note('c')])

      await waitUntil(() => relay.length === 3 && audit.length === 3)
      expect(new Set(relay)).toEqual(new Set(audit))
    })
  })

  test('remembers the version of every stream it published', async () => {
    await mysql.withDatabase(async ({ pool, options, onDispose }) => {
      const eventStore = await setUp(pool)
      let published = 0

      onDispose(
        await createEventStoreConsumer<SchedulingEvent>({
          getOptions: () => options,
          consumerName: 'relay',
          publish: () => void published++,
          pollInterval: Duration.ofMiliseconds(50),
        }).start(),
      )

      await eventStore.appendToStream<SchedulingEvent>('task-1', [note('a'), note('b'), note('c')])
      await waitUntil(() => published === 3)
      await waitUntil(
        async () =>
          (await count(
            pool,
            'SELECT `version` AS n FROM `hermes_subscriptions` WHERE `consumer_name` = ? AND `stream_id` = ?',
            ['relay', 'task-1'],
          )) === 3,
      )
    })
  })

  test('after a restart, publishes only the events it has not published yet', async () => {
    await mysql.withDatabase(async ({ pool, options }) => {
      const eventStore = await setUp(pool)
      const published: HermesEventEnvelope<SchedulingEvent>[] = []
      const create = () =>
        createEventStoreConsumer<SchedulingEvent>({
          getOptions: () => options,
          consumerName: 'relay',
          publish: (event) => void published.push(event),
          pollInterval: Duration.ofMiliseconds(50),
        })

      let stop = await create().start()
      await eventStore.appendToStream<SchedulingEvent>('task-1', [note('a'), note('b'), note('c')])
      await waitUntil(() => published.length === 3)
      await stop()

      stop = await create().start()
      await setTimeout(300)
      expect(published).toHaveLength(3)

      await eventStore.appendToStream<SchedulingEvent>('task-1', [note('d')])
      await waitUntil(() => published.length === 4)
      await stop()

      expect(positionsBy(published, 'task-1')).toEqual([1n, 2n, 3n, 4n])
    })
  })

  test('a failed event stops its stream until it is published; other streams go on', async () => {
    await mysql.withDatabase(async ({ pool, options, onDispose }) => {
      const eventStore = await setUp(pool)
      const published: HermesEventEnvelope<SchedulingEvent>[] = []
      const onFailedPublish = jest.fn()
      let failures = 2

      onDispose(
        await createEventStoreConsumer<SchedulingEvent>({
          getOptions: () => options,
          consumerName: 'relay',
          publish: (event) => {
            if (event.streamId === 'task-2' && event.streamPosition === 2n && failures > 0) {
              failures--
              throw new Error('The broker is down.')
            }

            published.push(event)
          },
          pollInterval: Duration.ofMiliseconds(50),
          retry: () => Duration.ofMiliseconds(200),
          onFailedPublish,
        }).start(),
      )

      await eventStore.appendToStream<SchedulingEvent>('task-2', [note('a'), note('b'), note('c')])
      await eventStore.appendToStream<SchedulingEvent>('task-1', [note('d'), note('e')])

      await waitUntil(() => positionsBy(published, 'task-1').length === 2)
      expect(positionsBy(published, 'task-2')).toEqual([1n])

      await waitUntil(() => positionsBy(published, 'task-2').length === 3)
      expect(positionsBy(published, 'task-2')).toEqual([1n, 2n, 3n])
      expect(published.find((event) => event.streamId === 'task-2' && event.streamPosition === 2n)).toMatchObject({
        redeliveryCount: 2,
      })
      expect(onFailedPublish).toHaveBeenCalledTimes(2)
    })
  })

  test('does not lose the events of a transaction that commits after a later one', async () => {
    await mysql.withDatabase(async ({ pool, options, onDispose }) => {
      const eventStore = await setUp(pool)
      const published: HermesEventEnvelope<SchedulingEvent>[] = []

      onDispose(
        await createEventStoreConsumer<SchedulingEvent>({
          getOptions: () => options,
          consumerName: 'relay',
          publish: (event) => void published.push(event),
          pollInterval: Duration.ofMiliseconds(50),
        }).start(),
      )

      const slow = await pool.getConnection()

      try {
        await slow.beginTransaction()
        await eventStore.appendToStream<SchedulingEvent>('task-A', [note('slow')], { tx: slow })

        await eventStore.appendToStream<SchedulingEvent>('task-B', [note('fast')])
        await waitUntil(() => published.some(({ streamId }) => streamId === 'task-B'))
        expect(published.some(({ streamId }) => streamId === 'task-A')).toBe(false)

        await slow.commit()
      } finally {
        slow.release()
      }

      await waitUntil(() => published.some(({ streamId }) => streamId === 'task-A'))
    })
  })

  test('publishing never blocks the appends of the application to the same stream', async () => {
    await mysql.withDatabase(async ({ pool, options, onDispose }) => {
      const eventStore = await setUp(pool)
      let unblock = () => {}
      const blocked = new Promise<void>((resolve) => (unblock = resolve))
      let publishing = false

      onDispose(async () => unblock())
      onDispose(
        await createEventStoreConsumer<SchedulingEvent>({
          getOptions: () => options,
          consumerName: 'relay',
          publish: async () => {
            publishing = true
            await blocked
          },
          pollInterval: Duration.ofMiliseconds(50),
        }).start(),
      )

      await eventStore.appendToStream<SchedulingEvent>('task-1', [note('a')])
      await waitUntil(() => publishing)

      await expect(
        Promise.race([
          eventStore.appendToStream<SchedulingEvent>('task-1', [note('b')], { expectedVersion: 1n }),
          setTimeout(Duration.ofSeconds(2).ms).then(() => 'blocked'),
        ]),
      ).resolves.toEqual({ nextVersion: 2n, createdNewStream: false })

      unblock()
    })
  })
})

describe('Async projections', () => {
  test('builds the document from the events of many streams', async () => {
    await mysql.withDatabase(async ({ pool, options, onDispose }) => {
      const eventStore = await setUp(pool)

      onDispose(
        await createProjectionConsumer({
          getOptions: () => options,
          projection: eventCounter,
          pollInterval: Duration.ofMiliseconds(50),
        }).start(),
      )

      await eventStore.appendToStream<SchedulingEvent>('task-1', [note('a'), note('b')])
      await eventStore.appendToStream<SchedulingEvent>('task-2', [scheduled('o-1', FUTURE)])

      await waitUntil(async () => (await eventStore.readProjection(eventCounter, 'all'))?.data.count === 3)
    })
  })

  test('after a restart, does not apply an event twice', async () => {
    await mysql.withDatabase(async ({ pool, options }) => {
      const eventStore = await setUp(pool)
      const create = () =>
        createProjectionConsumer({
          getOptions: () => options,
          projection: eventCounter,
          pollInterval: Duration.ofMiliseconds(50),
        })
      const countIs = (n: number) => async () =>
        (await eventStore.readProjection(eventCounter, 'all'))?.data.count === n

      let stop = await create().start()
      await eventStore.appendToStream<SchedulingEvent>('task-1', [note('a'), note('b')])
      await waitUntil(countIs(2))
      await stop()

      stop = await create().start()
      await eventStore.appendToStream<SchedulingEvent>('task-1', [note('c')])
      await waitUntil(countIs(3))
      await setTimeout(300)
      await stop()

      expect((await eventStore.readProjection(eventCounter, 'all'))?.data.count).toBe(3)
    })
  })

  test('a failing evolve changes neither the document nor the version, and is retried', async () => {
    await mysql.withDatabase(async ({ pool, options, onDispose }) => {
      const eventStore = await setUp(pool)
      let failures = 1
      const flaky = defineHermesProjection<{ texts: string[] }, SchedulingEvent>()
        .ofName('flaky')
        .ofDocumentType()
        .ofEvents('NoteAdded')
        .ofInitialState(() => ({ texts: [] }))
        .ofEvolve((state, event) => {
          if (event.data.text === 'b' && failures > 0) {
            failures--
            throw new Error('evolve failed')
          }

          return { texts: [...state.texts, event.data.text] }
        })
        .async()
        .done()

      onDispose(
        await createProjectionConsumer({
          getOptions: () => options,
          projection: flaky,
          pollInterval: Duration.ofMiliseconds(50),
          retry: () => Duration.ofMiliseconds(100),
        }).start(),
      )

      await eventStore.appendToStream<SchedulingEvent>('task-1', [note('a'), note('b'), note('c')])

      await waitUntil(async () => (await eventStore.readProjection(flaky, 'task-1'))?.data.texts.length === 3)
      expect(await eventStore.readProjection(flaky, 'task-1')).toEqual({
        data: { texts: ['a', 'b', 'c'] },
        version: 3n,
      })
    })
  })

  test('skips the events the projection does not handle, and still moves on', async () => {
    await mysql.withDatabase(async ({ pool, options, onDispose }) => {
      const eventStore = await setUp(pool)
      const scheduledOnly = defineHermesProjection<{ ids: string[] }, SchedulingEvent>()
        .ofName('scheduledOnly')
        .ofDocumentType()
        .ofEvents('OccurrenceScheduled')
        .ofInitialState(() => ({ ids: [] }))
        .ofEvolve((state, event) => ({ ids: [...state.ids, event.data.occurrenceId] }))
        .ofId(() => 'all')
        .async()
        .done()

      onDispose(
        await createProjectionConsumer({
          getOptions: () => options,
          projection: scheduledOnly,
          pollInterval: Duration.ofMiliseconds(50),
        }).start(),
      )

      await eventStore.appendToStream<SchedulingEvent>('task-1', [note('a'), scheduled('o-1', FUTURE), note('b')])
      await eventStore.appendToStream<SchedulingEvent>('task-2', [scheduled('o-2', FUTURE)])

      await waitUntil(async () => (await eventStore.readProjection(scheduledOnly, 'all'))?.data.ids.length === 2)
      await waitUntil(
        async () =>
          (await count(
            pool,
            'SELECT `version` AS n FROM `hermes_subscriptions` WHERE `consumer_name` = ? AND `stream_id` = ?',
            ['projection:scheduledOnly', 'task-1'],
          )) === 3,
      )
    })
  })
})

describe('Mutex', () => {
  const holderOf = async (pool: Pool, name: string) =>
    (await select<{ holder: number | null }>(pool, 'SELECT IS_USED_LOCK(?) AS holder', [name]))[0].holder

  test('only one instance holds the lock', async () => {
    await mysql.withDatabase(async ({ options, onDispose }) => {
      const first = createMutex({ getOptions: () => options, name: 'scheduling-tick' })
      const second = createMutex({ getOptions: () => options, name: 'scheduling-tick' })
      onDispose(() => first.unlock())
      onDispose(() => second.unlock())

      expect(await first.tryLock()).toBe(true)
      expect(await second.tryLock()).toBe(false)

      await first.unlock()

      expect(await second.tryLock()).toBe(true)
      expect(await second.stillHeld()).toBe(true)
    })
  })

  test('lock() waits until the lock is free', async () => {
    await mysql.withDatabase(async ({ options, onDispose }) => {
      const first = createMutex({ getOptions: () => options, name: 'scheduling-tick' })
      const second = createMutex({
        getOptions: () => options,
        name: 'scheduling-tick',
        retryEvery: Duration.ofMiliseconds(50),
      })
      onDispose(() => first.unlock())
      onDispose(() => second.unlock())
      let locked = false

      await first.lock()
      const waiting = second.lock().then(() => (locked = true))

      await setTimeout(300)
      expect(locked).toBe(false)

      await first.unlock()
      await waiting
      expect(locked).toBe(true)
    })
  })

  test('the lock is released when the connection of its holder dies', async () => {
    await mysql.withDatabase(async ({ pool, options, onDispose }) => {
      const first = createMutex({ getOptions: () => options, name: 'scheduling-tick' })
      const second = createMutex({ getOptions: () => options, name: 'scheduling-tick' })
      onDispose(() => first.unlock())
      onDispose(() => second.unlock())

      await first.lock()
      await pool.query(`KILL CONNECTION ${Number(await holderOf(pool, 'scheduling-tick'))}`)

      await waitUntil(async () => (await holderOf(pool, 'scheduling-tick')) === null)
      expect(await first.stillHeld()).toBe(false)
      expect(await second.tryLock()).toBe(true)
    })
  })

  test('locks of different names are independent', async () => {
    await mysql.withDatabase(async ({ options, onDispose }) => {
      const tick = createMutex({ getOptions: () => options, name: 'scheduling-tick' })
      const report = createMutex({ getOptions: () => options, name: 'monthly-report' })
      onDispose(() => tick.unlock())
      onDispose(() => report.unlock())

      expect(await tick.tryLock()).toBe(true)
      expect(await report.tryLock()).toBe(true)
    })
  })
})
