import {
  applyProjection,
  assert,
  assertExpectedVersion,
  type Event,
  type EventStore,
  type HermesProjection,
  type RecordedEvent,
  type StateLoader,
} from '@chassisjs/hermes'
import { randomUUID } from 'node:crypto'
import { type Pool, type RowDataPacket } from 'mysql2/promise'
import { DeadlockErrno, DuplicateEntryErrno, EventsTable, StreamsTable } from './eventStoreSql.js'
import { assertProjectionTables, ensureProjectionTables, forgetProjectionTables } from './projectionTables.js'
import {
  applyToProjection,
  EventColumns,
  readDocument,
  toBigInt,
  toRecordedEvent,
  type AnyProjection,
  type EventRow,
  type Queryable,
} from './projections.js'
import { inTransaction, insertStatements } from './sql.js'

/**
 * A transaction of the application that an append or a read runs in: a `mysql2` connection with an open transaction.
 */
type EventStoreTransaction = Queryable

type MySqlEventStore = EventStore<EventStoreTransaction> & {
  /**
   * Creates the missing tables of the projections given to {@link createEventStore} (see {@link projectionTable}),
   * on its own connection of the pool, never in a transaction: MySQL commits every DDL statement. Existing tables are
   * never changed.
   *
   * An append without `tx` creates the tables of the inline projections before their first use. An append in a
   * transaction of the application (`tx`) never creates them: it would need a second connection of the pool while the
   * transaction holds one, and a table created after the transaction began cannot be read in it
   * (`ER_TABLE_DEF_CHANGED`). It throws when they are missing, so call `init()` on start when you append with `tx`.
   */
  init(): Promise<void>

  /**
   * Reads a document of a projection.
   *
   * @returns The document and, for a single-stream projection, the version of its stream (`null` for a document fed by
   * many streams); `null` when there is no document
   */
  readProjection<State, E extends Event>(
    projection: HermesProjection<State, E>,
    id: string,
    options?: { tx?: EventStoreTransaction },
  ): Promise<{ data: State; version: bigint | null } | null>

  /** The version of a stream, 0 when it does not exist. */
  readStreamVersion(streamId: string, options?: { tx?: EventStoreTransaction }): Promise<bigint>
}

const OwnTransactionAttempts = 5
const NoSuchTableErrno = 1146
const TableDefinitionChangedErrno = 1412
const Savepoint = 'hermes_append'

const errnoOf = (error: unknown) => (error as { errno?: number }).errno

/**
 * Locks the row of a stream until the end of the transaction and returns its version, creating the row (at version 0)
 * when the stream does not exist.
 *
 * In its own transaction (`READ COMMITTED`), `INSERT ... ON DUPLICATE KEY UPDATE` takes the exclusive lock at once, so
 * appends that create the same stream at the same time do not deadlock on an upgrade of a shared lock.
 *
 * In a transaction of the application, it looks for the row with a plain `SELECT` first, so that a missing stream is
 * created with an `INSERT`, which locks only the new row, instead of a locking read of a missing row, which in
 * `REPEATABLE READ` locks the gap where other streams would be created.
 */
const lockStream = async (ex: Queryable, streamId: string, readCommitted: boolean) => {
  if (readCommitted) {
    await ex.query(
      `INSERT INTO \`${StreamsTable}\` (\`stream_id\`, \`version\`) VALUES (?, 0)
       ON DUPLICATE KEY UPDATE \`stream_id\` = \`stream_id\``,
      [streamId],
    )
  } else {
    const [found] = await ex.query<RowDataPacket[]>(`SELECT 1 FROM \`${StreamsTable}\` WHERE \`stream_id\` = ?`, [
      streamId,
    ])

    if (!found.length) {
      try {
        await ex.query(`INSERT INTO \`${StreamsTable}\` (\`stream_id\`, \`version\`) VALUES (?, 0)`, [streamId])

        return 0n
      } catch (error) {
        if (errnoOf(error) !== DuplicateEntryErrno) {
          throw error
        }
      }
    }
  }
  const [[row]] = await ex.query<RowDataPacket[]>(
    `SELECT \`version\` FROM \`${StreamsTable}\` WHERE \`stream_id\` = ? FOR UPDATE`,
    [streamId],
  )

  return toBigInt(row.version)
}

