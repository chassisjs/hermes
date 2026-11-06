import { assert, type HermesProjection } from '@chassisjs/hermes'
import { createHash } from 'node:crypto'
import { type Pool, type PoolConnection, type RowDataPacket } from 'mysql2/promise'
import { retryOnTableLockTimeout, TableLockWaitTimeoutSeconds } from './sql.js'

/** The tables of one projection. */
type ProjectionTables = Readonly<{
  /** One row per document: `id`, `data` (JSON), `created_at`, `updated_at`. */
  documents: string
  /** The version of every stream that fed a document: `id`, `stream_id`, `version`. */
  versions: string
}>

const TablePrefix = 'hermes_projection_'
const VersionsSuffix = '_versions'
const MaxIdentifierLength = 64
const MaxBaseLength = MaxIdentifierLength - TablePrefix.length - VersionsSuffix.length
const HashLength = 8

const tablesByName = new Map<string, ProjectionTables>()

/**
 * The tables of a projection, named after it: `hermes_projection_<name>` and `hermes_projection_<name>_versions`.
 *
 * A name of lowercase letters, digits and `_` (at most 37 characters) is used as it is. Any other name is turned into
 * one (camelCase into snake_case, other characters into `_`) and gets 8 characters of the SHA-256 of the name, so that
 * two projections never share a table, also where MySQL ignores the case of table names (macOS, Windows).
 *
 * @example
 * ```typescript
 * projectionTables(defineHermesProjection<...>().ofName('open_occurrences')...)
 * // { documents: 'hermes_projection_open_occurrences', versions: 'hermes_projection_open_occurrences_versions' }
 *
 * projectionTables({ name: 'openOccurrences' })
 * // { documents: 'hermes_projection_open_occurrences_1c1a2c3e', versions: '..._1c1a2c3e_versions' }
 * ```
 */
const projectionTables = ({ name }: Pick<HermesProjection<unknown>, 'name'>): ProjectionTables => {
  let tables = tablesByName.get(name)

  if (!tables) {
    assert(typeof name === 'string' && name.length > 0, 'A projection needs a name.')

    const slug = name
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, '_')
    const base =
      slug === name && slug.length <= MaxBaseLength
        ? slug
        : `${slug.slice(0, MaxBaseLength - HashLength - 1)}_${createHash('sha256').update(name).digest('hex').slice(0, HashLength)}`

    tables = Object.freeze({ documents: `${TablePrefix}${base}`, versions: `${TablePrefix}${base}${VersionsSuffix}` })
    tablesByName.set(name, tables)
  }

  return tables
}

/**
 * The statements that create the tables of a projection when they are missing. They never change existing tables.
 */
const projectionTableStatements = (projection: Pick<HermesProjection<unknown>, 'name'>) => {
  const { documents, versions } = projectionTables(projection)
  const comment = `Hermes projection ${projection.name}`

  return [
    {
      text: `CREATE TABLE IF NOT EXISTS \`${documents}\` (
        \`id\`          VARCHAR(250)  COLLATE utf8mb4_0900_bin NOT NULL,
        \`data\`        JSON          NULL,
        \`created_at\`  DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        \`updated_at\`  DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (\`id\`)
      ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COMMENT = ?`,
      params: [comment],
    },
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
 * statement, so it must never run in a transaction of the application. A statement waits for the lock of a table at
 * most 5 seconds (and is tried again), because a waiting DDL stops the queries of the application on that table.
 */
const createProjectionTables = async (
  connection: PoolConnection,
  projections: readonly Pick<HermesProjection<unknown>, 'name'>[],
) => {
  const [[session]] = await connection.query<RowDataPacket[]>('SELECT @@SESSION.lock_wait_timeout AS lockWaitTimeout')

  await connection.query('SET SESSION lock_wait_timeout = ?', [TableLockWaitTimeoutSeconds])

  try {
    for (const projection of projections) {
      for (const { text, params } of projectionTableStatements(projection)) {
        await retryOnTableLockTimeout(() => connection.query(text, params))
      }
    }
  } finally {
    await connection.query('SET SESSION lock_wait_timeout = ?', [Number(session.lockWaitTimeout)])
  }
}

const ensuredByPool = new WeakMap<Pool, Map<string, Promise<void>>>()

/**
 * Creates the missing tables of the projections, once per pool and table: later calls wait for the first one. It
 * takes its own connection of the pool, so it can run while the application has a transaction open on another one.
 */
const ensureProjectionTables = async (pool: Pool, projections: readonly Pick<HermesProjection<unknown>, 'name'>[]) => {
  let ensured = ensuredByPool.get(pool)

  if (!ensured) {
    ensured = new Map()
    ensuredByPool.set(pool, ensured)
  }

  const cache = ensured

  await Promise.all(
    projections.map((projection) => {
      const { documents } = projectionTables(projection)
      let creating = cache.get(documents)

      if (!creating) {
        creating = (async () => {
          const connection = await pool.getConnection()

          try {
            await createProjectionTables(connection, [projection])
          } finally {
            connection.release()
          }
        })()
        creating.catch(() => cache.delete(documents))
        cache.set(documents, creating)
      }

      return creating
    }),
  )
}

export {
  createProjectionTables,
  ensureProjectionTables,
  projectionTables,
  projectionTableStatements,
  type ProjectionTables,
}
