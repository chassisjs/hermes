import { applyProjection, type Event, type HermesProjection, type RecordedEvent } from '@chassisjs/hermes'
import { type PoolConnection, type RowDataPacket } from 'mysql2/promise'
import { DuplicateEntryErrno, EventsTable, ProjectionsTable, ProjectionVersionsTable } from './eventStoreSql.js'

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

/**
 * Locks the row of a document, creating an empty one (`data` is `NULL`) when there is none. A `NULL` row exists only
 * inside the transaction that created it (it is filled or deleted before the commit), so `data === null` means that
 * the document is new.
 *
 * In `READ COMMITTED`, `INSERT ... ON DUPLICATE KEY UPDATE` takes the exclusive lock at once: there are no gap locks
 * to fear, and two transactions creating the same document do not deadlock on an upgrade of a shared lock.
 *
 * In a transaction of the application, it looks for the row with a plain `SELECT` first and locks it only when it
 * exists, so that `REPEATABLE READ` does not lock the gap of a missing row, which would block the documents of other
 * streams. A row created by a concurrent transaction is a duplicate key, and then it is locked like an existing one.
 */
const lockDocument = async (ex: Queryable, name: string, id: string, { readCommitted }: ApplyOptions) => {
  const lockExisting = async () => {
    const [rows] = await ex.query<RowDataPacket[]>(
      `SELECT \`data\` FROM \`${ProjectionsTable}\` WHERE \`name\` = ? AND \`id\` = ? FOR UPDATE`,
      [name, id],
    )

    return rows.length ? ((rows[0].data ?? null) as unknown) : null
  }

  if (readCommitted) {
    await ex.query(
      `INSERT INTO \`${ProjectionsTable}\` (\`name\`, \`id\`, \`data\`) VALUES (?, ?, NULL)
       ON DUPLICATE KEY UPDATE \`name\` = \`name\``,
      [name, id],
    )

    return lockExisting()
  }

  const [found] = await ex.query<RowDataPacket[]>(
    `SELECT 1 FROM \`${ProjectionsTable}\` WHERE \`name\` = ? AND \`id\` = ?`,
    [name, id],
  )

  if (found.length) {
    const [rows] = await ex.query<RowDataPacket[]>(
      `SELECT \`data\` FROM \`${ProjectionsTable}\` WHERE \`name\` = ? AND \`id\` = ? FOR UPDATE`,
      [name, id],
    )

    if (rows.length) {
      return (rows[0].data ?? null) as unknown
    }
  }

  try {
    await ex.query(`INSERT INTO \`${ProjectionsTable}\` (\`name\`, \`id\`, \`data\`) VALUES (?, ?, NULL)`, [name, id])

    return null
  } catch (error) {
    if (errnoOf(error) !== DuplicateEntryErrno) {
      throw error
    }

    return lockExisting()
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
  key: { name: string; id: string; streamId: string },
  version: bigint,
  exists: boolean,
) => {
  const update = () =>
    ex.query(
      `UPDATE \`${ProjectionVersionsTable}\` SET \`version\` = GREATEST(\`version\`, CAST(? AS UNSIGNED))
       WHERE \`name\` = ? AND \`id\` = ? AND \`stream_id\` = ?`,
      [version.toString(), key.name, key.id, key.streamId],
    )

  if (exists) {
    await update()

    return
  }

  try {
    await ex.query(
      `INSERT INTO \`${ProjectionVersionsTable}\` (\`name\`, \`id\`, \`stream_id\`, \`version\`) VALUES (?, ?, ?, ?)`,
      [key.name, key.id, key.streamId, version.toString()],
    )
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
 * The document keeps the version of every stream that fed it (`hermes_projection_versions`), so an event at or below
 * that version was already applied and is skipped: a replay or a redelivery does not change the document. A document
 * that `evolve` turns into `null` is deleted, and its versions stay, so a replay does not bring it back.
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

  const { name } = projection
  const { documentId, streamId } = target
  const data = await lockDocument(ex, name, documentId, options)
  const [versions] = await ex.query<RowDataPacket[]>(
    `SELECT \`version\` FROM \`${ProjectionVersionsTable}\` WHERE \`name\` = ? AND \`id\` = ? AND \`stream_id\` = ?`,
    [name, documentId, streamId],
  )
  const version = versions.length ? toBigInt(versions[0].version) : 0n
  const catchUp =
    projection.isSingleStream && !versions.length && data === null && events[0].streamPosition > 1n
      ? await readEventsBefore(ex, streamId, events[0].streamPosition)
      : []
  const fresh = [...catchUp, ...events].filter(({ streamPosition }) => streamPosition > version)
  const handled = fresh.filter((event) => projection.canHandle(event))

  if (!fresh.length || (!handled.length && data === null)) {
    if (data === null) {
      await ex.query(`DELETE FROM \`${ProjectionsTable}\` WHERE \`name\` = ? AND \`id\` = ?`, [name, documentId])
    }

    return
  }

  const state = applyProjection(projection, data, fresh)

  if (state === null || state === undefined) {
    await ex.query(`DELETE FROM \`${ProjectionsTable}\` WHERE \`name\` = ? AND \`id\` = ?`, [name, documentId])
  } else if (state !== data) {
    await ex.query(`UPDATE \`${ProjectionsTable}\` SET \`data\` = CAST(? AS JSON) WHERE \`name\` = ? AND \`id\` = ?`, [
      JSON.stringify(state),
      name,
      documentId,
    ])
  }

  await setVersion(ex, { name, id: documentId, streamId }, fresh[fresh.length - 1].streamPosition, versions.length > 0)
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

/**
 * Reads a document of a projection.
 *
 * @returns The document and, for a single-stream projection, the version of its stream; `null` when there is none
 */
const readDocument = async <State>(ex: Queryable, projection: HermesProjection<State, Event>, id: string) => {
  const [rows] = await ex.query<RowDataPacket[]>(
    `SELECT \`data\` FROM \`${ProjectionsTable}\` WHERE \`name\` = ? AND \`id\` = ?`,
    [projection.name, id],
  )

  if (!rows.length || rows[0].data === null) {
    return null
  }

  if (!projection.isSingleStream) {
    return { data: rows[0].data as State, version: null }
  }

  const [versions] = await ex.query<RowDataPacket[]>(
    `SELECT \`version\` FROM \`${ProjectionVersionsTable}\` WHERE \`name\` = ? AND \`id\` = ? AND \`stream_id\` = ?`,
    [projection.name, id, id],
  )

  return { data: rows[0].data as State, version: versions.length ? toBigInt(versions[0].version) : 0n }
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
