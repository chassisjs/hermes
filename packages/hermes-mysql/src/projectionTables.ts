import { assert, type HermesProjection } from '@chassisjs/hermes'
import { createHash } from 'node:crypto'
import { type Pool, type PoolConnection, type RowDataPacket } from 'mysql2/promise'
import { type Queryable } from './projections.js'
import { retryOnTableLockTimeout, TableLockWaitTimeoutSeconds } from './sql.js'

/** What naming and creating the table of a projection needs to know about it. */
type ProjectionShape = Pick<HermesProjection<unknown>, 'name' | 'isSingleStream'>

const MaxIdentifierLength = 64
const HashLength = 8
const ReservedPrefix = 'hermes_'

const tableByName = new Map<string, string>()
// A plain name must not take a table of Hermes (`hermes_*`), nor look like a hashed name, which ends in `__` and 8
// hexadecimal digits.
const HashedEnding = new RegExp(`__[0-9a-f]{${HashLength}}$`)
const looksReserved = (slug: string) => slug.startsWith(ReservedPrefix) || HashedEnding.test(slug)

/**
 * The comment of the table of a projection. It tells the table of a projection from a table of the application with
 * the same name, and a single-stream table from a multi-stream one.
 */
const tableComment = ({ name, isSingleStream }: ProjectionShape) =>
  `Hermes projection ${name} (${isSingleStream ? 'single-stream' : 'multi-stream'})`

/**
 * The table of a projection, named after it.
 *
 * A name of lowercase letters, digits and `_` (at most 64 characters, not starting with `hermes_` and not ending in
 * `__` and 8 hexadecimal digits) is used as it is, e.g. `open_occurrences`. Any other name is turned into one (camelCase
 * into snake_case, other characters into `_`) and gets `__` and 8 characters of the SHA-256 of the name, so that two
 * projections never share a table, also where MySQL ignores the case of table names (macOS, Windows).
 *
 * The table lives next to the tables of the application, so pick a name that none of them has: a table of that name
 * that is not the table of the projection makes the creation of the tables fail (see the comment of the table).
 *
 * @example
 * ```typescript
 * projectionTable(openOccurrences) // name 'open_occurrences'
 * // 'open_occurrences'
 *
 * projectionTable(occurrencesByPatient) // name 'occurrencesByPatient'
 * // 'occurrences_by_patient__1c1a2c3e'
 * ```
 */
const projectionTable = ({ name }: Pick<ProjectionShape, 'name'>): string => {
  let table = tableByName.get(name)

  if (table === undefined) {
    assert(typeof name === 'string' && name.length > 0, 'A projection needs a name.')

    const slug = name
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, '_')

    table =
      slug === name && slug.length <= MaxIdentifierLength && !looksReserved(slug)
        ? slug
        : `${slug.slice(0, MaxIdentifierLength - HashLength - 2)}__${createHash('sha256').update(name).digest('hex').slice(0, HashLength)}`
    tableByName.set(name, table)
  }

  return table
}

const VersionColumn = '\n        `version`     BIGINT UNSIGNED  NOT NULL DEFAULT 0,'

/**
 * The statement that creates the table of a projection when it is missing. It never changes an existing table.
 *
 * A single-stream table keeps the version of its stream in the `version` column of the document. A multi-stream one
 * keeps only the documents: the checkpoint of its consumer moves in the transaction of the document, only forward, so
 * an event is never applied twice.
 */
const projectionTableStatement = (projection: ProjectionShape) => ({
  text: `CREATE TABLE IF NOT EXISTS \`${projectionTable(projection)}\` (
        \`id\`          VARCHAR(250)     COLLATE utf8mb4_0900_bin NOT NULL,
        \`data\`        JSON             NULL,${projection.isSingleStream ? VersionColumn : ''}
        \`created_at\`  DATETIME(6)      NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        \`updated_at\`  DATETIME(6)      NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (\`id\`)
      ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COMMENT = ?`,
  params: [tableComment(projection)],
})

/**
 * Throws when a table of the projections is not theirs: a table of the application with the same name, or the table
 * of the projection when it was single-stream and is multi-stream now, or the other way around.
 */
const assertOwnTables = async (ex: Queryable, projections: readonly ProjectionShape[]) => {
  if (!projections.length) {
    return
  }

  const [rows] = await ex.query<RowDataPacket[]>(
    `SELECT \`table_name\` AS name, \`table_comment\` AS comment FROM information_schema.tables
     WHERE \`table_schema\` = DATABASE() AND \`table_name\` IN (?)`,
    [projections.map((projection) => projectionTable(projection))],
  )
  const comments = new Map(rows.map(({ name, comment }) => [String(name), String(comment)]))

  for (const projection of projections) {
    const table = projectionTable(projection)
    const comment = comments.get(table)

    assert(
      comment === undefined || comment === tableComment(projection),
      `Table ${table} is not the table of the ${projection.isSingleStream ? 'single' : 'multi'}-stream projection ` +
        `${projection.name} (${comment ? `its comment is '${comment}'` : 'it is not a table of Hermes: no comment'}). ` +
        'Rename the projection, or drop the table when it is a table of the projection that changed its kind.',
    )
  }

  return comments
}