/**
 * Creates an event store on MySQL 8.0+ / Aurora MySQL 3. Run `migrate(pool, { eventStore: true })` first.
 *
 * An append locks the row of its stream in `hermes_streams` until the end of its transaction, checks the expected
 * version, stores the events with the next positions and updates the inline projections, all in one transaction:
 * its own, in `READ COMMITTED`, or the one of the application (`tx`). In the transaction of the application, the
 * append runs inside a savepoint, so a rejected append (e.g. a {@link VersionConflictError}) leaves nothing behind
 * and the transaction stays usable. Appends to different streams do not wait for each other, with one exception: an
 * inline projection whose document is fed by many streams (`ofId`) locks that document in every append that feeds it,
 * until the end of its transaction.
 *
 * Every event gets a new `eventId` (a UUID); an id given by the caller is not used. For idempotent appends, use the
 * expected version.
 *
 * Every projection has its own table, named after it ({@link projectionTable}) and created when it is missing (see
 * {@link MySqlEventStore.init}). It keeps the documents, and in a single-stream projection also the version of its
 * stream.
 *
 * Its own transaction is tried again when MySQL picks it as the victim of a deadlock (e.g. when many instances create
 * the same stream at once). A deadlock in the transaction of the application rolls back the whole transaction, so it
 * is thrown to the application as it is.
 *
 * Reads and appends use the pool, so point it at the writer of Aurora, not at a reader: the readers lag behind.
 *
 * @param pool - The `mysql2` pool of the application
 * @param options.projections - The projections: the inline ones are updated in the transaction of every append, and
 * `init()` creates the tables of all of them
 */
