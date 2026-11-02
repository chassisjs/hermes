import { describe, expect, jest, test } from '@jest/globals'
import { Sql } from 'postgres'
import { insertRows, insertRowsAtomically, MaxRowsPerStatement, toQueryExecutor } from './queryExecutor.js'
import { QueryExecutor } from './types.js'

const createExecutor = () => {
  const query = jest.fn<QueryExecutor['query']>().mockResolvedValue([])
  return { executor: { query }, query }
}

describe('insertRows', () => {
  test('inserts one row with positional parameters and casts', async () => {
    const { executor, query } = createExecutor()

    await insertRows(
      executor,
      'outbox',
      [{ name: 'messageId' }, { name: 'data', cast: 'text::jsonb' }],
      [['id-1', '{}']],
    )

    expect(query).toHaveBeenCalledTimes(1)
    expect(query).toHaveBeenCalledWith('INSERT INTO "outbox" ("messageId", "data") VALUES ($1, $2::text::jsonb)', [
      'id-1',
      '{}',
    ])
  })

  test('inserts many rows with one statement, numbering the parameters row by row', async () => {
    const { executor, query } = createExecutor()

    await insertRows(
      executor,
      'outbox',
      [{ name: 'messageId' }, { name: 'messageType' }, { name: 'data', cast: 'text::jsonb' }],
      [
        ['id-1', 'type-1', '{"a":1}'],
        ['id-2', 'type-2', '{"a":2}'],
      ],
    )

    expect(query).toHaveBeenCalledTimes(1)
    expect(query).toHaveBeenCalledWith(
      'INSERT INTO "outbox" ("messageId", "messageType", "data") VALUES ($1, $2, $3::text::jsonb), ($4, $5, $6::text::jsonb)',
      ['id-1', 'type-1', '{"a":1}', 'id-2', 'type-2', '{"a":2}'],
    )
  })

  test('does nothing for no rows', async () => {
    const { executor, query } = createExecutor()

    await insertRows(executor, 'outbox', [{ name: 'messageId' }], [])

    expect(query).not.toHaveBeenCalled()
  })

  test('passes the error of the query on', async () => {
    const error = new Error('value too long')
    const executor = { query: jest.fn<QueryExecutor['query']>().mockRejectedValue(error) }

    await expect(insertRows(executor, 'outbox', [{ name: 'messageId' }], [['id-1']])).rejects.toBe(error)
  })
})

const rowsOf = (count: number) => Array.from({ length: count }, (_, i) => [`id-${i}`])

describe('insertRows with many rows', () => {
  test('splits the rows into statements of at most MaxRowsPerStatement rows, numbering the parameters from $1 in each', async () => {
    const { executor, query } = createExecutor()

    await insertRows(executor, 'outbox', [{ name: 'messageId' }], rowsOf(2 * MaxRowsPerStatement + 1))

    expect(query).toHaveBeenCalledTimes(3)
    expect(query.mock.calls.map(([, params]) => params.length)).toEqual([MaxRowsPerStatement, MaxRowsPerStatement, 1])
    expect(query.mock.calls[2]).toEqual([
      'INSERT INTO "outbox" ("messageId") VALUES ($1)',
      [`id-${2 * MaxRowsPerStatement}`],
    ])
  })
})

describe('insertRowsAtomically', () => {
  const createSql = () => {
    const outer = jest.fn().mockReturnValue(Promise.resolve([]))
    const inner = jest.fn().mockReturnValue(Promise.resolve([]))
    const tx = Object.assign(() => undefined, { unsafe: inner })
    const begin = jest.fn(async (work: (tx: unknown) => Promise<unknown>) => work(tx))
    const sql = Object.assign(() => undefined, { unsafe: outer, begin }) as unknown as Sql

    return { sql, outer, inner, begin }
  }

  test('uses the given transaction', async () => {
    const { sql, outer, begin } = createSql()
    const { executor, query } = createExecutor()

    await insertRowsAtomically(sql, executor, 'outbox', [{ name: 'messageId' }], rowsOf(MaxRowsPerStatement + 1))

    expect(query).toHaveBeenCalledTimes(2)
    expect(outer).not.toHaveBeenCalled()
    expect(begin).not.toHaveBeenCalled()
  })

  test('stores up to MaxRowsPerStatement rows with one statement, without a transaction', async () => {
    const { sql, outer, begin } = createSql()

    await insertRowsAtomically(sql, undefined, 'outbox', [{ name: 'messageId' }], rowsOf(MaxRowsPerStatement))

    expect(outer).toHaveBeenCalledTimes(1)
    expect(begin).not.toHaveBeenCalled()
  })

  test('opens a transaction for more rows', async () => {
    const { sql, outer, inner, begin } = createSql()

    await insertRowsAtomically(sql, undefined, 'outbox', [{ name: 'messageId' }], rowsOf(MaxRowsPerStatement + 1))

    expect(begin).toHaveBeenCalledTimes(1)
    expect(inner).toHaveBeenCalledTimes(2)
    expect(outer).not.toHaveBeenCalled()
  })
})

describe('toQueryExecutor', () => {
  test('runs the queries of a postgres.js connection or transaction with `unsafe`', async () => {
    const unsafe = jest.fn().mockReturnValue(Promise.resolve([]))
    const sql = Object.assign(() => undefined, { unsafe }) as unknown as Sql

    await toQueryExecutor(sql).query('SELECT $1', [1])

    expect(unsafe).toHaveBeenCalledWith('SELECT $1', [1])
  })

  test('returns any other executor as it is', () => {
    const { executor } = createExecutor()

    expect(toQueryExecutor(executor)).toBe(executor)
  })
})
