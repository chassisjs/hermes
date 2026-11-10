import { applyProjection, type Event, type HermesProjection, type RecordedEvent } from '@chassisjs/hermes'
import { type PoolConnection, type RowDataPacket } from 'mysql2/promise'
import { DuplicateEntryErrno, EventsTable } from './eventStoreSql.js'
import { projectionTable } from './projectionTables.js'

/** A `mysql2` pool or connection. */
type Queryable = Pick<PoolConnection, 'query'>

type AnyProjection = HermesProjection<any, any>

/**
 * How a projection is updated: `readCommitted` is true in the transactions of Hermes (`READ COMMITTED`), false in a
 * transaction of the application, whose isolation level is unknown (`REPEATABLE READ` by default).
 */
type ApplyOptions = { readCommitted: boolean }

type EventRow = RowDataPacket & {
  stream_id: string
  stream_position: string | number
  event_id: string
  type: string
  data: unknown
  metadata: unknown
  recorded_at: Date
}

const EventColumns = '`stream_id`, `stream_position`, `event_id`, `type`, `data`, `metadata`, `recorded_at`'

const toBigInt = (value: unknown) => BigInt(String(value))
const errnoOf = (error: unknown) => (error as { errno?: number }).errno

const toRecordedEvent = (row: EventRow) =>
  ({
    type: row.type,
    data: row.data,
    metadata: row.metadata ?? {},
    streamId: row.stream_id,
    streamPosition: toBigInt(row.stream_position),
    eventId: row.event_id,
    recordedAt: row.recorded_at,
  }) as RecordedEvent

type LockedDocument = {
  /** `null` for a document that does not exist, was deleted, or has no handled events yet. */
  data: unknown
  /** The version of its stream, in a single-stream projection (0 for a new document); `null` otherwise. */
  version: bigint | null
}

/**
 * Locks the row of a document, creating an empty one (`data` is `NULL`, `version` is 0) when there is none.
 *
 * In a multi-stream projection, a `NULL` row exists only inside the transaction that created it (it is filled or
 * deleted before the commit). In a single-stream projection, the row also keeps the version of its stream, so it
 * stays when the document is deleted (`data` is `NULL`), and a replay does not bring the document back.
 *
 * In `READ COMMITTED`, `INSERT ... ON DUPLICATE KEY UPDATE` takes the exclusive lock at once: there are no gap locks
 * to fear, and two transactions creating the same document do not deadlock on an upgrade of a shared lock.
 *
 * In a transaction of the application, it looks for the row with a plain `SELECT` first and locks it only when it
 * exists, so that `REPEATABLE READ` does not lock the gap of a missing row, which would block the documents of other
 * streams. A row created by a concurrent transaction is a duplicate key, and then it is locked like an existing one.
 */
const lockDocument = async (
  ex: Queryable,
  table: string,
  id: string,
  { readCommitted }: ApplyOptions,
  withVersion: boolean,
): Promise<LockedDocument> => {
  const columns = withVersion ? '`data`, `version`' : '`data`'
  const created: LockedDocument = { data: null, version: withVersion ? 0n : null }
  const lockExisting = async (): Promise<LockedDocument | null> => {
    const [rows] = await ex.query<RowDataPacket[]>(`SELECT ${columns} FROM \`${table}\` WHERE \`id\` = ? FOR UPDATE`, [
      id,
    ])

    return rows.length ? { data: rows[0].data ?? null, version: withVersion ? toBigInt(rows[0].version) : null } : null
  }

  if (readCommitted) {
    await ex.query(
      `INSERT INTO \`${table}\` (\`id\`, \`data\`) VALUES (?, NULL) ON DUPLICATE KEY UPDATE \`id\` = \`id\``,
      [id],
    )

    return (await lockExisting()) ?? created
  }

  const [found] = await ex.query<RowDataPacket[]>(`SELECT 1 FROM \`${table}\` WHERE \`id\` = ?`, [id])

  if (found.length) {
    const existing = await lockExisting()

    if (existing) {
      return existing
    }
  }

  try {
    await ex.query(`INSERT INTO \`${table}\` (\`id\`, \`data\`) VALUES (?, NULL)`, [id])

    return created
  } catch (error) {
    if (errnoOf(error) !== DuplicateEntryErrno) {
      throw error
    }

    return (await lockExisting()) ?? created
  }
}

/**
 * The events of a stream before a position, with a locking read (the latest committed rows, whatever the snapshot of
 * the transaction is). The row of the stream is locked by the append, so they do not change meanwhile.
 *
 * In `REPEATABLE READ`, the read takes next-key locks on the range, including the gap before the first event of the
 * stream, so until the transaction of the application commits, it blocks the first event of a new stream whose id
 * sorts just before it. It runs at most once per stream and document.
 */
const readEventsBefore = async (ex: Queryable, streamId: string, before: bigint) => {
  const [rows] = await ex.query<EventRow[]>(
    `SELECT ${EventColumns} FROM \`${EventsTable}\`
     WHERE \`stream_id\` = ? AND \`stream_position\` < ?
     ORDER BY \`stream_position\`
     FOR SHARE`,
    [streamId, before.toString()],
  )

  return rows.map(toRecordedEvent)
}

/**
 * Applies events of one stream to one document, in a transaction.
 *
 * A single-stream document keeps the version of its stream in its row, so an event at or below that version was
 * already applied and is skipped: a replay or a redelivery does not change the document.
 *
 * A multi-stream document keeps no versions: an inline projection gets every event once, in the transaction of its
 * append, and the consumer of an async one moves its checkpoint only forward in the transaction of the document, so the
 * transaction that would apply an event again is rolled back. A document that `evolve` turns into `null` is deleted.
 */
