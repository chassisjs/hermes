import { describe, expect, test } from '@jest/globals'
import { insertStatements, MaxRowsPerStatement } from './sql.js'

describe('insertStatements', () => {
  test('inserts the rows with one statement, with the placeholders of the columns', () => {
    expect(
      insertStatements(
        'hermes_outbox',
        [{ name: 'message_id' }, { name: 'data', placeholder: 'CAST(? AS JSON)' }],
        [
          ['m1', '{}'],
          ['m2', '[]'],
        ],
      ),
    ).toEqual([
      {
        text: 'INSERT INTO `hermes_outbox` (`message_id`, `data`) VALUES (?, CAST(? AS JSON)), (?, CAST(? AS JSON))',
        params: ['m1', '{}', 'm2', '[]'],
      },
    ])
  })

  test(`splits the rows into statements of at most ${MaxRowsPerStatement} rows`, () => {
    const rows = Array.from({ length: 2 * MaxRowsPerStatement + 1 }, (_, i) => [`m${i}`])
    const statements = insertStatements('hermes_outbox', [{ name: 'message_id' }], rows)

    expect(statements.map(({ params }) => params.length)).toEqual([MaxRowsPerStatement, MaxRowsPerStatement, 1])
    expect(statements[2]).toEqual({
      text: 'INSERT INTO `hermes_outbox` (`message_id`) VALUES (?)',
      params: [`m${2 * MaxRowsPerStatement}`],
    })
  })

  test('has no statements for no rows', () => {
    expect(insertStatements('hermes_outbox', [{ name: 'message_id' }], [])).toEqual([])
  })
})
