import { createPool } from 'mysql2'
import { type Pool, type PoolConnection, type PoolOptions } from 'mysql2/promise'
import { type QueryExecutor } from './types.js'

const OutboxTable = 'hermes_outbox'
const PartitionTable = 'hermes_outbox_partition'
const MigrationTable = 'hermes_migrations'
const MaxRowsPerStatement = 1000

/**
 * Creates the pool that Hermes polls the outbox with.
 *
 * Every connection of the pool runs in `READ COMMITTED`, so the locking reads (`FOR UPDATE SKIP LOCKED`) and the
 * statements that change rows lock only the rows, not the gaps between them, which would stop the application from
 * inserting new messages. Keep it apart from the pool of the application, so the isolation level of the application
 * does not change.
 *
 * @param options - The options of the `mysql2` pool
 */
const createPollingPool = (options: PoolOptions): Pool => {
  const pool = createPool({ ...options, supportBigNumbers: true, bigNumberStrings: true })

  pool.on('connection', (connection) => {
    connection.query('SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED', (error) => {
      if (error) {
        connection.destroy()
      }
    })
  })

  return pool.promise()
}

/**
 * Runs `work` in a transaction on one connection of the pool.
 */
const inTransaction = async <T>(pool: Pool, work: (connection: PoolConnection) => Promise<T>): Promise<T> => {
  const connection = await pool.getConnection()

  try {
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
  createPollingPool,
  inTransaction,
  insertRowsAtomically,
  insertStatements,
  MaxRowsPerStatement,
  MigrationTable,
  OutboxTable,
  PartitionTable,
}
