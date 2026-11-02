import { type Pool, type PoolConnection } from 'mysql2/promise'
import { type QueryExecutor } from './types.js'

const OutboxTable = 'hermes_outbox'
const PartitionTable = 'hermes_outbox_partition'
const MigrationTable = 'hermes_migrations'
const MaxRowsPerStatement = 1000

/**
 * Runs `work` in a transaction on one connection of the pool.
 *
 * `READ COMMITTED` keeps the locking reads (`FOR UPDATE SKIP LOCKED`) from locking the gaps between the rows, which
 * would stop the application from inserting new messages until the transaction ends.
 */
const inTransaction = async <T>(pool: Pool, work: (connection: PoolConnection) => Promise<T>): Promise<T> => {
  const connection = await pool.getConnection()

  try {
    await connection.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
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

/**
 * Runs one statement that changes rows, as its own `READ COMMITTED` transaction: `SET TRANSACTION` applies to the next
 * transaction of the connection, which is the statement itself in the autocommit mode. So the statement locks only the
 * rows it changes, not the gaps between them, and does not block the inserts of the application.
 */
const writeReadCommitted = async (pool: Pool, text: string, params: unknown[]) => {
  const connection = await pool.getConnection()

  try {
    await connection.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
    await connection.query(text, params)
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
  pool: Pool,
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
    await pool.query(statements[0].text, statements[0].params)
  } else if (statements.length > 1) {
    await inTransaction(pool, run)
  }
}

export {
  inTransaction,
  insertRowsAtomically,
  insertStatements,
  MaxRowsPerStatement,
  MigrationTable,
  OutboxTable,
  PartitionTable,
  writeReadCommitted,
}
