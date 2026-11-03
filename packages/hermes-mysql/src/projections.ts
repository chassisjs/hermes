import { applyProjection, type Event, type HermesProjection, type RecordedEvent } from '@chassisjs/hermes'
import { type PoolConnection, type RowDataPacket } from 'mysql2/promise'
import { DuplicateEntryErrno, ProjectionsTable, ProjectionVersionsTable } from './eventStoreSql.js'

/** A `mysql2` pool or connection. */
type Queryable = Pick<PoolConnection, 'query'>

type AnyProjection = HermesProjection<any, any>

const toBigInt = (value: unknown) => BigInt(String(value))
const errnoOf = (error: unknown) => (error as { errno?: number }).errno

/**
 * Locks the row of a document, creating an empty one (`data` is `NULL`) when there is none.
 *
 * It looks for the row with a plain `SELECT` first and locks it only when it exists, so that a transaction of the
 * application in `REPEATABLE READ` does not lock the gap of a missing row, which would block the documents of other
 * streams. A row created by a concurrent transaction is a duplicate key, and then it is locked like an existing one.
 */
const lockDocument = async (ex: Queryable, name: string, id: string) => {
  const lockExisting = async () => {
    const [rows] = await ex.query<RowDataPacket[]>(
      `SELECT \`data\` FROM \`${ProjectionsTable}\` WHERE \`name\` = ? AND \`id\` = ? FOR UPDATE`,
      [name, id],
    )

    return rows.length ? { created: false, data: (rows[0].data ?? null) as unknown } : null
  }

  const [found] = await ex.query<RowDataPacket[]>(
    `SELECT 1 FROM \`${ProjectionsTable}\` WHERE \`name\` = ? AND \`id\` = ?`,
    [name, id],
  )

  if (found.length) {
    const locked = await lockExisting()

    if (locked) {
      return locked
    }
  }

  try {
    await ex.query(`INSERT INTO \`${ProjectionsTable}\` (\`name\`, \`id\`, \`data\`) VALUES (?, ?, NULL)`, [name, id])

    return { created: true, data: null as unknown }
  } catch (error) {
    if (errnoOf(error) !== DuplicateEntryErrno) {
      throw error
    }

    return (await lockExisting()) ?? { created: false, data: null as unknown }
  }
}

/**
 * Sets the version of a stream in a document. `exists` comes from the read of the version, so a missing row is
 * inserted instead of updated: an `UPDATE` of a missing row locks its gap in `REPEATABLE READ`, which would block
 * the documents of other streams. The row of the document is locked, so nobody else changes its versions meanwhile.
 */
const setVersion = async (
  ex: Queryable,
  key: { name: string; id: string; streamId: string },
  version: bigint,
  exists: boolean,
) => {
  if (exists) {
    await ex.query(
      `UPDATE \`${ProjectionVersionsTable}\` SET \`version\` = ? WHERE \`name\` = ? AND \`id\` = ? AND \`stream_id\` = ?`,
      [version.toString(), key.name, key.id, key.streamId],
    )
  } else {
    await ex.query(
      `INSERT INTO \`${ProjectionVersionsTable}\` (\`name\`, \`id\`, \`stream_id\`, \`version\`) VALUES (?, ?, ?, ?)`,
      [key.name, key.id, key.streamId, version.toString()],
    )
  }
}

/**
 * Applies events of one stream to one document, in a transaction.
 *
 * The document keeps the version of every stream that fed it (`hermes_projection_versions`), so an event at or below
 * that version was already applied and is skipped: a replay or a redelivery does not change the document. A document
 * that `evolve` turns into `null` is deleted, and its versions stay, so a replay does not bring it back.
 */
const applyToDocument = async (
  ex: Queryable,
  projection: AnyProjection,
  documentId: string,
  streamId: string,
  events: RecordedEvent<Event>[],
) => {
  if (!events.length) {
    return
  }

  const { name } = projection
  const document = await lockDocument(ex, name, documentId)
  const [versions] = await ex.query<RowDataPacket[]>(
    `SELECT \`version\` FROM \`${ProjectionVersionsTable}\` WHERE \`name\` = ? AND \`id\` = ? AND \`stream_id\` = ?`,
    [name, documentId, streamId],
  )
  const version = versions.length ? toBigInt(versions[0].version) : 0n
  const fresh = events.filter(({ streamPosition }) => streamPosition > version)
  const handled = fresh.filter((event) => projection.canHandle(event))

  if (!fresh.length || (!handled.length && document.data === null)) {
    if (document.created) {
      await ex.query(`DELETE FROM \`${ProjectionsTable}\` WHERE \`name\` = ? AND \`id\` = ?`, [name, documentId])
    }

    return
  }

  const state = applyProjection(projection, document.data, fresh)

  if (state === null || state === undefined) {
    await ex.query(`DELETE FROM \`${ProjectionsTable}\` WHERE \`name\` = ? AND \`id\` = ?`, [name, documentId])
  } else if (state !== document.data) {
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
const applyToProjection = async (ex: Queryable, projection: AnyProjection, events: RecordedEvent<Event>[]) => {
  if (!events.length) {
    return
  }

  if (projection.isSingleStream) {
    await applyToDocument(ex, projection, events[0].streamId, events[0].streamId, events)

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
    await applyToDocument(ex, projection, id, events[0].streamId, byDocument.get(id)!)
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

export { applyToProjection, readDocument, toBigInt, type AnyProjection, type Queryable }
