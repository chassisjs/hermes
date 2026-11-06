import { applyProjection, type Event, type HermesProjection, type RecordedEvent } from '@chassisjs/hermes'
import { type PoolConnection, type RowDataPacket } from 'mysql2/promise'
import { DuplicateEntryErrno, EventsTable } from './eventStoreSql.js'
import { projectionTables } from './projectionTables.js'

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
 * Sets the version of a stream in a document. `exists` comes from the read of the version, so a missing row is
 * inserted instead of updated: an `UPDATE` of a missing row locks its gap in `REPEATABLE READ`, which would block
 * the documents of other streams.
 *
 * In `REPEATABLE READ`, that read sees the snapshot of the transaction, so a row committed after the snapshot looks
 * missing and its `INSERT` is a duplicate key. Then the row is updated, never below its version: the row of the
 * document is locked, so the positions applied now are above any version recorded before.
 */
const setVersion = async (
  ex: Queryable,
  table: string,
  key: { id: string; streamId: string },
  version: bigint,
  exists: boolean,
) => {
  const update = () =>
    ex.query(
      `UPDATE \`${table}\` SET \`version\` = GREATEST(\`version\`, CAST(? AS UNSIGNED))
       WHERE \`id\` = ? AND \`stream_id\` = ?`,
      [version.toString(), key.id, key.streamId],
    )

  if (exists) {
    await update()

    return
  }

  try {
    await ex.query(`INSERT INTO \`${table}\` (\`id\`, \`stream_id\`, \`version\`) VALUES (?, ?, ?)`, [
      key.id,
      key.streamId,
      version.toString(),
    ])
  } catch (error) {
    if (errnoOf(error) !== DuplicateEntryErrno) {
      throw error
    }

    await update()
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
 * The document keeps the version of every stream that fed it (in its own row in a single-stream projection, in the
 * `_versions` table in a multi-stream one), so an event at or below that version was already applied and is skipped:
 * a replay or a redelivery does not change the document. A document that `evolve` turns into `null` is deleted, and
 * its versions stay, so a replay does not bring it back.
 *
 * A single-stream document that does not exist yet for a stream that has earlier events (e.g. the projection was
 * added to a running application) is built from all the events of the stream first, so it never misses them.
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

  const tables = projectionTables(projection)
  const { documentId, streamId } = target

  if (tables.versions === null) {
    await applyToSingleStreamDocument(ex, projection, tables.documents, streamId, events, options)

    return
  }

  const { data } = await lockDocument(ex, tables.documents, documentId, options, false)
  const [versions] = await ex.query<RowDataPacket[]>(
    `SELECT \`version\` FROM \`${tables.versions}\` WHERE \`id\` = ? AND \`stream_id\` = ?`,
    [documentId, streamId],
  )
  const version = versions.length ? toBigInt(versions[0].version) : 0n
  const fresh = events.filter(({ streamPosition }) => streamPosition > version)
  const handled = fresh.filter((event) => projection.canHandle(event))

  if (!fresh.length || (!handled.length && data === null)) {
    if (data === null) {
      await ex.query(`DELETE FROM \`${tables.documents}\` WHERE \`id\` = ?`, [documentId])
    }

    return
  }

  const state = applyProjection(projection, data, fresh)

  if (state === null || state === undefined) {
    await ex.query(`DELETE FROM \`${tables.documents}\` WHERE \`id\` = ?`, [documentId])
  } else if (state !== data) {
    await ex.query(`UPDATE \`${tables.documents}\` SET \`data\` = CAST(? AS JSON) WHERE \`id\` = ?`, [
      JSON.stringify(state),
      documentId,
    ])
  }

  await setVersion(
    ex,
    tables.versions,
    { id: documentId, streamId },
    fresh[fresh.length - 1].streamPosition,
    versions.length > 0,
  )
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
  const state = fresh.some((event) => projection.canHandle(event)) ? applyProjection(projection, data, fresh) : data
  const deleted = state === null || state === undefined

  if (state === data || (deleted && data === null)) {
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
 * also when the tables of the projection do not exist yet
 */
const readDocument = async <State>(ex: Queryable, projection: HermesProjection<State, Event>, id: string) => {
  const tables = projectionTables(projection)
  let rows: RowDataPacket[]

  try {
    ;[rows] = await ex.query<RowDataPacket[]>(
      `SELECT ${tables.versions === null ? '`data`, `version`' : '`data`'} FROM \`${tables.documents}\` WHERE \`id\` = ?`,
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
    version: tables.versions === null ? toBigInt(rows[0].version) : null,
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