/**
 * Creates the missing tables of the projections on a connection without a transaction: MySQL commits every DDL
 * statement, so it must never run in a transaction of the application. Set a short `lock_wait_timeout` on the
 * connection first: a statement that times out waiting for the lock of a table is tried again.
 *
 * @throws Error when a table of that name exists and is not the table of the projection
 */
const createProjectionTables = async (connection: PoolConnection, projections: readonly ProjectionShape[]) => {
  for (const projection of projections) {
    const { text, params } = projectionTableStatement(projection)

    await retryOnTableLockTimeout(() => connection.query(text, params))
  }

  await assertOwnTables(connection, projections)
}

type PoolCache = {
  /** The tables being created or created, by their names. */
  creating: Map<string, Promise<void>>
  /** The tables that are known to exist. */
  existing: Set<string>
}

const cacheByPool = new WeakMap<Pool, PoolCache>()

const cacheOf = (pool: Pool) => {
  let cache = cacheByPool.get(pool)

  if (!cache) {
    cache = { creating: new Map(), existing: new Set() }
    cacheByPool.set(pool, cache)
  }

  return cache
}

/**
 * Creates the table of one projection on its own connection of the pool, with a `lock_wait_timeout` of 5 seconds,
 * because a waiting DDL stops the queries of the application on that table. A connection whose `lock_wait_timeout`
 * cannot be set back is destroyed, so that the pool never hands it to the application.
 */
const createOnOwnConnection = async (pool: Pool, projection: ProjectionShape) => {
  const connection = await pool.getConnection()
  let reusable = false

  try {
    const [[session]] = await connection.query<RowDataPacket[]>('SELECT @@SESSION.lock_wait_timeout AS lockWaitTimeout')

    await connection.query('SET SESSION lock_wait_timeout = ?', [TableLockWaitTimeoutSeconds])

    let failure: { error: unknown } | undefined

    try {
      await createProjectionTables(connection, [projection])
    } catch (error) {
      failure = { error }
    }

    await connection.query('SET SESSION lock_wait_timeout = ?', [Number(session.lockWaitTimeout)]).then(
      () => {
        reusable = true
      },
      (error: unknown) => {
        failure ??= { error }
      },
    )

    if (failure) {
      throw failure.error
    }
  } finally {
    if (reusable) {
      connection.release()
    } else {
      connection.destroy()
    }
  }
}

/**
 * Creates the missing tables of the projections, once per pool and table: later calls wait for the first one. It
 * takes its own connection of the pool, so call it without a transaction open on the pool, e.g. on start.
 */
const ensureProjectionTables = async (pool: Pool, projections: readonly ProjectionShape[]) => {
  const cache = cacheOf(pool)

  await Promise.all(
    projections.map((projection) => {
      const table = projectionTable(projection)
      let creating = cache.creating.get(table)

      if (!creating) {
        creating = createOnOwnConnection(pool, projection).then(() => {
          cache.existing.add(table)
        })
        creating.catch(() => cache.creating.delete(table))
        cache.creating.set(table, creating)
      }

      return creating
    }),
  )
}

/**
 * Checks, in the transaction of the application, that the tables of the projections exist, without creating them:
 * creating them there would need a second connection of the pool while the transaction holds one, and a table created
 * after the transaction began cannot be read in it (`ER_TABLE_DEF_CHANGED`).
 *
 * @throws Error naming the missing tables, which `init()` of the event store creates, or a table that is not the
 * table of its projection
 */
const assertProjectionTables = async (pool: Pool, ex: Queryable, projections: readonly ProjectionShape[]) => {
  const cache = cacheOf(pool)
  const unknown = projections.filter((projection) => !cache.existing.has(projectionTable(projection)))
  const comments = await assertOwnTables(ex, unknown)

  if (!comments) {
    return
  }

  const missing = unknown.map((projection) => projectionTable(projection)).filter((table) => !comments.has(table))

  assert(
    missing.length === 0,
    `The tables of the projections are missing (${missing.join(', ')}). Call init() of the event store on start ` +
      'when you append in a transaction (tx).',
  )

  for (const projection of unknown) {
    cache.existing.add(projectionTable(projection))
  }
}

/** Forgets the tables known to exist, e.g. after one of them turned out to be missing (dropped). */
const forgetProjectionTables = (pool: Pool) => {
  cacheByPool.delete(pool)
}

export {
  assertProjectionTables,
  createProjectionTables,
  ensureProjectionTables,
  forgetProjectionTables,
  projectionTable,
  projectionTableStatement,
}