const createEventStore = (pool: Pool, options?: { projections?: AnyProjection[] }): MySqlEventStore => {
  const projections = options?.projections ?? []
  const names = projections.map(({ name }) => name)

  assert(new Set(names).size === names.length, 'The names of the projections have to be unique.')

  const inline = projections.filter(({ mode }) => mode === 'inline')
  const init = () => ensureProjectionTables(pool, projections)
  // a table dropped after it was created is created again by the next append without `tx`; the tables of the
  // projections share no prefix, so any missing table only resets what is known to exist
  const forgetOnMissingTable = (error: unknown) => {
    if (errnoOf(error) === NoSuchTableErrno) {
      forgetProjectionTables(pool)
    }
  }

  const append = async (
    ex: Queryable,
    streamId: string,
    events: Event[],
    expectedVersion: Parameters<typeof assertExpectedVersion>[1],
    readCommitted: boolean,
  ) => {
    await ex.query(`SAVEPOINT ${Savepoint}`)

    try {
      const currentVersion = await lockStream(ex, streamId, readCommitted)

      assertExpectedVersion(streamId, expectedVersion, currentVersion)

      const recordedAt = new Date()
      const recorded = events.map(
        (event, i) =>
          ({
            type: event.type,
            data: event.data,
            metadata: (event as { metadata?: unknown }).metadata ?? {},
            streamId,
            streamPosition: currentVersion + BigInt(i + 1),
            eventId: randomUUID(),
            recordedAt,
          }) as RecordedEvent,
      )
      const nextVersion = currentVersion + BigInt(events.length)

      for (const { text, params } of insertStatements(
        EventsTable,
        [
          { name: 'stream_id' },
          { name: 'stream_position' },
          { name: 'event_id' },
          { name: 'type' },
          { name: 'data', placeholder: 'CAST(? AS JSON)' },
          { name: 'metadata', placeholder: 'CAST(? AS JSON)' },
          { name: 'recorded_at' },
        ],
        recorded.map((event) => [
          streamId,
          event.streamPosition.toString(),
          event.eventId,
          event.type,
          JSON.stringify(event.data),
          JSON.stringify(event.metadata),
          recordedAt,
        ]),
      )) {
        await ex.query(text, params)
      }

      await ex.query(`UPDATE \`${StreamsTable}\` SET \`version\` = ? WHERE \`stream_id\` = ?`, [
        nextVersion.toString(),
        streamId,
      ])

      for (const projection of inline) {
        await applyToProjection(ex, projection, recorded, { readCommitted })
      }

      await ex.query(`RELEASE SAVEPOINT ${Savepoint}`)

      return { nextVersion, createdNewStream: currentVersion === 0n }
    } catch (error) {
      if (errnoOf(error) !== DeadlockErrno) {
        await ex.query(`ROLLBACK TO SAVEPOINT ${Savepoint}`).catch(() => {})
      }

      throw error
    }
  }

  const readStreamVersion = async (streamId: string, ex: Queryable) => {
    const [rows] = await ex.query<RowDataPacket[]>(
      `SELECT \`version\` FROM \`${StreamsTable}\` WHERE \`stream_id\` = ?`,
      [streamId],
    )

    return rows.length ? toBigInt(rows[0].version) : 0n
  }

  return {
    init,

    async readStream<E extends Event>(streamId: string, options?: { after?: bigint; tx?: EventStoreTransaction }) {
      const ex = options?.tx ?? pool
      const currentVersion = await readStreamVersion(streamId, ex)
      const [rows] = await ex.query<EventRow[]>(
        `SELECT ${EventColumns}
         FROM \`${EventsTable}\`
         WHERE \`stream_id\` = ? AND \`stream_position\` > ?
         ORDER BY \`stream_position\``,
        [streamId, (options?.after ?? 0n).toString()],
      )

      const events = rows.map(toRecordedEvent) as RecordedEvent<E>[]
      // Without `tx`, the version and the events may come from different connections: an append that commits in
      // between adds events above the version, so the version is the last of them.
      const version =
        events.length && events[events.length - 1].streamPosition > currentVersion
          ? events[events.length - 1].streamPosition
          : currentVersion

      return { events, currentVersion: version, streamExists: version > 0n }
    },

    async appendToStream(streamId, events, options) {
      assert(events.length > 0, 'There are no events to append.')
      assert(
        typeof streamId === 'string' && streamId.length > 0 && streamId.length <= 250,
        'A stream id has to have 1 to 250 characters.',
      )

      const expectedVersion = options?.expectedVersion ?? 'any'

      if (options?.tx) {
        await assertProjectionTables(pool, options.tx, inline)

        return append(options.tx, streamId, events, expectedVersion, false).catch((error: unknown) => {
          forgetOnMissingTable(error)

          if (errnoOf(error) === TableDefinitionChangedErrno) {
            // a table of a projection was created after the transaction began
            Object.assign(error as object, {
              message: `${(error as Error).message} Retry the transaction, and call init() of the event store on start.`,
            })
          }

          throw error
        })
      }

      await ensureProjectionTables(pool, inline)

      for (let attempt = 1; ; attempt++) {
        try {
          return await inTransaction(
            pool,
            (connection) => append(connection, streamId, events, expectedVersion, true),
            {
              readCommitted: true,
            },
          )
        } catch (error) {
          forgetOnMissingTable(error)

          if (errnoOf(error) !== DeadlockErrno || attempt >= OwnTransactionAttempts) {
            throw error
          }
        }
      }
    },

    readProjection: (projection, id, options) =>
      readDocument(options?.tx ?? pool, projection as HermesProjection<never, Event>, id) as never,

    readStreamVersion: (streamId, options) => readStreamVersion(streamId, options?.tx ?? pool),
  }
}

/**
 * Loads the state of a stream from the document of a single-stream inline projection (state-stored), with the
 * version of the stream it was updated at.
 *
 * A stream with events but without a document (e.g. the projection was added to a running application, and nothing
 * was appended to the stream since) gets its state folded from its events through the projection, so the decider
 * never decides on an empty state. The next append writes the document from all the events of the stream.
 *
 * The projection has to apply the same events as the `evolve` of the decider, e.g. `.ofEvolve(decider.evolve)`.
 */
const fromInlineProjection = <State, E extends Event>(
  eventStore: MySqlEventStore,
  projection: HermesProjection<State, E>,
): StateLoader<State, EventStoreTransaction> => {
  assert(projection.isSingleStream, `Projection ${projection.name} has to have one document per stream (no ofId).`)
  assert(projection.mode === 'inline', `Projection ${projection.name} has to be inline.`)

  return async ({ streamId, tx }) => {
    const document = await eventStore.readProjection(projection, streamId, { tx })

    if (document) {
      return { state: document.data, version: document.version ?? 0n }
    }

    const { events, currentVersion } = await eventStore.readStream<E>(streamId, { tx })

    return {
      // a document deleted by `evolve` (null) is the initial state again
      state: (events.length ? applyProjection(projection, null, events) : null) ?? projection.initialState(),
      version: currentVersion,
    }
  }
}

export { createEventStore, fromInlineProjection, type EventStoreTransaction, type MySqlEventStore }
