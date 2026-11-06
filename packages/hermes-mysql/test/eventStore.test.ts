import {
  createCommandHandler,
  defineHermesProjection,
  defineHermesReaction,
  Duration,
  type HermesProjection,
  type RecordedEvent,
  VersionConflictError,
} from '@chassisjs/hermes'
import { afterAll, beforeAll, describe, expect, jest, test } from '@jest/globals'
import { type Pool, type PoolConnection, type RowDataPacket } from 'mysql2/promise'
import { setTimeout } from 'node:timers/promises'
import {
  createEventStore,
  createEventStoreConsumer,
  createMutex,
  createProjectionConsumer,
  createReactionConsumer,
  type EventStoreTransaction,
  fromInlineProjection,
  type HermesEventEnvelope,
  migrate,
  projectionTables,
} from '../src/index.js'
import { changedStreamsQuery } from '../src/eventStoreSql.js'
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

/** The number in the column `n` of the first row, 0 when there is no row (e.g. a checkpoint not created yet). */
const count = async (pool: Pool, sql: string, params: unknown[] = []) =>
  Number((await select<{ n: string | number }>(pool, sql, params))[0]?.n ?? 0)

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
  await migrate(pool, { eventStore: true })

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
  test('the event store is opt-in: its own track of migrations, after the outbox', async () => {
    await mysql.withDatabase(async ({ pool }) => {
      const tables = async () =>
        (await select<Record<string, string>>(pool, 'SHOW TABLES')).map((row) => Object.values(row)[0]).sort()

      await migrate(pool)
      expect(await tables()).toEqual(['hermes_migrations', 'hermes_outbox', 'hermes_outbox_partition'])

      // the result lists the versions of the outbox, as before; the event store has its own table of versions
      expect(await migrate(pool, { eventStore: true })).toEqual([])
      expect(await tables()).toEqual([
        'hermes_dead_letters',
        'hermes_event_store_migrations',
        'hermes_events',
        'hermes_migrations',
        'hermes_outbox',
        'hermes_outbox_partition',
        'hermes_streams',
        'hermes_subscriptions',
      ])
      expect(await select(pool, 'SELECT `version`, `name` FROM `hermes_event_store_migrations`')).toEqual([
        { version: 1, name: 'create the event store' },
        { version: 2, name: 'create the dead letters of the consumers' },
        { version: 3, name: 'drop the shared tables of the projections' },
      ])
      expect(await select(pool, 'SELECT `version` FROM `hermes_migrations`')).toEqual([{ version: 1 }])
    })
  })

  test('instances that start at the same time apply every migration of the event store once', async () => {
    await mysql.withDatabase(async ({ pool }) => {
      await Promise.all([
        migrate(pool, { eventStore: true }),
        migrate(pool, { eventStore: true }),
        migrate(pool, { eventStore: true }),
      ])

      expect(await select(pool, 'SELECT `version` FROM `hermes_event_store_migrations`')).toEqual([
        { version: 1 },
        { version: 2 },
        { version: 3 },
      ])
      expect(await select(pool, 'SELECT `version` FROM `hermes_migrations`')).toEqual([{ version: 1 }])
    })
  })

  test('a consumer of the event store runs the migrations of the event store on start', async () => {
    await mysql.withDatabase(async ({ pool, options }) => {
      const stop = await createEventStoreConsumer<SchedulingEvent>({
        getOptions: () => options,
        consumerName: 'relay',
        publish: () => {},
      }).start()
      await stop()

      expect(await count(pool, 'SELECT COUNT(*) AS n FROM `hermes_event_store_migrations`')).toBe(3)
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
      // a conflict, not ER_DUP_ENTRY from the INSERT into hermes_streams
      results
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .forEach(({ reason }) => expect(reason).toBeInstanceOf(VersionConflictError))
      expect((await eventStore.readStream('task-1')).currentVersion).toBe(1n)
    })
  })

  test.each([
    { name: 'the current version + 1', exists: true, expectedVersion: 3n },
    { name: 'an older version', exists: true, expectedVersion: 1n },
    { name: '`no_stream`', exists: true, expectedVersion: 'no_stream' as const },
    { name: 'a version above 0', exists: false, expectedVersion: 1n },
    { name: '`stream_exists`', exists: false, expectedVersion: 'stream_exists' as const },
  ])('a rejected append changes nothing: $name', async ({ exists, expectedVersion }) => {
    await mysql.withDatabase(async ({ pool }) => {
      const eventStore = await setUp(pool)

      if (exists) {
        await eventStore.appendToStream<SchedulingEvent>('task-1', [scheduled('o-1', FUTURE), note('b')])
      }

      const before = await eventStore.readStream('task-1')
      const projection = await eventStore.readProjection(occurrences, 'task-1')

      await expect(
        eventStore.appendToStream<SchedulingEvent>('task-1', [completed('o-1')], { expectedVersion }),
      ).rejects.toBeInstanceOf(VersionConflictError)

      expect(await eventStore.readStream('task-1')).toEqual(before)
      expect(await eventStore.readProjection(occurrences, 'task-1')).toEqual(projection)
    })
  })

  test.each([
    { name: '`any`', expectedVersion: 'any' as const },
    { name: 'the default', expectedVersion: undefined },
    { name: '`stream_exists`', expectedVersion: 'stream_exists' as const },
  ])('concurrent appends with $name all succeed, with positions without gaps', async ({ expectedVersion }) => {
    await mysql.withDatabase(async ({ pool }) => {
      const eventStore = await setUp(pool)
      await eventStore.appendToStream<SchedulingEvent>('task-1', [note('first')])

      const results = await Promise.allSettled(
        Array.from({ length: 20 }, (_, i) =>
          eventStore.appendToStream<SchedulingEvent>('task-1', [note(`${i}`), note(`${i}'`)], { expectedVersion }),
        ),
      )

      expect(results.filter(({ status }) => status === 'rejected')).toEqual([])

      const { events, currentVersion } = await eventStore.readStream<SchedulingEvent>('task-1')

      expect(currentVersion).toBe(41n)
      expect(events.map(({ streamPosition }) => streamPosition)).toEqual(
        Array.from({ length: 41 }, (_, i) => BigInt(i + 1)),
      )
      // the two events of one append stay next to each other
      for (let i = 1; i < events.length; i += 2) {
        expect(`${(events[i].data as { text: string }).text}'`).toBe((events[i + 1].data as { text: string }).text)
      }
    })
  })

  test('other streams do not make a missing stream exist', async () => {
    await mysql.withDatabase(async ({ pool }) => {
      const eventStore = await setUp(pool)

      await eventStore.appendToStream<SchedulingEvent>('task-1', [note('a')])

      expect((await eventStore.readStream('task-2')).streamExists).toBe(false)
    })
  })

  test('appends to many streams in one transaction of the application commit or roll back together', async () => {
    await mysql.withDatabase(async ({ pool }) => {
      const eventStore = await setUp(pool)
      await eventStore.appendToStream<SchedulingEvent>('task-2', [note('a')])

      await expect(
        withTransaction(pool, async (tx) => {
          await eventStore.appendToStream<SchedulingEvent>('task-1', [note('b')], { tx })
          await eventStore.appendToStream<SchedulingEvent>('task-2', [note('c')], { tx, expectedVersion: 0n })
        }),
      ).rejects.toBeInstanceOf(VersionConflictError)

      expect((await eventStore.readStream('task-1')).streamExists).toBe(false)
      expect((await eventStore.readStream('task-2')).currentVersion).toBe(1n)

      await withTransaction(pool, async (tx) => {
        await eventStore.appendToStream<SchedulingEvent>('task-1', [note('b')], { tx })
        await eventStore.appendToStream<SchedulingEvent>('task-2', [note('c')], { tx, expectedVersion: 1n })
      })

      expect((await eventStore.readStream('task-1')).currentVersion).toBe(1n)
      expect((await eventStore.readStream('task-2')).currentVersion).toBe(2n)
    })
  })

  test('a conflict leaves the transaction of the application usable, with nothing of the rejected append', async () => {
    await mysql.withDatabase(async ({ pool }) => {
      const eventStore = await setUp(pool)
      await eventStore.appendToStream<SchedulingEvent>('task-2', [scheduled('o-2', FUTURE)])

      await withTransaction(pool, async (tx) => {
        await eventStore.appendToStream<SchedulingEvent>('task-1', [scheduled('o-1', FUTURE)], { tx })
        await expect(
          eventStore.appendToStream<SchedulingEvent>('task-2', [completed('o-2'), note('x')], {
            tx,
            expectedVersion: 0n,
          }),
        ).rejects.toBeInstanceOf(VersionConflictError)
        // the application handles the conflict and commits the rest
      })

      expect((await eventStore.readStream('task-1')).currentVersion).toBe(1n)
      expect(await eventStore.readProjection(occurrences, 'task-1')).toMatchObject({ version: 1n })
      expect(await eventStore.readStream('task-2')).toMatchObject({ currentVersion: 1n })
      expect(await count(pool, 'SELECT COUNT(*) AS n FROM `hermes_events` WHERE `stream_id` = ?', ['task-2'])).toBe(1)
      expect(await select(pool, 'SELECT `version` FROM `hermes_streams` WHERE `stream_id` = ?', ['task-2'])).toEqual([
        { version: '1' },
      ])
      expect(await eventStore.readProjection(occurrences, 'task-2')).toMatchObject({
        data: { status: 'scheduled' },
        version: 1n,
      })
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

  test('an inline projection that throws rolls back the events and the document', async () => {
    await mysql.withDatabase(async ({ pool }) => {
      await migrate(pool, { eventStore: true })
      const strict = defineHermesProjection<{ texts: string[] }, SchedulingEvent>()
        .ofName('strict')
        .ofDocumentType()
        .ofEvents('NoteAdded')
        .ofInitialState(() => ({ texts: [] }))
        .ofEvolve((state, event) => {
          if (event.data.text === 'boom') {
            throw new Error('evolve failed')
          }

          return { texts: [...state.texts, event.data.text] }
        })
        .inline()
        .done()
      const eventStore = createEventStore(pool, { projections: [strict] })

      await eventStore.appendToStream<SchedulingEvent>('task-1', [note('a')])
      await expect(eventStore.appendToStream<SchedulingEvent>('task-1', [note('b'), note('boom')])).rejects.toThrow(
        'evolve failed',
      )

      expect((await eventStore.readStream('task-1')).currentVersion).toBe(1n)
      expect(await eventStore.readProjection(strict, 'task-1')).toEqual({ data: { texts: ['a'] }, version: 1n })
    })
  })

  test('the names of the projections are unique', async () => {
    await mysql.withDatabase(async ({ pool }) => {
      await migrate(pool, { eventStore: true })

      expect(() => createEventStore(pool, { projections: [occurrences, occurrences] })).toThrow()
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
        `UPDATE \`${projectionTables(occurrences).documents}\` SET \`data\` = JSON_SET(\`data\`, '$.dueAt', ?) WHERE \`id\` = ?`,
        [PAST, 'task-1'],
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

      // Due at NOW, scheduled before it: the occurrence stays scheduled until the tick.
      await handle('task-1', schedule('o-1', NOW, PAST))
      expect(await eventStore.readProjection(occurrences, 'task-1')).toMatchObject({ data: { status: 'scheduled' } })

      const [tickResult, ...completions] = await Promise.allSettled([
        handle('task-1', tick(NOW)),
        ...Array.from({ length: 5 }, () => handle('task-1', complete('o-1'))),
      ])

      expect(completions.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
      completions
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .forEach(({ reason }) => expect(reason).toBeInstanceOf(NoOpenOccurrenceError))
      // the tick either got there first, or saw the completion and emitted nothing
      expect(tickResult.status).toBe('fulfilled')

      const types = (await eventStore.readStream<SchedulingEvent>('task-1')).events.map(({ type }) => type)

      expect(types.filter((type) => type === 'TaskCompleted')).toHaveLength(1)
      expect(types.filter((type) => type === 'OccurrenceBecameDueNow').length).toBeLessThanOrEqual(1)
      if (types.includes('OccurrenceBecameDueNow')) {
        expect(types.indexOf('OccurrenceBecameDueNow')).toBeLessThan(types.indexOf('TaskCompleted'))
      }
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
      // disposed first (in reverse order), so stop() does not wait for the blocked publish when the test fails
      onDispose(async () => unblock())

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

  test('the streams of a dead instance are taken over when its lease expires', async () => {
    await mysql.withDatabase(async ({ pool, options, onDispose }) => {
      const eventStore = await setUp(pool)
      const published: HermesEventEnvelope<SchedulingEvent>[] = []

      await eventStore.appendToStream<SchedulingEvent>('task-1', [note('a'), note('b')])
      // A claim of an instance that died: nobody renews it. A live instance renews its claims while it publishes and
      // stop() releases them, so only a hand-made claim makes an instance "die".
      //
      // Schema decision pinned here: unlike the outbox (hermes_outbox_partition), the claim lives in the same row as
      // the checkpoint, one row of hermes_subscriptions per (consumer, stream).
      await pool.query(
        'INSERT INTO `hermes_subscriptions` (`consumer_name`, `stream_id`, `version`, `owner`, `lease_until`) ' +
          'VALUES (?, ?, 0, ?, NOW(6) + INTERVAL 3 SECOND)',
        ['relay', 'task-1', 'dead-instance'],
      )

      onDispose(
        await createEventStoreConsumer<SchedulingEvent>({
          getOptions: () => options,
          consumerName: 'relay',
          publish: (event) => void published.push(event),
          pollInterval: Duration.ofMiliseconds(50),
        }).start(),
      )

      await setTimeout(1_000)
      const [{ leased }] = await select<{ leased: number }>(
        pool,
        'SELECT `lease_until` > NOW(6) AS leased FROM `hermes_subscriptions` WHERE `consumer_name` = ? AND `stream_id` = ?',
        ['relay', 'task-1'],
      )
      // checked only while the dead claim still holds, so a slow start does not make the test flaky
      if (Number(leased) === 1) {
        expect(published).toEqual([])
      }

      await waitUntil(() => published.length === 2)
      expect(positionsBy(published, 'task-1')).toEqual([1n, 2n])
    })
  })

  test('a new consumer can start from the end of the streams', async () => {
    await mysql.withDatabase(async ({ pool, options, onDispose }) => {
      const eventStore = await setUp(pool)
      const published: HermesEventEnvelope<SchedulingEvent>[] = []

      await eventStore.appendToStream<SchedulingEvent>('task-1', [note('old'), note('old')])

      onDispose(
        await createEventStoreConsumer<SchedulingEvent>({
          getOptions: () => options,
          consumerName: 'late',
          publish: (event) => void published.push(event),
          pollInterval: Duration.ofMiliseconds(50),
          startFrom: 'end',
        }).start(),
      )

      await setTimeout(300)
      expect(published).toEqual([])

      await eventStore.appendToStream<SchedulingEvent>('task-1', [note('new')])
      await eventStore.appendToStream<SchedulingEvent>('task-2', [note('new')])

      await waitUntil(() => published.length === 2)
      expect(published.map(({ streamId, streamPosition }) => [streamId, streamPosition])).toEqual(
        expect.arrayContaining([
          ['task-1', 3n],
          ['task-2', 1n],
        ]),
      )
    })
  })

  // `startFrom` applies only to a consumer without a checkpoint; how 'end' is stored (a version per stream or a global
  // marker) is up to the implementation.
  test("a restarted consumer with startFrom: 'end' resumes from its checkpoint and skips nothing", async () => {
    await mysql.withDatabase(async ({ pool, options }) => {
      const eventStore = await setUp(pool)
      const published: HermesEventEnvelope<SchedulingEvent>[] = []
      const create = () =>
        createEventStoreConsumer<SchedulingEvent>({
          getOptions: () => options,
          consumerName: 'late',
          publish: (event) => void published.push(event),
          pollInterval: Duration.ofMiliseconds(50),
          startFrom: 'end',
        })

      await eventStore.appendToStream<SchedulingEvent>('task-1', [note('old')])

      let stop = await create().start()
      await eventStore.appendToStream<SchedulingEvent>('task-1', [note('new')])
      await waitUntil(() => published.length === 1)
      await stop()

      // appended while the consumer is down
      await eventStore.appendToStream<SchedulingEvent>('task-1', [note('missed')])
      await eventStore.appendToStream<SchedulingEvent>('task-2', [note('missed')])

      stop = await create().start()
      await waitUntil(() => published.length === 3)
      await stop()

      expect(published.map(({ streamId, streamPosition }) => [streamId, streamPosition])).toEqual(
        expect.arrayContaining([
          ['task-1', 2n],
          ['task-1', 3n],
          ['task-2', 1n],
        ]),
      )
    })
  })

  test('by default a new consumer starts from the beginning of the streams', async () => {
    await mysql.withDatabase(async ({ pool, options, onDispose }) => {
      const eventStore = await setUp(pool)
      const published: HermesEventEnvelope<SchedulingEvent>[] = []

      await eventStore.appendToStream<SchedulingEvent>('task-1', [note('a'), note('b')])

      onDispose(
        await createEventStoreConsumer<SchedulingEvent>({
          getOptions: () => options,
          consumerName: 'new',
          publish: (event) => void published.push(event),
          pollInterval: Duration.ofMiliseconds(50),
        }).start(),
      )

      await waitUntil(() => published.length === 2)
    })
  })

  // A smoke test of the cost of finding the streams with new events, not a benchmark.
  test('finds a new event fast among many streams that have nothing new', async () => {
    await mysql.withDatabase(async ({ pool, options, onDispose }) => {
      const eventStore = await setUp(pool)
      const streams = 5_000
      let published = 0

      for (let i = 0; i < streams; i += 100) {
        await Promise.all(
          Array.from({ length: 100 }, (_, j) =>
            eventStore.appendToStream<SchedulingEvent>(`task-${i + j}`, [note('a')]),
          ),
        )
      }

      onDispose(
        await createEventStoreConsumer<SchedulingEvent>({
          getOptions: () => options,
          consumerName: 'relay',
          publish: () => void published++,
          pollInterval: Duration.ofMiliseconds(50),
          maxPartitions: 50,
        }).start(),
      )
      await waitUntil(() => published === streams, Duration.ofMinutes(2))

      const appendedAt = Date.now()
      await eventStore.appendToStream<SchedulingEvent>('task-42', [note('b')])
      await waitUntil(() => published === streams + 1)

      expect(Date.now() - appendedAt).toBeLessThan(Duration.ofSeconds(1).ms)
    })
  })

  // The smoke test above cannot tell a full scan of 5,000 rows from an index; the plan can.
  test('the query that finds the streams with new events uses an index', async () => {
    await mysql.withDatabase(async ({ pool }) => {
      const eventStore = await setUp(pool)

      for (let i = 0; i < 200; i += 50) {
        await Promise.all(
          Array.from({ length: 50 }, (_, j) =>
            eventStore.appendToStream<SchedulingEvent>(`task-${i + j}`, [note('a')]),
          ),
        )
      }
      await pool.query('ANALYZE TABLE `hermes_streams`, `hermes_subscriptions`')

      const { text, params } = changedStreamsQuery({ consumerName: 'relay', limit: 10 })
      const plan = await select<{ table: string; type: string; key: string | null; Extra: string | null }>(
        pool,
        `EXPLAIN ${text}`,
        params,
      )

      for (const row of plan.filter(({ table }) => table === 'hermes_subscriptions')) {
        expect(row.type).not.toBe('ALL')
        expect(row.key).not.toBeNull()
      }
      plan.forEach(({ Extra }) => expect(Extra ?? '').not.toContain('Using filesort'))
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

      const onFailedPublish = jest.fn()

      onDispose(
        await createProjectionConsumer({
          getOptions: () => options,
          projection: flaky,
          pollInterval: Duration.ofMiliseconds(50),
          retry: () => Duration.ofSeconds(2),
          onFailedPublish,
        }).start(),
      )

      await eventStore.appendToStream<SchedulingEvent>('task-1', [note('a'), note('b'), note('c')])

      // before the retry: 'a' is applied, 'b' is not, and the version stops at 'a'
      await waitUntil(() => onFailedPublish.mock.calls.length === 1)
      expect(await eventStore.readProjection(flaky, 'task-1')).toEqual({ data: { texts: ['a'] }, version: 1n })
      expect(
        await count(
          pool,
          'SELECT `version` AS n FROM `hermes_subscriptions` WHERE `consumer_name` = ? AND `stream_id` = ?',
          ['projection:flaky', 'task-1'],
        ),
      ).toBe(1)

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

  test('a document fed by many streams loses no update with many instances and lanes', async () => {
    await mysql.withDatabase(async ({ pool, options, onDispose }) => {
      const eventStore = await setUp(pool)

      for (let i = 0; i < 2; i++) {
        onDispose(
          await createProjectionConsumer({
            getOptions: () => options,
            projection: eventCounter,
            pollInterval: Duration.ofMiliseconds(20),
            maxPartitions: 10,
          }).start(),
        )
      }

      await Promise.all(
        Array.from({ length: 20 }, async (_, stream) => {
          for (let i = 0; i < 10; i++) {
            await eventStore.appendToStream<SchedulingEvent>(`task-${stream}`, [note(`${i}`)])
          }
        }),
      )

      await waitUntil(async () => (await eventStore.readProjection(eventCounter, 'all'))?.data.count === 200)
      await setTimeout(300)
      expect((await eventStore.readProjection(eventCounter, 'all'))?.data.count).toBe(200)
    })
  })

  // A replay: a checkpoint fixed by hand, a restored backup, or a future "rebuild projection" command.
  test('a single-stream document skips the events it already applied when the checkpoint goes back', async () => {
    await mysql.withDatabase(async ({ pool, options, onDispose }) => {
      const eventStore = await setUp(pool)
      const notes = defineHermesProjection<{ texts: string[] }, SchedulingEvent>()
        .ofName('notes')
        .ofDocumentType()
        .ofEvents('NoteAdded')
        .ofInitialState(() => ({ texts: [] }))
        .ofEvolve((state, event) => ({ texts: [...state.texts, event.data.text] }))
        .async()
        .done()
      const checkpoint = () =>
        count(pool, 'SELECT `version` AS n FROM `hermes_subscriptions` WHERE `consumer_name` = ? AND `stream_id` = ?', [
          'projection:notes',
          'task-1',
        ])

      onDispose(
        await createProjectionConsumer({
          getOptions: () => options,
          projection: notes,
          pollInterval: Duration.ofMiliseconds(50),
        }).start(),
      )

      await eventStore.appendToStream<SchedulingEvent>('task-1', [note('a'), note('b'), note('c')])
      await waitUntil(async () => (await checkpoint()) === 3)

      await pool.query(
        'UPDATE `hermes_subscriptions` SET `version` = 0 WHERE `consumer_name` = ? AND `stream_id` = ?',
        ['projection:notes', 'task-1'],
      )
      await waitUntil(async () => (await checkpoint()) === 3)

      expect(await eventStore.readProjection(notes, 'task-1')).toEqual({
        data: { texts: ['a', 'b', 'c'] },
        version: 3n,
      })
    })
  })

  // Every document keeps the version of every stream that fed it, in the _versions table of the projection.
  test('a multi-stream document is not changed by a replay of the events it already applied', async () => {
    await mysql.withDatabase(async ({ pool, options, onDispose }) => {
      const eventStore = await setUp(pool)
      const checkpoints = () =>
        count(pool, 'SELECT SUM(`version`) AS n FROM `hermes_subscriptions` WHERE `consumer_name` = ?', [
          'projection:eventCounter',
        ])

      onDispose(
        await createProjectionConsumer({
          getOptions: () => options,
          projection: eventCounter,
          pollInterval: Duration.ofMiliseconds(50),
        }).start(),
      )

      await eventStore.appendToStream<SchedulingEvent>('task-1', [note('a'), note('b')])
      await eventStore.appendToStream<SchedulingEvent>('task-2', [note('c')])
      await waitUntil(async () => (await checkpoints()) === 3)

      expect(
        await select(
          pool,
          `SELECT \`stream_id\`, \`version\` FROM \`${projectionTables(eventCounter).versions}\` WHERE \`id\` = ? ORDER BY 1`,
          ['all'],
        ),
      ).toEqual([
        { stream_id: 'task-1', version: '2' },
        { stream_id: 'task-2', version: '1' },
      ])

      await pool.query('UPDATE `hermes_subscriptions` SET `version` = 0 WHERE `consumer_name` = ?', [
        'projection:eventCounter',
      ])
      await waitUntil(async () => (await checkpoints()) === 3)

      // one `version` means nothing for a document fed by many streams
      expect(await eventStore.readProjection(eventCounter, 'all')).toEqual({ data: { count: 3 }, version: null })
    })
  })

  test('an evolve that returns null deletes the document, and a replay does not bring it back', async () => {
    await mysql.withDatabase(async ({ pool, options, onDispose }) => {
      const eventStore = await setUp(pool)
      const openOccurrences = defineHermesProjection<Occurrence | null, SchedulingEvent>()
        .ofName('openOccurrences')
        .ofDocumentType()
        .ofEvents('OccurrenceScheduled', 'OccurrenceBecameDueNow', 'TaskCompleted')
        .ofInitialState(() => null)
        .ofEvolve((state, event) =>
          event.type === 'TaskCompleted' ? null : scheduling.evolve(state ?? scheduling.initialState(), event),
        )
        .async()
        .done()
      const checkpoint = () =>
        count(pool, 'SELECT `version` AS n FROM `hermes_subscriptions` WHERE `consumer_name` = ? AND `stream_id` = ?', [
          'projection:openOccurrences',
          'task-1',
        ])

      onDispose(
        await createProjectionConsumer({
          getOptions: () => options,
          projection: openOccurrences,
          pollInterval: Duration.ofMiliseconds(50),
        }).start(),
      )

      await eventStore.appendToStream<SchedulingEvent>('task-1', [scheduled('o-1', FUTURE)])
      await waitUntil(async () => (await eventStore.readProjection(openOccurrences, 'task-1')) !== null)

      await eventStore.appendToStream<SchedulingEvent>('task-1', [completed('o-1')])
      await waitUntil(async () => (await checkpoint()) === 2)

      expect(await eventStore.readProjection(openOccurrences, 'task-1')).toBeNull()
      expect(
        await count(
          pool,
          `SELECT COUNT(*) AS n FROM \`${projectionTables(openOccurrences).documents}\` WHERE \`data\` IS NOT NULL`,
        ),
      ).toBe(0)

      await pool.query('UPDATE `hermes_subscriptions` SET `version` = 0 WHERE `consumer_name` = ?', [
        'projection:openOccurrences',
      ])
      await waitUntil(async () => (await checkpoint()) === 2)

      expect(await eventStore.readProjection(openOccurrences, 'task-1')).toBeNull()
    })
  })
})

describe('Reactions', () => {
  type Billing = { type: 'InvoiceIssued'; data: { occurrenceId: string } }

  const reactionCheckpoint = (pool: Pool, name: string, streamId: string) =>
    count(pool, 'SELECT `version` AS n FROM `hermes_subscriptions` WHERE `consumer_name` = ? AND `stream_id` = ?', [
      `reaction:${name}`,
      streamId,
    ])

  test('reacts to the handled events by appending to another stream in the same transaction', async () => {
    await mysql.withDatabase(async ({ pool, options, onDispose }) => {
      const eventStore = await setUp(pool)
      const handled: string[] = []
      const issueInvoice = defineHermesReaction<SchedulingEvent, EventStoreTransaction>()
        .ofName('billing:issue-invoice')
        .ofEvents('TaskCompleted')
        .ofHandler(async (event, { tx }) => {
          handled.push(`${event.streamId}:${event.streamPosition}`)
          await eventStore.appendToStream<Billing>(
            `invoice-${event.data.occurrenceId}`,
            [{ type: 'InvoiceIssued', data: { occurrenceId: event.data.occurrenceId } }],
            { expectedVersion: 'no_stream', tx },
          )
        })
        .done()

      onDispose(
        await createReactionConsumer({
          getOptions: () => options,
          reaction: issueInvoice,
          pollInterval: Duration.ofMiliseconds(50),
        }).start(),
      )

      await eventStore.appendToStream<SchedulingEvent>('task-1', [
        note('a'),
        scheduled('o-1', FUTURE),
        completed('o-1'),
      ])
      await eventStore.appendToStream<SchedulingEvent>('task-2', [completed('o-2')])

      await waitUntil(async () => (await reactionCheckpoint(pool, 'billing:issue-invoice', 'task-1')) === 3)
      await waitUntil(async () => (await reactionCheckpoint(pool, 'billing:issue-invoice', 'task-2')) === 1)

      expect(handled.sort()).toEqual(['task-1:3', 'task-2:1'])
      expect((await eventStore.readStream<Billing>('invoice-o-1')).events.map(({ type }) => type)).toEqual([
        'InvoiceIssued',
      ])
      expect((await eventStore.readStream<Billing>('invoice-o-2')).currentVersion).toBe(1n)
    })
  })

  test('a failing handler rolls back what it did in the transaction, and is retried', async () => {
    await mysql.withDatabase(async ({ pool, options, onDispose }) => {
      const eventStore = await setUp(pool)
      let failures = 1
      const onFailedPublish = jest.fn()
      const issueInvoice = defineHermesReaction<SchedulingEvent, EventStoreTransaction>()
        .ofName('billing:flaky')
        .ofEvents('TaskCompleted')
        .ofHandler(async (event, { tx }) => {
          await eventStore.appendToStream<Billing>(
            `invoice-${event.data.occurrenceId}`,
            [{ type: 'InvoiceIssued', data: { occurrenceId: event.data.occurrenceId } }],
            { tx },
          )

          if (failures > 0) {
            failures--
            throw new Error('the reaction failed')
          }
        })
        .done()

      onDispose(
        await createReactionConsumer({
          getOptions: () => options,
          reaction: issueInvoice,
          pollInterval: Duration.ofMiliseconds(50),
          retry: () => Duration.ofSeconds(1),
          onFailedPublish,
        }).start(),
      )

      await eventStore.appendToStream<SchedulingEvent>('task-1', [completed('o-1'), note('after')])

      // after the failure: no invoice, and the events after it in the stream wait
      await waitUntil(() => onFailedPublish.mock.calls.length === 1)
      expect(await eventStore.readStreamVersion('invoice-o-1')).toBe(0n)
      expect(await reactionCheckpoint(pool, 'billing:flaky', 'task-1')).toBe(0)

      await waitUntil(async () => (await reactionCheckpoint(pool, 'billing:flaky', 'task-1')) === 2)
      expect(await eventStore.readStreamVersion('invoice-o-1')).toBe(1n)
    })
  })

  test('after a restart, does not react to an event twice', async () => {
    await mysql.withDatabase(async ({ pool, options }) => {
      const eventStore = await setUp(pool)
      const handled: bigint[] = []
      const counting = defineHermesReaction<SchedulingEvent, EventStoreTransaction>()
        .ofName('counting')
        .ofEvents('NoteAdded')
        .ofHandler((event) => {
          handled.push(event.streamPosition)
        })
        .done()
      const create = () =>
        createReactionConsumer({
          getOptions: () => options,
          reaction: counting,
          pollInterval: Duration.ofMiliseconds(50),
        })

      let stop = await create().start()
      await eventStore.appendToStream<SchedulingEvent>('task-1', [note('a'), note('b')])
      await waitUntil(() => handled.length === 2)
      await stop()

      stop = await create().start()
      await eventStore.appendToStream<SchedulingEvent>('task-1', [note('c')])
      await waitUntil(() => handled.length === 3)
      await setTimeout(300)
      await stop()

      expect(handled).toEqual([1n, 2n, 3n])
    })
  })

  const failingReaction = (name: string, eventStore: Awaited<ReturnType<typeof setUp>>, fails: () => boolean) =>
    defineHermesReaction<SchedulingEvent, EventStoreTransaction>()
      .ofName(name)
      .ofEvents('TaskCompleted')
      .ofHandler(async (event, { tx }) => {
        await eventStore.appendToStream<Billing>(
          `invoice-${event.data.occurrenceId}`,
          [{ type: 'InvoiceIssued', data: { occurrenceId: event.data.occurrenceId } }],
          { tx },
        )

        if (fails()) {
          throw new Error(`cannot invoice ${event.data.occurrenceId}`)
        }
      })
      .done()

  const deadLetters = (pool: Pool) =>
    select<Record<string, unknown>>(
      pool,
      'SELECT `consumer_name`, `stream_id`, `stream_position`, `event_id`, `event_type`, `attempts`, `error` FROM `hermes_dead_letters` ORDER BY 2, 3',
    )

  test('after maxAttempts, writes the event to the dead letters, calls onGiveUp in the same transaction and goes on', async () => {
    await mysql.withDatabase(async ({ pool, options, onDispose }) => {
      const eventStore = await setUp(pool)
      const onGiveUp = jest.fn(async (event: RecordedEvent, error: unknown, { tx }: { tx: PoolConnection }) => {
        await tx.query("UPDATE `hermes_dead_letters` SET `error` = CONCAT('handled: ', `error`) WHERE `event_id` = ?", [
          event.eventId,
        ])
      })
      const onFailedPublish = jest.fn()

      onDispose(
        await createReactionConsumer({
          getOptions: () => options,
          reaction: failingReaction('billing:broken', eventStore, () => true),
          pollInterval: Duration.ofMiliseconds(50),
          retry: () => Duration.ofMiliseconds(50),
          maxAttempts: 3,
          onGiveUp,
          onFailedPublish,
        }).start(),
      )

      await eventStore.appendToStream<SchedulingEvent>('task-1', [completed('o-1'), note('after')])

      await waitUntil(async () => (await reactionCheckpoint(pool, 'billing:broken', 'task-1')) === 2)

      expect(onFailedPublish).toHaveBeenCalledTimes(2)
      expect(onGiveUp).toHaveBeenCalledTimes(1)
      expect((onGiveUp.mock.calls[0][1] as Error).message).toBe('cannot invoice o-1')
      expect(await eventStore.readStreamVersion('invoice-o-1')).toBe(0n)
      expect(await deadLetters(pool)).toEqual([
        {
          consumer_name: 'reaction:billing:broken',
          stream_id: 'task-1',
          stream_position: '1',
          event_id: expect.any(String),
          event_type: 'TaskCompleted',
          attempts: 3,
          error: expect.stringMatching(/^handled: Error: cannot invoice o-1/),
        },
      ])
      expect(
        await count(
          pool,
          'SELECT `attempts` AS n FROM `hermes_subscriptions` WHERE `consumer_name` = ? AND `stream_id` = ?',
          ['reaction:billing:broken', 'task-1'],
        ),
      ).toBe(0)
    })
  })

  test('without onGiveUp, a dead letter is written and the stream goes on', async () => {
    await mysql.withDatabase(async ({ pool, options, onDispose }) => {
      const eventStore = await setUp(pool)

      onDispose(
        await createReactionConsumer({
          getOptions: () => options,
          reaction: failingReaction('billing:broken', eventStore, () => true),
          pollInterval: Duration.ofMiliseconds(50),
          retry: () => Duration.ofMiliseconds(50),
          maxAttempts: 1,
        }).start(),
      )

      await eventStore.appendToStream<SchedulingEvent>('task-1', [completed('o-1')])
      await eventStore.appendToStream<SchedulingEvent>('task-2', [completed('o-2')])

      await waitUntil(async () => (await count(pool, 'SELECT COUNT(*) AS n FROM `hermes_dead_letters`')) === 2)
      expect((await deadLetters(pool)).map((row) => [row.stream_id, row.attempts])).toEqual([
        ['task-1', 1],
        ['task-2', 1],
      ])
    })
  })

  test('onGiveUp that throws keeps the stream waiting, and the handler is retried until it succeeds', async () => {
    await mysql.withDatabase(async ({ pool, options, onDispose }) => {
      const eventStore = await setUp(pool)
      let fixed = false
      const onGiveUp = jest.fn(() => {
        throw new Error('wait for a fix')
      })

      onDispose(
        await createReactionConsumer({
          getOptions: () => options,
          reaction: failingReaction('billing:until-fixed', eventStore, () => !fixed),
          pollInterval: Duration.ofMiliseconds(50),
          retry: () => Duration.ofMiliseconds(50),
          maxAttempts: 2,
          onGiveUp,
        }).start(),
      )

      await eventStore.appendToStream<SchedulingEvent>('task-1', [completed('o-1'), note('after')])

      await waitUntil(() => onGiveUp.mock.calls.length >= 2)
      expect(await reactionCheckpoint(pool, 'billing:until-fixed', 'task-1')).toBe(0)
      expect(await count(pool, 'SELECT COUNT(*) AS n FROM `hermes_dead_letters`')).toBe(0)

      fixed = true

      await waitUntil(async () => (await reactionCheckpoint(pool, 'billing:until-fixed', 'task-1')) === 2)
      expect(await eventStore.readStreamVersion('invoice-o-1')).toBe(1n)
      expect(await count(pool, 'SELECT COUNT(*) AS n FROM `hermes_dead_letters`')).toBe(0)
    })
  })

  test('maxAttempts has to be a positive integer, and onGiveUp needs it', () => {
    const reaction = defineHermesReaction<SchedulingEvent>()
      .ofName('r')
      .ofEvents('NoteAdded')
      .ofHandler(() => {})
      .done()

    expect(() => createReactionConsumer({ getOptions: () => ({}), reaction, maxAttempts: 0 })).toThrow(
      'maxAttempts has to be an integer of at least 1.',
    )
    expect(() => createReactionConsumer({ getOptions: () => ({}), reaction, onGiveUp: () => {} })).toThrow(
      'onGiveUp needs maxAttempts.',
    )
  })
})

describe('Projection tables', () => {
  const projectionTablesIn = async (pool: Pool) =>
    (await select<Record<string, string>>(pool, "SHOW TABLES LIKE 'hermes\\_projection\\_%'"))
      .map((row) => Object.values(row)[0])
      .sort()

  test('init() creates the tables of every projection, each its own, and never changes existing ones', async () => {
    await mysql.withDatabase(async ({ pool }) => {
      await migrate(pool, { eventStore: true })
      const eventStore = createEventStore(pool, { projections: [occurrences, eventCounter] })

      expect(await projectionTablesIn(pool)).toEqual([])
      expect(await eventStore.readProjection(occurrences, 'task-1')).toBeNull()

      await eventStore.init()
      await eventStore.init()

      expect(await projectionTablesIn(pool)).toEqual(
        [
          projectionTables(occurrences).documents,
          projectionTables(eventCounter).documents,
          projectionTables(eventCounter).versions,
        ].sort(),
      )
      expect(
        await select(
          pool,
          'SELECT `table_comment` AS comment FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?',
          [projectionTables(occurrences).documents],
        ),
      ).toEqual([{ comment: 'Hermes projection occurrences' }])
    })
  })

  test('the first append creates the tables of the inline projections', async () => {
    await mysql.withDatabase(async ({ pool }) => {
      await migrate(pool, { eventStore: true })
      const eventStore = createEventStore(pool, { projections: [occurrences] })

      await eventStore.appendToStream<SchedulingEvent>('task-1', [scheduled('o-1', FUTURE)])

      expect(await projectionTablesIn(pool)).toEqual([projectionTables(occurrences).documents])
      expect(await count(pool, `SELECT COUNT(*) AS n FROM \`${projectionTables(occurrences).documents}\``)).toBe(1)
    })
  })

  test('after init(), an append in a transaction of the application writes to the tables of the projection', async () => {
    await mysql.withDatabase(async ({ pool }) => {
      await migrate(pool, { eventStore: true })
      const eventStore = createEventStore(pool, { projections: [occurrences] })
      await eventStore.init()

      await withTransaction(pool, async (tx) => {
        await tx.query('SELECT COUNT(*) FROM `hermes_streams`')
        await eventStore.appendToStream<SchedulingEvent>('task-1', [scheduled('o-1', FUTURE)], { tx })
      })

      expect(await eventStore.readProjection(occurrences, 'task-1')).toMatchObject({ version: 1n })
    })
  })

  test('migrate() creates the tables of the projections it is given, and needs eventStore for them', async () => {
    await mysql.withDatabase(async ({ pool }) => {
      await expect(migrate(pool, { projections: [occurrences] })).rejects.toThrow(
        'The tables of the projections need eventStore: true.',
      )

      await migrate(pool, { eventStore: true, projections: [occurrences] })

      expect(await projectionTablesIn(pool)).toEqual([projectionTables(occurrences).documents])
    })
  })

  test('a projection consumer creates the tables of its projection on start, unless migrate is false', async () => {
    await mysql.withDatabase(async ({ pool, options }) => {
      await migrate(pool, { eventStore: true })

      const withoutMigrate = await createProjectionConsumer({
        getOptions: () => options,
        projection: eventCounter,
        migrate: false,
      }).start()
      await withoutMigrate()
      expect(await projectionTablesIn(pool)).toEqual([])

      const stop = await createProjectionConsumer({ getOptions: () => options, projection: eventCounter }).start()
      await stop()
      expect(await projectionTablesIn(pool)).toEqual(
        [projectionTables(eventCounter).documents, projectionTables(eventCounter).versions].sort(),
      )
    })
  })

  test('migration 3 drops the shared tables of the projections and the checkpoints of the async ones', async () => {
    await mysql.withDatabase(async ({ pool }) => {
      await migrate(pool, { eventStore: true })
      await pool.query('DELETE FROM `hermes_event_store_migrations` WHERE `version` = 3')
      await pool.query('CREATE TABLE `hermes_projections` (`name` VARCHAR(250) NOT NULL, PRIMARY KEY (`name`))')
      await pool.query('CREATE TABLE `hermes_projection_versions` (`name` VARCHAR(250) NOT NULL, PRIMARY KEY (`name`))')
      await pool.query(
        "INSERT INTO `hermes_subscriptions` (`consumer_name`, `stream_id`, `version`) VALUES ('projection:x', 'task-1', 3), ('relay', 'task-1', 3)",
      )

      await migrate(pool, { eventStore: true })

      expect(
        await count(
          pool,
          "SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN ('hermes_projections', 'hermes_projection_versions')",
        ),
      ).toBe(0)
      expect(await select(pool, 'SELECT `consumer_name` FROM `hermes_subscriptions`')).toEqual([
        { consumer_name: 'relay' },
      ])
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

  // GET_LOCK is reentrant since MySQL 5.7: a second GET_LOCK needs a second RELEASE_LOCK.
  test('locking twice and unlocking once frees the lock', async () => {
    await mysql.withDatabase(async ({ options, onDispose }) => {
      const first = createMutex({ getOptions: () => options, name: 'scheduling-tick' })
      const second = createMutex({ getOptions: () => options, name: 'scheduling-tick' })
      onDispose(() => first.unlock())
      onDispose(() => second.unlock())

      expect(await first.tryLock()).toBe(true)
      expect(await first.tryLock()).toBe(true)
      await first.lock()
      await first.unlock()

      expect(await first.stillHeld()).toBe(false)
      expect(await second.tryLock()).toBe(true)
    })
  })

  test('unlocking a lock that is not held does nothing', async () => {
    await mysql.withDatabase(async ({ options, onDispose }) => {
      const holder = createMutex({ getOptions: () => options, name: 'scheduling-tick' })
      const other = createMutex({ getOptions: () => options, name: 'scheduling-tick' })
      onDispose(() => holder.unlock())

      await expect(other.unlock()).resolves.toBeUndefined()
      expect(await holder.tryLock()).toBe(true)
      await expect(other.unlock()).resolves.toBeUndefined()
      expect(await holder.stillHeld()).toBe(true)
    })
  })

  test('names longer than the 64 characters of MySQL work and stay distinct', async () => {
    await mysql.withDatabase(async ({ options, onDispose }) => {
      const prefix = 'hermes-relay:'.padEnd(80, 'x')
      const a = createMutex({ getOptions: () => options, name: `${prefix}-a` })
      const b = createMutex({ getOptions: () => options, name: `${prefix}-b` })
      const a2 = createMutex({ getOptions: () => options, name: `${prefix}-a` })
      onDispose(() => a.unlock())
      onDispose(() => b.unlock())

      expect(await a.tryLock()).toBe(true)
      expect(await b.tryLock()).toBe(true)
      expect(await a2.tryLock()).toBe(false)
    })
  })
})

describe('Transactions of the application', () => {
  const inlineCounter = defineHermesProjection<{ count: number }, SchedulingEvent>()
    .ofName('inlineCounter')
    .ofDocumentType()
    .ofEvents('OccurrenceScheduled', 'OccurrenceBecameDueNow', 'TaskCompleted', 'NoteAdded')
    .ofInitialState(() => ({ count: 0 }))
    .ofEvolve((state) => ({ count: state.count + 1 }))
    .ofId(() => 'all')
    .inline()
    .done()

  test('an append whose snapshot is older than the documents of its stream updates them', async () => {
    await mysql.withDatabase(async ({ pool }) => {
      await migrate(pool, { eventStore: true })
      const eventStore = createEventStore(pool, { projections: [occurrences, inlineCounter] })
      // with `tx`, the tables of the projections have to exist before the transaction begins
      await eventStore.init()
      const app = await pool.getConnection()

      try {
        // REPEATABLE READ, with the snapshot taken before the other append commits
        await app.query('START TRANSACTION WITH CONSISTENT SNAPSHOT')
        await eventStore.appendToStream<SchedulingEvent>('task-1', [scheduled('o-1', FUTURE)])

        await expect(eventStore.appendToStream<SchedulingEvent>('task-1', [note('a')], { tx: app })).resolves.toEqual({
          nextVersion: 2n,
          createdNewStream: false,
        })
        await app.commit()
      } finally {
        app.release()
      }

      expect(await eventStore.readProjection(occurrences, 'task-1')).toEqual({
        data: { status: 'scheduled', occurrenceId: 'o-1', dueAt: FUTURE },
        version: 2n,
      })
      expect(await eventStore.readProjection(inlineCounter, 'all')).toMatchObject({ data: { count: 2 } })
    })
  })

  test('a version conflict in a transaction of the application is not retried', async () => {
    await mysql.withDatabase(async ({ pool }) => {
      const eventStore = await setUp(pool)
      const decide = jest.fn(scheduling.decide)
      const handle = createCommandHandler({
        decider: { ...scheduling, decide },
        eventStore,
        loadState: fromInlineProjection(eventStore, occurrences),
        retry: { attempts: 3 },
      })

      await handle('task-1', schedule('o-1', NOW, PAST))
      decide.mockClear()

      const inTransaction = async () => {
        const app = await pool.getConnection()

        try {
          await app.beginTransaction()
          const result = await handle('task-1', complete('o-1'), { tx: app })
          await app.commit()

          return result
        } catch (error) {
          await app.rollback()
          throw error
        } finally {
          app.release()
        }
      }

      const results = await Promise.allSettled([inTransaction(), inTransaction()])

      expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
      results
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .forEach(({ reason }) => expect(reason).toBeInstanceOf(VersionConflictError))
      expect(decide).toHaveBeenCalledTimes(2)
    })
  })
})

describe('A projection added to a running application', () => {
  test('a state-stored decider sees the events appended before the projection existed', async () => {
    await mysql.withDatabase(async ({ pool }) => {
      await migrate(pool, { eventStore: true })
      await createEventStore(pool).appendToStream<SchedulingEvent>('task-1', [scheduled('o-1', PAST)])

      const eventStore = createEventStore(pool, { projections: [occurrences] })
      const handle = createCommandHandler({
        decider: scheduling,
        eventStore,
        loadState: fromInlineProjection(eventStore, occurrences),
      })

      // with an empty state, completing would be rejected: there would be no open occurrence
      const { newEvents, nextVersion } = await handle('task-1', complete('o-1'))

      expect(newEvents.map(({ type }) => type)).toEqual(['TaskCompleted'])
      expect(nextVersion).toBe(2n)
      // the document is built from all the events of the stream
      expect(await eventStore.readProjection(occurrences, 'task-1')).toEqual({
        data: { status: 'completed', occurrenceId: 'o-1', dueAt: PAST },
        version: 2n,
      })
    })
  })
})

describe('Deleted and not yet handled documents', () => {
  test('a decider gets the initial state again after its document was deleted', async () => {
    await mysql.withDatabase(async ({ pool }) => {
      await migrate(pool, { eventStore: true })
      const closing = defineHermesProjection<Occurrence | null, SchedulingEvent>()
        .ofName('closing')
        .ofDocumentType()
        .ofEvents('OccurrenceScheduled', 'OccurrenceBecameDueNow', 'TaskCompleted', 'NoteAdded')
        .ofInitialState(scheduling.initialState)
        .ofEvolve((state, event) =>
          event.type === 'TaskCompleted' ? null : scheduling.evolve(state ?? scheduling.initialState(), event),
        )
        .inline()
        .done()
      const eventStore = createEventStore(pool, { projections: [closing] })
      const decide = jest.fn(scheduling.decide)
      const handle = createCommandHandler({
        decider: { ...scheduling, decide },
        eventStore,
        loadState: fromInlineProjection(
          eventStore,
          closing as unknown as HermesProjection<Occurrence, SchedulingEvent>,
        ),
      })

      await handle('task-1', schedule('o-1', FUTURE))
      await handle('task-1', complete('o-1'))
      expect(await eventStore.readProjection(closing, 'task-1')).toBeNull()

      await expect(handle('task-1', schedule('o-2', FUTURE))).resolves.toMatchObject({ nextVersion: 3n })
      expect(decide.mock.calls[2][1]).toEqual(scheduling.initialState())
    })
  })

  test('a single-stream document records the events it skipped, so the catch-up runs once', async () => {
    await mysql.withDatabase(async ({ pool }) => {
      await migrate(pool, { eventStore: true })
      const completions = defineHermesProjection<{ completed: number }, SchedulingEvent>()
        .ofName('completions')
        .ofDocumentType()
        .ofEvents('TaskCompleted')
        .ofInitialState(() => ({ completed: 0 }))
        .ofEvolve((state) => ({ completed: state.completed + 1 }))
        .inline()
        .done()
      const eventStore = createEventStore(pool, { projections: [completions] })

      for (const text of ['a', 'b', 'c']) {
        await eventStore.appendToStream<SchedulingEvent>('task-1', [note(text)])
      }

      expect(await eventStore.readProjection(completions, 'task-1')).toBeNull()
      expect(
        await select(pool, `SELECT \`version\` FROM \`${projectionTables(completions).documents}\` WHERE \`id\` = ?`, [
          'task-1',
        ]),
      ).toEqual([{ version: '3' }])

      await eventStore.appendToStream<SchedulingEvent>('task-1', [completed('o-1')])
      expect(await eventStore.readProjection(completions, 'task-1')).toEqual({ data: { completed: 1 }, version: 4n })
    })
  })
})

describe('Fairness', () => {
  test('a busy stream does not starve the others', async () => {
    await mysql.withDatabase(async ({ pool, options, onDispose }) => {
      const eventStore = await setUp(pool)
      const published: HermesEventEnvelope<SchedulingEvent>[] = []
      let busy = true

      onDispose(
        await createEventStoreConsumer<SchedulingEvent>({
          getOptions: () => options,
          consumerName: 'relay',
          publish: (event) => void published.push(event),
          pollInterval: Duration.ofMiliseconds(20),
          maxPartitions: 1,
          batchSize: 1,
        }).start(),
      )

      const appending = (async () => {
        for (let i = 0; busy; i++) {
          await eventStore.appendToStream<SchedulingEvent>('a-busy', [note(`${i}`)])
        }
      })()

      try {
        await waitUntil(() => published.length > 5)
        await eventStore.appendToStream<SchedulingEvent>('z-quiet', [note('one')])
        await waitUntil(() => published.some(({ streamId }) => streamId === 'z-quiet'), Duration.ofSeconds(5))
      } finally {
        busy = false
        await appending
      }
    })
  })
})

describe('Mutex, cancellation', () => {
  test('lock() stops waiting when its signal aborts', async () => {
    await mysql.withDatabase(async ({ options, onDispose }) => {
      const first = createMutex({ getOptions: () => options, name: 'scheduling-tick' })
      const second = createMutex({
        getOptions: () => options,
        name: 'scheduling-tick',
        retryEvery: Duration.ofSeconds(10),
      })
      onDispose(() => first.unlock())
      onDispose(() => second.unlock())
      const controller = new AbortController()

      await first.lock()
      const waiting = second.lock(controller.signal)
      setTimeout(50).then(() => controller.abort())

      await expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
    })
  })
})
