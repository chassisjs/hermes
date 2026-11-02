import { Sql, TransactionSql } from 'postgres'
import type { OutboxTransaction, QueryExecutor } from './types.js'

const isPostgresJs = (sql: Sql | OutboxTransaction): sql is Sql | TransactionSql =>
  typeof sql === 'function' && typeof (sql as Partial<Sql>).unsafe === 'function'

const isTransaction = (value: OutboxTransaction | object | undefined): value is OutboxTransaction =>
  typeof value === 'function' || typeof (value as Partial<QueryExecutor> | undefined)?.query === 'function'

const toQueryExecutor = (sql: Sql | OutboxTransaction): QueryExecutor =>
  isPostgresJs(sql) ? { query: (text, params) => sql.unsafe(text, params as never[]) } : sql

// Pass JSON as `text::jsonb`: a `text` parameter is sent as it is by every driver, while postgres.js would
// serialize a `jsonb` one again.
type Column = { name: string; cast?: string }

// PostgreSQL accepts up to 65535 parameters per statement, so bigger batches are split into many statements.
const MaxRowsPerStatement = 1000

const insertRows = async (executor: QueryExecutor, table: string, columns: Column[], rows: unknown[][]) => {
  for (let start = 0; start < rows.length; start += MaxRowsPerStatement) {
    await _insertStatement(executor, table, columns, rows.slice(start, start + MaxRowsPerStatement))
  }
}

// Stores all the rows or none: in the given transaction, with one statement, or in a new transaction of `sql`.
const insertRowsAtomically = async (
  sql: Sql,
  tx: OutboxTransaction | undefined,
  table: string,
  columns: Column[],
  rows: unknown[][],
) => {
  if (tx || rows.length <= MaxRowsPerStatement) {
    await insertRows(toQueryExecutor(tx || sql), table, columns, rows)
  } else {
    await sql.begin((tx) => insertRows(toQueryExecutor(tx as TransactionSql), table, columns, rows))
  }
}

const _insertStatement = async (executor: QueryExecutor, table: string, columns: Column[], rows: unknown[][]) => {
  if (rows.length === 0) {
    return
  }

  const placeholders = rows
    .map((row, rowIndex) => {
      const values = columns.map(({ cast }, i) => `$${rowIndex * columns.length + i + 1}${cast ? `::${cast}` : ''}`)
      return `(${values.join(', ')})`
    })
    .join(', ')
  const columnList = columns.map(({ name }) => `"${name}"`).join(', ')

  await executor.query(`INSERT INTO "${table}" (${columnList}) VALUES ${placeholders}`, rows.flat())
}

export { insertRows, insertRowsAtomically, isTransaction, MaxRowsPerStatement, toQueryExecutor }
