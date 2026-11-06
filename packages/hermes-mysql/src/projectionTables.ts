import { assert, type HermesProjection } from '@chassisjs/hermes'
import { createHash } from 'node:crypto'
import { type Pool, type PoolConnection, type RowDataPacket } from 'mysql2/promise'
import { type Queryable } from './projections.js'
import { retryOnTableLockTimeout, TableLockWaitTimeoutSeconds } from './sql.js'

/** What naming and creating the tables of a projection needs to know about it. */
type ProjectionShape = Pick<HermesProjection<unknown>, 'name' | 'isSingleStream'>

/** The tables of one projection. */
type ProjectionTables = Readonly<{
  /**
   * One row per document: `id`, `data` (JSON), `created_at`, `updated_at`, and, in a single-stream projection, the
   * `version` of its stream.
   */
  documents: string
  /**
   * In a multi-stream projection, the version of every stream that fed a document: `id`, `stream_id`, `version`.
   * `null` in a single-stream projection, whose documents keep the version of their stream.
   */
  versions: string | null
}>

const TablePrefix = 'hermes_projection_'
const VersionsSuffix = '_versions'
const MaxIdentifierLength = 64
const MaxBaseLength = MaxIdentifierLength - TablePrefix.length - VersionsSuffix.length
const HashLength = 8

const baseByName = new Map<string, string>()
// A plain name must not look like the versions table of another projection, nor like a hashed name, which ends in
// `__` and 8 hexadecimal digits.
const HashedEnding = new RegExp(`__[0-9a-f]{${HashLength}}$`)
const looksReserved = (slug: string) => slug.endsWith(VersionsSuffix) || HashedEnding.test(slug)
const VersionColumn = '\n        `version`     BIGINT UNSIGNED  NOT NULL DEFAULT 0,'

/**
 * The tables of a projection, named after it: `hermes_projection_<name>`, and `hermes_projection_<name>_versions` in a
 * multi-stream projection (`ofId`).
 *
 * A name of lowercase letters, digits and `_` (at most 37 characters, not ending in `_versions` or in `__` and 8
 * hexadecimal digits) is used as it is, e.g. `orders_20261106`. Any other name is turned into one (camelCase into
 * snake_case, other characters into `_`) and gets `__` and 8 characters of the SHA-256 of the name, so that two
 * projections never share a table, also where MySQL ignores the case of table names (macOS, Windows).
 *
 * The tables of a single-stream projection differ from those of a multi-stream one, so turning one into the other
 * needs a new name.
 *
 * @example
 * ```typescript
 * projectionTables(openOccurrences) // name 'open_occurrences', single-stream
 * // { documents: 'hermes_projection_open_occurrences', versions: null }
 *
 * projectionTables(occurrencesByPatient) // name 'occurrencesByPatient', with ofId
 * // { documents: 'hermes_projection_occurrences_by_patient__1c1a2c3e', versions: '...__1c1a2c3e_versions' }
 * ```
 */
const projectionTables = ({ name, isSingleStream }: ProjectionShape): ProjectionTables => {
  let base = baseByName.get(name)

  if (base === undefined) {
    assert(typeof name === 'string' && name.length > 0, 'A projection needs a name.')

    const slug = name
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, '_')

    base =
      slug === name && slug.length <= MaxBaseLength && !looksReserved(slug)
        ? slug
        : `${slug.slice(0, MaxBaseLength - HashLength - 2)}__${createHash('sha256').update(name).digest('hex').slice(0, HashLength)}`
    baseByName.set(name, base)
  }

  return Object.freeze({
    documents: `${TablePrefix}${base}`,
    versions: isSingleStream ? null : `${TablePrefix}${base}${VersionsSuffix}`,
  })
}

/**
 * The statements that create the tables of a projection when they are missing. They never change existing tables.
 */
const projectionTableStatements = (projection: ProjectionShape) => {
  const { documents, versions } = projectionTables(projection)
  const comment = `Hermes projection ${projection.name}`
  const statements = [
    {
      text: `CREATE TABLE IF NOT EXISTS \`${documents}\` (
        \`id\`          VARCHAR(250)     COLLATE utf8mb4_0900_bin NOT NULL,
        \`data\`        JSON             NULL,${versions === null ? VersionColumn : ''}
        \`created_at\`  DATETIME(6)      NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        \`updated_at\`  DATETIME(6)      NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (\`id\`)
      ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COMMENT = ?`,
      params: [comment],
    },
  ]

  if (versions === null) {
    return statements
  }

  return [
    ...statements,
    {
      text: `CREATE TABLE IF NOT EXISTS \`${versions}\` (
        \`id\`         VARCHAR(250)     COLLATE utf8mb4_0900_bin NOT NULL,
        \`stream_id\`  VARCHAR(250)     COLLATE utf8mb4_0900_bin NOT NULL,
        \`version\`    BIGINT UNSIGNED  NOT NULL,
        PRIMARY KEY (\`id\`, \`stream_id\`)
      ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COMMENT = ?`,
      params: [comment],
    },
  ]
}

/**
 * Creates the missing tables of the projections on a connection without a transaction: MySQL commits every DDL
 * statement, so it must never run in a transaction of the application. Set a short `lock_wait_timeout` on the
 * connection first: a statement that times out waiting for the lock of a table is tried again.
 */
const createProjectionTables = async (connection: PoolConnection, projections: readonly ProjectionShape[]) => {
  for (const projection of projections) {
    for (const { text, params } of projectionTableStatements(projection)) {
      await retryOnTableLockTimeout(() => connection.query(text, params))
    }
  }
}

type PoolCache = {
  /** The tables being created or created, by the name of the documents table. */
  creating: Map<string, Promise<void>>
  /** The documents tables that are known to exist. */
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
 * Creates the tables of one projection on its own connection of the pool, with a `lock_wait_timeout` of 5 seconds,
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
      const { documents } = projectionTables(projection)
      let creating = cache.creating.get(documents)

      if (!creating) {
        creating = createOnOwnConnection(pool, projection).then(() => {
          cache.existing.add(documents)
        })
        creating.catch(() => cache.creating.delete(documents))
        cache.creating.set(documents, creating)
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
 * @throws Error naming the missing tables, which `init()` of the event store creates
 */
const assertProjectionTables = async (pool: Pool, ex: Queryable, projections: readonly ProjectionShape[]) => {
  const cache = cacheOf(pool)
  const tables = projections.flatMap((projection) => {
    const { documents, versions } = projectionTables(projection)

    return cache.existing.has(documents) ? [] : versions === null ? [documents] : [documents, versions]
  })

  if (!tables.length) {
    return
  }

  const [rows] = await ex.query<RowDataPacket[]>(
    `SELECT \`table_name\` AS name FROM information_schema.tables
     WHERE \`table_schema\` = DATABASE() AND \`table_name\` IN (?)`,
    [tables],
  )
  const found = new Set(rows.map(({ name }) => String(name)))
  const missing = tables.filter((table) => !found.has(table))

  assert(
    missing.length === 0,
    `The tables of the projections are missing (${missing.join(', ')}). Call init() of the event store on start ` +
      'when you append in a transaction (tx).',
  )

  for (const projection of projections) {
    cache.existing.add(projectionTables(projection).documents)
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
  projectionTables,
  projectionTableStatements,
  type ProjectionTables,
}
