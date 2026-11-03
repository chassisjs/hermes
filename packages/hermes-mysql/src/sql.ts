import { assert } from '@chassisjs/hermes'
import { createPool } from 'mysql2'
import { type Pool, type PoolConnection, type PoolOptions } from 'mysql2/promise'
import { type QueryExecutor } from './types.js'

const OutboxTable = 'hermes_outbox'
const PartitionTable = 'hermes_outbox_partition'
const MigrationTable = 'hermes_migrations'
const MaxRowsPerStatement = 1000
const DefaultPollingConnectionLimit = 3
const PollingProgramName = 'hermes-polling'
const LockWaitTimeoutSeconds = 5

/**
 * Creates the pool that Hermes polls the outbox with.
 *
 * Every connection of the pool runs in `READ COMMITTED`, so the statements of Hermes lock only the rows they change,
 * not the gaps between them, which would stop the application from inserting new messages. `resetOnRelease` is
 * turned off, because resetting a connection would bring back the default isolation level. When the isolation level
 * of a new connection cannot be set, the connection is closed, the statement waiting for it fails, and the polling
 * outbox tries again at the next poll.
 *
 * Keep it apart from the pool of the application, so the isolation level of the application does not change. Hermes
 * needs only a few connections, so the pool has at most `connectionLimit` of them, and the statements wait in a queue
 * for a free connection (`waitForConnections` and `queueLimit` of `options` are ignored). The statements are short, so
 * a few connections serve many partitions published at the same time. A statement waits for a row lock at most
 * 5 seconds (`innodb_lock_wait_timeout`), so a row locked by the application does not hold a connection, and the
 * renewals of the claims queued behind it, for longer.
 *
 * @param options - The options of the `mysql2` pool
 * @param connectionLimit - The maximum number of connections of the pool
 */
const createPollingPool = (options: PoolOptions, connectionLimit = DefaultPollingConnectionLimit): Pool => {
  assert(
    Number.isInteger(connectionLimit) && connectionLimit > 0,
    'The connection limit of the polling pool has to be a positive integer.',
  )

  const pool = createPool({
    ...options,
    connectionLimit,
    waitForConnections: true,
    queueLimit: 0,
    maxIdle: connectionLimit,
    resetOnRelease: false,
    supportBigNumbers: true,
    bigNumberStrings: true,
    connectAttributes: { ...options.connectAttributes, program_name: PollingProgramName },
  })

  pool.on('connection', (connection) => {
    connection.query(
      `SET SESSION transaction_isolation = 'READ-COMMITTED', SESSION innodb_lock_wait_timeout = ${LockWaitTimeoutSeconds}`,
      (error) => {
        if (error) {
          connection.destroy()
        }
      },
    )
  })

  return pool.promise()
}

/**
 * Runs `work` in a transaction on one connection of the pool.
 *
 * With `readCommitted`, the transaction runs in `READ COMMITTED` whatever the isolation level of the connection is,
 * so its locking reads (`FOR UPDATE SKIP LOCKED`) do not lock the gaps between the rows.
 */
const inTransaction = async <T>(
  pool: Pool,
  work: (connection: PoolConnection) => Promise<T>,
  { readCommitted = false } = {},
): Promise<T> => {
  const connection = await pool.getConnection()

  try {
    if (readCommitted) {
      await connection.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
    }
    await connection.beginTransaction()

    const result = await work(connection)

    await connection.commit()

    return result
  } catch (error) {
    await connection.rollback().catch(() => {})
    throw error
  } finally {
    connection.release()
  }
}

type Column = { name: string; placeholder?: string }

const chunksOf = <T>(items: T[], size: number) =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size))

const insertStatements = (table: string, columns: Column[], rows: unknown[][]) =>
  chunksOf(rows, MaxRowsPerStatement).map((chunk) => {
    const values = `(${columns.map(({ placeholder }) => placeholder ?? '?').join(', ')})`

    return {
      text: `INSERT INTO \`${table}\` (${columns.map(({ name }) => `\`${name}\``).join(', ')}) VALUES ${chunk.map(() => values).join(', ')}`,
      params: chunk.flat(),
    }
  })

/**
 * Inserts the rows, all or none: in the given transaction, with one statement, or in a new transaction when there are
 * more than {@link MaxRowsPerStatement} rows.
 */
const insertRowsAtomically = async (
  getPool: () => Pool,
  tx: QueryExecutor | undefined,
  table: string,
  columns: Column[],
  rows: unknown[][],
) => {
  const statements = insertStatements(table, columns, rows)
  const run = async (executor: QueryExecutor) => {
    for (const { text, params } of statements) {
      await executor.query(text, params)
    }
  }

  if (tx) {
    await run(tx)
  } else if (statements.length === 1) {
    await getPool().query(statements[0].text, statements[0].params)
  } else if (statements.length > 1) {
    await inTransaction(getPool(), run)
  }
}

export {
  createPollingPool,
  DefaultPollingConnectionLimit,
  PollingProgramName,
  inTransaction,
  insertRowsAtomically,
  insertStatements,
  MaxRowsPerStatement,
  MigrationTable,
  OutboxTable,
  PartitionTable,
}