const applyToDocument = async (
  ex: Queryable,
  projection: AnyProjection,
  target: { documentId: string; streamId: string },
  events: RecordedEvent<Event>[],
  options: ApplyOptions,
) => {
  if (!events.length) {
    return
  }

  const table = projectionTable(projection)
  const { documentId, streamId } = target

  if (projection.isSingleStream) {
    await applyToSingleStreamDocument(ex, projection, table, streamId, events, options)

    return
  }

  const { data } = await lockDocument(ex, table, documentId, options, false)
  const state = applyProjection(projection, data, events)

  if (state === null || state === undefined) {
    await ex.query(`DELETE FROM \`${table}\` WHERE \`id\` = ?`, [documentId])
  } else {
    await ex.query(`UPDATE \`${table}\` SET \`data\` = CAST(? AS JSON) WHERE \`id\` = ?`, [
      JSON.stringify(state),
      documentId,
    ])
  }
}

/**
 * Applies events to the document of their stream, whose row keeps the version of the stream, so one lock covers both.
 *
 * The row stays when there is nothing to show (`data` is `NULL`): when `evolve` deleted the document, and when the
 * stream has no handled events yet, so that the catch-up from the earlier events runs at most once per stream.
 */
const applyToSingleStreamDocument = async (
  ex: Queryable,
  projection: AnyProjection,
  table: string,
  streamId: string,
  events: RecordedEvent<Event>[],
  options: ApplyOptions,
) => {
  const { data, version } = await lockDocument(ex, table, streamId, options, true)
  const applied = version ?? 0n
  const catchUp =
    applied === 0n && events[0].streamPosition > 1n
      ? await readEventsBefore(ex, streamId, events[0].streamPosition)
      : []
  const fresh = [...catchUp, ...events].filter(({ streamPosition }) => streamPosition > applied)

  if (!fresh.length) {
    return
  }

  const nextVersion = fresh[fresh.length - 1].streamPosition.toString()
  // decided by what was handled, not by comparing the states: an `evolve` may change the state in place
  const handled = fresh.some((event) => projection.canHandle(event))
  const state = handled ? applyProjection(projection, data, fresh) : data
  const deleted = state === null || state === undefined

  if (!handled || (deleted && data === null)) {
    // nothing to show changed: only the version moves, without rewriting the JSON
    await ex.query(
      `UPDATE \`${table}\` SET \`version\` = GREATEST(\`version\`, CAST(? AS UNSIGNED)), \`updated_at\` = \`updated_at\`
       WHERE \`id\` = ?`,
      [nextVersion, streamId],
    )

    return
  }

  await ex.query(
    `UPDATE \`${table}\` SET \`data\` = CAST(? AS JSON), \`version\` = GREATEST(\`version\`, CAST(? AS UNSIGNED))
     WHERE \`id\` = ?`,
    [deleted ? null : JSON.stringify(state), nextVersion, streamId],
  )
}

/**
 * Applies events of one stream, in order, to the documents of a projection.
 *
 * A single-stream projection has one document per stream, which gets all the events, so its version follows the
 * stream. A multi-stream projection gets only the events it handles, grouped by document, and the documents are locked
 * in the order of their ids, so that two transactions do not wait for each other in a circle.
 */
const applyToProjection = async (
  ex: Queryable,
  projection: AnyProjection,
  events: RecordedEvent<Event>[],
  options: ApplyOptions,
) => {
  if (!events.length) {
    return
  }

  const streamId = events[0].streamId

  if (projection.isSingleStream) {
    await applyToDocument(ex, projection, { documentId: streamId, streamId }, events, options)

    return
  }

  const byDocument = new Map<string, RecordedEvent<Event>[]>()

  for (const event of events) {
    if (projection.canHandle(event)) {
      const id = projection.getDocumentId(event)

      byDocument.set(id, [...(byDocument.get(id) ?? []), event])
    }
  }

  for (const id of [...byDocument.keys()].sort()) {
    await applyToDocument(ex, projection, { documentId: id, streamId }, byDocument.get(id)!, options)
  }
}

const NoSuchTableErrno = 1146

/**
 * Reads a document of a projection.
 *
 * @returns The document and, for a single-stream projection, the version of its stream; `null` when there is none,
 * also when the table of the projection does not exist yet
 */
const readDocument = async <State>(ex: Queryable, projection: HermesProjection<State, Event>, id: string) => {
  let rows: RowDataPacket[]

  try {
    ;[rows] = await ex.query<RowDataPacket[]>(
      `SELECT ${projection.isSingleStream ? '`data`, `version`' : '`data`'} FROM \`${projectionTable(projection)}\` WHERE \`id\` = ?`,
      [id],
    )
  } catch (error) {
    if (errnoOf(error) === NoSuchTableErrno) {
      return null
    }

    throw error
  }

  if (!rows.length || rows[0].data === null) {
    return null
  }

  return {
    data: rows[0].data as State,
    version: projection.isSingleStream ? toBigInt(rows[0].version) : null,
  }
}

export {
  applyToProjection,
  EventColumns,
  readDocument,
  toBigInt,
  toRecordedEvent,
  type AnyProjection,
  type ApplyOptions,
  type EventRow,
  type Queryable,
}
